/* node:zlib's stream classes — Deflate, Inflate, Gzip, Gunzip, DeflateRaw,
 * InflateRaw and Unzip (createDeflate() et al) — as runtime Transform
 * streams over the scr_zlib.c engine. Linked only when the program uses
 * both zlib and the stream surface (the scr_util_style.c pairing rule), so
 * zlib's one-shot users keep their link line.
 *
 * The write path follows lib/zlib.js: every chunk runs as one or more
 * engine steps on the shared worker pool (Node's threadpool write), each
 * step filling the chunkSize output buffer from the current offset; a
 * non-empty step pushes one 'data' chunk, a full buffer starts the next
 * step (after a _read when push() answered false), and the transform
 * callback runs once the input is consumed. The last chunk written after
 * end() runs with finishFlush, the 'prefinish' flush writes an empty chunk
 * with it, and flush() writes a zero-length sentinel chunk carrying its
 * flush kind. Engine errors destroy the stream with Node's Error (message,
 * errno and code). */
#include "scr_runtime.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* zlib.h values (the engine unit owns the zlib include). */
enum { SCR_ZF_NO_FLUSH, SCR_ZF_PARTIAL, SCR_ZF_SYNC, SCR_ZF_FULL, SCR_ZF_FINISH, SCR_ZF_BLOCK };
enum { SCR_ZM_DEFLATE = 1, SCR_ZM_INFLATE, SCR_ZM_GZIP, SCR_ZM_GUNZIP, SCR_ZM_DEFLATERAW,
       SCR_ZM_INFLATERAW, SCR_ZM_UNZIP };

typedef struct ScrZlibStream {
  size_t rc;
  ScrZlibEngine *eng; /* freed at close (deferred while a step runs) */
  bool closed;        /* Node's `_handle === null` */
  bool pending_close;
  bool write_in_progress;
  ScrStream *s;       /* borrowed: the stream owns this state through its hooks */
  int mode;
  uint32_t chunk_size;
  int default_flush, finish_flush, full_flush;
  double level, strategy; /* Node's _level/_strategy (params() compares them) */
  bool reject_garbage;
  double bytes_written;
  /* _outBuffer/_outOffset: steps write at out_offset, pushes copy slices */
  unsigned char *out_buf;
  uint32_t out_offset;
  /* the chunk in flight (handle.buffer/inOff/availInBefore/availOutBefore) */
  unsigned char *in_buf;
  uint32_t in_off, avail_in_before, avail_out_before;
  int flush_flag;
  bool flushing;       /* the 'prefinish' flush: completion is flush_done */
  bool wait_read;      /* push() answered false with output pending */
  bool done_pending;   /* Transform's kCallback: completion waits for _read */
  double rlen_before;  /* readableLength when the chunk's transform began */
  ScrBytes *flush_bufs[6]; /* zero-length sentinels, one per flush kind */
  /* The AsyncLocalStorage context of the stream's creation (+1, NULL
   * outside a store): Node runs the handle's step callbacks in it. */
  ScrAlsCtx *als;
} ScrZlibStream;

static void scr_zlib_stream_oom(void) {
  scr_trap("scriptc: out of memory\n");
}

static void *scr_zs_retain_v(void *p) {
  ((ScrZlibStream *)p)->rc++;
  return p;
}

static void scr_zs_close_engine(ScrZlibStream *zs) {
  if (zs->write_in_progress) {
    zs->pending_close = true;
    return;
  }
  zs->pending_close = false;
  scr_zlib_engine_free(zs->eng);
  zs->eng = NULL;
}

static void scr_zs_release_v(void *p) {
  ScrZlibStream *zs = p;
  if (--zs->rc > 0) return;
  scr_zlib_engine_free(zs->eng);
  free(zs->out_buf);
  free(zs->in_buf);
  for (size_t i = 0; i < 6; i++) {
    if (zs->flush_bufs[i]) scr_bytes_release(zs->flush_bufs[i]);
  }
  scr_als_ctx_release(zs->als);
  free(zs);
}

static ScrClosure *scr_zs_hook(ScrZlibStream *zs, void *fn) {
  ScrClosure *cb = scr_closure_new(fn, 1);
  cb->caps[0] = scr_box_new_obj(&scr_zs_retain_v, &scr_zs_release_v, NULL);
  scr_box_set_ref(cb->caps[0], scr_zs_retain_v(zs));
  return cb;
}

static ScrZlibStream *scr_zs_of(ScrClosure *cb) {
  ScrZlibStream *zs = scr_box_get_ref(cb->caps[0]);
  scr_zs_release_v(zs); /* the stream's hooks keep it alive */
  return zs;
}

/* ── completion ───────────────────────────────────────────────────────── */

static void scr_zs_finish(ScrZlibStream *zs, ScrStream *s) {
  if (zs->flushing) {
    zs->flushing = false;
    scr_stream_flush_done(s, NULL, NULL, NULL);
  } else {
    /* scr_zs_complete has applied Transform._write's callback rule. */
    scr_stream_write_done(s, NULL);
  }
}

static void scr_zs_tick_finish(ScrClosure *cb) {
  ScrStream *s = scr_box_get_ref(cb->caps[0]);
  ScrZlibStream *zs = scr_box_get_ref(cb->caps[1]);
  scr_zs_finish(zs, s);
  scr_zs_release_v(zs);
  scr_stream_release(s);
}

static void scr_zs_finish_on_tick(ScrZlibStream *zs, ScrStream *s) {
  ScrClosure *cb = scr_closure_new((void *)&scr_zs_tick_finish, 2);
  cb->caps[0] = scr_box_new_obj(&scr_stream_retain_v, &scr_stream_release_v, &scr_stream_trace);
  scr_box_set_ref(cb->caps[0], scr_stream_retain(s));
  cb->caps[1] = scr_box_new_obj(&scr_zs_retain_v, &scr_zs_release_v, NULL);
  scr_box_set_ref(cb->caps[1], scr_zs_retain_v(zs));
  scr_next_tick(cb);
}

/* Transform._write's callback: a write that leaves the readable buffer
 * grown past its high-water mark completes at the next _read; a readable
 * side that already ended completes on a tick. The flush completes at
 * once. */
static void scr_zs_complete(ScrZlibStream *zs, ScrStream *s) {
  if (zs->flushing) {
    scr_zs_finish(zs, s);
    return;
  }
  if (scr_stream_prop(s, "rs:ended")) {
    scr_zs_finish_on_tick(zs, s);
    return;
  }
  double rlen = scr_stream_prop(s, "readableLength");
  if (scr_stream_prop(s, "writableEnded") || rlen == zs->rlen_before ||
      rlen < scr_stream_prop(s, "readableHighWaterMark")) {
    scr_zs_finish(zs, s);
    return;
  }
  zs->done_pending = true;
}

/* ── the engine steps ─────────────────────────────────────────────────── */

typedef struct {
  ScrZlibStream *zs;
  ScrStream *s;
} ScrZlibStep;

static void scr_zs_submit(ScrZlibStream *zs, ScrStream *s);

static void scr_zs_step_work(void *payload) {
  ScrZlibStep *op = payload;
  ScrZlibStream *zs = op->zs;
  scr_zlib_engine_work(zs->eng, zs->flush_flag, zs->in_buf + zs->in_off, zs->avail_in_before,
                       zs->out_buf + zs->out_offset, zs->avail_out_before);
}

static ScrError *scr_zs_engine_error(const ScrZlibError *ze) {
  ScrStr *message = scr_str_new(ze->message, strlen(ze->message));
  ScrError *err = scr_error_new(SCR_ERR_ERROR, message);
  scr_str_release(message);
  err->system_errno = ze->err;
  scr_error_set_code(err, ze->code);
  return err;
}

static void scr_zs_destroy_with(ScrStream *s, ScrError *err /*moves*/) {
  scr_stream_release(scr_stream_destroy(s, err));
  scr_error_release(err);
}

/* processCallback: account the step, push its output, then either run
 * the next step (the output buffer filled) or complete the chunk. */
static void scr_zs_process(ScrZlibStream *zs, ScrStream *s) {
  if (scr_stream_prop(s, "destroyed")) {
    scr_zs_finish(zs, s);
    return;
  }
  uint32_t avail_in_after, avail_out_after;
  scr_zlib_engine_offsets(zs->eng, &avail_in_after, &avail_out_after);
  uint32_t in_delta = zs->avail_in_before - avail_in_after;
  zs->bytes_written += in_delta;
  uint32_t have = zs->avail_out_before - avail_out_after;
  bool full = false;
  if (have > 0) {
    ScrBytes *out = scr_bytes_new(SCR_BYTES_U8, (double)have);
    out->is_buffer = true; /* Node pushes Buffer slices of its output buffer */
    memcpy(out->data, zs->out_buf + zs->out_offset, have);
    zs->out_offset += have;
    full = !scr_stream_push(s, out);
    scr_bytes_release(out);
    if (scr_exc_pending()) return;
  }
  if (scr_stream_prop(s, "destroyed")) {
    scr_zs_finish(zs, s);
    return;
  }
  if (avail_out_after == 0 || zs->out_offset >= zs->chunk_size) {
    zs->avail_out_before = zs->chunk_size;
    zs->out_offset = 0;
  }
  if (avail_out_after == 0) {
    zs->in_off += in_delta;
    zs->avail_in_before = avail_in_after;
    if (full) zs->wait_read = true;
    else scr_zs_submit(zs, s);
    return;
  }
  if (avail_in_after > 0) {
    /* The decoder stopped before the input did (trailing data). */
    if (zs->reject_garbage) {
      static const char msg[] = "Trailing junk found after the end of the compressed stream";
      ScrStr *m = scr_str_new(msg, sizeof msg - 1);
      ScrError *err = scr_error_new(SCR_ERR_TYPE, m);
      scr_str_release(m);
      scr_error_set_code(err, "ERR_TRAILING_JUNK_AFTER_STREAM_END");
      scr_stream_release(scr_stream_destroy(s, err));
      if (zs->flushing) {
        zs->flushing = false;
        scr_stream_flush_done(s, err, NULL, NULL);
      } else {
        scr_stream_transform_done(s, err, NULL, NULL);
      }
      return;
    }
    scr_stream_push_null(s);
    if (scr_exc_pending()) return;
  }
  scr_zs_complete(zs, s);
}

static void scr_zs_step_after(void *payload) {
  ScrZlibStep *op = payload;
  ScrZlibStream *zs = op->zs;
  ScrStream *s = op->s;
  ScrAlsCtx *prev = scr_als_dispatch_enter(zs->als);
  zs->write_in_progress = false;
  ScrZlibError ze;
  if (scr_zlib_engine_error(zs->eng, &ze)) {
    ScrError *err = scr_zs_engine_error(&ze);
    zs->closed = true;
    scr_zs_destroy_with(s, err);
  } else {
    scr_zs_process(zs, s);
  }
  if (zs->pending_close) scr_zs_close_engine(zs);
  scr_als_dispatch_leave(prev);
}

static void scr_zs_step_destroy(void *payload) {
  ScrZlibStep *op = payload;
  scr_zs_release_v(op->zs);
  scr_stream_release(op->s);
  free(op);
}

static void scr_zs_submit(ScrZlibStream *zs, ScrStream *s) {
  ScrZlibStep *op = malloc(sizeof *op);
  if (!op) scr_zlib_stream_oom();
  op->zs = scr_zs_retain_v(zs);
  op->s = scr_stream_retain(s);
  zs->write_in_progress = true;
  scr_work_submit(op, &scr_zs_step_work, &scr_zs_step_after, &scr_zs_step_destroy);
}

/* processChunk: a closed handle completes on a tick; otherwise the chunk
 * is copied (the worker reads it) and its first step starts. */
static void scr_zs_process_chunk(ScrZlibStream *zs, ScrStream *s, const ScrBytes *chunk, int flag) {
  if (zs->closed) {
    scr_zs_finish_on_tick(zs, s);
    return;
  }
  size_t len = chunk->len;
  free(zs->in_buf);
  zs->in_buf = malloc(len ? len : 1);
  if (!zs->in_buf) scr_zlib_stream_oom();
  if (len) scr_bytes_read(chunk, 0, zs->in_buf, len);
  zs->in_off = 0;
  zs->avail_in_before = (uint32_t)len;
  zs->avail_out_before = zs->chunk_size - zs->out_offset;
  zs->flush_flag = flag;
  zs->rlen_before = scr_stream_prop(s, "readableLength");
  scr_zs_submit(zs, s);
}

/* Node's flushiness order: NO_FLUSH < BLOCK < PARTIAL < SYNC < FULL < FINISH. */
static int scr_zs_flushiness(int f) {
  static const int rank[6] = { 0, 2, 3, 4, 5, 1 };
  return f >= 0 && f < 6 ? rank[f] : 0;
}

static int scr_zs_max_flush(int a, int b) {
  return scr_zs_flushiness(a) > scr_zs_flushiness(b) ? a : b;
}

static void scr_zs_transform_inv(ScrClosure *cb, ScrStream *s, ScrBytes *chunk) {
  ScrZlibStream *zs = scr_zs_of(cb);
  int flag = zs->default_flush;
  for (int k = 0; k < 6; k++) {
    if (zs->flush_bufs[k] != NULL && chunk == zs->flush_bufs[k]) flag = k;
  }
  if (scr_stream_prop(s, "writableEnded") &&
      scr_stream_prop(s, "writableLength") == (double)chunk->len) {
    flag = scr_zs_max_flush(flag, zs->finish_flush);
  }
  zs->flushing = false;
  scr_zs_process_chunk(zs, s, chunk, flag);
}

/* _flush (run from the Transform's 'prefinish' listener): an empty chunk
 * through _transform — the stream has ended with nothing buffered, so the
 * finish flush applies. */
static void scr_zs_flush_inv(ScrClosure *cb, ScrStream *s) {
  ScrZlibStream *zs = scr_zs_of(cb);
  ScrBytes *empty = scr_bytes_new(SCR_BYTES_U8, 0);
  zs->flushing = true;
  scr_zs_process_chunk(zs, s, empty, scr_zs_max_flush(zs->default_flush, zs->finish_flush));
  scr_bytes_release(empty);
}

/* _read: the step a full push() paused resumes; a completion that waited
 * on the readable buffer (Transform's kCallback) runs. */
static void scr_zs_read_inv(ScrClosure *cb, ScrStream *s, double size) {
  (void)size;
  ScrZlibStream *zs = scr_zs_of(cb);
  if (zs->wait_read) {
    zs->wait_read = false;
    scr_zs_submit(zs, s);
  }
  if (zs->done_pending) {
    zs->done_pending = false;
    scr_zs_finish(zs, s);
  }
}

static void scr_zs_destroy_inv(ScrClosure *cb, ScrStream *s, ScrError *err) {
  ScrZlibStream *zs = scr_zs_of(cb);
  zs->closed = true;
  scr_zs_close_engine(zs);
  scr_stream_destroy_done(s, err ? scr_error_retain(err) : NULL);
}

/* ── option validation (lib/internal/validators.js) ───────────────────── */

static const ScrDyn *scr_zs_opt(const ScrDyn *opts, const char *key) {
  if (opts == NULL || opts->kind != SCR_DYN_OBJ) return NULL;
  return scr_dyn_obj_get((ScrDyn *)opts, key, strlen(key));
}

static bool scr_zs_is_null(const ScrDyn *v) {
  return v == NULL || v->kind == SCR_DYN_UNDEF || v->kind == SCR_DYN_NULL;
}

/* getHighWaterMark (lib/internal/streams/state.js): highWaterMark wins
 * over the sided key; a non-integer or negative value throws with the
 * sided name. -1 = the default. */
static bool scr_zs_hwm_value(const ScrDyn *v, const char *name, double *out) {
  if (v->kind != SCR_DYN_NUM || !isfinite(v->v.num) || trunc(v->v.num) != v->v.num ||
      v->v.num < 0) {
    scr_dyn_arg_value_fail(name, NULL, v);
    return false;
  }
  *out = v->v.num;
  return true;
}

static bool scr_zs_hwm(const ScrDyn *opts, const char *sided, const char *name, double *out) {
  const ScrDyn *v = scr_zs_opt(opts, "highWaterMark");
  if (scr_zs_is_null(v)) v = scr_zs_opt(opts, sided);
  *out = -1;
  if (scr_zs_is_null(v)) return true;
  return scr_zs_hwm_value(v, name, out);
}

static bool scr_zs_false(const ScrDyn *v) {
  return v != NULL && v->kind == SCR_DYN_BOOL && !v->v.b;
}

static bool scr_zs_unsupported(const char *msg) {
  scr_throw_error_msg(SCR_ERR_ERROR, msg, strlen(msg));
  return false;
}

/* The Transform options Node would consume with no lowering here. */
static bool scr_zs_check_unlowered(const ScrDyn *opts) {
  if (opts == NULL || opts->kind != SCR_DYN_OBJ) return true;
  const ScrDyn *v = scr_zs_opt(opts, "readableObjectMode");
  if (v != NULL && scr_dyn_truthy(v))
    return scr_zs_unsupported("objectMode streams are not supported yet (chunks are Buffers or utf8 strings)");
  if (scr_zs_false(scr_zs_opt(opts, "decodeStrings")))
    return scr_zs_unsupported("decodeStrings: false is not supported yet (chunks always decode to Buffers)");
  v = scr_zs_opt(opts, "signal");
  if (!scr_zs_is_null(v))
    return scr_zs_unsupported("the stream option 'signal' is not supported yet (AbortSignal-driven destruction has no lowering)");
  v = scr_zs_opt(opts, "defaultEncoding");
  if (v != NULL && v->kind == SCR_DYN_STR &&
      !(v->v.str->len == 4 && memcmp(v->v.str->data, "utf8", 4) == 0) &&
      !(v->v.str->len == 5 && memcmp(v->v.str->data, "utf-8", 5) == 0))
    return scr_zs_unsupported("the stream option 'defaultEncoding' is not supported yet (utf8, the default, is the write-side string encoding)");
  static const char *const fns[] = { "construct", "read", "write", "writev", "final", "destroy",
                                     "transform" };
  for (size_t i = 0; i < sizeof fns / sizeof fns[0]; i++) {
    v = scr_zs_opt(opts, fns[i]);
    if (v != NULL && v->kind == SCR_DYN_FUNC) {
      char msg[160];
      snprintf(msg, sizeof msg,
               "the zlib stream option '%s' is not supported yet (it would replace the zlib transform)",
               fns[i]);
      return scr_zs_unsupported(msg);
    }
  }
  return true;
}

static const char *scr_zs_class_name(int mode) {
  switch (mode) {
  case SCR_ZM_DEFLATE: return "Deflate";
  case SCR_ZM_INFLATE: return "Inflate";
  case SCR_ZM_GZIP: return "Gzip";
  case SCR_ZM_GUNZIP: return "Gunzip";
  case SCR_ZM_DEFLATERAW: return "DeflateRaw";
  case SCR_ZM_INFLATERAW: return "InflateRaw";
  case 8: return "BrotliDecompress";
  case 9: return "BrotliCompress";
  default: return "Unzip";
  }
}

ScrStream *scr_zlib_stream_new(double mode_d, ScrDyn *opts) {
  /* A typed options object is read through its materialized view. */
  if (opts != NULL && opts->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *view = scr_dyn_typed_ref_materialize(opts);
    ScrStream *stream = scr_exc_pending() ? NULL : scr_zlib_stream_new(mode_d, view);
    scr_dyn_release(view);
    return stream;
  }
  int mode = (int)mode_d;
  const ScrDyn *o = opts != NULL && scr_dyn_truthy(opts) ? opts : NULL;
  ScrZlibOptions zo;
  if (!scr_zlib_options_parse(mode, opts, &zo)) return NULL;
  /* Transform(): the high-water marks, then the unlowered options. */
  double rhwm = -1, whwm = -1;
  bool hwm_ok = scr_zs_hwm(o, "readableHighWaterMark", "options.readableHighWaterMark", &rhwm);
  if (hwm_ok && rhwm == 0) {
    /* A zero readable mark: Transform drops highWaterMark and the writable
     * side reads `writableHighWaterMark || 0`. */
    const ScrDyn *w = scr_zs_opt(o, "writableHighWaterMark");
    whwm = 0;
    if (w != NULL && scr_dyn_truthy(w))
      hwm_ok = scr_zs_hwm_value(w, "options.writableHighWaterMark", &whwm);
  } else if (hwm_ok) {
    hwm_ok = scr_zs_hwm(o, "writableHighWaterMark", "options.writableHighWaterMark", &whwm);
  }
  if (!hwm_ok || !scr_zs_check_unlowered(o)) {
    scr_zlib_options_drop(&zo);
    return NULL;
  }
  ScrZlibStream *zs = calloc(1, sizeof *zs);
  if (!zs) scr_zlib_stream_oom();
  zs->rc = 1;
  zs->als = scr_als_capture();
  zs->mode = mode;
  zs->eng = scr_zlib_engine_from_options(mode, &zo);
  scr_zlib_options_drop(&zo);
  zs->chunk_size = (uint32_t)zo.chunk_size;
  zs->out_buf = malloc(zs->chunk_size);
  if (!zs->out_buf) scr_zlib_stream_oom();
  zs->default_flush = (int)zo.flush;
  zs->finish_flush = (int)zo.finish_flush;
  /* Brotli's full flush is BROTLI_OPERATION_FLUSH (brotliDefaultOpts). */
  zs->full_flush = mode == 8 || mode == 9 ? 1 : SCR_ZF_FULL;
  zs->level = zo.level;
  zs->strategy = zo.strategy;
  zs->reject_garbage = zo.reject_garbage;
  bool auto_destroy = !scr_zs_false(scr_zs_opt(o, "autoDestroy"));
  bool emit_close = !scr_zs_false(scr_zs_opt(o, "emitClose"));
  bool allow_half_open = !scr_zs_false(scr_zs_opt(o, "allowHalfOpen"));
  bool readable_side = !scr_zs_false(scr_zs_opt(o, "readable"));
  bool writable_side = !scr_zs_false(scr_zs_opt(o, "writable"));
  ScrStream *s = scr_stream_new_transform(rhwm, whwm, auto_destroy, emit_close, allow_half_open,
      readable_side, writable_side,
      scr_zs_hook(zs, (void *)&scr_zs_transform_inv), &scr_zs_transform_inv,
      scr_zs_hook(zs, (void *)&scr_zs_flush_inv), &scr_zs_flush_inv,
      scr_zs_hook(zs, (void *)&scr_zs_destroy_inv), &scr_zs_destroy_inv);
  scr_stream_set_read(s, scr_zs_hook(zs, (void *)&scr_zs_read_inv), &scr_zs_read_inv);
  scr_stream_set_flush_on_prefinish(s);
  s->cls = scr_zs_class_name(mode);
  zs->s = s;
  scr_stream_set_native(s, zs, &scr_zs_release_v); /* moves the creation reference */
  return s;
}

/* ── the instance surface ─────────────────────────────────────────────── */

static ScrZlibStream *scr_zs_from_stream(ScrStream *s) {
  ScrZlibStream *zs = scr_stream_native(s, &scr_zs_release_v);
  if (zs == NULL) {
    static const char msg[] = "the receiver is not a zlib stream";
    scr_throw_error_msg(SCR_ERR_TYPE, msg, sizeof msg - 1);
  }
  return zs;
}

bool scr_zlib_stream_is(ScrStream *s, double mode) {
  const ScrZlibStream *zs = scr_stream_native(s, &scr_zs_release_v);
  return zs != NULL && zs->mode == (int)mode;
}

double scr_zlib_stream_bytes_written(ScrStream *s) {
  ScrZlibStream *zs = scr_zs_from_stream(s);
  return zs ? zs->bytes_written : 0;
}

static void scr_zs_call0(ScrClosure *cb) {
  ((void (*)(ScrClosure *))cb->fn)(cb);
}

static void scr_zs_end_inv(ScrClosure *cb, va_list ap) {
  (void)ap;
  scr_zs_call0(cb);
}

/* flush(kind?, callback?) — kind arrives undefined when absent; the
 * frontend has already moved a function first argument into cb. */
void scr_zlib_stream_flush(ScrStream *s, ScrDyn *kind, ScrClosure *cb) {
  ScrZlibStream *zs = scr_zs_from_stream(s);
  if (!zs) {
    if (cb) scr_closure_release(cb);
    return;
  }
  double k;
  if (!scr_zlib_check_range(kind, "kind", false, 0, 5, zs->full_flush, &k)) {
    if (cb) scr_closure_release(cb);
    return;
  }
  if (scr_stream_prop(s, "writableFinished")) {
    if (cb) scr_next_tick(cb);
    return;
  }
  if (scr_stream_prop(s, "writableEnded")) {
    if (cb) {
      ScrStr *name = scr_str_new("end", 3);
      scr_emitter_release(scr_emitter_on((ScrEmitter *)s, name, cb, &scr_zs_end_inv, true, false));
      scr_str_release(name);
    }
    return;
  }
  int ki = (int)k;
  if (zs->flush_bufs[ki] == NULL) {
    /* a Buffer, as Node's kFlushBuffers are: write() passes a Buffer
     * through unchanged, so _transform recognizes the sentinel */
    zs->flush_bufs[ki] = scr_bytes_new(SCR_BYTES_U8, 0);
    zs->flush_bufs[ki]->is_buffer = true;
  }
  scr_stream_write(s, zs->flush_bufs[ki], cb);
}

/* params(level, strategy, callback): a sync flush first when either
 * changes, then the engine's deflateParams; the callback runs unless the
 * stream was destroyed meanwhile. */
static void scr_zs_params_after(ScrClosure *cb) {
  ScrStream *s = scr_box_get_ref(cb->caps[0]);
  double level = scr_box_get_f64(cb->caps[1]);
  double strategy = scr_box_get_f64(cb->caps[2]);
  ScrClosure *user = cb->ncaps > 3 ? scr_box_get_ref(cb->caps[3]) : NULL;
  ScrZlibStream *zs = scr_zs_from_stream(s);
  if (zs && zs->closed) {
    static const char msg[] =
        "zlib binding closed\nThis is caused by either a bug in Node.js or incorrect usage of "
        "Node.js internals.\nPlease open an issue with this stack trace at "
        "https://github.com/nodejs/node/issues\n";
    scr_throw_error_msg_code(SCR_ERR_ERROR, msg, sizeof msg - 1, "ERR_INTERNAL_ASSERTION");
  } else if (zs) {
    ScrZlibError ze;
    if (scr_zlib_engine_params(zs->eng, isnan(level) ? 0 : (int)level,
                               isnan(strategy) ? 0 : (int)strategy, &ze)) {
      zs->closed = true;
      scr_zs_destroy_with(s, scr_zs_engine_error(&ze));
    }
    if (!scr_stream_prop(s, "destroyed")) {
      zs->level = level;
      zs->strategy = strategy;
      if (user) scr_zs_call0(user);
    }
  }
  if (user) scr_closure_release(user);
  scr_stream_release(s);
}

void scr_zlib_stream_params(ScrStream *s, ScrDyn *level_d, ScrDyn *strategy_d, ScrClosure *cb) {
  ScrZlibStream *zs = scr_zs_from_stream(s);
  double level, strategy;
  if (!zs || !scr_zlib_check_range(level_d, "level", false, -1, 9, NAN, &level) ||
      !scr_zlib_check_range(strategy_d, "strategy", false, 0, 4, NAN, &strategy)) {
    if (cb) scr_closure_release(cb);
    return;
  }
  bool same_level = level == zs->level || (isnan(level) && isnan(zs->level));
  bool same_strategy = strategy == zs->strategy || (isnan(strategy) && isnan(zs->strategy));
  if (same_level && same_strategy) {
    if (cb == NULL) {
      ScrDyn *undef = scr_dyn_undefined();
      scr_dyn_arg_type_fail("callback", "of type function", undef);
      return;
    }
    scr_next_tick(cb);
    return;
  }
  /* caps: the stream, level, strategy, then the callback when given */
  ScrClosure *after = scr_closure_new((void *)&scr_zs_params_after, cb ? 4 : 3);
  after->caps[0] = scr_box_new_obj(&scr_stream_retain_v, &scr_stream_release_v, &scr_stream_trace);
  scr_box_set_ref(after->caps[0], scr_stream_retain(s));
  after->caps[1] = scr_box_new(SCR_BOX_F64);
  scr_box_set_f64(after->caps[1], level);
  after->caps[2] = scr_box_new(SCR_BOX_F64);
  scr_box_set_f64(after->caps[2], strategy);
  if (cb) {
    after->caps[3] = scr_box_new(SCR_BOX_FUNC);
    scr_box_set_ref(after->caps[3], cb);
  }
  ScrDyn *sync = scr_dyn_new_num(SCR_ZF_SYNC);
  scr_zlib_stream_flush(s, sync, after);
  scr_dyn_release(sync);
}

static void scr_zs_close_inv(ScrClosure *cb, ScrStream *s, ScrError *err) {
  (void)s;
  (void)err;
  scr_zs_call0(cb);
}

/* close(callback?): finished(this, callback), then destroy(). */
void scr_zlib_stream_close(ScrStream *s, ScrClosure *cb) {
  if (!scr_zs_from_stream(s)) {
    if (cb) scr_closure_release(cb);
    return;
  }
  if (cb) {
    ScrClosure *cleanup = scr_stream_finished(s, cb, &scr_zs_close_inv);
    if (cleanup) scr_closure_release(cleanup);
  }
  scr_stream_release(scr_stream_destroy(s, NULL));
}

void scr_zlib_stream_reset(ScrStream *s) {
  ScrZlibStream *zs = scr_zs_from_stream(s);
  if (!zs) return;
  if (zs->closed) {
    static const char msg[] =
        "zlib binding closed\nThis is caused by either a bug in Node.js or incorrect usage of "
        "Node.js internals.\nPlease open an issue with this stack trace at "
        "https://github.com/nodejs/node/issues\n";
    scr_throw_error_msg_code(SCR_ERR_ERROR, msg, sizeof msg - 1, "ERR_INTERNAL_ASSERTION");
    return;
  }
  if (zs->write_in_progress) {
    static const char msg[] = "Cannot reset zlib stream while a write is in progress";
    scr_throw_error_msg(SCR_ERR_ERROR, msg, sizeof msg - 1);
    return;
  }
  ScrZlibError ze;
  if (scr_zlib_engine_reset(zs->eng, &ze)) {
    zs->closed = true;
    scr_zs_destroy_with(s, scr_zs_engine_error(&ze));
  }
}
