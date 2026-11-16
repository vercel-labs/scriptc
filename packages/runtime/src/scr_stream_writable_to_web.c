/* Writable.toWeb (Node's newWritableStreamFromStreamWritable in
 * lib/internal/webstreams/adapters.js): a web WritableStream over a native
 * Writable. The sink's write() completes when the native write's callback
 * fires (and rejects with the stream's error), close() ends the writable and
 * settles at its finish, and abort() destroys it with the reason. The sink is
 * a plain object of C-authored functions, so the web unit builds the
 * WritableStream through its own class constructor. */
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
   * writable's listener table) alive. */
  ScrClosure *finish_cl;
  ScrStr *finish_name;
  ScrClosure *error_cl;
  ScrStr *error_name;
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

/* Reject p with the stream's current error, or fulfil it. */
static void stw3_settle(Stw3Job *j) {
  ScrError *err = scr_stream_errored(j->ctx->writable); /* +1 or NULL */
  if (err) {
    scr_throw_obj(scr_error_retain(err), &scr_error_retain_v, &scr_error_release_v,
                  scr_error_trace_arg());
    scr_promise_reject_pending(j->p);
    scr_error_release(err);
  } else {
    scr_promise_fulfill_void(j->p);
  }
  if (scr_exc_pending()) scr_exc_clear();
}

/* The native write's completion callback (the zero-argument ABI). Node's
 * adapter resolves the writer's promise when the wrapped write completes; a
 * failed write reaches the web stream through the lifecycle 'error' listener
 * instead of rejecting this promise. */
static void stw3_write_done(ScrClosure *cl) {
  Stw3Job *j = stw3_job_of(cl);
  scr_promise_fulfill_void(j->p);
  if (scr_exc_pending()) scr_exc_clear();
  stw3_job_release(j);
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
  ScrDyn *chunk = argc > 0 ? args[0] : scr_dyn_undefined();
  ScrClosure *done = stw3_job_closure((void *)&stw3_write_done, j);
  scr_stream_write_dyn(c->writable, chunk, done); /* done moves */
  /* A chunk the writable refuses synchronously leaves its error pending:
   * the write's promise carries it, as the sink's throw would. */
  if (scr_exc_pending()) scr_promise_reject_pending(j->p);
  ScrDyn *out = scr_dyn_new_promise(j->p);
  stw3_job_release(j);
  stw3_unref(c);
  return out;
}

/* The close settles at the writable's 'finish' (or its 'error'), Node's
 * writable-side eos: a writable with autoDestroy: false never emits 'close',
 * so waiting for it would leave the writer's close pending forever. */
/* Remove the listener of the pair that did not fire. */
static void stw3_close_unregister(Stw3Job *j, bool finishing) {
  ScrClosure *drop = finishing ? j->error_cl : j->finish_cl;
  ScrStr *drop_name = finishing ? j->error_name : j->finish_name;
  if (drop) scr_emitter_unadd_quiet((ScrEmitter *)j->ctx->writable, drop_name, drop);
  if (j->finish_name) scr_str_release(j->finish_name);
  if (j->error_name) scr_str_release(j->error_name);
  j->finish_cl = NULL;
  j->finish_name = NULL;
  j->error_cl = NULL;
  j->error_name = NULL;
}

static void stw3_close_finish(ScrClosure *cl) {
  Stw3Job *j = stw3_job_of(cl);
  stw3_close_unregister(j, true);
  scr_promise_fulfill_void(j->p);
  if (scr_exc_pending()) scr_exc_clear();
  stw3_job_release(j);
}

static void stw3_close_error(ScrClosure *cl, ScrError *err) {
  Stw3Job *j = stw3_job_of(cl);
  stw3_close_unregister(j, false);
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

/* sink.close() */
static ScrDyn *stw3_close(ScrClosure *cl, ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc;
  Stw3Ctx *c = scr_box_get_ref(cl->caps[0]);
  Stw3Job *j = stw3_job_new(c);
  ScrClosure *finish_cl = stw3_job_closure((void *)&stw3_close_finish, j);
  ScrStr *finish_name = scr_str_new("finish", 6);
  scr_emitter_release(scr_emitter_on((ScrEmitter *)c->writable, finish_name, finish_cl,
                                     scr_ee_inv_fixed0, true, false));
  ScrClosure *error_cl = stw3_job_closure((void *)&stw3_close_error, j);
  ScrStr *error_name = scr_str_new("error", 5);
  scr_emitter_release(scr_emitter_on((ScrEmitter *)c->writable, error_name, error_cl,
                                     scr_ee_inv_fixed1, true, false));
  j->finish_cl = finish_cl;
  j->finish_name = finish_name;
  j->error_cl = error_cl;
  j->error_name = error_name;
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
