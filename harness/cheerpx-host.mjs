/**
 * WebX CheerpX Host
 *
 * Boots the SteamOS image in CheerpX and bridges Vulkan commands from the
 * guest ICD to the VkWebGPU-ICD plugin running on the host.
 *
 * ## IPC Mechanism (CheerpX 1.2.5+)
 *
 *   cx.registerPortListener(port, (hostPort: MessagePort) => void)
 *
 *   This is the CORRECT signature — the callback receives a MessagePort object,
 *   NOT (port, value, isWrite) as the name might imply.
 *
 *   The MessagePort is established the first time the guest executes any IN/OUT
 *   instruction on the registered port.  After that it's a persistent bidirectional
 *   byte stream:
 *
 *     Guest → Host:  each outb(byte, port) fires hostPort.onmessage.
 *                    event.data contains the value written to the port.
 *     Host → Guest:  hostPort.postMessage({ data: Uint8Array }) queues bytes
 *                    that become readable by the guest via subsequent inb(port).
 *
 *   CheerpX returns 0xFFFFFFFF from inl(port) when no data is queued.
 *   The guest ICD polls inl() until it gets the expected response seq number.
 *
 * ## CheerpX API reference (confirmed 1.2.7, source: reverse-engineered cx.js)
 *
 *   Linux.create({ mounts, networkInterface })
 *   cx.setKmsCanvas(canvas, width, height)
 *   cx.setCustomConsole(writeFn, cols, rows)
 *   cx.registerCallback(eventName, cb)
 *   cx.registerPortListener(port, cb: (hostPort: MessagePort) => void)
 *   cx.run(path, args, { env, cwd, uid, gid })
 *
 * ## Undocumented API NOT available (confirmed absent):
 *   - customDevices (no chardev hook)
 *   - onRead / onWrite / onIoctl
 *   - Any direct IDBDevice host-side file read API
 *
 * Feature request: https://github.com/leaningtech/cheerpx-meta/issues
 */

import { VkBridge }  from './vk-bridge.mjs';
import { loadPlugin } from './vkwebgpu-plugin.mjs';

/* Use the latest confirmed-stable CheerpX release */
const CX_CDN = 'https://cxrtnc.leaningtech.com/1.2.7/cx.esm.js';

/* SteamOS ext2 images produced by steam/prepare-image.sh (served from repo root/steam/) */
const STEAMOS_ROOTFS_URL = '/steam/steamos-rootfs.ext2';
const STEAMOS_PROTON_URL = '/steam/steamos-proton.ext2';

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

    /* ── Mount SteamOS images (read-only base + persistent overlay each) ── */
    /* steamos-rootfs.ext2 → / */
    const roRoot  = await HttpBytesDevice.create(STEAMOS_ROOTFS_URL);
    const rwRoot  = await IDBDevice.create('webx-root-rw');
    const rootDev = await OverlayDevice.create(roRoot, rwRoot);

    /* steamos-proton.ext2 → /opt (GE-Proton10-32 + webx scripts) */
    const roProton  = await HttpBytesDevice.create(STEAMOS_PROTON_URL);
    const rwProton  = await IDBDevice.create('webx-proton-rw');
    const protonDev = await OverlayDevice.create(roProton, rwProton);

    /* ── Boot Linux ── */
    const cx = await Linux.create({
        mounts: [
            { type: 'ext2', path: '/',    dev: rootDev   },
            { type: 'ext2', path: '/opt', dev: protonDev },
            { type: 'devs', path: '/dev'                 },
            { type: 'proc', path: '/proc'                },
        ],
        networkInterface: { authKey: null },
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

    /* ── CheerpX lifecycle events ── */
    cx.registerCallback('ready', () => console.log('[WebX] CheerpX ready'));

    /* ── Launch Proton + game ── */
    const env = [
        'HOME=/root',
        'USER=gamer',
        'DISPLAY=:0',
        'XDG_RUNTIME_DIR=/run/user/1000',

        /* Route all Vulkan to VkWebGPU ICD (libvkwebgpu.so, installed by prepare-image.sh) */
        'VK_DRIVER_FILES=/etc/vulkan/icd.d/vkwebgpu_icd.json',
        'VK_ICD_FILENAMES=/etc/vulkan/icd.d/vkwebgpu_icd.json',

        /* WebX IPC port (read by guest ICD to call ioperm) */
        `WEBX_PORT=0x${WEBX_PORT.toString(16)}`,

        /* DXVK / VKD3D diagnostics */
        'DXVK_LOG_LEVEL=info',
        'DXVK_HUD=fps,devinfo,memory',
        'VKD3D_DEBUG=err',

        /* Proton — GE-Proton10-32 installed at /opt/GE-Proton10-32 by prepare-image.sh */
        'PROTON_PATH=/usr/bin/proton',
        'STEAM_COMPAT_DATA_PATH=/home/gamer/.proton',
        'STEAM_COMPAT_CLIENT_INSTALL_PATH=/opt/GE-Proton10-32',
        /* Disable esync/fsync: CheerpX eventfd/futex emulation is incomplete */
        'PROTON_NO_ESYNC=1',
        'PROTON_NO_FSYNC=1',
        'PROTON_USE_WINED3D=0',
    ];

    await cx.run('/bin/bash', ['/opt/webx/launch.sh'], { env });
}
