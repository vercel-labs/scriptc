/* events.once(emitter, name, { signal }) over typed listeners — Node 24's
 * lib/events.js `once` with an options object. Linked only by programs
 * that pass the options (the emitter and event-target units together).
 *
 * The signal is validated first: undefined is the plain form, a value that
 * is not an AbortSignal rejects with ERR_INVALID_ARG_TYPE, and an aborted
 * signal rejects with an AbortError whose cause is signal.reason, all
 * without registering a listener. Otherwise the event's one-shot listener,
 * the 'error' one (unless the event is 'error') and a once,
 * resist-stop-propagation 'abort' listener on the signal share the state
 * below. The event or the error removes the other emitter listener and the
 * abort listener, then settles; the abort removes both emitter listeners
 * and rejects with the AbortError.
 *
 * Ownership: the state owns the promise, the name and the signal. The
 * emitter is weak in the state; the abort listener holds it strongly (the
 * abort is the one settlement that does not come from the emitter itself,
 * like the closure Node's abortListener keeps). The three listener closures
 * reach the state through link objects; a link clears the state's pointer
 * to its closure when that closure is freed, so removals never compare a
 * stale identity. The cycle through the signal's listener ends when the
 * promise settles or the signal aborts (or at the exit teardown of the
 * signal's listeners). */
#include "scr_runtime.h"

#include <stdlib.h>

typedef struct ScrEosState {
  size_t rc;
  ScrPromise *promise;  /* owned */
  ScrEmitter *em;       /* weak: alive whenever a listener fires */
  ScrStr *name;         /* owned */
  ScrDyn *signal;       /* owned; undefined without an abort listener */
  ScrClosure *event_cb; /* weak, NULL once freed */
  ScrClosure *error_cb; /* weak, NULL once freed or for 'error' */
  ScrDyn *listener;     /* weak abort listener, NULL once freed */
  bool settled;
} ScrEosState;

enum { SCR_EOS_EVENT, SCR_EOS_ERROR, SCR_EOS_ABORT };

typedef struct ScrEosLink {
  size_t rc;
  ScrEosState *st; /* owned */
  int slot;
} ScrEosLink;

static void scr_eos_oom(void) { scr_trap("scriptc: out of memory in events.once\n"); }

static void scr_eos_state_release(ScrEosState *st) {
  if (--st->rc > 0) return;
  scr_promise_release(st->promise);
  scr_str_release(st->name);
  scr_dyn_release(st->signal);
  free(st);
}

static void *scr_eos_link_retain(void *p) {
  ((ScrEosLink *)p)->rc++;
  return p;
}

static void scr_eos_link_release(void *p) {
  ScrEosLink *link = p;
  if (--link->rc > 0) return;
  ScrEosState *st = link->st;
  if (link->slot == SCR_EOS_EVENT) st->event_cb = NULL;
  else if (link->slot == SCR_EOS_ERROR) st->error_cb = NULL;
  else st->listener = NULL;
  scr_eos_state_release(st);
  free(link);
}

static ScrBox *scr_eos_link_box(ScrEosState *st, int slot) {
  ScrEosLink *link = calloc(1, sizeof *link);
  if (!link) scr_eos_oom();
  link->rc = 1;
  link->st = st;
  link->slot = slot;
  st->rc++;
  ScrBox *box = scr_box_new_obj(&scr_eos_link_retain, &scr_eos_link_release, NULL);
  scr_box_set_ref(box, link);
  return box;
}

/* An emitter listener: caps[0] its boxer (the compiled adapter calls it),
 * caps[1] its link. */
static ScrClosure *scr_eos_closure(void *adapter, ScrClosure *boxer, ScrEosState *st, int slot) {
  ScrClosure *c = scr_closure_new(adapter, 2);
  ScrBox *bx = scr_box_new(SCR_BOX_FUNC);
  scr_box_set_ref(bx, scr_closure_retain(boxer));
  c->caps[0] = bx;
  c->caps[1] = scr_eos_link_box(st, slot);
  return c;
}

/* new AbortError(undefined, { cause: signal.reason }), thrown. */
static void scr_eos_throw_abort(ScrDyn *signal) {
  ScrStr *message = scr_str_new("The operation was aborted", 25);
  ScrError *e = scr_error_new(SCR_ERR_ERROR, message);
  scr_str_release(message);
  scr_str_release(e->name);
  e->name = scr_str_new("AbortError", 10);
  /* AbortError assigns code, then name: own enumerable properties */
  scr_error_set_code(e, "ABORT_ERR");
  e->name_present = true;
  e->name_enumerable = true;
  ScrStr *k = scr_str_new("reason", 6);
  ScrDyn *reason = scr_dyn_handle_key_get(signal, k);
  scr_str_release(k);
  scr_error_define_cause(e, reason ? reason : scr_dyn_undefined());
  if (reason) scr_dyn_release(reason);
  scr_throw_obj(e, &scr_error_retain_v, &scr_error_release_v, scr_error_trace_arg());
}

/* removeEventListener('abort', listener) on the signal, when the listener
 * is still registered. */
static void scr_eos_remove_abort(ScrEosState *st) {
  if (st->listener == NULL) return;
  bool aborted;
  ScrEventTargetCore *core = scr_et_signal_core_fn ? scr_et_signal_core_fn(st->signal, &aborted) : NULL;
  if (!core) return;
  ScrStr *abort = scr_str_new("abort", 5);
  ScrDyn *type = scr_dyn_new_str(abort);
  scr_str_release(abort);
  ScrDyn *listener = scr_dyn_retain(st->listener);
  ScrDyn *remove_args[2] = {type, listener};
  ScrDyn *r = scr_et_remove_listener(core, remove_args, 2);
  if (r) scr_dyn_release(r);
  scr_dyn_release(type);
  scr_dyn_release(listener);
}

/* emitter.removeListener(name, cb) for a listener closure still alive. */
static bool scr_eos_off(ScrEmitter *em, ScrStr *name, ScrClosure *cb) {
  if (cb == NULL) return true;
  scr_emitter_release(scr_emitter_off(em, name, cb));
  return !scr_exc_pending();
}

/* The compiled adapter's tail: `cb` is the firing emitter listener, `args`
 * the boxed event arguments (moves in). */
void scr_events_once_signal_fire(ScrClosure *cb, ScrArr *args) {
  ScrEosLink *link = scr_box_get_ref(cb->caps[1]);
  ScrEosState *st = link->st;
  if (!st->settled) {
    st->settled = true;
    bool error = link->slot == SCR_EOS_ERROR;
    /* Node's errorListener removes the event's listener and resolver the
     * error's, each through removeListener; then the abort listener. */
    bool ok;
    if (error) {
      ok = scr_eos_off(st->em, st->name, st->event_cb);
    } else {
      ScrStr *error_name = scr_str_new("error", 5);
      ok = scr_eos_off(st->em, error_name, st->error_cb);
      scr_str_release(error_name);
    }
    if (ok) {
      scr_eos_remove_abort(st);
      if (error) {
        ScrDyn *reason = (ScrDyn *)scr_arr_get_ref(args, 0);
        scr_dyn_throw(reason); /* moves reason */
        scr_promise_reject_pending(st->promise);
      } else {
        scr_promise_fulfill_ref(st->promise, scr_arr_retain(args), scr_arr_retain_v,
                                scr_arr_release_v, args->cyc ? scr_arr_trace_v : NULL);
      }
    }
  }
  scr_arr_release(args);
  scr_eos_link_release(link);
}

/* The signal's 'abort' listener: caps[0] its link, caps[1] the emitter. */
static ScrDyn *scr_eos_abort_thunk(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc;
  ScrEosLink *link = scr_box_get_ref(clo->caps[0]);
  ScrEmitter *em = scr_box_get_ref(clo->caps[1]);
  ScrEosState *st = link->st;
  bool ok = true;
  if (!st->settled) {
    st->settled = true;
    ok = scr_eos_off(em, st->name, st->event_cb);
    if (ok) {
      ScrStr *error_name = scr_str_new("error", 5);
      ok = scr_eos_off(em, error_name, st->error_cb);
      scr_str_release(error_name);
    }
    if (ok) {
      scr_eos_throw_abort(st->signal);
      scr_promise_reject_pending(st->promise);
    }
  }
  scr_emitter_release(em);
  scr_eos_link_release(link);
  return ok ? scr_dyn_retain(scr_dyn_undefined()) : NULL;
}

static ScrBox *scr_eos_promise_box(ScrPromise *p) {
  ScrBox *box = scr_box_new_obj(&scr_promise_retain_v, &scr_promise_release_v, &scr_promise_trace_v);
  scr_box_set_ref(box, scr_promise_retain(p));
  return box;
}

static void scr_eos_adopt_job(ScrClosure *job) {
  ScrPromise *outer = scr_box_get_ref(job->caps[0]);
  ScrPromise *inner = scr_box_get_ref(job->caps[1]);
  scr_promise_race_join(outer, inner, &scr_promise_adapt_copy);
  scr_promise_release(inner);
  scr_promise_release(outer);
}

/* Node's once is an async function returning the executor's promise: its
 * result adopts that promise through a thenable job queued now, whose
 * reaction settles the result one turn after the inner promise settles.
 * Moves `inner` in; the result is +1. */
static ScrPromise *scr_eos_adopt(ScrPromise *inner) {
  ScrPromise *outer = scr_promise_new();
  ScrClosure *job = scr_closure_new((void *)&scr_eos_adopt_job, 2);
  job->caps[0] = scr_eos_promise_box(outer);
  job->caps[1] = scr_eos_promise_box(inner);
  scr_promise_release(inner);
  scr_queue_microtask(job);
  return outer;
}

/* boxer and err_boxer are borrowed (err_boxer is NULL when the awaited
 * event is 'error'); signal is borrowed. The result is +1 and never throws:
 * every failure rejects it, as Node's async function does. */
ScrPromise *scr_events_once_signal(ScrEmitter *em, ScrStr *name, ScrClosure *boxer, void *adapter,
                                   ScrEeInvoke inv, ScrClosure *err_boxer, void *err_adapter,
                                   ScrEeInvoke err_inv, ScrDyn *signal) {
  ScrPromise *result = scr_promise_new();
  bool with_signal = signal->kind != SCR_DYN_UNDEF;
  if (with_signal) {
    bool aborted = false;
    ScrEventTargetCore *core =
        scr_et_signal_core_fn ? scr_et_signal_core_fn(signal, &aborted) : NULL;
    if (!core) {
      scr_dyn_prop_type_fail("options.signal", "an instance of AbortSignal", signal);
      scr_promise_reject_pending(result);
      return result;
    }
    if (aborted) {
      scr_eos_throw_abort(signal);
      scr_promise_reject_pending(result);
      return result;
    }
  }
  ScrEosState *st = calloc(1, sizeof *st);
  if (!st) scr_eos_oom();
  st->rc = 1;
  st->promise = result;
  st->em = em;
  st->name = scr_str_retain(name);
  st->signal = scr_dyn_retain(signal);
  ScrClosure *event_cb = scr_eos_closure(adapter, boxer, st, SCR_EOS_EVENT);
  ScrClosure *error_cb =
      err_boxer != NULL ? scr_eos_closure(err_adapter, err_boxer, st, SCR_EOS_ERROR) : NULL;
  st->event_cb = event_cb;
  st->error_cb = error_cb;
  /* Node registers inside the promise's executor: a throwing 'newListener'
   * listener rejects the promise, and the listener it announced is never
   * added (the event's listener stays when only the 'error' announcement
   * throws). No abort listener follows a throw. */
  ScrCaught *thrown = NULL;
  scr_emitter_release(scr_emitter_on(em, name, event_cb, inv, true, false));
  if (scr_exc_pending()) {
    thrown = scr_exc_take();
    scr_emitter_unadd_quiet(em, name, event_cb);
    if (error_cb != NULL) scr_closure_release(error_cb); /* never registered */
  } else if (error_cb != NULL) {
    ScrStr *error = scr_str_new("error", 5);
    scr_emitter_release(scr_emitter_on(em, error, error_cb, err_inv, true, false));
    if (scr_exc_pending()) {
      thrown = scr_exc_take();
      scr_emitter_unadd_quiet(em, error, error_cb);
    }
    scr_str_release(error);
  }
  if (thrown != NULL) {
    st->settled = true;
    scr_rethrow(thrown);
    scr_caught_release(thrown);
    scr_promise_reject_pending(st->promise);
  } else if (with_signal) {
    ScrClosure *clo = scr_closure_new((void *)&scr_eos_abort_thunk, 2);
    clo->caps[0] = scr_eos_link_box(st, SCR_EOS_ABORT);
    clo->caps[1] = scr_box_new_obj(&scr_emitter_retain_v, &scr_emitter_release_v, NULL);
    scr_box_set_ref(clo->caps[1], scr_emitter_retain(em));
    ScrDyn *listener = scr_dyn_new_func(clo, &scr_eos_abort_thunk, 0, "()", "abortListener");
    st->listener = listener;
    ScrDyn *dispose = scr_events_add_abort_listener(signal, listener);
    if (dispose) scr_dyn_release(dispose);
    /* The signal's listener entry keeps it; the state's pointer is weak. */
    scr_dyn_release(listener);
  }
  ScrPromise *inner = scr_promise_retain(st->promise);
  scr_eos_state_release(st);
  return scr_eos_adopt(inner);
}
