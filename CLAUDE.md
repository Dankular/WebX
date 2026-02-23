# WebX — Claude Session Context

WebX runs x86-64 Windows/Steam games in the browser via WebGPU.
Pipeline: **DX9/10/11/12 → Proton (Wine + DXVK + VKD3D-Proton) → Vulkan → VkWebGPU-ICD → Browser WebGPU**
VM: **Canary** (x86-64 Linux WASM emulator, open source) booting a real SteamOS image.

## Architecture

```
Browser (host)
├── harness/index.html           — UI, WebGPU init, canvas
├── harness/server.mjs           — Node dev server (port 3000, COOP/COEP headers)
├── harness/canary-host.mjs      — Canary boot, IPC doorbell handler, framebuffer
├── harness/vk-bridge.mjs        — Binary Vulkan packet framer/dispatcher
└── harness/vkwebgpu-plugin.mjs  — VkWebGPU-ICD stub (SWAP THIS for real ICD)

Canary Guest (x86-64 SteamOS inside browser)
├── /opt/webx/launch.sh          — Starts Xorg + Proton
├── /usr/local/lib/libvkwebx.so  — Our Vulkan ICD (built from guest-icd/)
└── /etc/vulkan/icd.d/vkwebx_icd.json

IPC Bridge (x86 I/O port, emulated by Canary)
└── x86 I/O port 0x7860 — guest outb() doorbell → host registerPortListener()
```

### Why Proton (not bare Wine)
Proton includes: Wine + DXVK + VKD3D-Proton + DXVK-NVAPI + vkd3d-shader +
wine-mono + wine-gecko + FAudio + Protonfixes + Steam Runtime Sniper.
This is tens of thousands of hours of compatibility work; Valve maintains it full-time.
Steam Deck Verified database gives per-game fix coverage.
Full x86-64 support means VKD3D-Proton works (requires 64-bit; was blocked on i386).

### VkWebGPU-ICD is separate
Developed at https://github.com/Dankular/VkWebGPU-ICD (Rust, wgpu 0.20, Naga SPIR-V→WGSL).
We stub it in `harness/vkwebgpu-plugin.mjs`. Replace `loadPlugin()` import when ready.

### Why Canary (not CheerpX)
CheerpX constraints that blocked WebX:
- **32-bit only** — limited to i386 ELF; VKD3D-Proton requires x86-64
- **Closed source CDN** — no ability to extend or fix runtime behaviour
- **No documented IPC** — registerPortListener was reverse-engineered from cx.js
- **2 GB image limit** — full Proton stack needed multiple split images

Canary (D:\Dev Proj\Canary):
- **x86-64** — full 64-bit ELF support; all of Proton works
- **Open source Rust** — self-hosted, no CDN, fully extensible
- **Framebuffer** — /dev/fb0 (1024×768 BGRA) → `get_framebuffer()` → canvas blit
- **pthreads** — SharedArrayBuffer + Web Workers
- **IN/OUT port emulation** — x86 opcodes 0xEC/0xED/0xEE/0xEF emulated natively
  → `registerPortListener(port, cb)` API mirrors CheerpX (in progress)

## Key Design Decision: x86 I/O Port IPC Bridge

The guest ICD communicates with the host via x86 I/O port 0x7860.
Canary emulates the IN/OUT instructions and exposes them to JS via
`registerPortListener` — the same API surface as CheerpX.

### Mechanism (pure MessagePort, no files)

```
Guest outb(byte, 0x7860)  →  hostPort.onmessage fires  →  bridge.handleWrite([byte])
bridge.onResponseReady(resp)  →  hostPort.postMessage({data: resp})  →  guest inb(0x7860)
```

1. Guest streams command bytes via repeated `outb(byte, 0x7860)` (one byte per call)
2. Host accumulates in `hostPort.onmessage`, `VkBridge` detects complete packets via magic+length
3. `VkBridge.#dispatch()` calls `plugin.dispatch()`, builds response packet
4. `bridge.onResponseReady` callback calls `hostPort.postMessage({ data: resp })`
5. Canary queues response bytes in the port's FIFO
6. Guest reads bytes via `inb(0x7860)` one at a time

### Canary `registerPortListener` status
- **IN PROGRESS** — Canary x86 IN/OUT port opcode emulation being implemented
- When ready, `rt.registerPortListener(port, cb)` API mirrors CheerpX's interface
- The callback receives a `MessagePort` — same pattern as CheerpX 1.2.5+

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

## Files

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
| `harness/canary-host.mjs` | Canary boot, image mount, IPC doorbell, framebuffer blit |
| `harness/vk-bridge.mjs` | Packet accumulator → plugin dispatcher → response queue |
| `harness/vkwebgpu-plugin.mjs` | VkWebGPU-ICD stub (placeholder WebGPU frame render) |
| `steam/launch.sh` | /opt/webx/launch.sh inside SteamOS: Xorg (fbdev) + Proton |
| `steam/extract-image.py` | Windows-native: decompress .bz2 + extract GPT rootfs partition |
| `steam/extract-rootfs.sh` | Linux/WSL: loop mount, install ICD, ext4→ext2 |
| `steam/prepare-image.sh` | Original Docker approach (superseded) |

## SteamOS Image Status

Source: `C:\Users\Dan\Downloads\steamdeck-repair-20250521.10-3.7.7.img.bz2`

```
steam/steamdeck-repair.img   ~7,385 MB  ← decompressed full GPT disk image  ✓ DONE
steam/steamos-rootfs.img     ~5,120 MB  ← rootfs partition extracted         ✓ DONE
```

**Remaining:** Run `steam/extract-rootfs.sh` in WSL to:
1. Resize image by +256 MB (room for ICD)
2. Mount it and install `libvkwebx.so` + `vkwebx_icd.json` + `launch.sh`
3. Remove competing ICDs (intel/radeon/nvidia/lvp/dzn)
4. Run `ldconfig`
5. Convert ext4 → ext2 via `tune2fs`

## Environment (Windows Server 2022, EFRET-DEVSERV, user: sysadmin)

- SteamOS image: `C:\Users\sysadmin\Downloads\steamdeck-repair-20250521.10-3.7.7.img.bz2`
- Repos at: `Z:\Repos\WebSteamOS\{WebX,Canary,VkWebGPU-ICD}` (siblings, one level up from WebX)
- Node.js v25, Rust stable 1.93.1, Python 3.14, wasm-pack installed
- WSL Ubuntu installed: `wsl -d Ubuntu`; Z: mounted via `/etc/wsl.conf` boot command
- **Canary path**: `../Canary` relative to WebX (one level up, not two)

## Current Status (2026-02-22)

| Step | Status |
|------|--------|
| Canary I/O port emulation (`canary-io`) | ✅ Complete |
| Canary WASM build | ✅ `Canary/crates/canary-wasm/pkg/` |
| libvkwebx.so cross-compile | ✅ `WebX/build/guest-icd/libvkwebx.so` |
| SteamOS image decompressed | ✅ `steam/steamdeck-repair.img` (7.3 GB) |
| extract-rootfs.sh (ICD install + ext4→ext2) | 🔄 Running in WSL Ubuntu |
| `steam/steamos-webx.ext2` | ⏳ Pending extract-rootfs.sh |
| `npm run dev` | ⏳ Pending steamos-webx.ext2 |

## Current Blockers

### extract-rootfs.sh running
Wait for completion, then: `npm run dev` → `http://localhost:3000`

### SteamOS repair image partition layout
```
p1: 64 MB  EFI System
p2: 128 MB Microsoft basic data (recovery)
p3: 5 GB   Linux root x86-64  ← rootfs (extract-rootfs.sh uses p3)
p4: 256 MB Linux variable data
p5: 1.6 GB Linux home
```

## WSL Build Commands (Ubuntu, Z: auto-mounted)

```bash
# Cross-compile libvkwebx.so
sudo apt-get install -y cmake gcc-x86-64-linux-gnu libvulkan-dev libxcb1-dev
WEBX=/mnt/z/Repos/WebSteamOS/WebX
cmake -B $WEBX/build/guest-icd $WEBX/guest-icd/ \
  -DCMAKE_TOOLCHAIN_FILE=$WEBX/cmake/x86_64-linux-gnu.cmake \
  -DCMAKE_BUILD_TYPE=Release
cmake --build $WEBX/build/guest-icd --parallel 4

# Install ICD into SteamOS image (ext4→ext2)
cd /mnt/z/Repos/WebSteamOS/WebX
bash steam/extract-rootfs.sh steam/steamdeck-repair.img steam/
```

## npm Scripts

```bash
npm run dev              # Start browser dev server (port 3000)
npm run build:canary     # Build Canary WASM (cd ../Canary && npm run build:wasm)
npm run extract:image    # Decompress .bz2 + extract rootfs (Windows, Python)
npm run extract:rootfs   # Install ICD into image, ext4→ext2 (Linux/WSL)
npm run build:icd        # Cross-compile libvkwebx.so (WSL required)
npm run build:icd:docker # Same via Docker (needs libxcb1-dev)
```

## Immediate Next Steps

1. **Wait for `extract-rootfs.sh`**: produces `steam/steamos-webx.ext2`
2. **Run dev server**: `npm run dev`, open `http://localhost:3000`
3. **Wire in real VkWebGPU-ICD** when ready: edit `harness/vkwebgpu-plugin.mjs` `loadPlugin()`

## Canary API Reference (confirmed from canary_wasm.d.ts + harness/canary-host.mjs)

```js
// Dynamic import — served at /canary/canary_wasm.js by server.mjs
const wasmMod = await import('/canary/canary_wasm.js');
await wasmMod.default();          // run __wbg_init()
const { CanaryRuntime } = wasmMod;
const rt = new CanaryRuntime();

// Load ext2 filesystem image
rt.load_fs_image(imageUint8Array);

// Check VFS
rt.path_exists('/bin/bash');      // → boolean
rt.read_file('/bin/bash');        // → Uint8Array | undefined
rt.list_dir('/');                 // → JSON string: [{name, kind}]

// Execute x86-64 ELF
rt.run_elf(elfBytes, JSON.stringify(argv), JSON.stringify(envp));
// → exits synchronously (use for short processes)

// Step-based execution (interleave with JS)
rt.step();                        // → boolean (false = process exited)

// Framebuffer (/dev/fb0, 1024×768 BGRA)
rt.has_framebuffer();             // → boolean
rt.get_framebuffer();             // → Uint8Array (BGRA)
rt.get_fb_dimensions();           // → "1024,768"

// Console I/O
rt.drain_stdout();                // → Uint8Array
rt.drain_stderr();                // → Uint8Array
rt.write_stdin(bytes);            // feed stdin

// Networking (TCP → WebSocket bridge)
rt.drain_connect_requests();      // → JSON: [{fd, ip, port}]
rt.drain_socket_sends();          // → JSON: [{fd, data (base64)}]
rt.socket_connected(fd_bigint);
rt.socket_recv_data(fd_bigint, bytes);

// Threading (pthreads → Web Workers)
rt.drain_clone_requests();        // → JSON: [{tid, child_stack, tls, ...}]
rt.set_current_tid(tid);
rt.current_tid();                 // → number

// x86 I/O port listener — IN PROGRESS
// rt.registerPortListener(port, (hostPort: MessagePort) => void)

// Debugging
rt.rip();                         // → BigInt (current RIP)
rt.dump_regs_json();              // → JSON string of all GPRs

rt.free();                        // deallocate
```

## Key Environment Variables (passed to Canary guest)

```
VK_DRIVER_FILES=/etc/vulkan/icd.d/vkwebx_icd.json
WEBX_PORT=0x7860
DXVK_HUD=fps,devinfo,memory
VKD3D_DEBUG=fixme
PROTON_USE_WINED3D=0
PROTON_NO_ESYNC=1
WINEARCH=win64
DISPLAY=:0
```
