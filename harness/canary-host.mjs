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

/* Canary WASM package — served from /canary/ by server.mjs */
const CANARY_WASM_URL    = '/canary/canary_wasm.js';
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

/* Active thread Workers, keyed by guest TID. */
const _workers = new Map();

/* Active TCP WebSocket connections, keyed by guest socket fd. */
const _wsMap = new Map();

/* ── Boot ─────────────────────────────────────────────────────────────────── */

export async function boot(canvas, consoleEl) {
    if (!navigator.gpu)
        throw new Error('WebGPU not available. Use Chrome 113+, Edge 113+, or Firefox Nightly.');

    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter found.');

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
    const wasmInitResult = await wasmMod.default();

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

    const { CanaryRuntime } = wasmMod;
    const rt = new CanaryRuntime();
    console.log('[WebX] Canary runtime ready.');

    /* ── Fetch and mount SteamOS ext2 image ── */
    console.log(`[WebX] Fetching guest image: ${STEAMOS_IMAGE_URL}`);
    const imgResp = await fetch(STEAMOS_IMAGE_URL);
    if (!imgResp.ok)
        throw new Error(`Failed to fetch guest image: HTTP ${imgResp.status}`);
    const imgBytes = new Uint8Array(await imgResp.arrayBuffer());
    console.log(`[WebX] Image: ${(imgBytes.byteLength / 1024 / 1024).toFixed(0)} MiB`);
    rt.load_fs_image(imgBytes);
    console.log('[WebX] VFS populated from ext2 image.');

    /* ── Console output (drain stdout/stderr each frame) ── */
    const dec = new TextDecoder();
    function drainOutput() {
        const out = rt.drain_stdout();
        const err = rt.drain_stderr();
        const both = new Uint8Array(out.length + err.length);
        both.set(out);
        both.set(err, out.length);
        if (both.length > 0 && consoleEl)
            consoleEl.textContent += dec.decode(both);
    }

    /* ── Framebuffer rendering (/dev/fb0 → HTML canvas) ── */
    canvas.width  = FB_WIDTH;
    canvas.height = FB_HEIGHT;
    const ctx2d = canvas.getContext('2d');
    const fbImageData = ctx2d.createImageData(FB_WIDTH, FB_HEIGHT);

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
                type:        'init',
                wasmModule:  _wasmModule,   /* null if caching failed — Worker loads independently */
                tid,
                childStack:  child_stack,
                tls,
                childTidptr: child_tidptr,
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
    const LAUNCH_BIN  = '/bin/bash';
    const LAUNCH_ARGS = ['/opt/webx/launch.sh'];

    if (!rt.path_exists(LAUNCH_BIN))
        throw new Error(`Canary VFS: '${LAUNCH_BIN}' not found — is the guest image mounted?`);

    const elfBytes = rt.read_file(LAUNCH_BIN);
    if (!elfBytes || elfBytes.length === 0)
        throw new Error(`Canary VFS: read_file('${LAUNCH_BIN}') returned empty.`);

    const argvJson = JSON.stringify([LAUNCH_BIN, ...LAUNCH_ARGS]);
    const envpJson = JSON.stringify(env);

    console.log('[WebX] Starting guest: bash /opt/webx/launch.sh');

    const elfReady = rt.prepare_elf(elfBytes, argvJson, envpJson);
    if (!elfReady)
        throw new Error('Canary: prepare_elf() failed — check console for details.');

    /* ── Step loop (requestAnimationFrame-driven) ── */
    function stepLoop() {
        const deadline = performance.now() + FRAME_BUDGET_MS;
        while (performance.now() < deadline) {
            if (!rt.step()) {
                drainOutput();
                drainIoPorts();
                drainCloneRequests();
                renderFramebuffer();
                console.log('[WebX] Guest process exited.');
                return;
            }
        }
        drainOutput();
        drainIoPorts();
        drainCloneRequests();
        renderFramebuffer();
        requestAnimationFrame(stepLoop);
    }

    requestAnimationFrame(stepLoop);
}
