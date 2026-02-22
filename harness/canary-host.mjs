/**
 * WebX Canary Host
 *
 * Boots an x86-64 Linux guest in Canary (open-source WASM x86-64 emulator)
 * and bridges Vulkan commands from the guest ICD (libvkwebx.so) to the
 * WebGPU device running on the host.
 *
 * ## Canary vs CheerpX
 *   - Full x86-64 ELF support (CheerpX was limited to 32-bit i386)
 *   - Self-hosted WASM — no CDN dependency, fully open source
 *   - Framebuffer at /dev/fb0 (1024×768 BGRA) → canvas blit via get_framebuffer()
 *   - pthreads via SharedArrayBuffer + Web Workers
 *   - x86 IN/OUT port instructions (0xEC–0xEF) emulated natively
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
 *   step() is then called in requestAnimationFrame batches, interleaved with
 *   I/O port draining and framebuffer blitting.
 */

import { VkBridge }  from './vk-bridge.mjs';
import { loadPlugin } from './vkwebgpu-plugin.mjs';

/* Canary WASM package — served from /canary/ by server.mjs */
const CANARY_WASM_URL = '/canary/canary_wasm.js';

/* x86-64 SteamOS guest image (ext2, with libvkwebx.so pre-installed) */
const STEAMOS_IMAGE_URL = '/steam/steamos-webx.ext2';

/* x86 I/O port used as the guest↔host IPC doorbell (same as CheerpX design) */
const WEBX_PORT = 0x7860;

/* Framebuffer resolution Canary exposes via /dev/fb0 */
const FB_WIDTH  = 1280;
const FB_HEIGHT = 720;

/* Execution budget per animation frame (ms). */
const FRAME_BUDGET_MS = 10;

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
    await wasmMod.default(); /* run wasm-bindgen __wbg_init() */
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
     * Canary emulates x86 IN/OUT instructions via its IoCtx (canary-io crate).
     * We use the polling API:
     *
     *   Guest → Host: outb(byte, 0x7860)
     *                 → queued in IoCtx.pending_writes
     *                 → drained by rt.drain_io_writes() each frame
     *                 → fed to VkBridge.handleWrite()
     *
     *   Host → Guest: bridge.onResponseReady(resp)
     *                 → rt.push_io_read(port, 4, seqU32)  ← unblocks inl()
     *                 → rt.push_io_read(port, 1, byte) × N ← data via inb()
     *
     * Response layout (from guest protocol):
     *   inl() returns the first 4 bytes (seq u32 LE, never 0xFFFFFFFF).
     *   Remaining bytes are read via inb() one at a time: result(4) + len(4) + payload.
     */
    bridge.onResponseReady = (resp) => {
        /* First 4 bytes of resp = seq u32 LE — returned by guest's inl() poll */
        const view = new DataView(resp.buffer, resp.byteOffset);
        const seqU32 = view.getUint32(0, true);
        rt.push_io_read(WEBX_PORT, 4, seqU32);
        /* Remaining bytes delivered one at a time via inb() */
        for (let i = 4; i < resp.length; i++) {
            rt.push_io_read(WEBX_PORT, 1, resp[i]);
        }
    };

    /* Drain all pending guest outb() writes and feed bytes to the Vulkan bridge. */
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

    /* ── Step loop (requestAnimationFrame-driven) ──
     *
     * prepare_elf() loads the ELF, sets up memory/stack/CPU, and returns.
     * step() then drives execution one instruction at a time.
     *
     * After each frame budget of steps:
     *   1. Drain stdout/stderr for the console display.
     *   2. Drain I/O port writes (outb packets) and feed to VkBridge.
     *   3. Blit the framebuffer to canvas.
     *
     * drainIoPorts() may trigger bridge.onResponseReady() asynchronously
     * (WebGPU dispatch is async). push_io_read() queues the response bytes
     * so the guest's next inl()/inb() spin picks them up immediately.
     */
    const elfReady = rt.prepare_elf(elfBytes, argvJson, envpJson);
    if (!elfReady)
        throw new Error('Canary: prepare_elf() failed — check console for details.');

    function stepLoop() {
        const deadline = performance.now() + FRAME_BUDGET_MS;
        while (performance.now() < deadline) {
            if (!rt.step()) {
                drainOutput();
                drainIoPorts();
                renderFramebuffer();
                console.log('[WebX] Guest process exited.');
                return;
            }
        }
        drainOutput();
        drainIoPorts();
        renderFramebuffer();
        requestAnimationFrame(stepLoop);
    }

    requestAnimationFrame(stepLoop);
}
