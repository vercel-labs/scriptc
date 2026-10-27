/* Readable.fromWeb (Node's newStreamReadableFromReadableStream in
 * internal/webstreams/adapters.js): a Readable over a web ReadableStream's
 * reader. read() queues one read request (scr_fetch_reader_read_into); a
 * chunk is pushed in a microtask, the end pushes null and an error
 * destroys the Readable. destroy() cancels the reader unless it has
 * closed, then completes. reader.closed's settlement marks it closed (a
 * rejection also destroys the Readable). Linked only by programs that
 * use both streams and the native web streams. */
#include "scr_runtime.h"
#include "scr_stream.h"

#include <stdlib.h>
#include <string.h>

typedef struct SfwCtx SfwCtx;
struct SfwCtx {
  size_t rc;
  ScrStream *readable; /* +1 until teardown */
  ScrDyn *reader;      /* +1 */
  ScrDyn *pending;     /* +1: pendingChunk, or NULL */
  bool closed;
  SfwCtx *live_prev, *live_next;
};

static SCR_TL SfwCtx *sfw_live = NULL;

static SfwCtx *sfw_ref(SfwCtx *c) {
  c->rc++;
  return c;
}

static void sfw_unref(SfwCtx *c) {
  if (--c->rc > 0) return;
  if (c->readable) scr_stream_release(c->readable);
  if (c->reader) scr_dyn_release(c->reader);
  if (c->pending) scr_dyn_release(c->pending);
  free(c);
}

static void *sfw_retain_v(void *p) { return sfw_ref(p); }
static void sfw_release_v(void *p) { sfw_unref(p); }

/* Drop the Readable (the cycle through its callbacks). */
static void sfw_teardown(SfwCtx *c) {
  if (c->live_prev) c->live_prev->live_next = c->live_next;
  else if (sfw_live == c) sfw_live = c->live_next;
  else return; /* already torn down */
  if (c->live_next) c->live_next->live_prev = c->live_prev;
  c->live_prev = c->live_next = NULL;
  ScrStream *r = c->readable;
  c->readable = NULL;
  if (r) scr_stream_release(r);
  sfw_unref(c); /* the live list's reference */
}

static void sfw_atexit(void) {
  while (sfw_live) sfw_teardown(sfw_live);
}

static ScrClosure *sfw_closure(void *fn, SfwCtx *c) {
  ScrClosure *cl = scr_closure_new(fn, 1);
  cl->caps[0] = scr_box_new_obj(&sfw_retain_v, &sfw_release_v, NULL);
  scr_box_set_ref(cl->caps[0], sfw_ref(c));
  return cl;
}

static SfwCtx *sfw_of(ScrClosure *cl) { return scr_box_get_ref(cl->caps[0]); /* +1 */ }

/* destroyer(readable, error) */
static void sfw_destroyer(SfwCtx *c, ScrDyn *reason) {
  ScrStream *r = c->readable;
  if (!r || scr_stream_prop(r, "destroyed")) return;
  ScrError *err = reason ? scr_error_from_dyn(reason) : NULL;
  if (scr_exc_pending()) scr_exc_clear();
  scr_stream_release(scr_stream_destroy(r, err));
  if (err) scr_error_release(err);
}

/* forwardChunk: readable.push(pendingChunk) */
static void sfw_forward(ScrClosure *job) {
  SfwCtx *c = sfw_of(job);
  ScrDyn *chunk = c->pending;
  c->pending = NULL;
  if (chunk && c->readable) {
    scr_stream_push_dyn(c->readable, chunk);
    if (scr_exc_pending()) scr_exc_clear();
  }
  if (chunk) scr_dyn_release(chunk);
  sfw_unref(c);
}

static void sfw_sink_chunk(void *ctx, ScrDyn *value) {
  SfwCtx *c = ctx;
  if (c->pending) scr_dyn_release(c->pending);
  c->pending = scr_dyn_retain(value);
  scr_queue_microtask(sfw_closure((void *)&sfw_forward, c));
  sfw_unref(c); /* the request's reference */
}

static void sfw_sink_close(void *ctx) {
  SfwCtx *c = ctx;
  if (c->readable) scr_stream_push_null(c->readable);
  if (scr_exc_pending()) scr_exc_clear();
  sfw_unref(c);
}

static void sfw_sink_error(void *ctx, ScrDyn *reason) {
  SfwCtx *c = ctx;
  sfw_destroyer(c, reason);
  sfw_unref(c);
}

static const ScrFetchReadSink sfw_sink = {&sfw_sink_chunk, &sfw_sink_close, &sfw_sink_error};

/* read(): readableStreamDefaultReaderRead(reader, readRequest) */
static void sfw_read_inv(ScrClosure *cb, ScrStream *s, double size) {
  (void)s;
  (void)size;
  SfwCtx *c = sfw_of(cb);
  if (c->reader) {
    if (!scr_fetch_reader_read_into(c->reader, &sfw_sink, sfw_ref(c))) {
      sfw_unref(c);
      if (scr_exc_pending()) scr_exc_clear();
    }
  }
  sfw_unref(c);
}

/* destroy's done(): callback(error) */
typedef struct {
  SfwCtx *c;      /* +1 */
  ScrStream *s;   /* +1 */
  ScrError *err;  /* +1 or NULL */
  ScrDyn *cancel; /* +1: reader.cancel(error)'s promise */
} SfwDestroy;

static void sfw_destroy_done(SfwCtx *c, ScrStream *s, ScrError *err) {
  scr_stream_destroy_done(s, err ? scr_error_retain(err) : NULL);
  sfw_teardown(c);
}

static void sfw_cancel_entry(ScrFiber *fiber, void *arg) {
  (void)fiber;
  SfwDestroy d = *(SfwDestroy *)arg;
  free(arg);
  ScrDyn *v = scr_await_ref(d.cancel->v.promise); /* then(done, done) */
  if (scr_exc_pending()) scr_exc_clear();
  if (v) scr_dyn_release(v);
  sfw_destroy_done(d.c, d.s, d.err);
  if (d.err) scr_error_release(d.err);
  scr_stream_release(d.s);
  scr_dyn_release(d.cancel);
  sfw_unref(d.c);
}

static void sfw_destroy_inv(ScrClosure *cb, ScrStream *s, ScrError *err) {
  SfwCtx *c = sfw_of(cb);
  if (!c->closed && c->reader) {
    /* _destroy(err, cb) gets null for a destroy without an error */
    ScrDyn *reason = err ? scr_dyn_from_error(err) : scr_dyn_new_null();
    ScrDyn *cancel = scr_dyn_invoke(c->reader, "cancel", &reason, 1, "reader.cancel");
    scr_dyn_release(reason);
    if (cancel && cancel->kind == SCR_DYN_PROMISE) {
      SfwDestroy *d = malloc(sizeof *d);
      if (!d) abort();
      d->c = sfw_ref(c);
      d->s = scr_stream_retain(s);
      d->err = err ? scr_error_retain(err) : NULL;
      d->cancel = cancel;
      scr_promise_release(scr_async_spawn_after(cancel->v.promise, &sfw_cancel_entry, d));
      sfw_unref(c);
      return;
    }
    if (cancel) scr_dyn_release(cancel);
    if (scr_exc_pending()) scr_exc_clear();
  }
  sfw_destroy_done(c, s, err);
  sfw_unref(c);
}

/* reader.closed.then(() => closed = true, (e) => { closed = true; destroy(readable, e) }) */
typedef struct {
  SfwCtx *c;      /* +1 */
  ScrDyn *closed; /* +1, the promise */
} SfwClosed;

static void sfw_closed_entry(ScrFiber *fiber, void *arg) {
  (void)fiber;
  SfwClosed w = *(SfwClosed *)arg;
  free(arg);
  ScrDyn *v = scr_await_ref(w.closed->v.promise);
  w.c->closed = true;
  if (scr_exc_pending()) {
    ScrCaught *caught = scr_exc_take();
    ScrDyn *reason = scr_caught_to_dyn(caught);
    scr_caught_release(caught);
    sfw_destroyer(w.c, reason);
    if (reason) scr_dyn_release(reason);
  }
  if (v) scr_dyn_release(v);
  scr_dyn_release(w.closed);
  sfw_unref(w.c);
}

/* web: the ReadableStream (borrowed); hwm < 0 = the mode's default;
 * encoding NULL or a known name (borrowed). +1, or NULL with the error
 * pending. */
ScrStream *scr_stream_readable_from_web(ScrDyn *web, bool object_mode, double hwm, ScrStr *encoding) {
  if (encoding && encoding->len == 0) encoding = NULL;
  if (!web || web->kind != SCR_DYN_HANDLE || web->v.handle.tag != SCR_DYNH_WEB_STREAM) {
    scr_dyn_arg_type_fail("readableStream", "an instance of ReadableStream", web);
    return NULL;
  }
  ScrDyn *reader = scr_dyn_invoke(web, "getReader", NULL, 0, "readableStream.getReader");
  if (!reader) return NULL;
  SfwCtx *c = calloc(1, sizeof *c);
  if (!c) abort();
  c->rc = 1;
  c->reader = reader;
  ScrStream *r = scr_stream_new_readable(hwm < 0 ? (object_mode ? 16 : -1) : hwm, true, true,
                                         sfw_closure((void *)&sfw_read_inv, c), &sfw_read_inv,
                                         sfw_closure((void *)&sfw_destroy_inv, c), &sfw_destroy_inv);
  if (object_mode) scr_stream_set_object_mode(r, true, false);
  if (encoding) scr_stream_release(scr_stream_set_encoding(r, encoding));
  c->readable = scr_stream_retain(r);
  static SCR_TL bool registered = false;
  if (!registered) {
    registered = true;
    scr_atexit(sfw_atexit);
  }
  c->live_next = sfw_live;
  if (sfw_live) sfw_live->live_prev = c;
  sfw_live = c; /* the reference c was created with */
  ScrStr *key = scr_str_new("closed", 6);
  ScrDyn *closed = scr_dyn_handle_key_get(reader, key);
  scr_str_release(key);
  if (closed && closed->kind == SCR_DYN_PROMISE) {
    SfwClosed *w = malloc(sizeof *w);
    if (!w) abort();
    w->c = sfw_ref(c);
    w->closed = closed;
    scr_promise_release(scr_async_spawn_after(closed->v.promise, &sfw_closed_entry, w));
  } else if (closed) {
    scr_dyn_release(closed);
  }
  return r;
}
