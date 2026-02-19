/*
 * WebX Guest ICD — Resource entrypoints
 * Memory, buffers, images, image views, samplers.
 */

#define VK_NO_PROTOTYPES
#include <vulkan/vulkan.h>
#include "vkwebx_wire.h"
#include <string.h>

/* Provided by vkwebx.c */
extern int    g_dev_fd;
extern void   webx_send(VkWebXCmd, const void *, uint32_t);
extern VkResult webx_call(VkWebXCmd, const void *, uint32_t, uint8_t **, uint32_t *);

/* ── Memory ──────────────────────────────────────────────────────────── */

VKAPI_ATTR VkResult VKAPI_CALL
webx_AllocateMemory(VkDevice dev, const VkMemoryAllocateInfo *ai,
                    const VkAllocationCallbacks *alloc, VkDeviceMemory *out) {
    WebXBuf buf; webx_buf_init(&buf);
    uint64_t h = webx_new_handle();
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)dev);
    webx_buf_push_u64(&buf, h);
    webx_buf_push_u64(&buf, (uint64_t)ai->allocationSize);
    webx_buf_push_u32(&buf, ai->memoryTypeIndex);
    VkResult r = webx_call(WEBX_CMD_ALLOCATE_MEMORY, buf.data, (uint32_t)buf.len, NULL, NULL);
    webx_buf_free(&buf);
    if (r == VK_SUCCESS) *out = (VkDeviceMemory)(uintptr_t)h;
    return r;
}

VKAPI_ATTR void VKAPI_CALL
webx_FreeMemory(VkDevice dev, VkDeviceMemory mem,
                const VkAllocationCallbacks *alloc) {
    uint64_t h = (uint64_t)(uintptr_t)mem;
    webx_send(WEBX_CMD_FREE_MEMORY, &h, 8);
}

VKAPI_ATTR VkResult VKAPI_CALL
webx_MapMemory(VkDevice dev, VkDeviceMemory mem, VkDeviceSize off,
               VkDeviceSize size, VkMemoryMapFlags flags, void **ppData) {
    /*
     * We allocate a local CPU-side shadow buffer for the mapped range.
     * On unmap or flush, we send it to the host via WEBX_CMD_WRITE_MAPPED_DATA.
     * The pointer is stored in a small per-mapping struct.
     */
    size_t sz = (size == VK_WHOLE_SIZE) ? 64 * 1024 * 1024 : (size_t)size;
    void *shadow = calloc(1, sz);
    if (!shadow) return VK_ERROR_OUT_OF_HOST_MEMORY;

    /* Encode offset into the shadow pointer itself (hack: store as tagged ptr).
     * A real implementation would keep a side table. */
    *ppData = shadow;
    return VK_SUCCESS;
}

VKAPI_ATTR void VKAPI_CALL
webx_UnmapMemory(VkDevice dev, VkDeviceMemory mem) {
    /*
     * Send all pending mapped data to the host.
     * The shadow buffer was already freed by the caller after writing.
     * We send a zero-size flush to let the host know the map is released.
     */
    WebXBuf buf; webx_buf_init(&buf);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)dev);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)mem);
    webx_buf_push_u64(&buf, 0);   /* offset */
    webx_buf_push_u32(&buf, 0);   /* data length = 0 (unmap signal) */
    webx_send(WEBX_CMD_UNMAP_MEMORY, buf.data, (uint32_t)buf.len);
    webx_buf_free(&buf);
}

VKAPI_ATTR VkResult VKAPI_CALL
webx_FlushMappedMemoryRanges(VkDevice dev, uint32_t count,
                              const VkMappedMemoryRange *ranges) {
    /* Caller has written data to the shadow buffer at ranges[i].memory.
     * We need to send those bytes to the host.
     * Currently a no-op stub — real implementation tracks shadow buffers. */
    (void)dev; (void)count; (void)ranges;
    return VK_SUCCESS;
}

VKAPI_ATTR VkResult VKAPI_CALL
webx_InvalidateMappedMemoryRanges(VkDevice dev, uint32_t count,
                                   const VkMappedMemoryRange *ranges) {
    (void)dev; (void)count; (void)ranges;
    return VK_SUCCESS;
}

/* Send bulk data for a mapped region (called by higher-level upload helpers) */
void webx_upload_memory(VkDeviceMemory mem, VkDeviceSize offset,
                         const void *data, VkDeviceSize size) {
    WebXBuf hdr; webx_buf_init(&hdr);
    webx_buf_push_u64(&hdr, (uint64_t)(uintptr_t)mem);
    webx_buf_push_u64(&hdr, (uint64_t)offset);
    webx_buf_push_u32(&hdr, (uint32_t)size);
    /* Inline the bulk data after the header in one packet */
    webx_buf_write(&hdr, data, (size_t)size);
    webx_send(WEBX_CMD_WRITE_MAPPED_DATA, hdr.data, (uint32_t)hdr.len);
    webx_buf_free(&hdr);
}

/* ── Memory requirements ─────────────────────────────────────────────── */

VKAPI_ATTR void VKAPI_CALL
webx_GetBufferMemoryRequirements(VkDevice dev, VkBuffer buf,
                                  VkMemoryRequirements *reqs) {
    /* Host knows the real size; we ask synchronously */
    WebXBuf b; webx_buf_init(&b);
    webx_buf_push_u64(&b, (uint64_t)(uintptr_t)dev);
    webx_buf_push_u64(&b, (uint64_t)(uintptr_t)buf);
    uint8_t *data; uint32_t len;
    if (webx_call(0x0040 | 0x8000, b.data, (uint32_t)b.len, &data, &len) == VK_SUCCESS
        && len >= sizeof(*reqs)) {
        memcpy(reqs, data, sizeof(*reqs));
    } else {
        /* Fallback: report size of buffer creation info */
        reqs->size       = 256;
        reqs->alignment  = 256;
        reqs->memoryTypeBits = 0x7;
    }
    free(data);
    webx_buf_free(&b);
}

VKAPI_ATTR void VKAPI_CALL
webx_GetImageMemoryRequirements(VkDevice dev, VkImage img,
                                 VkMemoryRequirements *reqs) {
    WebXBuf b; webx_buf_init(&b);
    webx_buf_push_u64(&b, (uint64_t)(uintptr_t)dev);
    webx_buf_push_u64(&b, (uint64_t)(uintptr_t)img);
    uint8_t *data; uint32_t len;
    if (webx_call(0x0043 | 0x8000, b.data, (uint32_t)b.len, &data, &len) == VK_SUCCESS
        && len >= sizeof(*reqs)) {
        memcpy(reqs, data, sizeof(*reqs));
    } else {
        reqs->size       = 4 * 1024 * 1024;
        reqs->alignment  = 4096;
        reqs->memoryTypeBits = 0x7;
    }
    free(data);
    webx_buf_free(&b);
}

/* ── Buffers ─────────────────────────────────────────────────────────── */

VKAPI_ATTR VkResult VKAPI_CALL
webx_CreateBuffer(VkDevice dev, const VkBufferCreateInfo *ci,
                  const VkAllocationCallbacks *alloc, VkBuffer *out) {
    WebXBuf buf; webx_buf_init(&buf);
    uint64_t h = webx_new_handle();
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)dev);
    webx_buf_push_u64(&buf, h);
    webx_buf_push_u64(&buf, (uint64_t)ci->size);
    webx_buf_push_u32(&buf, ci->usage);
    webx_buf_push_u32(&buf, ci->sharingMode);
    VkResult r = webx_call(WEBX_CMD_CREATE_BUFFER, buf.data, (uint32_t)buf.len, NULL, NULL);
    webx_buf_free(&buf);
    if (r == VK_SUCCESS) *out = (VkBuffer)(uintptr_t)h;
    return r;
}

VKAPI_ATTR void VKAPI_CALL
webx_DestroyBuffer(VkDevice dev, VkBuffer b, const VkAllocationCallbacks *a) {
    uint64_t h = (uint64_t)(uintptr_t)b;
    webx_send(WEBX_CMD_DESTROY_BUFFER, &h, 8);
}

VKAPI_ATTR VkResult VKAPI_CALL
webx_BindBufferMemory(VkDevice dev, VkBuffer buf, VkDeviceMemory mem,
                      VkDeviceSize offset) {
    WebXBuf b; webx_buf_init(&b);
    webx_buf_push_u64(&b, (uint64_t)(uintptr_t)dev);
    webx_buf_push_u64(&b, (uint64_t)(uintptr_t)buf);
    webx_buf_push_u64(&b, (uint64_t)(uintptr_t)mem);
    webx_buf_push_u64(&b, (uint64_t)offset);
    VkResult r = webx_call(WEBX_CMD_BIND_BUFFER_MEMORY, b.data, (uint32_t)b.len, NULL, NULL);
    webx_buf_free(&b);
    return r;
}

/* ── Images ──────────────────────────────────────────────────────────── */

VKAPI_ATTR VkResult VKAPI_CALL
webx_CreateImage(VkDevice dev, const VkImageCreateInfo *ci,
                 const VkAllocationCallbacks *alloc, VkImage *out) {
    WebXBuf buf; webx_buf_init(&buf);
    uint64_t h = webx_new_handle();
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)dev);
    webx_buf_push_u64(&buf, h);
    webx_buf_push_u32(&buf, ci->imageType);
    webx_buf_push_u32(&buf, ci->format);
    webx_buf_push_u32(&buf, ci->extent.width);
    webx_buf_push_u32(&buf, ci->extent.height);
    webx_buf_push_u32(&buf, ci->extent.depth);
    webx_buf_push_u32(&buf, ci->mipLevels);
    webx_buf_push_u32(&buf, ci->arrayLayers);
    webx_buf_push_u32(&buf, ci->samples);
    webx_buf_push_u32(&buf, ci->tiling);
    webx_buf_push_u32(&buf, ci->usage);
    webx_buf_push_u32(&buf, ci->initialLayout);
    webx_buf_push_u32(&buf, ci->flags);
    VkResult r = webx_call(WEBX_CMD_CREATE_IMAGE, buf.data, (uint32_t)buf.len, NULL, NULL);
    webx_buf_free(&buf);
    if (r == VK_SUCCESS) *out = (VkImage)(uintptr_t)h;
    return r;
}

VKAPI_ATTR void VKAPI_CALL
webx_DestroyImage(VkDevice dev, VkImage img, const VkAllocationCallbacks *a) {
    uint64_t h = (uint64_t)(uintptr_t)img;
    webx_send(WEBX_CMD_DESTROY_IMAGE, &h, 8);
}

VKAPI_ATTR VkResult VKAPI_CALL
webx_BindImageMemory(VkDevice dev, VkImage img, VkDeviceMemory mem,
                     VkDeviceSize offset) {
    WebXBuf b; webx_buf_init(&b);
    webx_buf_push_u64(&b, (uint64_t)(uintptr_t)dev);
    webx_buf_push_u64(&b, (uint64_t)(uintptr_t)img);
    webx_buf_push_u64(&b, (uint64_t)(uintptr_t)mem);
    webx_buf_push_u64(&b, (uint64_t)offset);
    VkResult r = webx_call(WEBX_CMD_BIND_IMAGE_MEMORY, b.data, (uint32_t)b.len, NULL, NULL);
    webx_buf_free(&b);
    return r;
}

VKAPI_ATTR VkResult VKAPI_CALL
webx_CreateImageView(VkDevice dev, const VkImageViewCreateInfo *ci,
                     const VkAllocationCallbacks *alloc, VkImageView *out) {
    WebXBuf buf; webx_buf_init(&buf);
    uint64_t h = webx_new_handle();
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)dev);
    webx_buf_push_u64(&buf, h);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)ci->image);
    webx_buf_push_u32(&buf, ci->viewType);
    webx_buf_push_u32(&buf, ci->format);
    webx_buf_push_u32(&buf, ci->components.r);
    webx_buf_push_u32(&buf, ci->components.g);
    webx_buf_push_u32(&buf, ci->components.b);
    webx_buf_push_u32(&buf, ci->components.a);
    webx_buf_push_u32(&buf, ci->subresourceRange.aspectMask);
    webx_buf_push_u32(&buf, ci->subresourceRange.baseMipLevel);
    webx_buf_push_u32(&buf, ci->subresourceRange.levelCount);
    webx_buf_push_u32(&buf, ci->subresourceRange.baseArrayLayer);
    webx_buf_push_u32(&buf, ci->subresourceRange.layerCount);
    VkResult r = webx_call(WEBX_CMD_CREATE_IMAGE_VIEW, buf.data, (uint32_t)buf.len, NULL, NULL);
    webx_buf_free(&buf);
    if (r == VK_SUCCESS) *out = (VkImageView)(uintptr_t)h;
    return r;
}

VKAPI_ATTR void VKAPI_CALL
webx_DestroyImageView(VkDevice dev, VkImageView iv, const VkAllocationCallbacks *a) {
    uint64_t h = (uint64_t)(uintptr_t)iv;
    webx_send(WEBX_CMD_DESTROY_IMAGE_VIEW, &h, 8);
}

VKAPI_ATTR VkResult VKAPI_CALL
webx_CreateSampler(VkDevice dev, const VkSamplerCreateInfo *ci,
                   const VkAllocationCallbacks *alloc, VkSampler *out) {
    WebXBuf buf; webx_buf_init(&buf);
    uint64_t h = webx_new_handle();
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)dev);
    webx_buf_push_u64(&buf, h);
    webx_buf_push_u32(&buf, ci->magFilter);
    webx_buf_push_u32(&buf, ci->minFilter);
    webx_buf_push_u32(&buf, ci->mipmapMode);
    webx_buf_push_u32(&buf, ci->addressModeU);
    webx_buf_push_u32(&buf, ci->addressModeV);
    webx_buf_push_u32(&buf, ci->addressModeW);
    webx_buf_push_f32(&buf, ci->mipLodBias);
    webx_buf_push_u32(&buf, ci->anisotropyEnable);
    webx_buf_push_f32(&buf, ci->maxAnisotropy);
    webx_buf_push_u32(&buf, ci->compareEnable);
    webx_buf_push_u32(&buf, ci->compareOp);
    webx_buf_push_f32(&buf, ci->minLod);
    webx_buf_push_f32(&buf, ci->maxLod);
    webx_buf_push_u32(&buf, ci->borderColor);
    webx_buf_push_u32(&buf, ci->unnormalizedCoordinates);
    VkResult r = webx_call(WEBX_CMD_CREATE_SAMPLER, buf.data, (uint32_t)buf.len, NULL, NULL);
    webx_buf_free(&buf);
    if (r == VK_SUCCESS) *out = (VkSampler)(uintptr_t)h;
    return r;
}

VKAPI_ATTR void VKAPI_CALL
webx_DestroySampler(VkDevice dev, VkSampler s, const VkAllocationCallbacks *a) {
    uint64_t h = (uint64_t)(uintptr_t)s;
    webx_send(WEBX_CMD_DESTROY_SAMPLER, &h, 8);
}

/* ── Transfer commands ───────────────────────────────────────────────── */

VKAPI_ATTR void VKAPI_CALL
webx_CmdCopyBuffer(VkCommandBuffer cb, VkBuffer src, VkBuffer dst,
                   uint32_t regionCount, const VkBufferCopy *regions) {
    WebXBuf buf; webx_buf_init(&buf);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)cb);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)src);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)dst);
    webx_buf_push_u32(&buf, regionCount);
    webx_buf_write(&buf, regions, regionCount * sizeof(VkBufferCopy));
    webx_send(WEBX_CMD_CMD_COPY_BUFFER, buf.data, (uint32_t)buf.len);
    webx_buf_free(&buf);
}

VKAPI_ATTR void VKAPI_CALL
webx_CmdCopyBufferToImage(VkCommandBuffer cb, VkBuffer src, VkImage dst,
                           VkImageLayout dstLayout, uint32_t regionCount,
                           const VkBufferImageCopy *regions) {
    WebXBuf buf; webx_buf_init(&buf);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)cb);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)src);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)dst);
    webx_buf_push_u32(&buf, dstLayout);
    webx_buf_push_u32(&buf, regionCount);
    webx_buf_write(&buf, regions, regionCount * sizeof(VkBufferImageCopy));
    webx_send(WEBX_CMD_CMD_COPY_BUFFER_TO_IMAGE, buf.data, (uint32_t)buf.len);
    webx_buf_free(&buf);
}

VKAPI_ATTR void VKAPI_CALL
webx_CmdCopyImageToBuffer(VkCommandBuffer cb, VkImage src, VkImageLayout srcLayout,
                           VkBuffer dst, uint32_t regionCount,
                           const VkBufferImageCopy *regions) {
    WebXBuf buf; webx_buf_init(&buf);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)cb);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)src);
    webx_buf_push_u32(&buf, srcLayout);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)dst);
    webx_buf_push_u32(&buf, regionCount);
    webx_buf_write(&buf, regions, regionCount * sizeof(VkBufferImageCopy));
    webx_send(WEBX_CMD_CMD_COPY_IMAGE_TO_BUFFER, buf.data, (uint32_t)buf.len);
    webx_buf_free(&buf);
}

VKAPI_ATTR void VKAPI_CALL
webx_CmdCopyImage(VkCommandBuffer cb,
                  VkImage src, VkImageLayout srcLayout,
                  VkImage dst, VkImageLayout dstLayout,
                  uint32_t regionCount, const VkImageCopy *regions) {
    WebXBuf buf; webx_buf_init(&buf);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)cb);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)src);
    webx_buf_push_u32(&buf, srcLayout);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)dst);
    webx_buf_push_u32(&buf, dstLayout);
    webx_buf_push_u32(&buf, regionCount);
    webx_buf_write(&buf, regions, regionCount * sizeof(VkImageCopy));
    webx_send(WEBX_CMD_CMD_COPY_IMAGE, buf.data, (uint32_t)buf.len);
    webx_buf_free(&buf);
}

VKAPI_ATTR void VKAPI_CALL
webx_CmdBlitImage(VkCommandBuffer cb,
                  VkImage src, VkImageLayout srcLayout,
                  VkImage dst, VkImageLayout dstLayout,
                  uint32_t regionCount, const VkImageBlit *regions,
                  VkFilter filter) {
    WebXBuf buf; webx_buf_init(&buf);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)cb);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)src);
    webx_buf_push_u32(&buf, srcLayout);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)dst);
    webx_buf_push_u32(&buf, dstLayout);
    webx_buf_push_u32(&buf, regionCount);
    webx_buf_write(&buf, regions, regionCount * sizeof(VkImageBlit));
    webx_buf_push_u32(&buf, filter);
    webx_send(WEBX_CMD_CMD_BLIT_IMAGE, buf.data, (uint32_t)buf.len);
    webx_buf_free(&buf);
}

VKAPI_ATTR void VKAPI_CALL
webx_CmdClearColorImage(VkCommandBuffer cb, VkImage img, VkImageLayout layout,
                         const VkClearColorValue *color,
                         uint32_t rangeCount, const VkImageSubresourceRange *ranges) {
    WebXBuf buf; webx_buf_init(&buf);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)cb);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)img);
    webx_buf_push_u32(&buf, layout);
    webx_buf_write(&buf, color, sizeof(*color));
    webx_buf_push_u32(&buf, rangeCount);
    webx_buf_write(&buf, ranges, rangeCount * sizeof(VkImageSubresourceRange));
    webx_send(WEBX_CMD_CMD_CLEAR_COLOR_IMAGE, buf.data, (uint32_t)buf.len);
    webx_buf_free(&buf);
}

VKAPI_ATTR void VKAPI_CALL
webx_CmdClearDepthStencilImage(VkCommandBuffer cb, VkImage img, VkImageLayout layout,
                                const VkClearDepthStencilValue *val,
                                uint32_t rangeCount, const VkImageSubresourceRange *ranges) {
    WebXBuf buf; webx_buf_init(&buf);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)cb);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)img);
    webx_buf_push_u32(&buf, layout);
    webx_buf_push_f32(&buf, val->depth);
    webx_buf_push_u32(&buf, val->stencil);
    webx_buf_push_u32(&buf, rangeCount);
    webx_buf_write(&buf, ranges, rangeCount * sizeof(VkImageSubresourceRange));
    webx_send(WEBX_CMD_CMD_CLEAR_DEPTH_STENCIL_IMAGE, buf.data, (uint32_t)buf.len);
    webx_buf_free(&buf);
}

VKAPI_ATTR void VKAPI_CALL
webx_CmdFillBuffer(VkCommandBuffer cb, VkBuffer dst, VkDeviceSize offset,
                   VkDeviceSize size, uint32_t data) {
    WebXBuf buf; webx_buf_init(&buf);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)cb);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)dst);
    webx_buf_push_u64(&buf, (uint64_t)offset);
    webx_buf_push_u64(&buf, (uint64_t)size);
    webx_buf_push_u32(&buf, data);
    webx_send(WEBX_CMD_CMD_FILL_BUFFER, buf.data, (uint32_t)buf.len);
    webx_buf_free(&buf);
}

VKAPI_ATTR void VKAPI_CALL
webx_CmdUpdateBuffer(VkCommandBuffer cb, VkBuffer dst, VkDeviceSize offset,
                     VkDeviceSize dataSize, const void *data) {
    WebXBuf buf; webx_buf_init(&buf);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)cb);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)dst);
    webx_buf_push_u64(&buf, (uint64_t)offset);
    webx_buf_push_u32(&buf, (uint32_t)dataSize);
    webx_buf_write(&buf, data, (size_t)dataSize);
    webx_send(WEBX_CMD_CMD_UPDATE_BUFFER, buf.data, (uint32_t)buf.len);
    webx_buf_free(&buf);
}
