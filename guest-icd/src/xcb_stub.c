/*
 * libxcb_stub.c — Fake XCB implementation for DXVK/Wine inside Canary.
 *
 * When LD_PRELOAD'd, this replaces the real libxcb.so.1 so that
 * DXVK and Wine can create "X11" windows without a real X server.
 * The vkwebx ICD (vkwebx_surface.c) ignores xcb connection/window
 * values entirely — so returning fake handles is sufficient.
 *
 * Supported:
 *   - xcb_connect / xcb_disconnect / xcb_connection_has_error
 *   - xcb_generate_id, xcb_get_setup, xcb_setup_roots_iterator
 *   - xcb_create_window, xcb_map_window, xcb_change_property
 *   - xcb_intern_atom, xcb_get_geometry
 *   - xcb_get_extension_data (always reports "not present" → DXVK falls back)
 *   - xcb_poll_for_event → NULL  (no events, non-blocking)
 *   - xcb_wait_for_event  → NULL  (no events, returns immediately)
 */
#define _GNU_SOURCE
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

/* ── Minimal xcb type definitions (mirrors xcb/xcb.h + xcb/xproto.h) ────── */

typedef struct xcb_connection_t { int fd; int err; } xcb_connection_t;
typedef uint32_t xcb_window_t;
typedef uint32_t xcb_visualid_t;
typedef uint32_t xcb_colormap_t;
typedef uint32_t xcb_atom_t;
typedef struct { uint32_t sequence; } xcb_void_cookie_t;
typedef struct { uint32_t sequence; } xcb_intern_atom_cookie_t;
typedef struct { uint32_t sequence; } xcb_get_geometry_cookie_t;
typedef struct { uint32_t sequence; } xcb_query_tree_cookie_t;
typedef struct { uint32_t sequence; } xcb_get_window_attributes_cookie_t;

typedef struct {
    uint8_t  response_type;
    uint8_t  error_code;
    uint16_t sequence;
    uint32_t resource_id;
    uint16_t minor_code;
    uint8_t  major_code;
    uint8_t  pad0;
    uint32_t pad[5];
    uint32_t full_sequence;
} xcb_generic_error_t;

/* xcb_screen_t (40 bytes) — layout matches X11 protocol */
typedef struct {
    xcb_window_t   root;
    xcb_colormap_t default_colormap;
    uint32_t       white_pixel;
    uint32_t       black_pixel;
    uint32_t       current_input_masks;
    uint16_t       width_in_pixels;
    uint16_t       height_in_pixels;
    uint16_t       width_in_millimeters;
    uint16_t       height_in_millimeters;
    uint16_t       min_installed_maps;
    uint16_t       max_installed_maps;
    xcb_visualid_t root_visual;
    uint8_t        backing_stores;
    uint8_t        save_unders;
    uint8_t        root_depth;
    uint8_t        allowed_depths_len;
} xcb_screen_t;

typedef struct {
    xcb_screen_t *data;
    int           rem;
    int           index;
} xcb_screen_iterator_t;

/* xcb_setup_t — minimal header, enough for roots_iterator to function */
typedef struct {
    uint8_t  status;
    uint8_t  pad0;
    uint16_t protocol_major_version;
    uint16_t protocol_minor_version;
    uint16_t length;
    uint32_t release_number;
    uint32_t resource_id_base;
    uint32_t resource_id_mask;
    uint32_t motion_buffer_size;
    uint16_t vendor_len;
    uint16_t maximum_request_length;
    uint8_t  roots_len;
    uint8_t  pixmap_formats_len;
    uint8_t  image_byte_order;
    uint8_t  bitmap_format_bit_order;
    uint8_t  bitmap_format_scanline_unit;
    uint8_t  bitmap_format_scanline_pad;
    uint8_t  min_keycode;
    uint8_t  max_keycode;
    uint8_t  pad1[4];
} xcb_setup_t;

typedef struct {
    uint8_t    response_type;
    uint8_t    pad0;
    uint16_t   sequence;
    uint32_t   length;
    xcb_atom_t atom;
} xcb_intern_atom_reply_t;

typedef struct {
    uint8_t      response_type;
    uint8_t      depth;
    uint16_t     sequence;
    uint32_t     length;
    xcb_window_t root;
    int16_t      x;
    int16_t      y;
    uint16_t     width;
    uint16_t     height;
    uint16_t     border_width;
    uint8_t      pad0[2];
} xcb_get_geometry_reply_t;

typedef struct {
    uint8_t  response_type;
    uint8_t  pad0;
    uint16_t sequence;
    uint32_t length;
    uint8_t  present;
    uint8_t  major_opcode;
    uint8_t  first_event;
    uint8_t  first_error;
} xcb_query_extension_reply_t;

typedef struct {
    uint8_t      response_type;
    uint8_t      pad0;
    uint16_t     sequence;
    uint32_t     length;
    xcb_window_t root;
    xcb_window_t parent;
    uint16_t     children_len;
    uint8_t      pad1[14];
} xcb_query_tree_reply_t;

typedef struct {
    uint8_t      response_type;
    uint8_t      backing_store;
    uint16_t     sequence;
    uint32_t     length;
    xcb_visualid_t visual;
    uint16_t     _class;
    uint8_t      bit_gravity;
    uint8_t      win_gravity;
    uint32_t     backing_planes;
    uint32_t     backing_pixel;
    uint8_t      save_under;
    uint8_t      map_is_installed;
    uint8_t      map_state;
    uint8_t      override_redirect;
    xcb_colormap_t colormap;
    uint32_t     all_event_masks;
    uint32_t     your_event_mask;
    uint16_t     do_not_propagate_mask;
    uint8_t      pad0[2];
} xcb_get_window_attributes_reply_t;

/* ── Static globals ──────────────────────────────────────────────────────── */

static xcb_connection_t _conn = { 3, 0 };

static xcb_screen_t _screen = {
    .root                  = 0x00010001,
    .default_colormap      = 0x00020001,
    .white_pixel           = 0x00FFFFFF,
    .black_pixel           = 0x00000000,
    .current_input_masks   = 0,
    .width_in_pixels       = 1024,
    .height_in_pixels      = 768,
    .width_in_millimeters  = 271,
    .height_in_millimeters = 203,
    .min_installed_maps    = 1,
    .max_installed_maps    = 1,
    .root_visual           = 0x00030001,
    .backing_stores        = 0,
    .save_unders           = 0,
    .root_depth            = 24,
    .allowed_depths_len    = 1,
};

static xcb_setup_t _setup = {
    .status                    = 1,
    .protocol_major_version    = 11,
    .protocol_minor_version    = 0,
    .length                    = 10,
    .release_number            = 12001000,
    .resource_id_base          = 0x00100000,
    .resource_id_mask          = 0x001FFFFF,
    .vendor_len                = 0,
    .maximum_request_length    = 65535,
    .roots_len                 = 1,
    .pixmap_formats_len        = 1,
    .image_byte_order          = 0,
    .bitmap_format_bit_order   = 0,
    .bitmap_format_scanline_unit = 32,
    .bitmap_format_scanline_pad  = 32,
    .min_keycode               = 8,
    .max_keycode               = 255,
};

/* All extensions report "not present" → DXVK falls back to non-present path */
static const xcb_query_extension_reply_t _ext_not_present = { 1,0,0,0, 0,0,0,0 };

static uint32_t _next_id   = 0x00100001;
static uint32_t _next_atom = 256;
static uint32_t _next_seq  = 1;

/* ── Connection ──────────────────────────────────────────────────────────── */

xcb_connection_t *xcb_connect(const char *displayname, int *screenp)
{
    (void)displayname;
    if (screenp) *screenp = 0;
    return &_conn;
}

int  xcb_connection_has_error(xcb_connection_t *c) { (void)c; return 0; }
void xcb_disconnect(xcb_connection_t *c)            { (void)c; }
int  xcb_flush(xcb_connection_t *c)                 { (void)c; return 1; }
int  xcb_get_file_descriptor(xcb_connection_t *c)   { (void)c; return 3; }

uint32_t xcb_generate_id(xcb_connection_t *c) { (void)c; return _next_id++; }

const xcb_setup_t *xcb_get_setup(xcb_connection_t *c) { (void)c; return &_setup; }

xcb_screen_iterator_t xcb_setup_roots_iterator(const xcb_setup_t *R)
{
    (void)R;
    return (xcb_screen_iterator_t){ &_screen, 1, 0 };
}

void xcb_screen_next(xcb_screen_iterator_t *i) { i->data++; i->rem--; i->index++; }

/* ── Request check ───────────────────────────────────────────────────────── */

xcb_generic_error_t *xcb_request_check(xcb_connection_t *c, xcb_void_cookie_t cookie)
{
    (void)c; (void)cookie;
    return NULL; /* NULL = success */
}

void xcb_discard_reply(xcb_connection_t *c, unsigned int seq) { (void)c; (void)seq; }
void xcb_free_reply(void *reply) { free(reply); }

/* ── Window management ───────────────────────────────────────────────────── */

xcb_void_cookie_t xcb_create_window(xcb_connection_t *c, uint8_t depth,
    xcb_window_t wid, xcb_window_t parent, int16_t x, int16_t y,
    uint16_t w, uint16_t h, uint16_t bw, uint16_t cls, xcb_visualid_t vis,
    uint32_t mask, const void *list)
{
    (void)c;(void)depth;(void)wid;(void)parent;(void)x;(void)y;
    (void)w;(void)h;(void)bw;(void)cls;(void)vis;(void)mask;(void)list;
    return (xcb_void_cookie_t){_next_seq++};
}

xcb_void_cookie_t xcb_create_window_checked(xcb_connection_t *c, uint8_t depth,
    xcb_window_t wid, xcb_window_t parent, int16_t x, int16_t y,
    uint16_t w, uint16_t h, uint16_t bw, uint16_t cls, xcb_visualid_t vis,
    uint32_t mask, const void *list)
{
    return xcb_create_window(c, depth, wid, parent, x, y, w, h, bw, cls, vis, mask, list);
}

xcb_void_cookie_t xcb_destroy_window(xcb_connection_t *c, xcb_window_t w)
    { (void)c;(void)w; return (xcb_void_cookie_t){_next_seq++}; }

xcb_void_cookie_t xcb_map_window(xcb_connection_t *c, xcb_window_t w)
    { (void)c;(void)w; return (xcb_void_cookie_t){_next_seq++}; }

xcb_void_cookie_t xcb_map_window_checked(xcb_connection_t *c, xcb_window_t w)
    { return xcb_map_window(c, w); }

xcb_void_cookie_t xcb_unmap_window(xcb_connection_t *c, xcb_window_t w)
    { (void)c;(void)w; return (xcb_void_cookie_t){_next_seq++}; }

xcb_void_cookie_t xcb_change_window_attributes(xcb_connection_t *c, xcb_window_t w,
    uint32_t mask, const void *list)
    { (void)c;(void)w;(void)mask;(void)list; return (xcb_void_cookie_t){_next_seq++}; }

xcb_void_cookie_t xcb_change_window_attributes_checked(xcb_connection_t *c, xcb_window_t w,
    uint32_t mask, const void *list)
    { return xcb_change_window_attributes(c, w, mask, list); }

xcb_void_cookie_t xcb_configure_window(xcb_connection_t *c, xcb_window_t w,
    uint16_t mask, const void *list)
    { (void)c;(void)w;(void)mask;(void)list; return (xcb_void_cookie_t){_next_seq++}; }

xcb_void_cookie_t xcb_reparent_window(xcb_connection_t *c, xcb_window_t w,
    xcb_window_t p, int16_t x, int16_t y)
    { (void)c;(void)w;(void)p;(void)x;(void)y; return (xcb_void_cookie_t){_next_seq++}; }

/* ── Properties ──────────────────────────────────────────────────────────── */

xcb_void_cookie_t xcb_change_property(xcb_connection_t *c, uint8_t mode,
    xcb_window_t w, xcb_atom_t prop, xcb_atom_t type, uint8_t fmt,
    uint32_t len, const void *data)
{
    (void)c;(void)mode;(void)w;(void)prop;(void)type;(void)fmt;(void)len;(void)data;
    return (xcb_void_cookie_t){_next_seq++};
}

xcb_void_cookie_t xcb_delete_property(xcb_connection_t *c, xcb_window_t w, xcb_atom_t prop)
    { (void)c;(void)w;(void)prop; return (xcb_void_cookie_t){_next_seq++}; }

/* ── Atoms ───────────────────────────────────────────────────────────────── */

xcb_intern_atom_cookie_t xcb_intern_atom(xcb_connection_t *c, uint8_t only_if_exists,
    uint16_t name_len, const char *name)
    { (void)c;(void)only_if_exists;(void)name_len;(void)name;
      return (xcb_intern_atom_cookie_t){_next_seq++}; }

xcb_intern_atom_cookie_t xcb_intern_atom_unchecked(xcb_connection_t *c, uint8_t only_if_exists,
    uint16_t name_len, const char *name)
    { return xcb_intern_atom(c, only_if_exists, name_len, name); }

xcb_intern_atom_reply_t *xcb_intern_atom_reply(xcb_connection_t *c,
    xcb_intern_atom_cookie_t cookie, xcb_generic_error_t **e)
{
    (void)c; (void)cookie;
    if (e) *e = NULL;
    xcb_intern_atom_reply_t *r = calloc(1, sizeof(*r));
    if (r) r->atom = _next_atom++;
    return r;
}

/* ── Geometry ────────────────────────────────────────────────────────────── */

xcb_get_geometry_cookie_t xcb_get_geometry(xcb_connection_t *c, xcb_window_t w)
    { (void)c;(void)w; return (xcb_get_geometry_cookie_t){_next_seq++}; }

xcb_get_geometry_reply_t *xcb_get_geometry_reply(xcb_connection_t *c,
    xcb_get_geometry_cookie_t cookie, xcb_generic_error_t **e)
{
    (void)c; (void)cookie;
    if (e) *e = NULL;
    xcb_get_geometry_reply_t *r = calloc(1, sizeof(*r));
    if (r) {
        r->root   = _screen.root;
        r->depth  = _screen.root_depth;
        r->width  = _screen.width_in_pixels;
        r->height = _screen.height_in_pixels;
    }
    return r;
}

/* ── Query tree ──────────────────────────────────────────────────────────── */

xcb_query_tree_cookie_t xcb_query_tree(xcb_connection_t *c, xcb_window_t w)
    { (void)c;(void)w; return (xcb_query_tree_cookie_t){_next_seq++}; }

xcb_query_tree_reply_t *xcb_query_tree_reply(xcb_connection_t *c,
    xcb_query_tree_cookie_t cookie, xcb_generic_error_t **e)
{
    (void)c; (void)cookie;
    if (e) *e = NULL;
    return calloc(1, sizeof(xcb_query_tree_reply_t));
}

xcb_window_t *xcb_query_tree_children(xcb_query_tree_reply_t *R) { (void)R; return NULL; }
int xcb_query_tree_children_length(xcb_query_tree_reply_t *R) { (void)R; return 0; }

/* ── Window attributes ───────────────────────────────────────────────────── */

xcb_get_window_attributes_cookie_t xcb_get_window_attributes(xcb_connection_t *c, xcb_window_t w)
    { (void)c;(void)w; return (xcb_get_window_attributes_cookie_t){_next_seq++}; }

xcb_get_window_attributes_reply_t *xcb_get_window_attributes_reply(xcb_connection_t *c,
    xcb_get_window_attributes_cookie_t cookie, xcb_generic_error_t **e)
{
    (void)c; (void)cookie;
    if (e) *e = NULL;
    xcb_get_window_attributes_reply_t *r = calloc(1, sizeof(*r));
    if (r) {
        r->visual      = _screen.root_visual;
        r->_class      = 1; /* InputOutput */
        r->map_state   = 2; /* IsViewable */
        r->colormap    = _screen.default_colormap;
    }
    return r;
}

/* ── Events ──────────────────────────────────────────────────────────────── */

void *xcb_poll_for_event(xcb_connection_t *c)   { (void)c; return NULL; }
void *xcb_wait_for_event(xcb_connection_t *c)   { (void)c; return NULL; }
void *xcb_poll_for_queued_event(xcb_connection_t *c) { (void)c; return NULL; }

/* ── Extensions — all reported as "not present" ─────────────────────────── */

const xcb_query_extension_reply_t *xcb_get_extension_data(xcb_connection_t *c, void *ext)
    { (void)c;(void)ext; return &_ext_not_present; }

/* xcb_send_request — catch any remaining raw requests */
int xcb_send_request(xcb_connection_t *c, int flags, void *vector, const void *request)
    { (void)c;(void)flags;(void)vector;(void)request; return (int)_next_seq++; }

unsigned int xcb_get_maximum_request_length(xcb_connection_t *c)
    { (void)c; return 65535; }

/* Prefetch — used by DXVK for async extension queries; stub as no-op */
void xcb_prefetch_extension_data(xcb_connection_t *c, void *ext)
    { (void)c;(void)ext; }
