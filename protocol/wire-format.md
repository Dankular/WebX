# WebX Vulkan Wire Protocol

Binary protocol over the `/dev/webgpu` CheerpX custom character device.

## Transport

The guest ICD opens `/dev/webgpu` and communicates via `write()`/`read()` syscalls.
CheerpX intercepts these at the device level and routes them to the host JS bridge
without going through the network stack — zero network latency.

## Framing

Every guest→host message:

```
┌──────────────────────────────────────────┐
│ magic    : u32  = 0x58574756 ("VGWX")   │
│ cmd      : u32  = VkWebXCmd             │
│ seq      : u32  = sequence number       │
│ len      : u32  = payload byte count    │
├──────────────────────────────────────────┤
│ payload  : u8[len]                       │
└──────────────────────────────────────────┘
```

Every host→guest response (for commands that block waiting):

```
┌──────────────────────────────────────────┐
│ seq      : u32  = echoed sequence number │
│ result   : i32  = VkResult              │
│ len      : u32  = response payload len  │
├──────────────────────────────────────────┤
│ payload  : u8[len]                       │
└──────────────────────────────────────────┘
```

All values little-endian.

## Command Classes

### Fire-and-forget (no response read)
Recording commands that go into a command buffer do not need synchronous responses.
The guest writes the packet and immediately continues. These are buffered on the host
until `WEBX_CMD_QUEUE_SUBMIT`.

```
WEBX_CMD_CMD_DRAW
WEBX_CMD_CMD_DRAW_INDEXED
WEBX_CMD_CMD_BIND_PIPELINE
WEBX_CMD_CMD_SET_VIEWPORT
... (all CMD_CMD_* recording commands)
```

### Synchronous (guest blocks on read)
Anything that returns a VkResult or creates a handle. Guest calls write() then
immediately calls read() which blocks until the host sends a WebXResponseHeader.

```
WEBX_CMD_CREATE_INSTANCE       → returns VkResult
WEBX_CMD_CREATE_DEVICE         → returns VkResult
WEBX_CMD_ALLOCATE_MEMORY       → returns VkResult + WebXHandle (allocation)
WEBX_CMD_QUEUE_SUBMIT          → returns VkResult (after GPU work submitted)
WEBX_CMD_WAIT_FOR_FENCES       → returns VkResult (blocks until GPU done)
WEBX_CMD_ACQUIRE_NEXT_IMAGE    → returns VkResult + uint32_t (image index)
... etc
```

CheerpX's x86 emulation allows the guest thread to block on read() without
stalling the browser's event loop — identical to how blocking file I/O works.

## Handle Encoding

Vulkan handles (VkDevice, VkImage, etc.) are opaque 64-bit values. The guest
generates handles locally using a monotonic counter. The host maintains a
`Map<u64, HostObject>` table keyed by guest handle values.

This avoids round-trips for handle creation — the guest can continue recording
without waiting for the host to acknowledge each allocation.

Exception: the host must confirm handle creation for objects that require WebGPU
resources (images, buffers, pipelines). These use synchronous commands.

## Bulk Data Transfer

For memory map/unmap (large buffer uploads), the protocol uses a dedicated
`WEBX_CMD_WRITE_MAPPED_DATA` command with the allocation handle and raw bytes.
The host receives this and calls `GPUQueue.writeBuffer()` / `GPUQueue.writeTexture()`.

Reads (GPU→CPU readback) use a separate `WEBX_CMD_READ_MAPPED_DATA` response
payload. Readback is rare in games and the latency is acceptable.

## Swapchain / Presentation

`WEBX_CMD_QUEUE_PRESENT` signals the host to call `GPUCanvasContext.getCurrentTexture()`
and blit the current swapchain image to the canvas. The host resolves on the next
animation frame via `requestAnimationFrame`.

## VkWebGPU-ICD Plugin Interface

The host bridge calls into the active plugin for each deserialized command:

```
bridge.dispatch(cmd: VkWebXCmd, seq: u32, payload: Uint8Array)
  → Promise<{ result: VkResult, data: Uint8Array }>
```

The plugin stub (harness/vkwebgpu-plugin.mjs) logs all commands.
The real VkWebGPU-ICD implements this interface against browser WebGPU.
