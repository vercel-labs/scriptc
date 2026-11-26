/* Writable.toWeb (Node's newWritableStreamFromStreamWritable in
 * lib/internal/webstreams/adapters.js): a web WritableStream over a native
 * Writable. The sink's write() answers at once when the native write accepts
 * the chunk, and otherwise answers a promise that settles at the stream's
 * 'drain' or its end-of-stream error. One end-of-stream watcher owns the
 * adapter's fate: an error rejects the pending write and close and errors
 * the web stream with it, a clean end settles a pending close, and a clean
 * end without one errors the web stream with an AbortError (Node's shape).
 * A writable that is already destroyed or not writable adapts to a closed
 * WritableStream. */
#include "scr_runtime.h"
#include "scr_stream.h"

typedef struct Stw3Ctx Stw3Ctx;
struct Stw3Ctx {
  size_t rc;
  ScrStream *writable;      /* +1 */
  ScrDyn *controller;       /* +1 once the sink's start() ran */
  ScrPromise *backpressure; /* +1 while a backpressured write waits */
  ScrPromise *closed;       /* +1 while the writer's close waits */
  /* +1: the reason the adapter retired with, so a write or close that races
   * the retire answers Node's error instead of resolving. */
  ScrError *error;
  ScrClosure *eos;          /* +1: the finished() registration */
  /* +1: the close-step watcher that lets go when a stream closes without
   * emitting 'close' (a clean destroy of an emitClose:false stream, which
   * the eos watcher above never sees). */
  ScrClosure *close_step;
  ScrClosure *error_cl;     /* the writable's 'error' listener */
  ScrStr *error_name;       /* +1 */
  Stw3Ctx *live_prev, *live_next;
  /* The 'drain' listener of the pending backpressured write (the writable
   * owns the closure; the name is ours). */
  ScrClosure *drain_cl;
  ScrStr *drain_name;       /* +1 */
};

static Stw3Ctx *stw3_ref(Stw3Ctx *c) {
  c->rc++;
  return c;
}

static void stw3_unref(Stw3Ctx *c);

static SCR_TL Stw3Ctx *stw3_live = NULL;

/* Drop the adapter's hold on its stream: unhook the watchers and the error
 * listener and release the writable. The web stream's sink keeps the context
 * alive until the web stream itself goes. */
static void stw3_retire(Stw3Ctx *c) {
  if (c->live_prev) c->live_prev->live_next = c->live_next;
  else if (stw3_live == c) stw3_live = c->live_next;
  else return; /* already retired */
  if (c->live_next) c->live_next->live_prev = c->live_prev;
  c->live_prev = c->live_next = NULL;
  if (c->error_cl) {
    scr_emitter_unadd_quiet((ScrEmitter *)c->writable, c->error_name, c->error_cl);
    c->error_cl = NULL;
  }
  if (c->error_name) {
    scr_str_release(c->error_name);
    c->error_name = NULL;
  }
  ScrClosure *eos = c->eos;
  c->eos = NULL;
  if (eos) {
    ((void (*)(ScrClosure *))eos->fn)(eos);
    scr_closure_release(eos);
  }
  ScrClosure *close_step = c->close_step;
  c->close_step = NULL;
  if (close_step) {
    ((void (*)(ScrClosure *))close_step->fn)(close_step);
    scr_closure_release(close_step);
  }
  ScrStream *w = c->writable;
  c->writable = NULL;
  if (w) scr_stream_release(w);
  /* The sink's boxes hide the context from the collector, so the adapter's
   * own reference to the controller would otherwise keep the stream's
   * controller (and through it the web stream and the sink) alive after a
   * dropped adapter. The stream keeps the controller itself. */
  ScrDyn *controller = c->controller;
  c->controller = NULL;
  if (controller) scr_dyn_release(controller);
  stw3_unref(c); /* the live list's reference */
}

static void stw3_atexit(void) {
  while (stw3_live) stw3_retire(stw3_live);
}

static void stw3_unref(Stw3Ctx *c) {
  if (--c->rc > 0) return;
  if (c->drain_cl && c->writable)
    scr_emitter_unadd_quiet((ScrEmitter *)c->writable, c->drain_name, c->drain_cl);
  if (c->drain_name) scr_str_release(c->drain_name);
  if (c->eos) scr_closure_release(c->eos);
  if (c->close_step) scr_closure_release(c->close_step);
  if (c->error_cl && c->writable)
    scr_emitter_unadd_quiet((ScrEmitter *)c->writable, c->error_name, c->error_cl);
  if (c->error_name) scr_str_release(c->error_name);
  if (c->writable) scr_stream_release(c->writable);
  if (c->controller) scr_dyn_release(c->controller);
  if (c->backpressure) scr_promise_release(c->backpressure);
  if (c->closed) scr_promise_release(c->closed);
  if (c->error) scr_error_release(c->error);
  free(c);
}

static void stw3_unref(Stw3Ctx *c);
static void *stw3_ref_v(void *p) { return stw3_ref(p); }
static void stw3_unref_v(void *p) { stw3_unref(p); }

static ScrClosure *stw3_closure(void *fn, Stw3Ctx *c) {
  ScrClosure *cl = scr_closure_new(fn, 1);
  cl->caps[0] = scr_box_new_obj(&stw3_ref_v, &stw3_unref_v, NULL);
  scr_box_set_ref(cl->caps[0], stw3_ref(c));
  return cl;
}

static Stw3Ctx *stw3_of(ScrClosure *cl) { return scr_box_get_ref(cl->caps[0]); /* +1 */ }

/* Reject p with err (borrowed): the shared shape the runtime's promise
 * rejections use, which starts from a pending exception. */
static void stw3_reject(ScrPromise *p, ScrError *err) {
  scr_throw_obj(scr_error_retain(err), &scr_error_retain_v, &scr_error_release_v,
                scr_error_trace_arg());
  scr_promise_reject_pending(p);
  if (scr_exc_pending()) scr_exc_clear();
}

/* Node's handleKnownInternalErrors: a premature close becomes an AbortError. */
static bool stw3_is_premature_close(const ScrError *e) {
  static const char code[] = "ERR_STREAM_PREMATURE_CLOSE";
  return e->code && e->code->len == sizeof code - 1 &&
         memcmp(e->code->data, code, sizeof code - 1) == 0;
}

/* The writable's 'drain': the backpressured write can proceed. */
static void stw3_drain(ScrClosure *cl) {
  Stw3Ctx *c = stw3_of(cl);
  if (c->backpressure) {
    ScrPromise *p = c->backpressure;
    c->backpressure = NULL;
    scr_promise_fulfill_void(p);
    scr_promise_release(p);
  }
  c->drain_cl = NULL; /* the once listener is gone */
  if (c->drain_name) {
    scr_str_release(c->drain_name);
    c->drain_name = NULL;
  }
  stw3_unref(c);
}

/* controller.error(err): the web stream errors, which rejects its queued
 * and later writes with the same reason (Node's finished() handler). */
static void stw3_controller_error(Stw3Ctx *c, ScrError *err) {
  if (!c->controller) return;
  ScrDyn *arg = scr_dyn_from_error(err); /* +1 */
  scr_dyn_invoke(c->controller, "error", &arg, 1, "controller.error");
  scr_dyn_release(arg);
  if (scr_exc_pending()) scr_exc_clear();
  scr_dyn_release(c->controller);
  c->controller = NULL;
}

/* Fail what the adapter has pending with the writable's error: the undrained
 * write, the close, and the web stream itself (Node's eos error handler). */
static void stw3_fail(Stw3Ctx *c, ScrError *reason) {
  if (reason && !c->error) c->error = scr_error_retain(reason);
  if (c->backpressure) {
    ScrPromise *p = c->backpressure;
    c->backpressure = NULL;
    if (reason) {
      stw3_reject(p, reason);
    } else {
      scr_promise_fulfill_void(p);
    }
    scr_promise_release(p);
  }
  if (c->drain_cl && c->writable) {
    scr_emitter_unadd_quiet((ScrEmitter *)c->writable, c->drain_name, c->drain_cl);
    c->drain_cl = NULL;
  }
  if (c->drain_name) {
    scr_str_release(c->drain_name);
    c->drain_name = NULL;
  }
  if (c->closed) {
    ScrPromise *p = c->closed;
    c->closed = NULL;
    stw3_reject(p, reason);
    scr_promise_release(p);
  }
  stw3_controller_error(c, reason);
}

/* An error the adapted writable emits itself (a hand-written emitter, or a
 * destroy): consumed here, as Node's eos 'error' listener consumes it, and
 * the pending write and close reject with it. */
static void stw3_emitted_error(ScrClosure *cl, void *errp) {
  Stw3Ctx *c = stw3_of(cl);
  ScrError *err = errp;
  if (err) stw3_fail(c, err);
  stw3_unref(c);
}

/* The end-of-stream watcher: Node's finished(streamWritable, cb). A
 * premature close is Node's AbortError (handleKnownInternalErrors), and a
 * clean end without a close in flight errors the web stream with one. */
static void stw3_eos(ScrClosure *cl, ScrStream *s, ScrError *err) {
  Stw3Ctx *c = stw3_of(cl);
  if (!scr_stream_emits_close(s) && scr_stream_prop(s, "destroyed") != 0 &&
      scr_stream_prop(s, "writableFinished") == 0) {
    /* The stream closed without a 'close' event, so there is nothing to
     * report (Node's eos stays pending here); the adapter only lets go. */
    ScrClosure *eos = c->eos;
    c->eos = NULL;
    if (eos) {
      ((void (*)(ScrClosure *))eos->fn)(eos);
      scr_closure_release(eos);
    }
    stw3_retire(c);
    stw3_unref(c);
    return;
  }
  ScrError *own = err ? scr_error_retain(err) : NULL;
  ScrError *reason = own;
  if (own && stw3_is_premature_close(own)) reason = scr_error_abort(NULL);
  if (reason) {
    stw3_fail(c, reason);
  } else if (c->closed) {
    ScrPromise *p = c->closed;
    c->closed = NULL;
    scr_promise_fulfill_void(p);
    scr_promise_release(p);
  } else {
    /* Node's clean-end branch without a close: the web stream errors with an
     * AbortError, so a write still waiting on backpressure and any later write
     * reject with one. */
    ScrError *abort = scr_error_abort(NULL);
    if (abort) {
      if (c->backpressure) {
        ScrPromise *p = c->backpressure;
        c->backpressure = NULL;
        stw3_reject(p, abort);
        scr_promise_release(p);
      }
      stw3_controller_error(c, abort);
      scr_error_release(abort);
    }
  }
  if (reason && reason != own) scr_error_release(reason);
  if (own) scr_error_release(own);
  /* The adapter lets go of the writable and the watcher registrations; the
   * finished() cleanup releases its stream and callback references. */
  stw3_retire(c);
  stw3_unref(c);
}

/* The adapted stream closed without emitting 'close' (a clean destroy of an
 * emitClose:false stream): the eos watcher never sees it, so this watcher
 * lets the adapter go, as Node's adapter does. The writer's close stays
 * pending, Node's shape for a stream that never finished. */
static void stw3_close_step(ScrClosure *cl, ScrStream *s, ScrError *err) {
  (void)s;
  (void)err;
  Stw3Ctx *c = stw3_of(cl);
  if (c->eos != NULL) stw3_retire(c);
  stw3_unref(c);
}

/* sink.start(controller) */
static ScrDyn *stw3_start(ScrClosure *cl, ScrDyn *const *args, size_t argc) {
  Stw3Ctx *c = stw3_of(cl);
  if (argc > 0 && args[0]) {
    if (c->controller) scr_dyn_release(c->controller);
    c->controller = scr_dyn_retain(args[0]);
  }
  stw3_unref(c);
  return scr_dyn_retain(scr_dyn_undefined());
}

/* sink.write(chunk): Node's sink answers at once unless the native writable
 * was already backpressured or buffers the chunk (its write answers false),
 * in which case 'drain' or the end-of-stream error settles the promise. */
static ScrDyn *stw3_write(ScrClosure *cl, ScrDyn *const *args, size_t argc) {
  Stw3Ctx *c = stw3_of(cl);
  ScrDyn *chunk = argc > 0 ? args[0] : scr_dyn_undefined();
  if (!c->writable) {
    /* Retired (the wrapped stream is gone): an error that retired it is the
     * write's error, as the sink's failure would have answered; a clean
     * retire releases the call. */
    ScrPromise *done = scr_promise_new();
    if (c->error) stw3_reject(done, c->error);
    else scr_promise_fulfill_void(done);
    ScrDyn *out = scr_dyn_new_promise(done);
    scr_promise_release(done);
    stw3_unref(c);
    return out;
  }
  /* A write that reaches a writable which already failed rejects with its
   * error, as Node's sink does; the branches below only resolve a write whose
   * own failure emptied the queue. The writable keeps its own lifecycle: one
   * that auto-destroys has already done so, and one with autoDestroy: false
   * stays open, as Node leaves it. */
  ScrError *failed = scr_stream_errored(c->writable);
  if (failed != NULL) {
    ScrPromise *rejected = scr_promise_new();
    stw3_reject(rejected, failed);
    scr_error_release(failed);
    ScrDyn *out = scr_dyn_new_promise(rejected);
    scr_promise_release(rejected);
    stw3_unref(c);
    return out;
  }
  bool needed = scr_stream_prop(c->writable, "writableNeedDrain") != 0;
  bool accepted = scr_stream_write_dyn(c->writable, chunk, NULL);
  ScrPromise *p = scr_promise_new();
  if (scr_exc_pending()) {
    /* The native write refused the chunk outright (write after end, an
     * encoding it does not know): the sink's throw rejects this write. */
    scr_promise_reject_pending(p);
    if (scr_exc_pending()) scr_exc_clear();
  } else if (!needed && accepted) {
    scr_promise_fulfill_void(p);
  } else if (scr_stream_prop(c->writable, "writableNeedDrain") == 0) {
    /* The write answered false but the stream needs no drain (a synchronous
     * failure clears its queue): Node resolves this write at once. */
    scr_promise_fulfill_void(p);
  } else {
    if (c->drain_cl) {
      /* A write cannot overtake a waiting one, but a stale wait is settled
       * and unhooked rather than left to resolve twice. */
      scr_emitter_unadd_quiet((ScrEmitter *)c->writable, c->drain_name, c->drain_cl);
      c->drain_cl = NULL;
    }
    if (c->drain_name) {
      scr_str_release(c->drain_name);
      c->drain_name = NULL;
    }
    if (c->backpressure) {
      ScrPromise *old = c->backpressure;
      c->backpressure = NULL;
      scr_promise_fulfill_void(old);
      scr_promise_release(old);
    }
    c->backpressure = scr_promise_retain(p);
    ScrClosure *drain_cl = stw3_closure((void *)&stw3_drain, c);
    ScrStr *drain_name = scr_str_new("drain", 5);
    scr_emitter_release(scr_emitter_on((ScrEmitter *)c->writable, drain_name, drain_cl,
                                       scr_ee_inv_fixed0, true, false));
    if (c->drain_name) scr_str_release(c->drain_name);
    c->drain_name = drain_name;
    c->drain_cl = drain_cl;
  }
  ScrDyn *out = scr_dyn_new_promise(p);
  scr_promise_release(p);
  stw3_unref(c);
  return out;
}

/* sink.close(): end the native writable and settle at its end-of-stream
 * (Node answers an already-ended or already-closing stream at once). */
static ScrDyn *stw3_close(ScrClosure *cl, ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc;
  Stw3Ctx *c = stw3_of(cl);
  ScrPromise *p = scr_promise_new();
  if (!c->writable) {
    /* Retired after a destroy that never reported its end: Node leaves a
     * close on such a stream pending. An error that retired it is the
     * close's error. */
    if (c->error) stw3_reject(p, c->error);
  } else if (c->closed || scr_stream_prop(c->writable, "writableEnded") != 0) {
    scr_promise_fulfill_void(p);
  } else {
    c->closed = scr_promise_retain(p);
    scr_stream_release(scr_stream_end(c->writable, NULL, NULL, NULL));
  }
  ScrDyn *out = scr_dyn_new_promise(p);
  scr_promise_release(p);
  stw3_unref(c);
  return out;
}

/* sink.abort(reason): destroy the native writable with it. */
static ScrDyn *stw3_abort(ScrClosure *cl, ScrDyn *const *args, size_t argc) {
  Stw3Ctx *c = stw3_of(cl);
  ScrDyn *reason = argc > 0 ? args[0] : NULL;
  /* Node's writer.abort() with no reason does not leave the stream
   * unerrored: the writable is destroyed with an AbortError. */
  ScrError *err =
      reason && reason->kind != SCR_DYN_UNDEF && reason->kind != SCR_DYN_NULL
          ? scr_error_from_dyn(reason)
          : scr_error_abort(NULL);
  if (c->writable && !scr_stream_prop(c->writable, "destroyed")) {
    scr_stream_release(scr_stream_destroy(c->writable, err));
  }
  /* The destruction errors the writable (an AbortError when the abort had no
   * reason), which the adapter's own error listener consumes and its eos
   * watcher reports: the adapter retires from there, so a destroyed stream
   * that never emits 'close' does not keep it alive until exit. */
  if (err) scr_error_release(err);
  if (scr_exc_pending()) scr_exc_clear();
  ScrPromise *p = scr_promise_new();
  scr_promise_fulfill_void(p);
  ScrDyn *out = scr_dyn_new_promise(p);
  scr_promise_release(p);
  stw3_unref(c);
  return out;
}

/* The sink member functions, each closing over the context. */
static ScrDyn *stw3_member(void *fn, ScrDynThunk thunk, uint32_t arity, const char *sig,
                           const char *name, Stw3Ctx *c) {
  ScrClosure *cl = stw3_closure(fn, c);
  return scr_dyn_new_func(cl, thunk, arity, sig, name);
}

/* A string's UTF-16 length, Node's `chunk.length`: code points in the
 * three-byte and shorter forms count once, a four-byte code point counts
 * as the surrogate pair it becomes. */
static double stw3_utf16_len(const ScrStr *s) {
  size_t units = 0;
  const unsigned char *p = (const unsigned char *)s->data;
  const unsigned char *end = p + s->len;
  while (p < end) {
    unsigned char b = *p;
    if (b < 0x80) {
      units += 1;
      p += 1;
    } else if ((b & 0xE0) == 0xC0 && p + 1 < end) {
      units += 1;
      p += 2;
    } else if ((b & 0xF0) == 0xE0 && p + 2 < end) {
      units += 1;
      p += 3;
    } else if ((b & 0xF8) == 0xF0 && p + 3 < end) {
      units += 2;
      p += 4;
    } else {
      units += 1;
      p += 1;
    }
  }
  return (double)units;
}

/* Node's strategy size function: a byte chunk's byteLength, otherwise the
 * value's length, and 1 in object mode (CountQueuingStrategy). */
static ScrDyn *stw3_size(ScrClosure *cl, ScrDyn *const *args, size_t argc) {
  Stw3Ctx *c = stw3_of(cl);
  double size = 1;
  if (c->writable && scr_stream_prop(c->writable, "writableObjectMode") == 0 && argc > 0 &&
      args[0] != NULL) {
    const ScrDyn *chunk = args[0];
    if (chunk->kind == SCR_DYN_BYTES && chunk->v.bytes != NULL) {
      double length = 0;
      if (scr_bytes_view_byte_length(chunk->v.bytes, &length)) size = length;
    } else if (chunk->kind == SCR_DYN_STR && chunk->v.str != NULL) {
      size = stw3_utf16_len(chunk->v.str);
    } else if (chunk->kind == SCR_DYN_ARR) {
      size = scr_dyn_arr_len(chunk);
    }
  }
  stw3_unref(c);
  return scr_dyn_new_num(size);
}

/* The queuing strategy Node builds from the wrapped writable: its
 * highWaterMark and the size function above. */
static ScrDyn *stw3_strategy(Stw3Ctx *c) {
  ScrDyn *strategy = scr_dyn_new_obj();
  double high_water_mark = scr_stream_prop(c->writable, "writableHighWaterMark");
  scr_dyn_obj_set(strategy, "highWaterMark", 13, scr_dyn_new_num(high_water_mark));
  ScrClosure *size_cl = stw3_closure((void *)&stw3_size, c);
  scr_dyn_obj_set(strategy, "size", 4,
                  scr_dyn_new_func(size_cl, &stw3_size, 1, "(chunk)", "size"));
  return strategy;
}

/* A closed WritableStream: Node adapts a destroyed or non-writable stream to
 * one (`new WritableStream(); writable.close()`). */
static ScrDyn *stw3_closed_stream(void) {
  ScrDyn *cls = scr_webstream_class(5); /* WritableStream */
  ScrDyn *ctorArgs = scr_dyn_new_arr();
  ScrStr *what = scr_str_new("Writable.toWeb", 15);
  ScrDyn *stream = scr_dyn_construct(cls, ctorArgs, what);
  scr_str_release(what);
  scr_dyn_release(ctorArgs);
  scr_dyn_release(cls);
  if (stream) {
    ScrDyn *closed = scr_dyn_invoke(stream, "close", NULL, 0, "WritableStream.close");
    if (closed) scr_dyn_release(closed);
    if (scr_exc_pending()) scr_exc_clear();
  }
  return stream;
}

/* Writable.toWeb(writable): the web WritableStream (+1). */
ScrDyn *scr_stream_writable_to_web(ScrStream *w, double flags) {
  (void)flags;
  if (scr_stream_prop(w, "destroyed") != 0 || scr_stream_prop(w, "writable") == 0)
    return stw3_closed_stream();
  Stw3Ctx *c = calloc(1, sizeof *c);
  if (!c) abort();
  /* The web stream's sink holds the context; it keeps the writable alive
   * until the end-of-stream watcher settles. */
  /* One reference is the exit-time live list's, one is this constructor's;
   * each closure takes its own. */
  c->rc = 2;
  c->writable = scr_stream_retain(w);
  /* The writable's own error (a hand-written emitter, or a destroy) is
   * consumed here and fails the pending write and close. */
  ScrClosure *error_cl = stw3_closure((void *)&stw3_emitted_error, c);
  ScrStr *error_name = scr_str_new("error", 5);
  scr_emitter_release(
      scr_emitter_on((ScrEmitter *)w, error_name, error_cl, scr_ee_inv_fixed1, false, false));
  c->error_cl = error_cl;
  c->error_name = error_name;
  ScrDyn *sink = scr_dyn_new_obj();
  scr_dyn_obj_set(sink, "start", 5, stw3_member((void *)&stw3_start, &stw3_start, 1, "(controller)", "start", c));
  scr_dyn_obj_set(sink, "write", 5, stw3_member((void *)&stw3_write, &stw3_write, 1, "(chunk)", "write", c));
  scr_dyn_obj_set(sink, "close", 5, stw3_member((void *)&stw3_close, &stw3_close, 0, "()", "close", c));
  scr_dyn_obj_set(sink, "abort", 5, stw3_member((void *)&stw3_abort, &stw3_abort, 1, "(reason)", "abort", c));
  ScrDyn *cls = scr_webstream_class(5); /* WritableStream */
  ScrDyn *ctorArgs = scr_dyn_new_arr();
  scr_dyn_arr_push(ctorArgs, scr_dyn_retain(sink));
  scr_dyn_arr_push(ctorArgs, stw3_strategy(c));
  ScrStr *what = scr_str_new("Writable.toWeb", 15);
  ScrDyn *out = scr_dyn_construct(cls, ctorArgs, what);
  scr_str_release(what);
  scr_dyn_release(ctorArgs);
  scr_dyn_release(sink);
  scr_dyn_release(cls);
  if (out) {
    static SCR_TL bool registered = false;
    if (!registered) {
      registered = true;
      scr_atexit(stw3_atexit);
    }
    c->live_next = stw3_live;
    if (stw3_live) stw3_live->live_prev = c;
    stw3_live = c;
    /* One end-of-stream watcher for the adapted stream (after the sink's
     * start, so a synchronously finished stream still sees the controller).
     * Node's adapter calls finished(streamWritable, { readable: false }):
     * a Duplex's readable side can outlive the writable one (it ends only
     * through a read), and the writer's close settles on the writable. */
    c->eos = scr_stream_finished_opts(c->writable, stw3_closure((void *)&stw3_eos, c), &stw3_eos,
                                      0, -1, true, NULL, NULL);
    /* A silent close step is the one terminal point the eos watcher cannot
     * report; this watcher only retires the adapter there (and is unhooked
     * by stw3_retire when eos settles first). */
    c->close_step = scr_stream_finished_always(
        c->writable, stw3_closure((void *)&stw3_close_step, c), &stw3_close_step);
  }
  stw3_unref(c); /* the constructor's reference */
  return out;
}

/* ── Writable.toWeb over a checked-dynamic writable ─────────────────────
 * Node accepts any object that reports write() and on(): a userland
 * stream, an http.OutgoingMessage, a plain emitter with the writable flags.
 * This adapter drives such a value through dyn calls. Its listeners capture
 * the adapter context, so a live list removes them at exit (and when the
 * stream ends) before the audit, the way the native adapter retires its
 * watchers. */
typedef struct Stw3Dyn Stw3Dyn;

enum { STW3D_ERROR, STW3D_FINISH, STW3D_CLOSE, STW3D_DRAIN, STW3D_WATCHERS };

struct Stw3Dyn {
  size_t rc;
  ScrDyn *target;           /* +1 */
  ScrDyn *controller;       /* +1 */
  ScrPromise *backpressure; /* +1 while a write waits */
  ScrPromise *closed;       /* +1 while the writer's close waits */
  ScrDyn *listeners[STW3D_WATCHERS]; /* +1 each; NULL once removed */
  bool object_mode;
  bool retired;
  Stw3Dyn *live_prev, *live_next;
};

static SCR_TL Stw3Dyn *stw3d_live = NULL;

static Stw3Dyn *stw3d_ref(Stw3Dyn *c) {
  c->rc++;
  return c;
}

static void stw3d_unref(Stw3Dyn *c) {
  if (--c->rc > 0) return;
  for (int i = 0; i < STW3D_WATCHERS; i++)
    if (c->listeners[i]) scr_dyn_release(c->listeners[i]);
  if (c->target) scr_dyn_release(c->target);
  if (c->controller) scr_dyn_release(c->controller);
  if (c->backpressure) scr_promise_release(c->backpressure);
  if (c->closed) scr_promise_release(c->closed);
  free(c);
}

static void *stw3d_ref_v(void *p) { return stw3d_ref(p); }
static void stw3d_unref_v(void *p) { stw3d_unref(p); }

static Stw3Dyn *stw3d_of(ScrClosure *cl) { return scr_box_get_ref(cl->caps[0]); /* +1 */ }

static ScrClosure *stw3d_closure(void *fn, Stw3Dyn *c) {
  ScrClosure *cl = scr_closure_new(fn, 1);
  cl->caps[0] = scr_box_new_obj(&stw3d_ref_v, &stw3d_unref_v, NULL);
  scr_box_set_ref(cl->caps[0], stw3d_ref(c));
  return cl;
}

static bool stw3d_truthy(const ScrDyn *d) {
  if (!d) return false;
  switch (d->kind) {
  case SCR_DYN_UNDEF:
  case SCR_DYN_NULL:
    return false;
  case SCR_DYN_BOOL:
    return d->v.b;
  case SCR_DYN_NUM:
    return d->v.num != 0;
  case SCR_DYN_STR:
    return d->v.str != NULL && d->v.str->len != 0;
  default:
    return true;
  }
}

/* A member of the adapted value (+1), or NULL when absent. A compiled class
 * instance answers through its materialized view, as every checked member
 * read does. */
static ScrDyn *stw3d_member(const ScrDyn *target, const char *name, size_t length) {
  if (!target) return NULL;
  /* A member a getter answers can emit 'close', which retires the adapter
   * and drops its reference to an otherwise-unreferenced target: hold one
   * across the whole lookup so the read finishes on a live object. */
  ScrDyn *held = scr_dyn_retain((ScrDyn *)target);
  const ScrDyn *receiver = target;
  ScrDyn *view = NULL;
  if (target && target->kind == SCR_DYN_TYPED_REF) {
    view = scr_dyn_typed_ref_materialize(target);
    if (view) receiver = view;
  }
  ScrDyn *value = scr_dyn_obj_read(receiver, name, length);
  if (view) scr_dyn_release(view);
  scr_dyn_release(held);
  if (scr_exc_pending()) scr_exc_clear();
  return value;
}

/* target.name(args...), +1 or NULL with the exception pending. */
static ScrDyn *stw3d_call(ScrDyn *target, const char *method, ScrDyn *const *args, size_t argc) {
  if (!target) return NULL;
  /* The member lookup (and a getter) can retire the adapter and drop its
   * reference to an otherwise-unreferenced target: hold one across the
   * whole lookup and invoke, and release it after. */
  ScrDyn *held = scr_dyn_retain(target);
  ScrDyn *result = scr_dyn_invoke(held, method, args, argc, method);
  scr_dyn_release(held);
  return result;
}

static void stw3d_settle_reject(ScrPromise *p, ScrDyn *reason) {
  scr_dyn_throw(scr_dyn_retain(reason));
  scr_promise_reject_pending(p);
  if (scr_exc_pending()) scr_exc_clear();
}

static void stw3d_controller_error(Stw3Dyn *c, ScrDyn *reason) {
  if (!c->controller || !reason) return;
  ScrDyn *result = stw3d_call(c->controller, "error", &reason, 1);
  if (result) scr_dyn_release(result);
  if (scr_exc_pending()) scr_exc_clear();
}

static void stw3d_controller_abort(Stw3Dyn *c) {
  if (!c->controller) return;
  ScrError *aborted = scr_error_abort(NULL); /* +1 */
  if (!aborted) return;
  ScrDyn *reason = scr_dyn_from_error(aborted); /* +1 */
  stw3d_controller_error(c, reason);
  scr_dyn_release(reason);
  scr_error_release(aborted);
}

/* Fail what the adapter has pending with the writable's error. */
static void stw3d_fail(Stw3Dyn *c, ScrDyn *reason) {
  if (c->backpressure) {
    ScrPromise *p = c->backpressure;
    c->backpressure = NULL;
    stw3d_settle_reject(p, reason);
    scr_promise_release(p);
  }
  if (c->closed) {
    ScrPromise *p = c->closed;
    c->closed = NULL;
    stw3d_settle_reject(p, reason);
    scr_promise_release(p);
  }
  stw3d_controller_error(c, reason);
}

/* Error the web stream with `reason` and settle what waits on it: a
 * backpressured write and a pending close reject with the same reason. A
 * write waiting for a drain that can no longer come must not be stranded. */
static void stw3d_abort_pending(Stw3Dyn *c, ScrDyn *reason) {
  if (c->backpressure) {
    ScrPromise *p = c->backpressure;
    c->backpressure = NULL;
    stw3d_settle_reject(p, reason);
    scr_promise_release(p);
  }
  if (c->closed) {
    ScrPromise *p = c->closed;
    c->closed = NULL;
    stw3d_settle_reject(p, reason);
    scr_promise_release(p);
  }
  stw3d_controller_error(c, reason);
}

static const char *const stw3d_watch_names[STW3D_WATCHERS] = {"error", "finish", "close", "drain"};

static ScrDyn *stw3d_register(Stw3Dyn *c, int slot, void *fn);

/* Drop the adapter's hold on the value: remove its listeners, release the
 * controller and the value. The sink's closures keep the context alive
 * until the web stream itself goes. */
static void stw3d_retire(Stw3Dyn *c) {
  if (c->retired) return;
  c->retired = true;
  if (c->live_prev) c->live_prev->live_next = c->live_next;
  else if (stw3d_live == c) stw3d_live = c->live_next;
  if (c->live_next) c->live_next->live_prev = c->live_prev;
  c->live_prev = c->live_next = NULL;
  for (int i = 0; i < STW3D_WATCHERS; i++) {
    ScrDyn *cb = c->listeners[i];
    c->listeners[i] = NULL;
    if (!cb) continue;
    ScrStr *name = scr_str_new(stw3d_watch_names[i], strlen(stw3d_watch_names[i]));
    ScrDyn *name_dyn = scr_dyn_new_str(name);
    ScrDyn *args[2] = {name_dyn, cb};
    ScrDyn *result = stw3d_call(c->target, "removeListener", args, 2);
    if (scr_exc_pending()) scr_exc_clear();
    if (!result) {
      result = stw3d_call(c->target, "off", args, 2);
      if (scr_exc_pending()) scr_exc_clear();
    }
    if (result) scr_dyn_release(result);
    scr_dyn_release(name_dyn);
    scr_str_release(name);
    scr_dyn_release(cb);
  }
  if (c->controller) {
    scr_dyn_release(c->controller);
    c->controller = NULL;
  }
  if (c->backpressure) {
    scr_promise_release(c->backpressure);
    c->backpressure = NULL;
  }
  if (c->closed) {
    scr_promise_release(c->closed);
    c->closed = NULL;
  }
  ScrDyn *target = c->target;
  c->target = NULL;
  if (target) scr_dyn_release(target);
  stw3d_unref(c); /* the live list's reference */
}

static void stw3d_atexit(void) {
  while (stw3d_live) stw3d_retire(stw3d_live);
}

static void stw3d_live_add(Stw3Dyn *c) {
  static SCR_TL bool registered = false;
  if (!registered) {
    registered = true;
    scr_atexit(stw3d_atexit);
  }
  stw3d_ref(c); /* the list's own reference, released by stw3d_retire */
  c->live_next = stw3d_live;
  if (stw3d_live) stw3d_live->live_prev = c;
  stw3d_live = c;
}

static ScrDyn *stw3d_listener_dyn(Stw3Dyn *c, void *fn, const char *name) {
  ScrClosure *cl = stw3d_closure(fn, c);
  return scr_dyn_new_func(cl, (ScrDynThunk)fn, 1, "(event)", name);
}

/* value.on(name, fn): the listener's dyn value is kept for removeListener. */
static ScrDyn *stw3d_register(Stw3Dyn *c, int slot, void *fn) {
  const char *name = stw3d_watch_names[slot];
  ScrDyn *cb = stw3d_listener_dyn(c, fn, name);
  ScrStr *name_str = scr_str_new(name, strlen(name));
  ScrDyn *name_dyn = scr_dyn_new_str(name_str);
  ScrDyn *args[2] = {name_dyn, cb};
  ScrDyn *result = stw3d_call(c->target, "on", args, 2);
  if (scr_exc_pending()) scr_exc_clear();
  if (result) scr_dyn_release(result);
  scr_dyn_release(name_dyn);
  scr_str_release(name_str);
  if (c->listeners[slot]) scr_dyn_release(c->listeners[slot]);
  c->listeners[slot] = cb;
  return cb;
}

static ScrDyn *stw3d_emit_void(void) { return scr_dyn_undefined(); }

/* 'error': fail the pending write and close and error the web stream, as
 * Node's eos error handler does. */
static ScrDyn *stw3d_on_error(ScrClosure *cl, ScrDyn *const *args, size_t argc) {
  Stw3Dyn *c = stw3d_of(cl);
  ScrDyn *err = argc > 0 ? args[0] : NULL;
  if (err && err->kind != SCR_DYN_UNDEF && err->kind != SCR_DYN_NULL) {
    stw3d_fail(c, err);
    stw3d_retire(c);
  }
  stw3d_unref(c);
  return stw3d_emit_void();
}

/* 'finish': a pending close resolves; a clean end the writer did not ask
 * for errors the web stream with an AbortError. */
static ScrDyn *stw3d_on_finish(ScrClosure *cl, ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc;
  Stw3Dyn *c = stw3d_of(cl);
  if (c->closed) {
    ScrPromise *p = c->closed;
    c->closed = NULL;
    scr_promise_fulfill_void(p);
    scr_promise_release(p);
  } else {
    /* A clean end without the writer's close: the web stream errors with an
     * AbortError and a write waiting on drain rejects with it rather than
     * waiting for a drain the ended writable never emits. */
    ScrError *aborted = scr_error_abort(NULL); /* +1 */
    ScrDyn *reason = aborted ? scr_dyn_from_error(aborted) : NULL; /* +1 */
    if (reason) {
      stw3d_abort_pending(c, reason);
      scr_dyn_release(reason);
    }
    if (aborted) scr_error_release(aborted);
  }
  stw3d_retire(c);
  stw3d_unref(c);
  return stw3d_emit_void();
}

/* 'close' without a finish is Node's premature close (eos reports
 * ERR_STREAM_PREMATURE_CLOSE, which the adapter maps to an AbortError): the
 * pending close and write reject with it and the web stream errors. */
static ScrDyn *stw3d_on_close(ScrClosure *cl, ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc;
  Stw3Dyn *c = stw3d_of(cl);
  ScrError *aborted = scr_error_abort(NULL); /* +1 */
  ScrDyn *reason = aborted ? scr_dyn_from_error(aborted) : NULL; /* +1 */
  if (reason) {
    stw3d_abort_pending(c, reason);
    scr_dyn_release(reason);
  }
  if (aborted) scr_error_release(aborted);
  stw3d_retire(c);
  stw3d_unref(c);
  return stw3d_emit_void();
}

/* 'drain': the backpressured write can proceed. */
static ScrDyn *stw3d_on_drain(ScrClosure *cl, ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc;
  Stw3Dyn *c = stw3d_of(cl);
  if (c->backpressure) {
    ScrPromise *p = c->backpressure;
    c->backpressure = NULL;
    scr_promise_fulfill_void(p);
    scr_promise_release(p);
  }
  stw3d_unref(c);
  return stw3d_emit_void();
}

/* A string's UTF-16 length, Node's chunk.length. */
static double stw3d_utf16_len(const ScrStr *str) {
  size_t units = 0;
  const unsigned char *p = (const unsigned char *)str->data;
  const unsigned char *end = p + str->len;
  while (p < end) {
    unsigned char b = *p;
    if (b < 0x80) {
      units += 1;
      p += 1;
    } else if ((b & 0xE0) == 0xC0 && p + 1 < end) {
      units += 1;
      p += 2;
    } else if ((b & 0xF0) == 0xE0 && p + 2 < end) {
      units += 1;
      p += 3;
    } else if ((b & 0xF8) == 0xF0 && p + 3 < end) {
      units += 2;
      p += 4;
    } else {
      units += 1;
      p += 1;
    }
  }
  return (double)units;
}

/* The web stream's strategy size: 1 in object mode, else the chunk's
 * byteLength, UTF-16 length or length, as Node's size function reads it. */
static ScrDyn *stw3d_size(ScrClosure *cl, ScrDyn *const *args, size_t argc) {
  Stw3Dyn *c = stw3d_of(cl);
  double size = 1;
  if (!c->object_mode && argc > 0 && args[0] != NULL) {
    const ScrDyn *chunk = args[0];
    if (chunk->kind == SCR_DYN_BYTES && chunk->v.bytes != NULL) {
      double length = 0;
      if (scr_bytes_view_byte_length(chunk->v.bytes, &length)) size = length;
    } else if (chunk->kind == SCR_DYN_STR && chunk->v.str != NULL) {
      size = stw3d_utf16_len(chunk->v.str);
    } else if (chunk->kind == SCR_DYN_ARR) {
      size = scr_dyn_arr_len(chunk);
    }
  }
  stw3d_unref(c);
  return scr_dyn_new_num(size);
}

static ScrDyn *stw3d_strategy(Stw3Dyn *c) {
  ScrDyn *strategy = scr_dyn_new_obj();
  ScrDyn *hwm = stw3d_member(c->target, "writableHighWaterMark", 21);
  scr_dyn_obj_set(strategy, "highWaterMark", 13, hwm ? hwm : scr_dyn_undefined());
  ScrClosure *size_cl = stw3d_closure((void *)&stw3d_size, c);
  scr_dyn_obj_set(strategy, "size", 4,
                  scr_dyn_new_func(size_cl, &stw3d_size, 1, "(chunk)", "size"));
  return strategy;
}

/* sink.start(controller) */
static ScrDyn *stw3d_start(ScrClosure *cl, ScrDyn *const *args, size_t argc) {
  Stw3Dyn *c = stw3d_of(cl);
  if (argc > 0 && args[0]) {
    if (c->controller) scr_dyn_release(c->controller);
    c->controller = scr_dyn_retain(args[0]);
  }
  stw3d_unref(c);
  return scr_dyn_retain(scr_dyn_undefined());
}

static bool stw3d_is_undefined(const ScrDyn *d) {
  return d == NULL || d->kind == SCR_DYN_UNDEF;
}

/* sink.write(chunk): Node's adapter answers at once when the writable
 * accepts the chunk, and otherwise waits for 'drain' or the error. */
static ScrDyn *stw3d_write(ScrClosure *cl, ScrDyn *const *args, size_t argc) {
  Stw3Dyn *c = stw3d_of(cl);
  ScrDyn *chunk = argc > 0 ? args[0] : scr_dyn_undefined();
  ScrPromise *p = scr_promise_new();
  ScrDyn *need = stw3d_member(c->target, "writableNeedDrain", 17);
  bool needed = stw3d_truthy(need);
  if (need) scr_dyn_release(need);
  bool accepted = false;
  if (!needed && c->target) {
    ScrDyn *result = stw3d_call(c->target, "write", &chunk, 1);
    if (scr_exc_pending()) {
      scr_promise_reject_pending(p);
      if (scr_exc_pending()) scr_exc_clear();
      goto settled;
    }
    accepted = stw3d_truthy(result);
    if (result) scr_dyn_release(result);
  }
  if (c->retired || c->target == NULL) {
    /* The writable finished or failed inside write(): its error already
     * reached the controller and the target is gone. Settle this write
     * instead of reading writableNeedDrain through it. */
    scr_promise_fulfill_void(p);
    goto settled;
  }
  if (!needed && accepted) {
    scr_promise_fulfill_void(p);
  } else {
    ScrDyn *now = stw3d_member(c->target, "writableNeedDrain", 17);
    bool wait = needed || stw3d_truthy(now);
    if (now) scr_dyn_release(now);
    if (!wait) {
      scr_promise_fulfill_void(p);
    } else {
      if (c->backpressure) scr_promise_release(c->backpressure);
      c->backpressure = scr_promise_retain(p);
    }
  }
settled:;
  ScrDyn *out = scr_dyn_new_promise(p);
  scr_promise_release(p);
  stw3d_unref(c);
  return out;
}

/* sink.close() */
static ScrDyn *stw3d_close(ScrClosure *cl, ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc;
  Stw3Dyn *c = stw3d_of(cl);
  ScrPromise *p = scr_promise_new();
  ScrDyn *ended = stw3d_member(c->target, "writableEnded", 13);
  bool is_ended = stw3d_truthy(ended);
  if (ended) scr_dyn_release(ended);
  if (is_ended || c->closed != NULL) {
    scr_promise_fulfill_void(p);
  } else if (c->target == NULL) {
    /* Retired (the wrapped value is gone): Node leaves a close on such a
     * stream pending. */
  } else {
    /* The close is recorded before end(): a userland sink can emit 'finish'
     * synchronously inside end(), which settles and retires the adapter.
     * Recording it afterwards would strand this promise, and the error the
     * retirement reports, forever. */
    c->closed = scr_promise_retain(p);
    ScrDyn *result = stw3d_call(c->target, "end", NULL, 0);
    if (scr_exc_pending()) {
      if (c->closed) {
        scr_promise_release(c->closed);
        c->closed = NULL;
      }
      scr_promise_reject_pending(p);
      if (scr_exc_pending()) scr_exc_clear();
      if (result) scr_dyn_release(result);
      goto done;
    }
    if (result) scr_dyn_release(result);
  }
done:;
  ScrDyn *out = scr_dyn_new_promise(p);
  scr_promise_release(p);
  stw3d_unref(c);
  return out;
}

/* sink.abort(reason): destroy the value with the reason, or with Node's
 * AbortError when the writer passed none. A cancellation must not look like
 * a clean destroy. */
static ScrDyn *stw3d_abort(ScrClosure *cl, ScrDyn *const *args, size_t argc) {
  Stw3Dyn *c = stw3d_of(cl);
  ScrPromise *p = scr_promise_new();
  ScrDyn *given = argc > 0 ? args[0] : NULL;
  ScrDyn *reason = NULL;
  if (given && given->kind != SCR_DYN_UNDEF && given->kind != SCR_DYN_NULL) {
    reason = scr_dyn_retain(given);
  } else {
    ScrError *aborted = scr_error_abort(NULL); /* +1 */
    if (aborted) {
      reason = scr_dyn_from_error(aborted); /* +1 */
      scr_error_release(aborted);
    }
  }
  bool failed = false;
  if (c->target && reason) {
    ScrDyn *result = stw3d_call(c->target, "destroy", &reason, 1);
    if (scr_exc_pending()) {
      scr_promise_reject_pending(p);
      if (scr_exc_pending()) scr_exc_clear();
      failed = true;
    } else if (result) {
      scr_dyn_release(result);
    }
  }
  if (reason) scr_dyn_release(reason);
  if (!failed) scr_promise_fulfill_void(p);
  ScrDyn *out = scr_dyn_new_promise(p);
  scr_promise_release(p);
  stw3d_unref(c);
  return out;
}

/* A closed WritableStream over a value that reports it is not writable. */
static ScrDyn *stw3d_closed_stream(void) {
  ScrDyn *cls = scr_webstream_class(5); /* WritableStream */
  ScrDyn *ctorArgs = scr_dyn_new_arr();
  ScrStr *what = scr_str_new("Writable.toWeb", 15);
  ScrDyn *stream = scr_dyn_construct(cls, ctorArgs, what);
  scr_str_release(what);
  scr_dyn_release(ctorArgs);
  scr_dyn_release(cls);
  if (stream) {
    ScrDyn *closed = scr_dyn_invoke(stream, "close", NULL, 0, "WritableStream.close");
    if (closed) scr_dyn_release(closed);
    if (scr_exc_pending()) scr_exc_clear();
  }
  return stream;
}

/* Whether the value reports a callable member of this name. A compiled
 * class instance answers from its class's member table (its methods are not
 * own properties of a materialized view). */
static bool stw3d_has_method(const ScrDyn *value, const char *name, size_t length) {
  if (!value) return false;
  if (value->kind == SCR_DYN_TYPED_REF) {
    ScrStr *key = scr_str_new(name, length);
    bool has = scr_dyn_typed_ref_class_has(value, key);
    scr_str_release(key);
    return has;
  }
  ScrDyn *member = stw3d_member(value, name, length);
  bool callable = member && scr_dyn_is_callable(member);
  if (member) scr_dyn_release(member);
  return callable;
}

/* Writable.toWeb over a checked-dynamic value: any object with write() and
 * on() drives the adapter (Node's newWritableStreamFromStreamWritable). */
ScrDyn *scr_stream_writable_to_web_dyn(const ScrDyn *value, double flags) {
  (void)flags;
  bool valid = stw3d_has_method(value, "write", 5) && stw3d_has_method(value, "on", 2);
  if (!valid) {
    ScrDyn *missing = value ? NULL : scr_dyn_undefined();
    scr_dyn_arg_type_fail("streamWritable", "an stream.Writable", value ? value : missing);
    if (missing) scr_dyn_release(missing);
    return NULL;
  }
  ScrDyn *destroyed = stw3d_member(value, "destroyed", 9);
  ScrDyn *writable = stw3d_member(value, "writable", 8);
  bool gone = stw3d_truthy(destroyed) || !stw3d_truthy(writable);
  if (destroyed) scr_dyn_release(destroyed);
  if (writable) scr_dyn_release(writable);
  if (gone) return stw3d_closed_stream();

  Stw3Dyn *c = calloc(1, sizeof *c);
  if (!c) abort();
  c->rc = 1;
  c->target = scr_dyn_retain((ScrDyn *)value);
  ScrDyn *object_mode = stw3d_member(value, "writableObjectMode", 18);
  c->object_mode = stw3d_truthy(object_mode);
  if (object_mode) scr_dyn_release(object_mode);

  ScrDyn *sink = scr_dyn_new_obj();
  scr_dyn_obj_set(sink, "start", 5,
                  scr_dyn_new_func(stw3d_closure((void *)&stw3d_start, c), &stw3d_start, 1,
                                   "(controller)", "start"));
  scr_dyn_obj_set(sink, "write", 5,
                  scr_dyn_new_func(stw3d_closure((void *)&stw3d_write, c), &stw3d_write, 1,
                                   "(chunk)", "write"));
  scr_dyn_obj_set(sink, "close", 5,
                  scr_dyn_new_func(stw3d_closure((void *)&stw3d_close, c), &stw3d_close, 0,
                                   "()", "close"));
  scr_dyn_obj_set(sink, "abort", 5,
                  scr_dyn_new_func(stw3d_closure((void *)&stw3d_abort, c), &stw3d_abort, 1,
                                   "(reason)", "abort"));
  ScrDyn *cls = scr_webstream_class(5); /* WritableStream */
  ScrDyn *ctorArgs = scr_dyn_new_arr();
  scr_dyn_arr_push(ctorArgs, sink);
  scr_dyn_arr_push(ctorArgs, stw3d_strategy(c));
  ScrStr *what = scr_str_new("Writable.toWeb", 15);
  ScrDyn *out = scr_dyn_construct(cls, ctorArgs, what);
  scr_str_release(what);
  scr_dyn_release(ctorArgs);
  scr_dyn_release(cls);
  if (!out) {
    /* The stream refused the strategy (a negative or NaN highWaterMark, or
     * another invalid option): nothing has been linked or listened to yet,
     * so dropping this context frees it and the value it holds, and the
     * constructor's exception stays pending. */
    stw3d_unref(c);
    return NULL;
  }
  /* Linked and watched only once the stream exists, so a failed construction
   * never leaves a context rooted on the live list. */
  stw3d_live_add(c);
  stw3d_register(c, STW3D_ERROR, (void *)&stw3d_on_error);
  stw3d_register(c, STW3D_FINISH, (void *)&stw3d_on_finish);
  stw3d_register(c, STW3D_CLOSE, (void *)&stw3d_on_close);
  stw3d_register(c, STW3D_DRAIN, (void *)&stw3d_on_drain);
  stw3d_unref(c); /* the adapter's reference */
  return out;
}
