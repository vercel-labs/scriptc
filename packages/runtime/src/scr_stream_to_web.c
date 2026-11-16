/* Readable.toWeb (Node's newReadableStreamFromStreamReadable in
 * lib/internal/webstreams/adapters.js): a web ReadableStream over a Node
 * readable's chunks. Each pull queues one read on the readable
 * (scr_stream_next_chunk_dyn) and forwards what it settles with — the chunk,
 * the end marker, or the rejection — through the stream-over-reads source
 * (scr_webstream_readable_over), which enqueues it into the stream's
 * controller. Cancel destroys the readable with the cancel reason. Linked
 * only by programs that use both the stream and web stream units. */
#include "scr_runtime.h"
#include "scr_stream.h"

#include <string.h>
#include <stdio.h>

typedef struct StwCtx StwCtx;
struct StwCtx {
  size_t rc;
  ScrStream *readable; /* +1 until the source drops it */
  bool cancelled;
};

static StwCtx *stw_ref(StwCtx *c) {
  c->rc++;
  return c;
}

static void stw_unref(StwCtx *c) {
  if (--c->rc > 0) return;
  if (c->readable) scr_stream_release(c->readable);
  free(c);
}

static void *stw_ref_v(void *p) { return stw_ref(p); }
static void stw_unref_v(void *p) { stw_unref(p); }

/* One queued read: the web stream's sink and the source's own context. The
 * fulfill and reject closures hold one reference each; the reaction drops
 * the closure that does not run, which releases that reference. */
typedef struct StwRead StwRead;
struct StwRead {
  size_t rc;
  StwCtx *ctx; /* +1 */
  const ScrFetchReadSink *sink;
  void *sink_ctx; /* the web stream's request reference; the sink releases it */
};

static StwRead *stw_read_new(StwCtx *c, const ScrFetchReadSink *sink, void *sink_ctx) {
  StwRead *r = calloc(1, sizeof *r);
  if (!r) abort();
  r->rc = 1;
  r->ctx = stw_ref(c);
  r->sink = sink;
  r->sink_ctx = sink_ctx;
  return r;
}

static void stw_read_drop(StwRead *r) {
  if (--r->rc > 0) return;
  stw_unref(r->ctx);
  free(r);
}

static void *stw_read_ref_v(void *p) {
  ((StwRead *)p)->rc++;
  return p;
}

static void stw_read_drop_v(void *p) { stw_read_drop(p); }

/* A closure over one read reference, for a promise reaction. */
static ScrClosure *stw_job(void *fn, StwRead *r) {
  ScrClosure *cl = scr_closure_new(fn, 1);
  cl->caps[0] = scr_box_new_obj(&stw_read_ref_v, &stw_read_drop_v, NULL);
  scr_box_set_ref(cl->caps[0], stw_read_ref_v(r));
  return cl;
}

static StwRead *stw_job_read(ScrClosure *cl) { return scr_box_get_ref(cl->caps[0]); /* +1 */ }

/* Node's adapter copies a Buffer chunk into a plain Uint8Array before it
 * enqueues it (`new Uint8Array(chunk)`, detached from the Buffer pool), so
 * the web stream never shares the readable's storage and answers the
 * Uint8Array brand; an object-mode chunk passes through unchanged. +1 when
 * it copied, otherwise the borrowed value. */
static ScrDyn *stw_detach_chunk(StwCtx *c, ScrDyn *value) {
  if (value->kind != SCR_DYN_BYTES || !value->buffer) return value;
  if (scr_stream_readable_object_entries(c->readable)) return value;
  ScrBytes *src = value->v.bytes;
  ScrBytes *copy = scr_bytes_new(SCR_BYTES_U8, (double)src->len);
  memcpy(copy->data, src->data, src->len);
  copy->is_buffer = false;
  ScrDyn *out = scr_dyn_new_bytes(copy);
  scr_bytes_release(copy);
  return out;
}

/* The read settled: the chunk, or the end marker; the sink answers the
 * pull either way. */
static ScrDyn *stw_on_chunk(ScrClosure *cl, ScrDyn *const *args, size_t argc) {
  StwRead *r = stw_job_read(cl);
  ScrDyn *value = argc > 0 ? args[0] : scr_dyn_undefined();
  ScrDyn *end = scr_stream_from_done();
  if (value == end) {
    r->sink->close(r->sink_ctx);
  } else {
    ScrDyn *chunk = stw_detach_chunk(r->ctx, value);
    r->sink->chunk(r->sink_ctx, chunk);
    if (chunk != value) scr_dyn_release(chunk);
  }
  scr_dyn_release(end);
  stw_read_drop(r);
  if (scr_exc_pending()) scr_exc_clear(); /* a continuation leaves none pending */
  return scr_dyn_retain(scr_dyn_undefined());
}

/* The read rejected (the readable errored or was destroyed): the stream
 * takes the reason as its error. */
static ScrDyn *stw_on_error(ScrClosure *cl, ScrDyn *const *args, size_t argc) {
  StwRead *r = stw_job_read(cl);
  ScrDyn *reason = argc > 0 ? args[0] : scr_dyn_undefined();
  r->sink->error(r->sink_ctx, reason);
  stw_read_drop(r);
  if (scr_exc_pending()) scr_exc_clear();
  return scr_dyn_retain(scr_dyn_undefined());
}

/* read_into: one read of the readable, one buffered chunk at a time (Node's
 * adapter enqueues each 'data' chunk), answered through the sink. */
static bool stw_read_into(void *ctx, const ScrFetchReadSink *sink, void *sink_ctx) {
  StwCtx *c = ctx;
  ScrPromise *p = scr_stream_next_chunk_dyn_single(c->readable);
  if (!p) return false; /* the read reported its own error; the caller drops */
  StwRead *r = stw_read_new(c, sink, sink_ctx);
  ScrClosure *fc = stw_job((void *)&stw_on_chunk, r);
  ScrClosure *rc = stw_job((void *)&stw_on_error, r);
  /* The two closures hold the read now (one reference each). */
  stw_read_drop(r);
  ScrDyn *onf = scr_dyn_new_func(fc, &stw_on_chunk, 1, "(chunk)", "toWeb");
  ScrDyn *onr = scr_dyn_new_func(rc, &stw_on_error, 1, "(reason)", "toWeb");
  ScrDyn *chained = scr_dyn_promise_then(p, onf, onr, NULL);
  if (chained) scr_dyn_release(chained);
  scr_dyn_release(onf);
  scr_dyn_release(onr);
  scr_promise_release(p);
  return true;
}

/* cancel(reason): destroy the readable with the reason, as Node's adapter
 * does; the stream answers an already-settled promise. */
static ScrPromise *stw_cancel(void *ctx, ScrDyn *reason) {
  StwCtx *c = ctx;
  c->cancelled = true;
  ScrStream *s = scr_stream_retain(c->readable);
  ScrError *err = NULL;
  if (reason && reason->kind != SCR_DYN_NULL && reason->kind != SCR_DYN_UNDEF) {
    err = scr_error_from_dyn(reason);
  }
  scr_stream_release(scr_stream_destroy(s, err));
  scr_stream_release(s);
  if (err) scr_error_release(err);
  if (scr_exc_pending()) scr_exc_clear();
  ScrPromise *done = scr_promise_new();
  ScrDyn *value = scr_dyn_retain(scr_dyn_undefined());
  scr_promise_fulfill_ref(done, value, scr_dyn_retain_v, scr_dyn_release_v, NULL);
  return done;
}

static void stw_release(void *ctx) { stw_unref((StwCtx *)ctx); }

static const ScrWebStreamSource stw_source = {stw_read_into, stw_cancel, stw_release};

/* The adapter's own 'error' listener: Node's toWeb keeps an eos watcher on
 * the readable, which is what stops a lifecycle error (a cancel reason
 * included) from crashing the program as an unhandled 'error' event. The
 * read's rejection is how the web stream learns of it. */
static void stw_noop(ScrClosure *cl) { (void)cl; }

/* One listener per adapted readable: a process-global template would cross
 * worker runtimes (one worker's cleanup could release it while another still
 * uses it). The stream's listener table owns the closure. */
static void stw_watch_errors(ScrStream *s) {
  ScrClosure *listener = scr_closure_new((void *)&stw_noop, 0);
  ScrStr *name = scr_str_new("error", 5);
  scr_emitter_release(scr_emitter_on((ScrEmitter *)s, name,
                                     scr_closure_retain(listener), scr_ee_inv_fixed0, false,
                                     false));
  scr_str_release(name);
  scr_closure_release(listener);
}

/* Readable.toWeb(readable[, options]): the web ReadableStream (+1). flags'
 * bit 1 asks for a byte stream (options.type === 'bytes'). */
ScrDyn *scr_stream_to_web_readable(ScrStream *s, double flags) {
  (void)flags;
  StwCtx *c = calloc(1, sizeof *c);
  if (!c) abort();
  c->rc = 1;
  c->readable = scr_stream_retain(s);
  stw_watch_errors(s);
  return scr_webstream_readable_over(&stw_source, c); /* the stream takes the context's reference */
}

/* Readable.toWeb over a checked-dynamic value: a boxed native readable
 * unwraps, and any other value throws the not-supported Error. */
ScrDyn *scr_stream_to_web_readable_dyn(const ScrDyn *value, double flags) {
  ScrStream *s = scr_stream_native_readable_of_dyn(value);
  if (!s) {
    static const char message[] =
        "Readable.toWeb over a checked-dynamic value that is not a native readable stream is not supported yet";
    scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
    return NULL;
  }
  ScrDyn *out = scr_stream_to_web_readable(s, flags);
  scr_stream_release(s);
  return out;
}
