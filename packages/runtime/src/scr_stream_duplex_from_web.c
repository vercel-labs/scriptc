/* Duplex.fromWeb (Node's newStreamDuplexFromReadableWritablePair in
 * lib/internal/webstreams/adapters.js): a Duplex that owns the web pair's
 * reader and writer directly.
 *
 *   read()      one read request at a time; a chunk is pushed, the end pushes
 *               null, a rejection destroys the Duplex.
 *   write()     awaits writer.write(chunk); the write completes with that
 *               promise's outcome.
 *   final()     awaits writer.close().
 *   destroy()   aborts the writer (the destroy's error, or null) and cancels
 *               the reader, then completes with the destroy's error.
 *
 * writer.closed settling before end() is Node's premature close; a rejected
 * writer.closed destroys the Duplex with that reason. */
#include "scr_runtime.h"
#include "scr_stream.h"

#include <stdlib.h>

typedef struct SdfwCtx SdfwCtx;
struct SdfwCtx {
  size_t rc;
  ScrStream *duplex; /* +1 until teardown */
  ScrDyn *reader;    /* +1 */
  ScrDyn *writer;    /* +1 */
  ScrDyn *pending;   /* +1: a read chunk awaiting the forward microtask */
  bool reader_closed;
  bool writer_closed;
  /* _destroy: the error it settles with, and how many side operations
   * (writer abort, reader cancel) are still awaited. */
  bool destroying;
  int destroy_waiting;
  ScrError *destroy_err; /* +1 while the destroy runs */
  SdfwCtx *live_prev, *live_next;
};

static SCR_TL SdfwCtx *sdfw_live = NULL;

static SdfwCtx *sdfw_ref(SdfwCtx *c) {
  c->rc++;
  return c;
}

static void sdfw_unref(SdfwCtx *c) {
  if (--c->rc > 0) return;
  if (c->duplex) scr_stream_release(c->duplex);
  if (c->reader) scr_dyn_release(c->reader);
  if (c->writer) scr_dyn_release(c->writer);
  if (c->pending) scr_dyn_release(c->pending);
  if (c->destroy_err) scr_error_release(c->destroy_err);
  free(c);
}

static void *sdfw_retain_v(void *p) { return sdfw_ref(p); }
static void sdfw_release_v(void *p) { sdfw_unref(p); }

/* Drop the Duplex (the cycle through its callbacks). */
static void sdfw_teardown(SdfwCtx *c) {
  if (c->live_prev) c->live_prev->live_next = c->live_next;
  else if (sdfw_live == c) sdfw_live = c->live_next;
  else return; /* already torn down */
  if (c->live_next) c->live_next->live_prev = c->live_prev;
  c->live_prev = c->live_next = NULL;
  ScrStream *d = c->duplex;
  c->duplex = NULL;
  if (d) scr_stream_release(d);
  sdfw_unref(c); /* the live list's reference */
}

static void sdfw_atexit(void) {
  while (sdfw_live) sdfw_teardown(sdfw_live);
}

static ScrClosure *sdfw_closure(void *fn, SdfwCtx *c) {
  ScrClosure *cl = scr_closure_new(fn, 1);
  cl->caps[0] = scr_box_new_obj(&sdfw_retain_v, &sdfw_release_v, NULL);
  scr_box_set_ref(cl->caps[0], sdfw_ref(c));
  return cl;
}

static SdfwCtx *sdfw_of(ScrClosure *cl) { return scr_box_get_ref(cl->caps[0]); /* +1 */ }

/* destroy(duplex, reason): a lifecycle error or a cancellation. */
static void sdfw_destroy_with(SdfwCtx *c, ScrDyn *reason) {
  ScrStream *d = c->duplex;
  if (!d) return;
  ScrError *err = reason ? scr_error_from_dyn(reason) : NULL;
  if (scr_exc_pending()) scr_exc_clear();
  scr_stream_release(scr_stream_destroy(d, err));
  if (err) scr_error_release(err);
}

/* forwardChunk: duplex.push(pendingChunk) */
static void sdfw_forward(ScrClosure *job) {
  SdfwCtx *c = sdfw_of(job);
  ScrDyn *chunk = c->pending;
  c->pending = NULL;
  if (chunk && c->duplex) {
    scr_stream_push_dyn(c->duplex, chunk);
    if (scr_exc_pending()) scr_exc_clear();
  }
  if (chunk) scr_dyn_release(chunk);
  sdfw_unref(c);
}

/* One read request: the reader's read() promise, waited on outside the
 * stream machinery (the web unit answers { value, done }). */
typedef struct {
  SdfwCtx *ctx;    /* +1 */
  ScrDyn *promise; /* +1 */
} SdfwRead;

static void sdfw_read_entry(ScrFiber *fiber, void *arg) {
  (void)fiber;
  SdfwRead r = *(SdfwRead *)arg;
  free(arg);
  ScrDyn *result = scr_await_ref(r.promise->v.promise);
  if (scr_exc_pending()) {
    ScrCaught *caught = scr_exc_take();
    ScrDyn *reason = scr_caught_to_dyn(caught);
    scr_caught_release(caught);
    r.ctx->reader_closed = true;
    sdfw_destroy_with(r.ctx, reason);
    if (reason) scr_dyn_release(reason);
  } else if (result) {
    ScrDyn *done = scr_dyn_obj_read(result, "done", 4);
    bool finished = done != NULL && scr_dyn_truthy(done);
    if (done) scr_dyn_release(done);
    if (finished) {
      r.ctx->reader_closed = true;
      if (r.ctx->duplex) scr_stream_push_null(r.ctx->duplex);
      if (scr_exc_pending()) scr_exc_clear();
    } else {
      ScrDyn *value = scr_dyn_obj_read(result, "value", 5);
      if (value && r.ctx->duplex) {
        if (r.ctx->pending) scr_dyn_release(r.ctx->pending);
        r.ctx->pending = scr_dyn_retain(value);
        scr_queue_microtask(sdfw_closure((void *)&sdfw_forward, r.ctx));
      }
      if (value) scr_dyn_release(value);
    }
  }
  if (result) scr_dyn_release(result);
  scr_dyn_release(r.promise);
  sdfw_unref(r.ctx);
}

/* read(): readableStreamDefaultReaderRead(reader, readRequest) */
static void sdfw_read_inv(ScrClosure *cb, ScrStream *s, double size) {
  (void)s;
  (void)size;
  SdfwCtx *c = sdfw_of(cb);
  if (c->reader && !c->reader_closed && !c->pending) {
    ScrDyn *promise = scr_dyn_invoke(c->reader, "read", NULL, 0, "reader.read");
    if (promise && promise->kind == SCR_DYN_PROMISE) {
      SdfwRead *r = malloc(sizeof *r);
      if (!r) abort();
      r->ctx = sdfw_ref(c);
      r->promise = promise;
      scr_promise_release(scr_async_spawn_after(promise->v.promise, &sdfw_read_entry, r));
    } else if (promise) {
      scr_dyn_release(promise);
    }
    if (scr_exc_pending()) scr_exc_clear();
  }
  sdfw_unref(c);
}

/* One awaited side operation: the ctx and the promise it waits on. */
typedef struct {
  SdfwCtx *ctx;     /* +1 */
  ScrDyn *promise;  /* +1 */
  int which;        /* 0 write, 1 final, 2 destroy side operation */
} SdfwAwait;

static void sdfw_destroy_side_settled(SdfwCtx *c);

static void sdfw_await_entry(ScrFiber *fiber, void *arg) {
  (void)fiber;
  SdfwAwait a = *(SdfwAwait *)arg;
  free(arg);
  ScrDyn *value = scr_await_ref(a.promise->v.promise);
  ScrError *err = NULL;
  if (scr_exc_pending()) {
    ScrCaught *caught = scr_exc_take();
    ScrDyn *reason = scr_caught_to_dyn(caught);
    scr_caught_release(caught);
    err = reason ? scr_error_from_dyn(reason) : NULL;
    if (reason) scr_dyn_release(reason);
  }
  if (value) scr_dyn_release(value);
  switch (a.which) {
  case 0:
    if (a.ctx->duplex) scr_stream_write_done(a.ctx->duplex, err ? scr_error_retain(err) : NULL);
    break;
  case 1:
    if (a.ctx->duplex) scr_stream_final_done(a.ctx->duplex, err ? scr_error_retain(err) : NULL);
    break;
  default:
    sdfw_destroy_side_settled(a.ctx);
    break;
  }
  if (err) scr_error_release(err);
  scr_dyn_release(a.promise);
  sdfw_unref(a.ctx);
}

static void sdfw_await(SdfwCtx *c, ScrDyn *result, int which) {
  if (!result || result->kind != SCR_DYN_PROMISE) {
    switch (which) {
    case 0:
      if (c->duplex) scr_stream_write_done(c->duplex, NULL);
      break;
    case 1:
      if (c->duplex) scr_stream_final_done(c->duplex, NULL);
      break;
    default:
      sdfw_destroy_side_settled(c);
      break;
    }
    return;
  }
  SdfwAwait *a = malloc(sizeof *a);
  if (!a) abort();
  a->ctx = sdfw_ref(c);
  a->promise = scr_dyn_retain(result);
  a->which = which;
  scr_promise_release(scr_async_spawn_after(result->v.promise, &sdfw_await_entry, a));
}

/* _write: writer.write(chunk) */
static void sdfw_write_inv(ScrClosure *cb, ScrStream *s, ScrBytes *chunk) {
  (void)s;
  SdfwCtx *c = sdfw_of(cb);
  ScrDyn *value = scr_dyn_new_bytes(chunk);
  ScrDyn *result = NULL;
  if (c->writer) result = scr_dyn_invoke(c->writer, "write", &value, 1, "writer.write");
  scr_dyn_release(value);
  sdfw_await(c, result, 0);
  if (result) scr_dyn_release(result);
  sdfw_unref(c);
}

/* _final: writer.close() */
static void sdfw_final_inv(ScrClosure *cb, ScrStream *s) {
  (void)s;
  SdfwCtx *c = sdfw_of(cb);
  ScrDyn *result = c->writer ? scr_dyn_invoke(c->writer, "close", NULL, 0, "writer.close") : NULL;
  sdfw_await(c, result, 1);
  if (result) scr_dyn_release(result);
  sdfw_unref(c);
}

/* _destroy: abort the writer and cancel the reader, then complete with the
 * destroy's own error. */
static void sdfw_destroy_side_settled(SdfwCtx *c) {
  c->destroy_waiting--;
  if (c->destroy_waiting > 0 || !c->destroying) return;
  c->destroying = false;
  ScrStream *d = c->duplex;
  ScrError *err = c->destroy_err;
  c->destroy_err = NULL;
  if (d) {
    scr_stream_destroy_done(d, err); /* moves */
    sdfw_teardown(c);
  } else if (err) {
    scr_error_release(err);
  }
}

static void sdfw_destroy_inv(ScrClosure *cb, ScrStream *s, ScrError *err) {
  (void)s;
  SdfwCtx *c = sdfw_of(cb);
  if (c->destroy_err) scr_error_release(c->destroy_err);
  c->destroy_err = err ? scr_error_retain(err) : NULL;
  c->destroying = true;
  c->destroy_waiting = 0;
  if (c->writer && !c->writer_closed) {
    ScrDyn *reason = err ? scr_dyn_from_error(err) : scr_dyn_new_null();
    ScrDyn *result = scr_dyn_invoke(c->writer, "abort", &reason, 1, "writer.abort");
    scr_dyn_release(reason);
    c->destroy_waiting++;
    sdfw_await(c, result, 2);
    if (result) scr_dyn_release(result);
  }
  if (c->reader && !c->reader_closed) {
    ScrDyn *reason = err ? scr_dyn_from_error(err) : scr_dyn_new_null();
    ScrDyn *result = scr_dyn_invoke(c->reader, "cancel", &reason, 1, "reader.cancel");
    scr_dyn_release(reason);
    c->destroy_waiting++;
    sdfw_await(c, result, 2);
    if (result) scr_dyn_release(result);
  }
  if (c->destroy_waiting == 0) {
    c->destroying = false;
    ScrStream *d = c->duplex;
    ScrError *own = c->destroy_err;
    c->destroy_err = NULL;
    if (d) {
      scr_stream_destroy_done(d, own);
      sdfw_teardown(c);
    } else if (own) {
      scr_error_release(own);
    }
  }
  sdfw_unref(c);
}

/* One web side's `closed` promise: rejecting it fails the Duplex. */
typedef struct {
  SdfwCtx *ctx;    /* +1 */
  ScrDyn *promise; /* +1 */
} SdfwWatch;

static void sdfw_watch(ScrDyn *closed /*moves*/, SdfwCtx *c,
                       void (*entry)(ScrFiber *, void *)) {
  SdfwWatch *w = malloc(sizeof *w);
  if (!w) abort();
  w->ctx = sdfw_ref(c);
  w->promise = closed;
  scr_promise_release(scr_async_spawn_after(closed->v.promise, entry, w));
}

static void sdfw_watch_done(SdfwWatch *w) {
  scr_dyn_release(w->promise);
  sdfw_unref(w->ctx);
}

/* Watch a side handle's `closed` promise, when it has one. */
static void sdfw_watch_closed(ScrDyn *handle, SdfwCtx *c,
                              void (*entry)(ScrFiber *, void *)) {
  ScrDyn *closed = scr_dyn_obj_read(handle, "closed", 6);
  if (closed && closed->kind == SCR_DYN_PROMISE) {
    sdfw_watch(closed, c, entry); /* the +1 moves to the watch */
  } else if (closed) {
    scr_dyn_release(closed);
  }
}

/* writer.closed: a close before end() is Node's premature close; a rejection
 * destroys the Duplex with its reason. */
static void sdfw_closed_settle(SdfwCtx *c, ScrDyn *reason) {
  ScrStream *d = c->duplex;
  c->writer_closed = true;
  if (!d) return;
  if (reason) {
    sdfw_destroy_with(c, reason);
  } else if (scr_stream_prop(d, "writableEnded") == 0) {
    ScrStr *message = scr_str_new("Premature close", 15);
    ScrError *err = scr_error_new(SCR_ERR_ERROR, message);
    scr_str_release(message);
    if (err) {
      scr_error_set_code(err, "ERR_STREAM_PREMATURE_CLOSE");
      scr_stream_release(scr_stream_destroy(d, err));
      scr_error_release(err);
    }
  }
  if (scr_exc_pending()) scr_exc_clear();
}

static void sdfw_closed_entry(ScrFiber *fiber, void *arg) {
  (void)fiber;
  SdfwWatch w = *(SdfwWatch *)arg;
  free(arg);
  ScrDyn *value = scr_await_ref(w.promise->v.promise);
  ScrDyn *reason = NULL;
  if (scr_exc_pending()) {
    ScrCaught *caught = scr_exc_take();
    reason = scr_caught_to_dyn(caught);
    scr_caught_release(caught);
  }
  sdfw_closed_settle(w.ctx, reason);
  if (reason) scr_dyn_release(reason);
  if (value) scr_dyn_release(value);
  sdfw_watch_done(&w);
}

/* reader.closed: a rejected reader (the web readable errored) fails the
 * Duplex even when nothing has read it yet. A clean close is left to read(),
 * which pushes null. */
static void sdfw_reader_closed_entry(ScrFiber *fiber, void *arg) {
  (void)fiber;
  SdfwWatch w = *(SdfwWatch *)arg;
  free(arg);
  ScrDyn *value = scr_await_ref(w.promise->v.promise);
  if (scr_exc_pending()) {
    ScrCaught *caught = scr_exc_take();
    ScrDyn *reason = scr_caught_to_dyn(caught);
    scr_caught_release(caught);
    w.ctx->reader_closed = true;
    sdfw_destroy_with(w.ctx, reason);
    if (reason) scr_dyn_release(reason);
  }
  if (value) scr_dyn_release(value);
  sdfw_watch_done(&w);
}

/* Duplex.fromWeb({ readable, writable }): the Duplex (+1), or NULL with
 * ERR_INVALID_ARG_TYPE pending for a pair whose members are not web streams.
 * The options (allowHalfOpen, objectMode, encoding, decodeStrings,
 * highWaterMark, signal) have no lowering. */
ScrStream *scr_stream_duplex_from_web(ScrDyn *pair, double flags) {
  (void)flags;
  /* Node's validateObject(pair, 'pair'), then validateReadableStream and
   * validateWritableStream over the pair's members. */
  if (!pair || !scr_dyn_is_object(pair)) {
    scr_dyn_arg_type_fail("pair", "of type object", pair ? pair : scr_dyn_undefined());
    return NULL;
  }
  ScrDyn *readable = scr_dyn_obj_read(pair, "readable", 8);
  bool readable_ok = readable && readable->kind == SCR_DYN_HANDLE &&
                     (readable->v.handle.tag == SCR_DYNH_WS_READABLE ||
                      readable->v.handle.tag == SCR_DYNH_WEB_STREAM);
  if (!readable_ok) {
    scr_dyn_arg_type_fail("pair.readable", "an instance of ReadableStream",
                          readable ? readable : scr_dyn_undefined());
    if (readable) scr_dyn_release(readable);
    return NULL;
  }
  ScrDyn *writable = scr_dyn_obj_read(pair, "writable", 8);
  bool writable_ok = writable && writable->kind == SCR_DYN_HANDLE &&
                     (writable->v.handle.tag == SCR_DYNH_WS_WRITABLE ||
                      writable->v.handle.tag == SCR_DYNH_WEB_WRITABLE);
  if (!writable_ok) {
    scr_dyn_arg_type_fail("pair.writable", "an instance of WritableStream",
                          writable ? writable : scr_dyn_undefined());
    scr_dyn_release(readable);
    if (writable) scr_dyn_release(writable);
    return NULL;
  }
  ScrDyn *reader = scr_dyn_invoke(readable, "getReader", NULL, 0, "pair.readable.getReader");
  ScrDyn *writer = scr_dyn_invoke(writable, "getWriter", NULL, 0, "pair.writable.getWriter");
  scr_dyn_release(readable);
  scr_dyn_release(writable);
  if (!reader || !writer) {
    if (reader) scr_dyn_release(reader);
    if (writer) scr_dyn_release(writer);
    return NULL;
  }
  SdfwCtx *c = calloc(1, sizeof *c);
  if (!c) abort();
  /* Two references: the live list keeps this context reachable at exit
   * (sdfw_atexit tears it down), and this constructor holds the other to
   * drop on return. */
  c->rc = 2;
  c->reader = reader;
  c->writer = writer;
  ScrStream *d = scr_stream_new_duplex(
      -1, -1, true, true, false, true, true, sdfw_closure((void *)&sdfw_read_inv, c),
      &sdfw_read_inv, sdfw_closure((void *)&sdfw_write_inv, c), &sdfw_write_inv,
      sdfw_closure((void *)&sdfw_final_inv, c), &sdfw_final_inv,
      sdfw_closure((void *)&sdfw_destroy_inv, c), &sdfw_destroy_inv);
  c->duplex = scr_stream_retain(d);
  static SCR_TL bool registered = false;
  if (!registered) {
    registered = true;
    scr_atexit(sdfw_atexit);
  }
  c->live_next = sdfw_live;
  if (sdfw_live) sdfw_live->live_prev = c;
  sdfw_live = c;
  sdfw_watch_closed(writer, c, &sdfw_closed_entry);
  sdfw_watch_closed(reader, c, &sdfw_reader_closed_entry);
  sdfw_unref(c);
  return d;
}
