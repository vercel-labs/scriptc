/* Checked-dynamic ASYNC surfaces (gated — cc.ts links this TU only when
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

static double scr_als_counter = 0;

/* Main-slot teardown (atexit, LIFO after scr_init's audit registration —
 * the dc-registry precedent): a top-level enterWith leaves a context in
 * the main slot at exit; release it before the RC audit counts. */
static void scr_als_teardown(void) {
  /* atexit runs on the main context — the active slot IS main's. */
  scr_als_ctx_release(*scr_als_active);
  *scr_als_active = NULL;
}

double scr_als_new(void) {
  static bool teardown_registered = false;
  if (!teardown_registered) {
    teardown_registered = true;
    atexit(scr_als_teardown);
  }
  return ++scr_als_counter;
}

ScrDyn *scr_als_get(double id) {
  const ScrAlsCtx *c = *scr_als_active;
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
  ScrAlsCtx *prev = *scr_als_active;
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
  *scr_als_active = next;
  return prev; /* ownership moves to the caller */
}

/* The exit() arm: the id REMOVED from the snapshot. */
ScrAlsCtx *scr_als_enter_absent(double id) {
  ScrAlsCtx *prev = *scr_als_active;
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
  *scr_als_active = next;
  return prev;
}

void scr_als_restore(ScrAlsCtx *prev) {
  scr_als_ctx_release(*scr_als_active);
  *scr_als_active = prev; /* ownership moves back in */
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
  ScrDyn *fn;
  bool once;
} ScrRejListener;

static ScrRejListener *scr_urj_listeners = NULL;
static size_t scr_nurj = 0, scr_urj_cap = 0;
static ScrRejListener *scr_rjh_listeners = NULL;
static size_t scr_nrjh = 0, scr_rjh_cap = 0;

static void scr_urj_teardown(void) {
  for (size_t i = 0; i < scr_nurj; i++) scr_dyn_release(scr_urj_listeners[i].fn);
  free(scr_urj_listeners);
  scr_urj_listeners = NULL;
  scr_nurj = scr_urj_cap = 0;
}

static void scr_rjh_teardown(void) {
  for (size_t i = 0; i < scr_nrjh; i++) scr_dyn_release(scr_rjh_listeners[i].fn);
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
  (*list)[(*n)++] = (ScrRejListener){scr_dyn_retain(fn), once};
}

static void scr_rej_remove(ScrRejListener *list, size_t *n, ScrDyn *fn) {
  for (size_t i = 0; i < *n; i++) {
    ScrDyn *l = list[i].fn;
    bool same = l == fn || (l->kind == SCR_DYN_FUNC && fn->kind == SCR_DYN_FUNC &&
                            l->v.fn.clo == fn->v.fn.clo);
    if (same) {
      scr_dyn_release(l);
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
  static bool teardown_armed = false;
  if (!teardown_armed) {
    teardown_armed = true;
    atexit(scr_urj_teardown);
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
  static bool teardown_armed = false;
  if (!teardown_armed) {
    teardown_armed = true;
    atexit(scr_rjh_teardown);
  }
  scr_rej_push(&scr_rjh_listeners, &scr_nrjh, &scr_rjh_cap, fn, once);
  scr_rjh_sync_hook();
}

void scr_process_off_rejection_handled(ScrDyn *fn) {
  scr_rej_remove(scr_rjh_listeners, &scr_nrjh, fn);
  scr_rjh_sync_hook();
}

/* One registry pass: call every listener with `args`, removing once-
 * listeners BEFORE their call (Node's once removes at dispatch, so a
 * re-registration inside the listener sticks). The registry is accessed
 * THROUGH its pointers per step — a listener that registers can realloc
 * the array mid-pass. Returns false when a listener threw (the caller's
 * crash path). */
static bool scr_rej_fire(ScrRejListener **list, size_t *n, ScrDyn **args, size_t argc) {
  size_t i = 0;
  bool ok = true;
  while (i < *n && ok) {
    /* Own +1 across the call: a once-removal (here) or the listener
     * removing itself (off inside the body) must not free a running
     * function. */
    ScrDyn *fn = scr_dyn_retain((*list)[i].fn);
    if ((*list)[i].once) {
      scr_dyn_release((*list)[i].fn);
      memmove(*list + i, *list + i + 1, (*n - i - 1) * sizeof **list);
      (*n)--;
    } else {
      i++;
    }
    ScrDyn *r = scr_dyn_call(fn, args, argc, "listener");
    if (r == NULL) ok = false;
    else scr_dyn_release(r);
    scr_dyn_release(fn);
  }
  return ok;
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

static void scr_dyn_then_entry(ScrFiber *self, void *ap) {
  (void)self;
  ScrDynThenPack *a = (ScrDynThenPack *)ap;
  ScrDyn *v = scr_await_dyn(a->src);
  bool rejected = scr_exc_pending();
  ScrCaught *c = rejected ? scr_exc_take() : NULL;
  ScrDyn *handler = a->onfin ? a->onfin : (rejected ? a->onr : a->onf);
  if (handler != NULL && handler->kind == SCR_DYN_FUNC) {
    ScrDyn *arg = NULL;
    if (a->onfin == NULL) arg = rejected ? scr_caught_to_dyn(c) : scr_dyn_retain(v);
    ScrDyn *r = scr_dyn_call(handler, arg ? &arg : NULL, arg ? 1 : 0, "handler");
    scr_dyn_release(arg);
    if (r == NULL) {
      /* The handler threw: dst rejects with that. */
      scr_promise_reject_pending(a->dst);
    } else if (a->onfin != NULL) {
      /* finally: the callback's value is dropped and the source
       * settlement passes through (JS — a finally callback returning a
       * promise would delay adoption; that refinement waits for a use). */
      scr_dyn_release(r);
      if (rejected) {
        scr_rethrow(c);
        scr_promise_reject_pending(a->dst);
      } else {
        scr_promise_fulfill_ref(a->dst, scr_dyn_retain(v), scr_dyn_retain_v, scr_dyn_release_v, NULL);
      }
    } else {
      /* Adopt dyn-promise results (JS's resolve walk). */
      while (r != NULL && r->kind == SCR_DYN_PROMISE) {
        ScrDyn *inner = scr_await_dyn(r->v.promise);
        scr_dyn_release(r);
        r = inner;
        if (scr_exc_pending()) {
          scr_promise_reject_pending(a->dst);
          break;
        }
      }
      if (r != NULL) {
        scr_promise_fulfill_ref(a->dst, r, scr_dyn_retain_v, scr_dyn_release_v, NULL);
      }
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
   * 'rejectionHandled' when no fiber turn remains. */
  if (onr != NULL) scr_promise_mark_handled(src);
  ScrDynThenPack *a = malloc(sizeof *a);
  if (!a) scr_ad_oom();
  a->src = scr_promise_retain(src);
  a->dst = scr_promise_new();
  a->onf = onf ? scr_dyn_retain(onf) : NULL;
  a->onr = onr ? scr_dyn_retain(onr) : NULL;
  a->onfin = onfin ? scr_dyn_retain(onfin) : NULL;
  ScrDyn *boxed = scr_dyn_new_promise(a->dst);
  ScrPromise *waiter = scr_async_spawn(scr_dyn_then_entry, a);
  scr_promise_release(waiter); /* the entry never rejects; nobody awaits it */
  return boxed;
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

/* ── process warnings (emitWarning + the 'warning' event) ─────────────
 * Gated with the rest of this TU (a deprecation-emitting unit's gate
 * must imply the dynAsync link). Listeners are dyn functions; emission
 * queues a process.nextTick entry, so the synchronous caller returns
 * before the default report and event — Node's ordering. The default
 * stderr report runs before user listeners because Node installs its own
 * warning listener during bootstrap. The warning VALUE is the dyn error
 * encoding built over an ScrError (identity-cached, so a listener
 * comparing two deliveries of one warning sees one object); a string
 * `detail` joins the dyn node and the report's second line, exactly Node. */
static ScrDyn **scr_warn_listeners = NULL;
static size_t scr_nwarn = 0, scr_warn_cap = 0;

typedef struct ScrPendingWarning {
  ScrDyn *value; /* owned */
  struct ScrPendingWarning *next;
} ScrPendingWarning;

static ScrPendingWarning *scr_warn_head = NULL;
static ScrPendingWarning *scr_warn_tail = NULL;
static ScrPendingWarning *scr_deferred_warn_head = NULL;
static ScrPendingWarning *scr_deferred_warn_tail = NULL;
static size_t scr_deferred_warn_scheduled = 0;
static bool scr_warn_cleanup_registered = false;

static void scr_warn_queue_teardown(ScrPendingWarning **head,
                                    ScrPendingWarning **tail) {
  while (*head) {
    ScrPendingWarning *pending = *head;
    *head = pending->next;
    scr_dyn_release(pending->value);
    free(pending);
  }
  *tail = NULL;
}

static void scr_warn_teardown(void) {
  for (size_t i = 0; i < scr_nwarn; i++) scr_dyn_release(scr_warn_listeners[i]);
  free(scr_warn_listeners);
  scr_warn_listeners = NULL;
  scr_nwarn = scr_warn_cap = 0;
  scr_warn_queue_teardown(&scr_warn_head, &scr_warn_tail);
  scr_warn_queue_teardown(&scr_deferred_warn_head, &scr_deferred_warn_tail);
  scr_deferred_warn_scheduled = 0;
}

static void scr_warn_ensure_cleanup(void) {
  if (!scr_warn_cleanup_registered) {
    scr_warn_cleanup_registered = true;
    atexit(scr_warn_teardown);
  }
}

void scr_process_on_warning(ScrDyn *fn) {
  if (fn->kind != SCR_DYN_FUNC) {
    const char *msg = "The \"listener\" argument must be of type function";
    scr_throw_error_msg_code(SCR_ERR_TYPE, msg, strlen(msg), "ERR_INVALID_ARG_TYPE");
    return;
  }
  if (scr_nwarn == scr_warn_cap) {
    scr_warn_cap = scr_warn_cap ? scr_warn_cap * 2 : 4;
    scr_warn_listeners = realloc(scr_warn_listeners, scr_warn_cap * sizeof *scr_warn_listeners);
    if (!scr_warn_listeners) {
      fputs("scriptc: out of memory\n", stderr);
      abort();
    }
  }
  scr_warn_ensure_cleanup();
  scr_warn_listeners[scr_nwarn++] = scr_dyn_retain(fn);
}

void scr_process_off_warning(ScrDyn *fn) {
  for (size_t i = 0; i < scr_nwarn; i++) {
    ScrDyn *l = scr_warn_listeners[i];
    bool same = l == fn || (l->kind == SCR_DYN_FUNC && fn->kind == SCR_DYN_FUNC &&
                            l->v.fn.clo == fn->v.fn.clo);
    if (same) {
      scr_dyn_release(l);
      memmove(scr_warn_listeners + i, scr_warn_listeners + i + 1,
              (scr_nwarn - i - 1) * sizeof *scr_warn_listeners);
      scr_nwarn--;
      return;
    }
  }
}

/* Dispatch + the default stderr report over a built warning dyn node.
 * Borrowed. A listener throw propagates from the queued tick. */
static void scr_warning_dispatch(ScrDyn *w) {
  /* "(node:pid) [CODE] Name: message" + "\n<detail>" — Node's
   * bootstrap onWarning report. It is registered before user listeners,
   * so it prints first. */
  const ScrDyn *en = scr_dyn_obj_get(w, "name", 4);
  const ScrDyn *em = scr_dyn_obj_get(w, "message", 7);
  const ScrDyn *ec = scr_dyn_obj_get(w, "code", 4);
  const ScrDyn *ed = scr_dyn_obj_get(w, "detail", 6);
  fflush(stdout);
  fprintf(stderr, "(node:%ld) ", SCR_WARN_PID());
  if (ec && ec->kind == SCR_DYN_STR) fprintf(stderr, "[%s] ", ec->v.str->data);
  fprintf(stderr, "%s: %s",
          (en && en->kind == SCR_DYN_STR) ? en->v.str->data : "Warning",
          (em && em->kind == SCR_DYN_STR) ? em->v.str->data : "");
  if (ed && ed->kind == SCR_DYN_STR) fprintf(stderr, "\n%s", ed->v.str->data);
  fputc('\n', stderr);
  /* Node's one-time trace hint, after the first report. */
  static bool hinted = false;
  if (!hinted) {
    hinted = true;
    fputs("(Use `node --trace-warnings ...` to show where the warning was created)\n", stderr);
  }
  for (size_t i = 0; i < scr_nwarn; i++) {
    ScrDyn *r = scr_dyn_call(scr_warn_listeners[i], &w, 1, "listener");
    if (r == NULL) return; /* pending exception propagates */
    scr_dyn_release(r);
  }
}

/* One raw nextTick marker delivers one queued warning. Keeping markers
 * one-for-one preserves FIFO interleaving with user process.nextTick
 * callbacks registered around emitWarning calls. */
static void scr_warning_deliver_one(void) {
  ScrPendingWarning *pending = scr_warn_head;
  if (!pending) return;
  scr_warn_head = pending->next;
  if (!scr_warn_head) scr_warn_tail = NULL;
  ScrDyn *value = pending->value;
  free(pending);
  scr_warning_dispatch(value);
  scr_dyn_release(value);
}

static void scr_warning_append(ScrPendingWarning **head,
                               ScrPendingWarning **tail,
                               ScrDyn *w /* borrowed */) {
  ScrPendingWarning *pending = calloc(1, sizeof *pending);
  if (!pending) {
    fputs("scriptc: out of memory\n", stderr);
    abort();
  }
  scr_warn_ensure_cleanup();
  pending->value = scr_dyn_retain(w);
  if (*tail) (*tail)->next = pending;
  else *head = pending;
  *tail = pending;
}

static void scr_warning_enqueue(ScrDyn *w /* borrowed */) {
  scr_warning_append(&scr_warn_head, &scr_warn_tail, w);
  scr_next_tick_raw(scr_warning_deliver_one);
}

/* Typeless-package warnings originate inside the embedded ESM loader.
 * Keep them dormant until the island boundary says module evaluation has
 * reached its observable completion point. A static import flushes after
 * evaluation; an import() flushes after engine promise jobs have woken
 * the compiled awaiter. The post-ready tick stage then runs them after
 * that awaiter's microtasks but before its nextTicks, matching Node's
 * loader-warning order. */
static void scr_warning_deliver_deferred_one(void) {
  ScrPendingWarning *pending = scr_deferred_warn_head;
  if (!pending) return;
  scr_deferred_warn_head = pending->next;
  if (!scr_deferred_warn_head) scr_deferred_warn_tail = NULL;
  if (scr_deferred_warn_scheduled > 0) scr_deferred_warn_scheduled--;
  ScrDyn *value = pending->value;
  free(pending);
  scr_warning_dispatch(value);
  scr_dyn_release(value);
}

void scr_flush_deferred_warnings(void) {
  size_t queued = 0;
  for (ScrPendingWarning *p = scr_deferred_warn_head; p; p = p->next) queued++;
  while (scr_deferred_warn_scheduled < queued) {
    scr_next_tick_raw_after_microtasks(scr_warning_deliver_deferred_one);
    scr_deferred_warn_scheduled++;
  }
}

/* A warning built from C parts (the runtime deprecation sites): name
 * defaults to "Warning"; code/detail optional. Borrows message. */
void scr_emit_warning(const char *name, const char *code, ScrStr *message) {
  ScrError *e = scr_error_new(SCR_ERR_ERROR, message);
  scr_str_release(e->name);
  e->name = scr_str_new(name ? name : "Warning", strlen(name ? name : "Warning"));
  if (code) e->code = scr_str_new(code, strlen(code));
  ScrDyn *w = scr_dyn_from_error(e);
  scr_error_release(e);
  scr_warning_enqueue(w);
  scr_dyn_release(w);
}

/* The loader-only variant: construction is identical, but dispatch waits
 * for scr_flush_deferred_warnings at the island completion boundary. */
void scr_emit_warning_deferred(const char *name, const char *code,
                               ScrStr *message) {
  ScrError *e = scr_error_new(SCR_ERR_ERROR, message);
  scr_str_release(e->name);
  e->name = scr_str_new(name ? name : "Warning",
                        strlen(name ? name : "Warning"));
  if (code) e->code = scr_str_new(code, strlen(code));
  ScrDyn *w = scr_dyn_from_error(e);
  scr_error_release(e);
  scr_warning_append(&scr_deferred_warn_head, &scr_deferred_warn_tail, w);
  scr_dyn_release(w);
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
 * ERR_INVALID_ARG_TYPE TypeErrors; non-string details are ignored. */
void scr_process_emit_warning(ScrDyn *args) {
  size_t argc = args->kind == SCR_DYN_ARR ? args->v.arr.len : 0;
  ScrDyn *const *items = args->kind == SCR_DYN_ARR ? args->v.arr.items : NULL;
  ScrDyn *warning = argc >= 1 ? items[0] : NULL;
  /* An Error-encoded warning: type/code arguments are ignored (Node). */
  if (warning != NULL && warning->kind == SCR_DYN_OBJ &&
      scr_dyn_obj_get(warning, "%error", 6) != NULL) {
    scr_warning_enqueue(warning);
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
  if (code) e->code = scr_str_retain((ScrStr *)code);
  ScrDyn *w = scr_dyn_from_error(e);
  scr_error_release(e);
  if (detail) {
    scr_dyn_obj_set(w, "detail", 6, scr_dyn_new_str((ScrStr *)detail)); /* retains */
  }
  scr_warning_enqueue(w);
  scr_dyn_release(w);
}



/* A caught-exception snapshot as a dyn value — identity-preserving for
 * dyn payloads (a dyn-thrown value is retained, not copied), the
 * identity-cached %error encoding above for Error-family objects,
 * scalars by value, the type-erased empty object for the rest
 * (SEMANTICS.md 67). Shared by the dc trace choreography, the checked-dynamic tree
 * promise reactions, and the unhandled-rejection dispatch. Borrows the
 * box; result +1. */
ScrDyn *scr_caught_to_dyn(const ScrCaught *c) {
  switch (c->kind) {
  case SCR_EXC_F64: return scr_dyn_new_num(c->f64);
  case SCR_EXC_BOOL: return scr_dyn_new_bool(c->b);
  case SCR_EXC_STR: return scr_dyn_new_str((ScrStr *)c->payload);
  case SCR_EXC_REF:
    if (c->retain_fn == scr_dyn_retain_v) return scr_dyn_retain((ScrDyn *)c->payload);
    return scr_dyn_new_obj();
  case SCR_EXC_OBJ:
    if (scr_error_is(c->payload)) return scr_dyn_from_error((const ScrError *)c->payload);
    return scr_dyn_new_obj();
  default:
    return scr_dyn_new_obj();
  }
}

/* Await a dyn-CROSSING promise (SCR_DYN_PROMISE's boundary contract —
 * dyn or void fulfillment): the payload as a dyn value (+1; a void
 * fulfillment answers the undefined value, and the defensive scalar arms
 * cover payload kinds a direct box could theoretically carry), or NULL
 * with the rejection re-thrown into the awaiter. */
ScrDyn *scr_await_dyn(ScrPromise *p) {
  if (!scr_promise_await_settled(p)) return NULL;
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
  case SCR_EXC_REF: {
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

ScrDyn *scr_dyn_new_promise(ScrPromise *p) {
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
  scr_promise_race_add(dst, src, adapt);
  ScrDyn *d = scr_dyn_alloc_promise(scr_promise_release);
  d->v.promise = dst; /* the constructor's +1 moves in */
  return d;
}

ScrPromise *scr_dyn_promise_of(const ScrDyn *d) {
  return d->kind == SCR_DYN_PROMISE ? d->v.promise : NULL;
}
