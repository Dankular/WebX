/**
 * VkWebGPU-ICD Host Plugin
 *
 * Real WebGPU implementation that receives the Vulkan command stream from the
 * Canary guest via vk-bridge.mjs and replays it against the browser WebGPU API.
 *
 * Interface contract:
 *   initialize(adapter, device, canvas) → Promise<void>
 *   dispatch(cmd, seq, payload)         → { result: number, data: Uint8Array }
 *   destroy()                           → void
 *
 * ## Binary formats
 *
 * All data from the guest is little-endian.  Vulkan handles are u64 (BigInt).
 * QUEUE_SUBMIT payload:
 *   [cmd_count: u32]
 *   For each inner command:
 *     [opcode: u32][payload_len: u32][payload: payload_len bytes]
 *
 * See protocol/commands.h and VkWebGPU-ICD/vkwebgpu/src/webx_serialize.rs.
 */

// ── Vulkan result codes ────────────────────────────────────────────────────────
const VK_SUCCESS          = 0;
const VK_ERROR_DEVICE_LOST = -4;

// ── GPUBufferUsage numeric flags (stable across browsers) ─────────────────────
const BU_COPY_SRC  = 0x0004;
const BU_COPY_DST  = 0x0008;
const BU_INDEX     = 0x0010;
const BU_VERTEX    = 0x0020;
const BU_UNIFORM   = 0x0040;
const BU_STORAGE   = 0x0080;
const BU_INDIRECT  = 0x0100;

// ── GPUTextureUsage numeric flags ─────────────────────────────────────────────
const TU_COPY_SRC      = 0x01;
const TU_COPY_DST      = 0x02;
const TU_TEXTURE_BIND  = 0x04;
const TU_STORAGE_BIND  = 0x08;
const TU_RENDER_ATTACH = 0x10;

// ── Frame-command opcodes (WEBX_CMD_CMD_* from protocol/commands.h) ───────────
const FC_BEGIN_RENDER_PASS       = 0x0080;
const FC_END_RENDER_PASS         = 0x0081;
const FC_NEXT_SUBPASS            = 0x0082;
const FC_BEGIN_RENDERING         = 0x0083;
const FC_END_RENDERING           = 0x0084;
const FC_BIND_PIPELINE           = 0x0085;
const FC_BIND_VERTEX_BUFFERS     = 0x0086;
const FC_BIND_INDEX_BUFFER       = 0x0087;
const FC_BIND_DESCRIPTOR_SETS    = 0x0088;
const FC_PUSH_CONSTANTS          = 0x0089;
const FC_DRAW                    = 0x008A;
const FC_DRAW_INDEXED            = 0x008B;
const FC_DRAW_INDIRECT           = 0x008C;
const FC_DRAW_INDEXED_INDIRECT   = 0x008D;
const FC_DISPATCH                = 0x008E;
const FC_SET_VIEWPORT            = 0x0090;
const FC_SET_SCISSOR             = 0x0091;
const FC_SET_BLEND_CONSTANTS     = 0x0092;
const FC_SET_STENCIL_REFERENCE   = 0x0093;
const FC_SET_DEPTH_BIAS          = 0x0094;
const FC_SET_LINE_WIDTH          = 0x0095;
const FC_SET_CULL_MODE           = 0x0096;
const FC_SET_FRONT_FACE          = 0x0097;
const FC_SET_PRIMITIVE_TOPOLOGY  = 0x0098;
const FC_PIPELINE_BARRIER        = 0x0099;
const FC_COPY_BUFFER             = 0x009A;
const FC_COPY_BUFFER_TO_IMAGE    = 0x009B;
const FC_COPY_IMAGE_TO_BUFFER    = 0x009C;
const FC_COPY_IMAGE              = 0x009D;
const FC_BLIT_IMAGE              = 0x009E;
const FC_CLEAR_COLOR_IMAGE       = 0x009F;
const FC_CLEAR_DEPTH_STENCIL_IMAGE = 0x00A0;
const FC_CLEAR_ATTACHMENTS       = 0x00A1;
const FC_FILL_BUFFER             = 0x00A2;
const FC_UPDATE_BUFFER           = 0x00A3;
const FC_EXECUTE_COMMANDS        = 0x00A4;
const FC_RESOLVE_IMAGE           = 0x00A5;
const FC_SET_DEPTH_TEST_ENABLE   = 0x00A6;
const FC_SET_DEPTH_WRITE_ENABLE  = 0x00A7;
const FC_SET_DEPTH_COMPARE_OP    = 0x00A8;
const FC_SET_DEPTH_BIAS_ENABLE   = 0x00A9;
const FC_SET_STENCIL_TEST_ENABLE = 0x00AA;
const FC_SET_STENCIL_OP          = 0x00AB;
const FC_SET_DEPTH_BOUNDS        = 0x00AC;
const FC_DISPATCH_BASE           = 0x00AD;

// ── VkFormat → GPUTextureFormat ───────────────────────────────────────────────
// Keyed by raw VkFormat enum values (vulkan_core.h).
const VK_FORMAT_MAP = {
    // R8
    9:   'r8unorm',           // VK_FORMAT_R8_UNORM
    10:  'r8snorm',           // VK_FORMAT_R8_SNORM
    13:  'r8uint',            // VK_FORMAT_R8_UINT
    14:  'r8sint',            // VK_FORMAT_R8_SINT
    // R8G8
    16:  'rg8unorm',          // VK_FORMAT_R8G8_UNORM
    17:  'rg8snorm',          // VK_FORMAT_R8G8_SNORM
    20:  'rg8uint',           // VK_FORMAT_R8G8_UINT
    21:  'rg8sint',           // VK_FORMAT_R8G8_SINT
    // R8G8B8A8
    37:  'rgba8unorm',        // VK_FORMAT_R8G8B8A8_UNORM
    38:  'rgba8snorm',        // VK_FORMAT_R8G8B8A8_SNORM
    41:  'rgba8uint',         // VK_FORMAT_R8G8B8A8_UINT
    42:  'rgba8sint',         // VK_FORMAT_R8G8B8A8_SINT
    43:  'rgba8unorm-srgb',   // VK_FORMAT_R8G8B8A8_SRGB
    // B8G8R8A8
    44:  'bgra8unorm',        // VK_FORMAT_B8G8R8A8_UNORM
    50:  'bgra8unorm-srgb',   // VK_FORMAT_B8G8R8A8_SRGB
    // Packed 10-bit
    64:  'rgb10a2unorm',      // VK_FORMAT_A2B10G10R10_UNORM_PACK32
    68:  'rgb10a2uint',       // VK_FORMAT_A2B10G10R10_UINT_PACK32
    // R16
    74:  'r16uint',           // VK_FORMAT_R16_UINT
    75:  'r16sint',           // VK_FORMAT_R16_SINT
    76:  'r16float',          // VK_FORMAT_R16_SFLOAT
    // R16G16
    81:  'rg16uint',          // VK_FORMAT_R16G16_UINT
    82:  'rg16sint',          // VK_FORMAT_R16G16_SINT
    83:  'rg16float',         // VK_FORMAT_R16G16_SFLOAT  ← DXVK heavy use
    // R16G16B16A16
    91:  'rgba16unorm',       // VK_FORMAT_R16G16B16A16_UNORM  (requires 16bit-norm feature)
    95:  'rgba16uint',        // VK_FORMAT_R16G16B16A16_UINT
    96:  'rgba16sint',        // VK_FORMAT_R16G16B16A16_SINT
    97:  'rgba16float',       // VK_FORMAT_R16G16B16A16_SFLOAT  ← DXVK render targets
    // R32
    98:  'r32uint',           // VK_FORMAT_R32_UINT
    99:  'r32sint',           // VK_FORMAT_R32_SINT
    100: 'r32float',          // VK_FORMAT_R32_SFLOAT
    // R32G32
    101: 'rg32uint',          // VK_FORMAT_R32G32_UINT
    102: 'rg32sint',          // VK_FORMAT_R32G32_SINT
    103: 'rg32float',         // VK_FORMAT_R32G32_SFLOAT
    // R32G32B32A32
    107: 'rgba32uint',        // VK_FORMAT_R32G32B32A32_UINT
    108: 'rgba32sint',        // VK_FORMAT_R32G32B32A32_SINT
    109: 'rgba32float',       // VK_FORMAT_R32G32B32A32_SFLOAT
    // Packed float
    122: 'rg11b10ufloat',     // VK_FORMAT_B10G11R11_UFLOAT_PACK32
    // Depth / Stencil
    124: 'depth16unorm',      // VK_FORMAT_D16_UNORM
    125: 'depth24plus',       // VK_FORMAT_X8_D24_UNORM_PACK32
    126: 'depth32float',      // VK_FORMAT_D32_SFLOAT
    127: 'stencil8',          // VK_FORMAT_S8_UINT
    129: 'depth24plus-stencil8',      // VK_FORMAT_D24_UNORM_S8_UINT
    130: 'depth32float-stencil8',     // VK_FORMAT_D32_SFLOAT_S8_UINT
    // BC compressed (require 'texture-compression-bc' feature)
    131: 'bc1-rgba-unorm',    // VK_FORMAT_BC1_RGB_UNORM_BLOCK
    132: 'bc1-rgba-unorm-srgb',
    133: 'bc1-rgba-unorm',    // VK_FORMAT_BC1_RGBA_UNORM_BLOCK
    134: 'bc1-rgba-unorm-srgb',
    135: 'bc2-rgba-unorm',    // VK_FORMAT_BC2_UNORM_BLOCK
    136: 'bc2-rgba-unorm-srgb',
    137: 'bc3-rgba-unorm',    // VK_FORMAT_BC3_UNORM_BLOCK
    138: 'bc3-rgba-unorm-srgb',
    139: 'bc4-r-unorm',       // VK_FORMAT_BC4_UNORM_BLOCK
    140: 'bc4-r-snorm',
    141: 'bc5-rg-unorm',      // VK_FORMAT_BC5_UNORM_BLOCK
    142: 'bc5-rg-snorm',
    143: 'bc6h-rgb-ufloat',   // VK_FORMAT_BC6H_UFLOAT_BLOCK
    144: 'bc6h-rgb-float',    // VK_FORMAT_BC6H_SFLOAT_BLOCK
    145: 'bc7-rgba-unorm',    // VK_FORMAT_BC7_UNORM_BLOCK
    146: 'bc7-rgba-unorm-srgb',
};

// ── VkAttachmentLoadOp / VkAttachmentStoreOp ──────────────────────────────────
const VK_LOAD_OP  = { 0: 'load',  1: 'clear',   2: 'load'    }; // DONT_CARE→load
const VK_STORE_OP = { 0: 'store', 1: 'discard'               };

// ── VkIndexType ───────────────────────────────────────────────────────────────
const VK_INDEX_TYPE = { 0: 'uint16', 1: 'uint32' };

// ── VkPipelineBindPoint ───────────────────────────────────────────────────────
const VK_BIND_GRAPHICS = 0;
const VK_BIND_COMPUTE  = 1;

// ── VkSamplerAddressMode → GPUAddressMode ────────────────────────────────────
const VK_ADDR_MODE = { 0: 'repeat', 1: 'mirror-repeat', 2: 'clamp-to-edge', 3: 'clamp-to-edge', 4: 'clamp-to-edge' };
const VK_FILTER    = { 0: 'nearest', 1: 'linear' };
const VK_MIPMAP    = { 0: 'nearest', 1: 'linear' };

// ── VkBlendFactor → GPUBlendFactor ───────────────────────────────────────────
const VK_BLEND_FACTOR = {
    0: 'zero', 1: 'one',
    2: 'src',  3: 'one-minus-src',
    4: 'dst',  5: 'one-minus-dst',
    6: 'src-alpha',  7: 'one-minus-src-alpha',
    8: 'dst-alpha',  9: 'one-minus-dst-alpha',
    10: 'constant',  11: 'one-minus-constant',
};

// ── VkBlendOp → GPUBlendOperation ────────────────────────────────────────────
const VK_BLEND_OP = { 0: 'add', 1: 'subtract', 2: 'reverse-subtract', 3: 'min', 4: 'max' };

// ── VkCompareOp → GPUCompareFunction ─────────────────────────────────────────
const VK_COMPARE_OP = {
    0: 'never',   1: 'less',          2: 'equal',
    3: 'less-equal', 4: 'greater',    5: 'not-equal',
    6: 'greater-equal', 7: 'always',
};

// ── VkPrimitiveTopology → GPUPrimitiveTopology ───────────────────────────────
const VK_TOPOLOGY = {
    0: 'point-list', 1: 'line-list', 2: 'line-strip',
    3: 'triangle-list', 4: 'triangle-strip',
};

// ── VkCullModeFlags → GPUCullMode ─────────────────────────────────────────────
const VK_CULL_MODE = { 0: undefined, 1: 'front', 2: 'back', 3: undefined };

// ── VkFrontFace → GPUFrontFace ───────────────────────────────────────────────
const VK_FRONT_FACE = { 0: 'ccw', 1: 'cw' };

// ── VkFormat (vertex subset) → GPUVertexFormat ───────────────────────────────
const VK_VERTEX_FORMAT = {
    // R32_{UINT,SINT,SFLOAT} = 98,99,100
    98: 'uint32', 99: 'sint32', 100: 'float32',
    // R32G32_{UINT,SINT,SFLOAT} = 101,102,103
    101: 'uint32x2', 102: 'sint32x2', 103: 'float32x2',
    // R32G32B32_{UINT,SINT,SFLOAT} = 104,105,106
    104: 'uint32x3', 105: 'sint32x3', 106: 'float32x3',
    // R32G32B32A32_{UINT,SINT,SFLOAT} = 107,108,109
    107: 'uint32x4', 108: 'sint32x4', 109: 'float32x4',
    // R16G16_{UINT,SINT} = 77,79
    77: 'uint16x2', 79: 'sint16x2',
    // R16G16B16A16_{UINT,SINT} = 83,85
    83: 'uint16x4', 85: 'sint16x4',
    // R8G8_{UINT,SINT} = 19,21
    19: 'uint8x2', 21: 'sint8x2',
    // R8G8B8A8_{UINT,SINT} = 32,34
    32: 'uint8x4', 34: 'sint8x4',
};

// ── VkBufferUsageFlags → GPUBufferUsage ───────────────────────────────────────
function vkBufUsage(vk) {
    let u = BU_COPY_SRC | BU_COPY_DST; // always include for staging
    if (vk & 0x0004) u |= BU_UNIFORM;   // UNIFORM_TEXEL_BUFFER
    if (vk & 0x0008) u |= BU_STORAGE;   // STORAGE_TEXEL_BUFFER
    if (vk & 0x0010) u |= BU_UNIFORM;   // UNIFORM_BUFFER
    if (vk & 0x0020) u |= BU_STORAGE;   // STORAGE_BUFFER
    if (vk & 0x0040) u |= BU_INDEX;     // INDEX_BUFFER
    if (vk & 0x0080) u |= BU_VERTEX;    // VERTEX_BUFFER
    if (vk & 0x0100) u |= BU_INDIRECT;  // INDIRECT_BUFFER
    return u;
}

// ── VkImageUsageFlags → GPUTextureUsage ──────────────────────────────────────
function vkImgUsage(vk) {
    let u = TU_COPY_SRC | TU_COPY_DST;
    if (vk & 0x0004) u |= TU_TEXTURE_BIND;  // SAMPLED
    if (vk & 0x0008) u |= TU_STORAGE_BIND;  // STORAGE
    if (vk & 0x0010) u |= TU_RENDER_ATTACH; // COLOR_ATTACHMENT
    if (vk & 0x0020) u |= TU_RENDER_ATTACH; // DEPTH_STENCIL_ATTACHMENT
    return u;
}

// ── VkAspectFlags → GPUTextureAspect ─────────────────────────────────────────
function vkAspect(mask) {
    if (mask === 0x2) return 'depth-only';
    if (mask === 0x4) return 'stencil-only';
    return 'all';
}

// ── VkShaderStageFlags → GPUShaderStage bitmask ───────────────────────────────
// VERTEX=1, FRAGMENT=0x10, COMPUTE=0x20; GPUShaderStage: V=1, F=2, C=4
function vkShaderStages(vk) {
    let s = 0;
    if (vk & 0x1)  s |= 1; // VERTEX
    if (vk & 0x10) s |= 2; // FRAGMENT
    if (vk & 0x20) s |= 4; // COMPUTE
    return s || 7; // fallback: all stages
}

// ── VkDescriptorType → GPUBindGroupLayoutEntry ────────────────────────────────
function vkBglEntry(binding, dtype, count, visibility) {
    switch (dtype) {
    case 0:  // SAMPLER
        return { binding, visibility, sampler: { type: 'filtering' } };
    case 1:  // COMBINED_IMAGE_SAMPLER → texture part (sampler added separately)
    case 2:  // SAMPLED_IMAGE
    case 10: // INPUT_ATTACHMENT
        return { binding, visibility, texture: { sampleType: 'float', viewDimension: '2d', multisampled: false } };
    case 3:  // STORAGE_IMAGE
        return { binding, visibility, storageTexture: { access: 'write-only', format: 'rgba8unorm', viewDimension: '2d' } };
    case 4:  // UNIFORM_TEXEL_BUFFER (treat as uniform)
    case 6:  // UNIFORM_BUFFER
        return { binding, visibility, buffer: { type: 'uniform' } };
    case 8:  // UNIFORM_BUFFER_DYNAMIC
        return { binding, visibility, buffer: { type: 'uniform', hasDynamicOffset: true } };
    case 5:  // STORAGE_TEXEL_BUFFER
    case 7:  // STORAGE_BUFFER
        return { binding, visibility, buffer: { type: 'storage', readOnly: false } };
    case 9:  // STORAGE_BUFFER_DYNAMIC
        return { binding, visibility, buffer: { type: 'storage', readOnly: false, hasDynamicOffset: true } };
    default:
        return { binding, visibility, buffer: { type: 'uniform' } };
    }
}

// =============================================================================
// VkWebGPUPlugin
// =============================================================================

export class VkWebGPUPlugin {
    /** @type {GPUAdapter}       */ #adapter = null;
    /** @type {GPUDevice}        */ #device  = null;
    /** @type {HTMLCanvasElement}*/ #canvas  = null;
    /** @type {GPUCanvasContext} */ #ctx     = null;
    /** @type {string}           */ #canvasFormat = 'bgra8unorm';

    // ── Resource maps (guest handle bigint → host descriptor) ─────────────────
    #renderPasses    = new Map(); // handle → { attachments[] }
    #framebuffers    = new Map(); // handle → { rpHandle, width, height, views[] }
    #images          = new Map(); // handle → { texture, format, width, height, isSwapchain }
    #imageViews      = new Map(); // handle → { view, format }
    #buffers         = new Map(); // handle → { gpuBuffer, size, memHandle }
    #memories        = new Map(); // handle → { size, memType }
    #shaderModules   = new Map(); // handle → { spirv, gpuModule }
    #pipelineLayouts = new Map(); // handle → { setLayouts }
    #pipelines       = new Map(); // handle → { type, gpuPipeline }
    #descSetLayouts  = new Map(); // handle → { bindings }
    #descPools       = new Map(); // handle → {}
    #descSets        = new Map(); // handle → { layoutHandle, gpuBindGroup }
    #samplers        = new Map(); // handle → GPUSampler

    // ── Swapchain state ───────────────────────────────────────────────────────
    #swapImages      = [];        // GPUTexture[] for each swapchain image
    #swapFormat      = 'bgra8unorm';
    #swapIndex       = 0;

    // ── Extended dynamic state ────────────────────────────────────────────────
    // Tracks state set by FC_SET_* commands (VK_EXT_extended_dynamic_state).
    #dynState = { cullMode: 0, frontFace: 0, topology: 3,
                  depthTestEnable: 0, depthWriteEnable: 0, depthCompareOp: 1,
                  stencilTestEnable: 0, depthBiasEnable: 0 };
    #dynDirty  = false;                // true when state changed since last setPipeline
    #boundPipeH = null;               // handle of currently bound graphics pipeline
    #pipelineCreateInfos = new Map(); // handle → GPURenderPipelineDescriptor (sans dynamic parts)
    #pipelineVariants    = new Map(); // variantKey → GPURenderPipeline

    // ── Blit pipeline (for FC_BLIT_IMAGE scaled copies) ───────────────────────
    #blitBGL       = null;            // BindGroupLayout: texture2d + sampler
    #blitSampler   = null;            // GPUSampler (linear, clamp)
    #blitPipelines = new Map();       // dstFormat → GPURenderPipeline
    #blitShaderMod = null;            // shared vertex+fragment shader module

    // ── Push constant staging buffer (256 bytes max) ──────────────────────────
    #pushConstData   = new Uint8Array(256);
    #pushConstBGL    = null;  // GPUBindGroupLayout for the 256-byte push-constant UBO
    #pushConstBuffer = null;  // GPUBuffer (256 bytes, UNIFORM|COPY_DST)
    #pushConstBG     = null;  // GPUBindGroup

    // ── Host-side handle allocator (only used for pre-resource-creation bootstrap) ─
    #nextHandle      = 0x0001_0000n;

    // =========================================================================
    async initialize(adapter, device, canvas) {
        this.#adapter      = adapter;
        this.#device       = device;
        this.#canvas       = canvas;
        this.#ctx          = canvas.getContext('webgpu');
        this.#canvasFormat = navigator.gpu.getPreferredCanvasFormat();
        this.#ctx.configure({ device, format: this.#canvasFormat, alphaMode: 'opaque' });

        // Push-constant resources: a 256-byte uniform buffer bound at group=0, binding=0.
        // Pipelines with push constants prepend this BGL before user descriptor-set BGLs.
        this.#pushConstBGL = device.createBindGroupLayout({
            label: 'push-const-bgl',
            entries: [{ binding: 0, visibility: 7 /* V|F|C */, buffer: { type: 'uniform' } }],
        });
        this.#pushConstBuffer = device.createBuffer({
            size: 256, usage: BU_UNIFORM | BU_COPY_DST, label: 'push-const',
        });
        this.#pushConstBG = device.createBindGroup({
            label: 'push-const-bg', layout: this.#pushConstBGL,
            entries: [{ binding: 0, resource: { buffer: this.#pushConstBuffer } }],
        });

        // Blit pipeline resources — shared across all blit operations.
        this.#blitBGL = device.createBindGroupLayout({
            label: 'blit-bgl',
            entries: [
                { binding: 0, visibility: 2, texture: { sampleType: 'float', viewDimension: '2d' } },
                { binding: 1, visibility: 2, sampler: { type: 'filtering' } },
            ],
        });
        this.#blitSampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
        this.#blitShaderMod = device.createShaderModule({
            label: 'blit-shader',
            code: `
@group(0) @binding(0) var srcTex : texture_2d<f32>;
@group(0) @binding(1) var srcSamp: sampler;
struct VSOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
    var pos = array<vec2f,3>(vec2f(-1.0,-1.0), vec2f(3.0,-1.0), vec2f(-1.0, 3.0));
    var uv  = array<vec2f,3>(vec2f( 0.0, 1.0), vec2f(2.0,  1.0), vec2f( 0.0,-1.0));
    return VSOut(vec4f(pos[vi], 0.0, 1.0), uv[vi]);
}
@fragment fn fs_main(in: VSOut) -> @location(0) vec4f {
    return textureSample(srcTex, srcSamp, in.uv);
}`,
        });

        console.log('[VkWebGPUPlugin] initialized —', adapter.info?.description ?? '(no description)');
    }

    dispatch(cmd, seq, payload) {
        const v = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
        try {
            return this.#handle(cmd, v, payload);
        } catch (err) {
            console.error(`[VkWebGPUPlugin] cmd=0x${cmd.toString(16).padStart(4,'0')} threw:`, err);
            return { result: VK_ERROR_DEVICE_LOST, data: new Uint8Array(0) };
        }
    }

    destroy() {
        for (const bi of this.#buffers.values())  bi.gpuBuffer?.destroy();
        for (const ii of this.#images.values())   if (!ii.isSwapchain) ii.texture?.destroy();
        for (const t  of this.#swapImages)        t.destroy();
        this.#swapImages = [];
        this.#ctx        = null;
    }

    // =========================================================================
    // Top-level command dispatch
    // =========================================================================

    #handle(cmd, v, payload) {
        switch (cmd) {
            // Instance
            case 0x0001: return this.#createInstance();
            case 0x0002: return ok();
            case 0x0003: return this.#enumPhysDevices();
            case 0x0004: return this.#getPhysDevProps();
            case 0x0005: return this.#getPhysDevFeatures();
            case 0x0006: return this.#getPhysDevQueueFamily();
            case 0x0007: return this.#getPhysDevMemProps();
            case 0x0008: return ok();
            // Device
            case 0x0010: return this.#createDevice();
            case 0x0011: return ok();
            case 0x0012: return ok();
            case 0x0013: return ok();
            // Swapchain
            case 0x0020: return this.#createSwapchain(v);
            case 0x0021: return ok();
            case 0x0022: return this.#getSwapchainImages();
            case 0x0023: return this.#acquireNextImage();
            case 0x0024: return this.#queuePresent();
            // Memory
            case 0x0030: return this.#allocateMemory(v);
            case 0x0031: return ok();
            case 0x0032: return ok();
            case 0x0033: return ok();
            case 0x0034: return ok();
            case 0x0035: return this.#writeMappedData(v, payload);
            // Buffers / Images
            case 0x0040: return this.#createBuffer(v);
            case 0x0041: return this.#destroyBuffer(v);
            case 0x0042: return ok();
            case 0x0043: return this.#createImage(v);
            case 0x0044: return this.#destroyImage(v);
            case 0x0045: return ok();
            case 0x0046: return this.#createImageView(v);
            case 0x0047: return this.#destroyImageView(v);
            case 0x0048: return this.#createSampler(v);
            case 0x0049: return this.#destroySampler(v);
            // Pipelines
            case 0x0050: return this.#createShaderModule(v, payload);
            case 0x0051: return this.#destroyShaderModule(v);
            case 0x0052: return this.#createPipelineLayout(v, payload);
            case 0x0053: return ok();
            case 0x0054: return this.#createGraphicsPipeline(v, payload);
            case 0x0055: return this.#createComputePipeline(v, payload);
            case 0x0056: return this.#destroyPipeline(v);
            case 0x0057: return this.#createRenderPass(v, payload);
            case 0x0058: return ok();
            case 0x0059: return this.#createFramebuffer(v, payload);
            case 0x005A: return ok();
            // Descriptors
            case 0x0060: return this.#createDescriptorSetLayout(v, payload);
            case 0x0061: return ok();
            case 0x0062: return this.#createDescriptorPool();
            case 0x0063: return ok();
            case 0x0064: return this.#allocateDescriptorSets(v, payload);
            case 0x0065: return this.#updateDescriptorSets(v, payload);
            // Command pool / buffer (recording is in guest; host just acks)
            case 0x0070: case 0x0071: case 0x0072:
            case 0x0073: case 0x0074: case 0x0075:
            case 0x0076: case 0x0077: return ok();
            // Queue submission
            case 0x00B0: return this.#queueSubmit(v, payload);
            case 0x00B1: return ok();
            // Sync objects — all immediately signaled
            case 0x00B2: case 0x00B3: case 0x00B4:
            case 0x00B5: case 0x00B6: case 0x00B7:
            case 0x00B8: return ok();
            // Extension enumeration
            case 0x00C0: case 0x00C1: case 0x00C2: return ok();
            default:
                console.warn(`[VkWebGPUPlugin] unknown cmd=0x${cmd.toString(16).padStart(4,'0')}`);
                return ok();
        }
    }

    // =========================================================================
    // Instance / Device bootstrap
    // =========================================================================

    #createInstance() {
        // Reply: WebXSurfaceCaps (24 bytes)
        const resp = new Uint8Array(24);
        const rv   = new DataView(resp.buffer);
        rv.setUint32(0,  this.#canvas.width,  true); // canvas_width
        rv.setUint32(4,  this.#canvas.height, true); // canvas_height
        rv.setUint32(8,  2,                   true); // swapchain_image_count
        rv.setUint32(12, 44,                  true); // VK_FORMAT_B8G8R8A8_UNORM
        rv.setUint32(16, 0,                   true); // VK_COLOR_SPACE_SRGB_NONLINEAR_KHR
        rv.setUint32(20, 2,                   true); // VK_PRESENT_MODE_MAILBOX_KHR
        return { result: VK_SUCCESS, data: resp };
    }

    #enumPhysDevices() {
        // count(u32) + handle(u64)
        const resp = new Uint8Array(12);
        const rv   = new DataView(resp.buffer);
        rv.setUint32(0, 1,  true);
        rv.setBigUint64(4, 1n, true);
        return { result: VK_SUCCESS, data: resp };
    }

    #getPhysDevProps() {
        // Simplified VkPhysicalDeviceProperties — enough for common drivers.
        // Layout: apiVersion(4)+driverVersion(4)+vendorID(4)+deviceID(4)+deviceType(4)
        //        +deviceName[256]+pipelineCacheUUID[16]+limits(variable)+sparseProps(20)
        const resp = new Uint8Array(832);
        const rv   = new DataView(resp.buffer);
        rv.setUint32(0,  0x00403000, true); // VK_API_VERSION_1_3
        rv.setUint32(4,  1,          true); // driverVersion
        rv.setUint32(8,  0,          true); // vendorID
        rv.setUint32(12, 1,          true); // deviceID
        rv.setUint32(16, 4,          true); // VIRTUAL_GPU
        const name = 'WebX Virtual GPU (WebGPU)';
        for (let i = 0; i < name.length; i++) resp[20 + i] = name.charCodeAt(i);
        // limits.maxImageDimension2D @ offset 20+256+16 = 292
        rv.setUint32(292, 16384, true);
        // limits.maxUniformBufferRange @ 292+72 = 364
        rv.setUint32(364, 65536, true);
        // limits.minUniformBufferOffsetAlignment @ 292+208 = 500
        rv.setBigUint64(500, 256n, true);
        return { result: VK_SUCCESS, data: resp };
    }

    #getPhysDevFeatures() {
        // VkPhysicalDeviceFeatures: 55 VkBool32 values = 220 bytes
        const resp = new Uint8Array(220);
        const rv   = new DataView(resp.buffer);
        // Enable most features; disable geometry/tessellation shaders (not in WebGPU)
        for (let i = 0; i < 55; i++) rv.setUint32(i * 4, 1, true);
        rv.setUint32(4,  0, true); // tessellationShader
        rv.setUint32(8,  0, true); // geometryShader
        rv.setUint32(24, 0, true); // multiViewport (WebGPU supports 1)
        return { result: VK_SUCCESS, data: resp };
    }

    #getPhysDevQueueFamily() {
        // count(u32) + VkQueueFamilyProperties{flags(u32),count(u32),tsValidBits(u32),granularity(Extent3D=12)}
        const resp = new Uint8Array(4 + 24);
        const rv   = new DataView(resp.buffer);
        rv.setUint32(0,  1,    true); // 1 family
        rv.setUint32(4,  0xF,  true); // GRAPHICS|COMPUTE|TRANSFER|SPARSE
        rv.setUint32(8,  4,    true); // queueCount
        rv.setUint32(12, 0,    true); // timestampValidBits
        rv.setUint32(16, 1,    true); // granularity.width
        rv.setUint32(20, 1,    true); // granularity.height
        rv.setUint32(24, 1,    true); // granularity.depth
        return { result: VK_SUCCESS, data: resp };
    }

    #getPhysDevMemProps() {
        // memTypeCount(u32) + [32]VkMemoryType{propertyFlags(u32)+heapIndex(u32)}
        // + memHeapCount(u32) + [16]VkMemoryHeap{size(u64)+flags(u32)+_pad(u32)}
        const resp = new Uint8Array(4 + 32 * 8 + 4 + 16 * 16);
        const rv   = new DataView(resp.buffer);
        let off = 0;
        rv.setUint32(off, 2, true); off += 4;
        // Type 0: DEVICE_LOCAL|HOST_VISIBLE|HOST_COHERENT
        rv.setUint32(off, 0x7, true); rv.setUint32(off + 4, 0, true); off += 8;
        // Type 1: HOST_VISIBLE|HOST_COHERENT|HOST_CACHED
        rv.setUint32(off, 0xE, true); rv.setUint32(off + 4, 0, true); off += 8;
        off += 30 * 8; // remaining types (zero = not present)
        rv.setUint32(off, 1, true); off += 4; // heapCount
        rv.setBigUint64(off, BigInt(4 * 1024 * 1024 * 1024), true); off += 8; // 4 GB
        rv.setUint32(off, 1, true); // DEVICE_LOCAL
        return { result: VK_SUCCESS, data: resp };
    }

    #createDevice() {
        // Reply: device handle (u64)
        const resp = new Uint8Array(8);
        new DataView(resp.buffer).setBigUint64(0, 2n, true);
        return { result: VK_SUCCESS, data: resp };
    }

    // =========================================================================
    // Swapchain
    // =========================================================================

    #createSwapchain(v) {
        const width      = v.getUint32(0,  true);
        const height     = v.getUint32(4,  true);
        const imageCount = v.getUint32(8,  true);
        const vkFormat   = v.getUint32(12, true);
        this.#swapFormat = VK_FORMAT_MAP[vkFormat] ?? this.#canvasFormat;

        for (const t of this.#swapImages) t.destroy();
        this.#swapImages = [];

        for (let i = 0; i < imageCount; i++) {
            this.#swapImages.push(this.#device.createTexture({
                size:  [width, height, 1],
                format: this.#swapFormat,
                usage:  TU_RENDER_ATTACH | TU_COPY_SRC | TU_COPY_DST | TU_TEXTURE_BIND,
            }));
        }

        return okHandle(3n); // swapchain handle = 3
    }

    #getSwapchainImages() {
        const n    = this.#swapImages.length;
        const resp = new Uint8Array(4 + n * 8);
        const rv   = new DataView(resp.buffer);
        rv.setUint32(0, n, true);
        for (let i = 0; i < n; i++) {
            const h = BigInt(0x100 + i);
            rv.setBigUint64(4 + i * 8, h, true);
            const tex = this.#swapImages[i];
            this.#images.set(h, { texture: tex, format: this.#swapFormat,
                                  width: tex.width, height: tex.height, isSwapchain: true });
        }
        return { result: VK_SUCCESS, data: resp };
    }

    #acquireNextImage() {
        const idx = this.#swapIndex;
        this.#swapIndex = (this.#swapIndex + 1) % Math.max(1, this.#swapImages.length);
        return { result: VK_SUCCESS, data: u32Bytes(idx) };
    }

    #queuePresent() {
        // Blit the most recently rendered swapchain image to the canvas.
        const n   = this.#swapImages.length;
        if (!n || !this.#ctx) return ok();
        const src = this.#swapImages[(this.#swapIndex + n - 1) % n];
        const dst = this.#ctx.getCurrentTexture();
        const enc = this.#device.createCommandEncoder({ label: 'vk-present' });

        if (src.format === dst.format) {
            // Same format — fast path: direct GPU copy.
            enc.copyTextureToTexture(
                { texture: src },
                { texture: dst },
                [Math.min(src.width, dst.width), Math.min(src.height, dst.height), 1],
            );
        } else {
            // Format mismatch (e.g. bgra8unorm swapchain → rgba8unorm canvas on Chrome).
            // Use the shared blit pipeline so the format conversion happens in the shader.
            const blitPipe = this.#getBlitPipeline(dst.format);
            if (blitPipe) {
                const srcView = src.createView();
                const dstView = dst.createView();
                const bg = this.#device.createBindGroup({
                    layout: this.#blitBGL,
                    entries: [
                        { binding: 0, resource: srcView },
                        { binding: 1, resource: this.#blitSampler },
                    ],
                });
                const blitRP = enc.beginRenderPass({
                    colorAttachments: [{ view: dstView, loadOp: 'clear', storeOp: 'store',
                                        clearValue: { r:0,g:0,b:0,a:1 } }],
                });
                blitRP.setPipeline(blitPipe);
                blitRP.setBindGroup(0, bg);
                blitRP.draw(3);
                blitRP.end();
            } else {
                // Blit pipeline not ready yet — fallback copy (may be wrong colour).
                enc.copyTextureToTexture(
                    { texture: src },
                    { texture: dst },
                    [Math.min(src.width, dst.width), Math.min(src.height, dst.height), 1],
                );
            }
        }

        this.#device.queue.submit([enc.finish()]);
        return ok();
    }

    // =========================================================================
    // Memory
    // =========================================================================

    #allocateMemory(v) {
        // payload: handle(u64@0) + size(u64@8) + memTypeIndex(u32@16)
        const h       = v.getBigUint64(0, true);
        const size    = v.getBigUint64(8, true);
        const memType = v.getUint32(16, true);
        this.#memories.set(h, { size, memType });
        return ok();
    }

    #writeMappedData(v, payload) {
        // payload: memHandle(u64)+offset(u64)+dataLen(u32)+data
        const memH    = v.getBigUint64(0, true);
        const memOff  = v.getBigUint64(8, true);
        const dataLen = v.getUint32(16, true);
        const data    = payload.subarray(20, 20 + dataLen);
        for (const bi of this.#buffers.values()) {
            if (bi.memHandle === memH && bi.gpuBuffer) {
                const bufOff = Number(memOff - (bi.memOffset ?? 0n));
                this.#device.queue.writeBuffer(bi.gpuBuffer, Math.max(0, bufOff), data);
                break;
            }
        }
        return ok();
    }

    // =========================================================================
    // Buffers
    // =========================================================================

    #createBuffer(v) {
        // payload: handle(u64@0) + size(u64@8) + vkUsage(u32@16)
        const h       = v.getBigUint64(0, true);
        const size    = v.getBigUint64(8, true);
        const vkUsage = v.getUint32(16, true);
        // Align size to 4 bytes as required by WebGPU.
        const alignedSize = Number((size + 3n) & ~3n);
        let gpuBuffer = null;
        try {
            gpuBuffer = this.#device.createBuffer({ size: Math.max(4, alignedSize), usage: vkBufUsage(vkUsage) });
        } catch (e) {
            console.warn('[VkWebGPUPlugin] createBuffer failed:', e.message);
        }
        this.#buffers.set(h, { gpuBuffer, size });
        return ok();
    }

    #destroyBuffer(v) {
        const h  = v.getBigUint64(0, true);
        const bi = this.#buffers.get(h);
        if (bi) { bi.gpuBuffer?.destroy(); this.#buffers.delete(h); }
        return ok();
    }

    // =========================================================================
    // Images
    // =========================================================================

    #createImage(v) {
        // payload: handle(u64@0)+width(u32@8)+height(u32@12)+depth(u32@16)+vkFmt(u32@20)+vkUsage(u32@24)+mipLevels(u32@28)
        const h       = v.getBigUint64(0,  true);
        const width   = v.getUint32(8,  true);
        const height  = v.getUint32(12, true);
        const depth   = v.getUint32(16, true);
        const vkFmt   = v.getUint32(20, true);
        const vkUsage = v.getUint32(24, true);
        const mips    = v.getUint32(28, true);
        const format  = VK_FORMAT_MAP[vkFmt] ?? 'rgba8unorm';
        let texture   = null;
        try {
            texture = this.#device.createTexture({
                size:          [Math.max(1, width), Math.max(1, height), Math.max(1, depth)],
                format,
                usage:         vkImgUsage(vkUsage),
                mipLevelCount: Math.max(1, mips),
            });
        } catch (e) {
            console.warn(`[VkWebGPUPlugin] createImage (${format} ${width}x${height}) failed:`, e.message);
        }
        this.#images.set(h, { texture, format, width, height });
        return ok();
    }

    #destroyImage(v) {
        const h  = v.getBigUint64(0, true);
        const ii = this.#images.get(h);
        if (ii && !ii.isSwapchain) { ii.texture?.destroy(); this.#images.delete(h); }
        return ok();
    }

    #createImageView(v) {
        // payload: handle(u64@0)+imageHandle(u64@8)+vkFmt(u32@16)+aspectMask(u32@20)+baseMip(u32@24)+levelCount(u32@28)+baseLayer(u32@32)+layerCount(u32@36)
        const h          = v.getBigUint64(0,  true);
        const imgH       = v.getBigUint64(8,  true);
        const vkFmt      = v.getUint32(16, true);
        const aspectMask = v.getUint32(20, true);
        const baseMip    = v.getUint32(24, true);
        const levelCount = v.getUint32(28, true);
        const baseLayer  = v.getUint32(32, true);
        const layerCount = v.getUint32(36, true);
        const ii         = this.#images.get(imgH);
        const format     = VK_FORMAT_MAP[vkFmt] ?? (ii?.format ?? 'rgba8unorm');
        const aspect     = vkAspect(aspectMask);
        let view         = null;
        if (ii?.texture) {
            try {
                view = ii.texture.createView({
                    format,
                    aspect,
                    baseMipLevel:    baseMip,
                    mipLevelCount:   levelCount === 0xFFFFFFFF ? undefined : levelCount,
                    baseArrayLayer:  baseLayer,
                    arrayLayerCount: layerCount === 0xFFFFFFFF ? undefined : layerCount,
                });
            } catch (e) {
                console.warn('[VkWebGPUPlugin] createImageView failed:', e.message);
            }
        }
        this.#imageViews.set(h, { view, format });
        return ok();
    }

    #destroyImageView(v) {
        this.#imageViews.delete(v.getBigUint64(0, true));
        return ok();
    }

    // =========================================================================
    // Samplers
    // =========================================================================

    #createSampler(v) {
        // payload: handle(u64@0)+magFilter(u32@8)+minFilter(u32@12)+mipmapMode(u32@16)
        //          +addrU(u32@20)+addrV(u32@24)+addrW(u32@28)+mipLodBias(f32@32)
        //          +anisotropyEnable(u32@36)+maxAnisotropy(f32@40)
        const h       = v.getBigUint64(0,  true);
        const magF    = v.getUint32(8,  true);
        const minF    = v.getUint32(12, true);
        const mipM    = v.getUint32(16, true);
        const adU     = v.getUint32(20, true);
        const adV     = v.getUint32(24, true);
        const adW     = v.getUint32(28, true);
        const anisoEn = v.getUint32(36, true);
        const maxAniso= v.getFloat32(40, true);
        const sampler = this.#device.createSampler({
            magFilter:    VK_FILTER[magF]    ?? 'linear',
            minFilter:    VK_FILTER[minF]    ?? 'linear',
            mipmapFilter: VK_MIPMAP[mipM]   ?? 'linear',
            addressModeU: VK_ADDR_MODE[adU] ?? 'repeat',
            addressModeV: VK_ADDR_MODE[adV] ?? 'repeat',
            addressModeW: VK_ADDR_MODE[adW] ?? 'repeat',
            maxAnisotropy: anisoEn ? Math.min(maxAniso, 16) : 1,
        });
        this.#samplers.set(h, sampler);
        return ok();
    }

    #destroySampler(v) {
        this.#samplers.delete(v.getBigUint64(0, true));
        return ok();
    }

    // =========================================================================
    // Shaders  (SPIRV stored; WGSL transpilation is a TODO)
    // =========================================================================

    #createShaderModule(v, payload) {
        // payload: handle(u64@0) + wgslLen(u32@8) + wgsl[@12]
        // (Rust guest already translated SPIRV→WGSL via naga)
        const h       = v.getBigUint64(0, true);
        const wgslLen = v.getUint32(8, true);
        const wgsl    = new TextDecoder().decode(payload.subarray(12, 12 + wgslLen));
        let gpuModule = null;
        try {
            gpuModule = this.#device.createShaderModule({ code: wgsl, label: `sm_${h}` });
        } catch (e) {
            console.warn(`[VkWebGPUPlugin] createShaderModule (h=${h}) failed:`, e.message, '\nWGSL:\n', wgsl.slice(0, 300));
        }
        this.#shaderModules.set(h, { gpuModule });
        return ok();
    }

    #destroyShaderModule(v) {
        this.#shaderModules.delete(v.getBigUint64(0, true));
        return ok();
    }

    // =========================================================================
    // Pipeline layout
    // =========================================================================

    #createPipelineLayout(v, payload) {
        // payload: handle(u64@0) + hasPush(u32@8) + setCount(u32@12) + setLayouts[@16](each u64)
        const h          = v.getBigUint64(0,  true);
        const hasPush    = v.getUint32(8,  true) !== 0;
        const setCount   = v.getUint32(12, true);
        const setLayouts = [];
        for (let i = 0; i < setCount; i++) setLayouts.push(v.getBigUint64(16 + i * 8, true));

        // Build GPUPipelineLayout: if hasPush, prepend push-constant BGL at slot 0.
        const bgls = [];
        if (hasPush && this.#pushConstBGL) bgls.push(this.#pushConstBGL);
        for (const lh of setLayouts) {
            const dsl = this.#descSetLayouts.get(lh);
            if (dsl?.gpuLayout) bgls.push(dsl.gpuLayout);
        }
        let gpuLayout = null;
        try {
            gpuLayout = this.#device.createPipelineLayout({
                label: `pl_${h}`, bindGroupLayouts: bgls,
            });
        } catch (e) {
            console.warn(`[VkWebGPUPlugin] createPipelineLayout (h=${h}) failed:`, e.message);
        }
        this.#pipelineLayouts.set(h, { setLayouts, hasPush, gpuLayout });
        return ok();
    }

    // =========================================================================
    // Render passes and framebuffers
    // =========================================================================

    #createRenderPass(v, payload) {
        // payload: handle(u64@0) + attachCount(u32@8) + per attachment: vkFormat(u32)+loadOp(u32)+storeOp(u32)+isDepth(u32)
        const h           = v.getBigUint64(0, true);
        const attachCount = v.getUint32(8, true);
        const attachments = [];
        for (let i = 0; i < attachCount; i++) {
            const base   = 12 + i * 16;
            const vkFmt  = v.getUint32(base,      true);
            const loadOp = v.getUint32(base + 4,  true);
            const storeOp= v.getUint32(base + 8,  true);
            const isDepth= v.getUint32(base + 12, true);
            attachments.push({
                format:  VK_FORMAT_MAP[vkFmt] ?? 'rgba8unorm',
                loadOp:  VK_LOAD_OP[loadOp]   ?? 'load',
                storeOp: VK_STORE_OP[storeOp] ?? 'store',
                isDepth: isDepth !== 0,
            });
        }
        this.#renderPasses.set(h, { attachments });
        return ok();
    }

    #createFramebuffer(v, payload) {
        // payload: handle(u64@0) + rpHandle(u64@8) + width(u32@16) + height(u32@20) + viewCount(u32@24) + views[](u64@28)
        const h         = v.getBigUint64(0,  true);
        const rpHandle  = v.getBigUint64(8,  true);
        const width     = v.getUint32(16, true);
        const height    = v.getUint32(20, true);
        const viewCount = v.getUint32(24, true);
        const views     = [];
        for (let i = 0; i < viewCount; i++) views.push(v.getBigUint64(28 + i * 8, true));
        this.#framebuffers.set(h, { rpHandle, width, height, views });
        return ok();
    }

    // =========================================================================
    // Graphics / Compute Pipelines
    // =========================================================================

    #createGraphicsPipeline(v, payload) {
        // Serialization format (from serialize_and_send_graphics_pipeline in pipeline.rs):
        //   handle(u64) + layoutHandle(u64) + stageCount(u32)
        //   stages[] × { stageFlags(u32) + moduleHandle(u64) + entryLen(u32) + entry[entryLen] }
        //   colorFmtCount(u32) + colorFmts[](u32) + depthFmt(u32)
        //   vtxBindCount(u32) + vtxBindings[] × { binding+stride+rate(u32×3) + attrCount(u32) + attrs[] × { loc+bind+fmt+off(u32×4) } }
        //   topology(u32) + polygonMode(u32) + cullMode(u32) + frontFace(u32)
        //   depthTestEn(u32) + depthWriteEn(u32) + depthCompareOp(u32)
        //   blendCount(u32) + blends[] × { enable+srcCol+dstCol+colOp+srcAlpha+dstAlpha+alphaOp+writeMask(u32×8) }
        let off = 0;
        const h       = v.getBigUint64(off, true); off += 8;
        const layoutH = v.getBigUint64(off, true); off += 8;

        const stageCount = v.getUint32(off, true); off += 4;
        const stages = [];
        for (let i = 0; i < stageCount; i++) {
            const stageFlags = v.getUint32(off, true); off += 4;
            const moduleH    = v.getBigUint64(off, true); off += 8;
            const entryLen   = v.getUint32(off, true); off += 4;
            const entry      = new TextDecoder().decode(payload.subarray(off, off + entryLen)); off += entryLen;
            stages.push({ stageFlags, moduleH, entry: entry || 'main' });
        }

        const colorFmtCount = v.getUint32(off, true); off += 4;
        const colorFmts = [];
        for (let i = 0; i < colorFmtCount; i++) { colorFmts.push(v.getUint32(off, true)); off += 4; }
        const depthFmt = v.getUint32(off, true); off += 4;

        const vtxBindCount = v.getUint32(off, true); off += 4;
        const vtxBuffers = [];
        for (let i = 0; i < vtxBindCount; i++) {
            /*const binding =*/ v.getUint32(off, true); off += 4;
            const stride    = v.getUint32(off, true); off += 4;
            const rate      = v.getUint32(off, true); off += 4; // 0=vertex,1=instance
            const attrCount = v.getUint32(off, true); off += 4;
            const attrs = [];
            for (let j = 0; j < attrCount; j++) {
                const loc  = v.getUint32(off, true); off += 4;
                /*bind*/     v.getUint32(off, true); off += 4;
                const fmt  = v.getUint32(off, true); off += 4;
                const aoff = v.getUint32(off, true); off += 4;
                attrs.push({ shaderLocation: loc, offset: aoff, format: VK_VERTEX_FORMAT[fmt] ?? 'float32x4' });
            }
            vtxBuffers.push({ arrayStride: stride, stepMode: rate === 1 ? 'instance' : 'vertex', attributes: attrs });
        }

        const topology    = v.getUint32(off, true); off += 4;
        /*polygonMode*/     v.getUint32(off, true); off += 4;
        const cullMode    = v.getUint32(off, true); off += 4;
        const frontFace   = v.getUint32(off, true); off += 4;
        const depthTestEn = v.getUint32(off, true); off += 4;
        const depthWrEn   = v.getUint32(off, true); off += 4;
        const depthCmp    = v.getUint32(off, true); off += 4;

        const blendCount = v.getUint32(off, true); off += 4;
        const targets = [];
        for (let i = 0; i < blendCount; i++) {
            const enable   = v.getUint32(off, true); off += 4;
            const srcCol   = v.getUint32(off, true); off += 4;
            const dstCol   = v.getUint32(off, true); off += 4;
            const colOp    = v.getUint32(off, true); off += 4;
            const srcAlpha = v.getUint32(off, true); off += 4;
            const dstAlpha = v.getUint32(off, true); off += 4;
            const alphaOp  = v.getUint32(off, true); off += 4;
            const wmask    = v.getUint32(off, true); off += 4;
            targets.push({
                format:    VK_FORMAT_MAP[colorFmts[i]] ?? 'rgba8unorm',
                writeMask: wmask & 0xF,
                blend:     enable ? {
                    color: { srcFactor: VK_BLEND_FACTOR[srcCol]   ?? 'one',  dstFactor: VK_BLEND_FACTOR[dstCol]   ?? 'zero', operation: VK_BLEND_OP[colOp]   ?? 'add' },
                    alpha: { srcFactor: VK_BLEND_FACTOR[srcAlpha] ?? 'one',  dstFactor: VK_BLEND_FACTOR[dstAlpha] ?? 'zero', operation: VK_BLEND_OP[alphaOp] ?? 'add' },
                } : undefined,
            });
        }
        // If no blend attachments were specified but we have color formats, add unblended targets.
        if (targets.length === 0) {
            for (const fmt of colorFmts) targets.push({ format: VK_FORMAT_MAP[fmt] ?? 'rgba8unorm', writeMask: 0xF });
        }

        // Locate vertex/fragment GPU shader modules.
        let vertMod = null, vertEntry = 'main';
        let fragMod = null, fragEntry = 'main';
        for (const st of stages) {
            const sm = this.#shaderModules.get(st.moduleH);
            if (sm?.gpuModule) {
                if (st.stageFlags & 0x1)  { vertMod = sm.gpuModule; vertEntry = st.entry; }
                if (st.stageFlags & 0x10) { fragMod = sm.gpuModule; fragEntry = st.entry; }
            }
        }

        const plData = this.#pipelineLayouts.get(layoutH);
        let gpuPipeline = null;
        if (plData?.gpuLayout && vertMod) {
            try {
                gpuPipeline = this.#device.createRenderPipeline({
                    label:  `gp_${h}`,
                    layout: plData.gpuLayout,
                    vertex: { module: vertMod, entryPoint: vertEntry, buffers: vtxBuffers },
                    primitive: {
                        topology:  VK_TOPOLOGY[topology]     ?? 'triangle-list',
                        cullMode:  VK_CULL_MODE[cullMode]    ?? 'none',
                        frontFace: VK_FRONT_FACE[frontFace]  ?? 'ccw',
                    },
                    depthStencil: depthFmt !== 0 ? {
                        format:             VK_FORMAT_MAP[depthFmt] ?? 'depth32float',
                        depthWriteEnabled:  depthWrEn !== 0,
                        depthCompare:       depthTestEn ? (VK_COMPARE_OP[depthCmp] ?? 'less') : 'always',
                    } : undefined,
                    fragment: fragMod ? {
                        module: fragMod, entryPoint: fragEntry, targets,
                    } : undefined,
                    multisample: { count: 1 },
                });
            } catch (e) {
                console.warn(`[VkWebGPUPlugin] createGraphicsPipeline (h=${h}) failed:`, e.message);
            }
        } else {
            if (!plData?.gpuLayout) console.warn(`[VkWebGPUPlugin] gp_${h}: no gpuLayout for layout ${layoutH}`);
            if (!vertMod)           console.warn(`[VkWebGPUPlugin] gp_${h}: no vertex module`);
        }
        // Save descriptor for dynamic-state variant recreation.
        if (plData?.gpuLayout && vertMod) {
            this.#pipelineCreateInfos.set(h, {
                label:  `gp_${h}_dyn`,
                layout: plData.gpuLayout,
                vertex: { module: vertMod, entryPoint: vertEntry, buffers: vtxBuffers },
                primitive: {
                    topology:  VK_TOPOLOGY[topology]    ?? 'triangle-list',
                    cullMode:  VK_CULL_MODE[cullMode]   ?? 'none',
                    frontFace: VK_FRONT_FACE[frontFace] ?? 'ccw',
                },
                depthStencil: depthFmt !== 0 ? {
                    format:            VK_FORMAT_MAP[depthFmt] ?? 'depth32float',
                    depthWriteEnabled: depthWrEn !== 0,
                    depthCompare:      depthTestEn ? (VK_COMPARE_OP[depthCmp] ?? 'less') : 'always',
                } : undefined,
                fragment: fragMod ? {
                    module: fragMod, entryPoint: fragEntry, targets,
                } : undefined,
                multisample: { count: 1 },
            });
        }
        this.#pipelines.set(h, { type: 'render', gpuPipeline });
        return ok();
    }

    #createComputePipeline(v, payload) {
        // payload: handle(u64@0) + layoutHandle(u64@8) + moduleHandle(u64@16) + entryLen(u32@24) + entry[@28]
        const h       = v.getBigUint64(0,  true);
        const layoutH = v.getBigUint64(8,  true);
        const moduleH = v.getBigUint64(16, true);
        const entryLen= v.getUint32(24, true);
        const entry   = new TextDecoder().decode(payload.subarray(28, 28 + entryLen)) || 'main';
        const plData  = this.#pipelineLayouts.get(layoutH);
        const smData  = this.#shaderModules.get(moduleH);
        let gpuPipeline = null;
        if (plData?.gpuLayout && smData?.gpuModule) {
            try {
                gpuPipeline = this.#device.createComputePipeline({
                    label:   `cp_${h}`,
                    layout:  plData.gpuLayout,
                    compute: { module: smData.gpuModule, entryPoint: entry },
                });
            } catch (e) {
                console.warn(`[VkWebGPUPlugin] createComputePipeline (h=${h}) failed:`, e.message);
            }
        }
        this.#pipelines.set(h, { type: 'compute', gpuPipeline });
        return ok();
    }

    #destroyPipeline(v) {
        this.#pipelines.delete(v.getBigUint64(0, true));
        return ok();
    }

    // =========================================================================
    // Descriptor sets
    // =========================================================================

    #createDescriptorSetLayout(v, payload) {
        // payload: handle(u64@0) + bindingCount(u32@8) + bindings[@12]
        // each binding: binding(u32)+dtype(u32)+count(u32)+stages(u32)+cisCompanion(u32) = 20 bytes
        const h            = v.getBigUint64(0, true);
        const bindingCount = v.getUint32(8, true);
        const bindings     = [];
        const entries      = [];
        for (let i = 0; i < bindingCount; i++) {
            const base         = 12 + i * 20;
            const binding      = v.getUint32(base,      true);
            const dtype        = v.getUint32(base + 4,  true);
            const count        = v.getUint32(base + 8,  true);
            const stages       = v.getUint32(base + 12, true);
            const cisCompanion = v.getUint32(base + 16, true);
            const vis          = vkShaderStages(stages);
            bindings.push({ binding, dtype, count, stages, cisCompanion });
            entries.push(vkBglEntry(binding, dtype, count, vis));
            // For COMBINED_IMAGE_SAMPLER (dtype=1), add companion sampler entry.
            if (dtype === 1 && cisCompanion !== 0xFFFFFFFF) {
                entries.push({ binding: cisCompanion, visibility: vis, sampler: { type: 'filtering' } });
            }
        }
        let gpuLayout = null;
        try {
            gpuLayout = this.#device.createBindGroupLayout({ label: `dsl_${h}`, entries });
        } catch (e) {
            console.warn(`[VkWebGPUPlugin] createDescriptorSetLayout (h=${h}) failed:`, e.message);
        }
        this.#descSetLayouts.set(h, { bindings, gpuLayout });
        return ok();
    }

    #createDescriptorPool() {
        // WebGPU has no descriptor pool concept; just ack.
        return ok();
    }

    #allocateDescriptorSets(v, payload) {
        // Rust-allocated handles sent as: count(u32@0) + sets[](setHandle:u64+layoutHandle:u64) = 4+n×16
        const count = v.getUint32(0, true);
        for (let i = 0; i < count; i++) {
            const setH    = v.getBigUint64(4 + i * 16,     true);
            const layoutH = v.getBigUint64(4 + i * 16 + 8, true);
            this.#descSets.set(setH, { layoutH, bindings: new Map(), gpuBindGroup: null });
        }
        return ok();
    }

    #updateDescriptorSets(v, payload) {
        // payload: writeCount(u32@0) + writes[]
        // each write header: dstSet(u64)+dstBinding(u32)+dstArrayElement(u32)+count(u32)+dtype(u32) = 24 bytes
        // each buffer item:  bufH(u64)+offset(u64)+range(u64) = 24 bytes
        // each image item:   imageViewH(u64)+samplerH(u64)+imageLayout(u32)+pad(u32) = 24 bytes
        const writeCount = v.getUint32(0, true);
        let off = 4;
        for (let i = 0; i < writeCount; i++) {
            const dstSetH    = v.getBigUint64(off, true); off += 8;
            const dstBinding = v.getUint32(off, true);    off += 4;
            const dstArrElem = v.getUint32(off, true);    off += 4;
            const count      = v.getUint32(off, true);    off += 4;
            const dtype      = v.getUint32(off, true);    off += 4;

            const ds = this.#descSets.get(dstSetH);
            // UNIFORM_BUFFER=6, STORAGE_BUFFER=7, UNIFORM_BUFFER_DYNAMIC=8, STORAGE_BUFFER_DYNAMIC=9
            const isBuffer = (dtype >= 6 && dtype <= 9);

            for (let j = 0; j < count; j++) {
                const slot = dstBinding + dstArrElem + j;
                if (isBuffer) {
                    const bufH   = v.getBigUint64(off, true); off += 8;
                    const bufOff = v.getBigUint64(off, true); off += 8;
                    const range  = v.getBigUint64(off, true); off += 8;
                    const gpuRange = (range === 0n || range >= 0xFFFFFFFFn) ? undefined : Number(range);
                    if (ds) ds.bindings.set(slot, { type: 'buffer', bufH, offset: Number(bufOff), range: gpuRange });
                } else {
                    const ivH    = v.getBigUint64(off, true); off += 8;
                    const sampH  = v.getBigUint64(off, true); off += 8;
                    /*layout*/    v.getUint32(off, true);    off += 4;
                    /*pad*/       v.getUint32(off, true);    off += 4;
                    if (ds) {
                        if (dtype === 1 /* COMBINED_IMAGE_SAMPLER */)
                            ds.bindings.set(slot, { type: 'cis', ivH, sampH });
                        else if (dtype === 0 /* SAMPLER */)
                            ds.bindings.set(slot, { type: 'sampler', sampH });
                        else
                            ds.bindings.set(slot, { type: 'image', ivH });
                    }
                }
            }
            if (ds) this.#rebuildBindGroup(dstSetH);
        }
        return ok();
    }

    #rebuildBindGroup(dsH) {
        const ds     = this.#descSets.get(dsH);
        if (!ds) return;
        const layout = this.#descSetLayouts.get(ds.layoutH);
        if (!layout?.gpuLayout) return;

        const entries = [];
        for (const lb of layout.bindings) {
            const bd = ds.bindings.get(lb.binding);
            if (!bd) return; // slot not yet written — defer bind group creation

            if (bd.type === 'buffer') {
                const bi = this.#buffers.get(bd.bufH);
                if (!bi?.gpuBuffer) return;
                entries.push({ binding: lb.binding, resource: {
                    buffer: bi.gpuBuffer, offset: bd.offset, size: bd.range,
                }});
            } else if (bd.type === 'cis') {
                const ivi = this.#imageViews.get(bd.ivH);
                if (!ivi?.view) return;
                entries.push({ binding: lb.binding, resource: ivi.view });
                if (lb.cisCompanion !== undefined && lb.cisCompanion !== 0xFFFFFFFF) {
                    const samp = this.#samplers.get(bd.sampH);
                    if (!samp) return;
                    entries.push({ binding: lb.cisCompanion, resource: samp });
                }
            } else if (bd.type === 'image') {
                const ivi = this.#imageViews.get(bd.ivH);
                if (!ivi?.view) return;
                entries.push({ binding: lb.binding, resource: ivi.view });
            } else if (bd.type === 'sampler') {
                const samp = this.#samplers.get(bd.sampH);
                if (!samp) return;
                entries.push({ binding: lb.binding, resource: samp });
            }
        }

        try {
            ds.gpuBindGroup = this.#device.createBindGroup({
                label: `ds_${dsH}`, layout: layout.gpuLayout, entries,
            });
        } catch (e) {
            console.warn(`[VkWebGPUPlugin] rebuildBindGroup (ds=${dsH}) failed:`, e.message);
            ds.gpuBindGroup = null;
        }
    }

    // =========================================================================
    // Dynamic-state pipeline variant cache
    // =========================================================================

    // Returns the variant cache key for the current pipeline + dynamic state.
    #dynVariantKey() {
        const s = this.#dynState;
        return `${this.#boundPipeH}|${s.cullMode}|${s.frontFace}|${s.topology}|${s.depthTestEnable}|${s.depthWriteEnable}|${s.depthCompareOp}|${s.stencilTestEnable}`;
    }

    // Ensures the render pass uses the right pipeline variant for current dynamic state.
    // Call before every draw inside a render pass.
    #applyDynState(rp) {
        if (!rp || !this.#dynDirty || this.#boundPipeH === null) return;
        this.#dynDirty = false;
        const key = this.#dynVariantKey();
        let variant = this.#pipelineVariants.get(key);
        if (!variant) {
            const base = this.#pipelineCreateInfos.get(this.#boundPipeH);
            if (base) {
                const desc = structuredClone(base);
                const s = this.#dynState;
                desc.primitive.topology = VK_TOPOLOGY[s.topology] ?? desc.primitive.topology;
                desc.primitive.cullMode = VK_CULL_MODE[s.cullMode] ?? desc.primitive.cullMode;
                desc.primitive.frontFace = VK_FRONT_FACE[s.frontFace] ?? desc.primitive.frontFace;
                if (desc.depthStencil) {
                    desc.depthStencil.depthWriteEnabled = s.depthWriteEnable !== 0;
                    desc.depthStencil.depthCompare = s.depthTestEnable
                        ? (VK_COMPARE_OP[s.depthCompareOp] ?? desc.depthStencil.depthCompare)
                        : 'always';
                }
                try {
                    variant = this.#device.createRenderPipeline(desc);
                    this.#pipelineVariants.set(key, variant);
                } catch (e) {
                    console.warn('[VkWebGPUPlugin] dynState variant failed:', e.message);
                    variant = this.#pipelines.get(this.#boundPipeH)?.gpuPipeline;
                }
            }
        }
        if (variant) rp.setPipeline(variant);
    }

    // Returns (or lazily creates) the blit GPURenderPipeline for a given dst format.
    #getBlitPipeline(dstFormat) {
        let pipe = this.#blitPipelines.get(dstFormat);
        if (!pipe && this.#blitShaderMod && this.#blitBGL) {
            const layout = this.#device.createPipelineLayout({
                bindGroupLayouts: [this.#blitBGL],
            });
            try {
                pipe = this.#device.createRenderPipeline({
                    label:    `blit-${dstFormat}`,
                    layout,
                    vertex:   { module: this.#blitShaderMod, entryPoint: 'vs_main' },
                    fragment: { module: this.#blitShaderMod, entryPoint: 'fs_main',
                                targets: [{ format: dstFormat }] },
                    primitive: { topology: 'triangle-list' },
                });
                this.#blitPipelines.set(dstFormat, pipe);
            } catch (e) {
                console.warn(`[VkWebGPUPlugin] blitPipeline(${dstFormat}) failed:`, e.message);
            }
        }
        return pipe ?? null;
    }

    // =========================================================================
    // QUEUE_SUBMIT — the core frame path
    // =========================================================================

    #queueSubmit(v, payload) {
        const enc   = this.#device.createCommandEncoder({ label: 'vk-frame' });
        const state = { enc, renderPass: null, computePass: null };

        let off      = 0;
        const count  = v.getUint32(off, true); off += 4;

        for (let i = 0; i < count; i++) {
            if (off + 8 > payload.byteLength) {
                console.error('[VkWebGPUPlugin] QUEUE_SUBMIT payload truncated');
                break;
            }
            const opcode  = v.getUint32(off, true); off += 4;
            const cmdLen  = v.getUint32(off, true); off += 4;
            const cmdView = new DataView(payload.buffer, payload.byteOffset + off, cmdLen);
            const cmdPayl = payload.subarray(off, off + cmdLen);
            off += cmdLen;
            this.#replayCmd(state, opcode, cmdView, cmdPayl);
        }

        if (state.renderPass)  state.renderPass.end();
        if (state.computePass) state.computePass.end();
        this.#device.queue.submit([enc.finish()]);
        return ok();
    }

    // =========================================================================
    // Per-command replay inside QUEUE_SUBMIT
    // All DataView offsets are relative to the start of the per-command payload.
    // =========================================================================

    #replayCmd(state, op, v, payload) {
        const enc = state.enc;
        const rp  = state.renderPass;
        const cp  = state.computePass;

        switch (op) {

        case FC_BEGIN_RENDER_PASS: {
            if (rp) { rp.end(); state.renderPass = null; }
            const rpH        = v.getBigUint64(0, true);
            const fbH        = v.getBigUint64(8, true);
            // Rect2D: offset.x(i32)+offset.y(i32)+extent.w(u32)+extent.h(u32) = 16 bytes @ 16
            const clearCount = v.getUint32(32, true);
            const clears     = [];
            for (let i = 0; i < clearCount; i++) {
                const base = 36 + i * 16;
                clears.push({
                    r: v.getFloat32(base,     true), g: v.getFloat32(base + 4, true),
                    b: v.getFloat32(base + 8, true), a: v.getFloat32(base +12, true),
                    depth:   v.getFloat32(base, true),
                    stencil: v.getUint32(base + 4, true),
                });
            }
            state.renderPass = this.#beginRenderPassFromInfo(enc, rpH, fbH, clears);
            break;
        }

        case FC_END_RENDER_PASS:
        case FC_END_RENDERING:
            if (rp) { rp.end(); state.renderPass = null; }
            break;

        case FC_NEXT_SUBPASS:
            // Subpasses not expressible in WebGPU; treat as a no-op continuation.
            break;

        case FC_BEGIN_RENDERING: {
            // Dynamic rendering: render_area(16)+layerCount(4)+colorCount(4)+attachments
            if (rp) { rp.end(); state.renderPass = null; }
            const colorCount = v.getUint32(20, true);
            const colorAttachments = [];
            let off = 24;
            for (let i = 0; i < colorCount; i++) {
                const ivH    = v.getBigUint64(off, true); off += 8;
                const loadOp = v.getUint32(off, true);    off += 4;
                const stOp   = v.getUint32(off, true);    off += 4;
                const cv     = { r: v.getFloat32(off,true), g: v.getFloat32(off+4,true),
                                 b: v.getFloat32(off+8,true), a: v.getFloat32(off+12,true) };
                off += 16;
                const ivi = this.#imageViews.get(ivH);
                if (ivi?.view) colorAttachments.push({
                    view: ivi.view, loadOp: VK_LOAD_OP[loadOp] ?? 'load',
                    storeOp: VK_STORE_OP[stOp] ?? 'store', clearValue: cv,
                });
            }
            // Optional depth attachment: present(u32)+ivHandle(u64)+loadOp+storeOp+clearValue(16)
            let depthStencilAttachment;
            const hasDepth = v.getUint32(off, true); off += 4;
            if (hasDepth) {
                const ivH    = v.getBigUint64(off, true); off += 8;
                const loadOp = v.getUint32(off, true);    off += 4;
                const stOp   = v.getUint32(off, true);    off += 4;
                const dv     = v.getFloat32(off, true);   off += 16; // skip full ClearValue
                const ivi = this.#imageViews.get(ivH);
                if (ivi?.view) depthStencilAttachment = {
                    view: ivi.view, depthLoadOp: VK_LOAD_OP[loadOp] ?? 'load',
                    depthStoreOp: VK_STORE_OP[stOp] ?? 'store', depthClearValue: dv,
                };
            }
            if (colorAttachments.length || depthStencilAttachment)
                state.renderPass = enc.beginRenderPass({ colorAttachments, depthStencilAttachment });
            break;
        }

        case FC_BIND_PIPELINE: {
            const bindPt = v.getUint32(0, true);
            const pipeH  = v.getBigUint64(4, true);
            const pi     = this.#pipelines.get(pipeH);
            if (pi?.gpuPipeline) {
                if (bindPt === VK_BIND_GRAPHICS && rp) {
                    this.#boundPipeH = pipeH;
                    this.#dynDirty   = true; // re-apply dynamic state to this new pipeline
                    this.#applyDynState(rp);
                }
                if (bindPt === VK_BIND_COMPUTE  && cp)  cp.setPipeline(pi.gpuPipeline);
            }
            break;
        }

        case FC_BIND_VERTEX_BUFFERS: {
            if (!rp) break;
            const firstBind = v.getUint32(0, true);
            const count     = v.getUint32(4, true);
            const handles   = [], offsets = [];
            for (let i = 0; i < count; i++) handles.push(v.getBigUint64(8 + i * 8, true));
            for (let i = 0; i < count; i++) offsets.push(v.getBigUint64(8 + count * 8 + i * 8, true));
            for (let i = 0; i < count; i++) {
                const bi = this.#buffers.get(handles[i]);
                if (bi?.gpuBuffer) rp.setVertexBuffer(firstBind + i, bi.gpuBuffer, Number(offsets[i]));
            }
            break;
        }

        case FC_BIND_INDEX_BUFFER: {
            if (!rp) break;
            const bH      = v.getBigUint64(0, true);
            const bOff    = v.getBigUint64(8, true);
            const idxType = v.getUint32(16, true);
            const bi = this.#buffers.get(bH);
            if (bi?.gpuBuffer)
                rp.setIndexBuffer(bi.gpuBuffer, VK_INDEX_TYPE[idxType] ?? 'uint32', Number(bOff));
            break;
        }

        case FC_BIND_DESCRIPTOR_SETS: {
            const bindPt   = v.getUint32(0, true);
            // layout(u64 @ 4), firstSet(u32 @ 12), count(u32 @ 16), sets[](u64 @ 20)
            const firstSet = v.getUint32(12, true);
            const count    = v.getUint32(16, true);
            for (let i = 0; i < count; i++) {
                const dsH = v.getBigUint64(20 + i * 8, true);
                const ds  = this.#descSets.get(dsH);
                if (ds?.gpuBindGroup) {
                    if (bindPt === VK_BIND_GRAPHICS && rp) rp.setBindGroup(firstSet + i, ds.gpuBindGroup);
                    if (bindPt === VK_BIND_COMPUTE  && cp) cp.setBindGroup(firstSet + i, ds.gpuBindGroup);
                }
            }
            break;
        }

        case FC_PUSH_CONSTANTS: {
            // layout(u64)+stageFlags(u32)+offset(u32)+size(u32)+dataLen(u32)+data
            const pcOff  = v.getUint32(16, true);
            const pcSize = v.getUint32(20, true);
            const dataLen= v.getUint32(24, true);
            const copyLen = Math.min(dataLen, 256 - pcOff);
            for (let i = 0; i < copyLen; i++)
                this.#pushConstData[pcOff + i] = v.getUint8(28 + i);
            // Upload the full 256-byte push-constant block to the GPU uniform buffer.
            if (this.#pushConstBuffer)
                this.#device.queue.writeBuffer(this.#pushConstBuffer, 0, this.#pushConstData);
            break;
        }

        case FC_DRAW: {
            if (!rp) break;
            this.#applyDynState(rp);
            rp.draw(v.getUint32(0,true), v.getUint32(4,true), v.getUint32(8,true), v.getUint32(12,true));
            break;
        }

        case FC_DRAW_INDEXED: {
            if (!rp) break;
            this.#applyDynState(rp);
            rp.drawIndexed(v.getUint32(0,true), v.getUint32(4,true),
                           v.getUint32(8,true), v.getInt32(12,true), v.getUint32(16,true));
            break;
        }

        case FC_DRAW_INDIRECT: {
            if (!rp) break;
            this.#applyDynState(rp);
            const bi = this.#buffers.get(v.getBigUint64(0, true));
            if (bi?.gpuBuffer) {
                const bOff      = Number(v.getBigUint64(8, true));
                const drawCount = v.getUint32(16, true);
                const stride    = v.getUint32(20, true);
                for (let i = 0; i < drawCount; i++)
                    rp.drawIndirect(bi.gpuBuffer, bOff + i * stride);
            }
            break;
        }

        case FC_DRAW_INDEXED_INDIRECT: {
            if (!rp) break;
            this.#applyDynState(rp);
            const bi = this.#buffers.get(v.getBigUint64(0, true));
            if (bi?.gpuBuffer) {
                const bOff      = Number(v.getBigUint64(8, true));
                const drawCount = v.getUint32(16, true);
                const stride    = v.getUint32(20, true);
                for (let i = 0; i < drawCount; i++)
                    rp.drawIndexedIndirect(bi.gpuBuffer, bOff + i * stride);
            }
            break;
        }

        case FC_DISPATCH: {
            if (!cp) break;
            cp.dispatchWorkgroups(v.getUint32(0,true), v.getUint32(4,true), v.getUint32(8,true));
            break;
        }

        case FC_DISPATCH_BASE: {
            // WebGPU doesn't support base workgroup offsets; ignore base.
            if (!cp) break;
            cp.dispatchWorkgroups(v.getUint32(12,true), v.getUint32(16,true), v.getUint32(20,true));
            break;
        }

        case FC_SET_VIEWPORT: {
            if (!rp) break;
            // firstViewport(u32)+count(u32)+Viewport{x,y,w,h,minD,maxD}(6×f32=24 bytes)
            if (v.getUint32(4, true) < 1) break;
            const x    = v.getFloat32(8,  true);
            const y    = v.getFloat32(12, true);
            const w    = v.getFloat32(16, true);
            const h    = v.getFloat32(20, true);
            const minD = v.getFloat32(24, true);
            const maxD = v.getFloat32(28, true);
            // Vulkan allows negative height for Y-flip. WebGPU viewport takes positive h.
            const wgpuY = h < 0 ? y + h : y;
            rp.setViewport(x, wgpuY, Math.abs(w), Math.abs(h), minD, maxD);
            break;
        }

        case FC_SET_SCISSOR: {
            if (!rp) break;
            // firstScissor(u32)+count(u32)+Rect2D{x(i32),y(i32),w(u32),h(u32)}
            if (v.getUint32(4, true) < 1) break;
            const x = Math.max(0, v.getInt32(8,  true));
            const y = Math.max(0, v.getInt32(12, true));
            const w = v.getUint32(16, true);
            const h = v.getUint32(20, true);
            rp.setScissorRect(x, y, w, h);
            break;
        }

        case FC_SET_BLEND_CONSTANTS: {
            if (!rp) break;
            rp.setBlendConstant({
                r: v.getFloat32(0,  true), g: v.getFloat32(4,  true),
                b: v.getFloat32(8,  true), a: v.getFloat32(12, true),
            });
            break;
        }

        case FC_SET_STENCIL_REFERENCE: {
            if (!rp) break;
            rp.setStencilReference(v.getUint32(4, true)); // face_mask(u32)+reference(u32)
            break;
        }

        case FC_PIPELINE_BARRIER:
            // WebGPU synchronisation is automatic; no-op.
            break;

        case FC_SET_CULL_MODE:
            this.#dynState.cullMode = v.getUint32(0, true);
            this.#dynDirty = true;
            break;
        case FC_SET_FRONT_FACE:
            this.#dynState.frontFace = v.getUint32(0, true);
            this.#dynDirty = true;
            break;
        case FC_SET_PRIMITIVE_TOPOLOGY:
            this.#dynState.topology = v.getUint32(0, true);
            this.#dynDirty = true;
            break;
        case FC_SET_DEPTH_TEST_ENABLE:
            this.#dynState.depthTestEnable = v.getUint32(0, true);
            this.#dynDirty = true;
            break;
        case FC_SET_DEPTH_WRITE_ENABLE:
            this.#dynState.depthWriteEnable = v.getUint32(0, true);
            this.#dynDirty = true;
            break;
        case FC_SET_DEPTH_COMPARE_OP:
            this.#dynState.depthCompareOp = v.getUint32(0, true);
            this.#dynDirty = true;
            break;
        case FC_SET_DEPTH_BIAS_ENABLE:
            this.#dynState.depthBiasEnable = v.getUint32(0, true);
            // depth bias not directly settable in WebGPU; mark dirty so variant recreates
            this.#dynDirty = true;
            break;
        case FC_SET_STENCIL_TEST_ENABLE:
            this.#dynState.stencilTestEnable = v.getUint32(0, true);
            this.#dynDirty = true;
            break;
        case FC_SET_STENCIL_OP:
        case FC_SET_DEPTH_BOUNDS:
        case FC_SET_DEPTH_BIAS:
        case FC_SET_LINE_WIDTH:
            // No direct WebGPU equivalent; accepted without action.
            break;

        case FC_COPY_BUFFER: {
            // srcH(u64)+dstH(u64)+count(u32)+[BufferCopy{srcOff:u64,dstOff:u64,size:u64}]
            const srcBi = this.#buffers.get(v.getBigUint64(0, true));
            const dstBi = this.#buffers.get(v.getBigUint64(8, true));
            if (!srcBi?.gpuBuffer || !dstBi?.gpuBuffer) break;
            const count = v.getUint32(16, true);
            for (let i = 0; i < count; i++) {
                const base   = 20 + i * 24;
                const srcOff = Number(v.getBigUint64(base,      true));
                const dstOff = Number(v.getBigUint64(base + 8,  true));
                const size   = Number(v.getBigUint64(base + 16, true));
                enc.copyBufferToBuffer(srcBi.gpuBuffer, srcOff, dstBi.gpuBuffer, dstOff, size);
            }
            break;
        }

        case FC_COPY_BUFFER_TO_IMAGE: {
            // srcH(u64)+dstH(u64)+layout(u32)+count(u32)+[BufferImageCopy×56 bytes]
            const srcBi = this.#buffers.get(v.getBigUint64(0, true));
            const dstIi = this.#images.get(v.getBigUint64(8,  true));
            if (!srcBi?.gpuBuffer || !dstIi?.texture) break;
            const count = v.getUint32(20, true);
            for (let i = 0; i < count; i++) {
                const b  = 24 + i * 56;
                const bufOff   = Number(v.getBigUint64(b,      true));
                const rowLen   = v.getUint32(b + 8,  true);
                const imgH     = v.getUint32(b + 12, true);
                // subresource: aspect(u32)+mipLevel(u32)+baseLayer(u32)+layerCount(u32)
                const mipLevel = v.getUint32(b + 20, true);
                const ox = v.getInt32(b + 32, true), oy = v.getInt32(b + 36, true), oz = v.getInt32(b + 40, true);
                const ew = v.getUint32(b + 44, true), eh = v.getUint32(b + 48, true), ed = v.getUint32(b + 52, true);
                // bytesPerRow must be a multiple of 256 in WebGPU.
                const bpr = Math.ceil(Math.max(rowLen, ew) * 4 / 256) * 256;
                try {
                    enc.copyBufferToTexture(
                        { buffer: srcBi.gpuBuffer, offset: bufOff, bytesPerRow: bpr, rowsPerImage: imgH || eh },
                        { texture: dstIi.texture, mipLevel, origin: [ox, oy, oz] },
                        [ew, eh, Math.max(1, ed)],
                    );
                } catch (e) { /* size mismatch during loading — ignore */ }
            }
            break;
        }

        case FC_COPY_IMAGE: {
            // srcH(u64)+srcLayout(u32)+dstH(u64)+dstLayout(u32)+count(u32)+[ImageCopy×68]
            const srcIi = this.#images.get(v.getBigUint64(0, true));
            const dstIi = this.#images.get(v.getBigUint64(12, true));
            if (!srcIi?.texture || !dstIi?.texture) break;
            const count = v.getUint32(24, true);
            for (let i = 0; i < count; i++) {
                const b = 28 + i * 68;
                const sMip = v.getUint32(b + 4, true);
                const sox  = v.getInt32(b + 16, true), soy = v.getInt32(b + 20, true), soz = v.getInt32(b + 24, true);
                const dMip = v.getUint32(b + 32, true);
                const dox  = v.getInt32(b + 44, true), doy = v.getInt32(b + 48, true), doz = v.getInt32(b + 52, true);
                const ew   = v.getUint32(b + 56, true), eh = v.getUint32(b + 60, true), ed = v.getUint32(b + 64, true);
                enc.copyTextureToTexture(
                    { texture: srcIi.texture, mipLevel: sMip, origin: [sox, soy, soz] },
                    { texture: dstIi.texture, mipLevel: dMip, origin: [dox, doy, doz] },
                    [ew, eh, Math.max(1, ed)],
                );
            }
            break;
        }

        case FC_COPY_IMAGE_TO_BUFFER: {
            // srcH(u64)+dstH(u64)+layout(u32)+count(u32)+[BufferImageCopy×56]
            const srcIi = this.#images.get(v.getBigUint64(0, true));
            const dstBi = this.#buffers.get(v.getBigUint64(8, true));
            if (!srcIi?.texture || !dstBi?.gpuBuffer) break;
            const count = v.getUint32(20, true);
            for (let i = 0; i < count; i++) {
                const b       = 24 + i * 56;
                const bufOff  = Number(v.getBigUint64(b,      true));
                const rowLen  = v.getUint32(b + 8,  true);
                const imgH    = v.getUint32(b + 12, true);
                const mipLevel= v.getUint32(b + 20, true);
                const ox = v.getInt32(b + 32, true), oy = v.getInt32(b + 36, true), oz = v.getInt32(b + 40, true);
                const ew = v.getUint32(b + 44, true), eh = v.getUint32(b + 48, true), ed = v.getUint32(b + 52, true);
                const bpr = Math.ceil(Math.max(rowLen, ew) * 4 / 256) * 256;
                try {
                    enc.copyTextureToBuffer(
                        { texture: srcIi.texture, mipLevel, origin: [ox, oy, oz] },
                        { buffer: dstBi.gpuBuffer, offset: bufOff, bytesPerRow: bpr, rowsPerImage: imgH || eh },
                        [ew, eh, Math.max(1, ed)],
                    );
                } catch (e) { /* size mismatch — ignore */ }
            }
            break;
        }

        case FC_BLIT_IMAGE: {
            // srcH(u64)+srcLayout(u32)+dstH(u64)+dstLayout(u32)+filter(u32)+count(u32)+[ImageBlit×80]
            const srcIi = this.#images.get(v.getBigUint64(0,  true));
            const dstIi = this.#images.get(v.getBigUint64(12, true));
            if (!srcIi?.texture || !dstIi?.texture) break;
            const count = v.getUint32(24, true);
            if (rp) { rp.end(); state.renderPass = null; }
            for (let i = 0; i < count; i++) {
                const b = 28 + i * 80;
                // src/dst offsets: {x,y,z}×2 for src and dst (each i32[3])
                const sMip = v.getUint32(b + 4, true);
                const dMip = v.getUint32(b + 44, true);
                const sx0 = v.getInt32(b + 16, true), sy0 = v.getInt32(b + 20, true);
                const sx1 = v.getInt32(b + 24, true), sy1 = v.getInt32(b + 28, true);
                const dx0 = v.getInt32(b + 56, true), dy0 = v.getInt32(b + 60, true);
                const dx1 = v.getInt32(b + 64, true), dy1 = v.getInt32(b + 68, true);
                const srcW = Math.abs(sx1 - sx0), srcH_px = Math.abs(sy1 - sy0);
                const dstW = Math.abs(dx1 - dx0), dstH_px = Math.abs(dy1 - dy0);
                // Fast path: exact same region → copyTextureToTexture
                if (srcW === dstW && srcH_px === dstH_px) {
                    try {
                        enc.copyTextureToTexture(
                            { texture: srcIi.texture, mipLevel: sMip, origin: [Math.min(sx0,sx1), Math.min(sy0,sy1), 0] },
                            { texture: dstIi.texture, mipLevel: dMip, origin: [Math.min(dx0,dx1), Math.min(dy0,dy1), 0] },
                            [srcW, srcH_px, 1],
                        );
                    } catch (_) {}
                    continue;
                }
                // Scaled path: render full-screen triangle sampling from src.
                const dstFmt = dstIi.format;
                const blitPipe = this.#getBlitPipeline(dstFmt);
                if (!blitPipe) continue;
                let srcView, dstView;
                try {
                    srcView = srcIi.texture.createView({ baseMipLevel: sMip, mipLevelCount: 1 });
                    dstView = dstIi.texture.createView({ baseMipLevel: dMip, mipLevelCount: 1 });
                } catch (_) { continue; }
                const bg = this.#device.createBindGroup({
                    layout: this.#blitBGL,
                    entries: [
                        { binding: 0, resource: srcView },
                        { binding: 1, resource: this.#blitSampler },
                    ],
                });
                const blitRP = enc.beginRenderPass({
                    colorAttachments: [{ view: dstView, loadOp: 'load', storeOp: 'store' }],
                });
                blitRP.setPipeline(blitPipe);
                blitRP.setBindGroup(0, bg);
                blitRP.setViewport(Math.min(dx0,dx1), Math.min(dy0,dy1), dstW, dstH_px, 0, 1);
                blitRP.setScissorRect(Math.max(0,Math.min(dx0,dx1)), Math.max(0,Math.min(dy0,dy1)), dstW, dstH_px);
                blitRP.draw(3);
                blitRP.end();
            }
            break;
        }

        case FC_RESOLVE_IMAGE: {
            // srcH(u64)+srcLayout(u32)+dstH(u64)+dstLayout(u32)+count(u32)+[ImageResolve×68]
            // WebGPU has no MSAA resolve command; fall back to copyTextureToTexture.
            const srcIi = this.#images.get(v.getBigUint64(0, true));
            const dstIi = this.#images.get(v.getBigUint64(12, true));
            if (!srcIi?.texture || !dstIi?.texture) break;
            const count = v.getUint32(24, true);
            for (let i = 0; i < count; i++) {
                const b    = 28 + i * 68;
                const sMip = v.getUint32(b + 4,  true);
                const sox  = v.getInt32(b + 16, true), soy = v.getInt32(b + 20, true), soz = v.getInt32(b + 24, true);
                const dMip = v.getUint32(b + 32, true);
                const dox  = v.getInt32(b + 44, true), doy = v.getInt32(b + 48, true), doz = v.getInt32(b + 52, true);
                const ew   = v.getUint32(b + 56, true), eh = v.getUint32(b + 60, true);
                try {
                    enc.copyTextureToTexture(
                        { texture: srcIi.texture, mipLevel: sMip, origin: [sox, soy, soz] },
                        { texture: dstIi.texture, mipLevel: dMip, origin: [dox, doy, doz] },
                        [ew, eh, 1],
                    );
                } catch (_) {}
            }
            break;
        }

        case FC_CLEAR_COLOR_IMAGE: {
            // image(u64)+layout(u32)+color(ClearValue 16 bytes)+rangeCount(u32)+ranges(20×n)
            const ii = this.#images.get(v.getBigUint64(0, true));
            if (ii?.texture && !rp) {
                const cv = { r: v.getFloat32(12,true), g: v.getFloat32(16,true),
                             b: v.getFloat32(20,true), a: v.getFloat32(24,true) };
                const clear = enc.beginRenderPass({ colorAttachments: [{
                    view: ii.texture.createView(), loadOp: 'clear', storeOp: 'store', clearValue: cv,
                }]});
                clear.end();
            }
            break;
        }

        case FC_CLEAR_DEPTH_STENCIL_IMAGE: {
            // image(u64)+layout(u32)+clearValue{depth:f32,stencil:u32}+rangeCount(u32)+ranges
            const ii = this.#images.get(v.getBigUint64(0, true));
            if (!ii?.texture || rp) break; // only valid outside a render pass
            const depthCV   = v.getFloat32(12, true);
            const stencilCV = v.getUint32(16,  true);
            const fmt = ii.format ?? 'depth32float';
            const isDS = fmt.includes('stencil');
            try {
                const clrPass = enc.beginRenderPass({ colorAttachments: [], depthStencilAttachment: {
                    view:              ii.texture.createView(),
                    depthLoadOp:       'clear', depthStoreOp:   'store', depthClearValue:   depthCV,
                    stencilLoadOp:     isDS ? 'clear' : undefined,
                    stencilStoreOp:    isDS ? 'store' : undefined,
                    stencilClearValue: isDS ? stencilCV : undefined,
                }});
                clrPass.end();
            } catch (e) { console.warn('[VkWebGPUPlugin] clearDepthStencilImage failed:', e.message); }
            break;
        }

        case FC_CLEAR_ATTACHMENTS: {
            // count(u32) + [ClearAttachment{aspectMask:u32, colorAttachment:u32, clearValue:16}]
            // + rectCount(u32) + [ClearRect{rect:16, baseLayer:u32, layerCount:u32}]
            // WebGPU cannot clear attachments mid-pass.  End the pass, clear with a new pass, restart.
            if (!rp) break;
            // Collect clear infos before ending the pass.
            const count = v.getUint32(0, true);
            let off = 4;
            const clears = [];
            for (let i = 0; i < count; i++) {
                const aspect = v.getUint32(off, true); off += 4;
                const slot   = v.getUint32(off, true); off += 4;
                const r = v.getFloat32(off, true), g = v.getFloat32(off+4, true),
                      b = v.getFloat32(off+8, true), a = v.getFloat32(off+12, true);
                const depth = r, stencilV = v.getUint32(off+4, true);
                off += 16;
                clears.push({ aspect, slot, r, g, b, a, depth, stencilV });
            }
            // Re-begin the same render pass with LOAD_OP=clear for affected attachments
            // is not feasible mid-recording in WebGPU. Best effort: log and continue.
            console.debug('[VkWebGPUPlugin] FC_CLEAR_ATTACHMENTS: not supported mid-pass (no-op)');
            break;
        }

        case FC_FILL_BUFFER: {
            // dstH(u64)+dstOffset(u64)+size(u64)+data(u32)
            const bi      = this.#buffers.get(v.getBigUint64(0, true));
            const bOff    = Number(v.getBigUint64(8,  true));
            const size    = Number(v.getBigUint64(16, true));
            const fillVal = v.getUint32(24, true);
            if (!bi?.gpuBuffer) break;
            if (fillVal === 0) {
                // WebGPU native clear (most common case — DXVK clears with 0).
                enc.clearBuffer(bi.gpuBuffer, bOff, size === 0xFFFFFFFFFFFFFFFF ? undefined : size);
            } else {
                // Non-zero fill: build a CPU staging array and upload.
                const byteCount = Math.min(size === 0xFFFFFFFFFFFFFFFF ? bi.gpuBuffer.size : size,
                                           bi.gpuBuffer.size - bOff);
                const fill32 = new Uint32Array(Math.ceil(byteCount / 4));
                fill32.fill(fillVal);
                this.#device.queue.writeBuffer(bi.gpuBuffer, bOff, fill32, 0, Math.ceil(byteCount / 4));
            }
            break;
        }

        case FC_UPDATE_BUFFER: {
            // dstH(u64)+dstOffset(u64)+dataLen(u32)+data
            const bi = this.#buffers.get(v.getBigUint64(0, true));
            if (bi?.gpuBuffer) {
                const bOff    = Number(v.getBigUint64(8, true));
                const dataLen = v.getUint32(16, true);
                this.#device.queue.writeBuffer(bi.gpuBuffer, bOff, payload.subarray(20, 20 + dataLen));
            }
            break;
        }

        case FC_EXECUTE_COMMANDS:
            // Secondary command buffers not yet supported.
            break;

        default:
            break;
        }
    }

    // =========================================================================
    // Render pass helper
    // =========================================================================

    #beginRenderPassFromInfo(enc, rpHandle, fbHandle, clearValues) {
        const fbInfo = this.#framebuffers.get(fbHandle);
        if (!fbInfo) {
            console.warn(`[VkWebGPUPlugin] BeginRenderPass: unknown framebuffer 0x${fbHandle.toString(16)}`);
            return null;
        }
        const rpInfo = this.#renderPasses.get(rpHandle);
        const attachments = rpInfo?.attachments ?? [];

        const colorAttachments     = [];
        let   depthStencilAttachment;
        let   cvIdx = 0;

        for (let i = 0; i < fbInfo.views.length; i++) {
            const ivi = this.#imageViews.get(fbInfo.views[i]);
            const att = attachments[i];
            const cv  = clearValues[cvIdx++] ?? { r:0,g:0,b:0,a:1, depth:1, stencil:0 };
            if (!ivi?.view) continue;

            if (att?.isDepth) {
                depthStencilAttachment = {
                    view:             ivi.view,
                    depthLoadOp:      att.loadOp,
                    depthStoreOp:     att.storeOp,
                    depthClearValue:  cv.depth ?? 1.0,
                    stencilLoadOp:    att.loadOp,
                    stencilStoreOp:   att.storeOp,
                    stencilClearValue: cv.stencil ?? 0,
                };
            } else {
                colorAttachments.push({
                    view:       ivi.view,
                    loadOp:     att?.loadOp  ?? 'load',
                    storeOp:    att?.storeOp ?? 'store',
                    clearValue: { r: cv.r, g: cv.g, b: cv.b, a: cv.a },
                });
            }
        }

        if (colorAttachments.length === 0 && !depthStencilAttachment) return null;
        return enc.beginRenderPass({ colorAttachments, depthStencilAttachment });
    }
}

// =============================================================================
// Plugin loader
// =============================================================================

export async function loadPlugin() {
    return new VkWebGPUPlugin();
}

// =============================================================================
// Helpers
// =============================================================================

function ok()               { return { result: VK_SUCCESS, data: new Uint8Array(0) }; }
function u32Bytes(n)        { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; }
function okHandle(bigintH)  { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, bigintH, true); return { result: VK_SUCCESS, data: b }; }

export const CMD_NAMES = {
    0x0001: 'CREATE_INSTANCE',         0x0002: 'DESTROY_INSTANCE',
    0x0003: 'ENUM_PHYSICAL_DEVICES',   0x0004: 'GET_PHYS_DEV_PROPS',
    0x0005: 'GET_PHYS_DEV_FEATURES',   0x0006: 'GET_PHYS_DEV_QUEUE_FAMILY',
    0x0007: 'GET_PHYS_DEV_MEM_PROPS',  0x0008: 'GET_PHYS_DEV_FORMAT_PROPS',
    0x0010: 'CREATE_DEVICE',           0x0011: 'DESTROY_DEVICE',
    0x0012: 'GET_DEVICE_QUEUE',        0x0013: 'DEVICE_WAIT_IDLE',
    0x0020: 'CREATE_SWAPCHAIN',        0x0021: 'DESTROY_SWAPCHAIN',
    0x0022: 'GET_SWAPCHAIN_IMAGES',    0x0023: 'ACQUIRE_NEXT_IMAGE',
    0x0024: 'QUEUE_PRESENT',           0x0030: 'ALLOCATE_MEMORY',
    0x0031: 'FREE_MEMORY',             0x0032: 'MAP_MEMORY',
    0x0033: 'UNMAP_MEMORY',            0x0034: 'FLUSH_MAPPED_RANGES',
    0x0035: 'WRITE_MAPPED_DATA',       0x0040: 'CREATE_BUFFER',
    0x0041: 'DESTROY_BUFFER',          0x0042: 'BIND_BUFFER_MEMORY',
    0x0043: 'CREATE_IMAGE',            0x0044: 'DESTROY_IMAGE',
    0x0045: 'BIND_IMAGE_MEMORY',       0x0046: 'CREATE_IMAGE_VIEW',
    0x0047: 'DESTROY_IMAGE_VIEW',      0x0048: 'CREATE_SAMPLER',
    0x0049: 'DESTROY_SAMPLER',         0x0050: 'CREATE_SHADER_MODULE',
    0x0051: 'DESTROY_SHADER_MODULE',   0x0052: 'CREATE_PIPELINE_LAYOUT',
    0x0053: 'DESTROY_PIPELINE_LAYOUT', 0x0054: 'CREATE_GRAPHICS_PIPELINE',
    0x0055: 'CREATE_COMPUTE_PIPELINE', 0x0056: 'DESTROY_PIPELINE',
    0x0057: 'CREATE_RENDER_PASS',      0x0058: 'DESTROY_RENDER_PASS',
    0x0059: 'CREATE_FRAMEBUFFER',      0x005A: 'DESTROY_FRAMEBUFFER',
    0x0060: 'CREATE_DESC_SET_LAYOUT',  0x0061: 'DESTROY_DESC_SET_LAYOUT',
    0x0062: 'CREATE_DESC_POOL',        0x0063: 'RESET_DESC_POOL',
    0x0064: 'ALLOCATE_DESC_SETS',      0x0065: 'UPDATE_DESC_SETS',
    0x00B0: 'QUEUE_SUBMIT',            0x00B1: 'QUEUE_WAIT_IDLE',
    0x00B2: 'CREATE_FENCE',            0x00B3: 'DESTROY_FENCE',
    0x00B4: 'WAIT_FOR_FENCES',         0x00B5: 'RESET_FENCES',
    0x00B6: 'GET_FENCE_STATUS',        0x00B7: 'CREATE_SEMAPHORE',
    0x00B8: 'DESTROY_SEMAPHORE',
};
