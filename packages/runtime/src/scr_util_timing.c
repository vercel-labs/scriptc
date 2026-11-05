/* node:util's debounce and throttle over the checked-dynamic tree, step
 * for step with Node's lib/internal/util/debounce.js and throttle.js.
 * Each returns a native dyn function (an ordinary function with its own
 * prototype, fn's name and length) whose own cancel/flush/ref/unref
 * members (throttle: cancel/hasImmediateCapacity/ref/unref) and
 * non-enumerable pending/pendingCount (throttle: and activeCount) getters
 * share one refcounted state. Calls answer dyn promises.
 *
 * The state is invisible to the cycle collector, so nothing it holds
 * leads back to it: fn sits in a traced box on the returned function's
 * closure (fn may refer to that function), the state reaches the function through
 * a weak pointer that the function's closure clears when it is freed; an
 * armed timer and a throttled call's settle reaction hold the function
 * and the state until they run or are cleared; and the options.signal
 * 'abort' listener holds a weak slot that the state clears when it is
 * freed. The listener stays registered, as in Node. The clock is the
 * monotonic loop clock in whole milliseconds, like libuv's uv_now. All
 * arguments are borrowed. */
#include "scr_runtime.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Node's TIMEOUT_MAX (2 ** 31 - 1) and Number.MAX_SAFE_INTEGER. */
#define UT_TIMEOUT_MAX 2147483647.0
#define UT_SAFE_MAX 9007199254740991.0

typedef struct UtState UtState;

/* The abort listener's view of a state: NULL once the state is freed. */
typedef struct {
  size_t rc;
  UtState *state;
} UtWeak;

/* The returned function's closure holds its state through this token;
 * freeing the closure frees the token, which clears the state's weak
 * pointer to the function. */
typedef struct {
  size_t rc;
  UtState *state;
} UtOwner;

/* One pending call: its promise and, for throttle, its arguments. */
typedef struct {
  ScrPromise *promise;
  ScrDyn **args;
  size_t argc;
} UtCall;

struct UtState {
  size_t rc;
  bool throttle;
  ScrClosure *self; /* the returned function's closure (weak), or NULL */
  ScrDynThunk thunk;
  ScrDyn *signal;      /* NULL without options.signal */
  UtWeak *weak;        /* the abort listener's slot, or NULL */
  ScrDyn *abort_error; /* NULL until the signal aborts */
  double timeout;      /* the armed timer's handle; 0 for none */
  bool refed;
  /* pendingCalls: the live calls are [head, len). */
  UtCall *calls;
  size_t head, len, cap;
  /* debounce */
  double wait;
  bool leading, reject_on_cancel;
  ScrDyn **args; /* the latest call's arguments */
  size_t argc;
  /* throttle */
  double limit, interval, concurrency, max_pending, active;
  bool drop, strict;
  double *ticks; /* strictTicks: the live ticks are [tick_head, tick_len) */
  size_t tick_head, tick_len, tick_cap;
  double window_count, window_start;
  bool window_open;
};

static const char UT_SIG[] = "native:util.debounce";

static void *ut_oom(void) {
  scr_trap("scriptc: out of memory\n");
}

static ScrDyn **ut_args_copy(ScrDyn *const *args, size_t argc) {
  if (argc == 0) return NULL;
  ScrDyn **copy = malloc(argc * sizeof *copy);
  if (!copy) return ut_oom();
  for (size_t i = 0; i < argc; i++) copy[i] = scr_dyn_retain(args[i]);
  return copy;
}

static void ut_args_free(ScrDyn **args, size_t argc) {
  for (size_t i = 0; i < argc; i++) scr_dyn_release(args[i]);
  free(args);
}

static void *ut_weak_retain(void *p) {
  ((UtWeak *)p)->rc++;
  return p;
}

static void ut_weak_release(void *p) {
  UtWeak *weak = p;
  if (weak && --weak->rc == 0) free(weak);
}

static void *ut_state_retain(void *p) {
  ((UtState *)p)->rc++;
  return p;
}

static void ut_state_release(void *p) {
  UtState *s = p;
  if (!s || --s->rc) return;
  if (s->weak) {
    s->weak->state = NULL;
    ut_weak_release(s->weak);
  }
  scr_dyn_release(s->signal);
  scr_dyn_release(s->abort_error);
  ut_args_free(s->args, s->argc);
  for (size_t i = s->head; i < s->len; i++) {
    scr_promise_release(s->calls[i].promise);
    ut_args_free(s->calls[i].args, s->calls[i].argc);
  }
  free(s->calls);
  free(s->ticks);
  free(s);
}

static void *ut_owner_retain(void *p) {
  ((UtOwner *)p)->rc++;
  return p;
}

static void ut_owner_release(void *p) {
  UtOwner *owner = p;
  if (--owner->rc) return;
  owner->state->self = NULL;
  ut_state_release(owner->state);
  free(owner);
}

static ScrBox *ut_state_box(UtState *s) {
  ScrBox *box = scr_box_new_obj(ut_state_retain, ut_state_release, NULL);
  scr_box_set_ref(box, ut_state_retain(s));
  return box;
}

static ScrBox *ut_dyn_box(ScrDyn *value /* moves in */) {
  ScrBox *box = scr_box_new_obj(scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
  scr_box_set_ref(box, value);
  return box;
}

/* The state behind a member, getter, timer or listener closure (+1). */
static UtState *ut_cap_state(ScrClosure *closure) {
  return scr_box_get_ref(closure->caps[0]);
}

/* The state behind the returned function's own closure (+1). */
static UtState *ut_owner_state(ScrClosure *closure) {
  UtOwner *owner = scr_box_get_ref(closure->caps[0]);
  UtState *s = ut_state_retain(owner->state);
  ut_owner_release(owner);
  return s;
}

static ScrDyn *ut_box_fn(UtState *s, ScrClosure *closure) {
  return scr_dyn_new_func(scr_closure_retain(closure), s->thunk, 0, UT_SIG, s->throttle ? "throttled" : "debounced");
}

/* The returned function (+1), or NULL once nothing else holds it. */
static ScrDyn *ut_self(UtState *s) {
  return s->self ? ut_box_fn(s, s->self) : NULL;
}

static void ut_fence(const char *message) {
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, strlen(message), "SC2020");
}

static double ut_now(void) {
  return floor(scr_now_ms());
}

/* ── promises and errors ───────────────────────────────────────────── */

static void ut_reject(ScrPromise *p, const ScrDyn *error) {
  scr_dyn_throw(scr_dyn_retain((ScrDyn *)error));
  scr_promise_reject_pending(p);
}

static ScrDyn *ut_promise_box(ScrPromise *p /* moves in */) {
  ScrDyn *box = scr_dyn_new_promise(p);
  scr_promise_release(p);
  return box;
}

/* PromiseReject(error) (+1). */
static ScrDyn *ut_rejected(const ScrDyn *error) {
  ScrPromise *p = scr_promise_new();
  ut_reject(p, error);
  return ut_promise_box(p);
}

/* new AbortError(message, { cause }) (+1); a NULL cause defines none. */
static ScrDyn *ut_abort_error(const char *message, const ScrDyn *cause) {
  ScrStr *text = scr_str_new(message, strlen(message));
  ScrError *e = scr_error_new(SCR_ERR_ERROR, text);
  scr_str_release(text);
  scr_str_release(e->name);
  e->name = scr_str_new("AbortError", 10);
  scr_error_set_code(e, "ABORT_ERR");
  e->name_present = true;
  e->name_enumerable = true;
  if (cause) {
    /* The constructor's { cause } option: a non-enumerable own property. */
    scr_error_define_cause(e, (ScrDyn *)cause);
    e->cause_enumerable = false;
  }
  ScrDyn *error = scr_dyn_from_error(e);
  scr_error_release(e);
  return error;
}

/* cancel(reason)'s error: no cause for an undefined reason (+1). */
static ScrDyn *ut_cancel_error(ScrDyn *const *args, size_t argc) {
  const ScrDyn *reason = argc ? args[0] : scr_dyn_undefined();
  return ut_abort_error("The operation was aborted", reason->kind == SCR_DYN_UNDEF ? NULL : reason);
}

/* fn.apply(self, args): the result (+1), or NULL with fn's throw pending.
 * fn lives on the returned function's closure. */
static ScrDyn *ut_apply(const ScrDyn *self, ScrDyn *const *args, size_t argc) {
  ScrDyn *fn = scr_box_get_ref(scr_closure_identity(self->v.fn.clo)->caps[1]);
  scr_dyn_this_push_dyn(self);
  ScrDyn *result = scr_dyn_call(fn, args, argc, "fn");
  scr_dyn_this_pop();
  scr_dyn_release(fn);
  return result;
}

/* ── the signal ────────────────────────────────────────────────────── */

static bool ut_signal_aborted(const UtState *s) {
  if (!s->signal || !scr_et_signal_core_fn) return false;
  bool aborted = false;
  (void)scr_et_signal_core_fn(s->signal, &aborted);
  return aborted;
}

static void ut_cancel_with_error(UtState *s, const ScrDyn *error);

/* abort(): the first abort builds abortError from signal.reason. */
static void ut_abort(UtState *s) {
  if (!s->abort_error) {
    ScrStr *key = scr_str_new("reason", 6);
    ScrDyn *reason = scr_dyn_handle_key_get(s->signal, key);
    scr_str_release(key);
    if (!reason) return;
    s->abort_error = ut_abort_error("The operation was aborted", reason->kind == SCR_DYN_UNDEF ? NULL : reason);
    scr_dyn_release(reason);
  }
  ut_cancel_with_error(s, s->abort_error);
}

static ScrDyn *ut_abort_listener(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc;
  UtWeak *weak = scr_box_get_ref(closure->caps[0]);
  UtState *s = weak->state ? ut_state_retain(weak->state) : NULL;
  ut_weak_release(weak);
  if (s) {
    ut_abort(s);
    ut_state_release(s);
  }
  return scr_exc_pending() ? NULL : scr_dyn_retain(scr_dyn_undefined());
}

/* addAbortListener(signal, abort). */
static bool ut_listen(UtState *s) {
  UtWeak *weak = malloc(sizeof *weak);
  if (!weak) ut_oom();
  weak->rc = 1;
  weak->state = s;
  s->weak = weak;
  ScrClosure *closure = scr_closure_new(NULL, 1);
  closure->caps[0] = scr_box_new_obj(ut_weak_retain, ut_weak_release, NULL);
  scr_box_set_ref(closure->caps[0], ut_weak_retain(weak));
  ScrDyn *listener = scr_dyn_new_func(closure, ut_abort_listener, 0, UT_SIG, "abort");
  ScrDyn *disposable = scr_events_add_abort_listener(s->signal, listener);
  scr_dyn_release(listener);
  scr_dyn_release(disposable);
  return !scr_exc_pending();
}

/* ── pending calls ─────────────────────────────────────────────────── */

static size_t ut_pending_count(const UtState *s) {
  return s->len - s->head;
}

static void ut_push(UtState *s, ScrPromise *promise /* moves in */, ScrDyn **args /* moves in */, size_t argc) {
  /* Calls already taken free their slots, so a queue that never empties
   * keeps its storage within twice its live calls. */
  if (s->len == s->cap && s->head > 0) {
    s->len -= s->head;
    memmove(s->calls, s->calls + s->head, s->len * sizeof *s->calls);
    s->head = 0;
  }
  if (s->len == s->cap) {
    size_t cap = s->cap ? s->cap * 2 : 4;
    UtCall *grown = realloc(s->calls, cap * sizeof *grown);
    if (!grown) ut_oom();
    s->calls = grown;
    s->cap = cap;
  }
  s->calls[s->len++] = (UtCall){promise, args, argc};
}

/* Takes the pending calls, leaving none: *count live calls at the result
 * (free it, the promises and arguments when done). */
static UtCall *ut_take_calls(UtState *s, size_t *count) {
  UtCall *calls = s->calls;
  size_t head = s->head;
  *count = s->len - head;
  if (head) memmove(calls, calls + head, *count * sizeof *calls);
  s->calls = NULL;
  s->head = s->len = s->cap = 0;
  return calls;
}

static void ut_calls_free(UtCall *calls, size_t count) {
  for (size_t i = 0; i < count; i++) {
    scr_promise_release(calls[i].promise);
    ut_args_free(calls[i].args, calls[i].argc);
  }
  free(calls);
}

/* rejectPending(error). */
static void ut_reject_pending(UtState *s, const ScrDyn *error) {
  size_t count;
  UtCall *calls = ut_take_calls(s, &count);
  for (size_t i = 0; i < count; i++) ut_reject(calls[i].promise, error);
  ut_calls_free(calls, count);
}

static void ut_clear_timer(UtState *s) {
  double timeout = s->timeout;
  s->timeout = 0;
  scr_clear_interval(timeout);
}

static void ut_arm(UtState *s, const ScrDyn *self, double delay, void (*fire)(ScrClosure *)) {
  ScrClosure *timer = scr_closure_new((void *)fire, 2);
  timer->caps[0] = ut_state_box(s);
  timer->caps[1] = ut_dyn_box(scr_dyn_retain((ScrDyn *)self));
  s->timeout = scr_set_timeout_handle(timer, delay);
  if (!s->refed) scr_timer_unref(s->timeout);
}

/* The timer's state (+1) and function (+1). */
static UtState *ut_timer_state(ScrClosure *timer, ScrDyn **self) {
  *self = scr_box_get_ref(timer->caps[1]);
  return ut_cap_state(timer);
}

/* ── throttle's limiter ────────────────────────────────────────────── */

static void th_reset_limiter(UtState *s) {
  s->tick_head = s->tick_len = 0;
  s->window_count = 0;
  s->window_open = false;
}

static void th_prune_ticks(UtState *s, double now) {
  while (s->tick_head < s->tick_len && now - s->ticks[s->tick_head] >= s->interval) s->tick_head++;
  if (s->tick_head == s->tick_len) s->tick_head = s->tick_len = 0;
}

static bool th_has_capacity(UtState *s, double now) {
  if (s->strict) {
    th_prune_ticks(s, now);
    return (double)(s->tick_len - s->tick_head) < s->limit;
  }
  if (!s->window_open || now - s->window_start >= s->interval) {
    s->window_count = 0;
    s->window_start = now;
    s->window_open = true;
  }
  return s->window_count < s->limit;
}

static void th_reserve(UtState *s, double now) {
  if (!s->strict) {
    s->window_count++;
    return;
  }
  /* Ticks that left the window free their slots: at most limit ticks are
   * live, so the storage stays within twice that. */
  if (s->tick_len == s->tick_cap && s->tick_head > 0) {
    s->tick_len -= s->tick_head;
    memmove(s->ticks, s->ticks + s->tick_head, s->tick_len * sizeof *s->ticks);
    s->tick_head = 0;
  }
  if (s->tick_len == s->tick_cap) {
    size_t cap = s->tick_cap ? s->tick_cap * 2 : 8;
    double *grown = realloc(s->ticks, cap * sizeof *grown);
    if (!grown) ut_oom();
    s->ticks = grown;
    s->tick_cap = cap;
  }
  s->ticks[s->tick_len++] = now;
}

static void ut_cancel_with_error(UtState *s, const ScrDyn *error) {
  if (!s->throttle) {
    /* debounce's cancelWithError */
    if (s->timeout == 0) return;
    ut_clear_timer(s);
    ut_args_free(s->args, s->argc);
    s->args = NULL;
    s->argc = 0;
    ut_reject_pending(s, error);
    return;
  }
  if (s->timeout != 0) ut_clear_timer(s);
  th_reset_limiter(s);
  ut_reject_pending(s, error);
}

/* ── debounce ──────────────────────────────────────────────────────── */

/* invoke(callArgs, calls): every call settles with fn's one result. */
static void db_invoke(UtState *s, const ScrDyn *self, ScrDyn *const *args, size_t argc, UtCall *calls, size_t count) {
  if (ut_signal_aborted(s)) {
    ut_abort(s);
    if (!s->abort_error) return;
    for (size_t i = 0; i < count; i++) ut_reject(calls[i].promise, s->abort_error);
    return;
  }
  ScrDyn *result = ut_apply(self, args, argc);
  if (!result) {
    scr_promise_reject_pending(calls[0].promise);
    ScrDyn *error = scr_promise_reason_dyn(calls[0].promise);
    for (size_t i = 1; i < count; i++) ut_reject(calls[i].promise, error);
    scr_dyn_release(error);
    return;
  }
  for (size_t i = 0; i < count; i++) scr_promise_resolve_dyn(calls[i].promise, scr_dyn_retain(result));
  scr_dyn_release(result);
}

static void db_invoke_pending(UtState *s, const ScrDyn *self) {
  ScrDyn **args = s->args;
  size_t argc = s->argc;
  s->args = NULL;
  s->argc = 0;
  size_t count;
  UtCall *calls = ut_take_calls(s, &count);
  if (count) db_invoke(s, self, args, argc, calls, count);
  ut_calls_free(calls, count);
  ut_args_free(args, argc);
}

static void db_on_timeout(ScrClosure *timer) {
  ScrDyn *self;
  UtState *s = ut_timer_state(timer, &self);
  s->timeout = 0;
  db_invoke_pending(s, self);
  scr_dyn_release(self);
  ut_state_release(s);
}

static ScrDyn *db_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  UtState *s = ut_owner_state(closure);
  ScrDyn *self = ut_box_fn(s, closure);
  ScrDyn *out = NULL;
  if (ut_signal_aborted(s)) ut_abort(s);
  if (scr_exc_pending()) goto done;
  if (s->abort_error) {
    out = ut_rejected(s->abort_error);
    goto done;
  }
  bool invoke_now = s->leading && s->timeout == 0;
  if (s->timeout != 0) {
    if (ut_pending_count(s) != 0) {
      scr_promise_mark_handled(s->calls[s->len - 1].promise);
      if (s->reject_on_cancel) {
        ScrDyn *error = ut_abort_error("The debounced call was superseded", NULL);
        ut_reject_pending(s, error);
        scr_dyn_release(error);
      }
    }
    scr_timer_refresh(s->timeout);
  } else {
    ut_arm(s, self, s->wait, db_on_timeout);
  }
  if (ut_signal_aborted(s)) {
    ut_abort(s);
    if (s->abort_error) out = ut_rejected(s->abort_error);
    goto done;
  }
  ScrPromise *promise = scr_promise_new();
  if (invoke_now) {
    UtCall call = {promise, NULL, 0};
    db_invoke(s, self, args, argc, &call, 1);
  } else {
    ut_push(s, scr_promise_retain(promise), NULL, 0);
    ut_args_free(s->args, s->argc);
    s->args = ut_args_copy(args, argc);
    s->argc = argc;
  }
  out = ut_promise_box(promise);
done:
  scr_dyn_release(self);
  ut_state_release(s);
  return out;
}

static ScrDyn *db_flush(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc;
  UtState *s = ut_cap_state(closure);
  if (ut_pending_count(s) != 0) {
    /* The armed timer holds the function until it is cleared. */
    ScrDyn *self = ut_self(s);
    ut_clear_timer(s);
    db_invoke_pending(s, self);
    scr_dyn_release(self);
  }
  ut_state_release(s);
  return scr_exc_pending() ? NULL : scr_dyn_retain(scr_dyn_undefined());
}

/* ── throttle ──────────────────────────────────────────────────────── */

static void th_drain(UtState *s, const ScrDyn *self);

static ScrDyn *th_on_settled(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc;
  ScrDyn *self;
  UtState *s = ut_timer_state(closure, &self);
  s->active--;
  th_drain(s, self);
  scr_dyn_release(self);
  ut_state_release(s);
  return scr_exc_pending() ? NULL : scr_dyn_retain(scr_dyn_undefined());
}

/* invoke(call): the call adopts PromiseResolve(fn's result), and the
 * active count drops when that promise settles. Moves the call in. */
static void th_invoke(UtState *s, const ScrDyn *self, UtCall call) {
  s->active++;
  ScrDyn *result = ut_apply(self, call.args, call.argc);
  ScrPromise *settled;
  if (!result) {
    settled = scr_promise_new();
    scr_promise_reject_pending(settled);
  } else if (scr_dyn_promise_of(result)) {
    settled = scr_promise_retain(scr_dyn_promise_of(result));
    scr_dyn_release(result);
  } else {
    settled = scr_promise_new();
    scr_promise_resolve_dyn(settled, result);
  }
  scr_promise_resolve_dyn(call.promise, scr_dyn_new_promise(settled));
  ScrClosure *reaction = scr_closure_new(NULL, 2);
  reaction->caps[0] = ut_state_box(s);
  reaction->caps[1] = ut_dyn_box(scr_dyn_retain((ScrDyn *)self));
  ScrDyn *on_settled = scr_dyn_new_func(reaction, th_on_settled, 0, UT_SIG, "onSettled");
  scr_dyn_release(scr_dyn_promise_then(settled, on_settled, on_settled, NULL));
  scr_dyn_release(on_settled);
  scr_promise_release(settled);
  scr_promise_release(call.promise);
  ut_args_free(call.args, call.argc);
}

static void th_on_timeout(ScrClosure *timer);

static void th_schedule(UtState *s, const ScrDyn *self) {
  if (s->timeout != 0 || ut_pending_count(s) == 0 || s->active >= s->concurrency) return;
  double now = ut_now();
  if (th_has_capacity(s, now)) {
    th_drain(s, self);
    return;
  }
  double delay = s->strict ? s->ticks[s->tick_head] + s->interval - now : s->window_start + s->interval - now;
  ut_arm(s, self, delay, th_on_timeout);
}

static void th_drain(UtState *s, const ScrDyn *self) {
  if (ut_signal_aborted(s)) {
    ut_abort(s);
    return;
  }
  while (ut_pending_count(s) != 0 && s->active < s->concurrency) {
    double now = ut_now();
    if (!th_has_capacity(s, now)) break;
    UtCall call = s->calls[s->head++];
    if (s->head == s->len) s->head = s->len = 0;
    th_reserve(s, now);
    th_invoke(s, self, call);
  }
  th_schedule(s, self);
}

static void th_on_timeout(ScrClosure *timer) {
  ScrDyn *self;
  UtState *s = ut_timer_state(timer, &self);
  s->timeout = 0;
  th_drain(s, self);
  scr_dyn_release(self);
  ut_state_release(s);
}

/* drop(): a handled rejection with ERR_THROTTLED (+1). */
static ScrDyn *th_drop(void) {
  static const char message[] = "The call was dropped by the throttled function";
  ScrStr *text = scr_str_new(message, sizeof message - 1);
  ScrError *e = scr_error_new(SCR_ERR_ERROR, text);
  scr_str_release(text);
  scr_error_set_code(e, "ERR_THROTTLED");
  ScrDyn *error = scr_dyn_from_error(e);
  scr_error_release(e);
  ScrPromise *p = scr_promise_new();
  ut_reject(p, error);
  scr_dyn_release(error);
  scr_promise_mark_handled(p);
  return ut_promise_box(p);
}

static ScrDyn *th_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  UtState *s = ut_owner_state(closure);
  ScrDyn *self = ut_box_fn(s, closure);
  ScrDyn *out = NULL;
  if (ut_signal_aborted(s)) ut_abort(s);
  if (scr_exc_pending()) goto done;
  if (s->abort_error) {
    out = ut_rejected(s->abort_error);
    goto done;
  }
  double now = ut_now();
  bool can_invoke = ut_pending_count(s) == 0 && s->active < s->concurrency && th_has_capacity(s, now);
  if (!can_invoke && (s->drop || (double)ut_pending_count(s) >= s->max_pending)) {
    out = th_drop();
    goto done;
  }
  ScrPromise *promise = scr_promise_new();
  out = scr_dyn_new_promise(promise);
  UtCall call = {promise, ut_args_copy(args, argc), argc};
  if (can_invoke) {
    th_reserve(s, now);
    th_invoke(s, self, call);
  } else {
    ut_push(s, call.promise, call.args, call.argc);
    th_schedule(s, self);
  }
done:
  scr_dyn_release(self);
  ut_state_release(s);
  return out;
}

static ScrDyn *th_has_immediate_capacity(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc;
  UtState *s = ut_cap_state(closure);
  bool capacity = false;
  if (!ut_signal_aborted(s) && ut_pending_count(s) == 0 && s->active < s->concurrency) {
    double now = ut_now();
    if (s->strict) {
      size_t index = s->tick_head;
      while (index < s->tick_len && now - s->ticks[index] >= s->interval) index++;
      capacity = (double)(s->tick_len - index) < s->limit;
    } else {
      capacity = !s->window_open || now - s->window_start >= s->interval || s->window_count < s->limit;
    }
  }
  ut_state_release(s);
  return scr_dyn_new_bool(capacity);
}

/* ── the shared members ────────────────────────────────────────────── */

static ScrDyn *ut_cancel(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  UtState *s = ut_cap_state(closure);
  if (s->throttle || s->timeout != 0) {
    ScrDyn *error = ut_cancel_error(args, argc);
    ut_cancel_with_error(s, error);
    scr_dyn_release(error);
  }
  ut_state_release(s);
  return scr_dyn_retain(scr_dyn_undefined());
}

static ScrDyn *ut_set_ref(ScrClosure *closure, bool refed) {
  UtState *s = ut_cap_state(closure);
  s->refed = refed;
  if (s->timeout != 0) {
    if (refed) scr_timer_ref(s->timeout);
    else scr_timer_unref(s->timeout);
  }
  ScrDyn *self = ut_self(s);
  if (!self)
    ut_fence(s->throttle ? "util.throttle ref() and unref() after the throttled function is unreachable have no lowering"
                         : "util.debounce ref() and unref() after the debounced function is unreachable have no lowering");
  ut_state_release(s);
  return self;
}

static ScrDyn *ut_ref(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc;
  return ut_set_ref(closure, true);
}

static ScrDyn *ut_unref(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc;
  return ut_set_ref(closure, false);
}

static ScrDyn *ut_pending(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc;
  UtState *s = ut_cap_state(closure);
  ScrDyn *out = ut_pending_count(s) == 0 ? scr_dyn_new_null() : scr_dyn_new_promise(s->calls[s->len - 1].promise);
  ut_state_release(s);
  return out;
}

static ScrDyn *ut_pending_count_get(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc;
  UtState *s = ut_cap_state(closure);
  ScrDyn *out = scr_dyn_new_num((double)ut_pending_count(s));
  ut_state_release(s);
  return out;
}

static ScrDyn *th_active_count(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc;
  UtState *s = ut_cap_state(closure);
  ScrDyn *out = scr_dyn_new_num(s->active);
  ut_state_release(s);
  return out;
}

/* ── construction ──────────────────────────────────────────────────── */

/* Object.defineProperty(target, key, descriptor); the descriptor moves in. */
static bool ut_define(ScrDyn *target, const char *key, ScrDyn *descriptor) {
  ScrStr *name = scr_str_new(key, strlen(key));
  ScrDyn *property = scr_dyn_new_str(name);
  scr_str_release(name);
  ScrDyn *defined = scr_dyn_define_property(target, property, descriptor);
  scr_dyn_release(property);
  scr_dyn_release(descriptor);
  scr_dyn_release(defined);
  return defined != NULL;
}

static ScrDyn *ut_member_fn(UtState *s, ScrDynThunk thunk, uint32_t arity, const char *name) {
  ScrClosure *closure = scr_closure_new(NULL, 1);
  closure->caps[0] = ut_state_box(s);
  return scr_dyn_new_func(closure, thunk, arity, UT_SIG, name);
}

/* createFn(value): a writable, enumerable, configurable method. */
static bool ut_define_method(ScrDyn *target, UtState *s, const char *key, ScrDynThunk thunk, uint32_t arity) {
  ScrDyn *descriptor = scr_dyn_new_obj();
  scr_dyn_obj_set(descriptor, "configurable", 12, scr_dyn_new_bool(true));
  scr_dyn_obj_set(descriptor, "enumerable", 10, scr_dyn_new_bool(true));
  scr_dyn_obj_set(descriptor, "writable", 8, scr_dyn_new_bool(true));
  scr_dyn_obj_set(descriptor, "value", 5, ut_member_fn(s, thunk, arity, key));
  return ut_define(target, key, descriptor);
}

static bool ut_define_getter(ScrDyn *target, UtState *s, const char *key, ScrDynThunk thunk, const char *name) {
  ScrDyn *descriptor = scr_dyn_new_obj();
  scr_dyn_obj_set(descriptor, "enumerable", 10, scr_dyn_new_bool(false));
  scr_dyn_obj_set(descriptor, "get", 3, ut_member_fn(s, thunk, 0, name));
  return ut_define(target, key, descriptor);
}

/* `length` and `name` take fn's values. */
static bool ut_define_value(ScrDyn *target, const char *key, ScrDyn *value /* moves in */) {
  ScrDyn *descriptor = scr_dyn_new_obj();
  scr_dyn_obj_set(descriptor, "configurable", 12, scr_dyn_new_bool(true));
  scr_dyn_obj_set(descriptor, "value", 5, value);
  return ut_define(target, key, descriptor);
}

/* `value[key]` over an options object (+1, or NULL with an exception
 * pending). */
static ScrDyn *ut_get(const ScrDyn *value, const char *key) {
  size_t len = strlen(key);
  ScrDyn *result = NULL;
  if (value->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *view = scr_dyn_typed_ref_materialize(value);
    if (scr_exc_pending()) {
      scr_dyn_release(view);
      return NULL;
    }
    result = ut_get(view, key);
    scr_dyn_release(view);
    return result;
  }
  if (value->kind == SCR_DYN_OBJ || value->kind == SCR_DYN_ARR || value->kind == SCR_DYN_PROXY) {
    result = scr_dyn_obj_read(value, key, len);
  } else if (value->kind == SCR_DYN_HANDLE) {
    ScrStr *name = scr_str_new(key, len);
    result = scr_dyn_handle_key_get(value, name);
    scr_str_release(name);
    return result;
  } else {
    return scr_dyn_retain(scr_dyn_undefined());
  }
  if (!result && !scr_exc_pending()) result = scr_dyn_retain(scr_dyn_undefined());
  return result;
}

static void ut_type_fail(const char *name, const char *expected, const ScrDyn *got) {
  if (strchr(name, '.')) scr_dyn_prop_type_fail(name, expected, got);
  else scr_dyn_arg_type_fail(name, expected, got);
}

/* validateFunction(fn, 'fn'). */
static bool ut_function_arg(const ScrDyn *fn, const char *api) {
  if (fn->kind == SCR_DYN_PROXY && scr_dyn_is_callable(fn)) {
    char message[96];
    snprintf(message, sizeof message, "util.%s over Proxy functions has no lowering", api);
    ut_fence(message);
    return false;
  }
  if (fn->kind != SCR_DYN_FUNC) {
    ut_type_fail("fn", "of type function", fn);
    return false;
  }
  return true;
}

/* validateInteger(value, name, min, max). */
static bool ut_integer(const ScrDyn *value, const char *name, double min, double max, double *out) {
  if (value->kind != SCR_DYN_NUM) {
    ut_type_fail(name, "of type number", value);
    return false;
  }
  double v = value->v.num;
  bool integer = isfinite(v) && trunc(v) == v;
  if (integer && v >= min && v <= max) {
    *out = v;
    return true;
  }
  char received[48];
  if (v == 0 && signbit(v)) memcpy(received, "-0", 3);
  else scr_num_received(v, received);
  char range[64];
  if (integer) snprintf(range, sizeof range, ">= %.0f && <= %.0f", min, max);
  else memcpy(range, "an integer", 11);
  char message[256];
  int n = snprintf(message, sizeof message, "The value of \"%s\" is out of range. It must be %s. Received %s", name,
                   range, received);
  scr_throw_error_msg_code(SCR_ERR_RANGE, message, (size_t)n, "ERR_OUT_OF_RANGE");
  return false;
}

/* validateBoolean(value, name) over a defaulted option. */
static bool ut_boolean(const ScrDyn *value, const char *name, bool *out) {
  if (value->kind == SCR_DYN_UNDEF) {
    *out = false;
    return true;
  }
  if (value->kind != SCR_DYN_BOOL) {
    ut_type_fail(name, "of type boolean", value);
    return false;
  }
  *out = value->v.b;
  return true;
}

/* validateObject(options, 'options'), with undefined as the empty object. */
static bool ut_options_object(const ScrDyn *options) {
  if (options->kind == SCR_DYN_UNDEF) return true;
  bool object = options->kind == SCR_DYN_OBJ || options->kind == SCR_DYN_HANDLE || options->kind == SCR_DYN_BYTES ||
                options->kind == SCR_DYN_PROMISE || (options->kind == SCR_DYN_PROXY && !scr_dyn_is_callable(options));
  if (options->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *view = scr_dyn_typed_ref_materialize(options);
    if (!view) return false;
    object = view->kind == SCR_DYN_OBJ;
    scr_dyn_release(view);
  }
  if (!object) ut_type_fail("options", "of type object", options);
  return object;
}

/* validateAbortSignal(signal, 'options.signal'), then Node's throw for an
 * already-aborted signal. Objects that pass Node's duck-typed check
 * without being AbortSignal instances are refused. */
static bool ut_signal_option(const ScrDyn *signal, const char *api) {
  if (signal->kind == SCR_DYN_UNDEF) return true;
  bool aborted = false;
  if (scr_et_signal_core_fn && scr_et_signal_core_fn(signal, &aborted)) {
    if (!aborted) return true;
    ScrStr *key = scr_str_new("reason", 6);
    ScrDyn *reason = scr_dyn_handle_key_get(signal, key);
    scr_str_release(key);
    if (!reason) return false;
    ScrDyn *error = ut_abort_error("The operation was aborted", reason);
    scr_dyn_release(reason);
    scr_dyn_throw(error);
    return false;
  }
  bool object = signal->kind == SCR_DYN_OBJ || signal->kind == SCR_DYN_TYPED_REF || signal->kind == SCR_DYN_HANDLE ||
                signal->kind == SCR_DYN_PROXY;
  ScrStr *key = scr_str_new("aborted", 7);
  bool duck = object && signal->kind != SCR_DYN_HANDLE && scr_dyn_in(signal, key);
  scr_str_release(key);
  if (scr_exc_pending()) return false;
  if (duck) {
    char message[112];
    snprintf(message, sizeof message, "util.%s options.signal values that are not AbortSignal instances have no lowering",
             api);
    ut_fence(message);
    return false;
  }
  scr_dyn_prop_type_fail("options.signal", "an instance of AbortSignal", signal);
  return false;
}

static UtState *ut_state_new(bool throttle, ScrDyn *signal) {
  UtState *s = calloc(1, sizeof *s);
  if (!s) ut_oom();
  s->rc = 1;
  s->throttle = throttle;
  s->thunk = throttle ? th_call : db_call;
  s->signal = signal->kind == SCR_DYN_UNDEF ? NULL : scr_dyn_retain(signal);
  s->refed = true;
  return s;
}

/* The returned function, its members and getters, fn's length and name,
 * and the abort listener. Consumes the caller's state reference. fn sits
 * in a traced box on the function's closure, so a cycle through it (fn
 * refers to the returned function) stays collectable. */
static ScrDyn *ut_build(UtState *s, ScrDyn *wrapped) {
  ScrClosure *closure = scr_closure_new(NULL, 2);
  closure->function_kind = SCR_CLOSURE_KIND_OWN_PROTOTYPE;
  UtOwner *owner = malloc(sizeof *owner);
  if (!owner) ut_oom();
  owner->rc = 1;
  owner->state = s; /* the caller's reference */
  closure->caps[0] = scr_box_new_obj(ut_owner_retain, ut_owner_release, NULL);
  scr_box_set_ref(closure->caps[0], owner);
  closure->caps[1] = ut_dyn_box(scr_dyn_retain(wrapped));
  s->self = closure;
  ScrDyn *fn = ut_box_fn(s, closure);
  scr_closure_release(closure);
  bool ok = ut_define_method(fn, s, "cancel", ut_cancel, 1);
  if (s->throttle) {
    ok = ok && ut_define_method(fn, s, "hasImmediateCapacity", th_has_immediate_capacity, 0);
  } else {
    ok = ok && ut_define_method(fn, s, "flush", db_flush, 0);
  }
  ok = ok && ut_define_method(fn, s, "ref", ut_ref, 0) && ut_define_method(fn, s, "unref", ut_unref, 0) &&
       ut_define_getter(fn, s, "pending", ut_pending, "get") &&
       ut_define_getter(fn, s, "pendingCount", ut_pending_count_get, s->throttle ? "pendingCount" : "get");
  if (s->throttle) ok = ok && ut_define_getter(fn, s, "activeCount", th_active_count, "get");
  if (ok) {
    ScrDyn *length = scr_dyn_fn_get(wrapped, "length", 6);
    ok = ut_define_value(fn, "length", length ? length : scr_dyn_retain(scr_dyn_undefined()));
  }
  if (ok) {
    ScrDyn *name = scr_dyn_fn_get(wrapped, "name", 4);
    ok = ut_define_value(fn, "name", name ? name : scr_dyn_retain(scr_dyn_undefined()));
  }
  if (ok && s->signal) ok = ut_listen(s);
  if (!ok) {
    scr_dyn_release(fn);
    return NULL;
  }
  return fn;
}

ScrDyn *scr_util_debounce(ScrDyn *fn, ScrDyn *wait, ScrDyn *options) {
  double ms;
  if (!ut_function_arg(fn, "debounce") || !ut_integer(wait, "wait", 0, UT_TIMEOUT_MAX, &ms) ||
      !ut_options_object(options))
    return NULL;
  ScrDyn *leading = ut_get(options, "leading");
  ScrDyn *reject_on_cancel = leading ? ut_get(options, "rejectOnCancel") : NULL;
  ScrDyn *signal = reject_on_cancel ? ut_get(options, "signal") : NULL;
  bool lead = false, reject = false;
  bool ok = signal && ut_boolean(leading, "options.leading", &lead) &&
            ut_boolean(reject_on_cancel, "options.rejectOnCancel", &reject) && ut_signal_option(signal, "debounce");
  ScrDyn *result = NULL;
  if (ok) {
    UtState *s = ut_state_new(false, signal);
    s->wait = ms;
    s->leading = lead;
    s->reject_on_cancel = reject;
    result = ut_build(s, fn);
  }
  scr_dyn_release(signal);
  scr_dyn_release(reject_on_cancel);
  scr_dyn_release(leading);
  return result;
}

/* `= Infinity` options: validateInteger(value, name, min) unless Infinity. */
static bool ut_limit_option(const ScrDyn *value, const char *name, double min, double *out) {
  if (value->kind == SCR_DYN_UNDEF || (value->kind == SCR_DYN_NUM && value->v.num == INFINITY)) {
    *out = INFINITY;
    return true;
  }
  return ut_integer(value, name, min, UT_SAFE_MAX, out);
}

ScrDyn *scr_util_throttle(ScrDyn *fn, ScrDyn *limit, ScrDyn *interval, ScrDyn *options) {
  double count, ms;
  if (!ut_function_arg(fn, "throttle") || !ut_integer(limit, "limit", 1, UT_SAFE_MAX, &count) ||
      !ut_integer(interval, "interval", 0, UT_TIMEOUT_MAX, &ms) || !ut_options_object(options))
    return NULL;
  static const char *const keys[] = {"concurrency", "maxPending", "overflow", "signal", "strict"};
  ScrDyn *values[5] = {NULL};
  bool ok = true;
  for (size_t i = 0; i < 5 && ok; i++) ok = (values[i] = ut_get(options, keys[i])) != NULL;
  double concurrency = INFINITY, max_pending = INFINITY;
  bool drop = false, strict = false;
  ok = ok && ut_limit_option(values[0], "options.concurrency", 1, &concurrency) &&
       ut_limit_option(values[1], "options.maxPending", 0, &max_pending);
  if (ok) {
    const ScrDyn *overflow = values[2];
    bool queue = overflow->kind == SCR_DYN_UNDEF ||
                 (overflow->kind == SCR_DYN_STR && overflow->v.str->len == 5 && !memcmp(overflow->v.str->data, "queue", 5));
    drop = overflow->kind == SCR_DYN_STR && overflow->v.str->len == 4 && !memcmp(overflow->v.str->data, "drop", 4);
    if (!queue && !drop) {
      scr_dyn_arg_value_fail("options.overflow", "must be one of: 'queue', 'drop'", overflow);
      ok = false;
    }
  }
  ok = ok && ut_signal_option(values[3], "throttle") && ut_boolean(values[4], "options.strict", &strict);
  ScrDyn *result = NULL;
  if (ok) {
    UtState *s = ut_state_new(true, values[3]);
    s->limit = count;
    s->interval = ms;
    s->concurrency = concurrency;
    s->max_pending = max_pending;
    s->drop = drop;
    s->strict = strict;
    result = ut_build(s, fn);
  }
  for (size_t i = 0; i < 5; i++) scr_dyn_release(values[i]);
  return result;
}
