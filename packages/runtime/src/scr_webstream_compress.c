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
/* Input the engine has accepted but not consumed yet (bytes), and output
 * chunks a flush may queue before it waits for the reader (chunks: the
 * readable strategy has no size function, so its queue counts chunks):
 * both bound what a bomb-shaped stream can hold. */
enum { WS_COMP_BACKLOG = 1024 * 1024, WS_COMP_QUEUED = 64 };

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
  /* The bytes written and not yet consumed by the engine (in[in_off ..
   * in_len)). Output is produced only as the readable side asks for it, so
   * a chunk that expands to a bomb stays a bounded backlog instead of a
   * queue of expanded chunks. */
  unsigned char *in;
  size_t in_len, in_cap, in_off;
  bool finishing; /* flush began: drain the backlog, then finish the engine */
  bool drain;     /* the last step filled its output buffer: more is due */
  bool pumping;   /* a pump is on the stack: enqueues may pull again */
  ScrDyn *controller; /* +1, the transform controller while a job runs */
  ScrPromise *pending_write; /* +1, a write waiting for the backlog to drain */
  ScrPromise *pending_flush; /* +1, close waiting for the output to drain */
  unsigned char *out; /* the WS_COMP_OUT scratch, allocated on first use */
} WsCompState;

static void *ws_comp_retain(void *p) {
  ((WsCompState *)p)->rc++;
  return p;
}

static void ws_comp_trace(void *p, ScrTraceVisit visit, void *ctx) {
  WsCompState *s = p;
  if (s->transform) visit(s->transform, ctx);
  if (s->own) visit(s->own, ctx);
  if (s->controller) visit(s->controller, ctx);
  if (s->pending_write) visit(s->pending_write, ctx);
  if (s->pending_flush) visit(s->pending_flush, ctx);
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
  free(s->in);
  s->in = NULL;
  free(s->out);
  s->out = NULL;
  if (gc) return;
  if (s->transform) scr_dyn_release(s->transform);
  if (s->own) scr_dyn_release(s->own);
  if (s->controller) scr_dyn_release(s->controller);
  if (s->pending_write) scr_promise_release(s->pending_write);
  if (s->pending_flush) scr_promise_release(s->pending_flush);
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
static ScrDyn *ws_comp_cancel(ScrClosure *closure, ScrDyn *const *args, size_t argc);
static bool ws_comp_resume_hook(void *state);

static ScrDyn *ws_compress_construct(ScrDyn *const *args, size_t argc) {
  return ws_comp_construct(args, argc, false);
}

static ScrDyn *ws_decompress_construct(ScrDyn *const *args, size_t argc) {
  return ws_comp_construct(args, argc, true);
}

/* Attaches the stream's native transformer; false with the exception
 * pending. */
static bool ws_comp_attach(WsCompState *s, ScrDynThunk transform, ScrDynThunk flush) {
  ScrDyn *box =
      scr_webstream_native_transform(transform, flush, ws_comp_cancel, s, ws_comp_retain,
                                     ws_comp_release, ws_comp_trace, ws_comp_resume_hook);
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
                                        NULL, 0, decompressing);
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
 * error's code this way). +1. */
static ScrDyn *ws_comp_error_value(const ScrZlibError *ze) {
  ScrStr *message = scr_str_new("", 0);
  ScrError *err = scr_error_new(SCR_ERR_TYPE, message);
  scr_str_release(message);
  scr_error_set_code(err, ze->code);
  ScrDyn *value = scr_dyn_from_error(err);
  scr_error_release(err);
  return value;
}

/* Rejects `p` with `reason` (borrowed). The promise is the stream's own
 * (the machinery derives the promises the program sees from it), so its
 * rejection counts as handled here, like the runtime's other internal
 * promises: the close and read promise the program holds still reject. */
static void ws_comp_reject(ScrPromise *p, ScrDyn *reason) {
  scr_dyn_throw(scr_dyn_retain(reason));
  scr_promise_reject_pending(p);
  scr_promise_mark_handled(p);
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

/* Appends a written chunk to the backlog (compacting the consumed prefix
 * first). The backlog is what the engine has accepted and not consumed. */
static void ws_comp_backlog(WsCompState *s, const unsigned char *data, size_t len) {
  if (s->in_off > 0) {
    memmove(s->in, s->in + s->in_off, s->in_len - s->in_off);
    s->in_len -= s->in_off;
    s->in_off = 0;
  }
  if (s->in_len + len > s->in_cap) {
    size_t cap = s->in_cap ? s->in_cap : 4096;
    while (cap < s->in_len + len) cap *= 2;
    unsigned char *grown = realloc(s->in, cap);
    if (!grown) ws_comp_oom();
    s->in = grown;
    s->in_cap = cap;
  }
  if (len) memcpy(s->in + s->in_len, data, len);
  s->in_len += len;
}

/* Keeps the transform's controller (+1) while the backlog or the finish
 * flush is pending: the output is produced on its readable side's pulls. */
static void ws_comp_bind(WsCompState *s, ScrDyn *controller) {
  if (s->controller || controller->kind != SCR_DYN_HANDLE) return;
  if (controller->v.handle.tag != SCR_DYNH_WS_TCONTROLLER) return;
  s->controller = scr_dyn_retain(controller);
}

static void ws_comp_release_promises(WsCompState *s, ScrDyn *reason, bool reject) {
  if (s->pending_write) {
    ScrPromise *p = s->pending_write;
    s->pending_write = NULL;
    if (reject) ws_comp_reject(p, reason);
    else scr_promise_resolve_dyn(p, scr_dyn_retain(scr_dyn_undefined()));
    scr_promise_release(p);
  }
  if (s->pending_flush) {
    ScrPromise *p = s->pending_flush;
    s->pending_flush = NULL;
    if (reject) ws_comp_reject(p, reason);
    else scr_promise_resolve_dyn(p, scr_dyn_retain(scr_dyn_undefined()));
    scr_promise_release(p);
  }
}

/* Resolves a write that waited for the backlog to drain below its cap. */
static void ws_comp_release_write(WsCompState *s) {
  if (!s->pending_write || s->in_len - s->in_off > WS_COMP_BACKLOG) return;
  ScrPromise *write = s->pending_write;
  s->pending_write = NULL;
  scr_promise_resolve_dyn(write, scr_dyn_retain(scr_dyn_undefined()));
  scr_promise_release(write);
}

/* The job is done: the backlog is consumed, and after a flush the engine
 * itself is released. */
static void ws_comp_job_done(WsCompState *s) {
  if (s->finishing && s->engine) {
    scr_zlib_engine_free(s->engine);
    s->engine = NULL;
  }
  s->in_len = 0;
  s->in_off = 0;
  s->drain = false;
  ScrDyn *controller = s->controller;
  s->controller = NULL;
  ws_comp_release_promises(s, NULL, false);
  if (controller) scr_dyn_release(controller);
}

/* The engine failed: the stream errors with Node's TypeError (the readable
 * rejects; a write that already returned stays resolved, as on Node), and
 * whatever waits on the stream settles with it. */
static void ws_comp_fail(WsCompState *s, const ScrZlibError *ze) {
  ScrDyn *error = ws_comp_error_value(ze);
  ScrDyn *controller = s->controller;
  s->controller = NULL;
  if (s->engine) scr_zlib_engine_free(s->engine);
  s->engine = NULL;
  s->in_len = 0;
  s->in_off = 0;
  s->drain = false;
  ws_comp_release_promises(s, error, true);
  if (controller) {
    scr_webstream_controller_fail(controller, error);
    scr_dyn_release(controller);
  }
  scr_dyn_release(error);
}

/* A decompression stream's input continues past the end of the compressed
 * stream: Node rejects it with the trailing-junk TypeError (a codec's own
 * data error, such as deflate-raw parsing the extra bytes as another block,
 * arrives through the engine's error instead). */
static void ws_comp_junk(WsCompState *s) {
  static const char message[] = "Trailing junk found after the end of the compressed stream";
  ScrStr *text = scr_str_new(message, sizeof message - 1);
  ScrError *err = scr_error_new(SCR_ERR_TYPE, text);
  scr_str_release(text);
  scr_error_set_code(err, "ERR_TRAILING_JUNK_AFTER_STREAM_END");
  ScrDyn *error = scr_dyn_from_error(err);
  scr_error_release(err);
  ScrDyn *controller = s->controller;
  s->controller = NULL;
  if (s->engine) scr_zlib_engine_free(s->engine);
  s->engine = NULL;
  s->in_len = 0;
  s->in_off = 0;
  s->drain = false;
  ws_comp_release_promises(s, error, true);
  if (controller) {
    scr_webstream_controller_fail(controller, error);
    scr_dyn_release(controller);
  }
  scr_dyn_release(error);
}

/* The controller refused a chunk (the stream closed or errored under the
 * job): drop the job; the stream already carries the error. */
static void ws_comp_abandon(WsCompState *s) {
  ScrDyn *controller = s->controller;
  s->controller = NULL;
  s->in_len = 0;
  s->in_off = 0;
  s->drain = false;
  ws_comp_release_promises(s, NULL, false);
  if (controller) scr_dyn_release(controller);
}

/* Runs the engine as far as the readable side allows: one step per
 * outstanding read request, and during a flush up to WS_COMP_QUEUED bytes
 * of queued output (so a close before any read completes for a small
 * stream and waits for the reader for a bomb). Returns -1 with the
 * exception pending when enqueueing failed. */
static int ws_comp_pump_steps(WsCompState *s) {
  if (!s->out) {
    s->out = malloc(WS_COMP_OUT);
    if (!s->out) ws_comp_oom();
  }
  for (;;) {
    bool input_left = s->in_off < s->in_len;
    if (!input_left && !s->finishing && !s->drain) {
      ws_comp_job_done(s);
      return 0;
    }
    bool room = scr_webstream_controller_has_request(s->controller) ||
                (s->finishing &&
                 scr_webstream_controller_queue_size(s->controller) < WS_COMP_QUEUED);
    if (!room) {
      ws_comp_release_write(s);
      return 0; /* wait for the reader's next pull */
    }
    /* A flush finishes the engine over whatever backlog remains: the last
     * input and the end marker go in the same operation. */
    int op = s->finishing ? s->finish_op : Z_NO_FLUSH;
    size_t in_left = s->in_len - s->in_off;
    scr_zlib_engine_work(s->engine, op, input_left ? s->in + s->in_off : NULL,
                         (uint32_t)in_left, s->out, WS_COMP_OUT);
    uint32_t avail_in = 0, avail_out = 0;
    scr_zlib_engine_offsets(s->engine, &avail_in, &avail_out);
    size_t took = in_left - avail_in;
    size_t made = WS_COMP_OUT - avail_out;
    s->in_off += took;
    s->drain = made == WS_COMP_OUT;
    if (made) {
      if (!ws_comp_enqueue(s->controller, s->out, made)) {
        ws_comp_abandon(s);
        return -1;
      }
      /* Enqueueing can settle a read synchronously and run hooks that
       * cancel the stream: the cancel clears the controller and releases
       * the engine. Re-check both before touching either again. */
      if (!s->controller || !s->engine) return 0;
      /* The chunk satisfied the read request that pulled for it: settle
       * that pull so the reader's next read reaches the engine. */
      if (!scr_webstream_controller_has_request(s->controller))
        scr_webstream_controller_pull_done(s->controller);
    }
    ScrZlibError ze;
    if (scr_zlib_engine_error(s->engine, &ze)) {
      ws_comp_fail(s, &ze);
      return 0;
    }
    /* The decoder stopped with output space left and input unread: the
     * compressed stream ended and bytes follow it. A chunk this step made
     * already went to a waiting read, so the stream's bytes arrive before
     * the error; the error settles every other request now (a deferred
     * error would wait for a pump that nothing triggers). */
    if (s->decompressing && took < in_left && made < WS_COMP_OUT) {
      ws_comp_junk(s);
      return 0;
    }
    bool input_done = s->in_off >= s->in_len;
    /* A step that left output space: with the finish operation the engine
     * has ended (an incomplete stream is an error above), and without it
     * the backlog is consumed and deflate has emitted everything it will
     * until the next write or flush. */
    bool done = s->finishing ? (made < WS_COMP_OUT && !s->drain)
                             : (input_done && !s->drain);
    if (done) {
      ws_comp_job_done(s);
      return 0;
    }
    ws_comp_release_write(s);
    if (took == 0 && made == 0 && !s->drain) return 0;
  }
}

/* Runs the pump unless it is already on the stack: enqueueing can call the
 * readable's pull, whose resume hook pumps again, and a nested pump must not
 * free the engine under the outer one's steps. */
static int ws_comp_pump(WsCompState *s) {
  if (!s->controller || !s->engine || s->pumping) return 0;
  s->pumping = true;
  int result = ws_comp_pump_steps(s);
  s->pumping = false;
  return result;
}

/* A write hands its chunk to the backlog and returns: output is produced on
 * the reader's pulls, so writing never waits for the readable side (Node's
 * writable and readable sides are independent). Only a write past the
 * backlog's cap waits for the engine to catch up. */
static ScrDyn *ws_comp_transform(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  WsCompState *s = scr_box_get_ref(closure->caps[0]); /* +1, released below */
  ScrDyn *chunk = argc > 0 && args[0] != NULL ? args[0] : scr_dyn_undefined();
  ScrDyn *controller = argc > 1 && args[1] != NULL ? args[1] : scr_dyn_undefined();
  ScrDyn *result = NULL;
  ScrBytes *in = ws_comp_input(chunk);
  if (in) {
    if (s->engine) {
      ws_comp_backlog(s, in->data, in->len);
      ws_comp_bind(s, controller);
      s->drain = false;
      /* Produce what the readable side can take now: a reader already
       * waiting must not wait for another pull to start the engine, and a
       * backlog past its cap would otherwise never drain. */
      int pumped = ws_comp_pump(s);
      if (s->in_len - s->in_off > WS_COMP_BACKLOG) {
        s->pending_write = scr_promise_new();
        result = scr_dyn_new_promise(s->pending_write);
      } else if (pumped == 0) {
        result = scr_dyn_retain(scr_dyn_undefined());
      }
    } else {
      result = scr_dyn_retain(scr_dyn_undefined());
    }
    scr_bytes_release(in);
  }
  ws_comp_release(s);
  return result;
}

/* close(): the finish flush waits for the reader only when the output
 * exceeds what a flush may queue without one. */
static ScrDyn *ws_comp_flush(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  WsCompState *s = scr_box_get_ref(closure->caps[0]); /* +1, released below */
  ScrDyn *controller = argc > 0 && args[0] != NULL ? args[0] : scr_dyn_undefined();
  ScrDyn *result = NULL;
  if (s->engine) {
    ws_comp_bind(s, controller);
    s->finishing = true;
    s->drain = false;
    if (!s->pending_flush) s->pending_flush = scr_promise_new();
    if (ws_comp_pump(s) == 0)
      result = s->pending_flush ? scr_dyn_new_promise(s->pending_flush)
                                : scr_dyn_retain(scr_dyn_undefined());
  } else {
    result = scr_dyn_retain(scr_dyn_undefined());
  }
  ws_comp_release(s);
  return result;
}

/* cancel/abort: the engine and the backlog go now rather than with the
 * stream's collection. */
static ScrDyn *ws_comp_cancel(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  WsCompState *s = scr_box_get_ref(closure->caps[0]); /* +1, released below */
  ScrDyn *reason = argc > 0 && args[0] != NULL ? args[0] : scr_dyn_undefined();
  ScrDyn *controller = s->controller;
  s->controller = NULL;
  if (s->engine) scr_zlib_engine_free(s->engine);
  s->engine = NULL;
  s->in_len = 0;
  s->in_off = 0;
  s->drain = false;
  s->finishing = false;
  ws_comp_release_promises(s, reason, true);
  if (controller) scr_dyn_release(controller);
  ws_comp_release(s);
  return scr_dyn_retain(scr_dyn_undefined());
}

/* The readable's pull: the moment the engine may produce its next chunk.
 * The pull stays parked only while a read request still waits for output;
 * the pump's next enqueue settles it. */
static bool ws_comp_resume_hook(void *state) {
  WsCompState *s = state;
  if (!s->controller || !s->engine) return false;
  (void)ws_comp_pump(s);
  return s->controller != NULL && scr_webstream_controller_has_request(s->controller);
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
  (void)self; /* a borrowed receiver: the caller owns it */
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
