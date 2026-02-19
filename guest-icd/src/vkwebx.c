/*
 * WebX Guest Vulkan ICD
 *
 * Installed inside the SteamOS/CheerpX guest as a Vulkan ICD.
 * DXVK and VKD3D-Proton call into this ICD, which serializes every
 * Vulkan call and sends it to the host JS bridge.
 *
 * The host bridge deserializes the stream and dispatches to VkWebGPU-ICD.
 *
 * Build: x86-64 Linux shared library, position-independent.
 *   gcc -shared -fPIC -O2 -o libvkwebx.so vkwebx.c -lpthread
 */

#define VK_NO_PROTOTYPES
#include <vulkan/vulkan.h>
#include <vulkan/vk_icd.h>

#include "vkwebx_wire.h"

#include <unistd.h>
#include <pthread.h>
#include <string.h>
#include <stdlib.h>
#include <stdio.h>
#include <stdatomic.h>
#include <time.h>
#ifdef __x86_64__
#include <sys/io.h>
#endif

/* ── IPC: x86 I/O port MessagePort channel (CheerpX 1.2.5+) ─────────── */
/*
 * CheerpX.registerPortListener(port, (hostPort: MessagePort) => void)
 *
 * The first IN or OUT instruction to the registered port triggers the callback
 * on the host, establishing a bidirectional MessageChannel:
 *
 *   Guest → Host: outb(byte, WEBX_PORT)  →  hostPort.onmessage fires with byte
 *   Host → Guest: hostPort.postMessage({data: bytes})  →  inb(WEBX_PORT) reads
 *
 * For an empty port FIFO, inl() returns 0xFFFFFFFF.
 * We poll inl() until we see the expected response seq number (never 0xFFFFFFFF).
 *
 * Thread safety: g_ipc_lock serialises all IPC calls so that seq numbers match
 * responses correctly (no interleaving of concurrent Vulkan calls over the port).
 */

#define WEBX_PORT  0x7860u

static int                   g_port_ready = 0;
static pthread_mutex_t       g_ipc_lock   = PTHREAD_MUTEX_INITIALIZER;
static atomic_uint_fast32_t  g_seq        = 1;

static void port_init(void) {
    if (g_port_ready) return;
    g_port_ready = 1;
#ifdef __x86_64__
    /* Request OS permission for 4 consecutive I/O ports starting at WEBX_PORT.
     * Inside CheerpX this may be a no-op (emulated), but call it for correctness.
     * Fall back to iopl(3) if ioperm fails (requires CAP_SYS_RAWIO). */
    if (ioperm(WEBX_PORT, 4, 1) != 0)
        iopl(3);
#endif
}

static int dev_open(void) {
    port_init();
    return 0;
}

/* Stream packet bytes to the host one byte at a time via outb().
 * Each outb() generates a hostPort.onmessage event on the host. */
static void ipc_write_packet(const uint8_t *pkt, size_t total) {
#ifdef __x86_64__
    for (size_t i = 0; i < total; i++)
        outb(pkt[i], WEBX_PORT);
#else
    (void)pkt; (void)total;
#endif
}

/* Poll inl() until the host posts a response, then read it byte-by-byte.
 *
 * Protocol:
 *   Host does: hostPort.postMessage({ data: responseBytes })
 *   CheerpX queues those bytes in the port's receive FIFO.
 *   inl() returns 0xFFFFFFFF when the FIFO is empty.
 *   The first 4 bytes of a response are the seq number (u32 LE, never 0xFFFFFFFF).
 *   Once inl() != 0xFFFFFFFF, we have the seq; then read result + len + payload.
 */
static int ipc_read_response(uint32_t expected_seq, WebXResponse *out, int timeout_ms) {
    struct timespec ts_start, ts_now;
    clock_gettime(CLOCK_MONOTONIC, &ts_start);

#ifdef __x86_64__
    /* Wait for the first 4 bytes (seq number) */
    uint32_t first;
    while (1) {
        first = inl(WEBX_PORT);
        if (first != 0xFFFFFFFFu) break;

        clock_gettime(CLOCK_MONOTONIC, &ts_now);
        long ms = (ts_now.tv_sec  - ts_start.tv_sec)  * 1000
                + (ts_now.tv_nsec - ts_start.tv_nsec) / 1000000;
        if (ms > timeout_ms) {
            fprintf(stderr, "[webx-icd] Timeout waiting for response seq=%u\n",
                    expected_seq);
            return -1;
        }
        /* Yield CPU; host JS needs the event loop to process the command */
        struct timespec sl = { 0, 500 * 1000 }; /* 0.5 ms */
        nanosleep(&sl, NULL);
    }

    if (first != expected_seq) {
        fprintf(stderr, "[webx-icd] Seq mismatch: expected %u got %u\n",
                expected_seq, first);
        return -1;
    }

    /* Read result (i32) and payload length (u32) — 8 more bytes */
    uint8_t tail[8];
    for (int i = 0; i < 8; i++)
        tail[i] = inb(WEBX_PORT);

    out->result = (int32_t)( (uint32_t)tail[0]
                           | ((uint32_t)tail[1] << 8)
                           | ((uint32_t)tail[2] << 16)
                           | ((uint32_t)tail[3] << 24));
    out->len    = (uint32_t)tail[4]
                | ((uint32_t)tail[5] << 8)
                | ((uint32_t)tail[6] << 16)
                | ((uint32_t)tail[7] << 24);
    out->data   = NULL;

    if (out->len > 0) {
        out->data = malloc(out->len);
        if (!out->data) return -1;
        for (uint32_t i = 0; i < out->len; i++)
            out->data[i] = inb(WEBX_PORT);
    }
    return 0;

#else  /* non-x86 — stub for host-side unit tests */
    (void)expected_seq; (void)out; (void)timeout_ms;
    return -1;
#endif

}

/* ── Send a command and optionally read a synchronous response ────────── */

/* Allocate a seq number, skipping 0xFFFFFFFF (reserved as "port empty" sentinel). */
static uint32_t next_seq(void) {
    uint32_t s;
    do { s = (uint32_t)atomic_fetch_add(&g_seq, 1); } while (s == 0xFFFFFFFFu);
    return s;
}

void webx_send(VkWebXCmd cmd, const void *payload, uint32_t payload_len) {
    uint32_t seq = next_seq();
    size_t total;
    uint8_t *pkt = webx_packet_build(cmd, seq, payload, payload_len, &total);
    pthread_mutex_lock(&g_ipc_lock);
    ipc_write_packet(pkt, total);
    pthread_mutex_unlock(&g_ipc_lock);
    webx_packet_free(pkt);
    /* Fire-and-forget: no response wait */
}

VkResult webx_call(VkWebXCmd cmd, const void *payload, uint32_t payload_len,
                   uint8_t **out_data, uint32_t *out_len) {
    uint32_t seq = next_seq();
    size_t total;
    uint8_t *pkt = webx_packet_build(cmd, seq, payload, payload_len, &total);

    pthread_mutex_lock(&g_ipc_lock);
    ipc_write_packet(pkt, total);
    webx_packet_free(pkt);

    WebXResponse resp;
    int rc = ipc_read_response(seq, &resp, 10000 /* 10s timeout */);
    pthread_mutex_unlock(&g_ipc_lock);

    if (rc != 0) {
        fprintf(stderr, "[webx-icd] Timeout waiting for response to cmd 0x%04x seq %u\n",
                cmd, seq);
        return VK_ERROR_DEVICE_LOST;
    }

    if (out_data) *out_data = resp.data;
    else          free(resp.data);
    if (out_len)  *out_len  = resp.len;

    return (VkResult)resp.result;
}

/* ── ICD loader interface ─────────────────────────────────────────────── */

VKAPI_ATTR VkResult VKAPI_CALL
vk_icdNegotiateLoaderICDInterfaceVersion(uint32_t *p_version) {
    if (*p_version > 6) *p_version = 6;
    return VK_SUCCESS;
}

/* Forward declarations */
static PFN_vkVoidFunction webx_get_instance_proc(VkInstance, const char *);
static PFN_vkVoidFunction webx_get_device_proc(VkDevice, const char *);

VKAPI_ATTR PFN_vkVoidFunction VKAPI_CALL
vk_icdGetInstanceProcAddr(VkInstance inst, const char *name) {
    return webx_get_instance_proc(inst, name);
}

VKAPI_ATTR PFN_vkVoidFunction VKAPI_CALL
vk_icdGetPhysicalDeviceProcAddr(VkInstance inst, const char *name) {
    return webx_get_instance_proc(inst, name);
}

/* ── VkInstance ──────────────────────────────────────────────────────── */

static VKAPI_ATTR VkResult VKAPI_CALL
webx_CreateInstance(const VkInstanceCreateInfo *ci,
                    const VkAllocationCallbacks *alloc,
                    VkInstance *out) {
    if (dev_open() != 0) return VK_ERROR_INITIALIZATION_FAILED;

    /* Send app info: api version + app name (informational for the host) */
    WebXBuf buf; webx_buf_init(&buf);
    uint32_t api_ver = ci->pApplicationInfo
                       ? ci->pApplicationInfo->apiVersion
                       : VK_API_VERSION_1_0;
    webx_buf_push_u32(&buf, api_ver);

    uint64_t handle = webx_new_handle();
    webx_buf_push_u64(&buf, handle);

    VkResult r = webx_call(WEBX_CMD_CREATE_INSTANCE, buf.data, (uint32_t)buf.len, NULL, NULL);
    webx_buf_free(&buf);

    if (r == VK_SUCCESS) *out = (VkInstance)(uintptr_t)handle;
    return r;
}

static VKAPI_ATTR void VKAPI_CALL
webx_DestroyInstance(VkInstance inst, const VkAllocationCallbacks *alloc) {
    uint64_t h = (uint64_t)(uintptr_t)inst;
    webx_send(WEBX_CMD_DESTROY_INSTANCE, &h, 8);
}

static VKAPI_ATTR VkResult VKAPI_CALL
webx_EnumeratePhysicalDevices(VkInstance inst, uint32_t *count, VkPhysicalDevice *devs) {
    /* We advertise exactly one physical device (the browser GPU). */
    if (!devs) {
        *count = 1;
        return VK_SUCCESS;
    }
    if (*count < 1) return VK_INCOMPLETE;
    /* Physical device handle is instance handle | 0x8000_0000_0000_0000 */
    devs[0] = (VkPhysicalDevice)((uint64_t)(uintptr_t)inst | 0x8000000000000000ULL);
    *count = 1;
    return VK_SUCCESS;
}

static VKAPI_ATTR void VKAPI_CALL
webx_GetPhysicalDeviceProperties(VkPhysicalDevice pd, VkPhysicalDeviceProperties *props) {
    uint64_t h = (uint64_t)(uintptr_t)pd;
    uint8_t *data; uint32_t len;
    if (webx_call(WEBX_CMD_GET_PHYSICAL_DEVICE_PROPERTIES, &h, 8, &data, &len) == VK_SUCCESS
        && len >= sizeof(*props)) {
        memcpy(props, data, sizeof(*props));
    }
    free(data);
}

static VKAPI_ATTR void VKAPI_CALL
webx_GetPhysicalDeviceFeatures(VkPhysicalDevice pd, VkPhysicalDeviceFeatures *feats) {
    uint64_t h = (uint64_t)(uintptr_t)pd;
    uint8_t *data; uint32_t len;
    if (webx_call(WEBX_CMD_GET_PHYSICAL_DEVICE_FEATURES, &h, 8, &data, &len) == VK_SUCCESS
        && len >= sizeof(*feats)) {
        memcpy(feats, data, sizeof(*feats));
    }
    free(data);
}

static VKAPI_ATTR void VKAPI_CALL
webx_GetPhysicalDeviceQueueFamilyProperties(VkPhysicalDevice pd,
                                             uint32_t *count,
                                             VkQueueFamilyProperties *props) {
    if (!props) { *count = 1; return; }
    if (*count < 1) return;
    /* Single unified family: graphics + compute + transfer */
    props[0].queueFlags                  = VK_QUEUE_GRAPHICS_BIT
                                         | VK_QUEUE_COMPUTE_BIT
                                         | VK_QUEUE_TRANSFER_BIT;
    props[0].queueCount                  = 1;
    props[0].timestampValidBits          = 0;
    props[0].minImageTransferGranularity = (VkExtent3D){1,1,1};
    *count = 1;
}

static VKAPI_ATTR void VKAPI_CALL
webx_GetPhysicalDeviceMemoryProperties(VkPhysicalDevice pd,
                                        VkPhysicalDeviceMemoryProperties *props) {
    memset(props, 0, sizeof(*props));
    /* Match VkWebGPU-ICD memory model: device-local, host-visible, host-cached */
    props->memoryTypeCount = 3;
    props->memoryTypes[0].propertyFlags = VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT;
    props->memoryTypes[0].heapIndex     = 0;
    props->memoryTypes[1].propertyFlags = VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT
                                        | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT;
    props->memoryTypes[1].heapIndex     = 1;
    props->memoryTypes[2].propertyFlags = VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT
                                        | VK_MEMORY_PROPERTY_HOST_CACHED_BIT;
    props->memoryTypes[2].heapIndex     = 1;
    props->memoryHeapCount = 2;
    props->memoryHeaps[0].size  = 256ULL * 1024 * 1024;  /* 256 MB device */
    props->memoryHeaps[0].flags = VK_MEMORY_HEAP_DEVICE_LOCAL_BIT;
    props->memoryHeaps[1].size  = 1ULL * 1024 * 1024 * 1024;  /* 1 GB host */
    props->memoryHeaps[1].flags = 0;
}

/* ── VkDevice ─────────────────────────────────────────────────────────── */

static VKAPI_ATTR VkResult VKAPI_CALL
webx_CreateDevice(VkPhysicalDevice pd, const VkDeviceCreateInfo *ci,
                  const VkAllocationCallbacks *alloc, VkDevice *out) {
    WebXBuf buf; webx_buf_init(&buf);
    uint64_t pd_h = (uint64_t)(uintptr_t)pd;
    uint64_t dev_h = webx_new_handle();
    webx_buf_push_u64(&buf, pd_h);
    webx_buf_push_u64(&buf, dev_h);

    VkResult r = webx_call(WEBX_CMD_CREATE_DEVICE, buf.data, (uint32_t)buf.len, NULL, NULL);
    webx_buf_free(&buf);

    if (r == VK_SUCCESS) *out = (VkDevice)(uintptr_t)dev_h;
    return r;
}

static VKAPI_ATTR void VKAPI_CALL
webx_DestroyDevice(VkDevice dev, const VkAllocationCallbacks *alloc) {
    uint64_t h = (uint64_t)(uintptr_t)dev;
    webx_send(WEBX_CMD_DESTROY_DEVICE, &h, 8);
}

static VKAPI_ATTR void VKAPI_CALL
webx_GetDeviceQueue(VkDevice dev, uint32_t family, uint32_t idx, VkQueue *out) {
    /* Reuse device handle for the single queue — host maps accordingly */
    *out = (VkQueue)(uintptr_t)dev;
}

static VKAPI_ATTR VkResult VKAPI_CALL
webx_DeviceWaitIdle(VkDevice dev) {
    uint64_t h = (uint64_t)(uintptr_t)dev;
    return webx_call(WEBX_CMD_DEVICE_WAIT_IDLE, &h, 8, NULL, NULL);
}

/* ── Extension enumeration ────────────────────────────────────────────── */

static const char *k_instance_exts[] = {
    VK_KHR_SURFACE_EXTENSION_NAME,
    "VK_KHR_xcb_surface",                    /* for Wine's X11 wsi */
    VK_KHR_GET_PHYSICAL_DEVICE_PROPERTIES_2_EXTENSION_NAME,
    VK_KHR_PORTABILITY_ENUMERATION_EXTENSION_NAME,
    VK_EXT_DEBUG_UTILS_EXTENSION_NAME,
};
#define K_NUM_INST_EXTS (sizeof(k_instance_exts)/sizeof(k_instance_exts[0]))

static const char *k_device_exts[] = {
    VK_KHR_SWAPCHAIN_EXTENSION_NAME,
    VK_KHR_MAINTENANCE1_EXTENSION_NAME,
    VK_KHR_MAINTENANCE2_EXTENSION_NAME,
    VK_KHR_MAINTENANCE3_EXTENSION_NAME,
    VK_KHR_DYNAMIC_RENDERING_EXTENSION_NAME,
    VK_KHR_SYNCHRONIZATION_2_EXTENSION_NAME,
    VK_KHR_TIMELINE_SEMAPHORE_EXTENSION_NAME,
    VK_EXT_DESCRIPTOR_INDEXING_EXTENSION_NAME,
    VK_EXT_SCALAR_BLOCK_LAYOUT_EXTENSION_NAME,
    VK_KHR_SHADER_DRAW_PARAMETERS_EXTENSION_NAME,
    VK_EXT_EXTENDED_DYNAMIC_STATE_EXTENSION_NAME,
    VK_EXT_DEPTH_CLIP_ENABLE_EXTENSION_NAME,
    "VK_KHR_driver_properties",
};
#define K_NUM_DEV_EXTS (sizeof(k_device_exts)/sizeof(k_device_exts[0]))

static VKAPI_ATTR VkResult VKAPI_CALL
webx_EnumerateInstanceExtensionProperties(const char *layer,
                                           uint32_t *count,
                                           VkExtensionProperties *props) {
    if (!props) { *count = K_NUM_INST_EXTS; return VK_SUCCESS; }
    uint32_t n = *count < K_NUM_INST_EXTS ? *count : K_NUM_INST_EXTS;
    for (uint32_t i = 0; i < n; i++) {
        memset(&props[i], 0, sizeof(props[i]));
        strncpy(props[i].extensionName, k_instance_exts[i], VK_MAX_EXTENSION_NAME_SIZE-1);
        props[i].specVersion = 1;
    }
    *count = n;
    return n < K_NUM_INST_EXTS ? VK_INCOMPLETE : VK_SUCCESS;
}

static VKAPI_ATTR VkResult VKAPI_CALL
webx_EnumerateDeviceExtensionProperties(VkPhysicalDevice pd, const char *layer,
                                         uint32_t *count, VkExtensionProperties *props) {
    if (!props) { *count = K_NUM_DEV_EXTS; return VK_SUCCESS; }
    uint32_t n = *count < K_NUM_DEV_EXTS ? *count : K_NUM_DEV_EXTS;
    for (uint32_t i = 0; i < n; i++) {
        memset(&props[i], 0, sizeof(props[i]));
        strncpy(props[i].extensionName, k_device_exts[i], VK_MAX_EXTENSION_NAME_SIZE-1);
        props[i].specVersion = 1;
    }
    *count = n;
    return n < K_NUM_DEV_EXTS ? VK_INCOMPLETE : VK_SUCCESS;
}

static VKAPI_ATTR VkResult VKAPI_CALL
webx_EnumerateInstanceLayerProperties(uint32_t *count, VkLayerProperties *props) {
    *count = 0;
    return VK_SUCCESS;
}

/* ── Command buffers ──────────────────────────────────────────────────── */

static VKAPI_ATTR VkResult VKAPI_CALL
webx_CreateCommandPool(VkDevice dev, const VkCommandPoolCreateInfo *ci,
                       const VkAllocationCallbacks *alloc, VkCommandPool *out) {
    WebXBuf buf; webx_buf_init(&buf);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)dev);
    uint64_t h = webx_new_handle();
    webx_buf_push_u64(&buf, h);
    webx_buf_push_u32(&buf, ci->flags);
    webx_buf_push_u32(&buf, ci->queueFamilyIndex);
    VkResult r = webx_call(WEBX_CMD_CREATE_COMMAND_POOL, buf.data, (uint32_t)buf.len, NULL, NULL);
    webx_buf_free(&buf);
    if (r == VK_SUCCESS) *out = (VkCommandPool)(uintptr_t)h;
    return r;
}

static VKAPI_ATTR void VKAPI_CALL
webx_DestroyCommandPool(VkDevice dev, VkCommandPool pool,
                         const VkAllocationCallbacks *alloc) {
    uint64_t h = (uint64_t)(uintptr_t)pool;
    webx_send(WEBX_CMD_DESTROY_COMMAND_POOL, &h, 8);
}

static VKAPI_ATTR VkResult VKAPI_CALL
webx_AllocateCommandBuffers(VkDevice dev, const VkCommandBufferAllocateInfo *ai,
                             VkCommandBuffer *cbs) {
    WebXBuf buf; webx_buf_init(&buf);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)dev);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)ai->commandPool);
    webx_buf_push_u32(&buf, ai->level);
    webx_buf_push_u32(&buf, ai->commandBufferCount);
    /* Generate handles locally — host sees them via BEGIN_COMMAND_BUFFER */
    for (uint32_t i = 0; i < ai->commandBufferCount; i++) {
        uint64_t h = webx_new_handle();
        webx_buf_push_u64(&buf, h);
        cbs[i] = (VkCommandBuffer)(uintptr_t)h;
    }
    VkResult r = webx_call(WEBX_CMD_ALLOCATE_COMMAND_BUFFERS,
                            buf.data, (uint32_t)buf.len, NULL, NULL);
    webx_buf_free(&buf);
    return r;
}

static VKAPI_ATTR VkResult VKAPI_CALL
webx_BeginCommandBuffer(VkCommandBuffer cb, const VkCommandBufferBeginInfo *bi) {
    WebXBuf buf; webx_buf_init(&buf);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)cb);
    webx_buf_push_u32(&buf, bi->flags);
    /* Fire-and-forget: host creates deferred recording state */
    webx_send(WEBX_CMD_BEGIN_COMMAND_BUFFER, buf.data, (uint32_t)buf.len);
    webx_buf_free(&buf);
    return VK_SUCCESS;
}

static VKAPI_ATTR VkResult VKAPI_CALL
webx_EndCommandBuffer(VkCommandBuffer cb) {
    uint64_t h = (uint64_t)(uintptr_t)cb;
    webx_send(WEBX_CMD_END_COMMAND_BUFFER, &h, 8);
    return VK_SUCCESS;
}

/* ── Draw / recording commands (fire-and-forget) ─────────────────────── */

static VKAPI_ATTR void VKAPI_CALL
webx_CmdDraw(VkCommandBuffer cb, uint32_t vc, uint32_t ic, uint32_t fv, uint32_t fi) {
    WebXBuf buf; webx_buf_init(&buf);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)cb);
    webx_buf_push_u32(&buf, vc); webx_buf_push_u32(&buf, ic);
    webx_buf_push_u32(&buf, fv); webx_buf_push_u32(&buf, fi);
    webx_send(WEBX_CMD_CMD_DRAW, buf.data, (uint32_t)buf.len);
    webx_buf_free(&buf);
}

static VKAPI_ATTR void VKAPI_CALL
webx_CmdDrawIndexed(VkCommandBuffer cb, uint32_t idxCount, uint32_t instCount,
                    uint32_t firstIdx, int32_t vtxOff, uint32_t firstInst) {
    WebXBuf buf; webx_buf_init(&buf);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)cb);
    webx_buf_push_u32(&buf, idxCount); webx_buf_push_u32(&buf, instCount);
    webx_buf_push_u32(&buf, firstIdx); webx_buf_push_i32(&buf, vtxOff);
    webx_buf_push_u32(&buf, firstInst);
    webx_send(WEBX_CMD_CMD_DRAW_INDEXED, buf.data, (uint32_t)buf.len);
    webx_buf_free(&buf);
}

static VKAPI_ATTR void VKAPI_CALL
webx_CmdBindPipeline(VkCommandBuffer cb, VkPipelineBindPoint bp, VkPipeline pipeline) {
    WebXBuf buf; webx_buf_init(&buf);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)cb);
    webx_buf_push_u32(&buf, (uint32_t)bp);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)pipeline);
    webx_send(WEBX_CMD_CMD_BIND_PIPELINE, buf.data, (uint32_t)buf.len);
    webx_buf_free(&buf);
}

static VKAPI_ATTR void VKAPI_CALL
webx_CmdSetViewport(VkCommandBuffer cb, uint32_t first, uint32_t count,
                    const VkViewport *vps) {
    WebXBuf buf; webx_buf_init(&buf);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)cb);
    webx_buf_push_u32(&buf, first); webx_buf_push_u32(&buf, count);
    webx_buf_write(&buf, vps, count * sizeof(VkViewport));
    webx_send(WEBX_CMD_CMD_SET_VIEWPORT, buf.data, (uint32_t)buf.len);
    webx_buf_free(&buf);
}

static VKAPI_ATTR void VKAPI_CALL
webx_CmdSetScissor(VkCommandBuffer cb, uint32_t first, uint32_t count,
                   const VkRect2D *scissors) {
    WebXBuf buf; webx_buf_init(&buf);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)cb);
    webx_buf_push_u32(&buf, first); webx_buf_push_u32(&buf, count);
    webx_buf_write(&buf, scissors, count * sizeof(VkRect2D));
    webx_send(WEBX_CMD_CMD_SET_SCISSOR, buf.data, (uint32_t)buf.len);
    webx_buf_free(&buf);
}

static VKAPI_ATTR void VKAPI_CALL
webx_CmdPipelineBarrier(VkCommandBuffer cb,
                         VkPipelineStageFlags src, VkPipelineStageFlags dst,
                         VkDependencyFlags flags,
                         uint32_t memBarrierCount, const VkMemoryBarrier *memBarriers,
                         uint32_t bufBarrierCount, const VkBufferMemoryBarrier *bufBarriers,
                         uint32_t imgBarrierCount, const VkImageMemoryBarrier *imgBarriers) {
    /* Forward image layout transition info to host for layout tracking */
    WebXBuf buf; webx_buf_init(&buf);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)cb);
    webx_buf_push_u32(&buf, src); webx_buf_push_u32(&buf, dst);
    webx_buf_push_u32(&buf, imgBarrierCount);
    webx_buf_write(&buf, imgBarriers, imgBarrierCount * sizeof(VkImageMemoryBarrier));
    webx_send(WEBX_CMD_CMD_PIPELINE_BARRIER, buf.data, (uint32_t)buf.len);
    webx_buf_free(&buf);
}

/* ── Queue submission ─────────────────────────────────────────────────── */

static VKAPI_ATTR VkResult VKAPI_CALL
webx_QueueSubmit(VkQueue queue, uint32_t submitCount, const VkSubmitInfo *submits,
                 VkFence fence) {
    WebXBuf buf; webx_buf_init(&buf);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)queue);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)fence);
    webx_buf_push_u32(&buf, submitCount);
    for (uint32_t i = 0; i < submitCount; i++) {
        webx_buf_push_u32(&buf, submits[i].commandBufferCount);
        for (uint32_t j = 0; j < submits[i].commandBufferCount; j++)
            webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)submits[i].pCommandBuffers[j]);
    }
    /* Synchronous: waits for host to acknowledge submission */
    VkResult r = webx_call(WEBX_CMD_QUEUE_SUBMIT, buf.data, (uint32_t)buf.len, NULL, NULL);
    webx_buf_free(&buf);
    return r;
}

/* ── Presentation ─────────────────────────────────────────────────────── */

static VKAPI_ATTR VkResult VKAPI_CALL
webx_QueuePresentKHR(VkQueue queue, const VkPresentInfoKHR *pi) {
    WebXBuf buf; webx_buf_init(&buf);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)queue);
    webx_buf_push_u32(&buf, pi->swapchainCount);
    for (uint32_t i = 0; i < pi->swapchainCount; i++) {
        webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)pi->pSwapchains[i]);
        webx_buf_push_u32(&buf, pi->pImageIndices[i]);
    }
    /* Synchronous: host presents frame then returns */
    VkResult r = webx_call(WEBX_CMD_QUEUE_PRESENT, buf.data, (uint32_t)buf.len, NULL, NULL);
    webx_buf_free(&buf);
    return r;
}

/* ── Fence / sync ─────────────────────────────────────────────────────── */

static VKAPI_ATTR VkResult VKAPI_CALL
webx_CreateFence(VkDevice dev, const VkFenceCreateInfo *ci,
                 const VkAllocationCallbacks *alloc, VkFence *out) {
    WebXBuf buf; webx_buf_init(&buf);
    uint64_t h = webx_new_handle();
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)dev);
    webx_buf_push_u64(&buf, h);
    webx_buf_push_u32(&buf, ci->flags);
    VkResult r = webx_call(WEBX_CMD_CREATE_FENCE, buf.data, (uint32_t)buf.len, NULL, NULL);
    webx_buf_free(&buf);
    if (r == VK_SUCCESS) *out = (VkFence)(uintptr_t)h;
    return r;
}

static VKAPI_ATTR void VKAPI_CALL
webx_DestroyFence(VkDevice dev, VkFence fence, const VkAllocationCallbacks *alloc) {
    uint64_t h = (uint64_t)(uintptr_t)fence;
    webx_send(WEBX_CMD_DESTROY_FENCE, &h, 8);
}

static VKAPI_ATTR VkResult VKAPI_CALL
webx_WaitForFences(VkDevice dev, uint32_t count, const VkFence *fences,
                   VkBool32 waitAll, uint64_t timeout) {
    WebXBuf buf; webx_buf_init(&buf);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)dev);
    webx_buf_push_u32(&buf, count);
    webx_buf_push_u32(&buf, waitAll);
    webx_buf_push_u64(&buf, timeout);
    for (uint32_t i = 0; i < count; i++)
        webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)fences[i]);
    /* Synchronous: host blocks until GPU work done via device.poll() */
    VkResult r = webx_call(WEBX_CMD_WAIT_FOR_FENCES, buf.data, (uint32_t)buf.len, NULL, NULL);
    webx_buf_free(&buf);
    return r;
}

static VKAPI_ATTR VkResult VKAPI_CALL
webx_ResetFences(VkDevice dev, uint32_t count, const VkFence *fences) {
    WebXBuf buf; webx_buf_init(&buf);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)dev);
    webx_buf_push_u32(&buf, count);
    for (uint32_t i = 0; i < count; i++)
        webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)fences[i]);
    webx_send(WEBX_CMD_RESET_FENCES, buf.data, (uint32_t)buf.len);
    webx_buf_free(&buf);
    return VK_SUCCESS;
}

/* ── Forward declarations from split source files ─────────────────────── */
/* vkwebx_resources.c */
VKAPI_ATTR VkResult VKAPI_CALL webx_AllocateMemory(VkDevice, const VkMemoryAllocateInfo *, const VkAllocationCallbacks *, VkDeviceMemory *);
VKAPI_ATTR void     VKAPI_CALL webx_FreeMemory(VkDevice, VkDeviceMemory, const VkAllocationCallbacks *);
VKAPI_ATTR VkResult VKAPI_CALL webx_MapMemory(VkDevice, VkDeviceMemory, VkDeviceSize, VkDeviceSize, VkMemoryMapFlags, void **);
VKAPI_ATTR void     VKAPI_CALL webx_UnmapMemory(VkDevice, VkDeviceMemory);
VKAPI_ATTR VkResult VKAPI_CALL webx_FlushMappedMemoryRanges(VkDevice, uint32_t, const VkMappedMemoryRange *);
VKAPI_ATTR VkResult VKAPI_CALL webx_InvalidateMappedMemoryRanges(VkDevice, uint32_t, const VkMappedMemoryRange *);
VKAPI_ATTR void     VKAPI_CALL webx_GetBufferMemoryRequirements(VkDevice, VkBuffer, VkMemoryRequirements *);
VKAPI_ATTR void     VKAPI_CALL webx_GetImageMemoryRequirements(VkDevice, VkImage, VkMemoryRequirements *);
VKAPI_ATTR VkResult VKAPI_CALL webx_CreateBuffer(VkDevice, const VkBufferCreateInfo *, const VkAllocationCallbacks *, VkBuffer *);
VKAPI_ATTR void     VKAPI_CALL webx_DestroyBuffer(VkDevice, VkBuffer, const VkAllocationCallbacks *);
VKAPI_ATTR VkResult VKAPI_CALL webx_BindBufferMemory(VkDevice, VkBuffer, VkDeviceMemory, VkDeviceSize);
VKAPI_ATTR VkResult VKAPI_CALL webx_CreateImage(VkDevice, const VkImageCreateInfo *, const VkAllocationCallbacks *, VkImage *);
VKAPI_ATTR void     VKAPI_CALL webx_DestroyImage(VkDevice, VkImage, const VkAllocationCallbacks *);
VKAPI_ATTR VkResult VKAPI_CALL webx_BindImageMemory(VkDevice, VkImage, VkDeviceMemory, VkDeviceSize);
VKAPI_ATTR VkResult VKAPI_CALL webx_CreateImageView(VkDevice, const VkImageViewCreateInfo *, const VkAllocationCallbacks *, VkImageView *);
VKAPI_ATTR void     VKAPI_CALL webx_DestroyImageView(VkDevice, VkImageView, const VkAllocationCallbacks *);
VKAPI_ATTR VkResult VKAPI_CALL webx_CreateSampler(VkDevice, const VkSamplerCreateInfo *, const VkAllocationCallbacks *, VkSampler *);
VKAPI_ATTR void     VKAPI_CALL webx_DestroySampler(VkDevice, VkSampler, const VkAllocationCallbacks *);
VKAPI_ATTR void     VKAPI_CALL webx_CmdCopyBuffer(VkCommandBuffer, VkBuffer, VkBuffer, uint32_t, const VkBufferCopy *);
VKAPI_ATTR void     VKAPI_CALL webx_CmdCopyBufferToImage(VkCommandBuffer, VkBuffer, VkImage, VkImageLayout, uint32_t, const VkBufferImageCopy *);
VKAPI_ATTR void     VKAPI_CALL webx_CmdCopyImageToBuffer(VkCommandBuffer, VkImage, VkImageLayout, VkBuffer, uint32_t, const VkBufferImageCopy *);
VKAPI_ATTR void     VKAPI_CALL webx_CmdCopyImage(VkCommandBuffer, VkImage, VkImageLayout, VkImage, VkImageLayout, uint32_t, const VkImageCopy *);
VKAPI_ATTR void     VKAPI_CALL webx_CmdBlitImage(VkCommandBuffer, VkImage, VkImageLayout, VkImage, VkImageLayout, uint32_t, const VkImageBlit *, VkFilter);
VKAPI_ATTR void     VKAPI_CALL webx_CmdClearColorImage(VkCommandBuffer, VkImage, VkImageLayout, const VkClearColorValue *, uint32_t, const VkImageSubresourceRange *);
VKAPI_ATTR void     VKAPI_CALL webx_CmdClearDepthStencilImage(VkCommandBuffer, VkImage, VkImageLayout, const VkClearDepthStencilValue *, uint32_t, const VkImageSubresourceRange *);
VKAPI_ATTR void     VKAPI_CALL webx_CmdFillBuffer(VkCommandBuffer, VkBuffer, VkDeviceSize, VkDeviceSize, uint32_t);
VKAPI_ATTR void     VKAPI_CALL webx_CmdUpdateBuffer(VkCommandBuffer, VkBuffer, VkDeviceSize, VkDeviceSize, const void *);
/* vkwebx_pipeline.c */
VKAPI_ATTR VkResult VKAPI_CALL webx_CreateShaderModule(VkDevice, const VkShaderModuleCreateInfo *, const VkAllocationCallbacks *, VkShaderModule *);
VKAPI_ATTR void     VKAPI_CALL webx_DestroyShaderModule(VkDevice, VkShaderModule, const VkAllocationCallbacks *);
VKAPI_ATTR VkResult VKAPI_CALL webx_CreatePipelineLayout(VkDevice, const VkPipelineLayoutCreateInfo *, const VkAllocationCallbacks *, VkPipelineLayout *);
VKAPI_ATTR void     VKAPI_CALL webx_DestroyPipelineLayout(VkDevice, VkPipelineLayout, const VkAllocationCallbacks *);
VKAPI_ATTR VkResult VKAPI_CALL webx_CreateGraphicsPipelines(VkDevice, VkPipelineCache, uint32_t, const VkGraphicsPipelineCreateInfo *, const VkAllocationCallbacks *, VkPipeline *);
VKAPI_ATTR VkResult VKAPI_CALL webx_CreateComputePipelines(VkDevice, VkPipelineCache, uint32_t, const VkComputePipelineCreateInfo *, const VkAllocationCallbacks *, VkPipeline *);
VKAPI_ATTR void     VKAPI_CALL webx_DestroyPipeline(VkDevice, VkPipeline, const VkAllocationCallbacks *);
VKAPI_ATTR VkResult VKAPI_CALL webx_CreatePipelineCache(VkDevice, const VkPipelineCacheCreateInfo *, const VkAllocationCallbacks *, VkPipelineCache *);
VKAPI_ATTR void     VKAPI_CALL webx_DestroyPipelineCache(VkDevice, VkPipelineCache, const VkAllocationCallbacks *);
VKAPI_ATTR VkResult VKAPI_CALL webx_GetPipelineCacheData(VkDevice, VkPipelineCache, size_t *, void *);
VKAPI_ATTR VkResult VKAPI_CALL webx_MergePipelineCaches(VkDevice, VkPipelineCache, uint32_t, const VkPipelineCache *);
VKAPI_ATTR VkResult VKAPI_CALL webx_CreateRenderPass(VkDevice, const VkRenderPassCreateInfo *, const VkAllocationCallbacks *, VkRenderPass *);
VKAPI_ATTR void     VKAPI_CALL webx_DestroyRenderPass(VkDevice, VkRenderPass, const VkAllocationCallbacks *);
VKAPI_ATTR VkResult VKAPI_CALL webx_CreateFramebuffer(VkDevice, const VkFramebufferCreateInfo *, const VkAllocationCallbacks *, VkFramebuffer *);
VKAPI_ATTR void     VKAPI_CALL webx_DestroyFramebuffer(VkDevice, VkFramebuffer, const VkAllocationCallbacks *);
VKAPI_ATTR VkResult VKAPI_CALL webx_CreateDescriptorSetLayout(VkDevice, const VkDescriptorSetLayoutCreateInfo *, const VkAllocationCallbacks *, VkDescriptorSetLayout *);
VKAPI_ATTR void     VKAPI_CALL webx_DestroyDescriptorSetLayout(VkDevice, VkDescriptorSetLayout, const VkAllocationCallbacks *);
VKAPI_ATTR VkResult VKAPI_CALL webx_CreateDescriptorPool(VkDevice, const VkDescriptorPoolCreateInfo *, const VkAllocationCallbacks *, VkDescriptorPool *);
VKAPI_ATTR VkResult VKAPI_CALL webx_ResetDescriptorPool(VkDevice, VkDescriptorPool, VkDescriptorPoolResetFlags);
VKAPI_ATTR VkResult VKAPI_CALL webx_AllocateDescriptorSets(VkDevice, const VkDescriptorSetAllocateInfo *, VkDescriptorSet *);
VKAPI_ATTR void     VKAPI_CALL webx_UpdateDescriptorSets(VkDevice, uint32_t, const VkWriteDescriptorSet *, uint32_t, const VkCopyDescriptorSet *);
VKAPI_ATTR void     VKAPI_CALL webx_CmdBeginRenderPass(VkCommandBuffer, const VkRenderPassBeginInfo *, VkSubpassContents);
VKAPI_ATTR void     VKAPI_CALL webx_CmdEndRenderPass(VkCommandBuffer);
VKAPI_ATTR void     VKAPI_CALL webx_CmdBeginRendering(VkCommandBuffer, const VkRenderingInfo *);
VKAPI_ATTR void     VKAPI_CALL webx_CmdEndRendering(VkCommandBuffer);
VKAPI_ATTR void     VKAPI_CALL webx_CmdBindVertexBuffers(VkCommandBuffer, uint32_t, uint32_t, const VkBuffer *, const VkDeviceSize *);
VKAPI_ATTR void     VKAPI_CALL webx_CmdBindIndexBuffer(VkCommandBuffer, VkBuffer, VkDeviceSize, VkIndexType);
VKAPI_ATTR void     VKAPI_CALL webx_CmdBindDescriptorSets(VkCommandBuffer, VkPipelineBindPoint, VkPipelineLayout, uint32_t, uint32_t, const VkDescriptorSet *, uint32_t, const uint32_t *);
VKAPI_ATTR void     VKAPI_CALL webx_CmdPushConstants(VkCommandBuffer, VkPipelineLayout, VkShaderStageFlags, uint32_t, uint32_t, const void *);
VKAPI_ATTR void     VKAPI_CALL webx_CmdDrawIndirect(VkCommandBuffer, VkBuffer, VkDeviceSize, uint32_t, uint32_t);
VKAPI_ATTR void     VKAPI_CALL webx_CmdDrawIndexedIndirect(VkCommandBuffer, VkBuffer, VkDeviceSize, uint32_t, uint32_t);
VKAPI_ATTR void     VKAPI_CALL webx_CmdDispatch(VkCommandBuffer, uint32_t, uint32_t, uint32_t);
VKAPI_ATTR void     VKAPI_CALL webx_CmdDispatchIndirect(VkCommandBuffer, VkBuffer, VkDeviceSize);
VKAPI_ATTR void     VKAPI_CALL webx_CmdSetBlendConstants(VkCommandBuffer, const float[4]);
VKAPI_ATTR void     VKAPI_CALL webx_CmdSetStencilReference(VkCommandBuffer, VkStencilFaceFlags, uint32_t);
VKAPI_ATTR void     VKAPI_CALL webx_CmdSetDepthBias(VkCommandBuffer, float, float, float);
VKAPI_ATTR void     VKAPI_CALL webx_CmdSetLineWidth(VkCommandBuffer, float);
VKAPI_ATTR void     VKAPI_CALL webx_CmdSetCullModeEXT(VkCommandBuffer, VkCullModeFlags);
VKAPI_ATTR void     VKAPI_CALL webx_CmdSetFrontFaceEXT(VkCommandBuffer, VkFrontFace);
VKAPI_ATTR void     VKAPI_CALL webx_CmdSetPrimitiveTopologyEXT(VkCommandBuffer, VkPrimitiveTopology);
VKAPI_ATTR VkResult VKAPI_CALL webx_CreateSemaphore(VkDevice, const VkSemaphoreCreateInfo *, const VkAllocationCallbacks *, VkSemaphore *);
VKAPI_ATTR void     VKAPI_CALL webx_DestroySemaphore(VkDevice, VkSemaphore, const VkAllocationCallbacks *);
VKAPI_ATTR VkResult VKAPI_CALL webx_QueueWaitIdle(VkQueue);
VKAPI_ATTR VkResult VKAPI_CALL webx_FreeCommandBuffers_impl(VkDevice, VkCommandPool, uint32_t, const VkCommandBuffer *);
VKAPI_ATTR VkResult VKAPI_CALL webx_ResetCommandBuffer(VkCommandBuffer, VkCommandBufferResetFlags);
/* vkwebx_surface.c */
VKAPI_ATTR VkResult VKAPI_CALL webx_CreateXcbSurfaceKHR(VkInstance, const VkXcbSurfaceCreateInfoKHR *, const VkAllocationCallbacks *, VkSurfaceKHR *);
VKAPI_ATTR void     VKAPI_CALL webx_DestroySurfaceKHR(VkInstance, VkSurfaceKHR, const VkAllocationCallbacks *);
VKAPI_ATTR VkResult VKAPI_CALL webx_GetPhysicalDeviceSurfaceSupportKHR(VkPhysicalDevice, uint32_t, VkSurfaceKHR, VkBool32 *);
VKAPI_ATTR VkResult VKAPI_CALL webx_GetPhysicalDeviceSurfaceCapabilitiesKHR(VkPhysicalDevice, VkSurfaceKHR, VkSurfaceCapabilitiesKHR *);
VKAPI_ATTR VkResult VKAPI_CALL webx_GetPhysicalDeviceSurfaceFormatsKHR(VkPhysicalDevice, VkSurfaceKHR, uint32_t *, VkSurfaceFormatKHR *);
VKAPI_ATTR VkResult VKAPI_CALL webx_GetPhysicalDeviceSurfacePresentModesKHR(VkPhysicalDevice, VkSurfaceKHR, uint32_t *, VkPresentModeKHR *);
VKAPI_ATTR VkResult VKAPI_CALL webx_CreateSwapchainKHR(VkDevice, const VkSwapchainCreateInfoKHR *, const VkAllocationCallbacks *, VkSwapchainKHR *);
VKAPI_ATTR void     VKAPI_CALL webx_DestroySwapchainKHR(VkDevice, VkSwapchainKHR, const VkAllocationCallbacks *);
VKAPI_ATTR VkResult VKAPI_CALL webx_GetSwapchainImagesKHR(VkDevice, VkSwapchainKHR, uint32_t *, VkImage *);
VKAPI_ATTR VkResult VKAPI_CALL webx_AcquireNextImageKHR(VkDevice, VkSwapchainKHR, uint64_t, VkSemaphore, VkFence, uint32_t *);
VKAPI_ATTR void     VKAPI_CALL webx_GetPhysicalDeviceProperties2(VkPhysicalDevice, VkPhysicalDeviceProperties2 *);
VKAPI_ATTR void     VKAPI_CALL webx_GetPhysicalDeviceFeatures2(VkPhysicalDevice, VkPhysicalDeviceFeatures2 *);
VKAPI_ATTR void     VKAPI_CALL webx_GetPhysicalDeviceMemoryProperties2(VkPhysicalDevice, VkPhysicalDeviceMemoryProperties2 *);
VKAPI_ATTR void     VKAPI_CALL webx_GetPhysicalDeviceFormatProperties(VkPhysicalDevice, VkFormat, VkFormatProperties *);

/* ── Proc address dispatch ────────────────────────────────────────────── */

#define PROC(name) if (!strcmp(pname, "vk" #name)) return (PFN_vkVoidFunction)webx_##name

static PFN_vkVoidFunction webx_get_instance_proc(VkInstance inst, const char *pname) {
    /* ICD loader interface */
    if (!strcmp(pname, "vk_icdGetInstanceProcAddr"))
        return (PFN_vkVoidFunction)vk_icdGetInstanceProcAddr;
    if (!strcmp(pname, "vk_icdNegotiateLoaderICDInterfaceVersion"))
        return (PFN_vkVoidFunction)vk_icdNegotiateLoaderICDInterfaceVersion;
    if (!strcmp(pname, "vk_icdGetPhysicalDeviceProcAddr"))
        return (PFN_vkVoidFunction)vk_icdGetPhysicalDeviceProcAddr;

    /* Instance + physical device */
    PROC(CreateInstance);
    PROC(DestroyInstance);
    PROC(EnumeratePhysicalDevices);
    PROC(GetPhysicalDeviceProperties);
    PROC(GetPhysicalDeviceFeatures);
    PROC(GetPhysicalDeviceFeatures2);
    PROC(GetPhysicalDeviceProperties2);
    PROC(GetPhysicalDeviceMemoryProperties);
    PROC(GetPhysicalDeviceMemoryProperties2);
    PROC(GetPhysicalDeviceQueueFamilyProperties);
    PROC(GetPhysicalDeviceFormatProperties);
    PROC(EnumerateInstanceExtensionProperties);
    PROC(EnumerateInstanceLayerProperties);
    PROC(EnumerateDeviceExtensionProperties);

    /* Surface */
    PROC(CreateXcbSurfaceKHR);
    PROC(DestroySurfaceKHR);
    PROC(GetPhysicalDeviceSurfaceSupportKHR);
    PROC(GetPhysicalDeviceSurfaceCapabilitiesKHR);
    PROC(GetPhysicalDeviceSurfaceFormatsKHR);
    PROC(GetPhysicalDeviceSurfacePresentModesKHR);

    /* Device */
    PROC(CreateDevice);
    PROC(DestroyDevice);
    PROC(GetDeviceQueue);
    PROC(DeviceWaitIdle);

    /* Memory */
    PROC(AllocateMemory);
    PROC(FreeMemory);
    PROC(MapMemory);
    PROC(UnmapMemory);
    PROC(FlushMappedMemoryRanges);
    PROC(InvalidateMappedMemoryRanges);
    PROC(GetBufferMemoryRequirements);
    PROC(GetImageMemoryRequirements);

    /* Buffers + images */
    PROC(CreateBuffer);
    PROC(DestroyBuffer);
    PROC(BindBufferMemory);
    PROC(CreateImage);
    PROC(DestroyImage);
    PROC(BindImageMemory);
    PROC(CreateImageView);
    PROC(DestroyImageView);
    PROC(CreateSampler);
    PROC(DestroySampler);

    /* Shaders + pipelines */
    PROC(CreateShaderModule);
    PROC(DestroyShaderModule);
    PROC(CreatePipelineLayout);
    PROC(DestroyPipelineLayout);
    PROC(CreateGraphicsPipelines);
    PROC(CreateComputePipelines);
    PROC(DestroyPipeline);
    PROC(CreatePipelineCache);
    PROC(DestroyPipelineCache);
    PROC(GetPipelineCacheData);
    PROC(MergePipelineCaches);

    /* Render passes + framebuffers */
    PROC(CreateRenderPass);
    PROC(DestroyRenderPass);
    PROC(CreateFramebuffer);
    PROC(DestroyFramebuffer);

    /* Descriptors */
    PROC(CreateDescriptorSetLayout);
    PROC(DestroyDescriptorSetLayout);
    PROC(CreateDescriptorPool);
    PROC(ResetDescriptorPool);
    PROC(AllocateDescriptorSets);
    PROC(UpdateDescriptorSets);

    /* Swapchain */
    PROC(CreateSwapchainKHR);
    PROC(DestroySwapchainKHR);
    PROC(GetSwapchainImagesKHR);
    PROC(AcquireNextImageKHR);

    /* Command pools + buffers */
    PROC(CreateCommandPool);
    PROC(DestroyCommandPool);
    PROC(AllocateCommandBuffers);
    PROC(BeginCommandBuffer);
    PROC(EndCommandBuffer);
    PROC(ResetCommandBuffer);
    if (!strcmp(pname, "vkFreeCommandBuffers"))
        return (PFN_vkVoidFunction)webx_FreeCommandBuffers_impl;

    /* Recording — from vkwebx.c */
    PROC(CmdDraw);
    PROC(CmdDrawIndexed);
    PROC(CmdBindPipeline);
    PROC(CmdSetViewport);
    PROC(CmdSetScissor);
    PROC(CmdPipelineBarrier);

    /* Recording — from vkwebx_pipeline.c */
    PROC(CmdBeginRenderPass);
    PROC(CmdEndRenderPass);
    PROC(CmdBeginRendering);
    PROC(CmdEndRendering);
    PROC(CmdBindVertexBuffers);
    PROC(CmdBindIndexBuffer);
    PROC(CmdBindDescriptorSets);
    PROC(CmdPushConstants);
    PROC(CmdDrawIndirect);
    PROC(CmdDrawIndexedIndirect);
    PROC(CmdDispatch);
    PROC(CmdDispatchIndirect);
    PROC(CmdSetBlendConstants);
    PROC(CmdSetStencilReference);
    PROC(CmdSetDepthBias);
    PROC(CmdSetLineWidth);
    PROC(CmdSetCullModeEXT);
    PROC(CmdSetFrontFaceEXT);
    PROC(CmdSetPrimitiveTopologyEXT);

    /* Recording — from vkwebx_resources.c */
    PROC(CmdCopyBuffer);
    PROC(CmdCopyBufferToImage);
    PROC(CmdCopyImageToBuffer);
    PROC(CmdCopyImage);
    PROC(CmdBlitImage);
    PROC(CmdClearColorImage);
    PROC(CmdClearDepthStencilImage);
    PROC(CmdFillBuffer);
    PROC(CmdUpdateBuffer);

    /* Sync */
    PROC(CreateSemaphore);
    PROC(DestroySemaphore);
    PROC(QueueWaitIdle);

    /* Queue */
    PROC(QueueSubmit);
    PROC(QueuePresentKHR);

    /* Sync */
    PROC(CreateFence);
    PROC(DestroyFence);
    PROC(WaitForFences);
    PROC(ResetFences);

    /* Unimplemented — log and return NULL (loader will skip) */
    fprintf(stderr, "[webx-icd] unimplemented: %s\n", pname);
    return NULL;
}

static PFN_vkVoidFunction webx_get_device_proc(VkDevice dev, const char *pname) {
    return webx_get_instance_proc(VK_NULL_HANDLE, pname);
}
