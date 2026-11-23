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
typedef struct SdfwWatch SdfwWatch;

/* A parked promise reaction: a side handle's `closed` promise, the in-flight
 * read, or an awaited write/final/destroy operation (see sdfw_watch). */
typedef enum {
  SDFW_WATCH_WRITER_CLOSED,
  SDFW_WATCH_READER_CLOSED,
  SDFW_WATCH_READ,
  SDFW_WATCH_WRITE,
  SDFW_WATCH_FINAL,
  SDFW_WATCH_DESTROY_SIDE,
} SdfwWatchKind;

struct SdfwWatch {
  SdfwCtx *ctx; /* while attached; NULL once detached or settled */
  SdfwWatchKind kind;
  SdfwWatch *prev, *next; /* the ctx's list */
};

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
  /* Closed-promise and in-flight operation watchers still parked. */
  SdfwWatch *watches;
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

/* Drop the Duplex (the cycle through its callbacks). Watchers still parked
 * on a promise that never settles are detached first: that promise cannot
 * reach this context once the pair is gone, and keeping the watch's
 * reference would keep the adapter and both stream handles alive. */
static void sdfw_teardown(SdfwCtx *c) {
  if (c->live_prev) c->live_prev->live_next = c->live_next;
  else if (sdfw_live == c) sdfw_live = c->live_next;
  else return; /* already torn down */
  if (c->live_next) c->live_next->live_prev = c->live_prev;
  c->live_prev = c->live_next = NULL;
  ScrStream *d = c->duplex;
  c->duplex = NULL;
  int watchers = 0;
  while (c->watches) {
    SdfwWatch *w = c->watches;
    c->watches = w->next;
    w->ctx = NULL;
    w->prev = NULL;
    w->next = NULL;
    watchers++;
  }
  if (d) scr_stream_release(d);
  while (watchers-- > 0) sdfw_unref(c);
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


/* One native promise reaction parked by the adapter: a side handle's
 * `closed` promise, the in-flight read, or an awaited write/final/destroy
 * operation. Node's adapter holds these as closures and lets the collector
 * reclaim them. A parked fiber in their place would keep the context — and
 * with it both stream handles — alive after a one-sided failure: Node marks
 * both halves closed and destroys without aborting or cancelling the healthy
 * half, so that half's promises can stay pending forever. The reaction's
 * drop releases the watch when its promise goes away, and the pair's
 * teardown detaches every watch still parked, which breaks the
 * context → handle → promise → reaction → context cycle. */
static void sdfw_closed_settle(SdfwCtx *c, ScrDyn *reason);
static void sdfw_destroy_side_settled(SdfwCtx *c);

/* Detaches a live watch and drops its reference on the context. */
static void sdfw_watch_unlink(SdfwWatch *w) {
  SdfwCtx *c = w->ctx;
  if (!c) return;
  if (w->prev) w->prev->next = w->next;
  else c->watches = w->next;
  if (w->next) w->next->prev = w->prev;
  w->prev = NULL;
  w->next = NULL;
  w->ctx = NULL;
  sdfw_unref(c);
}

/* The adapter's steps for one settled promise (Node's reaction body).
 * `outcome` is the rejection reason or the fulfillment value (+1). */
static void sdfw_watch_settled(SdfwCtx *c, SdfwWatchKind kind, bool rejected, ScrDyn *outcome) {
  switch (kind) {
  case SDFW_WATCH_WRITER_CLOSED:
    /* A close before end() is Node's premature close; a rejection destroys
     * the Duplex with its reason (both flags recorded in closed_settle). */
    sdfw_closed_settle(c, rejected ? outcome : NULL);
    break;
  case SDFW_WATCH_READER_CLOSED:
    /* The readable failed, so the pair is over on both sides: the destroy
     * completes at once instead of waiting for the writer's abort hook
     * (Node marks both closed before it destroys). A clean close is left to
     * read(), which pushes null. */
    if (rejected) {
      c->reader_closed = true;
      c->writer_closed = true;
      sdfw_destroy_with(c, outcome);
    }
    break;
  case SDFW_WATCH_READ:
    if (rejected) {
      c->reader_closed = true;
      sdfw_destroy_with(c, outcome);
      break;
    }
    if (outcome) {
      ScrDyn *done = scr_dyn_obj_read(outcome, "done", 4);
      bool finished = done != NULL && scr_dyn_truthy(done);
      if (done) scr_dyn_release(done);
      if (finished) {
        c->reader_closed = true;
        if (c->duplex) scr_stream_push_null(c->duplex);
        if (scr_exc_pending()) scr_exc_clear();
      } else {
        ScrDyn *value = scr_dyn_obj_read(outcome, "value", 5);
        if (value && c->duplex) {
          if (c->pending) scr_dyn_release(c->pending);
          c->pending = scr_dyn_retain(value);
          scr_queue_microtask(sdfw_closure((void *)&sdfw_forward, c));
        }
        if (value) scr_dyn_release(value);
      }
    }
    break;
  case SDFW_WATCH_WRITE:
    if (c->duplex) {
      ScrError *err = rejected ? scr_error_from_dyn(outcome) : NULL;
      scr_stream_write_done(c->duplex, err ? scr_error_retain(err) : NULL); /* moves */
      if (err) scr_error_release(err);
    }
    break;
  case SDFW_WATCH_FINAL:
    if (c->duplex) {
      ScrError *err = rejected ? scr_error_from_dyn(outcome) : NULL;
      scr_stream_final_done(c->duplex, err ? scr_error_retain(err) : NULL); /* moves */
      if (err) scr_error_release(err);
    }
    break;
  default:
    sdfw_destroy_side_settled(c);
    break;
  }
}

static void sdfw_watch_react(void *opaque, ScrPromise *settled) {
  SdfwWatch *w = opaque;
  SdfwCtx *c = w->ctx;
  if (!c) return;
  sdfw_ref(c);
  SdfwWatchKind kind = w->kind;
  sdfw_watch_unlink(w);
  bool rejected = scr_promise_is_rejected(settled);
  ScrDyn *outcome = scr_promise_reason_dyn(settled); /* +1: reason or value */
  sdfw_watch_settled(c, kind, rejected, outcome);
  if (outcome) scr_dyn_release(outcome);
  sdfw_unref(c);
}

static void sdfw_watch_drop(void *opaque) {
  SdfwWatch *w = opaque;
  sdfw_watch_unlink(w);
  free(w);
}

static const ScrPromiseReaction sdfw_watch_reaction = {sdfw_watch_react, sdfw_watch_drop};

/* Parks a watch on `promise` (its reference moves in; the promise itself
 * belongs to the web side, which settles it). */
static void sdfw_watch(ScrDyn *promise /* moves */, SdfwCtx *c, SdfwWatchKind kind) {
  SdfwWatch *w = malloc(sizeof *w);
  if (!w) abort();
  w->ctx = sdfw_ref(c);
  w->kind = kind;
  w->prev = NULL;
  w->next = c->watches;
  if (c->watches) c->watches->prev = w;
  c->watches = w;
  scr_promise_react(promise->v.promise, &sdfw_watch_reaction, w);
  scr_dyn_release(promise);
}

/* Watch a side handle's `closed` promise, when it has one. */
static void sdfw_watch_closed(ScrDyn *handle, SdfwCtx *c, SdfwWatchKind kind) {
  ScrDyn *closed = scr_dyn_obj_read(handle, "closed", 6);
  if (!closed) return;
  if (closed->kind == SCR_DYN_PROMISE) sdfw_watch(closed, c, kind); /* the +1 moves */
  else scr_dyn_release(closed);
}

/* read(): readableStreamDefaultReaderRead(reader, readRequest) */
static void sdfw_read_inv(ScrClosure *cb, ScrStream *s, double size) {
  (void)s;
  (void)size;
  SdfwCtx *c = sdfw_of(cb);
  if (c->reader && !c->reader_closed && !c->pending) {
    ScrDyn *promise = scr_dyn_invoke(c->reader, "read", NULL, 0, "reader.read");
    if (promise && promise->kind == SCR_DYN_PROMISE) sdfw_watch(promise, c, SDFW_WATCH_READ);
    else if (promise) scr_dyn_release(promise);
    if (scr_exc_pending()) scr_exc_clear();
  }
  sdfw_unref(c);
}

/* One awaited side operation. */
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
  static const SdfwWatchKind kinds[] = {
      SDFW_WATCH_WRITE,
      SDFW_WATCH_FINAL,
      SDFW_WATCH_DESTROY_SIDE,
  };
  sdfw_watch(scr_dyn_retain(result), c, kinds[which < 0 || which > 2 ? 2 : which]);
}

/* _write: writer.write(chunk) */
static void sdfw_write_inv(ScrClosure *cb, ScrStream *s, ScrBytes *chunk) {
  SdfwCtx *c = sdfw_of(cb);
  /* A typed record arrives as the record with the write's descriptor; an
   * object-mode or decodeStrings: false side arrives as a dyn value. */
  const ScrStreamTypedDesc *typed = scr_stream_write_desc(s);
  ScrDyn *value = typed != NULL ? typed->box((void *)chunk)
                  : scr_stream_writes_values(s) ? scr_dyn_retain((ScrDyn *)chunk)
                                                : scr_dyn_new_bytes(chunk);
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


/* writer.closed: a close before end() is Node's premature close; a rejection
 * destroys the Duplex with its reason. */
static void sdfw_closed_settle(SdfwCtx *c, ScrDyn *reason) {
  ScrStream *d = c->duplex;
  c->writer_closed = true;
  if (!d) return;
  if (reason) {
    /* A rejected writer.closed has already failed the pair: both sides are
     * closed, so the destroy completes without aborting or cancelling (Node
     * records both flags before it destroys). */
    c->reader_closed = true;
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

/* The resolver the events unit installs for a signal's abort listener, so an
 * earlier listener's stopImmediatePropagation does not skip it (Node's
 * kResistStopPropagation). */
extern ScrDyn *scr_events_add_abort_listener(ScrDyn *signal, ScrDyn *listener)
    __attribute__((weak));

/* Destroy the duplex now with Node's AbortError whose cause is the signal's
 * reason. */
static void sdfw_destroy_aborted(ScrStream *d, ScrDyn *signal) {
  ScrDyn *reason = scr_dyn_obj_read(signal, "reason", 6);
  ScrError *aborted = scr_error_abort(reason); /* +1; reason borrowed */
  if (aborted) {
    ScrStream *destroyed = scr_stream_destroy(d, aborted);
    if (destroyed) scr_stream_release(destroyed);
    scr_error_release(aborted);
  }
  if (reason) scr_dyn_release(reason);
  if (scr_exc_pending()) scr_exc_clear();
}

/* The fallback when the events unit is not linked: the signal's own
 * addEventListener destroys the duplex when it fires. */
static ScrDyn *sdfw_on_abort(ScrClosure *cl, ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc;
  ScrStream *d = scr_box_get_ref(cl->caps[0]); /* +1 */
  ScrDyn *signal = scr_box_get_ref(cl->caps[1]); /* +1 */
  if (d && signal) sdfw_destroy_aborted(d, signal);
  if (signal) scr_dyn_release(signal);
  if (d) scr_stream_release(d);
  return scr_dyn_undefined();
}

/* The option's signal: the runtime's addAbortSignal when the events unit is
 * linked, the signal's own listener otherwise. */
static void sdfw_attach_signal(ScrStream *d, ScrDyn *signal) {
  if (scr_events_add_abort_listener != NULL) {
    ScrStream *attached =
        scr_stream_add_abort_signal(d, signal, true, scr_events_add_abort_listener);
    if (attached) scr_stream_release(attached);
    else if (scr_exc_pending()) scr_exc_clear();
    return;
  }
  ScrDyn *aborted = scr_dyn_obj_read(signal, "aborted", 7);
  bool is_aborted = scr_dyn_truthy(aborted);
  if (aborted) scr_dyn_release(aborted);
  if (is_aborted) {
    sdfw_destroy_aborted(d, signal);
    return;
  }
  ScrClosure *clo = scr_closure_new((void *)&sdfw_on_abort, 2);
  clo->caps[0] = scr_box_new_obj(&scr_stream_retain_v, &scr_stream_release_v, NULL);
  scr_box_set_ref(clo->caps[0], scr_stream_retain(d));
  clo->caps[1] = scr_box_new_obj(scr_dyn_retain_v, scr_dyn_release_v, NULL);
  scr_box_set_ref(clo->caps[1], scr_dyn_retain(signal));
  ScrDyn *listener = scr_dyn_new_func(clo, &sdfw_on_abort, 1, "(event)", "onAbort");
  ScrStr *abort_name = scr_str_new("abort", 5);
  ScrDyn *name = scr_dyn_new_str(abort_name);
  ScrDyn *args[2] = {name, listener};
  ScrDyn *result = scr_dyn_invoke(signal, "addEventListener", args, 2, "addEventListener");
  if (result) scr_dyn_release(result);
  scr_dyn_release(name);
  scr_str_release(abort_name);
  scr_dyn_release(listener);
  if (scr_exc_pending()) scr_exc_clear();
}

/* Duplex.fromWeb({ readable, writable }[, options]): the Duplex (+1), or NULL
 * with ERR_INVALID_ARG_TYPE pending for a pair whose members are not web
 * streams. flags: bit 1 allowHalfOpen, bit 2 objectMode, bit 4
 * decodeStrings: false; hwm < 0 takes the default; encoding is NULL when
 * absent; signal may be NULL. */
static ScrStream *sdfw_build(ScrDyn *pair, double flags, double hwm, ScrDyn *signal,
                             ScrStr *encoding) {
  /* Node's validateObject(pair, 'pair'), then validateReadableStream and
   * validateWritableStream over the pair's members. */
  if (!pair || !scr_dyn_is_object(pair)) {
    scr_dyn_arg_type_fail("pair", "of type object", pair ? pair : scr_dyn_undefined());
    return NULL;
  }
  if (signal && signal->kind != SCR_DYN_UNDEF && signal->kind != SCR_DYN_NULL) {
    ScrDyn *aborted = scr_dyn_obj_read(signal, "aborted", 7);
    if (aborted == NULL || aborted->kind == SCR_DYN_UNDEF) {
      if (aborted) scr_dyn_release(aborted);
      scr_dyn_arg_type_fail("signal", "an instance of AbortSignal", signal);
      return NULL;
    }
    scr_dyn_release(aborted);
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
      /* An object-mode Duplex takes the object-mode default for both sides
       * (16), which the constructor reads before the mode is switched on. */
      hwm < 0 && ((int)flags & 2) != 0 ? scr_stream_get_default_hwm(true) : hwm,
      hwm < 0 && ((int)flags & 2) != 0 ? scr_stream_get_default_hwm(true) : hwm,
      true, true, ((int)flags & 1) != 0, true, true,
      sdfw_closure((void *)&sdfw_read_inv, c),
      &sdfw_read_inv, sdfw_closure((void *)&sdfw_write_inv, c), &sdfw_write_inv,
      sdfw_closure((void *)&sdfw_final_inv, c), &sdfw_final_inv,
      sdfw_closure((void *)&sdfw_destroy_inv, c), &sdfw_destroy_inv);
  c->duplex = scr_stream_retain(d);
  if (((int)flags & 2) != 0) {
    scr_stream_set_object_mode(d, true, true);
    /* A pipeline's pair stage carries web chunks as they are: a null chunk
     * is a value, where a node stream's push(null)/write(null) are the end
     * and the null-values error. */
    scr_stream_set_web_chunks(d, true);
  }
  if (((int)flags & 4) != 0) scr_stream_set_decode_strings(d, false);
  if (encoding != NULL && encoding->len > 0) {
    ScrStream *decoded = scr_stream_set_encoding(d, encoding);
    if (decoded) scr_stream_release(decoded);
    ScrStream *named = scr_stream_set_encoding_name(d, encoding);
    if (named) scr_stream_release(named);
  }
  static SCR_TL bool registered = false;
  if (!registered) {
    registered = true;
    scr_atexit(sdfw_atexit);
  }
  c->live_next = sdfw_live;
  if (sdfw_live) sdfw_live->live_prev = c;
  sdfw_live = c;
  sdfw_watch_closed(writer, c, SDFW_WATCH_WRITER_CLOSED);
  sdfw_watch_closed(reader, c, SDFW_WATCH_READER_CLOSED);
  if (signal && signal->kind != SCR_DYN_UNDEF && signal->kind != SCR_DYN_NULL)
    sdfw_attach_signal(d, signal);
  sdfw_unref(c);
  return d;
}

ScrStream *scr_stream_duplex_from_web(ScrDyn *pair, double flags) {
  return sdfw_build(pair, flags, -1, NULL, NULL);
}

ScrStream *scr_stream_duplex_from_web_opts(ScrDyn *pair, double flags, double hwm,
                                           ScrDyn *signal, ScrStr *encoding) {
  return sdfw_build(pair, flags, hwm, signal, encoding);
}
