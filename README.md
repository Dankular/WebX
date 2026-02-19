# WebX

Run unmodified Windows Steam games in a browser tab — no plugin, no install.

WebX orchestrates a stack of open-source compatibility layers and GPU translation
technology so that a DirectX game launched via Proton ends up rendering through the
browser's WebGPU API.

## Architecture

```
┌──────────────────────────── Browser tab ─────────────────────────────────┐
│                                                                            │
│  ┌─────────────── CheerpX / WebVM  (x86-64 Linux VM in WASM) ──────────┐ │
│  │                                                                       │ │
│  │   Steam Game  (.exe)                                                  │ │
│  │     │  Win32 / DirectX 8–12 API calls                                │ │
│  │     ▼                                                                 │ │
│  │   Proton  (Wine + DXVK + VKD3D-Proton + Protonfixes)                 │ │
│  │     │  Translates D3D → Vulkan (DXVK) or D3D12 → Vulkan (VKD3D)     │ │
│  │     ▼                                                                 │ │
│  │   libvkwebx.so  ◄── WebX guest ICD  (x86-64 Linux, runs in VM)      │ │
│  │     │  Serializes Vulkan calls to binary packets                      │ │
│  │     │  outb/inl on x86 I/O port 0x7860                               │ │
│  └─────┼─────────────────────────────────────────────────────────────────┘ │
│        │  CheerpX  registerPortListener  MessagePort channel               │
│        ▼                                                                    │
│   vk-bridge.mjs   packet framing + dispatch                                │
│        │  Deserializes binary Vulkan command stream                         │
│        ▼                                                                    │
│   vkwebgpu-plugin.mjs  ◄── VkWebGPU-ICD  (host side, browser JS / WASM)  │
│        │  Executes Vulkan commands as WebGPU draw calls                     │
│        ▼                                                                    │
│   Browser WebGPU API  →  GPU  (D3D12 / Metal / Vulkan native)             │
└────────────────────────────────────────────────────────────────────────────┘
```

## Components

| Component | Repo / Source | Runs in | Role |
|-----------|--------------|---------|------|
| **CheerpX** | [leaningtech/cheerpx](https://cheerpx.io) · [issues](https://github.com/leaningtech/cheerpx-meta) | Browser (WASM) | x86-64 Linux VM; boots real SteamOS ext2 image |
| **WebVM** | [webvm.io](https://webvm.io) | Browser | Hosted CheerpX environment; alternative public deployment target |
| **SteamOS image** | Valve Steam Deck repair image | CheerpX VM | Full Proton runtime: Wine + DXVK + VKD3D-Proton + Steam Runtime Sniper |
| **Proton** | [ValveSoftware/Proton](https://github.com/ValveSoftware/Proton) | CheerpX VM | Windows→Linux game compatibility (thousands of per-game fixes via Protonfixes) |
| **DXVK** | [doitsujin/dxvk](https://github.com/doitsujin/dxvk) | CheerpX VM | Translates D3D9/10/11 → Vulkan; ships inside Proton |
| **VKD3D-Proton** | [HansKristian-Work/vkd3d-proton](https://github.com/HansKristian-Work/vkd3d-proton) | CheerpX VM | Translates D3D12 → Vulkan; ships inside Proton |
| **libvkwebx.so** | `guest-icd/` (this repo) | CheerpX VM (x86-64) | Thin Vulkan ICD; serializes every Vulkan call to binary wire packets |
| **vk-bridge.mjs** | `harness/` (this repo) | Browser JS | Packet framer/deserializer; dispatches to active plugin |
| **VkWebGPU-ICD** | [VkWebGPU-ICD](https://github.com/Dankular/VkWebGPU-ICD) | Browser (host) | Translates Vulkan commands to WebGPU; the GPU execution engine |
| **QEMU** | [qemu.org](https://www.qemu.org) | Local machine | Local testing VM; boots the same SteamOS image without a browser |

## Repository Layout

```
harness/
  index.html            Single-page app; WebGPU + crossOriginIsolated checks
  server.mjs            Node dev server (port 3000) with COOP/COEP/CORP headers
  cheerpx-host.mjs      CheerpX boot, SteamOS image mount, IPC bridge setup
  vk-bridge.mjs         Binary packet accumulator → plugin dispatcher
  vkwebgpu-plugin.mjs   VkWebGPU-ICD integration (stub while ICD is in development)

protocol/
  commands.h            VkWebXCmd enum + WebXPacketHeader/WebXResponseHeader structs
  wire-format.md        Full wire protocol specification

guest-icd/
  src/vkwebx.c          Vulkan ICD entry points + x86 I/O port serialization
  src/vkwebx_wire.h     Packet builder helpers (WebXBuf)
  src/vkwebx_resources.c  Memory, buffers, images, views, samplers
  src/vkwebx_pipeline.c   Shaders, pipelines, render passes, descriptors, draw cmds
  src/vkwebx_surface.c    Surface (XCB), swapchain, present, device queries
  vkwebx_icd.json       Vulkan loader manifest → /usr/local/lib/libvkwebx.so
  CMakeLists.txt        Cross-compile build (target: x86-64 Linux)

cmake/
  x86_64-linux-gnu.cmake  CMake toolchain for cross-compiling on Windows/macOS

steam/
  prepare-image.sh      Docker-based: build SteamOS ext2 image with ICD pre-installed
  extract-image.py      Windows: decompress .bz2 + extract GPT rootfs partition
  extract-rootfs.sh     Linux/WSL: loop-mount, install ICD, ext4 → ext2
  launch.sh             /opt/webx/launch.sh inside VM: Xorg + Proton game launch
```

## Wire Protocol

Binary packets flow from `libvkwebx.so` (inside the VM) to `vk-bridge.mjs` (browser JS)
over a CheerpX x86 I/O port channel.

**Packet header** (16 bytes, little-endian):

| Field | Type | Value |
|-------|------|-------|
| `magic` | u32 | `0x58574756` ("VGWX") |
| `cmd` | u32 | `VkWebXCmd` enum |
| `seq` | u32 | Monotonic sequence counter |
| `len` | u32 | Payload length in bytes |

**Response header** (12 bytes):

| Field | Type | Value |
|-------|------|-------|
| `seq` | u32 | Echoed sequence number |
| `result` | i32 | `VkResult` (0 = VK_SUCCESS) |
| `len` | u32 | Response payload length |

**Command classes:**
- **Synchronous** (`vkCreate*`, `vkAllocate*`, `vkGet*`): guest blocks on `inb` read until host writes response
- **Fire-and-forget** (`vkCmd*` recording commands): guest writes and continues; host buffers until `vkQueueSubmit`
- **Bulk data** (`WEBX_CMD_WRITE_MAPPED_DATA`): CPU→GPU uploads after `vkMapMemory`

See [`protocol/wire-format.md`](protocol/wire-format.md) and [`protocol/commands.h`](protocol/commands.h) for full specification.

## Testing Environments

### 1. Browser — CheerpX (production target)

The primary target. Boots the SteamOS ext2 image inside a browser tab via CheerpX's
x86-64 WASM emulator. All GPU commands cross the I/O port bridge to the browser-side
VkWebGPU-ICD plugin.

```sh
npm run dev          # start dev server at http://localhost:3000
# open browser, click Launch
```

Requirements:
- Chrome 113+ / Edge 113+ / Firefox Nightly (WebGPU)
- COOP + COEP headers (provided by `harness/server.mjs`)
- CheerpX license key ([cheerpx.io](https://cheerpx.io))

### 2. Browser — WebVM (public deployment)

[WebVM](https://webvm.io) is Leaning Technologies' hosted CheerpX environment. The same
SteamOS ext2 image can be deployed there for a zero-setup public demo without running
your own dev server. WebVM provides the x86 VM runtime; WebX provides the Vulkan bridge
and WebGPU plugin.

Feature requests relevant to this project are tracked at
[github.com/leaningtech/cheerpx-meta](https://github.com/leaningtech/cheerpx-meta)
(e.g. documented chardev API, socket IPC, SharedArrayBuffer relaxation).

### 3. Local — QEMU VM with GPU passthrough (development & debugging)

**No WSL2 required.** Boot the SteamOS image in QEMU with VirtIO-GPU so the guest sees
the host's real GPU. VkWebGPU-ICD is built and installed natively inside the running VM —
no cross-compilation, no loop-mount dance.

#### How the GPU pipe works

```
┌──────── QEMU VM (SteamOS) ────────────────────┐     ┌── Host (Windows) ──┐
│                                                 │     │                    │
│  game.exe → DXVK → Vulkan → VkWebGPU-ICD      │     │                    │
│                               │                 │     │                    │
│                         wgpu (Vulkan)           │     │                    │
│                               │                 │     │                    │
│                    Mesa VirtIO-GPU / Venus       │     │                    │
│                               │ VirtIO-GPU-GL / │     │                    │
│                               │ Venus Vulkan    │     │                    │
└───────────────────────────────┼─────────────────┘     │                    │
                                │ QEMU virtio-gpu ──────► host GPU (D3D12)   │
                                │                         wgpu renders here  │
                                └─────────────────────────────────────────────┘
```

QEMU exposes the host GPU to the guest via **VirtIO-GPU-GL** (virglrenderer, OpenGL forwarding)
or **VirtIO-GPU-Vulkan** (Venus protocol, native Vulkan forwarding). Inside the VM, wgpu
sees a real accelerated device and renders through it. No bridging protocol, no browser.

#### Setup

```sh
# 1. Convert the SteamOS rootfs to a QEMU qcow2 image (no WSL2 needed — Python only)
python steam/extract-image.py          # decompress .bz2, extract GPT partition
qemu-img convert -f raw -O qcow2 steam/steamos-rootfs.img steam/steamos-test.qcow2

# 2. Boot with VirtIO-GPU-GL (OpenGL forwarding via virglrenderer)
qemu-system-x86_64 \
  -enable-kvm \               # or -accel whpx on Windows (Hyper-V platform)
  -m 6G -cpu host -smp 4 \
  -drive file=steam/steamos-test.qcow2,format=qcow2,if=virtio \
  -device virtio-gpu-gl,virgl=on,hostmem=512M \
  -display sdl,gl=on \
  -usb -device usb-tablet

# 3. Inside the QEMU VM: build Rust + VkWebGPU-ICD natively (one-time)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
git clone https://github.com/Dankular/VkWebGPU-ICD
cd VkWebGPU-ICD && cargo build --release
sudo cp target/release/libvkwebgpu.so /usr/local/lib/
sudo cp vkwebgpu_icd.json /etc/vulkan/icd.d/vkwebgpu_icd.json

# 4. Launch a game via Proton
export VK_DRIVER_FILES=/etc/vulkan/icd.d/vkwebgpu_icd.json
export PROTON_USE_WINED3D=0
proton run game.exe
```

> **Windows note:** replace `-enable-kvm` with `-accel whpx` (Hyper-V) or `-accel haxm`.
> VirtIO-GPU-GL requires QEMU ≥ 7.2 and a display with `-display sdl,gl=on`.

Call chain:
```
game.exe → DXVK → Vulkan → VkWebGPU-ICD (wgpu) → VirtIO-GPU-GL/Venus → host GPU
```

WSL2 is **not required** for this path. The guest builds everything natively and uses
the host GPU via the VirtIO transport.

## Build

### Path A — QEMU local testing (no WSL2 needed)

1. **Extract image** (Python, Windows-native):
   ```sh
   npm run extract:image
   # decompresses steamdeck-repair.img.bz2, extracts rootfs partition
   # output: steam/steamos-rootfs.img
   ```
2. **Convert to qcow2**:
   ```sh
   qemu-img convert -f raw -O qcow2 steam/steamos-rootfs.img steam/steamos-test.qcow2
   ```
3. **Boot VM** (see QEMU section above) and build VkWebGPU-ICD natively inside it.

### Path B — CheerpX / WebVM (WSL2 or Docker required)

The CheerpX path needs an ext2 image with `libvkwebx.so` pre-installed. This requires a
Linux environment (WSL2 or Docker) to loop-mount and modify the image.

```sh
# Guest ICD cross-compile
npm run build:icd           # WSL2: cmake + gcc-x86-64-linux-gnu
npm run build:icd:docker    # Docker (no WSL2)
# Output: build/guest-icd/libvkwebx.so

# SteamOS ext2 image preparation
npm run extract:rootfs      # WSL2: loop-mount, install ICD, ext4 → ext2
bash steam/prepare-image.sh # Docker alternative
# Output: steam/steamos-webx.ext2
```

## Dev Setup

```sh
npm install              # no runtime deps; installs dev tools only
npm run dev              # start browser dev server at http://localhost:3000
```

Open `http://localhost:3000` and click **Launch**. The SteamOS image is fetched on demand
via `HttpBytesDevice`; writes are persisted in IndexedDB via `IDBDevice`.

## Current Status

| Item | Status |
|------|--------|
| Wire protocol (`protocol/`) | ✅ Specified |
| Guest ICD (`guest-icd/`) | ✅ Core commands implemented |
| Browser harness (`harness/`) | ✅ CheerpX boot + IPC bridge |
| VkWebGPU-ICD plugin stub | ✅ Full WebGPU translation layer |
| SteamOS image preparation | ✅ Docker + WSL scripts |
| VkWebGPU-ICD real integration | 🔄 In progress (VkWebGPU-ICD triangle test passing) |
| QEMU test setup | 🔄 Pending `libvkwebgpu.so` Linux build |
| WSL2 environment | ⚠️ Needs enabling (Windows Features → WSL + VMP → reboot) |
| SteamOS ext2 image final prep | ⚠️ Pending `steam/extract-rootfs.sh` run in WSL |
| End-to-end game render | 🔄 In progress |

## Related Projects

| Project | Purpose |
|---------|---------|
| [VkWebGPU-ICD](https://github.com/Dankular/VkWebGPU-ICD) | Rust Vulkan→WebGPU ICD; the GPU execution backend for this project |
| [CheerpX](https://cheerpx.io) | x86-64 Linux VM in WASM; runs the SteamOS image |
| [cheerpx-meta](https://github.com/leaningtech/cheerpx-meta) | CheerpX issue tracker; feature requests for IPC/chardev improvements |
| [WebVM](https://webvm.io) | Hosted CheerpX environment; public deployment target |
| [Proton](https://github.com/ValveSoftware/Proton) | Valve's Wine+DXVK+VKD3D runtime; enables Windows games on Linux |
| [DXVK](https://github.com/doitsujin/dxvk) | D3D9/10/11 → Vulkan translation layer (ships in Proton) |
| [VKD3D-Proton](https://github.com/HansKristian-Work/vkd3d-proton) | D3D12 → Vulkan translation layer (ships in Proton) |

## Requirements

| | QEMU path | CheerpX / WebVM path |
|-|-----------|---------------------|
| **GPU** | Host GPU via VirtIO-GPU-GL/Venus | Browser WebGPU (Chrome 113+ / Edge 113+ / Firefox Nightly) |
| **COOP/COEP headers** | Not needed | Required (provided by `harness/server.mjs`) |
| **CheerpX license** | Not needed | Required ([cheerpx.io](https://cheerpx.io)) |
| **WSL2 / Docker** | Not needed | Required (image prep + ICD cross-compile) |
| **QEMU ≥ 7.2** | Required | Not needed |
| **Node.js ≥ 20** | Not needed | Dev server only |

## License

MIT
