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
    /* Retired (the wrapped stream is gone): the web stream is closed or
     * errored, so a write here only releases the call. */
    ScrPromise *done = scr_promise_new();
    scr_promise_fulfill_void(done);
    ScrDyn *out = scr_dyn_new_promise(done);
    scr_promise_release(done);
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
     * close on such a stream pending. */
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
