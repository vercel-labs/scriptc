/* scriptc runtime — the web compression streams: CompressionStream and
 * DecompressionStream (Node's lib/internal/webstreams/compression.js).
 *
 * Each is a TransformStream whose transformer callbacks are the C functions
 * below, feeding one of Node's zlib streams (`gzip`, `deflate`,
 * `deflate-raw`): written chunks go through scr_zlib.c's streaming engine
 * and every output chunk is enqueued on the transform's readable side.
 * psClass builds the transform through scr_webstream_native_transform
 * (scr_webstreams.c), so the stream machinery stays in that unit and this
 * one links only when a program constructs the class (its pack predicate
 * needs both webStreams and zlib). */
#include "scr_runtime.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <zlib.h>

/* The two classes' kinds in the frontend's WEB_STREAM_CLASSES order. */
enum { WS_COMPRESS_KIND = 15, WS_DECOMPRESS_KIND = 16 };

/* One output buffer per engine step (zlib's own chunk-size default). */
enum { WS_COMP_OUT = 16 * 1024 };

static void ws_comp_oom(void) { scr_trap("scriptc: out of memory\n"); }

typedef struct WsCompState {
  size_t rc;
  ScrDyn *transform; /* +1, the TransformStream whose streams we expose */
  ScrZlibEngine *engine;
  bool decompressing;
  /* The engine's finish flush: zlib's Z_FINISH, or Brotli's own operation
   * value (BROTLI_OPERATION_FINISH = 2, where Z_FINISH is 4). */
  int finish_op;
  ScrDyn *own; /* +1 expando properties, or NULL */
} WsCompState;

static void *ws_comp_retain(void *p) {
  ((WsCompState *)p)->rc++;
  return p;
}

static void ws_comp_trace(void *p, ScrTraceVisit visit, void *ctx) {
  WsCompState *s = p;
  if (s->transform) visit(s->transform, ctx);
  if (s->own) visit(s->own, ctx);
}

/* The state owns its transform, the transform's native closures own their
 * capture box, and the box owns the state: a cycle. The style the web
 * stream unit's own streams use (WsObj, scr_webstreams.c) keeps it: the
 * collector traces the state and frees it without releasing the values it
 * already collected (drop(gc)). */
static void ws_comp_drop(void *p, bool gc) {
  WsCompState *s = p;
  if (s->engine) scr_zlib_engine_free(s->engine);
  s->engine = NULL;
  if (gc) return;
  if (s->transform) scr_dyn_release(s->transform);
  if (s->own) scr_dyn_release(s->own);
}

static void ws_comp_gcfree(void *p) {
  ws_comp_drop(p, true);
  scr_obj_free_note();
  scr_cyc_free(p);
}

static void ws_comp_destroy(void *p) {
  ws_comp_drop(p, false);
  scr_obj_free_note();
  scr_cyc_free(p);
}

static ScrCycType ws_comp_cyc_type = {ws_comp_trace, ws_comp_gcfree, SCR_CYC_KIND_NONE, 0};

static WsCompState *ws_comp_new(void) {
  WsCompState *s = scr_cyc_alloc(sizeof *s, &ws_comp_cyc_type);
  s->rc = 1;
  scr_obj_alloc_note();
  return s;
}

static void ws_comp_release(void *p) {
  WsCompState *s = p;
  if (--s->rc != 0) {
    scr_cyc_released(s);
    return;
  }
  scr_cyc_dead(s);
  scr_rc_destroy(s, ws_comp_destroy);
}

/* The class's getters: readable and writable, which own properties do not
 * shadow (the stream objects are the transform's). */
static const ScrDynHandleAccessor ws_comp_accessors[] = {{"readable", false}, {"writable", false}, {NULL, false}};

static ScrDynHandleTag ws_comp_tag_of(const WsCompState *s) {
  return s->decompressing ? SCR_DYNH_WS_DECOMPRESSION : SCR_DYNH_WS_COMPRESSION;
}

static ScrDyn *ws_comp_construct(ScrDyn *const *args, size_t argc, bool decompressing);
static ScrDyn *ws_comp_transform(ScrClosure *closure, ScrDyn *const *args, size_t argc);
static ScrDyn *ws_comp_flush(ScrClosure *closure, ScrDyn *const *args, size_t argc);

static ScrDyn *ws_compress_construct(ScrDyn *const *args, size_t argc) {
  return ws_comp_construct(args, argc, false);
}

static ScrDyn *ws_decompress_construct(ScrDyn *const *args, size_t argc) {
  return ws_comp_construct(args, argc, true);
}

/* Attaches the stream's native transformer; false with the exception
 * pending. */
static bool ws_comp_attach(WsCompState *s, ScrDynThunk transform, ScrDynThunk flush) {
  ScrDyn *box = scr_webstream_native_transform(transform, flush, s, ws_comp_retain, ws_comp_release,
                                               ws_comp_trace);
  if (!box) return false;
  s->transform = scr_dyn_retain(box);
  scr_dyn_release(box);
  return true;
}

/* ToString of the format argument, with a missing one as "undefined"
 * (WebIDL converts an absent required argument the same way in the
 * message). NULL with the exception pending for a symbol. */
static ScrStr *ws_comp_format_text(ScrDyn *arg) {
  if (arg == NULL) return scr_str_new("undefined", 9);
  return scr_dyn_string_coerce_js(arg);
}

/* The brotli format's mode sentinel: its engine is scr_brotli.c's. */
enum { WS_COMP_BROTLI = 0 };

/* The zlib mode a CompressionFormat names, or -1 for another value. */
static int ws_comp_mode(const ScrStr *format, bool decompressing) {
  if (format->len == 6 && memcmp(format->data, "brotli", 6) == 0) return WS_COMP_BROTLI;
  if (format->len == 4 && memcmp(format->data, "gzip", 4) == 0)
    return decompressing ? SCR_Z_GUNZIP : SCR_Z_GZIP;
  if (format->len == 7 && memcmp(format->data, "deflate", 7) == 0)
    return decompressing ? SCR_Z_INFLATE : SCR_Z_DEFLATE;
  if (format->len == 11 && memcmp(format->data, "deflate-raw", 11) == 0)
    return decompressing ? SCR_Z_INFLATERAW : SCR_Z_DEFLATERAW;
  return -1;
}

static ScrDyn *ws_comp_construct(ScrDyn *const *args, size_t argc, bool decompressing) {
  ScrStr *format = ws_comp_format_text(argc > 0 ? args[0] : NULL);
  if (!format) return NULL;
  int mode = ws_comp_mode(format, decompressing);
  if (mode < 0) {
    /* Node's enum conversion: TypeError, code ERR_INVALID_ARG_VALUE,
     * "Failed to construct 'CompressionStream': 1st argument '<text>' is
     * not a valid enum value of type CompressionFormat." */
    static const char before[] = "Failed to construct '";
    static const char middle[] = "': 1st argument '";
    static const char after[] = "' is not a valid enum value of type CompressionFormat.";
    const char *cls = decompressing ? "DecompressionStream" : "CompressionStream";
    size_t cls_len = strlen(cls);
    size_t len = sizeof before - 1 + cls_len + sizeof middle - 1 + format->len + sizeof after - 1;
    char *message = malloc(len);
    if (!message) ws_comp_oom();
    size_t at = 0;
    memcpy(message + at, before, sizeof before - 1);
    at += sizeof before - 1;
    memcpy(message + at, cls, cls_len);
    at += cls_len;
    memcpy(message + at, middle, sizeof middle - 1);
    at += sizeof middle - 1;
    memcpy(message + at, format->data, format->len);
    at += format->len;
    memcpy(message + at, after, sizeof after - 1);
    scr_str_release(format);
    scr_throw_error_msg_code(SCR_ERR_TYPE, message, len, "ERR_INVALID_ARG_VALUE");
    free(message);
    return NULL;
  }
  scr_str_release(format);
  WsCompState *s = ws_comp_new();
  s->decompressing = decompressing;
  s->finish_op = mode == WS_COMP_BROTLI ? 2 /* BROTLI_OPERATION_FINISH */ : Z_FINISH;
  s->engine = mode == WS_COMP_BROTLI
                  ? scr_brotli_web_engine(decompressing)
                  : scr_zlib_engine_new(mode, Z_DEFAULT_COMPRESSION, 15, 8, Z_DEFAULT_STRATEGY,
                                        NULL, 0, false);
  ScrDyn *result = NULL;
  if (ws_comp_attach(s, ws_comp_transform, ws_comp_flush)) {
    result = scr_dyn_new_handle(s, ws_comp_tag_of(s));
    result->v.handle.traced = true;
  }
  ws_comp_release(s);
  return result;
}

/* Node's zlib Writable chunk conversion, with its messages: a null chunk is
 * ERR_STREAM_NULL_VALUES, and text or a buffer source is its bytes. */
static ScrBytes *ws_comp_input(ScrDyn *chunk) {
  if (chunk->kind == SCR_DYN_NULL) {
    static const char message[] = "May not write null values to stream";
    scr_throw_error_msg_code(SCR_ERR_TYPE, message, sizeof message - 1, "ERR_STREAM_NULL_VALUES");
    return NULL;
  }
  return scr_zlib_input_dyn(chunk, true);
}

/* The zlib error a web compression stream fails with: a TypeError carrying
 * the zlib code, with no message (Node's adapters rethrow the underlying
 * error's code this way). */
static void ws_comp_throw(const ScrZlibError *ze) {
  scr_throw_error_msg_code(SCR_ERR_TYPE, "", 0, ze->code);
}

static bool ws_comp_enqueue(ScrDyn *controller, const unsigned char *data, size_t len) {
  ScrBytes *bytes = scr_bytes_new(SCR_BYTES_U8, (double)len);
  if (len) memcpy(bytes->data, data, len);
  bytes->is_buffer = false; /* a Uint8Array chunk, as Node's transform yields */
  ScrDyn *chunk = scr_dyn_new_bytes(bytes);
  bool ok = scr_webstream_controller_enqueue(controller, chunk);
  scr_dyn_release(chunk);
  scr_bytes_release(bytes);
  return ok;
}

/* Runs the engine until it takes all of `in` (or, with `finish`, until the
 * stream ends), enqueueing each full output buffer. False with the
 * exception pending, or when the controller refused the chunk. */
static bool ws_comp_run(WsCompState *s, ScrDyn *controller, const unsigned char *in, size_t in_len,
                        bool finish) {
  unsigned char *out = malloc(WS_COMP_OUT);
  if (!out) ws_comp_oom();
  size_t off = 0;
  bool ok = true;
  for (;;) {
    scr_zlib_engine_work(s->engine, finish ? s->finish_op : Z_NO_FLUSH, in + off,
                         (uint32_t)(in_len - off), out, WS_COMP_OUT);
    uint32_t avail_in = 0, avail_out = 0;
    scr_zlib_engine_offsets(s->engine, &avail_in, &avail_out);
    size_t took = in_len - off - avail_in;
    size_t made = WS_COMP_OUT - avail_out;
    off += took;
    if (made && !ws_comp_enqueue(controller, out, made)) {
      ok = false;
      break;
    }
    ScrZlibError ze;
    if (scr_zlib_engine_error(s->engine, &ze)) {
      ws_comp_throw(&ze);
      ok = false;
      break;
    }
    if (made < WS_COMP_OUT) break;
    if (took == 0 && made == 0) break;
  }
  free(out);
  return ok;
}

static ScrDyn *ws_comp_transform(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  WsCompState *s = ws_comp_retain(scr_box_get_ref(closure->caps[0]));
  ScrDyn *chunk = argc > 0 && args[0] != NULL ? args[0] : scr_dyn_undefined();
  ScrDyn *controller = argc > 1 && args[1] != NULL ? args[1] : scr_dyn_undefined();
  ScrDyn *result = NULL;
  ScrBytes *in = ws_comp_input(chunk);
  if (in) {
    if (ws_comp_run(s, controller, in->data, in->len, false))
      result = scr_dyn_retain(scr_dyn_undefined());
    scr_bytes_release(in);
  }
  ws_comp_release(s);
  return result;
}

static ScrDyn *ws_comp_flush(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  WsCompState *s = ws_comp_retain(scr_box_get_ref(closure->caps[0]));
  ScrDyn *controller = argc > 0 && args[0] != NULL ? args[0] : scr_dyn_undefined();
  ScrDyn *result = NULL;
  if (ws_comp_run(s, controller, NULL, 0, true)) result = scr_dyn_retain(scr_dyn_undefined());
  ws_comp_release(s);
  return result;
}

static ScrDyn *ws_comp_get(void *ptr, const char *key, size_t len) {
  WsCompState *s = ptr;
  /* The prototype's constructor IS the class object Node's global names,
   * so `stream.constructor === CompressionStream` holds. */
  if (len == 11 && memcmp(key, "constructor", 11) == 0)
    return scr_dyn_handle_class_value(ws_comp_tag_of(s));
  if (len == 8 && memcmp(key, "readable", 8) == 0)
    return scr_webstream_transform_readable(s->transform);
  if (len == 8 && memcmp(key, "writable", 8) == 0)
    return scr_webstream_transform_writable(s->transform);
  ScrDyn *own = s->own ? scr_dyn_obj_get(s->own, key, len) : NULL;
  if (own) return scr_dyn_retain(own);
  return scr_dyn_handle_class_member(ws_comp_tag_of(s), ptr, key, len);
}

static bool ws_comp_set(void *ptr, const char *key, size_t len, const ScrDyn *value) {
  WsCompState *s = ptr;
  for (const ScrDynHandleAccessor *a = ws_comp_accessors; a->name; a++) {
    if (strlen(a->name) != len || memcmp(a->name, key, len) != 0) continue;
    char buf[256];
    int n = snprintf(buf, sizeof buf, "Cannot set property %.*s of #<%s> which has only a getter",
                     (int)len, key, s->decompressing ? "DecompressionStream" : "CompressionStream");
    scr_throw_error_msg(SCR_ERR_TYPE, buf, (size_t)n);
    return true;
  }
  if (!s->own) s->own = scr_dyn_new_obj();
  scr_dyn_obj_set(s->own, key, len, scr_dyn_retain((ScrDyn *)value));
  return true;
}

/* The classes have no methods: a call on one is Node's "is not a function"
 * TypeError. */
static ScrDyn *ws_comp_invoke(void *ptr, ScrDyn *self, const char *method, ScrDyn *const *args,
                              size_t argc, const char *what) {
  (void)ptr;
  (void)method;
  (void)args;
  (void)argc;
  scr_dyn_release(self);
  char buf[160];
  int n = snprintf(buf, sizeof buf, "%s is not a function", what);
  scr_throw_error_msg(SCR_ERR_TYPE, buf, (size_t)n);
  return NULL;
}

#define WS_COMP_OPS(ops_name, class_name)                                                     \
  static const ScrDynHandleOps ops_name = {                                                   \
      .cls = class_name,                                                                      \
      .retain = ws_comp_retain,                                                               \
      .release = ws_comp_release,                                                             \
      .invoke = ws_comp_invoke,                                                               \
      .get = ws_comp_get,                                                                     \
      .set = ws_comp_set,                                                                     \
      .json_empty_object = true,                                                              \
      .to_string_tag = class_name,                                                            \
      .invalid_this = "Value of \"this\" must be of type " class_name,                        \
  }

WS_COMP_OPS(ws_compression_ops, "CompressionStream");
WS_COMP_OPS(ws_decompression_ops, "DecompressionStream");

static const ScrDynHandleClass ws_compression_class = {
    "CompressionStream", 0, ws_compress_construct, ws_comp_accessors, NULL, NULL, NULL,
};

static const ScrDynHandleClass ws_decompression_class = {
    "DecompressionStream", 0, ws_decompress_construct, ws_comp_accessors, NULL, NULL, NULL,
};

static SCR_TL bool ws_comp_installed;

static void ws_comp_install(void) {
  if (ws_comp_installed) return;
  scr_webstream_install();
  ws_comp_installed = true;
  scr_dyn_handle_class_install(SCR_DYNH_WS_COMPRESSION, &ws_compression_ops, &ws_compression_class);
  scr_dyn_handle_class_install(SCR_DYNH_WS_DECOMPRESSION, &ws_decompression_ops,
                               &ws_decompression_class);
}

ScrDyn *scr_webstream_compress_class(double kind) {
  ws_comp_install();
  return scr_dyn_handle_class_value(kind == (double)WS_DECOMPRESS_KIND ? SCR_DYNH_WS_DECOMPRESSION
                                                                       : SCR_DYNH_WS_COMPRESSION);
}

/* `value instanceof <class>`: a handle of the class, or an object with the
 * class's prototype on its chain (scr_dyn_handle_class.c's brand test, as
 * scr_webstream_instanceof runs for the other web stream classes). */
bool scr_webstream_compress_instanceof(ScrDyn *value, double kind) {
  ws_comp_install();
  ScrDynHandleTag tag =
      kind == (double)WS_DECOMPRESS_KIND ? SCR_DYNH_WS_DECOMPRESSION : SCR_DYNH_WS_COMPRESSION;
  if (value->kind == SCR_DYN_HANDLE) return scr_dyn_handle_class_tag_of(value) == tag;
  if (value->kind != SCR_DYN_OBJ && value->kind != SCR_DYN_ARR && value->kind != SCR_DYN_FUNC)
    return false;
  ScrDyn *prototype = scr_dyn_handle_class_prototype(tag);
  ScrDyn *current = scr_dyn_get_prototype(value);
  while (current && current->kind == SCR_DYN_OBJ) {
    if (current == prototype) return true;
    current = scr_dyn_get_prototype(current);
  }
  return false;
}
