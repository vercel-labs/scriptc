/* Promise statics called with a foreign constructor —
 * `Promise.all.call(C, iterable)` and friends.
 *
 * A JavaScript source spelling one of the Promise statics through
 * Function.prototype.call used to reach the checked-value fence: the
 * receiver of the static is whatever the program passes, and the
 * compiled implementation only knows %Promise%'s own arrays. This unit
 * runs the specification's generic algorithms over NewPromiseCapability(C)
 * and GetPromiseResolve(C), so any constructor the program supplies — a
 * function with its own `resolve`, a capability-shaped object, a hostile
 * probe asserting call order — observes exactly the steps the language
 * defines:
 *
 *   - NewPromiseCapability: IsConstructor, the executor (length 2, name
 *     "", no [[Construct]], extensible) whose two arguments become the
 *     capability's resolve and reject functions — they are recorded once,
 *     so a later call with a non-undefined argument throws — and
 *     `new C(executor)`, whose callable-recorded pair the capability
 *     keeps whatever the constructed promise's own properties are.
 *   - GetPromiseResolve: `C.resolve` read once, BEFORE the iterable is
 *     touched, and a non-callable value rejects the capability with
 *     Node's "resolve is not a function" TypeError.
 *   - The iterator protocol: Symbol.iterator, `next` read once, done and
 *     value read the way for-of reads them, and IteratorClose (return())
 *     on errors that leave the iterator unfinished.
 *   - The per-element functions: fresh ones for all/allSettled/any with
 *     length 1, name "", no prototype and their own [[AlreadyCalled]];
 *     race passes the capability's OWN resolve/reject functions.
 *   - IfAbruptRejectPromise: every failure after the capability exists
 *     rejects it and answers its promise — never a synchronous throw.
 *
 * `%Promise%` itself answers the ordinary implementation: the capability
 * is a native promise, recognized by identity with the interned
 * constructor the program's `Promise` global read produces, and its
 * resolve is the runtime's own resolution procedure. `Promise.all.call(
 * Promise, xs)` therefore keeps the native microtask ordering, and
 * `Promise.resolve.call(Promise, p)` answers p itself.
 *
 * The unit links only into programs that spell one of these calls in a
 * JavaScript source (the frontend marks promise.genericStatic there), so
 * typed programs keep their exact executables: their IR never names
 * scr_js_promise_generic_call. */
#include "scr_runtime.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* A compiled program that boxes generators registers the checked functions
 * that read a generator capsule's next and return members
 * (scr_dyn_set_generator_members). The iterator protocol's member read goes
 * through them, because the ordinary read of a capsule has no lowering. */
extern SCR_TL ScrDyn *(*scr_generator_member_hook)(const ScrDyn *, const char *, size_t);

/* The iterator's own next or return method, the way the protocol reads it:
 * a synchronous generator capsule ('g' typed sources) answers through the
 * program's registered generator members; every other value through the
 * ordinary member read. */
static ScrDyn *js_pg_iterator_member(const ScrDyn *iterator, const char *key, size_t len) {
  if (scr_generator_member_hook && iterator->kind == SCR_DYN_TYPED_REF &&
      iterator->v.typed_ref.type_key[0] == 'g')
    return scr_generator_member_hook(iterator, key, len);
  return scr_dyn_iterator_result_get(iterator, key, len);
}

/* ── shared state ─────────────────────────────────────────────────────
 * The combinator state is shared by the loop and by every element
 * function it creates, so it is heap-allocated, reference-counted and
 * captured through scr_box_new_obj, like the async unit's thenable jobs.
 * A slot stays NULL until its element settles; an unfilled slot reads as
 * `undefined` in the result array, which is how the specification's List
 * starts life. */
enum { JS_PG_ALL = 0, JS_PG_ALL_SETTLED = 1, JS_PG_ANY = 2, JS_PG_RACE = 3 };

typedef struct JsPgCombo JsPgCombo;

typedef struct {
  size_t rc;
  JsPgCombo *combo; /* +1 while the element lives */
  size_t index;
  bool called; /* the [[AlreadyCalled]] record allSettled's two functions share */
} JsPgElement;

struct JsPgCombo {
  size_t rc;
  int mode;
  ScrDyn *resolve; /* capability resolve (+1) */
  ScrDyn *reject;  /* capability reject (+1) */
  ScrDyn **slots;  /* [count] settled values or reasons (+1 each, NULL holes) */
  size_t count;
  size_t cap;
  size_t remaining;
};

static void *js_pg_combo_retain_v(void *p) {
  ((JsPgCombo *)p)->rc++;
  return p;
}

static void js_pg_combo_release(void *p) {
  JsPgCombo *c = p;
  if (--c->rc > 0) return;
  for (size_t i = 0; i < c->count; i++) scr_dyn_release(c->slots[i]);
  free(c->slots);
  scr_dyn_release(c->resolve);
  scr_dyn_release(c->reject);
  free(c);
}

static JsPgCombo *js_pg_combo_new(int mode, ScrDyn *resolve, ScrDyn *reject) {
  JsPgCombo *c = malloc(sizeof *c);
  if (!c) scr_trap("scriptc: out of memory\n");
  c->rc = 1;
  c->mode = mode;
  c->resolve = resolve;
  c->reject = reject;
  c->slots = NULL;
  c->count = 0;
  c->cap = 0;
  c->remaining = 1;
  return c;
}

/* Room for slot `index`. The loop settles indexes in order, so the array
 * only ever grows at the end. */
static void js_pg_combo_reserve(JsPgCombo *c, size_t index) {
  if (index < c->cap) {
    if (index >= c->count) c->count = index + 1;
    return;
  }
  size_t cap = c->cap ? c->cap : 4;
  while (cap <= index) cap *= 2;
  ScrDyn **grown = realloc(c->slots, cap * sizeof *grown);
  if (!grown) scr_trap("scriptc: out of memory\n");
  memset(grown + c->cap, 0, (cap - c->cap) * sizeof *grown);
  c->slots = grown;
  c->cap = cap;
  c->count = index + 1;
}

static void *js_pg_element_retain_v(void *p) {
  ((JsPgElement *)p)->rc++;
  return p;
}

static void js_pg_element_release_v(void *p) {
  JsPgElement *el = p;
  if (--el->rc > 0) return;
  js_pg_combo_release(el->combo);
  free(el);
}

/* ── small helpers ────────────────────────────────────────────────────
 * Node's exact TypeError texts for the failures this unit raises itself;
 * the class is what tests assert, the wording is what corpus programs can
 * compare. */
static void js_pg_throw_type(const char *message) {
  scr_throw_error_msg(SCR_ERR_TYPE, message, strlen(message));
}

/* The pending exception as a dyn value, clearing the cell. */
static ScrDyn *js_pg_take_reason(void) {
  ScrCaught *caught = scr_exc_take();
  if (!caught) return scr_dyn_retain(scr_dyn_undefined());
  ScrDyn *value = scr_caught_to_dyn(caught);
  scr_caught_release(caught);
  return value;
}

/* IsObject: the specification's object kinds. scr_dyn_is_object answers
 * typeof instead, which null passes. */
static bool js_pg_is_object(const ScrDyn *value) {
  switch (value->kind) {
  case SCR_DYN_OBJ:
  case SCR_DYN_ARR:
  case SCR_DYN_BYTES:
  case SCR_DYN_FUNC:
  case SCR_DYN_HANDLE:
  case SCR_DYN_PROMISE:
  case SCR_DYN_TYPED_REF:
  case SCR_DYN_PROXY:
    return true;
  default:
    return false;
  }
}

/* A boxed function value over `box`, with the shape the language gives
 * the builtins this unit creates: length `arity`, the empty name, no
 * prototype and no [[Construct]]. */
static ScrDyn *js_pg_function(ScrBox *box, ScrDynThunk thunk, uint32_t arity, const char *sig) {
  ScrClosure *closure = scr_closure_new((void *)thunk, 1);
  closure->caps[0] = scr_box_retain(box);
  return scr_dyn_new_func(closure, thunk, arity, sig, "");
}

/* `method(receiver)` — the call shape the iterator protocol and
 * Function.prototype.call spell (the receiver is the `this`). */
static ScrDyn *js_pg_call0(const ScrDyn *method, const ScrDyn *receiver, const char *what) {
  scr_dyn_this_push_dyn(receiver);
  ScrDyn *result = scr_dyn_call(method, NULL, 0, what);
  scr_dyn_this_pop();
  return result;
}

/* ── NewPromiseCapability ─────────────────────────────────────────────
 * The capability record the algorithms call through. For %Promise% its
 * promise is a native promise and its functions are the native resolving
 * functions; for a foreign constructor they are the two arguments its
 * executor received during `new C(executor)`. */
typedef struct {
  ScrDyn *promise; /* +1 */
  ScrDyn *resolve; /* +1 */
  ScrDyn *reject;  /* +1 */
} JsPgCapability;

static void js_pg_capability_release(JsPgCapability *cap) {
  scr_dyn_release(cap->promise);
  scr_dyn_release(cap->resolve);
  scr_dyn_release(cap->reject);
  cap->promise = cap->resolve = cap->reject = NULL;
}

/* The native capability's resolving-functions record: the promise and one
 * already-called flag, what %Promise%'s own executor closes over (a later
 * call of either function is inert). */
typedef struct {
  size_t rc;
  ScrPromise *promise; /* +1 */
  bool called;
} JsPgNative;

static void *js_pg_native_retain_v(void *p) {
  ((JsPgNative *)p)->rc++;
  return p;
}

static void js_pg_native_release_v(void *p) {
  JsPgNative *state = p;
  if (--state->rc > 0) return;
  scr_promise_release(state->promise);
  free(state);
}

static ScrDyn *js_pg_native_resolve_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  JsPgNative *state = scr_box_get_ref(closure->caps[0]);
  if (!state->called) {
    state->called = true;
    scr_dyn_promise_resolve_with(state->promise, argc ? args[0] : scr_dyn_undefined());
  }
  js_pg_native_release_v(state);
  return scr_dyn_retain(scr_dyn_undefined());
}

static ScrDyn *js_pg_native_reject_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  JsPgNative *state = scr_box_get_ref(closure->caps[0]);
  if (!state->called) {
    state->called = true;
    scr_dyn_throw(scr_dyn_retain(argc ? args[0] : scr_dyn_undefined()));
    scr_promise_reject_pending(state->promise);
  }
  js_pg_native_release_v(state);
  return scr_dyn_retain(scr_dyn_undefined());
}

/* The executor `new C(executor)` receives. Its arguments fill the
 * resolving-functions record once: a later call whose resolve or reject
 * argument is not undefined throws the language's TypeError (whose text
 * says "non-undefined arguments" for exactly this reason). */
typedef struct {
  size_t rc;
  ScrDyn *resolve; /* +1, or NULL for "undefined" */
  ScrDyn *reject;  /* +1, or NULL for "undefined" */
} JsPgResolving;

static void *js_pg_resolving_retain_v(void *p) {
  ((JsPgResolving *)p)->rc++;
  return p;
}

static void js_pg_resolving_release_v(void *p) {
  JsPgResolving *state = p;
  if (--state->rc > 0) return;
  scr_dyn_release(state->resolve);
  scr_dyn_release(state->reject);
  free(state);
}

static bool js_pg_defined(const ScrDyn *value) {
  return value && value->kind != SCR_DYN_UNDEF;
}

static ScrDyn *js_pg_executor_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  JsPgResolving *state = scr_box_get_ref(closure->caps[0]);
  ScrDyn *resolve = argc > 0 ? args[0] : scr_dyn_undefined();
  ScrDyn *reject = argc > 1 ? args[1] : scr_dyn_undefined();
  if (js_pg_defined(state->resolve) || js_pg_defined(state->reject)) {
    static const char message[] =
        "Promise executor has already been invoked with non-undefined arguments";
    js_pg_throw_type(message);
    js_pg_resolving_release_v(state);
    return NULL;
  }
  if (js_pg_defined(resolve)) state->resolve = scr_dyn_retain(resolve);
  if (js_pg_defined(reject)) state->reject = scr_dyn_retain(reject);
  js_pg_resolving_release_v(state);
  return scr_dyn_retain(scr_dyn_undefined());
}

/* Whether `value` is %Promise% itself: identity with the interned
 * constructor value the program's `Promise` global read answers. */
static bool js_pg_is_promise(const ScrDyn *value) {
  if (value->kind != SCR_DYN_FUNC) return false;
  ScrStr *name = scr_str_new("Promise", 7);
  ScrDyn *promise = scr_dyn_global_constructor(name);
  scr_str_release(name);
  bool same = scr_dyn_strict_eq(promise, value);
  scr_dyn_release(promise);
  return same;
}

/* NewPromiseCapability(C), `?` in the algorithms: a synchronous throw (a
 * non-constructor, a throwing constructor, resolve/reject values that are
 * not callable) leaves the exception pending and answers false. */
static bool js_pg_new_capability(JsPgCapability *out, const ScrDyn *ctor, bool native) {
  out->promise = out->resolve = out->reject = NULL;
  if (native) {
    ScrPromise *promise = scr_promise_new();
    JsPgNative *state = malloc(sizeof *state);
    if (!state) scr_trap("scriptc: out of memory\n");
    state->rc = 1;
    state->promise = scr_promise_retain(promise);
    state->called = false;
    ScrBox *box = scr_box_new_obj(js_pg_native_retain_v, js_pg_native_release_v, NULL);
    scr_box_set_ref(box, state); /* the creation reference moves in */
    out->promise = scr_dyn_new_promise(promise);
    out->resolve = js_pg_function(box, js_pg_native_resolve_call, 1, "native:promiseResolve");
    out->reject = js_pg_function(box, js_pg_native_reject_call, 1, "native:promiseReject");
    scr_box_release(box);
    scr_promise_release(promise);
    return true;
  }
  /* IsConstructor: a value that is not even callable takes V8's plain
   * "#<Object> is not a constructor"; a callable that is not a
   * constructor (an arrow function) throws from the construct path. */
  if (!scr_dyn_is_callable(ctor)) {
    js_pg_throw_type("#<Object> is not a constructor");
    return false;
  }
  JsPgResolving *resolving = malloc(sizeof *resolving);
  if (!resolving) scr_trap("scriptc: out of memory\n");
  resolving->rc = 1;
  resolving->resolve = resolving->reject = NULL;
  ScrBox *box = scr_box_new_obj(js_pg_resolving_retain_v, js_pg_resolving_release_v, NULL);
  scr_box_set_ref(box, resolving); /* the creation reference moves in */
  ScrDyn *args = scr_dyn_new_arr();
  scr_dyn_arr_push(args, js_pg_function(box, js_pg_executor_call, 2, "native:promiseExecutor"));
  ScrStr *what = scr_str_new("this", 4);
  ScrDyn *promise = scr_dyn_construct(ctor, args, what);
  scr_str_release(what);
  scr_dyn_release(args);
  if (!promise) {
    scr_box_release(box);
    return false;
  }
  /* The capability's functions are the arguments C passed to the executor,
   * not properties of the constructed promise (ES2015's record shape; a
   * constructor that only defines promise.resolve leaves them undefined).
   * A constructor that never called the executor leaves them undefined
   * too, which the callable check below turns into Node's TypeError. */
  JsPgResolving *recorded = scr_box_get_ref(box);
  scr_box_release(box);
  out->promise = promise;
  out->resolve = recorded->resolve ? scr_dyn_retain(recorded->resolve) : NULL;
  out->reject = recorded->reject ? scr_dyn_retain(recorded->reject) : NULL;
  js_pg_resolving_release_v(recorded);
  if (!out->resolve || !scr_dyn_is_callable(out->resolve) || !out->reject ||
      !scr_dyn_is_callable(out->reject)) {
    js_pg_throw_type("Promise resolve or reject function is not callable");
    js_pg_capability_release(out);
    return false;
  }
  return true;
}

/* ── element functions ────────────────────────────────────────────────
 * all/allSettled/any create fresh functions per element (allSettled two,
 * sharing the record); race passes the capability's own. */

/* CreateArrayFromList over the settled slots. */
static ScrDyn *js_pg_values_array(JsPgCombo *combo) {
  ScrDyn *values = scr_dyn_new_arr();
  for (size_t i = 0; i < combo->count; i++)
    scr_dyn_arr_push(values, combo->slots[i] ? scr_dyn_retain(combo->slots[i])
                                             : scr_dyn_retain(scr_dyn_undefined()));
  return values;
}

/* The AggregateError Promise.any rejects with once every entry failed. */
static void js_pg_throw_aggregate(JsPgCombo *combo) {
  static const char message[] = "All promises were rejected";
  ScrStr *text = scr_str_new(message, sizeof message - 1);
  ScrDyn *m = scr_dyn_new_str(text);
  scr_str_release(text);
  ScrError *error = scr_aggregate_new(m, scr_dyn_undefined());
  scr_dyn_release(m);
  ScrDyn *errors = js_pg_values_array(combo);
  scr_aggregate_set_errors(error, errors);
  scr_dyn_release(errors);
  scr_throw_obj(error, &scr_error_retain_v, &scr_error_release_v, scr_error_trace_arg());
}

/* `Call(capability.[[Resolve]], undefined, «values»)`. The call's result
 * is dropped; a throw leaves the exception pending. */
static bool js_pg_resolve_capability(JsPgCombo *combo) {
  ScrDyn *values = js_pg_values_array(combo);
  ScrDyn *args[1] = { values };
  ScrDyn *result = scr_dyn_call(combo->resolve, args, 1, "resolve");
  scr_dyn_release(values);
  if (!result) return false;
  scr_dyn_release(result);
  return true;
}

/* `Call(fn, undefined, «reason»)`, the shape IfAbruptRejectPromise and
 * Promise.any's last reject element both call through. The call's result
 * is dropped; a throw leaves the exception pending. */
static bool js_pg_reject_with(const ScrDyn *fn, const ScrDyn *reason) {
  ScrDyn *args[1] = { (ScrDyn *)reason };
  ScrDyn *result = scr_dyn_call(fn, args, 1, "reject");
  if (!result) return false;
  scr_dyn_release(result);
  return true;
}

/* A record of the settlement shape allSettled stores, `value` or `reason`
 * named by `key`. */
static ScrDyn *js_pg_settled_record(const char *status, const char *key, const ScrDyn *payload) {
  ScrDyn *record = scr_dyn_new_obj();
  ScrStr *text = scr_str_new(status, strlen(status));
  scr_dyn_obj_set(record, "status", 6, scr_dyn_new_str(text));
  scr_str_release(text);
  scr_dyn_obj_set(record, key, strlen(key), scr_dyn_retain((ScrDyn *)payload));
  return record;
}

/* The resolve element of all and allSettled, and the REJECT element of
 * any: they share the settlement shape (store at the index, count down,
 * settle the capability at zero). */
static ScrDyn *js_pg_element_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  JsPgElement *el = scr_box_get_ref(closure->caps[0]);
  ScrDyn *x = argc ? args[0] : scr_dyn_undefined();
  ScrDyn *answer = scr_dyn_retain(scr_dyn_undefined());
  if (!el->called) {
    el->called = true;
    JsPgCombo *combo = el->combo;
    js_pg_combo_reserve(combo, el->index);
    if (combo->mode == JS_PG_ANY) {
      combo->slots[el->index] = scr_dyn_retain(x);
      /* The last rejection rejects the capability itself: once the loop
       * has finished, no later step decrements the count, so the element
       * is the one that delivers the AggregateError. */
      if (--combo->remaining == 0) {
        js_pg_throw_aggregate(combo);
        ScrDyn *reason = js_pg_take_reason();
        if (!js_pg_reject_with(combo->reject, reason)) answer = NULL;
        scr_dyn_release(reason);
      }
    } else {
      combo->slots[el->index] = combo->mode == JS_PG_ALL_SETTLED
                                    ? js_pg_settled_record("fulfilled", "value", x)
                                    : scr_dyn_retain(x);
      if (--combo->remaining == 0 && !js_pg_resolve_capability(combo)) answer = NULL;
    }
  }
  js_pg_element_release_v(el);
  return answer;
}

/* The reject element of allSettled: the same record with the rejection
 * written as `reason`, sharing the resolve function's [[AlreadyCalled]]. */
static ScrDyn *js_pg_element_rejected_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  JsPgElement *el = scr_box_get_ref(closure->caps[0]);
  ScrDyn *x = argc ? args[0] : scr_dyn_undefined();
  ScrDyn *answer = scr_dyn_retain(scr_dyn_undefined());
  if (!el->called) {
    el->called = true;
    JsPgCombo *combo = el->combo;
    js_pg_combo_reserve(combo, el->index);
    combo->slots[el->index] = js_pg_settled_record("rejected", "reason", x);
    if (--combo->remaining == 0 && !js_pg_resolve_capability(combo)) answer = NULL;
  }
  js_pg_element_release_v(el);
  return answer;
}

/* The box one element's functions capture: its index and the shared
 * already-called record. */
static ScrBox *js_pg_element_box(JsPgCombo *combo, size_t index) {
  JsPgElement *el = malloc(sizeof *el);
  if (!el) scr_trap("scriptc: out of memory\n");
  el->rc = 1;
  el->combo = combo;
  combo->rc++;
  el->index = index;
  el->called = false;
  ScrBox *box = scr_box_new_obj(js_pg_element_retain_v, js_pg_element_release_v, NULL);
  scr_box_set_ref(box, el); /* the creation reference moves in */
  return box;
}

/* ── the algorithms ─────────────────────────────────────────────────── */

/* IteratorClose(iterator, throw completion): the pending error stays and
 * everything `return()` raises is dropped, so the algorithm's own error is
 * the one the capability rejects with. */
static void js_pg_close(ScrDyn *iterator) {
  ScrCaught *first = scr_exc_take();
  ScrDyn *method = js_pg_iterator_member(iterator, "return", 6);
  if (method && method->kind != SCR_DYN_UNDEF && method->kind != SCR_DYN_NULL) {
    ScrDyn *result = js_pg_call0(method, iterator, "return");
    if (!result) {
      ScrCaught *dropped = scr_exc_take();
      scr_caught_release(dropped);
    } else {
      scr_dyn_release(result);
    }
  }
  scr_dyn_release(method);
  if (first) {
    scr_rethrow(first);
    scr_caught_release(first);
  }
}

/* IteratorStepValue over (iterator, next): true with *done and the owned
 * value, or false with the exception pending. The native fast path reads
 * the step's value and completion back to back, before any user code
 * runs. */
static bool js_pg_step(ScrDyn *iterator, ScrDyn *next, bool *done, ScrDyn **value) {
  *done = false;
  *value = NULL;
  if (scr_dyn_iterator_can_step(iterator, next)) {
    ScrDyn *item = scr_dyn_iterator_step(iterator);
    if (!item) return false;
    *done = scr_dyn_iterator_step_done(iterator);
    *value = item;
    return true;
  }
  ScrDyn *raw = js_pg_call0(next, iterator, "next");
  if (!raw) return false;
  ScrDyn *result = scr_dyn_iterator_result(raw);
  scr_dyn_release(raw);
  if (!result) return false;
  ScrDyn *finished = scr_dyn_iterator_result_get(result, "done", 4);
  if (!finished) {
    scr_dyn_release(result);
    return false;
  }
  bool is_done = scr_dyn_truthy(finished);
  scr_dyn_release(finished);
  if (is_done) {
    *done = true;
    *value = scr_dyn_retain(scr_dyn_undefined());
  } else {
    ScrDyn *item = scr_dyn_iterator_result_get(result, "value", 5);
    if (!item) {
      scr_dyn_release(result);
      return false;
    }
    *value = item;
  }
  scr_dyn_release(result);
  return true;
}

/* IfAbruptRejectPromise: takes the pending exception, rejects the
 * capability with it and answers the capability's promise. A throwing
 * reject function propagates instead (NULL with that exception pending). */
static ScrDyn *js_pg_reject_abrupt(JsPgCapability *cap) {
  ScrDyn *reason = js_pg_take_reason();
  bool ok = js_pg_reject_with(cap->reject, reason);
  scr_dyn_release(reason);
  if (!ok) return NULL;
  return scr_dyn_retain(cap->promise);
}

/* PromiseResolve(C, value) for one element: %Promise% answers a promise
 * itself and a freshly fulfilled/adopted promise otherwise; a foreign
 * constructor's own `resolve` is called with C as the receiver. */
static ScrDyn *js_pg_resolve_one(bool native, const ScrDyn *ctor, const ScrDyn *resolve,
                                 const ScrDyn *value) {
  if (native) {
    if (value->kind == SCR_DYN_PROMISE) return scr_dyn_retain((ScrDyn *)value);
    ScrPromise *promise = scr_dyn_promise_resolve(value, NULL);
    ScrDyn *boxed = scr_dyn_new_promise(promise);
    scr_promise_release(promise);
    return boxed;
  }
  ScrDyn *args[1] = { (ScrDyn *)value };
  scr_dyn_this_push_dyn(ctor);
  ScrDyn *result = scr_dyn_call(resolve, args, 1, "resolve");
  scr_dyn_this_pop();
  return result;
}

/* `Invoke(promise, "then", «args»)`. */
static bool js_pg_then(ScrDyn *promise, ScrDyn *const *args, size_t argc) {
  ScrDyn *result = scr_dyn_invoke(promise, "then", args, argc, "then");
  if (!result) return false;
  scr_dyn_release(result);
  return true;
}

/* PerformPromiseAll / AllSettled / Any / Race over the iterable. Answers
 * the capability's promise, or NULL with the exception pending (a reject
 * that itself threw). */
static ScrDyn *js_pg_combine(int mode, const ScrDyn *ctor, bool native, const ScrDyn *iterable) {
  JsPgCapability cap;
  if (!js_pg_new_capability(&cap, ctor, native)) return NULL;

  /* GetPromiseResolve(constructor): once, before the iterable is read.
   * %Promise%'s own resolve is the runtime's resolution procedure. */
  ScrDyn *resolve = NULL;
  if (!native) {
    resolve = scr_dyn_obj_read(ctor, "resolve", 7);
    if (!resolve || !scr_dyn_is_callable(resolve)) {
      if (resolve) js_pg_throw_type("resolve is not a function");
      scr_dyn_release(resolve);
      ScrDyn *rejected = js_pg_reject_abrupt(&cap);
      js_pg_capability_release(&cap);
      return rejected;
    }
  }

  ScrDyn *iterator = scr_dyn_iterator(iterable, NULL);
  if (!iterator) {
    scr_dyn_release(resolve);
    ScrDyn *rejected = js_pg_reject_abrupt(&cap);
    js_pg_capability_release(&cap);
    return rejected;
  }
  /* GetIterator reads the `next` method once, as part of building the
   * iterator record: a throw there still precedes the loop. */
  ScrDyn *next = js_pg_iterator_member(iterator, "next", 4);
  if (!next) {
    scr_dyn_release(iterator);
    scr_dyn_release(resolve);
    ScrDyn *rejected = js_pg_reject_abrupt(&cap);
    js_pg_capability_release(&cap);
    return rejected;
  }

  JsPgCombo *combo = js_pg_combo_new(mode, scr_dyn_retain(cap.resolve), scr_dyn_retain(cap.reject));
  ScrBox *combo_box = scr_box_new_obj(js_pg_combo_retain_v, js_pg_combo_release, NULL);
  scr_box_set_ref(combo_box, combo); /* the creation reference moves in */
  ScrDyn *answer = NULL;
  size_t index = 0;
  for (;;) {
    bool done = false;
    ScrDyn *value = NULL;
    if (!js_pg_step(iterator, next, &done, &value)) {
      /* The step (or reading its value) failed: the iterator record is
       * done, so the language closes nothing and the capability rejects
       * with the step's own error. */
      answer = js_pg_reject_abrupt(&cap);
      break;
    }
    if (done) {
      scr_dyn_release(value);
      if (mode != JS_PG_RACE) {
        combo->remaining--;
        if (combo->remaining == 0) {
          if (mode == JS_PG_ANY) {
            js_pg_throw_aggregate(combo);
            answer = js_pg_reject_abrupt(&cap);
          } else {
            answer = js_pg_resolve_capability(combo) ? scr_dyn_retain(cap.promise)
                                                     : js_pg_reject_abrupt(&cap);
          }
          break;
        }
      }
      answer = scr_dyn_retain(cap.promise);
      break;
    }
    ScrDyn *next_promise = js_pg_resolve_one(native, ctor, resolve, value);
    scr_dyn_release(value);
    if (!next_promise) {
      js_pg_close(iterator);
      answer = js_pg_reject_abrupt(&cap);
      break;
    }
    /* Remaining counts this element before `then` runs: a thenable that
     * settles its element synchronously still sees the loop's initial
     * one and finishes at the iterator, like Node. */
    combo->remaining++;
    bool ok;
    if (mode == JS_PG_RACE) {
      ScrDyn *args[2] = { cap.resolve, cap.reject };
      ok = js_pg_then(next_promise, args, 2);
    } else {
      ScrBox *element_box = js_pg_element_box(combo, index);
      /* all fulfills through a fresh element function and rejects with the
       * capability's own reject; allSettled gives each element a second
       * fresh function (the same [[AlreadyCalled]]); any fulfills through
       * the capability's own resolve and rejects through a fresh element
       * function that records the reason (§27.2.4.5.1). */
      ScrDyn *resolve_element;
      ScrDyn *reject_element;
      if (mode == JS_PG_ANY) {
        resolve_element = scr_dyn_retain(cap.resolve);
        reject_element =
            js_pg_function(element_box, js_pg_element_call, 1, "native:promiseRejectElement");
      } else {
        resolve_element =
            js_pg_function(element_box, js_pg_element_call, 1, "native:promiseResolveElement");
        reject_element =
            mode == JS_PG_ALL_SETTLED
                ? js_pg_function(element_box, js_pg_element_rejected_call, 1,
                                 "native:promiseRejectElement")
                : scr_dyn_retain(cap.reject);
      }
      scr_box_release(element_box);
      ScrDyn *args[2] = { resolve_element, reject_element };
      ok = js_pg_then(next_promise, args, 2);
      scr_dyn_release(resolve_element);
      scr_dyn_release(reject_element);
    }
    scr_dyn_release(next_promise);
    if (!ok) {
      js_pg_close(iterator);
      answer = js_pg_reject_abrupt(&cap);
      break;
    }
    index++;
  }
  scr_box_release(combo_box);
  scr_dyn_release(next);
  scr_dyn_release(iterator);
  scr_dyn_release(resolve);
  js_pg_capability_release(&cap);
  return answer;
}

/* PromiseResolve(C, x): %Promise% answers a promise of its own
 * constructor itself and a freshly resolved promise otherwise; a foreign
 * C builds the capability, calls its own resolve function (the call's
 * result is dropped; a throw propagates) and answers the capability's
 * promise. */
static ScrDyn *js_pg_resolve_call(const ScrDyn *ctor, const ScrDyn *value, bool native) {
  bool native_value = value->kind == SCR_DYN_PROMISE;
  if (native) {
    if (native_value) return scr_dyn_retain((ScrDyn *)value);
    ScrPromise *promise = scr_dyn_promise_resolve(value, NULL);
    ScrDyn *boxed = scr_dyn_new_promise(promise);
    scr_promise_release(promise);
    return boxed;
  }
  /* PromiseResolve's first step: a promise whose constructor IS this
   * constructor answers itself. %Promise% is the only intrinsic with a
   * native promise box, and a foreign this never matches it. */
  if (native_value) {
    ScrDyn *constructor = scr_dyn_obj_read(value, "constructor", 11);
    if (!constructor) return NULL;
    bool same = scr_dyn_strict_eq(constructor, ctor);
    scr_dyn_release(constructor);
    if (same) return scr_dyn_retain((ScrDyn *)value);
  }
  JsPgCapability cap;
  if (!js_pg_new_capability(&cap, ctor, false)) return NULL;
  ScrDyn *args[1] = { (ScrDyn *)value };
  ScrDyn *result = scr_dyn_call(cap.resolve, args, 1, "resolve");
  if (!result) {
    js_pg_capability_release(&cap);
    return NULL;
  }
  scr_dyn_release(result);
  ScrDyn *answer = scr_dyn_retain(cap.promise);
  js_pg_capability_release(&cap);
  return answer;
}

/* Promise.reject(this, r): the capability is built, its own reject
 * function receives r, and the capability's promise is the answer. */
static ScrDyn *js_pg_reject_call(const ScrDyn *ctor, const ScrDyn *value, bool native) {
  if (native) {
    ScrPromise *promise = scr_promise_new();
    scr_dyn_throw(scr_dyn_retain((ScrDyn *)value));
    scr_promise_reject_pending(promise);
    ScrDyn *boxed = scr_dyn_new_promise(promise);
    scr_promise_release(promise);
    return boxed;
  }
  JsPgCapability cap;
  if (!js_pg_new_capability(&cap, ctor, false)) return NULL;
  ScrDyn *args[1] = { (ScrDyn *)value };
  ScrDyn *result = scr_dyn_call(cap.reject, args, 1, "reject");
  if (!result) {
    js_pg_capability_release(&cap);
    return NULL;
  }
  scr_dyn_release(result);
  ScrDyn *answer = scr_dyn_retain(cap.promise);
  js_pg_capability_release(&cap);
  return answer;
}

/* `name` is one of the six statics, `thisArg` its receiver and `arg` the
 * iterable (the combinators) or the value (resolve/reject). */
ScrDyn *scr_js_promise_generic_call(const ScrStr *name, const ScrDyn *thisArg, const ScrDyn *arg) {
  int mode = -1;
  const char *label = NULL;
  if (name->len == 3 && memcmp(name->data, "all", 3) == 0) {
    mode = JS_PG_ALL;
    label = "Promise.all";
  } else if (name->len == 10 && memcmp(name->data, "allSettled", 10) == 0) {
    mode = JS_PG_ALL_SETTLED;
    label = "Promise.allSettled";
  } else if (name->len == 3 && memcmp(name->data, "any", 3) == 0) {
    mode = JS_PG_ANY;
    label = "Promise.any";
  } else if (name->len == 4 && memcmp(name->data, "race", 4) == 0) {
    mode = JS_PG_RACE;
    label = "Promise.race";
  }
  bool resolve_mode = mode < 0 && name->len == 7 && memcmp(name->data, "resolve", 7) == 0;
  bool reject_mode = mode < 0 && name->len == 6 && memcmp(name->data, "reject", 6) == 0;
  /* IsObject(this): every static throws synchronously here, each under
   * the name Node uses (the two one-value statics use the internal
   * spelling). */
  if (!js_pg_is_object(thisArg)) {
    char message[64];
    if (resolve_mode) snprintf(message, sizeof message, "PromiseResolve called on non-object");
    else if (reject_mode) snprintf(message, sizeof message, "PromiseReject called on non-object");
    else snprintf(message, sizeof message, "%s called on non-object", label ? label : "Promise");
    js_pg_throw_type(message);
    return NULL;
  }
  bool native = js_pg_is_promise(thisArg);
  if (mode >= 0) return js_pg_combine(mode, thisArg, native, arg);
  if (resolve_mode) return js_pg_resolve_call(thisArg, arg, native);
  if (reject_mode) return js_pg_reject_call(thisArg, arg, native);
  js_pg_throw_type("Promise static is not supported");
  return NULL;
}
