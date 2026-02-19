# WebX — Claude Session Context

WebX runs x86 Windows/Steam games in the browser via WebGPU.
Pipeline: **DX9/10/11 → Proton (Wine + DXVK + VKD3D-Proton) → Vulkan → VkWebGPU-ICD → Browser WebGPU**
VM: **CheerpX** (x86 Linux emulator in browser) booting a real SteamOS image.

## Architecture

```
Browser (host)
├── harness/index.html           — UI, WebGPU init, canvas
├── harness/server.mjs           — Node dev server (port 3000, COOP/COEP headers)
├── harness/cheerpx-host.mjs    — CheerpX boot, IPC doorbell handler
├── harness/vk-bridge.mjs       — Binary Vulkan packet framer/dispatcher
└── harness/vkwebgpu-plugin.mjs — VkWebGPU-ICD stub (SWAP THIS for real ICD)

CheerpX Guest (x86 SteamOS inside browser)
├── /opt/webx/launch.sh          — Starts Xorg + Proton
├── /usr/local/lib/libvkwebx.so  — Our Vulkan ICD (built from guest-icd/)
└── /etc/vulkan/icd.d/vkwebx_icd.json

IPC Bridge (filesystem + doorbell)
├── /webx/cmd.bin  ← guest writes Vulkan command packets
├── /webx/rsp.bin  → guest reads responses (written by host)
└── x86 I/O port 0x7860 — guest outb() doorbell, host registerPortListener()
```

### Why Proton (not bare Wine)
Proton includes: Wine + DXVK + VKD3D-Proton + DXVK-NVAPI + vkd3d-shader +
wine-mono + wine-gecko + FAudio + Protonfixes + Steam Runtime Sniper.
This is tens of thousands of hours of compatibility work; Valve maintains it full-time.
Steam Deck Verified database gives per-game fix coverage.

### VkWebGPU-ICD is separate
Developed at https://github.com/Dankular/VkWebGPU-ICD (Rust, wgpu 0.20, Naga SPIR-V→WGSL).
We stub it in `harness/vkwebgpu-plugin.mjs`. Replace `loadPlugin()` import when ready.

## Key Design Decision: CheerpX IPC Bridge

CheerpX 1.2.7 has **NO public custom character device API**.
- No `customDevices` field (confirmed — this was an initial wrong assumption)
- No `onRead`/`onWrite`/`onIoctl`
- IDBDevice files written by the guest have **no documented host JS read API**

### Confirmed `registerPortListener` signature (from reverse-engineering cx.js 1.2.5/1.2.6)

```javascript
cx.registerPortListener(portNumber: number, callback: (hostPort: MessagePort) => void): void
```

The callback receives a **`MessagePort`** object — NOT `(port, value, isWrite)`.
It is called ONCE on the first guest IN/OUT to the registered port, establishing a
persistent bidirectional `MessageChannel`.

### Mechanism (pure MessagePort, no files)

```
Guest outb(byte, 0x7860)  →  hostPort.onmessage fires  →  bridge.handleWrite([byte])
bridge.onResponseReady(resp)  →  hostPort.postMessage({data: resp})  →  guest inb(0x7860)
```

1. Guest streams command bytes via repeated `outb(byte, 0x7860)` (one byte per call)
2. Host accumulates in `hostPort.onmessage`, `VkBridge` detects complete packets via magic+length
3. `VkBridge.#dispatch()` calls `plugin.dispatch()`, builds response packet
4. `bridge.onResponseReady` callback calls `hostPort.postMessage({ data: resp })`
5. CheerpX queues response bytes in the port's FIFO
6. Guest polls `inl(0x7860)` — returns `0xFFFFFFFF` when empty, or first 4 bytes of response
7. Guest reads `result` + `len` + payload via `inb(0x7860)` (one byte at a time)

`0xFFFFFFFF` is reserved as the "empty FIFO" sentinel; the seq counter skips that value.

### `registerPortListener` version history
- Added in **CheerpX v1.2.5** (replaced the removed `createUnixListener`)
- Use CheerpX `>= 1.2.5` (current: 1.2.7)

TODO: File CheerpX feature request at https://github.com/leaningtech/cheerpx-meta/issues
for a proper documented chardev API or socket API.

## Wire Protocol

**Packet header** (16 bytes, little-endian):
- `magic`   u32 = `0x58574756` ("VGWX")
- `cmd`     u32 = VkWebXCmd enum value
- `seq`     u32 = sequence number (atomic counter)
- `len`     u32 = payload length in bytes

**Response header** (12 bytes):
- `seq`     u32 = matching sequence number
- `result`  i32 = VkResult (0 = VK_SUCCESS, negative = error)
- `len`     u32 = response data length

See `protocol/commands.h` for ~80 VkWebXCmd values.
See `protocol/wire-format.md` for full spec.

## Files Created

| File | Purpose |
|------|---------|
| `protocol/commands.h` | VkWebXCmd enum, packet/response headers, WebXSurfaceCaps |
| `protocol/wire-format.md` | Full wire protocol specification |
| `guest-icd/src/vkwebx.c` | Vulkan ICD core: instance, device, queue, sync, dispatch table |
| `guest-icd/src/vkwebx_resources.c` | Memory, buffers, images, views, samplers, transfer cmds |
| `guest-icd/src/vkwebx_pipeline.c` | Shaders, pipelines, render passes, descriptors, draw cmds |
| `guest-icd/src/vkwebx_surface.c` | Surface (XCB), swapchain, present modes, device queries |
| `guest-icd/src/vkwebx_wire.h` | WebXBuf builder, webx_packet_build/read_response/new_handle |
| `guest-icd/vkwebx_icd.json` | Vulkan loader manifest → /usr/local/lib/libvkwebx.so |
| `guest-icd/vkwebx.map` | Linker version script (exports 3 ICD entry points) |
| `guest-icd/CMakeLists.txt` | Cross-compile build (x86-64 Linux target) |
| `cmake/x86_64-linux-gnu.cmake` | CMake toolchain: x86_64-linux-gnu-gcc |
| `harness/index.html` | Browser UI with WebGPU + crossOriginIsolated checks |
| `harness/server.mjs` | Node.js dev server, port 3000, COOP/COEP/CORP headers |
| `harness/cheerpx-host.mjs` | CheerpX boot, mounts, IPC doorbell, env vars |
| `harness/vk-bridge.mjs` | Packet accumulator → plugin dispatcher → response queue |
| `harness/vkwebgpu-plugin.mjs` | VkWebGPU-ICD stub (placeholder WebGPU frame render) |
| `steam/launch.sh` | /opt/webx/launch.sh inside SteamOS: Xorg + Proton |
| `steam/extract-image.py` | Windows-native: decompress .bz2 + extract GPT rootfs partition |
| `steam/extract-rootfs.sh` | Linux/WSL: loop mount, install ICD, ext4→ext2 |
| `steam/extract-image.ps1` | PowerShell helper (calls 7-Zip or guides to WSL/Docker) |
| `steam/prepare-image.sh` | Original Docker approach (superseded) |

## SteamOS Image Status

Source: `C:\Users\Dan\Downloads\steamdeck-repair-20250521.10-3.7.7.img.bz2`

```
steam/steamdeck-repair.img   ~7,385 MB  ← decompressed full GPT disk image  ✓ DONE
steam/steamos-rootfs.img     ~5,120 MB  ← rootfs partition extracted         ✓ DONE
```

**steamos-rootfs.img is ext4.** CheerpX requires ext2 (or CheerpX may accept ext4 — untested).

**Remaining:** Run `steam/extract-rootfs.sh` in WSL to:
1. Resize image by +256 MB (room for ICD)
2. Mount it and install `libvkwebx.so` + `vkwebx_icd.json` + `launch.sh`
3. Remove competing ICDs (intel/radeon/nvidia/lvp/dzn)
4. Run `ldconfig`
5. Convert ext4 → ext2 via `tune2fs` (disables journal, extent, flex_bg)

## Current Blockers

### WSL2 Broken
```
> wsl --status
Error code: Wsl/REGDB_E_CLASSNOTREGISTERED
```
**Fix after reboot:**
1. Open "Turn Windows features on or off"
2. Enable: **Windows Subsystem for Linux** + **Virtual Machine Platform**
3. Reboot
4. `wsl --install Ubuntu`
5. Then run: `bash steam/extract-rootfs.sh steam/steamdeck-repair.img steam/`

### libvkwebx.so not yet compiled
Needs WSL (or Docker) with cross-compile toolchain:
```bash
# In WSL Ubuntu:
sudo apt-get install -y cmake gcc-x86-64-linux-gnu libvulkan-dev
# In repo root:
npm run build:icd
# Or via Docker (if Docker Desktop installed):
npm run build:icd:docker
```
Output: `build/guest-icd/libvkwebx.so`

### SteamOS image not yet served
After building libvkwebx.so and running extract-rootfs.sh:
- Serve `steam/steamos-webx.ext2` at URL accessible to browser
- Update `STEAMOS_IMAGE_URL` constant in `harness/cheerpx-host.mjs`
- Run `npm run dev` and open `http://localhost:3000`

## npm Scripts

```bash
npm run dev              # Start browser dev server (port 3000)
npm run extract:image    # Decompress .bz2 + extract rootfs (Windows, Python)
npm run extract:rootfs   # Install ICD into image, ext4→ext2 (Linux/WSL)
npm run build:icd        # Cross-compile libvkwebx.so (WSL required)
npm run build:icd:docker # Same via Docker (Docker Desktop required)
```

## Immediate Next Steps (post-reboot)

1. **Fix WSL2** (Windows Features → enable WSL + VMP → reboot → `wsl --install Ubuntu`)
2. **Build libvkwebx.so**: `npm run build:icd` from WSL
3. **Install ICD into SteamOS image**: `bash steam/extract-rootfs.sh steam/steamdeck-repair.img steam/`
4. **Serve image + run dev server**: `npm run dev`, open localhost:3000
5. **File CheerpX feature request** for chardev API: https://github.com/leaningtech/cheerpx-meta/issues
6. **Wire in real VkWebGPU-ICD** when ready: edit `harness/vkwebgpu-plugin.mjs` `loadPlugin()`

## CheerpX API Reference (confirmed 1.2.7, source: reverse-engineered cx.js)

```js
import { Linux } from "https://cxrtnc.leaningtech.com/1.2.7/cx.esm.js";

const cx = await Linux.create({
    mounts: [
        { type: "ext2", path: "/", dev: OverlayDevice(HttpBytesDevice(url), IDBDevice('rw')) },
        { type: "devs", path: "/dev" },
        { type: "proc", path: "/proc" },
    ],
    networkInterface: { authKey: null },
});
cx.setKmsCanvas(canvas, 1280, 720);
cx.setCustomConsole(writeFn, 220, 50);

// CORRECT SIGNATURE: callback receives MessagePort, not (port, value, isWrite)
cx.registerPortListener(0x7860, (hostPort) => {
    bridge.onResponseReady = (resp) => hostPort.postMessage({ data: resp });
    hostPort.onmessage = (ev) => {
        const byte = typeof ev.data === 'number' ? ev.data & 0xFF
                   : Number(ev.data?.value ?? ev.data?.data?.[0] ?? 0) & 0xFF;
        bridge.handleWrite(new Uint8Array([byte]));
    };
});

cx.registerCallback('ready', () => { /* boot complete */ });
await cx.run('/bin/bash', ['/opt/webx/launch.sh'], { env: [...] });
```

### Other undocumented APIs found in cx.js (absent from type definitions)
| Method | Notes |
|--------|-------|
| `setKmsCanvas(canvas, w, h)` | Wires canvas to KMS/DRM framebuffer for Xorg |
| `registerPortListener(port, cb)` | **Added v1.2.5**, replaces removed `createUnixListener` |
| `setOffscreenCanvasCallback(cb)` | Alternative offscreen rendering path |
| `setJITErrorCallback(cb)` | Called on JIT compilation failures |
| `flushIO()` | Flush pending I/O before extracting IDB state |

## Key Environment Variables (passed to CheerpX guest)

```
VK_DRIVER_FILES=/etc/vulkan/icd.d/vkwebx_icd.json
WEBX_CMD_PATH=/webx/cmd.bin
WEBX_RSP_PATH=/webx/rsp.bin
WEBX_PORT=0x7860
DXVK_HUD=fps
VKD3D_DEBUG=fixme
PROTON_USE_WINED3D=0
DISPLAY=:0
```
