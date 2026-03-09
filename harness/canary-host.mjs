/**
 * WebX Canary Host
 *
 * Boots an x86-64 Linux guest in Canary (open-source WASM x86-64 emulator)
 * and bridges Vulkan commands from the guest ICD (libvkwebx.so) to the
 * WebGPU device running on the host.
 *
 * ## IPC Mechanism (x86 I/O port 0x7860, polled)
 *
 *   Canary's canary-io crate queues guest outb/inl accesses.  JS drains them
 *   each frame via rt.drain_io_writes() / rt.push_io_read().
 *
 *   Guest → Host: outb(byte, 0x7860)  → IoCtx.pending_writes
 *                 → rt.drain_io_writes() → VkBridge.handleWrite()
 *   Host → Guest: bridge.onResponseReady(resp)
 *                 → rt.push_io_read(port, 4, seqU32)  ← unblocks guest inl()
 *                 → rt.push_io_read(port, 1, byte) × N ← data for guest inb()
 *
 * ## Execution model
 *
 *   prepare_elf() sets up the ELF binary in guest memory without running it.
 *   step() is called in requestAnimationFrame batches interleaved with I/O
 *   port draining, network polling, thread spawning, and framebuffer blitting.
 *
 * ## Threading
 *
 *   Guest clone() calls are queued in drain_clone_requests(). Each entry
 *   spawns a Web Worker (worker.mjs) which runs its own CanaryRuntime for
 *   the child thread. Stdout/stderr/clone cascades are forwarded to main.
 *
 * ## Networking
 *
 *   Guest TCP connect() calls are queued in drain_connect_requests(). Each
 *   entry opens a WebSocket to ws://localhost:3001/tcp/<ip>/<port>. A TCP
 *   proxy (tcp-proxy.mjs or websockify) must run on port 3001.
 */

import { VkBridge }  from './vk-bridge.mjs';
import { loadPlugin } from './vkwebgpu-plugin.mjs';


// Sentry integration - reports errors if Sentry SDK is loaded in the page
function sentryCaptureError(msg, extra) {
    try {
        if (typeof Sentry !== 'undefined') {
            Sentry.withScope(scope => {
                if (extra) scope.setExtras(extra);
                Sentry.captureMessage(msg, 'error');
            });
        }
    } catch (_) {}
}

/* Canary WASM package — served from /canary/ by server.mjs */
const _CANARY_V = Date.now();
const CANARY_WASM_URL    = '/canary/canary_wasm.js?v='+_CANARY_V;
const CANARY_WASM_BG_URL = '/canary/canary_wasm_bg.wasm';

/* x86-64 SteamOS guest image (ext2, with libvkwebx.so pre-installed) */
const STEAMOS_IMAGE_URL = '/steam/steamos-webx.ext2';

/* x86 I/O port used as the guest↔host IPC doorbell */
const WEBX_PORT = 0x7860;

/* Framebuffer resolution — must match Canary's canary-fb crate (FB_WIDTH/FB_HEIGHT) */
const FB_WIDTH  = 1024;
const FB_HEIGHT = 768;

/* Execution budget per animation frame (ms). */
const FRAME_BUDGET_MS = 10;

/* TCP-over-WebSocket proxy URL for guest network connections. */
const TCP_PROXY_BASE = 'ws://localhost:3001/tcp';

/* ── Module-level state shared across workers ─────────────────────────────── */

/* Compiled WebAssembly.Module cached for sharing with thread Workers. */
let _wasmModule = null;

/*
 * SharedArrayBuffer-backed WebAssembly.Memory, present only when Canary is
 * built with the pkg-threads target (+atomics,+bulk-memory,+mutable-globals).
 * When non-null, all Workers receive the same backing buffer so guest memory
 * is truly shared (CLONE_VM semantics). With the standard single-threaded
 * build this stays null and Workers run isolated address spaces.
 */
let _wasmMemory = null;

/* Active thread Workers, keyed by guest TID. */
const _workers = new Map();

/* Active TCP WebSocket connections, keyed by guest socket fd. */
const _wsMap = new Map();

/* ── Boot ─────────────────────────────────────────────────────────────────── */

export async function boot(canvas, consoleEl, statusEl) {
    if (!navigator.gpu) {
        sentryCaptureError('WebGPU not available', {});
        throw new Error('WebGPU not available. Use Chrome 113+, Edge 113+, or Firefox Nightly.');
    }

    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) {
        sentryCaptureError('No WebGPU adapter found', {});
        throw new Error('No WebGPU adapter found.');
    }

    const deviceDesc = { requiredLimits: {} };
    if (adapter.features.has('texture-compression-bc'))
        deviceDesc.requiredFeatures = ['texture-compression-bc'];

    const device = await adapter.requestDevice(deviceDesc);
    device.lost.then(i => console.error('[WebX] WebGPU device lost:', i.message));

    /* ── VkWebGPU-ICD plugin ── */
    const plugin = await loadPlugin();
    await plugin.initialize(adapter, device, canvas);
    const bridge = new VkBridge(plugin);

    /* ── Load Canary WASM ── */
    console.log('[WebX] Loading Canary WASM…');
    const wasmMod = await import(/* @vite-ignore */ CANARY_WASM_URL);
    const wasmInitResult = await wasmMod.default(fetch('/canary/canary_wasm_bg.wasm?v='+_CANARY_V));

    /* Cache compiled module for sharing with thread Workers. */
    _wasmModule = wasmInitResult?.module ?? null;
    if (!_wasmModule) {
        /* Fallback: compile the .wasm binary directly. */
        try {
            _wasmModule = await WebAssembly.compileStreaming(fetch(CANARY_WASM_BG_URL));
            console.log('[WebX] WASM module compiled and cached for Workers.');
        } catch (e) {
            console.warn('[WebX] Could not cache WASM module for Workers:', e.message,
                         '— thread Workers will load WASM independently.');
        }
    }

    /*
     * Extract shared memory if available (pkg-threads build only).
     * The threads build initialises WASM with a SharedArrayBuffer-backed
     * WebAssembly.Memory so all Workers see the same guest address space.
     * The standard build returns a regular (non-shared) memory; we leave
     * _wasmMemory null in that case so Workers fall back to isolated mode.
     */
    const rawMem = wasmInitResult?.memory ?? wasmInitResult?.instance?.exports?.memory;
    if (rawMem?.buffer instanceof SharedArrayBuffer) {
        _wasmMemory = rawMem;
        console.log('[WebX] Shared WASM memory detected — Workers will share guest address space.');
    }

    const { CanaryRuntime } = wasmMod;
    const rt = new CanaryRuntime();
    console.log('[WebX] Canary runtime ready.');

    /* ── Lazy-load SteamOS ext2/ext4 filesystem via HTTP Range requests ── */
    /*
     * Instead of downloading the full ~7 GiB image (impossible: wasm32 has a
     * 4 GiB hard memory limit), we traverse the filesystem block-by-block using
     * server Range requests.  Only the blocks actually needed — superblock, BGDT,
     * inode tables, directory data, and small file content — are fetched.
     *
     * stage_vfs_from_url() is a free wasm-bindgen async function that builds a
     * MemFs in a thread-local staging area.  apply_staged_vfs() then merges it
     * into the runtime's VFS.
     */
    const setStatus = (msg) => { if (statusEl) statusEl.textContent = msg; };

    console.log(`[WebX] Lazy-loading ext2 filesystem: ${STEAMOS_IMAGE_URL}`);
    setStatus('Indexing filesystem…');

    try {
        await wasmMod.stage_vfs_from_url(STEAMOS_IMAGE_URL);
    } catch (e) {
        throw new Error(`[WebX] stage_vfs_from_url failed: ${e}`);
    }

    setStatus('Applying filesystem…');
    const fsOk = rt.apply_staged_vfs();
    if (!fsOk)
        throw new Error('apply_staged_vfs() returned false — no staged VFS available.');

    console.log('[WebX] VFS populated from ext2 image via lazy block loading.');

    /* ── Launch target (declared here so VFS overlay below can reference it) ── */
    // SteamOS/Arch: /bin is a relative symlink → usr/bin. Try resolved path first.
    const LAUNCH_BIN  = rt.path_exists('/usr/bin/bash') ? '/usr/bin/bash'
                      : rt.path_exists('/bin/bash')     ? '/bin/bash'
                      : '/usr/bin/bash'; // fallback
    const LAUNCH_ARGS = ['/opt/webx/launch.sh'];

    /* ── Prefetch critical binaries from ext2 image ──────────────────────────
     * populate_memfs only builds directory structure + symlinks; file content
     * is empty until explicitly fetched.  We eagerly fetch the files that must
     * be readable before the first instruction executes.  Symlinks are resolved
     * by the VFS, so we fetch the real targets directly.
     *
     * For each path: try to fetch; if it fails (unknown path, device node, etc.)
     * just log and continue — a missing non-critical file shouldn't block boot.
     * ────────────────────────────────────────────────────────────────────────── */
    const PREFETCH_PATHS = [
        // Shell + dynamic linker
        // SteamOS 3.x (Arch-based): /lib → /usr/lib, so real paths are under /usr/lib
        '/usr/bin/bash',  // SteamOS/Arch: /bin → usr/bin (relative symlink)
        '/bin/bash',
        '/usr/lib/ld-linux-x86-64.so.2',          // Arch/SteamOS
        '/usr/lib64/ld-linux-x86-64.so.2',         // Fedora/RHEL style
        '/lib64/ld-linux-x86-64.so.2',             // Debian-old / symlink path
        '/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2',
        // Core C runtime
        '/usr/lib/libc.so.6',                       // Arch/SteamOS
        '/usr/lib/x86_64-linux-gnu/libc.so.6',     // Debian
        '/lib/x86_64-linux-gnu/libc.so.6',
        '/usr/lib/libm.so.6',
        '/usr/lib/x86_64-linux-gnu/libm.so.6',
        '/usr/lib/libdl.so.2',
        '/usr/lib/x86_64-linux-gnu/libdl.so.2',
        '/usr/lib/libpthread.so.0',
        '/usr/lib/x86_64-linux-gnu/libpthread.so.0',
        '/usr/lib/libtinfo.so.6',
        '/usr/lib/x86_64-linux-gnu/libtinfo.so.6',
        '/usr/lib/libreadline.so.8',
        '/usr/lib/x86_64-linux-gnu/libreadline.so.8',
        // nsswitch / passwd (glibc reads these early)
        '/etc/nsswitch.conf',
        '/etc/passwd',
        // Note: /etc/ld.so.cache is intentionally excluded — its data blocks sit at
        // ~5.5 GB into the ext2 image, causing intermittent fetch hangs in some browsers.
        // ld-linux falls back to /etc/ld.so.conf and default library paths when absent.
        '/etc/ld.so.conf',
    ];

    // Serialize all lookup_ext2_path calls — the Rust ext2 reader is a singleton
    // that is taken out of thread-local storage during async operations.
    // Concurrent calls would see it as None and fail.
    let _ext2Lock = Promise.resolve();
    function ext2Lookup(p) {
        // 12-second timeout per lookup — prevents hung fetches (large files with data
        // blocks at huge ext2 offsets) from blocking the entire serialized chain.
        const result = _ext2Lock.then(() => {
            const fetch = wasmMod.lookup_ext2_path(p);
            const timeout = new Promise((_, rej) =>
                setTimeout(() => rej(new Error(`ext2 lookup timeout: ${p}`)), 12000));
            return Promise.race([fetch, timeout]);
        });
        // Chain: next caller waits for this one to finish (inc. put-back).
        _ext2Lock = result.then(() => {}, () => {});
        return result;
    }

    // Resolve a symlink target path relative to its symlink location.
    function resolveSymlinkTarget(symlinkPath, target) {
        if (target.startsWith('/')) return target;
        const dir = symlinkPath.slice(0, symlinkPath.lastIndexOf('/') + 1);
        const parts = (dir + target).split('/');
        const resolved = [];
        for (const p of parts) {
            if (p === '..') resolved.pop();
            else if (p && p !== '.') resolved.push(p);
        }
        return '/' + resolved.join('/');
    }

    // Fetch one file from ext2, following symlinks up to 4 levels deep.
    // Returns { data: Uint8Array, resolvedPath: string } or null.
    async function fetchExt2Resolved(fpath, depth = 0) {
        if (depth > 4) return null;
        let data;
        try { data = await ext2Lookup(fpath); }
        catch (_) { return null; }
        if (!data || data.byteLength === 0) return null;
        // Heuristic: detect symlink targets.
        // A symlink target is short (<= 255 bytes), contains only printable non-whitespace
        // ASCII, and is not an ELF binary or shell script.
        // This handles both absolute (/usr/lib/foo) and relative (libfoo.so.6) targets.
        if (data.byteLength <= 255) {
            const isELF     = data[0] === 0x7f && data[1] === 0x45; // \x7fE
            const isShebang = data[0] === 0x23 && data[1] === 0x21; // #!
            if (!isELF && !isShebang) {
                const text = new TextDecoder().decode(data).replace(/\0+$/, '');
                if (text.length > 0 && /^[^\s\0\x01-\x1f\x7f]+$/.test(text)) {
                    const resolved = resolveSymlinkTarget(fpath, text);
                    if (resolved !== fpath) {
                        const result = await fetchExt2Resolved(resolved, depth + 1);
                        if (result) return { data: result.data, resolvedPath: result.resolvedPath };
                    }
                }
            }
        }
        return { data, resolvedPath: fpath };
    }

    const total = PREFETCH_PATHS.length;
    let done = 0;
    setStatus(`Fetching boot files: 0 / ${total}`);
    // Fire all prefetches — they serialize through ext2Lookup but update status as each completes.
    const prefetchResults = await Promise.all(
        PREFETCH_PATHS.map(fpath => fetchExt2Resolved(fpath).then(r => {
            done++;
            setStatus(`Fetching boot files: ${done} / ${total}`);
            return { fpath, r };
        }))
    );
    const prefetchSeen = new Set();
    let prefetched = 0;
    for (const { fpath, r: result } of prefetchResults) {
        if (!result || result.data.byteLength === 0) { console.debug(`[WebX] prefetch skip: ${fpath}`); continue; }
        if (!prefetchSeen.has(fpath)) {
            rt.add_file(fpath, result.data);
            prefetchSeen.add(fpath);
            prefetched++;
        }
        if (result.resolvedPath !== fpath && !prefetchSeen.has(result.resolvedPath)) {
            rt.add_file(result.resolvedPath, result.data);
            prefetchSeen.add(result.resolvedPath);
            console.log(`[WebX] prefetched ${fpath} → ${result.resolvedPath} (${result.data.byteLength} bytes)`);
        } else if (!prefetchSeen.has(fpath + '_logged')) {
            console.log(`[WebX] prefetched ${fpath} (${result.data.byteLength} bytes)`);
            prefetchSeen.add(fpath + '_logged');
        }
    }
    const totalMB = (prefetchResults.reduce((sum, {r}) => sum + (r ? r.data.byteLength : 0), 0) / 1048576).toFixed(1);
    console.log(`[WebX] Prefetch complete: ${prefetched}/${PREFETCH_PATHS.length} paths resolved — ${totalMB} MB transferred.`);

    /* ── VFS overlay: /proc stubs + Vulkan ICD ── */
    /*
     * glibc reads /proc/cpuinfo at startup for CPU feature detection (SSE4,
     * AVX, etc.). Wine reads /proc/self/exe for its own path. ntdll reads
     * /proc/self/maps and /proc/self/status. These aren't in the ext2 image
     * because /proc is a kernel pseudo-fs; we synthesise them here.
     *
     * The Vulkan ICD JSON is added as a fallback even though extract-rootfs.sh
     * installs it into the image — this guarantees it's present regardless of
     * image preparation state.
     */
    const enc = new TextEncoder();

    rt.add_file('/proc/version',
        enc.encode('Linux version 6.1.0-canary (gcc 12.3.0) #1 SMP PREEMPT\n'));

    rt.add_file('/proc/self/exe',
        enc.encode(LAUNCH_BIN));

    rt.add_file('/proc/self/cmdline',
        enc.encode([LAUNCH_BIN, ...LAUNCH_ARGS].join('\0') + '\0'));

    rt.add_file('/proc/self/comm',
        enc.encode(LAUNCH_BIN.split('/').pop() + '\n'));

    /* Minimal /proc/self/stat — Wine/ntdll reads fields 1-4 (pid, comm, state, ppid). */
    rt.add_file('/proc/self/stat',
        enc.encode('1 (bash) R 0 1 1 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 0 0 0 ' +
                   '18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 17 0 0 0\n'));

    rt.add_file('/proc/self/status',
        enc.encode(
            'Name:\tbash\n'   +
            'State:\tR (running)\n' +
            'Pid:\t1\nPPid:\t0\n'  +
            'Uid:\t1000\t1000\t1000\t1000\n' +
            'Gid:\t1000\t1000\t1000\t1000\n' +
            'VmRSS:\t65536 kB\nVmPeak:\t65536 kB\n'));

    /* Empty maps — ntdll tolerates EOF here. */
    rt.add_file('/proc/self/maps', enc.encode(''));

    /*
     * /proc/cpuinfo — glibc probes this for CPUID feature flags at startup.
     * Include the flags that DXVK, VKD3D, and Wine check: SSE4.1/4.2, AVX,
     * AVX2, CX16 (cmpxchg16b for 64-bit atomics), POPCNT, AES, FMA.
     */
    rt.add_file('/proc/cpuinfo', enc.encode(
        'processor\t: 0\n'                        +
        'vendor_id\t: GenuineIntel\n'              +
        'cpu family\t: 6\n'                        +
        'model\t\t: 142\n'                         +
        'model name\t: Intel(R) Core(TM) i7 (Canary Emulated)\n' +
        'cpu MHz\t\t: 2400.000\n'                  +
        'cache size\t: 8192 KB\n'                  +
        'flags\t\t: fpu vme de pse tsc msr pae mce cx8 apic sep mtrr pge mca cmov pat ' +
        'pse36 clflush mmx fxsr sse sse2 ht syscall nx rdtscp lm constant_tsc '         +
        'pni pclmulqdq ssse3 fma cx16 pcid sse4_1 sse4_2 movbe popcnt aes xsave '      +
        'avx f16c rdrand hypervisor lahf_lm abm 3dnowprefetch avx2 bmi1 bmi2\n'));

    /* Vulkan ICD manifest — points loader to our WebX ICD inside the image. */
    rt.add_file('/etc/vulkan/icd.d/vkwebx_icd.json',
        enc.encode(JSON.stringify({
            file_format_version: '1.0.0',
            ICD: { library_path: '/usr/local/lib/libvkwebx.so', api_version: '1.3.0' },
        })));

    console.log('[WebX] /proc stubs and Vulkan ICD JSON written to VFS.');

    /* ── Console output (drain stdout/stderr each frame) ── */
    const dec = new TextDecoder();
    let _outBuf = '';
    function drainOutput() {
        const out = rt.drain_stdout();
        const err = rt.drain_stderr();
        const both = new Uint8Array(out.length + err.length);
        both.set(out);
        both.set(err, out.length);
        if (both.length > 0) {
            const text = dec.decode(both);
            if (consoleEl) consoleEl.textContent += text;
            // Forward to browser console line-by-line so Playwright/DevTools can see it
            _outBuf += text;
            let nl;
            while ((nl = _outBuf.indexOf('\n')) !== -1) {
                console.log('[guest] ' + _outBuf.slice(0, nl));
                _outBuf = _outBuf.slice(nl + 1);
            }
        }
    }

    /* ── Framebuffer rendering (/dev/fb0 → HTML canvas) ── */
    // The main `canvas` already has a WebGPU context (acquired by plugin.initialize).
    // A canvas can only hold one rendering context, so we blit the guest framebuffer
    // through a same-size OffscreenCanvas (2D) and then drawImage it onto the main canvas.
    // If the plugin is a stub (no real WebGPU output), this makes fb0 visible directly.
    canvas.width  = FB_WIDTH;
    canvas.height = FB_HEIGHT;
    const fbOffscreen = new OffscreenCanvas(FB_WIDTH, FB_HEIGHT);
    const ctx2d       = fbOffscreen.getContext('2d');
    const fbImageData = ctx2d.createImageData(FB_WIDTH, FB_HEIGHT);
    // We need a 2D context on the main canvas to drawImage from the offscreen canvas,
    // but it already has webgpu. Use ImageBitmap → GPU texture path instead.
    // Simplest compat path: if the main canvas is webgpu-bound we create a parallel
    // visible overlay canvas for the fb0 output.
    let fbTargetCtx = canvas.getContext('2d');   // null if webgpu already bound
    let fbOverlay   = null;
    if (!fbTargetCtx) {
        fbOverlay = document.createElement('canvas');
        fbOverlay.width  = FB_WIDTH;
        fbOverlay.height = FB_HEIGHT;
        fbOverlay.style.cssText = canvas.style.cssText +
            ';position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none';
        canvas.parentElement?.insertBefore(fbOverlay, canvas.nextSibling);
        fbTargetCtx = fbOverlay.getContext('2d');
    }

    function renderFramebuffer() {
        if (!rt.has_framebuffer()) return;
        const pixels = rt.get_framebuffer();
        if (pixels.length !== FB_WIDTH * FB_HEIGHT * 4) return;
        /* Convert BGRA (guest /dev/fb0) → RGBA (Canvas ImageData) */
        const rgba = fbImageData.data;
        for (let i = 0; i < pixels.length; i += 4) {
            rgba[i]     = pixels[i + 2]; /* R ← B */
            rgba[i + 1] = pixels[i + 1]; /* G */
            rgba[i + 2] = pixels[i];     /* B ← R */
            rgba[i + 3] = 255;
        }
        ctx2d.putImageData(fbImageData, 0, 0);
        fbTargetCtx.drawImage(fbOffscreen, 0, 0);
    }

    /* ── x86 I/O port bridge (0x7860) ── */
    /*
     * Response layout (wire protocol):
     *   inl() returns seq u32 LE (first 4 bytes, never 0xFFFFFFFF).
     *   Remaining bytes: result i32 (4) + len u32 (4) + payload read via inb().
     */
    bridge.onResponseReady = (resp) => {
        const view = new DataView(resp.buffer, resp.byteOffset);
        /* seq u32 — returned by guest's inl() poll, also first 4 bytes of response */
        rt.push_io_read(WEBX_PORT, 4, view.getUint32(0, true));
        /* Remaining bytes delivered one at a time via inb() */
        for (let i = 4; i < resp.length; i++)
            rt.push_io_read(WEBX_PORT, 1, resp[i]);
    };

    function drainIoPorts() {
        const raw = rt.drain_io_writes();
        if (raw === '[]') return;
        const writes = JSON.parse(raw);
        for (const { port, size, val } of writes) {
            if (port !== WEBX_PORT) continue;
            /* Guest uses outb (size=1) byte-by-byte; handle wider writes defensively */
            const bytes = new Uint8Array(size);
            for (let i = 0; i < size; i++) bytes[i] = (val >>> (i * 8)) & 0xFF;
            bridge.handleWrite(bytes);
        }
    }

    /* ── Network bridge (TCP-over-WebSocket) ── */
    /*
     * Wine/wineserver and other guest processes open TCP sockets.
     * Canary queues connect() calls; we forward them via WebSocket to a
     * TCP proxy (node harness/tcp-proxy.mjs) listening on port 3001.
     */
    function runNetworkPoll() {
        /* Open WebSocket connections for any pending connect() calls. */
        let connectJson;
        try { connectJson = rt.drain_connect_requests(); }
        catch (_) { connectJson = '[]'; }

        const connects = JSON.parse(connectJson);
        for (const req of connects) {
            if (_wsMap.has(req.fd)) continue;
            try {
                const url = `${TCP_PROXY_BASE}/${req.ip}/${req.port}`;
                const ws  = new WebSocket(url);
                ws.binaryType = 'arraybuffer';
                ws.onopen    = () => rt.socket_connected(BigInt(req.fd));
                ws.onmessage = (e) => rt.socket_recv_data(BigInt(req.fd), new Uint8Array(e.data));
                ws.onclose   = () => _wsMap.delete(req.fd);
                ws.onerror   = () => {}; /* connection refused — leave as Connecting */
                _wsMap.set(req.fd, ws);
            } catch (_) {}
        }

        /* Forward any pending outbound socket data. */
        let sendJson;
        try { sendJson = rt.drain_socket_sends(); }
        catch (_) { sendJson = '[]'; }

        const sends = JSON.parse(sendJson);
        for (const req of sends) {
            const ws = _wsMap.get(req.fd);
            if (ws?.readyState === WebSocket.OPEN) {
                try {
                    const bin = atob(req.data);
                    const buf = new Uint8Array(bin.length);
                    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
                    ws.send(buf);
                } catch (_) {}
            }
        }

        requestAnimationFrame(runNetworkPoll);
    }
    requestAnimationFrame(runNetworkPoll);

    /* ── Thread spawning ── */
    /*
     * When the guest calls clone(), Canary queues a CloneInfo record.
     * We drain these each frame and spawn a Web Worker per entry.
     * Each Worker runs its own CanaryRuntime for the child thread.
     */
    function drainCloneRequests() {
        let cloneJson;
        try { cloneJson = rt.drain_clone_requests(); }
        catch (_) { return; }
        if (cloneJson === '[]') return;
        for (const req of JSON.parse(cloneJson))
            spawnWorkerThread(req).catch(e => console.error('[WebX] Worker spawn failed:', e));
    }

    async function spawnWorkerThread(req) {
        const { tid, child_stack, tls, child_tidptr } = req;
        console.log(`[WebX] Spawning thread Worker tid=${tid}`);

        const worker = new Worker(new URL('./worker.mjs', import.meta.url), { type: 'module' });
        _workers.set(tid, worker);

        worker.onmessage = (e) => {
            const msg = e.data;
            if (msg.type === 'stdout' || msg.type === 'stderr') {
                if (consoleEl) consoleEl.textContent += dec.decode(msg.data);
            } else if (msg.type === 'clone') {
                /* Cascade: child thread itself called clone() */
                for (const r of JSON.parse(msg.requests))
                    spawnWorkerThread(r).catch(console.error);
            } else if (msg.type === 'exit') {
                console.log(`[WebX] Thread tid=${tid} exited (code=${msg.code})`);
                _workers.delete(tid);
            }
        };

        /* Send init params, then signal run once Worker confirms ready. */
        await new Promise((resolve) => {
            const origHandler = worker.onmessage;
            worker.onmessage = (e) => {
                if (e.data?.type === 'ready') {
                    worker.onmessage = origHandler;
                    resolve();
                } else {
                    origHandler(e);
                }
            };
            worker.postMessage({
                type:         'init',
                wasmModule:   _wasmModule,  /* null if caching failed — Worker loads independently */
                sharedMemory: _wasmMemory,  /* non-null only with pkg-threads WASM build */
                tid,
                childStack:   child_stack,
                tls,
                childTidptr:  child_tidptr,
            });
        });

        worker.postMessage({ type: 'run' });
    }

    /* ── Input event forwarding ── */
    /*
     * Keyboard and mouse events are forwarded to the guest via Canary's
     * evdev emulation layer (/dev/input/event0).
     * Canvas must be focusable (tabindex) to receive keyboard events.
     */
    canvas.setAttribute('tabindex', '0');

    canvas.addEventListener('keydown', (e) => {
        e.preventDefault();
        rt.push_key_event(e.code, true);
    });
    canvas.addEventListener('keyup', (e) => {
        e.preventDefault();
        rt.push_key_event(e.code, false);
    });
    canvas.addEventListener('mousemove', (e) => {
        const rect = canvas.getBoundingClientRect();
        const x = Math.round((e.clientX - rect.left) * (FB_WIDTH  / rect.width));
        const y = Math.round((e.clientY - rect.top)  * (FB_HEIGHT / rect.height));
        rt.push_mouse_move(x, y);
    });
    canvas.addEventListener('mousedown', (e) => rt.push_mouse_button(e.button, true));
    canvas.addEventListener('mouseup',   (e) => rt.push_mouse_button(e.button, false));
    /* Focus canvas on click so keyboard events are captured. */
    canvas.addEventListener('click', () => canvas.focus());

    /* ── Environment and launch ── */
    const env = [
        'HOME=/root',
        'USER=gamer',
        'DISPLAY=:0',
        'XDG_RUNTIME_DIR=/run/user/1000',
        'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        'TERM=xterm-256color',
        'LANG=en_US.UTF-8',

        /* Route all Vulkan to the WebX ICD */
        'VK_DRIVER_FILES=/etc/vulkan/icd.d/vkwebx_icd.json',
        'VK_ICD_FILENAMES=/etc/vulkan/icd.d/vkwebx_icd.json',

        /* IPC port (read by guest ICD to call ioperm) */
        `WEBX_PORT=0x${WEBX_PORT.toString(16)}`,

        /* Proton / Wine — full x86-64 prefix */
        'WINEPREFIX=/home/gamer/.wine',
        'WINEARCH=win64',
        'WINEDEBUG=-all,+d3d,+vulkan',
        'PROTON_USE_WINED3D=0',
        'PROTON_NO_ESYNC=1',

        /* DXVK / VKD3D diagnostics */
        'DXVK_LOG_LEVEL=info',
        'DXVK_HUD=fps,devinfo,memory',
        'VKD3D_DEBUG=fixme',
    ];

    /* ── Locate and start bash ── */

    if (!rt.path_exists(LAUNCH_BIN))
        throw new Error(`Canary VFS: '${LAUNCH_BIN}' not found — is the guest image mounted?`);

    const elfBytes = rt.read_file(LAUNCH_BIN);
    if (!elfBytes || elfBytes.length === 0)
        throw new Error(`Canary VFS: read_file('${LAUNCH_BIN}') returned empty.`);

    /* ── Parse PT_INTERP and ensure the dynamic linker is in the VFS ── */
    // ELF64 PT_INTERP = segment type 3; e_phoff@32, e_phentsize@54, e_phnum@56
    async function ensureInterpreter(bytes) {
        const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (bytes[0] !== 0x7f || bytes[1] !== 69) return; // not ELF
        const phoff    = Number(v.getBigUint64(32, true));
        const phentsz  = v.getUint16(54, true);
        const phnum    = v.getUint16(56, true);
        for (let i = 0; i < phnum; i++) {
            const off  = phoff + i * phentsz;
            if (v.getUint32(off, true) !== 3) continue; // PT_INTERP
            const foff = Number(v.getBigUint64(off + 8, true));
            const fsz  = Number(v.getBigUint64(off + 32, true));
            const interp = new TextDecoder().decode(bytes.slice(foff, foff + fsz)).replace(/ /g, '');
            console.log(`[WebX] ELF interpreter: ${interp}`);
            if (rt.path_exists(interp)) return; // already in VFS
            setStatus(`Fetching interpreter: ${interp}…`);
            // Fetch from ext2, following symlinks (e.g. /lib64 → usr/lib on Arch)
            const result = await fetchExt2Resolved(interp);
            if (result && result.data.byteLength > 0) {
                rt.add_file(interp, result.data);
                if (result.resolvedPath !== interp) rt.add_file(result.resolvedPath, result.data);
                console.log(`[WebX] Interpreter injected: ${interp} (${result.data.byteLength} bytes)`);
            } else {
                console.warn(`[WebX] Could not fetch interpreter: ${interp}`);
            }
            return;
        }
    }
    await ensureInterpreter(elfBytes);

    const argvJson = JSON.stringify([LAUNCH_BIN, ...LAUNCH_ARGS]);
    const envpJson = JSON.stringify(env);

    console.log('[WebX] Starting guest: bash /opt/webx/launch.sh');

    const elfReady = rt.prepare_elf(elfBytes, argvJson, envpJson);
    if (!elfReady)
        throw new Error('Canary: prepare_elf() failed — check console for details.');

    /* ── Tier-1 JIT compilation loop ── */
    /*
     * Each frame, drain any basic blocks that the Rust JIT has promoted
     * to Tier-1 (hit_count >= 16).  Each entry is a {rip, wasm} record
     * where `wasm` is a self-contained WASM module that exports a `run`
     * function.  We compile it synchronously (small modules — typically
     * < 200 bytes) and hand the resulting function back to the runtime
     * via register_compiled_block().  Subsequent hits on the same block
     * will call the browser-JIT-compiled native code instead of the
     * interpreter.
     *
     * The module imports only `env.memory` — the same linear memory
     * used by the main Canary WASM binary so guest register state
     * (GPRs stored in a flat i64[17] array) is shared.
     */
    let _jitSharedMemory = null;

    function drainJitQueue() {
        let pending;
        try { pending = rt.drain_jit_queue(); } catch (_) { return; }
        if (!pending || pending.length === 0) return;

        /* Lazily obtain the Canary WASM linear memory (static method). */
        if (!_jitSharedMemory) {
            try { _jitSharedMemory = CanaryRuntime.wasm_memory(); }
            catch (_) { return; }
        }

        for (const { rip, wasm } of pending) {
            try {
                const mod  = new WebAssembly.Module(wasm);
                const inst = new WebAssembly.Instance(mod, { env: { memory: _jitSharedMemory } });
                rt.register_compiled_block(rip, inst.exports.run);
            } catch (e) {
                console.warn(`[WebX] JIT compile failed rip=0x${rip.toString(16)}:`, e.message);
                sentryCaptureError(`[WebX] JIT compile failed rip=0x${rip.toString(16)}: ${e.message}`, { rip });
            }
        }
    }

    /* ── Lazy VFS miss resolver ─────────────────────────────────────────────── */
    /*
     * Each frame we drain VFS misses (paths that returned ENOENT) and try to
     * resolve them from the ext2 image on demand.  Once fetched, the content
     * is injected into the runtime via add_file() so the next access succeeds.
     *
     * Paths are deduplicated globally so each path is fetched at most once.
     */
    const vfsMissesInFlight = new Set();

    function drainVfsMisses() {
        let misses;
        try { misses = rt.drain_vfs_misses(); } catch (_) { return; }
        if (!misses || misses.length === 0) return;

        for (let i = 0; i < misses.length; i++) {
            const p = misses[i];
            if (vfsMissesInFlight.has(p)) continue;
            vfsMissesInFlight.add(p);

            // Don't attempt to fetch /proc, /dev, /sys paths from ext2, or ld.so.cache
            // (whose blocks are at ~5.5 GB in the image causing browser fetch hangs).
            if (p.startsWith('/proc/') || p.startsWith('/dev/') || p.startsWith('/sys/')) continue;
            if (p === '/etc/ld.so.cache') continue;

            (async () => {
                try {
                    const data = await ext2Lookup(p);
                    if (data && data.length > 0) {
                        rt.add_file(p, data);
                        console.log(`[WebX] Lazy VFS: injected ${p} (${data.length} bytes)`);
                    }
                    // If length==0 the path genuinely doesn't exist — leave the miss recorded.
                } catch (e) {
                    console.warn(`[WebX] Lazy VFS: failed to fetch ${p}:`, e);
                }
            })();
        }
    }

    /* ── Step loop (requestAnimationFrame-driven) ── */
    /*
     * Run guest instructions for FRAME_BUDGET_MS per animation frame.
     * drainIoPorts() is called both intra-frame (every 1024 steps) and
     * at the end of each frame.  The intra-frame drain ensures that as
     * soon as the guest has written a complete Vulkan command packet,
     * VkBridge can parse and begin dispatching it — reducing the round-
     * trip latency from a full frame to a single async microtask tick.
     */
    function stepLoop() {
        const deadline = performance.now() + FRAME_BUDGET_MS;
        let alive = true;
        let steps = 0;

        while (performance.now() < deadline) {
            if (!rt.step()) { alive = false; break; }
            /* Drain IO every 1024 steps so VkBridge sees bytes promptly. */
            if ((++steps & 1023) === 0) drainIoPorts();
        }

        drainOutput();
        drainIoPorts();
        drainCloneRequests();
        drainJitQueue();
        drainVfsMisses();
        renderFramebuffer();

        if (alive) {
            requestAnimationFrame(stepLoop);
        } else {
            console.log('[WebX] Guest process exited.');
        }
    }

    requestAnimationFrame(stepLoop);
}
