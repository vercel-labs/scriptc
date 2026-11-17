/* Writable.toWeb (Node's newWritableStreamFromStreamWritable in
 * lib/internal/webstreams/adapters.js): a web WritableStream over a native
 * Writable. The sink's write() fulfils as soon as the native write accepts
 * the chunk, waits for 'drain' when it is backpressured, and rejects with the
 * stream's error when the writable fails while that write is outstanding.
 * close() ends the writable and settles at its finish, and abort() destroys
 * it with the reason. The sink is a plain object of C-authored functions, so
 * the web unit builds the WritableStream through its own class constructor. */
#include "scr_runtime.h"
#include "scr_stream.h"

typedef struct Stw3Ctx Stw3Ctx;
struct Stw3Ctx {
  size_t rc;
  ScrStream *writable; /* +1 */
};

static Stw3Ctx *stw3_ref(Stw3Ctx *c) {
  c->rc++;
  return c;
}

static void stw3_unref(Stw3Ctx *c) {
  if (--c->rc > 0) return;
  if (c->writable) scr_stream_release(c->writable);
  free(c);
}

static void *stw3_ref_v(void *p) { return stw3_ref(p); }
static void stw3_unref_v(void *p) { stw3_unref(p); }

/* One sink operation's promise: the job holds the context and the promise
 * until the operation settles. */
typedef struct Stw3Job Stw3Job;
struct Stw3Job {
  size_t rc;
  Stw3Ctx *ctx;   /* +1 */
  ScrPromise *p;  /* +1 */
  /* close() registers a 'finish' and an 'error' listener; whichever fires
   * unregisters the other, so neither keeps the job (and through it the
   * writable's listener table) alive. A backpressured write registers 'drain'
   * and 'error' the same way. A job runs one of the two. */
  ScrClosure *finish_cl;
  ScrStr *finish_name;
  ScrClosure *error_cl;
  ScrStr *error_name;
  ScrClosure *close_cl;
  ScrStr *close_name;
  ScrClosure *drain_cl;
  ScrStr *drain_name;
};

static Stw3Job *stw3_job_new(Stw3Ctx *c) {
  Stw3Job *j = calloc(1, sizeof *j);
  if (!j) abort();
  j->rc = 1;
  j->ctx = stw3_ref(c);
  j->p = scr_promise_new();
  return j;
}

static void stw3_job_release(Stw3Job *j) {
  if (--j->rc > 0) return;
  stw3_unref(j->ctx);
  scr_promise_release(j->p);
  if (j->finish_name) scr_str_release(j->finish_name);
  if (j->error_name) scr_str_release(j->error_name);
  if (j->close_name) scr_str_release(j->close_name);
  if (j->drain_name) scr_str_release(j->drain_name);
  free(j);
}

static void *stw3_job_ref_v(void *p) { ((Stw3Job *)p)->rc++; return p; }
static void stw3_job_release_v(void *p) { stw3_job_release(p); }

static ScrClosure *stw3_job_closure(void *fn, Stw3Job *j) {
  ScrClosure *cl = scr_closure_new(fn, 1);
  cl->caps[0] = scr_box_new_obj(&stw3_job_ref_v, &stw3_job_release_v, NULL);
  scr_box_set_ref(cl->caps[0], stw3_job_ref_v(j));
  return cl;
}

static Stw3Job *stw3_job_of(ScrClosure *cl) { return scr_box_get_ref(cl->caps[0]); /* +1 */ }

/* Reject p with err (moves its +1), or with the writable's error when `err`
 * is NULL, or fulfil it when the writable has none. */
static void stw3_settle(Stw3Job *j, ScrError *err) {
  ScrError *reason = err ? err : scr_stream_errored(j->ctx->writable); /* +1 */
  if (reason) {
    scr_throw_obj(scr_error_retain(reason), &scr_error_retain_v, &scr_error_release_v,
                  scr_error_trace_arg());
    scr_promise_reject_pending(j->p);
    scr_error_release(reason);
  } else {
    scr_promise_fulfill_void(j->p);
  }
  if (scr_exc_pending()) scr_exc_clear();
}

/* The native write's completion callback (the zero-argument ABI). The sink
 * has already settled (Node's adapter resolves an accepted write at once and
 * a backpressured one at 'drain' or its error); the callback only releases
 * the wait it held. */
static void stw3_write_done(ScrClosure *cl) {
  Stw3Job *j = stw3_job_of(cl);
  if (scr_exc_pending()) scr_exc_clear();
  stw3_job_release(j);
}

/* Remove the write wait's listeners that did not fire (1 drain, 2 error,
 * 3 close). */
static void stw3_write_unregister(Stw3Job *j, int fired) {
  ScrClosure *alls[3] = {j->drain_cl, j->error_cl, j->close_cl};
  ScrStr *names[3] = {j->drain_name, j->error_name, j->close_name};
  for (int i = 0; i < 3; i++) {
    if (i + 1 == fired || !alls[i]) continue;
    scr_emitter_unadd_quiet((ScrEmitter *)j->ctx->writable, names[i], alls[i]);
  }
  if (j->drain_name) scr_str_release(j->drain_name);
  if (j->error_name) scr_str_release(j->error_name);
  if (j->close_name) scr_str_release(j->close_name);
  j->drain_cl = NULL;
  j->drain_name = NULL;
  j->error_cl = NULL;
  j->error_name = NULL;
  j->close_cl = NULL;
  j->close_name = NULL;
}

/* 'drain': the backpressured write can proceed, as Node's onDrain resolves
 * its backpressure promise. */
static void stw3_write_drain(ScrClosure *cl) {
  Stw3Job *j = stw3_job_of(cl);
  stw3_write_unregister(j, 1);
  scr_promise_fulfill_void(j->p);
  if (scr_exc_pending()) scr_exc_clear();
  stw3_job_release(j);
}

/* 'error' while a write waits for 'drain': Node's eos cleanup rejects the
 * backpressure promise with the writable's error, so the writer's write()
 * rejects with the stream's error. */
static void stw3_write_error(ScrClosure *cl, ScrError *err) {
  Stw3Job *j = stw3_job_of(cl);
  stw3_write_unregister(j, 2);
  stw3_settle(j, err ? scr_error_retain(err) : NULL);
  stw3_job_release(j);
}

/* 'close' without an 'error' while a write waits for 'drain': Node's eos
 * cleanup errors the stream with an AbortError, which rejects the pending
 * write. */
static void stw3_write_closed(ScrClosure *cl) {
  Stw3Job *j = stw3_job_of(cl);
  stw3_write_unregister(j, 3);
  ScrError *errored = scr_stream_errored(j->ctx->writable); /* +1 or NULL */
  if (errored) {
    stw3_settle(j, errored);
  } else {
    ScrError *aborted = scr_error_abort(NULL); /* +1 */
    if (aborted) {
      scr_throw_obj(aborted, &scr_error_retain_v, &scr_error_release_v, scr_error_trace_arg());
      scr_promise_reject_pending(j->p);
      if (scr_exc_pending()) scr_exc_clear();
    } else {
      scr_promise_fulfill_void(j->p);
    }
  }
  stw3_job_release(j);
}

/* Wait for 'drain', the writable's error, or its close, the promise Node's
 * adapter returns for a write the native writable backpressured. */
static void stw3_write_wait(Stw3Job *j) {
  ScrClosure *drain_cl = stw3_job_closure((void *)&stw3_write_drain, j);
  ScrStr *drain_name = scr_str_new("drain", 5);
  scr_emitter_release(scr_emitter_on((ScrEmitter *)j->ctx->writable, drain_name, drain_cl,
                                     scr_ee_inv_fixed0, true, false));
  ScrClosure *error_cl = stw3_job_closure((void *)&stw3_write_error, j);
  ScrStr *error_name = scr_str_new("error", 5);
  scr_emitter_release(scr_emitter_on((ScrEmitter *)j->ctx->writable, error_name, error_cl,
                                     scr_ee_inv_fixed1, true, false));
  ScrClosure *close_cl = stw3_job_closure((void *)&stw3_write_closed, j);
  ScrStr *close_name = scr_str_new("close", 5);
  scr_emitter_release(scr_emitter_on((ScrEmitter *)j->ctx->writable, close_name, close_cl,
                                     scr_ee_inv_fixed0, true, false));
  j->drain_cl = drain_cl;
  j->drain_name = drain_name;
  j->error_cl = error_cl;
  j->error_name = error_name;
  j->close_cl = close_cl;
  j->close_name = close_name;
}

/* The wrapped writable's lifecycle 'error' (a failed write, an abort, a
 * destroy with an error) is consumed here, Node's eos watcher shape: it must
 * not escape as an unhandled 'error' event. The listener captures nothing —
 * a captured context would cycle through the writable's listener table. */
static void stw3_stream_error(ScrClosure *cl, ScrError *err) {
  (void)cl;
  (void)err;
}

/* sink.write(chunk) */
static ScrDyn *stw3_write(ScrClosure *cl, ScrDyn *const *args, size_t argc) {
  Stw3Ctx *c = scr_box_get_ref(cl->caps[0]);
  Stw3Job *j = stw3_job_new(c);
  /* Node's stream is already errored when the wrapped writable is: a later
   * write rejects with the stored error without reaching the writable. A
   * writable destroyed without one gave the stream an AbortError instead. */
  ScrError *terminal = scr_stream_errored(c->writable); /* +1 or NULL */
  if (terminal || scr_stream_prop(c->writable, "destroyed") != 0) {
    if (terminal) {
      stw3_settle(j, terminal);
    } else {
      ScrError *aborted = scr_error_abort(NULL); /* +1 */
      if (aborted) {
        stw3_settle(j, aborted);
      } else {
        scr_promise_fulfill_void(j->p);
      }
    }
    ScrDyn *settled = scr_dyn_new_promise(j->p);
    stw3_job_release(j);
    stw3_unref(c);
    return settled;
  }
  ScrDyn *chunk = argc > 0 ? args[0] : scr_dyn_undefined();
  ScrClosure *done = stw3_job_closure((void *)&stw3_write_done, j);
  bool accepted = scr_stream_write_dyn(c->writable, chunk, done); /* done moves */
  /* A chunk the writable refuses synchronously leaves its error pending:
   * the write's promise carries it, as the sink's throw would. */
  if (scr_exc_pending()) {
    scr_promise_reject_pending(j->p);
  } else if (!accepted) {
    /* Node's adapter: a write the native writable backpressured answers a
     * promise that settles at 'drain' or rejects with the stream's error —
     * unless the writable is already draining (the write returned false but
     * needs no drain), which resolves at once. */
    if (scr_stream_prop(c->writable, "writableNeedDrain") == 0) {
      scr_promise_fulfill_void(j->p);
    } else {
      ScrError *errored = scr_stream_errored(c->writable); /* +1 or NULL */
      if (errored) {
        stw3_settle(j, errored);
      } else {
        stw3_write_wait(j);
      }
    }
  } else {
    /* The writable accepted the chunk without backpressure: Node's sink
     * write has already resolved, whatever the write later does. */
    scr_promise_fulfill_void(j->p);
  }
  ScrDyn *out = scr_dyn_new_promise(j->p);
  stw3_job_release(j);
  stw3_unref(c);
  return out;
}

/* The close settles at the writable's 'finish' (or its 'error'), Node's
 * writable-side eos: a writable with autoDestroy: false never emits 'close',
 * so waiting for it would leave the writer's close pending forever. */
/* Remove the listeners that did not fire (which is 1 finish, 2 error,
 * 3 close). */
static void stw3_close_unregister(Stw3Job *j, int fired) {
  ScrClosure *alls[3] = {j->finish_cl, j->error_cl, j->close_cl};
  ScrStr *names[3] = {j->finish_name, j->error_name, j->close_name};
  for (int i = 0; i < 3; i++) {
    if (i + 1 == fired || !alls[i]) continue;
    scr_emitter_unadd_quiet((ScrEmitter *)j->ctx->writable, names[i], alls[i]);
  }
  if (j->finish_name) scr_str_release(j->finish_name);
  if (j->error_name) scr_str_release(j->error_name);
  if (j->close_name) scr_str_release(j->close_name);
  j->finish_cl = NULL;
  j->finish_name = NULL;
  j->error_cl = NULL;
  j->error_name = NULL;
  j->close_cl = NULL;
  j->close_name = NULL;
}

static void stw3_close_finish(ScrClosure *cl) {
  Stw3Job *j = stw3_job_of(cl);
  stw3_close_unregister(j, 1);
  scr_promise_fulfill_void(j->p);
  if (scr_exc_pending()) scr_exc_clear();
  stw3_job_release(j);
}

static void stw3_close_error(ScrClosure *cl, ScrError *err) {
  Stw3Job *j = stw3_job_of(cl);
  stw3_close_unregister(j, 2);
  if (err) {
    scr_throw_obj(scr_error_retain(err), &scr_error_retain_v, &scr_error_release_v,
                  scr_error_trace_arg());
    scr_promise_reject_pending(j->p);
  } else {
    scr_promise_fulfill_void(j->p);
  }
  if (scr_exc_pending()) scr_exc_clear();
  stw3_job_release(j);
}

/* The writable's 'close': destroyed without a terminal 'finish' (a destroy
 * during the close) settles the pending close. */
static void stw3_close_closed(ScrClosure *cl) {
  Stw3Job *j = stw3_job_of(cl);
  stw3_close_unregister(j, 3);
  ScrError *err = scr_stream_errored(j->ctx->writable);
  if (err) {
    scr_throw_obj(err, &scr_error_retain_v, &scr_error_release_v, scr_error_trace_arg());
    scr_promise_reject_pending(j->p);
  } else {
    scr_promise_fulfill_void(j->p);
  }
  if (scr_exc_pending()) scr_exc_clear();
  stw3_job_release(j);
}

/* Node's writer rejects a close on a stream that is already closed or
 * errored with its invalid-state TypeError. */
static void stw3_reject_invalid_state(Stw3Job *j, const char *text, size_t length) {
  ScrStr *message = scr_str_new(text, length);
  ScrError *err = scr_error_new(SCR_ERR_TYPE, message);
  scr_str_release(message);
  if (err) {
    scr_error_set_code(err, "ERR_INVALID_STATE");
    scr_throw_obj(err, &scr_error_retain_v, &scr_error_release_v, scr_error_trace_arg());
    scr_promise_reject_pending(j->p);
  } else {
    scr_promise_fulfill_void(j->p);
  }
  if (scr_exc_pending()) scr_exc_clear();
}

/* sink.close() */
static ScrDyn *stw3_close(ScrClosure *cl, ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc;
  Stw3Ctx *c = scr_box_get_ref(cl->caps[0]);
  Stw3Job *j = stw3_job_new(c);
  /* A writable that already finished (or was destroyed) has no terminal event
   * left to wait for: settle now, or the close would never complete. */
  if (scr_stream_prop(c->writable, "writableFinished") != 0) {
    static const char invalid_state[] = "Invalid state: Failure to close WritableStream";
    stw3_reject_invalid_state(j, invalid_state, sizeof invalid_state - 1);
    ScrDyn *settled = scr_dyn_new_promise(j->p);
    stw3_job_release(j);
    stw3_unref(c);
    return settled;
  }
  ScrError *terminal = scr_stream_errored(c->writable); /* +1 or NULL */
  if (terminal || scr_stream_prop(c->writable, "destroyed") != 0) {
    /* The web stream is already errored once the wrapped writable is (an
     * error, or the AbortError a destroy gives it): Node's writer rejects the
     * close before the sink runs. */
    if (terminal) scr_error_release(terminal);
    static const char invalid_state[] = "Invalid state: WritableStream is closed";
    stw3_reject_invalid_state(j, invalid_state, sizeof invalid_state - 1);
    ScrDyn *settled = scr_dyn_new_promise(j->p);
    stw3_job_release(j);
    stw3_unref(c);
    return settled;
  }
  ScrClosure *finish_cl = stw3_job_closure((void *)&stw3_close_finish, j);
  ScrStr *finish_name = scr_str_new("finish", 6);
  scr_emitter_release(scr_emitter_on((ScrEmitter *)c->writable, finish_name, finish_cl,
                                     scr_ee_inv_fixed0, true, false));
  ScrClosure *error_cl = stw3_job_closure((void *)&stw3_close_error, j);
  ScrStr *error_name = scr_str_new("error", 5);
  scr_emitter_release(scr_emitter_on((ScrEmitter *)c->writable, error_name, error_cl,
                                     scr_ee_inv_fixed1, true, false));
  ScrClosure *close_cl = stw3_job_closure((void *)&stw3_close_closed, j);
  ScrStr *close_name = scr_str_new("close", 5);
  scr_emitter_release(scr_emitter_on((ScrEmitter *)c->writable, close_name, close_cl,
                                     scr_ee_inv_fixed0, true, false));
  j->finish_cl = finish_cl;
  j->finish_name = finish_name;
  j->error_cl = error_cl;
  j->error_name = error_name;
  j->close_cl = close_cl;
  j->close_name = close_name;
  scr_stream_release(scr_stream_end(c->writable, NULL, NULL, NULL));
  ScrDyn *out = scr_dyn_new_promise(j->p);
  stw3_job_release(j);
  stw3_unref(c);
  return out;
}

/* sink.abort(reason) */
static ScrDyn *stw3_abort(ScrClosure *cl, ScrDyn *const *args, size_t argc) {
  Stw3Ctx *c = scr_box_get_ref(cl->caps[0]);
  ScrDyn *reason = argc > 0 ? args[0] : NULL;
  ScrError *err = NULL;
  if (reason && reason->kind != SCR_DYN_UNDEF && reason->kind != SCR_DYN_NULL) {
    err = scr_error_from_dyn(reason);
  }
  if (!scr_stream_prop(c->writable, "destroyed")) {
    scr_stream_release(scr_stream_destroy(c->writable, err));
  }
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
  ScrClosure *cl = scr_closure_new(fn, 1);
  cl->caps[0] = scr_box_new_obj(&stw3_ref_v, &stw3_unref_v, NULL);
  scr_box_set_ref(cl->caps[0], stw3_ref(c));
  ScrDyn *out = scr_dyn_new_func(cl, thunk, arity, sig, name);
  return out;
}

/* Writable.toWeb(writable): the web WritableStream (+1). */
ScrDyn *scr_stream_writable_to_web(ScrStream *w, double flags) {
  (void)flags;
  Stw3Ctx *c = calloc(1, sizeof *c);
  if (!c) abort();
  c->rc = 1;
  c->writable = scr_stream_retain(w);
  ScrDyn *sink = scr_dyn_new_obj();
  scr_dyn_obj_set(sink, "write", 5, stw3_member((void *)&stw3_write, &stw3_write, 1, "(chunk)", "write", c));
  scr_dyn_obj_set(sink, "close", 5, stw3_member((void *)&stw3_close, &stw3_close, 0, "()", "close", c));
  scr_dyn_obj_set(sink, "abort", 5, stw3_member((void *)&stw3_abort, &stw3_abort, 1, "(reason)", "abort", c));
  /* The lifecycle watcher: an error listener on the native writable, one per
   * adapted stream (a shared template would cross worker runtimes). */
  ScrClosure *error_listener = scr_closure_new((void *)&stw3_stream_error, 0);
  ScrStr *error_name = scr_str_new("error", 5);
  scr_emitter_release(
      scr_emitter_on((ScrEmitter *)w, error_name, error_listener, scr_ee_inv_fixed1, false, false));
  scr_str_release(error_name);
  ScrDyn *cls = scr_webstream_class(5); /* WritableStream */
  ScrDyn *ctorArgs = scr_dyn_new_arr();
  scr_dyn_arr_push(ctorArgs, scr_dyn_retain(sink));
  ScrStr *what = scr_str_new("Writable.toWeb", 15);
  ScrDyn *out = scr_dyn_construct(cls, ctorArgs, what);
  scr_str_release(what);
  scr_dyn_release(ctorArgs);
  scr_dyn_release(sink);
  scr_dyn_release(cls);
  stw3_unref(c);
  return out;
}
