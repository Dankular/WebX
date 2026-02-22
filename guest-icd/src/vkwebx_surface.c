/*
 * WebX Guest ICD — Surface and swapchain entrypoints
 * Wine uses VK_KHR_xcb_surface (X11) when running under Xorg inside CheerpX.
 */

#define VK_NO_PROTOTYPES
#define VK_USE_PLATFORM_XCB_KHR
#include <vulkan/vulkan.h>
#include "vkwebx_wire.h"
#include <string.h>

extern void   webx_send(VkWebXCmd, const void *, uint32_t);
extern VkResult webx_call(VkWebXCmd, const void *, uint32_t, uint8_t **, uint32_t *);

/* ── Surface ─────────────────────────────────────────────────────────── */

/*
 * Wine creates an xcb_surface when running under Xorg.
 * We ignore the xcb connection/window (they're meaningless to the host)
 * and create a virtual surface handle.  The host uses the canvas registered
 * at boot time.
 */
VKAPI_ATTR VkResult VKAPI_CALL
webx_CreateXcbSurfaceKHR(VkInstance inst,
                          const VkXcbSurfaceCreateInfoKHR *ci,
                          const VkAllocationCallbacks *alloc,
                          VkSurfaceKHR *out) {
    uint64_t h = webx_new_handle();
    WebXBuf buf; webx_buf_init(&buf);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)inst);
    webx_buf_push_u64(&buf, h);
    /* xcb window id — informational only for the host */
    webx_buf_push_u32(&buf, ci->window);
    VkResult r = webx_call(0x00C3 /* CREATE_SURFACE */, buf.data, (uint32_t)buf.len, NULL, NULL);
    webx_buf_free(&buf);
    if (r == VK_SUCCESS) *out = (VkSurfaceKHR)(uintptr_t)h;
    return r;
}

VKAPI_ATTR void VKAPI_CALL
webx_DestroySurfaceKHR(VkInstance inst, VkSurfaceKHR surface,
                        const VkAllocationCallbacks *alloc) {
    uint64_t h = (uint64_t)(uintptr_t)surface;
    webx_send(0x00C4 /* DESTROY_SURFACE */, &h, 8);
}

VKAPI_ATTR VkResult VKAPI_CALL
webx_GetPhysicalDeviceSurfaceSupportKHR(VkPhysicalDevice pd, uint32_t queueFamily,
                                         VkSurfaceKHR surface, VkBool32 *supported) {
    *supported = VK_TRUE;
    return VK_SUCCESS;
}

VKAPI_ATTR VkResult VKAPI_CALL
webx_GetPhysicalDeviceSurfaceCapabilitiesKHR(VkPhysicalDevice pd,
                                              VkSurfaceKHR surface,
                                              VkSurfaceCapabilitiesKHR *caps) {
    WebXBuf buf; webx_buf_init(&buf);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)pd);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)surface);
    uint8_t *data; uint32_t len;
    VkResult r = webx_call(0x00C5 /* GET_SURFACE_CAPS */,
                            buf.data, (uint32_t)buf.len, &data, &len);
    webx_buf_free(&buf);
    if (r == VK_SUCCESS && len >= sizeof(*caps))
        memcpy(caps, data, sizeof(*caps));
    else {
        /* Fallback defaults matching a 1280×720 canvas */
        memset(caps, 0, sizeof(*caps));
        caps->minImageCount         = 2;
        caps->maxImageCount         = 3;
        caps->currentExtent         = (VkExtent2D){1280, 720};
        caps->minImageExtent        = (VkExtent2D){1, 1};
        caps->maxImageExtent        = (VkExtent2D){16384, 16384};
        caps->maxImageArrayLayers   = 1;
        caps->supportedTransforms   = VK_SURFACE_TRANSFORM_IDENTITY_BIT_KHR;
        caps->currentTransform      = VK_SURFACE_TRANSFORM_IDENTITY_BIT_KHR;
        caps->supportedCompositeAlpha = VK_COMPOSITE_ALPHA_OPAQUE_BIT_KHR;
        caps->supportedUsageFlags   = VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT
                                    | VK_IMAGE_USAGE_TRANSFER_DST_BIT
                                    | VK_IMAGE_USAGE_TRANSFER_SRC_BIT;
    }
    free(data);
    return VK_SUCCESS;
}

VKAPI_ATTR VkResult VKAPI_CALL
webx_GetPhysicalDeviceSurfaceFormatsKHR(VkPhysicalDevice pd, VkSurfaceKHR surface,
                                         uint32_t *count, VkSurfaceFormatKHR *formats) {
    static const VkSurfaceFormatKHR k_formats[] = {
        { VK_FORMAT_B8G8R8A8_UNORM,  VK_COLOR_SPACE_SRGB_NONLINEAR_KHR },
        { VK_FORMAT_B8G8R8A8_SRGB,   VK_COLOR_SPACE_SRGB_NONLINEAR_KHR },
        { VK_FORMAT_R8G8B8A8_UNORM,  VK_COLOR_SPACE_SRGB_NONLINEAR_KHR },
        { VK_FORMAT_R8G8B8A8_SRGB,   VK_COLOR_SPACE_SRGB_NONLINEAR_KHR },
    };
    static const uint32_t k_count = 4;
    if (!formats) { *count = k_count; return VK_SUCCESS; }
    uint32_t n = *count < k_count ? *count : k_count;
    memcpy(formats, k_formats, n * sizeof(VkSurfaceFormatKHR));
    *count = n;
    return n < k_count ? VK_INCOMPLETE : VK_SUCCESS;
}

VKAPI_ATTR VkResult VKAPI_CALL
webx_GetPhysicalDeviceSurfacePresentModesKHR(VkPhysicalDevice pd, VkSurfaceKHR surface,
                                              uint32_t *count, VkPresentModeKHR *modes) {
    static const VkPresentModeKHR k_modes[] = {
        VK_PRESENT_MODE_FIFO_KHR,         /* always available per spec */
        VK_PRESENT_MODE_MAILBOX_KHR,
    };
    static const uint32_t k_count = 2;
    if (!modes) { *count = k_count; return VK_SUCCESS; }
    uint32_t n = *count < k_count ? *count : k_count;
    memcpy(modes, k_modes, n * sizeof(VkPresentModeKHR));
    *count = n;
    return n < k_count ? VK_INCOMPLETE : VK_SUCCESS;
}

/* ── Swapchain ───────────────────────────────────────────────────────── */

VKAPI_ATTR VkResult VKAPI_CALL
webx_CreateSwapchainKHR(VkDevice dev, const VkSwapchainCreateInfoKHR *ci,
                         const VkAllocationCallbacks *alloc, VkSwapchainKHR *out) {
    WebXBuf buf; webx_buf_init(&buf);
    uint64_t h = webx_new_handle();
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)dev);
    webx_buf_push_u64(&buf, h);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)ci->surface);
    webx_buf_push_u32(&buf, ci->minImageCount);
    webx_buf_push_u32(&buf, ci->imageFormat);
    webx_buf_push_u32(&buf, ci->imageColorSpace);
    webx_buf_push_u32(&buf, ci->imageExtent.width);
    webx_buf_push_u32(&buf, ci->imageExtent.height);
    webx_buf_push_u32(&buf, ci->imageArrayLayers);
    webx_buf_push_u32(&buf, ci->imageUsage);
    webx_buf_push_u32(&buf, ci->preTransform);
    webx_buf_push_u32(&buf, ci->compositeAlpha);
    webx_buf_push_u32(&buf, ci->presentMode);
    webx_buf_push_u32(&buf, ci->clipped);
    VkResult r = webx_call(WEBX_CMD_CREATE_SWAPCHAIN, buf.data, (uint32_t)buf.len, NULL, NULL);
    webx_buf_free(&buf);
    if (r == VK_SUCCESS) *out = (VkSwapchainKHR)(uintptr_t)h;
    return r;
}

VKAPI_ATTR void VKAPI_CALL
webx_DestroySwapchainKHR(VkDevice dev, VkSwapchainKHR sc,
                           const VkAllocationCallbacks *alloc) {
    uint64_t h = (uint64_t)(uintptr_t)sc;
    webx_send(WEBX_CMD_DESTROY_SWAPCHAIN, &h, 8);
}

VKAPI_ATTR VkResult VKAPI_CALL
webx_GetSwapchainImagesKHR(VkDevice dev, VkSwapchainKHR sc,
                            uint32_t *count, VkImage *images) {
    WebXBuf buf; webx_buf_init(&buf);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)dev);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)sc);
    uint8_t *data; uint32_t len;
    VkResult r = webx_call(WEBX_CMD_GET_SWAPCHAIN_IMAGES,
                            buf.data, (uint32_t)buf.len, &data, &len);
    webx_buf_free(&buf);
    if (r != VK_SUCCESS) { free(data); return r; }

    uint32_t host_count = len / 8;
    if (!images) { *count = host_count; free(data); return VK_SUCCESS; }
    uint32_t n = *count < host_count ? *count : host_count;
    uint64_t *handles = (uint64_t *)data;
    for (uint32_t i = 0; i < n; i++)
        images[i] = (VkImage)(uintptr_t)handles[i];
    *count = n;
    free(data);
    return n < host_count ? VK_INCOMPLETE : VK_SUCCESS;
}

VKAPI_ATTR VkResult VKAPI_CALL
webx_AcquireNextImageKHR(VkDevice dev, VkSwapchainKHR sc, uint64_t timeout,
                          VkSemaphore sem, VkFence fence, uint32_t *imageIndex) {
    WebXBuf buf; webx_buf_init(&buf);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)dev);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)sc);
    webx_buf_push_u64(&buf, timeout);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)sem);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)fence);
    uint8_t *data; uint32_t len;
    VkResult r = webx_call(WEBX_CMD_ACQUIRE_NEXT_IMAGE,
                            buf.data, (uint32_t)buf.len, &data, &len);
    webx_buf_free(&buf);
    if (r == VK_SUCCESS && len >= 4)
        *imageIndex = *(uint32_t *)data;
    else
        *imageIndex = 0;
    free(data);
    return r;
}

/* ── Physical device surface properties (KHR_get_physical_device_properties2) */

VKAPI_ATTR void VKAPI_CALL
webx_GetPhysicalDeviceProperties2(VkPhysicalDevice pd,
                                   VkPhysicalDeviceProperties2 *props) {
    /* Delegate to the base query; we don't have extended properties yet */
    extern __attribute__((visibility("hidden"))) void webx_GetPhysicalDeviceProperties(VkPhysicalDevice, VkPhysicalDeviceProperties *);
    webx_GetPhysicalDeviceProperties(pd, &props->properties);
}

VKAPI_ATTR void VKAPI_CALL
webx_GetPhysicalDeviceFeatures2(VkPhysicalDevice pd,
                                 VkPhysicalDeviceFeatures2 *feats) {
    extern __attribute__((visibility("hidden"))) void webx_GetPhysicalDeviceFeatures(VkPhysicalDevice, VkPhysicalDeviceFeatures *);
    webx_GetPhysicalDeviceFeatures(pd, &feats->features);
}

VKAPI_ATTR void VKAPI_CALL
webx_GetPhysicalDeviceMemoryProperties2(VkPhysicalDevice pd,
                                         VkPhysicalDeviceMemoryProperties2 *props) {
    extern __attribute__((visibility("hidden"))) void webx_GetPhysicalDeviceMemoryProperties(VkPhysicalDevice,
                                                        VkPhysicalDeviceMemoryProperties *);
    webx_GetPhysicalDeviceMemoryProperties(pd, &props->memoryProperties);
}

VKAPI_ATTR void VKAPI_CALL
webx_GetPhysicalDeviceFormatProperties(VkPhysicalDevice pd, VkFormat fmt,
                                        VkFormatProperties *props) {
    /* Report broad support — host validates against real WebGPU capabilities */
    props->linearTilingFeatures  = VK_FORMAT_FEATURE_SAMPLED_IMAGE_BIT
                                 | VK_FORMAT_FEATURE_STORAGE_IMAGE_BIT
                                 | VK_FORMAT_FEATURE_COLOR_ATTACHMENT_BIT
                                 | VK_FORMAT_FEATURE_DEPTH_STENCIL_ATTACHMENT_BIT
                                 | VK_FORMAT_FEATURE_TRANSFER_SRC_BIT
                                 | VK_FORMAT_FEATURE_TRANSFER_DST_BIT;
    props->optimalTilingFeatures = props->linearTilingFeatures;
    props->bufferFeatures        = VK_FORMAT_FEATURE_VERTEX_BUFFER_BIT
                                 | VK_FORMAT_FEATURE_UNIFORM_TEXEL_BUFFER_BIT;
}
