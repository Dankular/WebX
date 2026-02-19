/*
 * WebX Guest ICD — Pipeline entrypoints
 * Shader modules, pipeline layouts, graphics/compute pipelines,
 * render passes, framebuffers, descriptors, and render commands.
 */

#define VK_NO_PROTOTYPES
#include <vulkan/vulkan.h>
#include "vkwebx_wire.h"
#include <string.h>

extern void   webx_send(VkWebXCmd, const void *, uint32_t);
extern VkResult webx_call(VkWebXCmd, const void *, uint32_t, uint8_t **, uint32_t *);

/* ── Shader modules ──────────────────────────────────────────────────── */

VKAPI_ATTR VkResult VKAPI_CALL
webx_CreateShaderModule(VkDevice dev, const VkShaderModuleCreateInfo *ci,
                        const VkAllocationCallbacks *alloc, VkShaderModule *out) {
    WebXBuf buf; webx_buf_init(&buf);
    uint64_t h = webx_new_handle();
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)dev);
    webx_buf_push_u64(&buf, h);
    /* Send the full SPIR-V blob — host (VkWebGPU-ICD) will run Naga on it */
    webx_buf_push_u32(&buf, (uint32_t)ci->codeSize);
    webx_buf_write(&buf, ci->pCode, ci->codeSize);
    VkResult r = webx_call(WEBX_CMD_CREATE_SHADER_MODULE, buf.data, (uint32_t)buf.len, NULL, NULL);
    webx_buf_free(&buf);
    if (r == VK_SUCCESS) *out = (VkShaderModule)(uintptr_t)h;
    return r;
}

VKAPI_ATTR void VKAPI_CALL
webx_DestroyShaderModule(VkDevice dev, VkShaderModule sm,
                          const VkAllocationCallbacks *a) {
    uint64_t h = (uint64_t)(uintptr_t)sm;
    webx_send(WEBX_CMD_DESTROY_SHADER_MODULE, &h, 8);
}

/* ── Pipeline layout ─────────────────────────────────────────────────── */

VKAPI_ATTR VkResult VKAPI_CALL
webx_CreatePipelineLayout(VkDevice dev, const VkPipelineLayoutCreateInfo *ci,
                          const VkAllocationCallbacks *alloc, VkPipelineLayout *out) {
    WebXBuf buf; webx_buf_init(&buf);
    uint64_t h = webx_new_handle();
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)dev);
    webx_buf_push_u64(&buf, h);
    webx_buf_push_u32(&buf, ci->setLayoutCount);
    for (uint32_t i = 0; i < ci->setLayoutCount; i++)
        webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)ci->pSetLayouts[i]);
    webx_buf_push_u32(&buf, ci->pushConstantRangeCount);
    webx_buf_write(&buf, ci->pPushConstantRanges,
                   ci->pushConstantRangeCount * sizeof(VkPushConstantRange));
    VkResult r = webx_call(WEBX_CMD_CREATE_PIPELINE_LAYOUT, buf.data, (uint32_t)buf.len, NULL, NULL);
    webx_buf_free(&buf);
    if (r == VK_SUCCESS) *out = (VkPipelineLayout)(uintptr_t)h;
    return r;
}

VKAPI_ATTR void VKAPI_CALL
webx_DestroyPipelineLayout(VkDevice dev, VkPipelineLayout pl,
                            const VkAllocationCallbacks *a) {
    uint64_t h = (uint64_t)(uintptr_t)pl;
    webx_send(WEBX_CMD_DESTROY_PIPELINE_LAYOUT, &h, 8);
}

/* ── Graphics pipeline ───────────────────────────────────────────────── */

VKAPI_ATTR VkResult VKAPI_CALL
webx_CreateGraphicsPipelines(VkDevice dev, VkPipelineCache cache,
                              uint32_t count, const VkGraphicsPipelineCreateInfo *cis,
                              const VkAllocationCallbacks *alloc, VkPipeline *out) {
    for (uint32_t i = 0; i < count; i++) {
        const VkGraphicsPipelineCreateInfo *ci = &cis[i];
        WebXBuf buf; webx_buf_init(&buf);
        uint64_t h = webx_new_handle();
        webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)dev);
        webx_buf_push_u64(&buf, h);
        webx_buf_push_u32(&buf, 0); /* type = graphics */
        webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)ci->layout);
        webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)ci->renderPass);
        webx_buf_push_u32(&buf, ci->subpass);

        /* Shader stages */
        webx_buf_push_u32(&buf, ci->stageCount);
        for (uint32_t s = 0; s < ci->stageCount; s++) {
            const VkPipelineShaderStageCreateInfo *st = &ci->pStages[s];
            webx_buf_push_u32(&buf, st->stage);
            webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)st->module);
            /* entry point name */
            uint32_t nmlen = (uint32_t)strlen(st->pName) + 1;
            webx_buf_push_u32(&buf, nmlen);
            webx_buf_write(&buf, st->pName, nmlen);
        }

        /* Vertex input */
        if (ci->pVertexInputState) {
            webx_buf_push_u32(&buf, ci->pVertexInputState->vertexBindingDescriptionCount);
            webx_buf_write(&buf, ci->pVertexInputState->pVertexBindingDescriptions,
                           ci->pVertexInputState->vertexBindingDescriptionCount
                           * sizeof(VkVertexInputBindingDescription));
            webx_buf_push_u32(&buf, ci->pVertexInputState->vertexAttributeDescriptionCount);
            webx_buf_write(&buf, ci->pVertexInputState->pVertexAttributeDescriptions,
                           ci->pVertexInputState->vertexAttributeDescriptionCount
                           * sizeof(VkVertexInputAttributeDescription));
        } else {
            webx_buf_push_u32(&buf, 0); webx_buf_push_u32(&buf, 0);
        }

        /* Input assembly */
        if (ci->pInputAssemblyState) {
            webx_buf_push_u32(&buf, ci->pInputAssemblyState->topology);
            webx_buf_push_u32(&buf, ci->pInputAssemblyState->primitiveRestartEnable);
        } else {
            webx_buf_push_u32(&buf, VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST);
            webx_buf_push_u32(&buf, VK_FALSE);
        }

        /* Rasterization */
        if (ci->pRasterizationState) {
            webx_buf_write(&buf, ci->pRasterizationState,
                           sizeof(VkPipelineRasterizationStateCreateInfo));
        } else {
            VkPipelineRasterizationStateCreateInfo rs = {0};
            rs.polygonMode = VK_POLYGON_MODE_FILL;
            rs.cullMode    = VK_CULL_MODE_NONE;
            rs.frontFace   = VK_FRONT_FACE_COUNTER_CLOCKWISE;
            rs.lineWidth   = 1.0f;
            webx_buf_write(&buf, &rs, sizeof(rs));
        }

        /* Depth-stencil */
        if (ci->pDepthStencilState) {
            webx_buf_write(&buf, ci->pDepthStencilState,
                           sizeof(VkPipelineDepthStencilStateCreateInfo));
        } else {
            VkPipelineDepthStencilStateCreateInfo ds = {0};
            webx_buf_write(&buf, &ds, sizeof(ds));
        }

        /* Color blend */
        if (ci->pColorBlendState) {
            webx_buf_push_u32(&buf, ci->pColorBlendState->attachmentCount);
            webx_buf_write(&buf, ci->pColorBlendState->pAttachments,
                           ci->pColorBlendState->attachmentCount
                           * sizeof(VkPipelineColorBlendAttachmentState));
        } else {
            webx_buf_push_u32(&buf, 0);
        }

        VkResult r = webx_call(WEBX_CMD_CREATE_GRAPHICS_PIPELINE,
                               buf.data, (uint32_t)buf.len, NULL, NULL);
        webx_buf_free(&buf);
        if (r != VK_SUCCESS) return r;
        out[i] = (VkPipeline)(uintptr_t)h;
    }
    return VK_SUCCESS;
}

VKAPI_ATTR VkResult VKAPI_CALL
webx_CreateComputePipelines(VkDevice dev, VkPipelineCache cache,
                             uint32_t count, const VkComputePipelineCreateInfo *cis,
                             const VkAllocationCallbacks *alloc, VkPipeline *out) {
    for (uint32_t i = 0; i < count; i++) {
        WebXBuf buf; webx_buf_init(&buf);
        uint64_t h = webx_new_handle();
        webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)dev);
        webx_buf_push_u64(&buf, h);
        webx_buf_push_u32(&buf, 1); /* type = compute */
        webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)cis[i].layout);
        webx_buf_push_u32(&buf, cis[i].stage.stage);
        webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)cis[i].stage.module);
        uint32_t nmlen = (uint32_t)strlen(cis[i].stage.pName) + 1;
        webx_buf_push_u32(&buf, nmlen);
        webx_buf_write(&buf, cis[i].stage.pName, nmlen);
        VkResult r = webx_call(WEBX_CMD_CREATE_COMPUTE_PIPELINE,
                               buf.data, (uint32_t)buf.len, NULL, NULL);
        webx_buf_free(&buf);
        if (r != VK_SUCCESS) return r;
        out[i] = (VkPipeline)(uintptr_t)h;
    }
    return VK_SUCCESS;
}

VKAPI_ATTR void VKAPI_CALL
webx_DestroyPipeline(VkDevice dev, VkPipeline p, const VkAllocationCallbacks *a) {
    uint64_t h = (uint64_t)(uintptr_t)p;
    webx_send(WEBX_CMD_DESTROY_PIPELINE, &h, 8);
}

/* Pipeline cache — stub (host manages its own cache) */
VKAPI_ATTR VkResult VKAPI_CALL
webx_CreatePipelineCache(VkDevice dev, const VkPipelineCacheCreateInfo *ci,
                         const VkAllocationCallbacks *a, VkPipelineCache *out) {
    *out = (VkPipelineCache)webx_new_handle(); return VK_SUCCESS;
}
VKAPI_ATTR void VKAPI_CALL
webx_DestroyPipelineCache(VkDevice dev, VkPipelineCache pc,
                           const VkAllocationCallbacks *a) { }
VKAPI_ATTR VkResult VKAPI_CALL
webx_GetPipelineCacheData(VkDevice dev, VkPipelineCache pc, size_t *sz, void *data) {
    *sz = 0; return VK_SUCCESS;
}
VKAPI_ATTR VkResult VKAPI_CALL
webx_MergePipelineCaches(VkDevice dev, VkPipelineCache dst, uint32_t n,
                          const VkPipelineCache *srcs) { return VK_SUCCESS; }

/* ── Render pass ─────────────────────────────────────────────────────── */

VKAPI_ATTR VkResult VKAPI_CALL
webx_CreateRenderPass(VkDevice dev, const VkRenderPassCreateInfo *ci,
                      const VkAllocationCallbacks *alloc, VkRenderPass *out) {
    WebXBuf buf; webx_buf_init(&buf);
    uint64_t h = webx_new_handle();
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)dev);
    webx_buf_push_u64(&buf, h);
    webx_buf_push_u32(&buf, ci->attachmentCount);
    webx_buf_write(&buf, ci->pAttachments,
                   ci->attachmentCount * sizeof(VkAttachmentDescription));
    webx_buf_push_u32(&buf, ci->subpassCount);
    for (uint32_t i = 0; i < ci->subpassCount; i++) {
        const VkSubpassDescription *sp = &ci->pSubpasses[i];
        webx_buf_push_u32(&buf, sp->pipelineBindPoint);
        webx_buf_push_u32(&buf, sp->inputAttachmentCount);
        webx_buf_write(&buf, sp->pInputAttachments,
                       sp->inputAttachmentCount * sizeof(VkAttachmentReference));
        webx_buf_push_u32(&buf, sp->colorAttachmentCount);
        webx_buf_write(&buf, sp->pColorAttachments,
                       sp->colorAttachmentCount * sizeof(VkAttachmentReference));
        uint32_t has_ds = (sp->pDepthStencilAttachment != NULL) ? 1 : 0;
        webx_buf_push_u32(&buf, has_ds);
        if (has_ds) webx_buf_write(&buf, sp->pDepthStencilAttachment,
                                   sizeof(VkAttachmentReference));
    }
    webx_buf_push_u32(&buf, ci->dependencyCount);
    webx_buf_write(&buf, ci->pDependencies,
                   ci->dependencyCount * sizeof(VkSubpassDependency));
    VkResult r = webx_call(WEBX_CMD_CREATE_RENDER_PASS, buf.data, (uint32_t)buf.len, NULL, NULL);
    webx_buf_free(&buf);
    if (r == VK_SUCCESS) *out = (VkRenderPass)(uintptr_t)h;
    return r;
}

VKAPI_ATTR void VKAPI_CALL
webx_DestroyRenderPass(VkDevice dev, VkRenderPass rp, const VkAllocationCallbacks *a) {
    uint64_t h = (uint64_t)(uintptr_t)rp;
    webx_send(WEBX_CMD_DESTROY_RENDER_PASS, &h, 8);
}

VKAPI_ATTR VkResult VKAPI_CALL
webx_CreateFramebuffer(VkDevice dev, const VkFramebufferCreateInfo *ci,
                       const VkAllocationCallbacks *alloc, VkFramebuffer *out) {
    WebXBuf buf; webx_buf_init(&buf);
    uint64_t h = webx_new_handle();
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)dev);
    webx_buf_push_u64(&buf, h);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)ci->renderPass);
    webx_buf_push_u32(&buf, ci->attachmentCount);
    for (uint32_t i = 0; i < ci->attachmentCount; i++)
        webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)ci->pAttachments[i]);
    webx_buf_push_u32(&buf, ci->width);
    webx_buf_push_u32(&buf, ci->height);
    webx_buf_push_u32(&buf, ci->layers);
    VkResult r = webx_call(WEBX_CMD_CREATE_FRAMEBUFFER, buf.data, (uint32_t)buf.len, NULL, NULL);
    webx_buf_free(&buf);
    if (r == VK_SUCCESS) *out = (VkFramebuffer)(uintptr_t)h;
    return r;
}

VKAPI_ATTR void VKAPI_CALL
webx_DestroyFramebuffer(VkDevice dev, VkFramebuffer fb, const VkAllocationCallbacks *a) {
    uint64_t h = (uint64_t)(uintptr_t)fb;
    webx_send(WEBX_CMD_DESTROY_FRAMEBUFFER, &h, 8);
}

/* ── Descriptors ─────────────────────────────────────────────────────── */

VKAPI_ATTR VkResult VKAPI_CALL
webx_CreateDescriptorSetLayout(VkDevice dev, const VkDescriptorSetLayoutCreateInfo *ci,
                                const VkAllocationCallbacks *alloc,
                                VkDescriptorSetLayout *out) {
    WebXBuf buf; webx_buf_init(&buf);
    uint64_t h = webx_new_handle();
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)dev);
    webx_buf_push_u64(&buf, h);
    webx_buf_push_u32(&buf, ci->bindingCount);
    webx_buf_write(&buf, ci->pBindings,
                   ci->bindingCount * sizeof(VkDescriptorSetLayoutBinding));
    VkResult r = webx_call(WEBX_CMD_CREATE_DESCRIPTOR_SET_LAYOUT,
                           buf.data, (uint32_t)buf.len, NULL, NULL);
    webx_buf_free(&buf);
    if (r == VK_SUCCESS) *out = (VkDescriptorSetLayout)(uintptr_t)h;
    return r;
}

VKAPI_ATTR void VKAPI_CALL
webx_DestroyDescriptorSetLayout(VkDevice dev, VkDescriptorSetLayout dsl,
                                 const VkAllocationCallbacks *a) {
    uint64_t h = (uint64_t)(uintptr_t)dsl;
    webx_send(WEBX_CMD_DESTROY_DESCRIPTOR_SET_LAYOUT, &h, 8);
}

VKAPI_ATTR VkResult VKAPI_CALL
webx_CreateDescriptorPool(VkDevice dev, const VkDescriptorPoolCreateInfo *ci,
                          const VkAllocationCallbacks *alloc, VkDescriptorPool *out) {
    WebXBuf buf; webx_buf_init(&buf);
    uint64_t h = webx_new_handle();
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)dev);
    webx_buf_push_u64(&buf, h);
    webx_buf_push_u32(&buf, ci->maxSets);
    webx_buf_push_u32(&buf, ci->flags);
    webx_buf_push_u32(&buf, ci->poolSizeCount);
    webx_buf_write(&buf, ci->pPoolSizes, ci->poolSizeCount * sizeof(VkDescriptorPoolSize));
    VkResult r = webx_call(WEBX_CMD_CREATE_DESCRIPTOR_POOL, buf.data, (uint32_t)buf.len, NULL, NULL);
    webx_buf_free(&buf);
    if (r == VK_SUCCESS) *out = (VkDescriptorPool)(uintptr_t)h;
    return r;
}

VKAPI_ATTR VkResult VKAPI_CALL
webx_ResetDescriptorPool(VkDevice dev, VkDescriptorPool pool, VkDescriptorPoolResetFlags f) {
    WebXBuf buf; webx_buf_init(&buf);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)dev);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)pool);
    VkResult r = webx_call(WEBX_CMD_RESET_DESCRIPTOR_POOL, buf.data, (uint32_t)buf.len, NULL, NULL);
    webx_buf_free(&buf);
    return r;
}

VKAPI_ATTR VkResult VKAPI_CALL
webx_AllocateDescriptorSets(VkDevice dev, const VkDescriptorSetAllocateInfo *ai,
                             VkDescriptorSet *out) {
    WebXBuf buf; webx_buf_init(&buf);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)dev);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)ai->descriptorPool);
    webx_buf_push_u32(&buf, ai->descriptorSetCount);
    uint64_t handles[ai->descriptorSetCount];
    for (uint32_t i = 0; i < ai->descriptorSetCount; i++) {
        handles[i] = webx_new_handle();
        webx_buf_push_u64(&buf, handles[i]);
        webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)ai->pSetLayouts[i]);
    }
    VkResult r = webx_call(WEBX_CMD_ALLOCATE_DESCRIPTOR_SETS,
                           buf.data, (uint32_t)buf.len, NULL, NULL);
    webx_buf_free(&buf);
    if (r == VK_SUCCESS)
        for (uint32_t i = 0; i < ai->descriptorSetCount; i++)
            out[i] = (VkDescriptorSet)(uintptr_t)handles[i];
    return r;
}

VKAPI_ATTR void VKAPI_CALL
webx_UpdateDescriptorSets(VkDevice dev, uint32_t writeCount,
                          const VkWriteDescriptorSet *writes,
                          uint32_t copyCount, const VkCopyDescriptorSet *copies) {
    WebXBuf buf; webx_buf_init(&buf);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)dev);
    webx_buf_push_u32(&buf, writeCount);
    for (uint32_t i = 0; i < writeCount; i++) {
        const VkWriteDescriptorSet *w = &writes[i];
        webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)w->dstSet);
        webx_buf_push_u32(&buf, w->dstBinding);
        webx_buf_push_u32(&buf, w->dstArrayElement);
        webx_buf_push_u32(&buf, w->descriptorCount);
        webx_buf_push_u32(&buf, w->descriptorType);
        switch (w->descriptorType) {
        case VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER:
        case VK_DESCRIPTOR_TYPE_STORAGE_BUFFER:
        case VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER_DYNAMIC:
        case VK_DESCRIPTOR_TYPE_STORAGE_BUFFER_DYNAMIC:
            for (uint32_t j = 0; j < w->descriptorCount; j++) {
                webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)w->pBufferInfo[j].buffer);
                webx_buf_push_u64(&buf, (uint64_t)w->pBufferInfo[j].offset);
                webx_buf_push_u64(&buf, (uint64_t)w->pBufferInfo[j].range);
            }
            break;
        case VK_DESCRIPTOR_TYPE_SAMPLED_IMAGE:
        case VK_DESCRIPTOR_TYPE_STORAGE_IMAGE:
        case VK_DESCRIPTOR_TYPE_INPUT_ATTACHMENT:
            for (uint32_t j = 0; j < w->descriptorCount; j++) {
                webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)w->pImageInfo[j].sampler);
                webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)w->pImageInfo[j].imageView);
                webx_buf_push_u32(&buf, w->pImageInfo[j].imageLayout);
            }
            break;
        case VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER:
            for (uint32_t j = 0; j < w->descriptorCount; j++) {
                webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)w->pImageInfo[j].sampler);
                webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)w->pImageInfo[j].imageView);
                webx_buf_push_u32(&buf, w->pImageInfo[j].imageLayout);
            }
            break;
        default:
            break;
        }
    }
    webx_send(WEBX_CMD_UPDATE_DESCRIPTOR_SETS, buf.data, (uint32_t)buf.len);
    webx_buf_free(&buf);
}

/* ── Render commands ─────────────────────────────────────────────────── */

VKAPI_ATTR void VKAPI_CALL
webx_CmdBeginRenderPass(VkCommandBuffer cb, const VkRenderPassBeginInfo *bi,
                         VkSubpassContents contents) {
    WebXBuf buf; webx_buf_init(&buf);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)cb);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)bi->renderPass);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)bi->framebuffer);
    webx_buf_push_u32(&buf, bi->renderArea.offset.x);
    webx_buf_push_u32(&buf, bi->renderArea.offset.y);
    webx_buf_push_u32(&buf, bi->renderArea.extent.width);
    webx_buf_push_u32(&buf, bi->renderArea.extent.height);
    webx_buf_push_u32(&buf, bi->clearValueCount);
    webx_buf_write(&buf, bi->pClearValues, bi->clearValueCount * sizeof(VkClearValue));
    webx_buf_push_u32(&buf, contents);
    webx_send(WEBX_CMD_CMD_BEGIN_RENDER_PASS, buf.data, (uint32_t)buf.len);
    webx_buf_free(&buf);
}

VKAPI_ATTR void VKAPI_CALL
webx_CmdEndRenderPass(VkCommandBuffer cb) {
    uint64_t h = (uint64_t)(uintptr_t)cb;
    webx_send(WEBX_CMD_CMD_END_RENDER_PASS, &h, 8);
}

VKAPI_ATTR void VKAPI_CALL
webx_CmdBeginRendering(VkCommandBuffer cb, const VkRenderingInfo *ri) {
    WebXBuf buf; webx_buf_init(&buf);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)cb);
    webx_buf_push_u32(&buf, ri->renderArea.offset.x);
    webx_buf_push_u32(&buf, ri->renderArea.offset.y);
    webx_buf_push_u32(&buf, ri->renderArea.extent.width);
    webx_buf_push_u32(&buf, ri->renderArea.extent.height);
    webx_buf_push_u32(&buf, ri->layerCount);
    webx_buf_push_u32(&buf, ri->colorAttachmentCount);
    for (uint32_t i = 0; i < ri->colorAttachmentCount; i++) {
        const VkRenderingAttachmentInfo *a = &ri->pColorAttachments[i];
        webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)a->imageView);
        webx_buf_push_u32(&buf, a->imageLayout);
        webx_buf_push_u32(&buf, a->loadOp);
        webx_buf_push_u32(&buf, a->storeOp);
        webx_buf_write(&buf, &a->clearValue, sizeof(VkClearValue));
    }
    uint32_t has_ds = (ri->pDepthAttachment != NULL) ? 1 : 0;
    webx_buf_push_u32(&buf, has_ds);
    if (has_ds) {
        const VkRenderingAttachmentInfo *d = ri->pDepthAttachment;
        webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)d->imageView);
        webx_buf_push_u32(&buf, d->imageLayout);
        webx_buf_push_u32(&buf, d->loadOp);
        webx_buf_push_u32(&buf, d->storeOp);
        webx_buf_write(&buf, &d->clearValue, sizeof(VkClearValue));
    }
    webx_send(WEBX_CMD_CMD_BEGIN_RENDERING, buf.data, (uint32_t)buf.len);
    webx_buf_free(&buf);
}

VKAPI_ATTR void VKAPI_CALL
webx_CmdEndRendering(VkCommandBuffer cb) {
    uint64_t h = (uint64_t)(uintptr_t)cb;
    webx_send(WEBX_CMD_CMD_END_RENDERING, &h, 8);
}

VKAPI_ATTR void VKAPI_CALL
webx_CmdBindVertexBuffers(VkCommandBuffer cb, uint32_t first, uint32_t count,
                           const VkBuffer *bufs, const VkDeviceSize *offsets) {
    WebXBuf buf; webx_buf_init(&buf);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)cb);
    webx_buf_push_u32(&buf, first);
    webx_buf_push_u32(&buf, count);
    for (uint32_t i = 0; i < count; i++) {
        webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)bufs[i]);
        webx_buf_push_u64(&buf, (uint64_t)offsets[i]);
    }
    webx_send(WEBX_CMD_CMD_BIND_VERTEX_BUFFERS, buf.data, (uint32_t)buf.len);
    webx_buf_free(&buf);
}

VKAPI_ATTR void VKAPI_CALL
webx_CmdBindIndexBuffer(VkCommandBuffer cb, VkBuffer b, VkDeviceSize offset,
                         VkIndexType indexType) {
    WebXBuf buf; webx_buf_init(&buf);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)cb);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)b);
    webx_buf_push_u64(&buf, (uint64_t)offset);
    webx_buf_push_u32(&buf, indexType);
    webx_send(WEBX_CMD_CMD_BIND_INDEX_BUFFER, buf.data, (uint32_t)buf.len);
    webx_buf_free(&buf);
}

VKAPI_ATTR void VKAPI_CALL
webx_CmdBindDescriptorSets(VkCommandBuffer cb, VkPipelineBindPoint bp,
                            VkPipelineLayout layout, uint32_t firstSet,
                            uint32_t setCount, const VkDescriptorSet *sets,
                            uint32_t dynCount, const uint32_t *dynOffsets) {
    WebXBuf buf; webx_buf_init(&buf);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)cb);
    webx_buf_push_u32(&buf, bp);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)layout);
    webx_buf_push_u32(&buf, firstSet);
    webx_buf_push_u32(&buf, setCount);
    for (uint32_t i = 0; i < setCount; i++)
        webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)sets[i]);
    webx_buf_push_u32(&buf, dynCount);
    webx_buf_write(&buf, dynOffsets, dynCount * sizeof(uint32_t));
    webx_send(WEBX_CMD_CMD_BIND_DESCRIPTOR_SETS, buf.data, (uint32_t)buf.len);
    webx_buf_free(&buf);
}

VKAPI_ATTR void VKAPI_CALL
webx_CmdPushConstants(VkCommandBuffer cb, VkPipelineLayout layout,
                      VkShaderStageFlags stages, uint32_t offset,
                      uint32_t size, const void *data) {
    WebXBuf buf; webx_buf_init(&buf);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)cb);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)layout);
    webx_buf_push_u32(&buf, stages);
    webx_buf_push_u32(&buf, offset);
    webx_buf_push_u32(&buf, size);
    webx_buf_write(&buf, data, size);
    webx_send(WEBX_CMD_CMD_PUSH_CONSTANTS, buf.data, (uint32_t)buf.len);
    webx_buf_free(&buf);
}

VKAPI_ATTR void VKAPI_CALL
webx_CmdDrawIndirect(VkCommandBuffer cb, VkBuffer b, VkDeviceSize off,
                     uint32_t count, uint32_t stride) {
    WebXBuf buf; webx_buf_init(&buf);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)cb);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)b);
    webx_buf_push_u64(&buf, (uint64_t)off);
    webx_buf_push_u32(&buf, count);
    webx_buf_push_u32(&buf, stride);
    webx_send(WEBX_CMD_CMD_DRAW_INDIRECT, buf.data, (uint32_t)buf.len);
    webx_buf_free(&buf);
}

VKAPI_ATTR void VKAPI_CALL
webx_CmdDrawIndexedIndirect(VkCommandBuffer cb, VkBuffer b, VkDeviceSize off,
                             uint32_t count, uint32_t stride) {
    WebXBuf buf; webx_buf_init(&buf);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)cb);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)b);
    webx_buf_push_u64(&buf, (uint64_t)off);
    webx_buf_push_u32(&buf, count);
    webx_buf_push_u32(&buf, stride);
    webx_send(WEBX_CMD_CMD_DRAW_INDEXED_INDIRECT, buf.data, (uint32_t)buf.len);
    webx_buf_free(&buf);
}

VKAPI_ATTR void VKAPI_CALL
webx_CmdDispatch(VkCommandBuffer cb, uint32_t x, uint32_t y, uint32_t z) {
    WebXBuf buf; webx_buf_init(&buf);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)cb);
    webx_buf_push_u32(&buf, x); webx_buf_push_u32(&buf, y); webx_buf_push_u32(&buf, z);
    webx_send(WEBX_CMD_CMD_DISPATCH, buf.data, (uint32_t)buf.len);
    webx_buf_free(&buf);
}

VKAPI_ATTR void VKAPI_CALL
webx_CmdDispatchIndirect(VkCommandBuffer cb, VkBuffer b, VkDeviceSize off) {
    WebXBuf buf; webx_buf_init(&buf);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)cb);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)b);
    webx_buf_push_u64(&buf, (uint64_t)off);
    webx_send(WEBX_CMD_CMD_DISPATCH_INDIRECT, buf.data, (uint32_t)buf.len);
    webx_buf_free(&buf);
}

VKAPI_ATTR void VKAPI_CALL
webx_CmdSetBlendConstants(VkCommandBuffer cb, const float bc[4]) {
    WebXBuf buf; webx_buf_init(&buf);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)cb);
    webx_buf_push_f32(&buf, bc[0]); webx_buf_push_f32(&buf, bc[1]);
    webx_buf_push_f32(&buf, bc[2]); webx_buf_push_f32(&buf, bc[3]);
    webx_send(WEBX_CMD_CMD_SET_BLEND_CONSTANTS, buf.data, (uint32_t)buf.len);
    webx_buf_free(&buf);
}

VKAPI_ATTR void VKAPI_CALL
webx_CmdSetStencilReference(VkCommandBuffer cb, VkStencilFaceFlags f, uint32_t ref) {
    WebXBuf buf; webx_buf_init(&buf);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)cb);
    webx_buf_push_u32(&buf, f); webx_buf_push_u32(&buf, ref);
    webx_send(WEBX_CMD_CMD_SET_STENCIL_REFERENCE, buf.data, (uint32_t)buf.len);
    webx_buf_free(&buf);
}

VKAPI_ATTR void VKAPI_CALL
webx_CmdSetDepthBias(VkCommandBuffer cb, float dcf, float dcc, float dsf) {
    WebXBuf buf; webx_buf_init(&buf);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)cb);
    webx_buf_push_f32(&buf, dcf); webx_buf_push_f32(&buf, dcc); webx_buf_push_f32(&buf, dsf);
    webx_send(WEBX_CMD_CMD_SET_DEPTH_BIAS, buf.data, (uint32_t)buf.len);
    webx_buf_free(&buf);
}

VKAPI_ATTR void VKAPI_CALL
webx_CmdSetLineWidth(VkCommandBuffer cb, float w) {
    WebXBuf buf; webx_buf_init(&buf);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)cb);
    webx_buf_push_f32(&buf, w);
    webx_send(WEBX_CMD_CMD_SET_LINE_WIDTH, buf.data, (uint32_t)buf.len);
    webx_buf_free(&buf);
}

/* Dynamic state (VK_EXT_extended_dynamic_state) */
VKAPI_ATTR void VKAPI_CALL
webx_CmdSetCullModeEXT(VkCommandBuffer cb, VkCullModeFlags m) {
    WebXBuf buf; webx_buf_init(&buf);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)cb);
    webx_buf_push_u32(&buf, m);
    webx_send(WEBX_CMD_CMD_SET_CULL_MODE, buf.data, (uint32_t)buf.len);
    webx_buf_free(&buf);
}

VKAPI_ATTR void VKAPI_CALL
webx_CmdSetFrontFaceEXT(VkCommandBuffer cb, VkFrontFace f) {
    WebXBuf buf; webx_buf_init(&buf);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)cb);
    webx_buf_push_u32(&buf, f);
    webx_send(WEBX_CMD_CMD_SET_FRONT_FACE, buf.data, (uint32_t)buf.len);
    webx_buf_free(&buf);
}

VKAPI_ATTR void VKAPI_CALL
webx_CmdSetPrimitiveTopologyEXT(VkCommandBuffer cb, VkPrimitiveTopology t) {
    WebXBuf buf; webx_buf_init(&buf);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)cb);
    webx_buf_push_u32(&buf, t);
    webx_send(WEBX_CMD_CMD_SET_PRIMITIVE_TOPOLOGY, buf.data, (uint32_t)buf.len);
    webx_buf_free(&buf);
}

/* Semaphores */
VKAPI_ATTR VkResult VKAPI_CALL
webx_CreateSemaphore(VkDevice dev, const VkSemaphoreCreateInfo *ci,
                     const VkAllocationCallbacks *a, VkSemaphore *out) {
    WebXBuf buf; webx_buf_init(&buf);
    uint64_t h = webx_new_handle();
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)dev);
    webx_buf_push_u64(&buf, h);
    webx_buf_push_u32(&buf, 0); /* binary semaphore */
    VkResult r = webx_call(WEBX_CMD_CREATE_SEMAPHORE, buf.data, (uint32_t)buf.len, NULL, NULL);
    webx_buf_free(&buf);
    if (r == VK_SUCCESS) *out = (VkSemaphore)(uintptr_t)h;
    return r;
}

VKAPI_ATTR void VKAPI_CALL
webx_DestroySemaphore(VkDevice dev, VkSemaphore sem, const VkAllocationCallbacks *a) {
    uint64_t h = (uint64_t)(uintptr_t)sem;
    webx_send(WEBX_CMD_DESTROY_SEMAPHORE, &h, 8);
}

VKAPI_ATTR VkResult VKAPI_CALL
webx_QueueWaitIdle(VkQueue q) {
    uint64_t h = (uint64_t)(uintptr_t)q;
    return webx_call(WEBX_CMD_QUEUE_WAIT_IDLE, &h, 8, NULL, NULL);
}

VKAPI_ATTR VkResult VKAPI_CALL
webx_FreeCommandBuffers_impl(VkDevice dev, VkCommandPool pool,
                              uint32_t count, const VkCommandBuffer *cbs) {
    WebXBuf buf; webx_buf_init(&buf);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)dev);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)pool);
    webx_buf_push_u32(&buf, count);
    for (uint32_t i = 0; i < count; i++)
        webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)cbs[i]);
    webx_send(WEBX_CMD_FREE_COMMAND_BUFFERS, buf.data, (uint32_t)buf.len);
    webx_buf_free(&buf);
    return VK_SUCCESS;
}

VKAPI_ATTR VkResult VKAPI_CALL
webx_ResetCommandBuffer(VkCommandBuffer cb, VkCommandBufferResetFlags flags) {
    WebXBuf buf; webx_buf_init(&buf);
    webx_buf_push_u64(&buf, (uint64_t)(uintptr_t)cb);
    webx_buf_push_u32(&buf, flags);
    webx_send(WEBX_CMD_RESET_COMMAND_BUFFER, buf.data, (uint32_t)buf.len);
    webx_buf_free(&buf);
    return VK_SUCCESS;
}
