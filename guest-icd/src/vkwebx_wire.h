#pragma once
/*
 * WebX guest ICD — wire helpers
 * Serialization/deserialization for the VkWebX protocol.
 */

#include "../../protocol/commands.h"
#include <stddef.h>
#include <string.h>
#include <stdlib.h>
#include <unistd.h>

/* ── Simple write buffer ─────────────────────────────────────────────── */

typedef struct {
    uint8_t *data;
    size_t   len;
    size_t   cap;
} WebXBuf;

static inline void webx_buf_init(WebXBuf *b) {
    b->cap  = 256;
    b->data = malloc(b->cap);
    b->len  = 0;
}

static inline void webx_buf_free(WebXBuf *b) {
    free(b->data);
    b->data = NULL;
    b->len = b->cap = 0;
}

static inline void webx_buf_grow(WebXBuf *b, size_t need) {
    while (b->len + need > b->cap) b->cap *= 2;
    b->data = realloc(b->data, b->cap);
}

static inline void webx_buf_write(WebXBuf *b, const void *src, size_t n) {
    webx_buf_grow(b, n);
    memcpy(b->data + b->len, src, n);
    b->len += n;
}

#define webx_buf_push_u32(b, v) do { uint32_t _v = (v); webx_buf_write(b, &_v, 4); } while(0)
#define webx_buf_push_u64(b, v) do { uint64_t _v = (v); webx_buf_write(b, &_v, 8); } while(0)
#define webx_buf_push_i32(b, v) do { int32_t  _v = (v); webx_buf_write(b, &_v, 4); } while(0)
#define webx_buf_push_f32(b, v) do { float    _v = (v); webx_buf_write(b, &_v, 4); } while(0)

/* ── Packet builder ──────────────────────────────────────────────────── */

/*
 * Build a complete packet (header + payload) ready to write to /dev/webgpu.
 * Caller owns the returned malloc'd buffer; free with webx_packet_free().
 */
static inline uint8_t *webx_packet_build(VkWebXCmd cmd, uint32_t seq,
                                          const void *payload, uint32_t payload_len,
                                          size_t *out_total) {
    size_t total = sizeof(WebXPacketHeader) + payload_len;
    uint8_t *buf = malloc(total);

    WebXPacketHeader *hdr = (WebXPacketHeader *)buf;
    hdr->magic = WEBX_MAGIC;
    hdr->cmd   = (uint32_t)cmd;
    hdr->seq   = seq;
    hdr->len   = payload_len;

    if (payload_len && payload)
        memcpy(buf + sizeof(WebXPacketHeader), payload, payload_len);

    *out_total = total;
    return buf;
}

static inline void webx_packet_free(uint8_t *pkt) { free(pkt); }

/* ── Response reader ─────────────────────────────────────────────────── */

typedef struct {
    int32_t  result;
    uint8_t *data;    /* malloc'd, caller frees; NULL if len==0 */
    uint32_t len;
} WebXResponse;

/*
 * Read a full response from fd (blocks until data available).
 * Returns 0 on success, -1 on read error.
 */
static inline int webx_read_response(int fd, uint32_t expected_seq, WebXResponse *out) {
    WebXResponseHeader hdr;
    ssize_t n;

    /* Read header */
    size_t remaining = sizeof(hdr);
    uint8_t *p = (uint8_t *)&hdr;
    while (remaining > 0) {
        n = read(fd, p, remaining);
        if (n <= 0) return -1;
        p += n; remaining -= n;
    }

    (void)expected_seq; /* TODO: validate seq in debug builds */

    out->result = hdr.result;
    out->len    = hdr.len;
    out->data   = NULL;

    if (hdr.len == 0) return 0;

    out->data = malloc(hdr.len);
    remaining = hdr.len;
    p = out->data;
    while (remaining > 0) {
        n = read(fd, p, remaining);
        if (n <= 0) { free(out->data); out->data = NULL; return -1; }
        p += n; remaining -= n;
    }
    return 0;
}

static inline void webx_response_free(WebXResponse *r) {
    free(r->data);
    r->data = NULL;
}

/* ── Handle counter ──────────────────────────────────────────────────── */

#include <stdatomic.h>
static atomic_uint_fast64_t webx_handle_counter = 1;

static inline uint64_t webx_new_handle(void) {
    return atomic_fetch_add(&webx_handle_counter, 1);
}
