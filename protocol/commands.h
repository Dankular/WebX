#pragma once
/*
 * WebX Vulkan Wire Protocol
 * Shared between guest ICD (x86 Linux) and host JS bridge.
 *
 * Binary layout (little-endian):
 *
 *   [WebXPacketHeader][payload bytes]
 *
 * For commands that return data, the guest blocks on read() after write().
 * The host writes back a [WebXResponseHeader][response payload].
 */

#include <stdint.h>

/* ── Packet framing ──────────────────────────────────────────────────── */

#define WEBX_MAGIC 0x58574756u  /* "VGWX" */

typedef struct {
    uint32_t magic;    /* WEBX_MAGIC — sanity check                */
    uint32_t cmd;      /* VkWebXCmd                                */
    uint32_t seq;      /* sequence number, echoed in response      */
    uint32_t len;      /* payload byte length following this header*/
} WebXPacketHeader;

typedef struct {
    uint32_t seq;      /* matches request sequence number          */
    int32_t  result;   /* VkResult (negative = error)              */
    uint32_t len;      /* response payload byte length             */
} WebXResponseHeader;

/* ── Command IDs ─────────────────────────────────────────────────────── */

typedef enum VkWebXCmd {
    /* Instance */
    WEBX_CMD_CREATE_INSTANCE                    = 0x0001,
    WEBX_CMD_DESTROY_INSTANCE                   = 0x0002,
    WEBX_CMD_ENUMERATE_PHYSICAL_DEVICES         = 0x0003,
    WEBX_CMD_GET_PHYSICAL_DEVICE_PROPERTIES     = 0x0004,
    WEBX_CMD_GET_PHYSICAL_DEVICE_FEATURES       = 0x0005,
    WEBX_CMD_GET_PHYSICAL_DEVICE_QUEUE_FAMILY   = 0x0006,
    WEBX_CMD_GET_PHYSICAL_DEVICE_MEMORY_PROPS   = 0x0007,
    WEBX_CMD_GET_PHYSICAL_DEVICE_FORMAT_PROPS   = 0x0008,

    /* Device */
    WEBX_CMD_CREATE_DEVICE                      = 0x0010,
    WEBX_CMD_DESTROY_DEVICE                     = 0x0011,
    WEBX_CMD_GET_DEVICE_QUEUE                   = 0x0012,
    WEBX_CMD_DEVICE_WAIT_IDLE                   = 0x0013,

    /* Swapchain */
    WEBX_CMD_CREATE_SWAPCHAIN                   = 0x0020,
    WEBX_CMD_DESTROY_SWAPCHAIN                  = 0x0021,
    WEBX_CMD_GET_SWAPCHAIN_IMAGES               = 0x0022,
    WEBX_CMD_ACQUIRE_NEXT_IMAGE                 = 0x0023,
    WEBX_CMD_QUEUE_PRESENT                      = 0x0024,

    /* Memory */
    WEBX_CMD_ALLOCATE_MEMORY                    = 0x0030,
    WEBX_CMD_FREE_MEMORY                        = 0x0031,
    WEBX_CMD_MAP_MEMORY                         = 0x0032,
    WEBX_CMD_UNMAP_MEMORY                       = 0x0033,
    WEBX_CMD_FLUSH_MAPPED_RANGES                = 0x0034,
    WEBX_CMD_WRITE_MAPPED_DATA                  = 0x0035,  /* bulk data transfer */

    /* Buffers / Images */
    WEBX_CMD_CREATE_BUFFER                      = 0x0040,
    WEBX_CMD_DESTROY_BUFFER                     = 0x0041,
    WEBX_CMD_BIND_BUFFER_MEMORY                 = 0x0042,
    WEBX_CMD_CREATE_IMAGE                       = 0x0043,
    WEBX_CMD_DESTROY_IMAGE                      = 0x0044,
    WEBX_CMD_BIND_IMAGE_MEMORY                  = 0x0045,
    WEBX_CMD_CREATE_IMAGE_VIEW                  = 0x0046,
    WEBX_CMD_DESTROY_IMAGE_VIEW                 = 0x0047,
    WEBX_CMD_CREATE_SAMPLER                     = 0x0048,
    WEBX_CMD_DESTROY_SAMPLER                    = 0x0049,

    /* Pipelines */
    WEBX_CMD_CREATE_SHADER_MODULE               = 0x0050,
    WEBX_CMD_DESTROY_SHADER_MODULE              = 0x0051,
    WEBX_CMD_CREATE_PIPELINE_LAYOUT             = 0x0052,
    WEBX_CMD_DESTROY_PIPELINE_LAYOUT            = 0x0053,
    WEBX_CMD_CREATE_GRAPHICS_PIPELINE           = 0x0054,
    WEBX_CMD_CREATE_COMPUTE_PIPELINE            = 0x0055,
    WEBX_CMD_DESTROY_PIPELINE                   = 0x0056,
    WEBX_CMD_CREATE_RENDER_PASS                 = 0x0057,
    WEBX_CMD_DESTROY_RENDER_PASS                = 0x0058,
    WEBX_CMD_CREATE_FRAMEBUFFER                 = 0x0059,
    WEBX_CMD_DESTROY_FRAMEBUFFER                = 0x005A,

    /* Descriptors */
    WEBX_CMD_CREATE_DESCRIPTOR_SET_LAYOUT       = 0x0060,
    WEBX_CMD_DESTROY_DESCRIPTOR_SET_LAYOUT      = 0x0061,
    WEBX_CMD_CREATE_DESCRIPTOR_POOL             = 0x0062,
    WEBX_CMD_RESET_DESCRIPTOR_POOL              = 0x0063,
    WEBX_CMD_ALLOCATE_DESCRIPTOR_SETS           = 0x0064,
    WEBX_CMD_UPDATE_DESCRIPTOR_SETS             = 0x0065,

    /* Command buffers */
    WEBX_CMD_CREATE_COMMAND_POOL                = 0x0070,
    WEBX_CMD_DESTROY_COMMAND_POOL               = 0x0071,
    WEBX_CMD_RESET_COMMAND_POOL                 = 0x0072,
    WEBX_CMD_ALLOCATE_COMMAND_BUFFERS           = 0x0073,
    WEBX_CMD_FREE_COMMAND_BUFFERS               = 0x0074,
    WEBX_CMD_BEGIN_COMMAND_BUFFER               = 0x0075,
    WEBX_CMD_END_COMMAND_BUFFER                 = 0x0076,
    WEBX_CMD_RESET_COMMAND_BUFFER               = 0x0077,

    /* Draw / dispatch commands (recorded into command buffers) */
    WEBX_CMD_CMD_BEGIN_RENDER_PASS              = 0x0080,
    WEBX_CMD_CMD_END_RENDER_PASS                = 0x0081,
    WEBX_CMD_CMD_NEXT_SUBPASS                   = 0x0082,
    WEBX_CMD_CMD_BEGIN_RENDERING                = 0x0083,  /* dynamic rendering */
    WEBX_CMD_CMD_END_RENDERING                  = 0x0084,
    WEBX_CMD_CMD_BIND_PIPELINE                  = 0x0085,
    WEBX_CMD_CMD_BIND_VERTEX_BUFFERS            = 0x0086,
    WEBX_CMD_CMD_BIND_INDEX_BUFFER              = 0x0087,
    WEBX_CMD_CMD_BIND_DESCRIPTOR_SETS          = 0x0088,
    WEBX_CMD_CMD_PUSH_CONSTANTS                 = 0x0089,
    WEBX_CMD_CMD_DRAW                           = 0x008A,
    WEBX_CMD_CMD_DRAW_INDEXED                   = 0x008B,
    WEBX_CMD_CMD_DRAW_INDIRECT                  = 0x008C,
    WEBX_CMD_CMD_DRAW_INDEXED_INDIRECT          = 0x008D,
    WEBX_CMD_CMD_DISPATCH                       = 0x008E,
    WEBX_CMD_CMD_DISPATCH_INDIRECT              = 0x008F,
    WEBX_CMD_CMD_SET_VIEWPORT                   = 0x0090,
    WEBX_CMD_CMD_SET_SCISSOR                    = 0x0091,
    WEBX_CMD_CMD_SET_BLEND_CONSTANTS            = 0x0092,
    WEBX_CMD_CMD_SET_STENCIL_REFERENCE          = 0x0093,
    WEBX_CMD_CMD_SET_DEPTH_BIAS                 = 0x0094,
    WEBX_CMD_CMD_SET_LINE_WIDTH                 = 0x0095,
    WEBX_CMD_CMD_SET_CULL_MODE                  = 0x0096,
    WEBX_CMD_CMD_SET_FRONT_FACE                 = 0x0097,
    WEBX_CMD_CMD_SET_PRIMITIVE_TOPOLOGY         = 0x0098,
    WEBX_CMD_CMD_PIPELINE_BARRIER               = 0x0099,
    WEBX_CMD_CMD_COPY_BUFFER                    = 0x009A,
    WEBX_CMD_CMD_COPY_BUFFER_TO_IMAGE           = 0x009B,
    WEBX_CMD_CMD_COPY_IMAGE_TO_BUFFER           = 0x009C,
    WEBX_CMD_CMD_COPY_IMAGE                     = 0x009D,
    WEBX_CMD_CMD_BLIT_IMAGE                     = 0x009E,
    WEBX_CMD_CMD_CLEAR_COLOR_IMAGE              = 0x009F,
    WEBX_CMD_CMD_CLEAR_DEPTH_STENCIL_IMAGE      = 0x00A0,
    WEBX_CMD_CMD_CLEAR_ATTACHMENTS              = 0x00A1,
    WEBX_CMD_CMD_FILL_BUFFER                    = 0x00A2,
    WEBX_CMD_CMD_UPDATE_BUFFER                  = 0x00A3,
    WEBX_CMD_CMD_EXECUTE_COMMANDS               = 0x00A4,

    /* Queue submission + sync */
    WEBX_CMD_QUEUE_SUBMIT                       = 0x00B0,
    WEBX_CMD_QUEUE_WAIT_IDLE                    = 0x00B1,
    WEBX_CMD_CREATE_FENCE                       = 0x00B2,
    WEBX_CMD_DESTROY_FENCE                      = 0x00B3,
    WEBX_CMD_WAIT_FOR_FENCES                    = 0x00B4,
    WEBX_CMD_RESET_FENCES                       = 0x00B5,
    WEBX_CMD_GET_FENCE_STATUS                   = 0x00B6,
    WEBX_CMD_CREATE_SEMAPHORE                   = 0x00B7,
    WEBX_CMD_DESTROY_SEMAPHORE                  = 0x00B8,

    /* Extension queries */
    WEBX_CMD_ENUMERATE_INSTANCE_EXTENSIONS      = 0x00C0,
    WEBX_CMD_ENUMERATE_DEVICE_EXTENSIONS        = 0x00C1,
    WEBX_CMD_ENUMERATE_INSTANCE_LAYERS          = 0x00C2,
} VkWebXCmd;

/* ── Handle type tag ─────────────────────────────────────────────────── */

/*
 * Vulkan handles are 64-bit opaque values. The guest sends them as-is;
 * the host maps guest handle values to its own internal handle table.
 */
typedef uint64_t WebXHandle;

/* ── Surface capability packet ───────────────────────────────────────── */
/* Sent host→guest after WEBX_CMD_CREATE_INSTANCE succeeds               */
typedef struct {
    uint32_t canvas_width;
    uint32_t canvas_height;
    uint32_t swapchain_image_count;  /* 2 or 3 */
    uint32_t surface_format;         /* VkFormat */
    uint32_t color_space;            /* VkColorSpaceKHR */
    uint32_t present_mode;           /* VkPresentModeKHR */
} WebXSurfaceCaps;
