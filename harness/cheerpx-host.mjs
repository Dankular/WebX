/**
 * WebX CheerpX Host
 *
 * Boots an i386 Debian guest in CheerpX and bridges Vulkan commands from the
 * guest ICD (libvkwebgpu.so) to the WebGPU device running on the host.
 *
 * ## CheerpX constraints (confirmed 1.2.7)
 *   - Only 32-bit (i386) Linux ELF binaries are supported
 *   - HttpBytesDevice: max ~2 GB per image (single image — no split needed at <1.5 GB)
 *   - registerCallback: no 'ready' event; only 'error' and similar internal events
 *
 * ## IPC Mechanism (CheerpX 1.2.5+)
 *
 *   cx.registerPortListener(port, (hostPort: MessagePort) => void)
 *
 *   Callback fires on the first guest IN/OUT to the registered port.
 *   After that it's a persistent bidirectional byte stream:
 *
 *     Guest → Host:  each outb(byte, port) fires hostPort.onmessage
 *     Host → Guest:  hostPort.postMessage({ data: Uint8Array }) queues bytes
 *
 *   CheerpX returns 0xFFFFFFFF from inl(port) when no data is queued.
 */

import { VkBridge }  from './vk-bridge.mjs';
import { loadPlugin } from './vkwebgpu-plugin.mjs';

/* Use the latest confirmed-stable CheerpX release */
const CX_CDN = 'https://cxrtnc.leaningtech.com/1.2.7/cx.esm.js';

/* i386 Debian guest image (single image, < 2 GB — Wine + DXVK + VkWebGPU ICD) */
const STEAMOS_ROOTFS_URL = '/steam/steamos-rootfs.ext2';

/* x86 I/O port used as the guest↔host IPC channel */
const WEBX_PORT = 0x7860;

export async function boot(canvas, consoleEl) {
    if (!navigator.gpu)
        throw new Error('WebGPU not available. Use Chrome 113+ or Edge 113+.');

    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter found.');

    /* Request only universally available features to maximise compatibility */
    const deviceDesc = { requiredLimits: {} };
    if (adapter.features.has('texture-compression-bc'))
        deviceDesc.requiredFeatures = ['texture-compression-bc'];

    const device = await adapter.requestDevice(deviceDesc);
    device.lost.then(i => console.error('[WebX] WebGPU device lost:', i.message));

    /* ── VkWebGPU-ICD plugin ── */
    const plugin = await loadPlugin();
    await plugin.initialize(adapter, device, canvas);
    const bridge = new VkBridge(plugin);

    /* ── Load CheerpX ── */
    const CX = await import(/* @vite-ignore */ CX_CDN);
    const { Linux, HttpBytesDevice, IDBDevice, OverlayDevice } = CX;

    /* ── Mount i386 guest image ── */
    /* Single ext2 image: i386 Debian + Wine32 + DXVK + VkWebGPU ICD */
    const roRoot  = await HttpBytesDevice.create(STEAMOS_ROOTFS_URL);
    const rwRoot  = await IDBDevice.create('webx-root-rw');
    const rootDev = await OverlayDevice.create(roRoot, rwRoot);

    /* ── Boot Linux ── */
    const cx = await Linux.create({
        mounts: [
            { type: 'ext2', path: '/',    dev: rootDev },
            { type: 'devs', path: '/dev'               },
            { type: 'proc', path: '/proc'              },
        ],
        networkInterface: { authKey: null },  /* community license — no Tailscale */
    });

    /* ── KMS canvas ── */
    cx.setKmsCanvas(canvas, canvas.width, canvas.height);

    /* ── Console output ── */
    const dec = new TextDecoder();
    if (consoleEl) {
        cx.setCustomConsole(
            (buf) => { consoleEl.textContent += dec.decode(buf); },
            220, 50
        );
    }

    /* ── x86 I/O port bridge ── */
    /*
     * registerPortListener(port, callback)
     *   callback receives a MessagePort — the FIRST access to the port from
     *   the guest triggers this callback.  After that, the port is a streaming
     *   bidirectional channel via the MessagePort.
     *
     * Guest → Host (command bytes):
     *   Each outb(byte, WEBX_PORT) fires hostPort.onmessage.
     *   event.data is the byte value (format may vary: plain number or object).
     *   We handle both: number → use directly; object → try .value / .data[0].
     *
     * Host → Guest (response bytes):
     *   hostPort.postMessage({ data: Uint8Array }) queues bytes that the guest
     *   reads via inb(WEBX_PORT).  CheerpX returns 0xFFFFFFFF from inl() when
     *   the queue is empty, so the guest polls until it sees its seq number.
     */
    if (typeof cx.registerPortListener === 'function') {
        cx.registerPortListener(WEBX_PORT, (hostPort) => {
            console.log('[WebX] MessagePort IPC established on port 0x' +
                        WEBX_PORT.toString(16));

            /* Wire bridge response callback: push responses back to guest */
            bridge.onResponseReady = (resp) => {
                /*
                 * Send the complete response Uint8Array to the guest.
                 * The guest reads it byte-by-byte via inb(WEBX_PORT).
                 * Transfer the underlying ArrayBuffer for zero-copy.
                 */
                hostPort.postMessage({ data: resp }, [resp.buffer]);
            };

            /* Receive command bytes from the guest */
            hostPort.onmessage = (event) => {
                const raw = event.data;
                let byte;
                if (typeof raw === 'number') {
                    byte = raw & 0xFF;
                } else if (raw instanceof Uint8Array) {
                    byte = raw[0] ?? 0;
                } else if (raw?.value !== undefined) {
                    byte = Number(raw.value) & 0xFF;
                } else if (raw?.data instanceof Uint8Array) {
                    byte = raw.data[0] ?? 0;
                } else {
                    byte = 0;
                }
                bridge.handleWrite(new Uint8Array([byte]));
            };
        });
        console.log('[WebX] Waiting for guest to connect on port 0x' +
                    WEBX_PORT.toString(16));
    } else {
        console.error('[WebX] cx.registerPortListener not available — CheerpX < 1.2.5?');
        console.error('[WebX] Vulkan bridge will not function.');
    }

    /* ── Launch Wine + game ── */
    const env = [
        'HOME=/root',
        'USER=gamer',
        'DISPLAY=:0',
        'XDG_RUNTIME_DIR=/run/user/1000',

        /* Route all Vulkan to VkWebGPU ICD (libvkwebgpu.so, i386 build) */
        'VK_DRIVER_FILES=/etc/vulkan/icd.d/vkwebgpu_icd.json',
        'VK_ICD_FILENAMES=/etc/vulkan/icd.d/vkwebgpu_icd.json',

        /* WebX IPC port (read by guest ICD to call ioperm) */
        `WEBX_PORT=0x${WEBX_PORT.toString(16)}`,

        /* DXVK diagnostics */
        'DXVK_LOG_LEVEL=info',
        'DXVK_HUD=fps,devinfo,memory',

        /* Wine settings — 32-bit prefix, disable Wine's own D3D (use DXVK) */
        'WINEPREFIX=/home/gamer/.wine',
        'WINEARCH=win32',
        'WINEDEBUG=-all,+d3d,+vulkan',
    ];

    await cx.run('/bin/bash', ['/opt/webx/launch.sh'], { env, uid: 0, gid: 0 });
}
