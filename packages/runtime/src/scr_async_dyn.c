/* Checked-dynamic ASYNC surfaces (gated — native-toolchain.ts links this TU only when
 * the IR carries the crossing libCalls or dyn dispatch: the scr_dc.c
 * size-class precedent). Everything here rides scr_async.c's public
 * machinery: the checked-dynamic tree-promise reaction helpers (.then/.catch/.finally
 * over SCR_DYN_PROMISE, await of a checked-dynamic value, the
 * `new Promise(setImmediate)` constructor), the AsyncLocalStorage API
 * over the fiber-carried snapshots (the always-linked core keeps only
 * the active slot + RC pair), the unhandled-rejection listener registry
 * (installed into scr_report_unhandled_rejections' hook at
 * registration), and the process-warning channel (emitWarning + the
 * 'warning' listeners + Node's stderr report). */
#include "scr_runtime.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#include <process.h>
#define SCR_WARN_PID() ((long)_getpid())
#else
#include <unistd.h>
#define SCR_WARN_PID() ((long)getpid())
#endif

static void scr_ad_oom(void) {
  fputs("scriptc: out of memory\n", stderr);
  abort();
}

/* Fresh snapshot storage (the layout lives in scr_runtime.h; the RC pair
 * in scr_async.c — spawn/destroy touch it). */
static ScrAlsCtx *scr_als_ctx_alloc(size_t len) {
  ScrAlsCtx *c = malloc(sizeof *c + len * sizeof(ScrAlsEntry));
  if (!c) scr_ad_oom();
  c->rc = 1;
  c->len = len;
  return c;
}

static SCR_TL double scr_als_counter = 0;

/* Main-slot teardown (atexit, LIFO after scr_init's audit registration —
 * the dc-registry precedent): a top-level enterWith leaves a context in
 * the main slot at exit; release it before the RC audit counts. */
static void scr_als_teardown(void) {
  /* atexit runs on the main context — the active slot IS main's. */
  scr_als_ctx_release(*SCR_ALS_SLOT());
  *SCR_ALS_SLOT() = NULL;
}

double scr_als_new(void) {
  static SCR_TL bool teardown_registered = false;
  if (!teardown_registered) {
    teardown_registered = true;
    scr_atexit(scr_als_teardown);
  }
  return ++scr_als_counter;
}

ScrDyn *scr_als_get(double id) {
  const ScrAlsCtx *c = *SCR_ALS_SLOT();
  if (c) {
    for (size_t i = 0; i < c->len; i++) {
      if (c->entries[i].id == id) return scr_dyn_retain(c->entries[i].value);
    }
  }
  return scr_dyn_retain(scr_dyn_undefined());
}

/* Fresh snapshot with (id → value) replaced-or-appended (value borrowed,
 * retained in), installed as the active context; the PREVIOUS snapshot
 * returns (ownership moves out) for scr_als_restore. */
ScrAlsCtx *scr_als_enter(double id, ScrDyn *value) {
  ScrAlsCtx *prev = *SCR_ALS_SLOT();
  size_t n = prev ? prev->len : 0;
  bool have = false;
  for (size_t i = 0; i < n; i++) {
    if (prev->entries[i].id == id) { have = true; break; }
  }
  ScrAlsCtx *next = scr_als_ctx_alloc(have ? n : n + 1);
  size_t w = 0;
  for (size_t i = 0; i < n; i++) {
    if (prev->entries[i].id == id) continue;
    next->entries[w].id = prev->entries[i].id;
    next->entries[w].value = scr_dyn_retain(prev->entries[i].value);
    w++;
  }
  next->entries[w].id = id;
  next->entries[w].value = scr_dyn_retain(value);
  *SCR_ALS_SLOT() = next;
  return prev; /* ownership moves to the caller */
}

/* The exit() arm: the id REMOVED from the snapshot. */
ScrAlsCtx *scr_als_enter_absent(double id) {
  ScrAlsCtx *prev = *SCR_ALS_SLOT();
  size_t n = prev ? prev->len : 0;
  size_t keep = 0;
  for (size_t i = 0; i < n; i++) {
    if (prev->entries[i].id != id) keep++;
  }
  ScrAlsCtx *next = scr_als_ctx_alloc(keep);
  size_t w = 0;
  for (size_t i = 0; i < n; i++) {
    if (prev->entries[i].id == id) continue;
    next->entries[w].id = prev->entries[i].id;
    next->entries[w].value = scr_dyn_retain(prev->entries[i].value);
    w++;
  }
  *SCR_ALS_SLOT() = next;
  return prev;
}

void scr_als_restore(ScrAlsCtx *prev) {
  scr_als_ctx_release(*SCR_ALS_SLOT());
  *SCR_ALS_SLOT() = prev; /* ownership moves back in */
}

void scr_als_enter_with(double id, ScrDyn *value) {
  ScrAlsCtx *prev = scr_als_enter(id, value);
  scr_als_ctx_release(prev); /* no restore point — Node's enterWith */
}

void scr_als_disable(double id) {
  ScrAlsCtx *prev = scr_als_enter_absent(id);
  scr_als_ctx_release(prev); /* minimal core: cleared for the current context */
}

/* run(store, fn, ...args) / exit(fn, ...args): enter (or clear), call the
 * dyn function with the forwarded arguments, restore — the finally, so a
 * throw still restores before propagating. Result +1 or NULL pending. */
static ScrDyn *scr_als_call_in(ScrAlsCtx *prev, ScrDyn *fn, ScrDyn *args) {
  size_t argc = args->kind == SCR_DYN_ARR ? args->v.arr.len : 0;
  ScrDyn *const *items = args->kind == SCR_DYN_ARR ? args->v.arr.items : NULL;
  ScrDyn *r = scr_dyn_call(fn, items, argc, "callback");
  scr_als_restore(prev);
  return r;
}

ScrDyn *scr_als_run(double id, ScrDyn *value, ScrDyn *fn, ScrDyn *args) {
  return scr_als_call_in(scr_als_enter(id, value), fn, args);
}

ScrDyn *scr_als_exit_run(double id, ScrDyn *fn, ScrDyn *args) {
  return scr_als_call_in(scr_als_enter_absent(id), fn, args);
}

/* The two rejection-event registries share one shape: listeners with a
 * `once` flag (auto-removed after one delivery, Node's once) and
 * identity-based removal (the offWarning stance). */
typedef struct {
  size_t refs;
  bool fired;
} ScrRejState;

typedef struct {
  ScrDyn *fn;
  bool once;
  uint64_t id;
  ScrRejState *state; /* snapshots share the once-fired state */
} ScrRejListener;

static void scr_rej_release(ScrRejListener *l) {
  scr_dyn_release(l->fn);
  if (--l->state->refs == 0) free(l->state);
}

static SCR_TL uint64_t scr_rej_id = 0;

static SCR_TL ScrRejListener *scr_urj_listeners = NULL;
static SCR_TL size_t scr_nurj = 0, scr_urj_cap = 0;
static SCR_TL ScrRejListener *scr_rjh_listeners = NULL;
static SCR_TL size_t scr_nrjh = 0, scr_rjh_cap = 0;

static void scr_urj_teardown(void) {
  for (size_t i = 0; i < scr_nurj; i++) scr_rej_release(&scr_urj_listeners[i]);
  free(scr_urj_listeners);
  scr_urj_listeners = NULL;
  scr_nurj = scr_urj_cap = 0;
}

static void scr_rjh_teardown(void) {
  for (size_t i = 0; i < scr_nrjh; i++) scr_rej_release(&scr_rjh_listeners[i]);
  free(scr_rjh_listeners);
  scr_rjh_listeners = NULL;
  scr_nrjh = scr_rjh_cap = 0;
}

static bool scr_urj_dispatch(ScrPromise *p);
static void scr_rjh_dispatch(ScrPromise *p);

/* Node's ERR_INVALID_ARG_TYPE for a non-function listener; true when the
 * value is fine. */
static bool scr_rej_check_listener(ScrDyn *fn) {
  if (fn->kind == SCR_DYN_FUNC) return true;
  const char *msg = "The \"listener\" argument must be of type function";
  scr_throw_error_msg_code(SCR_ERR_TYPE, msg, strlen(msg), "ERR_INVALID_ARG_TYPE");
  return false;
}

static void scr_rej_push(ScrRejListener **list, size_t *n, size_t *cap, ScrDyn *fn, bool once) {
  if (*n == *cap) {
    *cap = *cap ? *cap * 2 : 4;
    *list = realloc(*list, *cap * sizeof **list);
    if (!*list) scr_ad_oom();
  }
  ScrRejState *state = calloc(1, sizeof *state);
  if (!state) scr_ad_oom();
  state->refs = 1;
  (*list)[(*n)++] = (ScrRejListener){scr_dyn_retain(fn), once, ++scr_rej_id, state};
}

static void scr_rej_remove(ScrRejListener *list, size_t *n, ScrDyn *fn) {
  for (size_t left = *n; left > 0; left--) {
    size_t i = left - 1;
    ScrDyn *l = list[i].fn;
    bool same = l == fn || (l->kind == SCR_DYN_FUNC && fn->kind == SCR_DYN_FUNC &&
                            scr_dyn_strict_eq(l, fn));
    if (same) {
      scr_rej_release(&list[i]);
      memmove(list + i, list + i + 1, (*n - i - 1) * sizeof *list);
      (*n)--;
      return;
    }
  }
}

/* The hooks arm exactly while their registry is non-empty: Node with
 * every listener removed (off, or once-consumed) reverts to the default
 * report/silence, and the report loop consults the hook per promise. */
static void scr_urj_sync_hook(void) {
  scr_urj_deliver_fn = scr_nurj > 0 ? scr_urj_dispatch : NULL;
}

static void scr_rjh_sync_hook(void) {
  scr_rjh_notify_fn = scr_nrjh > 0 ? scr_rjh_dispatch : NULL;
}

void scr_process_on_unhandled_rejection(ScrDyn *fn, bool once) {
  if (!scr_rej_check_listener(fn)) return;
  static SCR_TL bool teardown_armed = false;
  if (!teardown_armed) {
    teardown_armed = true;
    scr_atexit(scr_urj_teardown);
  }
  scr_rej_push(&scr_urj_listeners, &scr_nurj, &scr_urj_cap, fn, once);
  scr_urj_sync_hook();
}

void scr_process_off_unhandled_rejection(ScrDyn *fn) {
  scr_rej_remove(scr_urj_listeners, &scr_nurj, fn);
  scr_urj_sync_hook();
}

void scr_process_on_rejection_handled(ScrDyn *fn, bool once) {
  if (!scr_rej_check_listener(fn)) return;
  static SCR_TL bool teardown_armed = false;
  if (!teardown_armed) {
    teardown_armed = true;
    scr_atexit(scr_rjh_teardown);
  }
  scr_rej_push(&scr_rjh_listeners, &scr_nrjh, &scr_rjh_cap, fn, once);
  scr_rjh_sync_hook();
}

void scr_process_off_rejection_handled(ScrDyn *fn) {
  scr_rej_remove(scr_rjh_listeners, &scr_nrjh, fn);
  scr_rjh_sync_hook();
}

/* Snapshot dispatch preserves EventEmitter mutation rules: removals do
 * not skip a pending listener, additions wait for the next delivery, and
 * once entries leave the live list before invoking user code. */
static bool scr_rej_fire(ScrRejListener **list, size_t *n, ScrDyn **args, size_t argc) {
  size_t count = *n;
  ScrRejListener *snap = count ? malloc(count * sizeof *snap) : NULL;
  if (count && !snap) scr_ad_oom();
  for (size_t i = 0; i < count; i++) {
    snap[i] = (*list)[i];
    scr_dyn_retain(snap[i].fn);
    snap[i].state->refs++;
  }
  bool ok = true;
  for (size_t i = 0; i < count; i++) {
    if (ok && !(snap[i].once && snap[i].state->fired)) {
      if (snap[i].once) {
        snap[i].state->fired = true;
        for (size_t j = 0; j < *n; j++) {
          if ((*list)[j].id == snap[i].id) {
            scr_rej_release(&(*list)[j]);
            memmove(*list + j, *list + j + 1, (*n - j - 1) * sizeof **list);
            (*n)--;
            break;
          }
        }
      }
      ScrDyn *r = scr_dyn_call(snap[i].fn, args, argc, "listener");
      ok = !scr_exc_pending();
      scr_dyn_release(r);
    }
    scr_rej_release(&snap[i]);
  }
  free(snap);
  return ok;
}

/* Uncaught exception listeners share the checked-dynamic callback ABI.
 * Monitors run first but do not handle the exception by themselves. */
static SCR_TL ScrRejListener *scr_uncaught_ls[2];
static SCR_TL size_t scr_uncaught_n[2], scr_uncaught_cap[2];
static int scr_uncaught_dispatch(bool from_promise);

static void scr_uncaught_sync_hook(void) {
  scr_uncaught_exception_hook = (scr_uncaught_n[0] || scr_uncaught_n[1]) ? scr_uncaught_dispatch : NULL;
}

static void scr_uncaught_teardown(void) {
  for (size_t k = 0; k < 2; k++) {
    for (size_t i = 0; i < scr_uncaught_n[k]; i++) scr_rej_release(&scr_uncaught_ls[k][i]);
    free(scr_uncaught_ls[k]);
    scr_uncaught_ls[k] = NULL;
    scr_uncaught_n[k] = scr_uncaught_cap[k] = 0;
  }
  scr_uncaught_sync_hook();
}

void scr_process_on_uncaught_exception(ScrDyn *fn, bool once, bool monitor) {
  if (!scr_rej_check_listener(fn)) return;
  static SCR_TL bool armed = false;
  if (!armed) { armed = true; scr_atexit(scr_uncaught_teardown); }
  size_t k = monitor ? 1 : 0;
  scr_rej_push(&scr_uncaught_ls[k], &scr_uncaught_n[k], &scr_uncaught_cap[k], fn, once);
  scr_uncaught_sync_hook();
}

void scr_process_off_uncaught_exception(ScrDyn *fn, bool monitor) {
  if (!scr_rej_check_listener(fn)) return;
  size_t k = monitor ? 1 : 0;
  scr_rej_remove(scr_uncaught_ls[k], &scr_uncaught_n[k], fn);
  scr_uncaught_sync_hook();
}

static int scr_uncaught_dispatch(bool from_promise) {
  ScrCaught *caught = scr_exc_take();
  ScrDyn *error = scr_caught_to_dyn(caught);
  const char *origin = from_promise ? "unhandledRejection" : "uncaughtException";
  ScrStr *text = scr_str_new(origin, strlen(origin));
  ScrDyn *args[2] = {error, scr_dyn_new_str(text)};
  scr_str_release(text);
  bool ok = scr_rej_fire(&scr_uncaught_ls[1], &scr_uncaught_n[1], args, 2);
  bool handled = ok && scr_uncaught_n[0] > 0;
  if (handled) ok = scr_rej_fire(&scr_uncaught_ls[0], &scr_uncaught_n[0], args, 2);
  scr_dyn_release(args[0]);
  scr_dyn_release(args[1]);
  scr_uncaught_sync_hook();
  if (ok && !handled) scr_rethrow(caught);
  scr_caught_release(caught);
  return !ok ? -1 : handled ? 1 : 0;
}

/* Dispatch one unhandled rejection to the registered listeners —
 * (reason, promise), Node's signature. A listener throw is an uncaught
 * exception (Node crashes there too): the caller prints it and exits 1.
 * A once-consumed-to-empty registry disarms the hook on the way out, so
 * the report's NEXT promise takes the default print — Node's
 * listener-less behavior. */
static bool scr_urj_dispatch(ScrPromise *p) {
  ScrDyn *reason = scr_promise_reason_dyn(p);
  ScrDyn *boxed = scr_dyn_new_promise(p);
  ScrDyn *args[2] = {reason, boxed};
  bool ok = scr_rej_fire(&scr_urj_listeners, &scr_nurj, args, 2);
  scr_dyn_release(reason);
  scr_dyn_release(boxed);
  scr_urj_sync_hook();
  return ok;
}

/* 'rejectionHandled' delivery — (promise), Node's payload. A listener
 * throw propagates as a pending exception through the attach site. */
static void scr_rjh_dispatch(ScrPromise *p) {
  ScrDyn *boxed = scr_dyn_new_promise(p);
  (void)scr_rej_fire(&scr_rjh_listeners, &scr_nrjh, &boxed, 1);
  scr_dyn_release(boxed);
  scr_rjh_sync_hook(); /* a once-consumed-to-empty registry disarms */
}

/* `new Promise(setImmediate)` (the Node-suite early-exit shape): the
 * executor IS setImmediate, so resolve rides the immediate queue — a
 * fresh promise an armed immediate fulfills with the undefined dyn value
 * (the executor's resolve receives no argument; the dyn payload keeps
 * promise<dyn> awaiters honest and void awaiters ignore it). +1. */
static void scr_imm_promise_thunk(ScrClosure *self) {
  ScrPromise *p = (ScrPromise *)scr_box_get_ref(self->caps[0]);
  scr_promise_fulfill_ref(p, scr_dyn_retain(scr_dyn_undefined()), scr_dyn_retain_v,
                          scr_dyn_release_v, NULL);
  scr_promise_release(p);
}

ScrPromise *scr_immediate_promise(void) {
  ScrPromise *p = scr_promise_new();
  ScrClosure *cb = scr_closure_new((void *)scr_imm_promise_thunk, 1);
  cb->caps[0] = scr_box_new_obj(scr_promise_retain_v, scr_promise_release_v, NULL);
  scr_box_set_ref(cb->caps[0], scr_promise_retain(p));
  scr_set_immediate(cb); /* ownership of cb moves in */
  return p;
}

/* ── .then/.catch/.finally over dyn promises (scr_dyn_invoke's promise
 * arm and the dc tracePromise reactions) ──────────────────────────────
 * One reaction fiber per registration: it awaits src (the settled-await
 * microtask hop keeps JS's ordering — reactions never run synchronously
 * inside settle), runs the checked-dynamic tree handler, and settles dst. A handler
 * returning a dyn promise is ADOPTED (awaited in a loop, like JS's
 * resolve). Non-callable handlers pass the settlement through (JS's
 * PromisePrototypeThen over non-function reactions). The fiber's own
 * promise is dropped unobserved — the entry consumes every exception
 * into dst, so it can never reject. */
typedef struct {
  ScrPromise *src, *dst; /* owned */
  ScrDyn *onf, *onr, *onfin; /* owned or NULL */
} ScrDynThenPack;

typedef struct {
  ScrPromise *src, *dst;
  ScrDyn *result;
} ScrDynFinallyPack;

static void scr_dyn_finally_entry(ScrFiber *self, void *opaque) {
  (void)self;
  ScrDynFinallyPack *pack = opaque;
  ScrDyn *result = scr_await_dyn(pack->result->v.promise);
  if (scr_exc_pending()) scr_promise_reject_pending(pack->dst);
  else scr_promise_adapt_copy(pack->dst, pack->src);
  scr_dyn_release(result);
  scr_dyn_release(pack->result);
  scr_promise_release(pack->src);
  scr_promise_release(pack->dst);
  free(pack);
}

static void scr_dyn_then_entry(ScrFiber *self, void *ap) {
  (void)self;
  ScrDynThenPack *a = (ScrDynThenPack *)ap;
  ScrDyn *v = scr_await_dyn(a->src);
  bool rejected = scr_exc_pending();
  ScrCaught *c = rejected ? scr_exc_take() : NULL;
  ScrDyn *handler = a->onfin ? a->onfin : (rejected ? a->onr : a->onf);
  if (handler != NULL && scr_dyn_is_callable(handler)) {
    ScrDyn *arg = NULL;
    if (a->onfin == NULL) arg = rejected ? scr_caught_to_dyn(c) : scr_dyn_retain(v);
    ScrDyn *r = scr_dyn_call(handler, arg ? &arg : NULL, arg ? 1 : 0, "handler");
    scr_dyn_release(arg);
    if (r == NULL) {
      /* The handler threw: dst rejects with that. */
      scr_promise_reject_pending(a->dst);
    } else if (a->onfin != NULL) {
      /* finally returns PromiseResolve(result).then(valueThunk), which
       * the outer reaction adopts. Even an undefined result takes those
       * jobs before propagating the original fulfillment or rejection. */
      if (r->kind != SCR_DYN_PROMISE) {
        ScrPromise *result = scr_promise_new();
        scr_promise_fulfill_ref(result, r, scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
        r = scr_dyn_new_promise(result);
        scr_promise_release(result);
      }
      ScrPromise *passthrough = scr_promise_new();
      ScrDynFinallyPack *pack = malloc(sizeof *pack);
      if (!pack) scr_ad_oom();
      pack->src = scr_promise_retain(a->src);
      pack->dst = scr_promise_retain(passthrough);
      pack->result = r;
      ScrPromise *waiter = scr_async_spawn_after(r->v.promise, scr_dyn_finally_entry, pack);
      scr_promise_release(waiter);
      scr_promise_resolve_dyn(a->dst, scr_dyn_new_promise(passthrough));
      scr_promise_release(passthrough);
    } else {
      scr_promise_resolve_dyn(a->dst, r);
    }
  } else if (rejected) {
    scr_rethrow(c);
    scr_promise_reject_pending(a->dst);
  } else {
    scr_promise_fulfill_ref(a->dst, scr_dyn_retain(v), scr_dyn_retain_v, scr_dyn_release_v, NULL);
  }
  scr_caught_release(c);
  scr_dyn_release(v);
  scr_promise_release(a->src);
  scr_promise_release(a->dst);
  scr_dyn_release(a->onf);
  scr_dyn_release(a->onr);
  scr_dyn_release(a->onfin);
  free(a);
}

ScrDyn *scr_dyn_promise_then(ScrPromise *src, ScrDyn *onf, ScrDyn *onr, ScrDyn *onfin) {
  /* A rejection HANDLER marks the source handled at attach (Node's
   * moment; the reaction fiber's await re-marks harmlessly) — this is
   * also what lets a .catch inside an 'unhandledRejection' listener fire
   * 'rejectionHandled' immediately at the attach point. */
  if (onr != NULL) scr_promise_mark_handled(src);
  ScrDynThenPack *a = malloc(sizeof *a);
  if (!a) scr_ad_oom();
  a->src = scr_promise_retain(src);
  a->dst = scr_promise_new();
  a->onf = onf ? scr_dyn_retain(onf) : NULL;
  a->onr = onr ? scr_dyn_retain(onr) : NULL;
  a->onfin = onfin ? scr_dyn_retain(onfin) : NULL;
  ScrDyn *boxed = scr_dyn_new_promise(a->dst);
  ScrPromise *waiter = scr_async_spawn_after(src, scr_dyn_then_entry, a);
  scr_promise_release(waiter); /* the entry never rejects; nobody awaits it */
  return boxed;
}
typedef struct {
  ScrPromise *destination;
  ScrDyn *value;
} ScrDynResolvePack;

static void scr_dyn_resolve_entry(ScrFiber *self, void *opaque) {
  (void)self;
  ScrDynResolvePack *pack = opaque;
#ifndef __wasi__
  /* Promise resolution schedules a job before attaching its reaction. */
  scr_await_hop();
#endif
  ScrDyn *value = scr_await_dyn(pack->value->v.promise);
  if (scr_exc_pending()) scr_promise_reject_pending(pack->destination);
  else scr_promise_resolve_dyn(pack->destination, value);
  scr_dyn_release(pack->value);
  scr_promise_release(pack->destination);
  free(pack);
}

#ifdef __wasi__
static void scr_dyn_resolve_job(ScrClosure *closure) {
  ScrPromise *destination = scr_box_get_ref(closure->caps[0]);
  ScrDyn *value = scr_box_get_ref(closure->caps[1]);
  ScrDynResolvePack *pack = malloc(sizeof *pack);
  if (!pack) scr_ad_oom();
  pack->destination = destination;
  pack->value = value;
  ScrPromise *waiter = scr_async_spawn_after(value->v.promise, scr_dyn_resolve_entry, pack);
  scr_promise_release(waiter);
}
#endif

/* The destination is borrowed; value moves in. An async function may
 * return a native promise hidden behind any/unknown without an explicit
 * await, so its completion must use resolution rather than fulfillment. */
void scr_promise_resolve_dyn(ScrPromise *destination, ScrDyn *value) {
  if (value->kind != SCR_DYN_PROMISE) {
    scr_promise_fulfill_ref(destination, value, scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
    return;
  }
  if (value->v.promise == destination) {
    static const char message[] = "Chaining cycle detected for promise #<Promise>";
    scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
    scr_promise_reject_pending(destination);
    scr_dyn_release(value);
    return;
  }
#ifdef __wasi__
  ScrClosure *job = scr_closure_new((void *)scr_dyn_resolve_job, 2);
  job->caps[0] = scr_box_new_obj(scr_promise_retain_v, scr_promise_release_v, scr_promise_trace_v);
  scr_box_set_ref(job->caps[0], scr_promise_retain(destination));
  job->caps[1] = scr_box_new_obj(scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
  scr_box_set_ref(job->caps[1], value);
  scr_queue_microtask(job);
#else
  ScrDynResolvePack *pack = malloc(sizeof *pack);
  if (!pack) scr_ad_oom();
  pack->destination = scr_promise_retain(destination);
  pack->value = value;
  ScrPromise *waiter = scr_async_spawn(scr_dyn_resolve_entry, pack);
  scr_promise_release(waiter);
#endif
}

/* `await v` where v is a CHECKED-DYNAMIC value: a dyn promise adopts
 * (the boxed promise awaits — rejections re-throw); every other kind is
 * JS's await-of-a-non-thenable — one microtask hop, the value itself
 * (+1). Thenable ADOPTION (a plain object carrying a then method) is not
 * modeled — SEMANTICS.md. */
ScrDyn *scr_await_dyn_value(ScrDyn *v) {
  if (v->kind == SCR_DYN_PROMISE) return scr_await_dyn(v->v.promise);
  scr_await_hop();
  return scr_dyn_retain(v);
}

/* The WASI emitter has already suspended on the value's actual promise,
 * or taken the non-promise microtask hop. Extraction must never suspend a
 * runtime-authored C frame. */
ScrDyn *scr_await_dyn_value_settled(ScrDyn *value) {
  return value->kind == SCR_DYN_PROMISE ? scr_await_dyn(value->v.promise) : scr_dyn_retain(value);
}

/* ── process warnings (emitWarning + the 'warning' event) ─────────────
 * Gated with the rest of this TU (a deprecation-emitting unit's gate
 * must imply the dynAsync link). Listeners are dyn functions; the
 * warning is built at the call and emitted on the next tick, as Node's
 * emitWarning does (scr_warning_emit_deferred). The default stderr report
 * prints for every warning except deprecations under process.noDeprecation
 * (Node's own bootstrap listener; a compiled binary has no
 * --no-warnings). The warning VALUE is the dyn error encoding built over
 * an ScrError (identity-cached, so a listener comparing two deliveries
 * of one warning sees one object); a string `detail` joins the dyn node
 * and the report's second line, exactly Node. */
static SCR_TL ScrDyn **scr_warn_listeners = NULL;
static SCR_TL size_t scr_nwarn = 0, scr_warn_cap = 0;

static void scr_warn_teardown(void) {
  for (size_t i = 0; i < scr_nwarn; i++) scr_dyn_release(scr_warn_listeners[i]);
  free(scr_warn_listeners);
  scr_warn_listeners = NULL;
  scr_nwarn = scr_warn_cap = 0;
}

void scr_process_on_warning(ScrDyn *fn) {
  if (fn->kind != SCR_DYN_FUNC) {
    const char *msg = "The \"listener\" argument must be of type function";
    scr_throw_error_msg_code(SCR_ERR_TYPE, msg, strlen(msg), "ERR_INVALID_ARG_TYPE");
    return;
  }
  scr_warning_emit_hook = scr_emit_warning;
  if (scr_nwarn == scr_warn_cap) {
    scr_warn_cap = scr_warn_cap ? scr_warn_cap * 2 : 4;
    scr_warn_listeners = realloc(scr_warn_listeners, scr_warn_cap * sizeof *scr_warn_listeners);
    if (!scr_warn_listeners) {
      fputs("scriptc: out of memory\n", stderr);
      abort();
    }
  }
  if (scr_nwarn == 0) scr_atexit(scr_warn_teardown);
  scr_warn_listeners[scr_nwarn++] = scr_dyn_retain(fn);
}

void scr_process_off_warning(ScrDyn *fn) {
  for (size_t i = 0; i < scr_nwarn; i++) {
    ScrDyn *l = scr_warn_listeners[i];
    bool same = l == fn || (l->kind == SCR_DYN_FUNC && fn->kind == SCR_DYN_FUNC &&
                            scr_dyn_strict_eq(l, fn));
    if (same) {
      scr_dyn_release(l);
      memmove(scr_warn_listeners + i, scr_warn_listeners + i + 1,
              (scr_nwarn - i - 1) * sizeof *scr_warn_listeners);
      scr_nwarn--;
      return;
    }
  }
}

/* process.noDeprecation (0) and process.throwDeprecation (1): ordinary
 * writable process properties, undefined until the program assigns them.
 * A compiled binary takes no Node command-line flags, so only those
 * assignments set them. */
static SCR_TL ScrDyn *scr_deprecation_flags[2] = {NULL, NULL};
static SCR_TL bool scr_deprecation_flags_registered = false;

static void scr_deprecation_flags_teardown(void) {
  for (size_t i = 0; i < 2; i++) {
    scr_dyn_release(scr_deprecation_flags[i]);
    scr_deprecation_flags[i] = NULL;
  }
}

ScrDyn *scr_process_deprecation_flag(double which) {
  ScrDyn *value = scr_deprecation_flags[which != 0];
  return scr_dyn_retain(value ? value : scr_dyn_undefined());
}

void scr_process_set_deprecation_flag(double which, ScrDyn *value) {
  if (!scr_deprecation_flags_registered) {
    scr_deprecation_flags_registered = true;
    scr_atexit(scr_deprecation_flags_teardown);
  }
  size_t slot = which != 0;
  ScrDyn *previous = scr_deprecation_flags[slot];
  scr_deprecation_flags[slot] = scr_dyn_retain(value);
  scr_dyn_release(previous);
}

bool scr_process_deprecation_flag_on(int which) {
  const ScrDyn *value = scr_deprecation_flags[which != 0];
  return value != NULL && scr_dyn_truthy(value);
}

/* The warning's name as warning.toString() reads it: the own property, or
 * the Error class name an emitted Error instance inherits. +1 or NULL. */
static ScrStr *scr_warning_name(const ScrDyn *w) {
  const ScrDyn *en = scr_dyn_obj_get(w, "name", 4);
  if (en) return en->kind == SCR_DYN_STR ? scr_str_retain(en->v.str) : NULL;
  ScrError *e = scr_errdyn_err_of(w);
  if (!e) return NULL;
  ScrStr *name = e->name ? scr_str_retain(e->name) : scr_error_default_name(e);
  scr_error_release(e);
  return name;
}

static bool scr_warning_is_deprecation(const ScrDyn *w) {
  ScrStr *name = scr_warning_name(w);
  bool deprecation = name && name->len == 18 && memcmp(name->data, "DeprecationWarning", 18) == 0;
  scr_str_release(name);
  return deprecation;
}

/* The default stderr report + dispatch over a built warning dyn node.
 * Borrowed. A listener throw propagates (the dc publish stance). */
static void scr_warning_dispatch(ScrDyn *w) {
  /* "(node:pid) [CODE] Name: message" + "\n<detail>" — Node's
   * onWarning report, written as ONE console.error line (so the global
   * console's group indentation applies to each of its lines). Node
   * registers that listener at startup, so it runs before the program's,
   * and skips deprecations while process.noDeprecation is set. */
  bool deprecation = scr_warning_is_deprecation(w);
  if (deprecation && scr_process_deprecation_flag_on(0)) goto listeners;
  ScrStr *name = scr_warning_name(w);
  const ScrDyn *em = scr_dyn_obj_get(w, "message", 7);
  const ScrDyn *ec = scr_dyn_obj_get(w, "code", 4);
  const ScrDyn *ed = scr_dyn_obj_get(w, "detail", 6);
  ScrJsonBuf report;
  scr_jb_init(&report);
  char pid[32];
  snprintf(pid, sizeof pid, "(node:%ld) ", SCR_WARN_PID());
  scr_jb_puts(&report, pid);
  if (ec && ec->kind == SCR_DYN_STR) {
    scr_jb_puts(&report, "[");
    scr_jb_put_str(&report, ec->v.str);
    scr_jb_puts(&report, "] ");
  }
  if (name) scr_jb_put_str(&report, name);
  else scr_jb_puts(&report, "Warning");
  scr_str_release(name);
  scr_jb_puts(&report, ": ");
  if (em && em->kind == SCR_DYN_STR) scr_jb_put_str(&report, em->v.str);
  if (ed && ed->kind == SCR_DYN_STR) {
    scr_jb_puts(&report, "\n");
    scr_jb_put_str(&report, ed->v.str);
  }
  /* Node's one-time trace hint, after the first report; deprecations
   * name their own trace flag. */
  static SCR_TL bool hinted = false;
  if (!hinted) {
    hinted = true;
    scr_jb_puts(&report, deprecation
                             ? "\n(Use `node --trace-deprecation ...` to show where the warning was created)"
                             : "\n(Use `node --trace-warnings ...` to show where the warning was created)");
  }
  ScrLogArg line = {.tag = SCR_ARG_STR};
  line.v.s = scr_jb_finish(&report);
  scr_console_error(1, &line);
  scr_str_release(line.v.s);
listeners:
  for (size_t i = 0; i < scr_nwarn; i++) {
    ScrDyn *r = scr_dyn_call(scr_warn_listeners[i], &w, 1, "listener");
    if (r == NULL) return; /* pending exception propagates */
    scr_dyn_release(r);
  }
}

/* A string warning with a type and an optional code, as
 * process.emitWarning(message, type, code) builds it. Borrows; +1. */
ScrDyn *scr_warning_new(ScrStr *message, const char *type, const ScrStr *code) {
  ScrError *e = scr_error_new(SCR_ERR_ERROR, message);
  scr_str_release(e->name);
  e->name = scr_str_new(type, strlen(type));
  e->name_present = true;
  if (code) e->code = scr_str_retain((ScrStr *)code);
  ScrDyn *w = scr_dyn_from_error(e);
  scr_error_release(e);
  return w;
}

/* A warning built from C parts (the runtime deprecation sites): name
 * defaults to "Warning"; code/detail optional. Reported synchronously.
 * Borrows message. */
void scr_emit_warning(const char *name, const char *code, ScrStr *message) {
  ScrStr *code_text = code ? scr_str_new(code, strlen(code)) : NULL;
  ScrDyn *w = scr_warning_new(message, name ? name : "Warning", code_text);
  scr_str_release(code_text);
  scr_warning_dispatch(w);
  scr_dyn_release(w);
}

/* Node's emitWarning tail for runtime-built warnings: deprecations are
 * dropped while process.noDeprecation is set and thrown from their own
 * tick while process.throwDeprecation is set; every other warning reaches
 * the report and the 'warning' listeners on the next tick. */
static void scr_warning_tick(ScrClosure *c) {
  ScrDyn *w = scr_box_get_ref(c->caps[0]);
  scr_warning_dispatch(w);
  scr_dyn_release(w);
}

static void scr_warning_throw_tick(ScrClosure *c) {
  ScrDyn *w = scr_box_get_ref(c->caps[0]);
  scr_throw_ref(w, scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
}

static void scr_warning_defer(ScrDyn *w, void (*fire)(ScrClosure *)) {
  ScrClosure *c = scr_closure_new((void *)fire, 1);
  c->caps[0] = scr_box_new_obj(scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
  scr_box_set_ref(c->caps[0], scr_dyn_retain(w));
  scr_next_tick(c);
}

void scr_warning_emit_deferred(ScrDyn *w) {
  if (scr_warning_is_deprecation(w)) {
    if (scr_process_deprecation_flag_on(0)) return;
    if (scr_process_deprecation_flag_on(1)) {
      scr_warning_defer(w, scr_warning_throw_tick);
      return;
    }
  }
  scr_warning_defer(w, scr_warning_tick);
}

/* The console members' warnings. Node's emitWarning emits on
 * process.nextTick, so these queue in order and each rides one raw tick
 * on the shared tick queue; any left at exit are dropped with it. */
static SCR_TL ScrStr **scr_warn_texts = NULL;
static SCR_TL size_t scr_warn_texts_head = 0, scr_warn_texts_len = 0, scr_warn_texts_cap = 0;
static SCR_TL bool scr_warn_texts_registered = false;

static void scr_warn_texts_teardown(void) {
  for (size_t i = scr_warn_texts_head; i < scr_warn_texts_len; i++) scr_str_release(scr_warn_texts[i]);
  free(scr_warn_texts);
  scr_warn_texts = NULL;
  scr_warn_texts_head = scr_warn_texts_len = scr_warn_texts_cap = 0;
}

static void scr_warn_text_tick(void) {
  if (scr_warn_texts_head == scr_warn_texts_len) return;
  ScrStr *message = scr_warn_texts[scr_warn_texts_head++];
  if (scr_warn_texts_head == scr_warn_texts_len) scr_warn_texts_head = scr_warn_texts_len = 0;
  scr_emit_warning(NULL, NULL, message);
  scr_str_release(message);
}

void scr_process_emit_warning_text(ScrStr *message) {
  if (message->len == 0) return;
  if (!scr_warn_texts_registered) {
    scr_warn_texts_registered = true;
    scr_atexit(scr_warn_texts_teardown);
  }
  if (scr_warn_texts_len == scr_warn_texts_cap) {
    size_t cap = scr_warn_texts_cap ? scr_warn_texts_cap * 2 : 4;
    ScrStr **grown = realloc(scr_warn_texts, cap * sizeof *grown);
    if (!grown) {
      fputs("scriptc: out of memory\n", stderr);
      abort();
    }
    scr_warn_texts = grown;
    scr_warn_texts_cap = cap;
  }
  scr_warn_texts[scr_warn_texts_len++] = scr_str_retain(message);
  scr_next_tick_raw(scr_warn_text_tick);
}

static void scr_warn_bad_arg(const char *arg, const char *want) {
  char buf[160];
  int n = snprintf(buf, sizeof buf, "The \"%s\" argument must be of type %s", arg, want);
  scr_throw_error_msg_code(SCR_ERR_TYPE, buf, (size_t)n, "ERR_INVALID_ARG_TYPE");
}

/* process.emitWarning(...) — Node's full argument grammar over dyn
 * values: (warning: string | Error), then for string warnings a type
 * string / ctor function / options object ({type, code, detail}) second
 * and a code string / ctor function third. Wrong kinds throw Node's
 * ERR_INVALID_ARG_TYPE TypeErrors at the call; non-string details are
 * ignored. The warning itself is emitted on the next tick. */
void scr_process_emit_warning(ScrDyn *args) {
  size_t argc = args->kind == SCR_DYN_ARR ? args->v.arr.len : 0;
  ScrDyn *const *items = args->kind == SCR_DYN_ARR ? args->v.arr.items : NULL;
  ScrDyn *warning = argc >= 1 ? items[0] : NULL;
  /* An Error-encoded warning: type/code arguments are ignored (Node). */
  if (warning != NULL && warning->kind == SCR_DYN_OBJ &&
      scr_dyn_obj_get(warning, "%error", 6) != NULL) {
    scr_warning_emit_deferred(warning);
    return;
  }
  if (warning == NULL || warning->kind != SCR_DYN_STR) {
    scr_warn_bad_arg("warning", "string or an instance of Error");
    return;
  }
  const ScrStr *type = NULL;
  const ScrStr *code = NULL;
  const ScrStr *detail = NULL;
  size_t i = 1;
  if (i < argc && items[i]->kind != SCR_DYN_UNDEF) {
    ScrDyn *a = items[i];
    if (a->kind == SCR_DYN_STR) {
      type = a->v.str;
      i++;
    } else if (a->kind == SCR_DYN_FUNC) {
      i = argc; /* ctor: consumed, stack-trace trimming only — ignored */
    } else if (a->kind == SCR_DYN_OBJ && scr_dyn_obj_get(a, "%error", 6) == NULL) {
      const ScrDyn *t = scr_dyn_obj_get(a, "type", 4);
      const ScrDyn *c = scr_dyn_obj_get(a, "code", 4);
      const ScrDyn *d = scr_dyn_obj_get(a, "detail", 6);
      if (t && t->kind == SCR_DYN_STR) type = t->v.str;
      else if (t && t->kind != SCR_DYN_UNDEF) {
        scr_warn_bad_arg("options.type", "string");
        return;
      }
      if (c && c->kind == SCR_DYN_STR) code = c->v.str;
      if (d && d->kind == SCR_DYN_STR) detail = d->v.str;
      i = argc; /* options form: no third argument (Node ignores it) */
    } else {
      scr_warn_bad_arg("type", "string");
      return;
    }
  } else if (i < argc) {
    i++; /* explicit undefined type: default */
  }
  if (i < argc && items[i]->kind != SCR_DYN_UNDEF) {
    ScrDyn *a = items[i];
    if (a->kind == SCR_DYN_STR) code = a->v.str;
    else if (a->kind != SCR_DYN_FUNC) {
      scr_warn_bad_arg("code", "string");
      return;
    }
  }
  ScrError *e = scr_error_new(SCR_ERR_ERROR, (ScrStr *)warning->v.str);
  scr_str_release(e->name);
  e->name = type ? scr_str_retain((ScrStr *)type) : scr_str_new("Warning", 7);
  e->name_present = true;
  if (code) e->code = scr_str_retain((ScrStr *)code);
  ScrDyn *w = scr_dyn_from_error(e);
  scr_error_release(e);
  if (detail) {
    scr_dyn_obj_set(w, "detail", 6, scr_dyn_new_str((ScrStr *)detail)); /* retains */
  }
  scr_warning_emit_deferred(w);
  scr_dyn_release(w);
}



/* A caught-exception snapshot as a dyn value — identity-preserving for
 * dyn payloads (a dyn-thrown value is retained, not copied), the
 * identity-cached %error encoding above for Error-family objects,
 * scalars by value, the type-erased empty object for the rest
 * (SEMANTICS.md 67). Shared by the dc trace choreography, the checked-dynamic tree
 * promise reactions, and the unhandled-rejection dispatch. Borrows the
 * box; result +1. */

/* Await a dyn-CROSSING promise (SCR_DYN_PROMISE's boundary contract —
 * dyn or void fulfillment): the payload as a dyn value (+1; a void
 * fulfillment answers the undefined value, and the defensive scalar arms
 * cover payload kinds a direct box could theoretically carry), or NULL
 * with the rejection re-thrown into the awaiter. */
static ScrDyn *scr_dyn_promise_payload(ScrPromise *p);

ScrDyn *scr_await_dyn(ScrPromise *p) {
  if (!scr_promise_await_settled(p)) return NULL;
  return scr_dyn_promise_payload(p);
}

/* A fulfilled dyn-crossing promise's payload as a dyn value (+1). */
static ScrDyn *scr_dyn_promise_payload(ScrPromise *p) {
  switch (scr_promise_payload_kind(p)) {
  case SCR_EXC_F64: return scr_dyn_new_num(scr_promise_payload_num(p));
  case SCR_EXC_BOOL: return scr_dyn_new_bool(scr_promise_payload_flag(p));
  case SCR_EXC_STR: {
    ScrStr *v = scr_promise_payload_str(p);
    ScrDyn *d = scr_dyn_new_str(v); /* retains */
    scr_str_release(v);
    return d;
  }
  case SCR_EXC_REF: {
    void *v = scr_promise_payload_ref(p);
    if (v) return (ScrDyn *)v; /* the dyn contract: a retained dyn */
    return scr_dyn_retain(scr_dyn_undefined());
  }
  default:
    return scr_dyn_retain(scr_dyn_undefined());
  }
}

/* The rejection reason as a dyn value — the scr_caught_to_dyn stances
 * over a promise's payload slot (identity-preserving for dyn-thrown
 * values and %Error instances). */
ScrDyn *scr_promise_reason_dyn(const ScrPromise *p) {
  switch (scr_promise_payload_kind(p)) {
  case SCR_EXC_F64: return scr_dyn_new_num(scr_promise_payload_num(p));
  case SCR_EXC_BOOL: return scr_dyn_new_bool(scr_promise_payload_flag(p));
  case SCR_EXC_STR: {
    ScrStr *v = scr_promise_payload_str((ScrPromise *)p);
    ScrDyn *d = scr_dyn_new_str(v); /* retains */
    scr_str_release(v);
    return d;
  }
  case SCR_EXC_REF:
  case SCR_EXC_PRIMITIVE_REF: {
    void *v = scr_promise_payload_ref((ScrPromise *)p);
    if (v == NULL) return scr_dyn_new_obj();
    if (scr_promise_payload_is_dyn(p)) return (ScrDyn *)v; /* retained */
    ScrDyn *d = scr_dyn_new_obj();
    /* release the generic +1 the accessor took */
    scr_promise_payload_release(p, v);
    return d;
  }
  case SCR_EXC_OBJ: {
    void *v = scr_promise_payload_ref((ScrPromise *)p);
    if (v != NULL && scr_error_is(v)) {
      ScrDyn *d = scr_dyn_from_error((const ScrError *)v);
      scr_promise_payload_release(p, v);
      return d;
    }
    if (v != NULL) scr_promise_payload_release(p, v);
    return scr_dyn_new_obj();
  }
  default:
    return scr_dyn_retain(scr_dyn_undefined());
  }
}

/* ── promises in the checked-dynamic tree (SCR_DYN_PROMISE) ────────────────────────────
 * Reference boxes over the fiber machinery's ScrPromise (scr_runtime.h's
 * design note). The boundary contract — a boxed promise settles with a
 * dyn payload — is the CALLERS' to keep: the compiler's converters box
 * promise<dyn> directly and every other inner type through the adapting
 * constructor below. */

SCR_TL extern bool (*scr_dyn_promise_identity_fn)(ScrPromise *, ScrPromise *);

ScrDyn *scr_dyn_new_promise(ScrPromise *p) {
  scr_dyn_promise_identity_fn = scr_promise_identity_equal;
  ScrDyn *d = scr_dyn_alloc_promise(scr_promise_release);
  d->v.promise = scr_promise_retain(p);
  return d;
}

/* The typed-inner box: a fresh destination promise parked on `src`
 * through the Promise.race cb-waiter machinery — `adapt` (emitted,
 * per-inner-type) converts the fulfillment payload into a dyn value and
 * fulfills the destination; rejections copy raw inside the machinery and
 * count as HANDLED on src (the box is the tracked promise, like a JS
 * .then chain). Already-settled sources adapt inline. Borrows src; +1. */
ScrDyn *scr_dyn_new_promise_adapting(ScrPromise *src,
                                     void (*adapt)(ScrPromise *dst, ScrPromise *src)) {
  ScrPromise *dst = scr_promise_new();
  scr_promise_share_identity(dst, src);
  scr_dyn_promise_identity_fn = scr_promise_identity_equal;
  scr_promise_race_add(dst, src, adapt);
  ScrDyn *d = scr_dyn_alloc_promise(scr_promise_release);
  d->v.promise = dst; /* the constructor's +1 moves in */
  return d;
}

ScrPromise *scr_dyn_promise_of(const ScrDyn *d) {
  return d->kind == SCR_DYN_PROMISE ? d->v.promise : NULL;
}

static void scr_dyn_all_result(ScrPromise *destination, ScrPromise *source) {
  ScrArr *values = scr_promise_payload_ref(source);
  ScrDyn *result = scr_dyn_new_arr();
  for (size_t i = 0; i < values->len; i++) scr_dyn_arr_push(result, scr_arr_get_ref(values, (double)i));
  scr_arr_release(values);
  scr_promise_fulfill_ref(destination, result, scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
}

static const ScrArrOps scr_dyn_arr_ops = { scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v };

/* ── Thenable adoption (PromiseResolve over a checked-dynamic value) ──
 * A non-promise object whose `then` is callable resolves through
 * NewPromiseResolveThenableJob: one microtask later `then` runs with the
 * thenable as `this` and a fresh resolve/reject pair, the first call of
 * which wins (a throw after it is ignored; a throw before it rejects).
 * The resolve function follows the full resolution procedure: native
 * promises adopt through scr_promise_resolve_dyn (its job then
 * reaction), further thenables queue another job, everything else
 * fulfills. */
typedef struct {
  size_t rc;
  bool called;
  ScrPromise *promise;
  ScrDyn *reader;   /* the then reader for further thenables (+1, or NULL) */
  ScrDyn *thenable; /* +1 until the job runs */
  ScrDyn *then;     /* +1 until the job runs */
} ScrDynThenState;

static void *scr_dyn_then_state_retain_v(void *p) {
  ((ScrDynThenState *)p)->rc++;
  return p;
}

static void scr_dyn_then_state_release_v(void *p) {
  ScrDynThenState *state = p;
  if (--state->rc > 0) return;
  scr_promise_release(state->promise);
  scr_dyn_release(state->reader);
  scr_dyn_release(state->thenable);
  scr_dyn_release(state->then);
  free(state);
}

static void scr_dyn_thenable_schedule(ScrPromise *target, const ScrDyn *thenable, const ScrDyn *then,
                                      const ScrDyn *reader);

/* The `then` of a resolution value: +1 when callable, NULL otherwise or
 * when the read threw (the exception stays pending). Program class
 * instances read through `reader`, the compiled property dispatch (no
 * reader: their own fields only). */
static ScrDyn *scr_dyn_then_of(const ScrDyn *value, const ScrDyn *reader) {
  if (value->kind != SCR_DYN_OBJ && value->kind != SCR_DYN_FUNC && value->kind != SCR_DYN_PROXY &&
      value->kind != SCR_DYN_TYPED_REF)
    return NULL;
  ScrDyn *then = NULL;
  if (value->kind == SCR_DYN_TYPED_REF && reader) {
    ScrDyn *arg = (ScrDyn *)value;
    then = scr_dyn_call(reader, &arg, 1, "then");
  } else if (value->kind == SCR_DYN_PROXY) {
    ScrStr *key = scr_str_new("then", 4);
    then = scr_dyn_proxy_get(value, key);
    scr_str_release(key);
  } else if (value->kind == SCR_DYN_FUNC) {
    then = scr_dyn_fn_get(value, "then", 4);
  } else if (value->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *view = scr_dyn_typed_ref_materialize(value);
    if (view) then = scr_dyn_obj_read(view, "then", 4);
    scr_dyn_release(view);
  } else {
    then = scr_dyn_obj_read(value, "then", 4);
  }
  if (then && then->kind == SCR_DYN_FUNC) return then;
  scr_dyn_release(then);
  return NULL;
}

/* Resolves `target` with `value` (borrowed). */
static void scr_dyn_resolve_value(ScrPromise *target, ScrDyn *value, const ScrDyn *reader) {
  if (value->kind == SCR_DYN_PROMISE) {
    scr_promise_resolve_dyn(target, scr_dyn_retain(value));
    return;
  }
  ScrDyn *then = scr_dyn_then_of(value, reader);
  if (scr_exc_pending()) {
    scr_promise_reject_pending(target);
  } else if (then) {
    scr_dyn_thenable_schedule(target, value, then, reader);
  } else {
    scr_promise_fulfill_ref(target, scr_dyn_retain(value), scr_dyn_retain_v, scr_dyn_release_v,
                            scr_dyn_trace_v);
  }
  scr_dyn_release(then);
}

/* The job and both resolving functions share one box holding the state;
 * box reads (scr_box_get_ref) answer +1 references. */
static ScrDyn *scr_dyn_then_resolve_call(ScrClosure *cb, ScrDyn *const *args, size_t argc) {
  ScrDynThenState *state = scr_box_get_ref(cb->caps[0]);
  if (!state->called) {
    state->called = true;
    scr_dyn_resolve_value(state->promise, argc ? args[0] : scr_dyn_undefined(), state->reader);
  }
  scr_dyn_then_state_release_v(state);
  return scr_dyn_retain(scr_dyn_undefined());
}

static ScrDyn *scr_dyn_then_reject_call(ScrClosure *cb, ScrDyn *const *args, size_t argc) {
  ScrDynThenState *state = scr_box_get_ref(cb->caps[0]);
  if (!state->called) {
    state->called = true;
    scr_dyn_throw(scr_dyn_retain(argc ? args[0] : scr_dyn_undefined()));
    scr_promise_reject_pending(state->promise);
  }
  scr_dyn_then_state_release_v(state);
  return scr_dyn_retain(scr_dyn_undefined());
}

static ScrDyn *scr_dyn_then_function(ScrBox *box, ScrDynThunk thunk) {
  ScrClosure *closure = scr_closure_new((void *)thunk, 1);
  closure->caps[0] = scr_box_retain(box);
  return scr_dyn_new_func(closure, thunk, 1, "(value)", "");
}

static void scr_dyn_thenable_job(ScrClosure *job) {
  ScrDynThenState *state = scr_box_get_ref(job->caps[0]);
  ScrDyn *thenable = state->thenable;
  ScrDyn *then = state->then;
  state->thenable = state->then = NULL; /* the references move here */
  ScrDyn *args[2] = {
    scr_dyn_then_function(job->caps[0], scr_dyn_then_resolve_call),
    scr_dyn_then_function(job->caps[0], scr_dyn_then_reject_call),
  };
  scr_dyn_this_push_dyn(thenable);
  ScrDyn *result = scr_dyn_call(then, args, 2, "then");
  scr_dyn_this_pop();
  if (result) {
    scr_dyn_release(result);
  } else if (!state->called) {
    state->called = true;
    scr_promise_reject_pending(state->promise);
  } else {
    scr_exc_clear();
  }
  scr_dyn_release(args[0]);
  scr_dyn_release(args[1]);
  scr_dyn_release(then);
  scr_dyn_release(thenable);
  scr_dyn_then_state_release_v(state);
}

static void scr_dyn_thenable_schedule(ScrPromise *target, const ScrDyn *thenable, const ScrDyn *then,
                                      const ScrDyn *reader) {
  ScrDynThenState *state = malloc(sizeof *state);
  if (!state) scr_ad_oom();
  state->rc = 1;
  state->called = false;
  state->promise = scr_promise_retain(target);
  state->reader = reader ? scr_dyn_retain((ScrDyn *)reader) : NULL;
  state->thenable = scr_dyn_retain((ScrDyn *)thenable);
  state->then = scr_dyn_retain((ScrDyn *)then);
  ScrClosure *job = scr_closure_new((void *)&scr_dyn_thenable_job, 1);
  job->caps[0] = scr_box_new_obj(scr_dyn_then_state_retain_v, scr_dyn_then_state_release_v, NULL);
  scr_box_set_ref(job->caps[0], state); /* the creation reference moves in */
  scr_queue_microtask(job);
}

/* ── Promise.all / allSettled / any over checked-dynamic entries ──────
 * Each element goes through PromiseResolve: a native promise is itself,
 * a thenable gets a fresh promise and its resolve job, anything else a
 * fulfilled promise (a throwing `then` read rejects it). The element
 * joins the combinator right after, so a thenable's job sits between
 * the jobs of the entries around it, exactly Node's iteration. */
static ScrPromise *scr_dyn_promise_entry(ScrCombine *c, ScrDyn *value, const ScrDyn *reader) {
  if (value->kind == SCR_DYN_PROMISE) return scr_promise_retain(value->v.promise);
  ScrPromise *source = scr_promise_new();
  ScrDyn *then = scr_dyn_then_of(value, reader);
  if (scr_exc_pending()) {
    scr_promise_reject_pending(source);
  } else if (then) {
    scr_promise_combine_flush(c);
    scr_dyn_thenable_schedule(source, value, then, reader);
  } else {
    scr_promise_fulfill_ref(source, scr_dyn_retain(value), scr_dyn_retain_v, scr_dyn_release_v,
                            scr_dyn_trace_v);
  }
  scr_dyn_release(then);
  return source;
}

static void scr_dyn_settled_store(ScrArr *a, double i, ScrPromise *src) {
  ScrDyn *record = scr_dyn_new_obj();
  bool fulfilled = !scr_promise_is_rejected(src);
  ScrStr *status = fulfilled ? scr_str_new("fulfilled", 9) : scr_str_new("rejected", 8);
  scr_dyn_obj_set(record, "status", 6, scr_dyn_new_str(status));
  scr_str_release(status);
  if (fulfilled) scr_dyn_obj_set(record, "value", 5, scr_dyn_promise_payload(src));
  else scr_dyn_obj_set(record, "reason", 6, scr_promise_reason_dyn(src));
  scr_arr_set_ref(a, i, record);
}

static void scr_promise_any_store(ScrArr *a, double i, ScrPromise *src) {
  scr_arr_set_ref(a, i, scr_promise_reason_dyn(src));
}

static void scr_promise_any_fail(ScrPromise *result, ScrArr *errors) {
  static const char message[] = "All promises were rejected";
  ScrStr *text = scr_str_new(message, sizeof message - 1);
  ScrDyn *m = scr_dyn_new_str(text);
  scr_str_release(text);
  ScrError *e = scr_aggregate_new(m, scr_dyn_undefined());
  scr_dyn_release(m);
  ScrDyn *list = scr_dyn_new_arr();
  for (size_t i = 0; i < errors->len; i++) scr_dyn_arr_push(list, scr_arr_get_ref(errors, (double)i));
  scr_aggregate_set_errors(e, list);
  scr_dyn_release(list);
  scr_throw_obj(e, &scr_error_retain_v, &scr_error_release_v, scr_error_trace_arg());
  scr_promise_reject_pending(result);
}

ScrPromise *scr_promise_any_typed(ScrArr *ps) {
  ScrArr *errors = scr_arr_new_ops(&scr_dyn_arr_ops, ps->len);
  ScrPromise *result = scr_promise_any(ps, errors, scr_promise_any_store, scr_promise_any_fail);
  scr_arr_release(errors);
  return result;
}

static ScrPromise *scr_dyn_promise_combine(const ScrDyn *entries, const ScrDyn *reader, int mode) {
  size_t n = entries->v.arr.len;
  ScrArr *values = scr_arr_new_ops(&scr_dyn_arr_ops, n);
  ScrAllStore store = mode == SCR_COMBINE_ALL           ? scr_promise_all_store_ref
                      : mode == SCR_COMBINE_ALL_SETTLED ? scr_dyn_settled_store
                                                        : scr_promise_any_store;
  ScrCombine c;
  scr_promise_combine_begin(&c, mode, n, values, store,
                            mode == SCR_COMBINE_ANY ? scr_promise_any_fail : NULL);
  for (size_t i = 0; i < n; i++) {
    ScrPromise *source = scr_dyn_promise_entry(&c, entries->v.arr.items[i], reader);
    scr_promise_combine_add(&c, source);
    scr_promise_release(source);
  }
  ScrPromise *combined = scr_promise_combine_end(&c);
  scr_arr_release(values);
  /* any settles with an entry's own dyn value or the AggregateError. */
  if (mode == SCR_COMBINE_ANY) return combined;
  ScrPromise *result = scr_promise_new();
  scr_promise_race_add(result, combined, scr_dyn_all_result);
  scr_promise_release(combined);
  return result;
}

ScrPromise *scr_dyn_promise_all(const ScrDyn *entries, const ScrDyn *reader) {
  return scr_dyn_promise_combine(entries, reader, SCR_COMBINE_ALL);
}

ScrPromise *scr_dyn_promise_all_settled(const ScrDyn *entries, const ScrDyn *reader) {
  return scr_dyn_promise_combine(entries, reader, SCR_COMBINE_ALL_SETTLED);
}

ScrPromise *scr_dyn_promise_any(const ScrDyn *entries, const ScrDyn *reader) {
  return scr_dyn_promise_combine(entries, reader, SCR_COMBINE_ANY);
}

/* The checked native WebCrypto digest entry keeps promise and ArrayBuffer results native. */
static ScrDyn *scr_crypto_digest_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure;
  ScrPromise *promise = scr_promise_new();
  ScrDyn *algorithm = argc ? args[0] : scr_dyn_undefined();
  ScrDyn *name = algorithm->kind == SCR_DYN_OBJ ? scr_dyn_obj_read(algorithm, "name", 4) : scr_dyn_retain(algorithm);
  ScrStr *text = name ? scr_dyn_string_coerce_js(name) : NULL;
  scr_dyn_release(name);
  ScrBytes *bytes = argc > 1 && args[1]->kind == SCR_DYN_BYTES ? scr_dyn_bytes_unbox(args[1]) : NULL;
  if (!bytes && argc > 1 && scr_array_buffer_is(args[1])) bytes = scr_array_buffer_view(SCR_BYTES_U8, args[1], scr_dyn_undefined(), scr_dyn_undefined());
  const char *native = NULL;
  if (text) {
    if (text->len == 7 && strncasecmp(text->data, "SHA-256", 7) == 0) native = "sha256";
    else if (text->len == 5 && strncasecmp(text->data, "SHA-1", 5) == 0) native = "sha1";
  }
  if (!text || !bytes || !native) {
    static const char message[] = "Unsupported WebCrypto digest algorithm or BufferSource";
    if (!scr_exc_pending()) scr_throw_error_msg_code(SCR_ERR_TYPE, message, sizeof message - 1, "SC2020");
    scr_promise_reject_pending(promise);
  } else {
    ScrStr *alg = scr_str_new(native, strlen(native));
    ScrCryptoHash *hash = scr_crypto_hash_new(alg);
    scr_str_release(alg);
    if (hash) {
      scr_crypto_hash_update_bytes(hash, bytes);
      ScrBytes *digest = scr_exc_pending() ? NULL : scr_crypto_hash_digest_buffer(hash);
      scr_crypto_hash_release(hash);
      if (digest) {
        ScrDyn *buffer = scr_array_buffer_from_bytes(digest); scr_bytes_release(digest);
        scr_promise_resolve_dyn(promise, buffer);
      } else scr_promise_reject_pending(promise);
    } else scr_promise_reject_pending(promise);
  }
  scr_str_release(text); scr_bytes_release(bytes);
  ScrDyn *result = scr_dyn_new_promise(promise); scr_promise_release(promise); return result;
}
ScrDyn *scr_crypto_native(void) {
  ScrDyn *subtle = scr_dyn_new_obj();
  scr_dyn_obj_set(subtle, "digest", 6, scr_dyn_new_func(scr_closure_new(NULL, 0), scr_crypto_digest_call, 2, "crypto.subtle.digest", "digest"));
  ScrDyn *result = scr_dyn_new_obj(); scr_dyn_obj_set(result, "subtle", 6, subtle); return result;
}

/* ── promise method values (`d.then` read as a VALUE) ─────────────────────
 * JS answers `Promise.prototype.then/catch/finally` for a `then`-keyed
 * read on any promise: one shared function object per method, shared by
 * every instance. The checked-dynamic key read over a promise box used to
 * fall through to undefined, so a promise held in `any`/`unknown` storage
 * answered `p.then === undefined` where Node answers a function. Each
 * method name mints ONE immortal FUNC-kind box per process (identity
 * matches JS's shared prototype method), and a call through the value
 * dispatches through the promise reaction machinery with the ambient
 * receiver (`this`) as the source promise — JS binds the promise the
 * prototype method was read off. */
static ScrDyn *scr_promise_then_method_call(ScrClosure *clo, ScrDyn *const *args, size_t argc);
static ScrDyn *scr_promise_catch_method_call(ScrClosure *clo, ScrDyn *const *args, size_t argc);
static ScrDyn *scr_promise_finally_method_call(ScrClosure *clo, ScrDyn *const *args, size_t argc);

static ScrDyn *scr_promise_method_value(ScrDynThunk thunk, const char *sig, const char *name) {
  static ScrDyn *values[3];
  const size_t slot =
    thunk == scr_promise_then_method_call ? 0 : thunk == scr_promise_catch_method_call ? 1 : 2;
  if (!values[slot]) {
    ScrClosure *closure = scr_closure_new((void *)thunk, 0);
    values[slot] = scr_dyn_new_func(closure, thunk, 1, sig, name);
  }
  return scr_dyn_retain(values[slot]);
}

static ScrDyn *scr_promise_method_call(size_t slot, ScrDyn *const *args, size_t argc) {
  static const char *const names[3] = { "then", "catch", "finally" };
  ScrDyn *self = scr_dyn_this_get();
  if (!self || self->kind != SCR_DYN_PROMISE) {
    /* Node's exact call failure for an unbound prototype method read. */
    if (!scr_exc_pending()) {
      static const char head[] = "Method Promise.prototype.";
      static const char tail[] = " called on incompatible receiver ";
      const char *name = names[slot];
      const char *recv;
      size_t recv_len;
      if (!self || self->kind == SCR_DYN_UNDEF) {
        recv = "undefined";
        recv_len = 9;
      } else if (self->kind == SCR_DYN_NULL) {
        recv = "null";
        recv_len = 4;
      } else {
        recv = "[object Object]";
        recv_len = 15;
      }
      ScrStr *msg = scr_str_concat(
        scr_str_concat(scr_str_new(head, sizeof head - 1), scr_str_new(name, strlen(name))),
        scr_str_concat(scr_str_new(tail, sizeof tail - 1), scr_str_new(recv, recv_len)));
      scr_throw_error_msg_code(SCR_ERR_TYPE, msg->data, msg->len, "SC2020");
      scr_str_release(msg);
    }
    return NULL;
  }
  ScrDyn *onf = slot == 0 && argc >= 1 ? args[0] : NULL;
  ScrDyn *onr = slot == 0 ? (argc >= 2 ? args[1] : NULL) : slot == 1 && argc >= 1 ? args[0] : NULL;
  ScrDyn *onfin = slot == 2 && argc >= 1 ? args[0] : NULL;
  return scr_dyn_promise_then(self->v.promise, onf, onr, onfin);
}

static ScrDyn *scr_promise_then_method_call(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  (void)clo;
  return scr_promise_method_call(0, args, argc);
}

static ScrDyn *scr_promise_catch_method_call(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  (void)clo;
  return scr_promise_method_call(1, args, argc);
}

static ScrDyn *scr_promise_finally_method_call(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  (void)clo;
  return scr_promise_method_call(2, args, argc);
}

ScrDyn *scr_dyn_promise_method_value(const char *name, size_t length) {
  if (length == 4 && memcmp(name, "then", 4) == 0)
    return scr_promise_method_value(scr_promise_then_method_call, "(onfulfilled?, onrejected?)", "then");
  if (length == 5 && memcmp(name, "catch", 5) == 0)
    return scr_promise_method_value(scr_promise_catch_method_call, "(onrejected?)", "catch");
  if (length == 7 && memcmp(name, "finally", 7) == 0)
    return scr_promise_method_value(scr_promise_finally_method_call, "(onfinally?)", "finally");
  return NULL;
}

