/* WHATWG streams for checked-dynamic code: ReadableStream, WritableStream
 * and TransformStream with their default readers, writers and controllers,
 * and the queuing strategies, as untyped JavaScript reads them (globals and
 * node:stream/web). The algorithms follow Node 24's
 * lib/internal/webstreams step by step, including where Node departs from
 * the specification's promise usage (its read fast path, the lazily
 * materialized closed promises), so promise jobs run in Node's order.
 *
 * Every interface is a dyn handle class (scr_dyn_handle_class.c): its
 * constructor value, prototype members and brand checks come from the
 * handle tables at the end of this file. Algorithm state is refcounted C
 * structs the cycle collector traces (WsObj); user callbacks and values are
 * dyn values.
 *
 * Promise steps: "upon settlement" is scr_promise_react, which runs as a
 * reaction job in subscription order, as PromisePrototypeThen does. */
#include "scr_runtime.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct WsReadable WsReadable;
typedef struct WsReader WsReader;
typedef struct WsRController WsRController;
typedef struct WsReadRequest WsReadRequest;
typedef struct WsTee WsTee;

static void ws_oom(void) { scr_trap("scriptc: out of memory\n"); }

static void *ws_alloc(size_t size) {
  void *p = calloc(1, size);
  if (!p) ws_oom();
  return p;
}

/* ── collected state ───────────────────────────────────────────────── */

/* Every algorithm state starts with WsObj and carries a cycle header: a
 * stream, its controller and its reader point at one another, as Node's
 * objects do, and user callbacks close over their handles, so the cycle
 * collector reclaims them. A type's trace visits every reference the state
 * holds to another state, a promise or a dyn value (every heap dyn value
 * carries a header); drop releases those references, or in a collection
 * (gc) none of them, since the collector settles what trace visits, and
 * frees the state's own buffers. */
typedef struct WsObjType {
  void (*trace)(void *obj, ScrTraceVisit visit, void *ctx);
  void (*drop)(void *obj, bool gc);
  /* For the states a class's handles show: the class name and its
   * getters. */
  const char *cls;
  const ScrDynHandleAccessor *accessors;
} WsObjType;

/* `own` holds the properties a program set on the state's object: handles
 * compare by their state, so every handle shows them. */
typedef struct WsObj {
  size_t rc;
  const WsObjType *type;
  ScrDyn *own; /* +1, or NULL */
} WsObj;

static void ws_obj_trace(void *obj, ScrTraceVisit visit, void *ctx) {
  WsObj *o = obj;
  if (o->own) visit(o->own, ctx);
  o->type->trace(obj, visit, ctx);
}

static void ws_obj_gcfree(void *obj) {
  ((WsObj *)obj)->type->drop(obj, true);
  scr_obj_free_note();
  scr_cyc_free(obj);
}

static void ws_obj_destroy(void *obj) {
  WsObj *o = obj;
  if (o->own) scr_dyn_release(o->own);
  o->type->drop(obj, false);
  scr_obj_free_note();
  scr_cyc_free(obj);
}

static ScrCycType ws_cyc_type = {ws_obj_trace, ws_obj_gcfree, SCR_CYC_KIND_NONE, 0};

static void *ws_obj_new(size_t size, const WsObjType *type) {
  WsObj *o = scr_cyc_alloc(size, &ws_cyc_type);
  o->rc = 1;
  o->type = type;
  scr_obj_alloc_note();
  return o;
}

static void *ws_retain(void *obj) {
  ((WsObj *)obj)->rc++;
  return obj;
}

static void ws_release(void *obj) {
  WsObj *o = obj;
  if (!o) return;
  if (--o->rc == 0) {
    scr_cyc_dead(o);
    scr_rc_destroy(o, ws_obj_destroy);
  } else {
    scr_cyc_released(o);
  }
}

/* The classes' getters (scr_dyn_handle_class.c), which own properties do
 * not shadow. */
static const ScrDynHandleAccessor ws_readable_accessors[] = {{"locked", false}, {NULL, false}};
static const ScrDynHandleAccessor ws_reader_accessors[] = {{"closed", true}, {NULL, false}};
static const ScrDynHandleAccessor ws_rcontroller_accessors[] = {{"desiredSize", false}, {NULL, false}};
static const ScrDynHandleAccessor ws_writable_accessors[] = {{"locked", false}, {NULL, false}};
static const ScrDynHandleAccessor ws_writer_accessors[] = {
    {"closed", true}, {"desiredSize", false}, {"ready", true}, {NULL, false}};
static const ScrDynHandleAccessor ws_wcontroller_accessors[] = {{"signal", false}, {NULL, false}};
static const ScrDynHandleAccessor ws_transform_accessors[] = {{"readable", false}, {"writable", false}, {NULL, false}};
static const ScrDynHandleAccessor ws_tcontroller_accessors[] = {{"desiredSize", false}, {NULL, false}};
static const ScrDynHandleAccessor ws_text_encoder_accessors[] = {
    {"encoding", false}, {"readable", false}, {"writable", false}, {NULL, false}};
static const ScrDynHandleAccessor ws_text_decoder_accessors[] = {
    {"encoding", false}, {"fatal", false}, {"ignoreBOM", false}, {"readable", false}, {"writable", false}, {NULL, false}};

static void ws_visit(const void *child, ScrTraceVisit visit, void *ctx) {
  if (child) visit((void *)child, ctx);
}

static void ws_drop_dyn(ScrDyn *d, bool gc) {
  if (d && !gc) scr_dyn_release(d);
}

static void ws_drop_promise(ScrPromise *p, bool gc) {
  if (p && !gc) scr_promise_release(p);
}

static void ws_drop_obj(void *o, bool gc) {
  if (o && !gc) ws_release(o);
}

/* ── values and errors ─────────────────────────────────────────────── */

static ScrDyn *ws_undef(void) { return scr_dyn_retain(scr_dyn_undefined()); }

static bool ws_is_object(const ScrDyn *v) {
  return v && v->kind != SCR_DYN_NULL && (v->kind == SCR_DYN_FUNC || scr_dyn_is_object(v));
}

/* The pending exception as a dyn value (+1); the cell is cleared. */
static ScrDyn *ws_take_pending(void) {
  ScrCaught *c = scr_exc_take();
  ScrDyn *d = scr_caught_to_dyn(c);
  scr_caught_release(c);
  return d;
}

/* ERR_INVALID_STATE as Node's ERR_INVALID_STATE.TypeError: pending. */
static void ws_state_error(const char *message) {
  char buf[256];
  int n = snprintf(buf, sizeof buf, "Invalid state: %s", message);
  scr_throw_error_msg_code(SCR_ERR_TYPE, buf, (size_t)n, "ERR_INVALID_STATE");
}

static ScrDyn *ws_state_error_value(const char *message) {
  ws_state_error(message);
  return ws_take_pending();
}

/* ERR_INVALID_ARG_VALUE.RangeError: "The property 'name' is invalid.
 * Received <value>". */
static void ws_range_arg_value(const char *name, const ScrDyn *got) {
  char inspected[64];
  const char *text = scr_dyn_inspect_lite(got, inspected, sizeof inspected);
  char buf[256];
  int n = snprintf(buf, sizeof buf, "The %s '%s' is invalid. Received %s",
                   strchr(name, '.') ? "property" : "argument", name, text);
  scr_throw_error_msg_code(SCR_ERR_RANGE, buf, (size_t)n, "ERR_INVALID_ARG_VALUE");
}

/* validateObject with Node's kValidateObjectAllowObjects (null refused) or
 * kValidateObjectAllowObjectsAndNull. */
static bool ws_validate_object(const ScrDyn *value, const char *name, bool allow_null) {
  if (value->kind == SCR_DYN_NULL ? allow_null : ws_is_object(value)) return true;
  scr_dyn_arg_type_fail(name, "of type object", value);
  return false;
}

/* value[name] through Get (getters run); +1, or NULL with the exception
 * pending. undefined and null answer undefined, as optional chaining does. */
static ScrDyn *ws_get(const ScrDyn *object, const char *name) {
  if (object->kind == SCR_DYN_UNDEF || object->kind == SCR_DYN_NULL) return ws_undef();
  if (object->kind == SCR_DYN_HANDLE || object->kind == SCR_DYN_BYTES) {
    ScrStr *key = scr_str_new(name, strlen(name));
    ScrDyn *value = object->kind == SCR_DYN_HANDLE ? scr_dyn_handle_key_get(object, key)
                                                   : scr_dyn_bytes_key_get(object, key);
    scr_str_release(key);
    return value;
  }
  ScrStr *key = scr_str_new(name, strlen(name));
  ScrDyn *k = scr_dyn_new_str(key);
  scr_str_release(key);
  ScrDyn *value = scr_dyn_reflect_get((ScrDyn *)object, k, (ScrDyn *)object);
  scr_dyn_release(k);
  if (!value && !scr_exc_pending()) value = ws_undef();
  return value;
}

/* fn.call(self, ...args): +1, or NULL with the exception pending. */
static ScrDyn *ws_call(const ScrDyn *fn, const ScrDyn *self, ScrDyn *const *args, size_t argc, const char *what) {
  scr_dyn_this_push_dyn((ScrDyn *)self);
  ScrDyn *result = scr_dyn_call(fn, args, argc, what);
  scr_dyn_this_pop();
  return result;
}

/* validateFunction(value, name): ERR_INVALID_ARG_TYPE for any value that
 * is not callable. */
static bool ws_validate_function(const ScrDyn *value, const char *name) {
  if (scr_dyn_is_callable(value)) return true;
  scr_dyn_arg_type_fail(name, "of type function", value);
  return false;
}

/* ── promises ──────────────────────────────────────────────────────── */

static SCR_TL ScrPromise *ws_resolved_promise; /* kResolvedPromise */

static ScrPromise *ws_resolved_singleton(void) {
  if (!ws_resolved_promise) {
    ws_resolved_promise = scr_promise_new();
    scr_promise_fulfill_ref(ws_resolved_promise, ws_undef(), scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
  }
  return ws_resolved_promise;
}

static void ws_fulfill(ScrPromise *p, ScrDyn *value) {
  scr_promise_fulfill_ref(p, scr_dyn_retain(value), scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
}

static void ws_reject(ScrPromise *p, ScrDyn *reason) {
  scr_dyn_throw(scr_dyn_retain(reason));
  scr_promise_reject_pending(p);
}

/* PromiseResolve() and PromiseReject(e): fresh settled promises (+1). */
static ScrPromise *ws_promise_resolved(ScrDyn *value) {
  ScrPromise *p = scr_promise_new();
  ws_fulfill(p, value);
  return p;
}

static ScrPromise *ws_promise_rejected(ScrDyn *reason) {
  ScrPromise *p = scr_promise_new();
  ws_reject(p, reason);
  return p;
}

/* A rejected promise for the pending exception (+1). */
static ScrPromise *ws_promise_rejected_pending(void) {
  ScrPromise *p = scr_promise_new();
  scr_promise_reject_pending(p);
  return p;
}

/* setPromiseHandled. */
static void ws_set_handled(ScrPromise *p) { scr_promise_mark_handled(p); }

/* The settled value or reason of p as a dyn value (+1). */
static ScrDyn *ws_settled_value(ScrPromise *p) { return scr_promise_reason_dyn(p); }

/* The promise a `new Promise((r) => r(value))` makes, or an async
 * function's result promise when it returns value: a promise adopts through
 * its then job, a thenable through its resolve job, and any other value
 * fulfills. +1. */
static ScrPromise *ws_promise_resolving(ScrDyn *value) {
  if (value->kind == SCR_DYN_PROMISE) {
    ScrPromise *p = scr_promise_new();
    scr_promise_resolve_dyn(p, scr_dyn_retain(value));
    return p;
  }
  if (ws_is_object(value)) return scr_dyn_promise_resolve(value, NULL);
  return ws_promise_resolved(value);
}

/* PromiseResolve(value): a promise is itself. +1. */
static ScrPromise *ws_promise_resolve(ScrDyn *value) {
  if (value->kind == SCR_DYN_PROMISE) return scr_promise_retain(value->v.promise);
  return scr_dyn_promise_resolve(value, NULL);
}

/* Native promise reactions over collected contexts (WsObj, or NULL). ok and err borrow the
 * context and the value; a NULL step passes the settlement on (and marks
 * nothing). */
typedef void (*WsStep)(void *ctx, ScrDyn *value);

/* A step whose result promise the then() result adopts (+1, or NULL with
 * the exception pending). */
typedef ScrPromise *(*WsPStep)(void *ctx, ScrDyn *value);

typedef struct WsReaction {
  WsStep ok;
  WsStep err;
  WsPStep pok;
  WsPStep perr;
  void *ctx;           /* a WsObj (+1), or NULL */
  ScrPromise *derived; /* the then() result, settled by the steps' outcome */
} WsReaction;

static void ws_reaction_run(void *opaque, ScrPromise *settled) {
  WsReaction *r = opaque;
  bool rejected = scr_promise_is_rejected(settled);
  WsStep step = rejected ? r->err : r->ok;
  WsPStep pstep = rejected ? r->perr : r->pok;
  ScrDyn *value = ws_settled_value(settled);
  if (pstep) {
    ScrPromise *adopted = pstep(r->ctx, value);
    if (!adopted) {
      scr_promise_reject_pending(r->derived);
    } else {
      ScrDyn *box = scr_dyn_new_promise(adopted);
      scr_promise_release(adopted);
      scr_promise_resolve_dyn(r->derived, box);
    }
    scr_dyn_release(value);
    return;
  }
  if (step) step(r->ctx, value);
  if (r->derived) {
    if (scr_exc_pending()) scr_promise_reject_pending(r->derived);
    else if (rejected && !step) ws_reject(r->derived, value);
    else {
      ScrDyn *u = ws_undef();
      ws_fulfill(r->derived, u);
      scr_dyn_release(u);
    }
  } else if (scr_exc_pending()) {
    /* A step's own throw in a reaction nobody observes: Node's then
     * result rejects unhandled, which reports. */
    ScrPromise *lost = ws_promise_rejected_pending();
    scr_promise_release(lost);
  }
  scr_dyn_release(value);
}

static void ws_reaction_drop(void *opaque) {
  WsReaction *r = opaque;
  ws_release(r->ctx);
  if (r->derived) scr_promise_release(r->derived);
  free(r);
}

static const ScrPromiseReaction ws_reaction = {ws_reaction_run, ws_reaction_drop};

/* PromisePrototypeThen(p, ok, err) with native steps; the caller's +1 on
 * ctx moves in. Answers the derived promise (+1) when want_derived. */
static ScrPromise *ws_then(ScrPromise *p, WsStep ok, WsStep err, void *ctx, bool want_derived) {
  WsReaction *r = ws_alloc(sizeof *r);
  r->ok = ok;
  r->err = err;
  r->ctx = ctx;
  ScrPromise *derived = NULL;
  if (want_derived) {
    derived = scr_promise_new();
    r->derived = scr_promise_retain(derived);
  }
  scr_promise_react(p, &ws_reaction, r);
  return derived;
}

/* PromisePrototypeThen(p, pok, perr) where the handlers return promises
 * the result adopts: the derived promise (+1). */
static ScrPromise *ws_then_adopt(ScrPromise *p, WsPStep pok, WsPStep perr, void *ctx) {
  WsReaction *r = ws_alloc(sizeof *r);
  r->pok = pok;
  r->perr = perr;
  r->ctx = ctx;
  ScrPromise *derived = scr_promise_new();
  r->derived = scr_promise_retain(derived);
  scr_promise_react(p, &ws_reaction, r);
  return derived;
}

/* `then(p, () => {})`: a promise fulfilled with undefined after p fulfills,
 * rejected with p's reason (+1). */
static ScrPromise *ws_then_void(ScrPromise *p) { return ws_then(p, NULL, NULL, NULL, true); }

/* thenAlgorithmResult (util.js): a non-object result continues from the
 * shared resolved promise; any other result through PromiseResolve. ctx
 * is borrowed. */
static void ws_then_algorithm_result(ScrDyn *result, WsStep ok, WsStep err, void *ctx) {
  if (!ws_is_object(result)) {
    ws_then(ws_resolved_singleton(), ok, NULL, ws_retain(ctx), false);
    return;
  }
  ScrPromise *p = ws_promise_resolve(result);
  if (!p) {
    /* PromiseResolve's then read threw: the algorithm result rejects. */
    p = ws_promise_rejected_pending();
  }
  ws_then(p, ok, err, ws_retain(ctx), false);
  scr_promise_release(p);
}

/* queueMicrotask(fn) with a native step; the caller's +1 on ctx moves in. */
static void ws_queue_microtask(WsStep step, void *ctx) {
  ws_then(ws_resolved_singleton(), step, NULL, ctx, false);
}

/* process.nextTick(fn) with a native step; the caller's +1 on ctx moves
 * in. The tick queue holds it until the step runs. */
typedef struct WsTick {
  WsStep step;
  void *ctx;
} WsTick;

static void *ws_tick_retain(void *p) { return p; }
static void ws_tick_release(void *p) {
  WsTick *t = p;
  ws_release(t->ctx);
  free(t);
}

static void ws_tick_run(ScrClosure *self) {
  WsTick *t = scr_box_get_ref(self->caps[0]);
  t->step(t->ctx, NULL);
}

static void ws_next_tick(WsStep step, void *ctx) {
  WsTick *t = ws_alloc(sizeof *t);
  t->step = step;
  t->ctx = ctx;
  ScrClosure *cb = scr_closure_new((void *)ws_tick_run, 1);
  cb->caps[0] = scr_box_new_obj(ws_tick_retain, ws_tick_release, NULL);
  scr_box_set_ref(cb->caps[0], t);
  scr_next_tick(cb);
}

/* A promise with its resolvers, settled at most once. */
typedef struct WsDeferred {
  ScrPromise *promise;
  bool settled;
} WsDeferred;

static void ws_deferred_init(WsDeferred *d) {
  d->promise = scr_promise_new();
  d->settled = false;
}

static void ws_deferred_resolve(WsDeferred *d, ScrDyn *value) {
  if (d->settled) return;
  d->settled = true;
  ws_fulfill(d->promise, value);
}

static void ws_deferred_resolve_undefined(WsDeferred *d) {
  ScrDyn *u = ws_undef();
  ws_deferred_resolve(d, u);
  scr_dyn_release(u);
}

/* resolve(promiseValue): adopts a promise the way a resolver called with
 * one does. */
static void ws_deferred_resolve_promise(WsDeferred *d, ScrPromise *value) {
  if (d->settled) return;
  d->settled = true;
  ScrDyn *box = scr_dyn_new_promise(value);
  scr_promise_resolve_dyn(d->promise, box);
}

static void ws_deferred_reject(WsDeferred *d, ScrDyn *reason) {
  if (d->settled) return;
  d->settled = true;
  ws_reject(d->promise, reason);
}

/* ── the queue (Queue's pairs, util.js) ───────────────────────────── */

typedef struct WsQueue {
  ScrDyn **values;
  double *sizes;
  size_t head, length, capacity;
} WsQueue;

static void ws_queue_push(WsQueue *q, ScrDyn *value, double size) {
  if (q->length == q->capacity) {
    size_t capacity = q->capacity ? q->capacity * 2 : 8;
    ScrDyn **values = malloc(capacity * sizeof *values);
    double *sizes = malloc(capacity * sizeof *sizes);
    if (!values || !sizes) ws_oom();
    for (size_t i = 0; i < q->length; i++) {
      values[i] = q->values[(q->head + i) % q->capacity];
      sizes[i] = q->sizes[(q->head + i) % q->capacity];
    }
    free(q->values);
    free(q->sizes);
    q->values = values;
    q->sizes = sizes;
    q->head = 0;
    q->capacity = capacity;
  }
  size_t at = (q->head + q->length) % q->capacity;
  q->values[at] = scr_dyn_retain(value);
  q->sizes[at] = size;
  q->length++;
}

/* The front value (+1 moves out) and its size. */
static ScrDyn *ws_queue_shift(WsQueue *q, double *size) {
  ScrDyn *value = q->values[q->head];
  *size = q->sizes[q->head];
  q->head = (q->head + 1) % q->capacity;
  q->length--;
  if (q->length == 0) q->head = 0;
  return value;
}

static void ws_queue_drop(WsQueue *q, bool gc) {
  if (!gc)
    for (size_t i = 0; i < q->length; i++) scr_dyn_release(q->values[(q->head + i) % q->capacity]);
  free(q->values);
  free(q->sizes);
  memset(q, 0, sizeof *q);
}

static void ws_queue_reset(WsQueue *q) { ws_queue_drop(q, false); }

static void ws_queue_trace(const WsQueue *q, ScrTraceVisit visit, void *ctx) {
  for (size_t i = 0; i < q->length; i++) visit(q->values[(q->head + i) % q->capacity], ctx);
}

/* ── read requests ─────────────────────────────────────────────────── */

typedef struct WsReadRequestOps {
  /* Each step consumes the request. Values are borrowed. */
  void (*chunk)(WsReadRequest *r, ScrDyn *chunk);
  void (*close)(WsReadRequest *r);
  void (*error)(WsReadRequest *r, ScrDyn *error);
} WsReadRequestOps;

struct WsReadRequest {
  const WsReadRequestOps *ops;
  WsReadRequest *next;
  ScrPromise *promise; /* +1, or NULL */
  void *ctx;           /* a WsObj (+1), or NULL */
};

static ScrDyn *ws_read_result(ScrDyn *value, bool done) {
  ScrDyn *result = scr_dyn_new_obj();
  scr_dyn_obj_set(result, "value", 5, scr_dyn_retain(value));
  scr_dyn_obj_set(result, "done", 4, scr_dyn_new_bool(done));
  return result;
}

/* DefaultReadRequest. */
static void ws_default_chunk(WsReadRequest *r, ScrDyn *chunk) {
  ScrDyn *result = ws_read_result(chunk, false);
  ws_fulfill(r->promise, result);
  scr_dyn_release(result);
  scr_promise_release(r->promise);
  free(r);
}

static void ws_default_close(WsReadRequest *r) {
  ScrDyn *u = ws_undef();
  ScrDyn *result = ws_read_result(u, true);
  scr_dyn_release(u);
  ws_fulfill(r->promise, result);
  scr_dyn_release(result);
  scr_promise_release(r->promise);
  free(r);
}

static void ws_default_error(WsReadRequest *r, ScrDyn *error) {
  ws_reject(r->promise, error);
  scr_promise_release(r->promise);
  free(r);
}

static const WsReadRequestOps ws_default_request_ops = {ws_default_chunk, ws_default_close, ws_default_error};

/* ── ReadableStream state ──────────────────────────────────────────── */

typedef enum { WS_STATE_READABLE, WS_STATE_CLOSED, WS_STATE_ERRORED } WsState;

/* Native algorithms for streams the runtime makes (tee branches, from()):
 * pull answers the algorithm's result (+1 dyn, or NULL with the exception
 * pending, or the parked sentinel), cancel a promise (+1). The context is
 * a WsObj the controller holds until it clears its algorithms. */
typedef struct WsSourceOps {
  ScrDyn *(*pull)(void *ctx, WsRController *c);
  ScrPromise *(*cancel)(void *ctx, WsRController *c, ScrDyn *reason);
} WsSourceOps;

struct WsReadable {
  WsObj obj;
  WsState state;
  bool disturbed;
  ScrDyn *stored_error;
  WsReader *reader;          /* +1 while locked */
  WsRController *controller; /* +1 */
  WsDeferred closed;         /* kIsClosedPromise, materialized on use */
  bool closed_materialized;
};

struct WsRController {
  WsObj obj;
  WsReadable *stream; /* +1 */
  WsQueue queue;
  double queue_total_size;
  double high_water_mark;
  bool started, close_requested, pull_again, pulling, algorithms_cleared;
  /* The underlying source's algorithms (user source), or native ones. */
  ScrDyn *source;
  ScrDyn *pull_fn;
  ScrDyn *cancel_fn;
  ScrDyn *size_fn; /* NULL = the default size algorithm */
  const WsSourceOps *native;
  void *native_ctx; /* +1 */
  int native_branch; /* a tee branch's number */
};

struct WsReader {
  WsObj obj;
  WsReadable *stream; /* +1 while attached */
  WsReadRequest *head, *tail;
  size_t requests;
  /* The closed promise record, materialized on first observation: the
   * promise, and whether its resolvers are still live (PromiseWithResolvers)
   * or it was made settled. */
  ScrPromise *closed;
  bool closed_live;
  /* The tee reading through this reader (+1), which reacts to the
   * stream's error as Node's reaction to the closed promise does. */
  WsTee *tee;
};

static SCR_TL ScrDyn *ws_released_error;  /* "Reader released" */
static SCR_TL ScrDyn *ws_releasing_error; /* "Releasing reader" */
static SCR_TL ScrDyn *ws_writer_released_error_value; /* "Writer has been released" */
static SCR_TL bool ws_teardown_registered;

static void ws_teardown(void) {
  if (ws_released_error) scr_dyn_release(ws_released_error);
  if (ws_releasing_error) scr_dyn_release(ws_releasing_error);
  if (ws_writer_released_error_value) scr_dyn_release(ws_writer_released_error_value);
  if (ws_resolved_promise) scr_promise_release(ws_resolved_promise);
  ws_released_error = ws_releasing_error = ws_writer_released_error_value = NULL;
  ws_resolved_promise = NULL;
}

static void ws_register_teardown(void) {
  if (ws_teardown_registered) return;
  ws_teardown_registered = true;
  scr_atexit(ws_teardown);
}

static ScrDyn *ws_reader_released_error(void) {
  if (!ws_released_error) {
    ws_register_teardown();
    ws_released_error = ws_state_error_value("Reader released");
  }
  return ws_released_error;
}

static ScrDyn *ws_reader_releasing_error(void) {
  if (!ws_releasing_error) {
    ws_register_teardown();
    ws_releasing_error = ws_state_error_value("Releasing reader");
  }
  return ws_releasing_error;
}

static WsReadable *ws_readable_retain(WsReadable *s) { return ws_retain(s); }
static WsRController *ws_rcontroller_retain(WsRController *c) { return ws_retain(c); }
static WsReader *ws_reader_retain(WsReader *r) { return ws_retain(r); }
static void ws_readable_release(WsReadable *s) { ws_release(s); }
static void ws_reader_release(WsReader *r) { ws_release(r); }

static void ws_readable_trace(void *obj, ScrTraceVisit visit, void *ctx) {
  WsReadable *s = obj;
  ws_visit(s->stored_error, visit, ctx);
  ws_visit(s->reader, visit, ctx);
  ws_visit(s->controller, visit, ctx);
  if (s->closed_materialized) ws_visit(s->closed.promise, visit, ctx);
}

static void ws_readable_drop(void *obj, bool gc) {
  WsReadable *s = obj;
  ws_drop_dyn(s->stored_error, gc);
  ws_drop_obj(s->reader, gc);
  ws_drop_obj(s->controller, gc);
  if (s->closed_materialized) ws_drop_promise(s->closed.promise, gc);
}

static const WsObjType ws_readable_type = {ws_readable_trace, ws_readable_drop, "ReadableStream", ws_readable_accessors};

static void ws_rcontroller_trace(void *obj, ScrTraceVisit visit, void *ctx) {
  WsRController *c = obj;
  ws_visit(c->stream, visit, ctx);
  ws_queue_trace(&c->queue, visit, ctx);
  ws_visit(c->source, visit, ctx);
  ws_visit(c->pull_fn, visit, ctx);
  ws_visit(c->cancel_fn, visit, ctx);
  ws_visit(c->size_fn, visit, ctx);
  ws_visit(c->native_ctx, visit, ctx);
}

static void ws_rcontroller_drop(void *obj, bool gc) {
  WsRController *c = obj;
  ws_queue_drop(&c->queue, gc);
  ws_drop_dyn(c->source, gc);
  ws_drop_dyn(c->pull_fn, gc);
  ws_drop_dyn(c->cancel_fn, gc);
  ws_drop_dyn(c->size_fn, gc);
  ws_drop_obj(c->native_ctx, gc);
  ws_drop_obj(c->stream, gc);
}

static const WsObjType ws_rcontroller_type = {ws_rcontroller_trace, ws_rcontroller_drop, "ReadableStreamDefaultController", ws_rcontroller_accessors};

static void ws_reader_trace(void *obj, ScrTraceVisit visit, void *ctx) {
  WsReader *r = obj;
  ws_visit(r->stream, visit, ctx);
  ws_visit(r->closed, visit, ctx);
  ws_visit(r->tee, visit, ctx);
  for (WsReadRequest *q = r->head; q; q = q->next) {
    ws_visit(q->promise, visit, ctx);
    ws_visit(q->ctx, visit, ctx);
  }
}

static void ws_reader_drop(void *obj, bool gc) {
  WsReader *r = obj;
  while (r->head) {
    WsReadRequest *q = r->head;
    r->head = q->next;
    ws_drop_promise(q->promise, gc);
    ws_drop_obj(q->ctx, gc);
    free(q);
  }
  ws_drop_promise(r->closed, gc);
  ws_drop_obj(r->tee, gc);
  ws_drop_obj(r->stream, gc);
}

static const WsObjType ws_reader_type = {ws_reader_trace, ws_reader_drop, "ReadableStreamDefaultReader", ws_reader_accessors};

/* ── handles ───────────────────────────────────────────────────────── */

/* A handle over a state (+1); the collector traces the handle's edge to
 * it. */
static ScrDyn *ws_box(void *state, ScrDynHandleTag tag) {
  ScrDyn *d = scr_dyn_new_handle(state, tag);
  d->v.handle.traced = true;
  return d;
}

static ScrDyn *ws_stream_box(WsReadable *s) { return ws_box(s, SCR_DYNH_WS_READABLE); }
static ScrDyn *ws_reader_box(WsReader *r) { return ws_box(r, SCR_DYNH_WS_READER); }
static ScrDyn *ws_rcontroller_box(WsRController *c) { return ws_box(c, SCR_DYNH_WS_RCONTROLLER); }

static WsReadable *ws_stream_of(const ScrDyn *d) {
  return d && d->kind == SCR_DYN_HANDLE && d->v.handle.tag == SCR_DYNH_WS_READABLE ? d->v.handle.ptr : NULL;
}

static void ws_install(void);

/* ── ReadableStream abstract operations ───────────────────────────── */

static bool ws_readable_locked(WsReadable *s) { return s->reader != NULL; }

static void ws_rcontroller_clear_algorithms(WsRController *c) {
  if (c->algorithms_cleared) return;
  c->algorithms_cleared = true;
  ScrDyn *source = c->source, *pull = c->pull_fn, *cancel = c->cancel_fn, *size = c->size_fn;
  void *native_ctx = c->native_ctx;
  c->source = c->pull_fn = c->cancel_fn = c->size_fn = NULL;
  c->native_ctx = NULL;
  if (source) scr_dyn_release(source);
  if (pull) scr_dyn_release(pull);
  if (cancel) scr_dyn_release(cancel);
  if (size) scr_dyn_release(size);
  ws_release(native_ctx);
}

static void ws_readable_close(WsReadable *s) {
  s->state = WS_STATE_CLOSED;
  if (s->closed_materialized) ws_deferred_resolve_undefined(&s->closed);
  WsReader *r = s->reader;
  if (!r) return;
  if (r->closed && r->closed_live) {
    r->closed_live = false;
    ScrDyn *u = ws_undef();
    ws_fulfill(r->closed, u);
    scr_dyn_release(u);
  }
  ws_reader_retain(r);
  while (r->head) {
    WsReadRequest *q = r->head;
    r->head = q->next;
    if (!r->head) r->tail = NULL;
    r->requests--;
    q->ops->close(q);
  }
  ws_reader_release(r);
}

static void ws_tee_source_error(WsTee *t, ScrDyn *error);

static void ws_readable_error(WsReadable *s, ScrDyn *error) {
  s->state = WS_STATE_ERRORED;
  s->stored_error = scr_dyn_retain(error);
  if (s->closed_materialized) {
    ws_set_handled(s->closed.promise);
    ws_deferred_reject(&s->closed, error);
  }
  WsReader *r = s->reader;
  if (!r) return;
  if (r->closed && r->closed_live) {
    r->closed_live = false;
    ws_set_handled(r->closed);
    ws_reject(r->closed, error);
  }
  if (r->tee) ws_tee_source_error(r->tee, error);
  ws_reader_retain(r);
  while (r->head) {
    WsReadRequest *q = r->head;
    r->head = q->next;
    if (!r->head) r->tail = NULL;
    r->requests--;
    q->ops->error(q, error);
  }
  ws_reader_release(r);
}

static void ws_readable_add_read_request(WsReadable *s, WsReadRequest *q) {
  WsReader *r = s->reader;
  q->next = NULL;
  if (r->tail) r->tail->next = q;
  else r->head = q;
  r->tail = q;
  r->requests++;
}

static void ws_readable_fulfill_read_request(WsReadable *s, ScrDyn *chunk) {
  WsReader *r = s->reader;
  WsReadRequest *q = r->head;
  r->head = q->next;
  if (!r->head) r->tail = NULL;
  r->requests--;
  q->ops->chunk(q, chunk);
}

static ScrPromise *ws_rcontroller_cancel_steps(WsRController *c, ScrDyn *reason);

/* readableStreamCancel: +1 promise. */
static ScrPromise *ws_readable_cancel(WsReadable *s, ScrDyn *reason) {
  s->disturbed = true;
  if (s->state == WS_STATE_CLOSED) {
    ScrDyn *u = ws_undef();
    ScrPromise *p = ws_promise_resolved(u);
    scr_dyn_release(u);
    return p;
  }
  if (s->state == WS_STATE_ERRORED) return ws_promise_rejected(s->stored_error);
  ws_readable_close(s);
  ScrPromise *source = ws_rcontroller_cancel_steps(s->controller, reason);
  ScrPromise *result = ws_then_void(source);
  scr_promise_release(source);
  return result;
}

/* readerClosedPromise: the reader's closed promise, materialized. Borrowed. */
static ScrPromise *ws_reader_closed_promise(WsReader *r) {
  if (r->closed) return r->closed;
  WsReadable *s = r->stream;
  if (!s) {
    r->closed = ws_promise_rejected(ws_reader_released_error());
    ws_set_handled(r->closed);
    r->closed_live = false;
  } else if (s->state == WS_STATE_READABLE) {
    r->closed = scr_promise_new();
    r->closed_live = true;
  } else if (s->state == WS_STATE_CLOSED) {
    ScrDyn *u = ws_undef();
    r->closed = ws_promise_resolved(u);
    scr_dyn_release(u);
    r->closed_live = false;
  } else {
    r->closed = ws_promise_rejected(s->stored_error);
    ws_set_handled(r->closed);
    r->closed_live = false;
  }
  return r->closed;
}

/* readableStreamReaderGenericRelease. */
static void ws_reader_generic_release(WsReader *r) {
  WsReadable *s = r->stream;
  if (s->state == WS_STATE_READABLE) {
    if (r->closed) {
      if (r->closed_live) {
        r->closed_live = false;
        ws_reject(r->closed, ws_reader_released_error());
      }
      ws_set_handled(r->closed);
    }
  } else if (r->closed) {
    scr_promise_release(r->closed);
    r->closed = NULL;
  }
  s->reader = NULL;
  r->stream = NULL;
  ws_reader_release(r); /* the stream's reference */
  ws_readable_release(s);
}

/* readableStreamDefaultReaderRelease. */
static void ws_reader_release_lock(WsReader *r) {
  ws_reader_retain(r);
  ws_reader_generic_release(r);
  while (r->head) {
    WsReadRequest *q = r->head;
    r->head = q->next;
    if (!r->head) r->tail = NULL;
    r->requests--;
    q->ops->error(q, ws_reader_releasing_error());
  }
  ws_reader_release(r);
}

/* setupReadableStreamDefaultReader: false with the exception pending. */
/* setupReadableStreamDefaultReader: the new reader (+1), or NULL with the
 * exception pending. */
static WsReader *ws_reader_new(WsReadable *s) {
  if (ws_readable_locked(s)) {
    ws_state_error("ReadableStream is locked");
    return NULL;
  }
  WsReader *r = ws_obj_new(sizeof *r, &ws_reader_type);
  r->stream = ws_readable_retain(s);
  s->reader = ws_reader_retain(r);
  return r;
}

/* ── the default controller ────────────────────────────────────────── */

static bool ws_rcontroller_can_close_or_enqueue(WsRController *c) {
  return !c->close_requested && c->stream->state == WS_STATE_READABLE;
}

static void ws_rcontroller_pull(WsRController *c);

static bool ws_rcontroller_should_call_pull(WsRController *c) {
  WsReadable *s = c->stream;
  if (c->close_requested || s->state != WS_STATE_READABLE || !c->started) return false;
  if (s->reader && s->reader->requests) return true;
  return c->high_water_mark - c->queue_total_size > 0;
}

static void ws_rcontroller_call_pull_if_needed(WsRController *c) {
  if (ws_rcontroller_should_call_pull(c)) ws_rcontroller_pull(c);
}

static void ws_rcontroller_error(WsRController *c, ScrDyn *error) {
  WsReadable *s = c->stream;
  if (s->state != WS_STATE_READABLE) return;
  ws_queue_reset(&c->queue);
  c->queue_total_size = 0;
  ws_rcontroller_clear_algorithms(c);
  ws_readable_error(s, error);
}

static void ws_rcontroller_close(WsRController *c) {
  if (!ws_rcontroller_can_close_or_enqueue(c)) return;
  c->close_requested = true;
  if (!c->queue.length) {
    ws_rcontroller_clear_algorithms(c);
    ws_readable_close(c->stream);
  }
}

/* readableStreamDefaultControllerEnqueue: false with the exception pending
 * (the size algorithm threw, or its size was invalid; the stream errors). */
static bool ws_rcontroller_enqueue(WsRController *c, ScrDyn *chunk) {
  WsReadable *s = c->stream;
  if (c->close_requested || s->state != WS_STATE_READABLE) return true;
  if (s->reader && s->reader->requests) {
    ws_readable_fulfill_read_request(s, chunk);
  } else if (!c->size_fn) {
    ws_queue_push(&c->queue, chunk, 1);
    c->queue_total_size++;
    if (c->started && c->high_water_mark - c->queue_total_size > 0) ws_rcontroller_pull(c);
    return true;
  } else {
    ScrDyn *size_fn = scr_dyn_retain(c->size_fn);
    ScrDyn *size = ws_call(size_fn, scr_dyn_undefined(), &chunk, 1, "strategy.size");
    scr_dyn_release(size_fn);
    double coerced = NAN;
    if (size) {
      coerced = scr_dyn_number_coerce(size);
      if (!scr_exc_pending() && (isnan(coerced) || coerced < 0 || isinf(coerced)))
        ws_range_arg_value("size", size);
      scr_dyn_release(size);
    }
    if (scr_exc_pending()) {
      ScrDyn *error = ws_take_pending();
      ws_rcontroller_error(c, error);
      scr_dyn_throw(error);
      return false;
    }
    ws_queue_push(&c->queue, chunk, coerced);
    c->queue_total_size += coerced;
  }
  ws_rcontroller_call_pull_if_needed(c);
  return true;
}

static ScrDyn *ws_rcontroller_desired_size(WsRController *c) {
  switch (c->stream->state) {
  case WS_STATE_ERRORED: return scr_dyn_new_null();
  case WS_STATE_CLOSED: return scr_dyn_new_num(0);
  default: return scr_dyn_new_num(c->high_water_mark - c->queue_total_size);
  }
}

static void ws_pull_fulfilled(void *ctx, ScrDyn *value) {
  (void)value;
  WsRController *c = ctx;
  c->pulling = false;
  if (c->pull_again) {
    c->pull_again = false;
    ws_rcontroller_call_pull_if_needed(c);
  }
}

static void ws_pull_rejected(void *ctx, ScrDyn *error) {
  ws_rcontroller_error(ctx, error);
}

/* The parked algorithm result (kParkedAlgorithmResult): the algorithm
 * settles the pull itself. */
static ScrDyn ws_parked_value;
#define WS_PARKED (&ws_parked_value)

static void ws_rcontroller_pull(WsRController *c) {
  if (c->pulling) {
    c->pull_again = true;
    return;
  }
  c->pulling = true;
  ScrDyn *result;
  if (c->native) {
    result = c->native->pull(c->native_ctx, c);
  } else if (c->pull_fn) {
    ScrDyn *controller = ws_rcontroller_box(c);
    ScrDyn *pull = scr_dyn_retain(c->pull_fn);
    ScrDyn *source = scr_dyn_retain(c->source);
    result = ws_call(pull, source, &controller, 1, "source.pull");
    scr_dyn_release(pull);
    scr_dyn_release(source);
    scr_dyn_release(controller);
  } else {
    result = ws_undef(); /* nonOpCallback */
  }
  if (result == WS_PARKED) return;
  if (!result) {
    ScrPromise *rejected = ws_promise_rejected_pending();
    ws_then(rejected, ws_pull_fulfilled, ws_pull_rejected, ws_rcontroller_retain(c), false);
    scr_promise_release(rejected);
    return;
  }
  ws_then_algorithm_result(result, ws_pull_fulfilled, ws_pull_rejected, c);
  scr_dyn_release(result);
}

/* readableStreamDefaultControllerCancelSteps: the cancel algorithm's
 * promise (+1). */
static ScrPromise *ws_rcontroller_cancel_steps(WsRController *c, ScrDyn *reason) {
  ws_queue_reset(&c->queue);
  c->queue_total_size = 0;
  ScrPromise *result;
  if (c->native) {
    result = c->native->cancel(c->native_ctx, c, reason);
  } else if (c->cancel_fn) {
    /* createPromiseCallback1Param: an async arrow around the call. */
    ScrDyn *cancel = scr_dyn_retain(c->cancel_fn);
    ScrDyn *source = scr_dyn_retain(c->source);
    ScrDyn *r = ws_call(cancel, source, &reason, 1, "source.cancel");
    scr_dyn_release(cancel);
    scr_dyn_release(source);
    if (!r) {
      result = ws_promise_rejected_pending();
    } else {
      result = ws_promise_resolving(r);
      scr_dyn_release(r);
    }
  } else {
    ScrDyn *u = ws_undef(); /* nonOpCancel */
    result = ws_promise_resolved(u);
    scr_dyn_release(u);
  }
  ws_rcontroller_clear_algorithms(c);
  return result;
}

/* readableStreamDefaultControllerPullSteps. */
static void ws_rcontroller_pull_steps(WsRController *c, WsReadRequest *q) {
  WsReadable *s = c->stream;
  if (c->queue.length) {
    double size;
    ScrDyn *chunk = ws_queue_shift(&c->queue, &size);
    c->queue_total_size = fmax(0, c->queue_total_size - size);
    if (c->close_requested && !c->queue.length) {
      ws_rcontroller_clear_algorithms(c);
      ws_readable_close(s);
    } else if (!c->close_requested && c->started && c->high_water_mark - c->queue_total_size > 0) {
      ws_rcontroller_pull(c);
    }
    q->ops->chunk(q, chunk);
    scr_dyn_release(chunk);
    return;
  }
  ws_readable_add_read_request(s, q);
  if (c->started) ws_rcontroller_pull(c);
}

/* readableStreamDefaultReaderRead. */
static void ws_reader_read_request(WsReader *r, WsReadRequest *q) {
  WsReadable *s = r->stream;
  s->disturbed = true;
  switch (s->state) {
  case WS_STATE_CLOSED: q->ops->close(q); break;
  case WS_STATE_ERRORED: q->ops->error(q, s->stored_error); break;
  default: ws_rcontroller_pull_steps(s->controller, q); break;
  }
}

static void ws_start_fulfilled(void *ctx, ScrDyn *value) {
  (void)value;
  WsRController *c = ctx;
  c->started = true;
  ws_rcontroller_call_pull_if_needed(c);
}

static void ws_start_rejected(void *ctx, ScrDyn *error) {
  ws_rcontroller_error(ctx, error);
}

/* setupReadableStreamDefaultController after the algorithms are in place:
 * runs the start algorithm's result. */
static void ws_rcontroller_started_with(WsRController *c, ScrDyn *start_result) {
  if (!ws_is_object(start_result)) {
    ws_queue_microtask(ws_start_fulfilled, ws_rcontroller_retain(c));
    return;
  }
  ScrPromise *p = ws_promise_resolving(start_result);
  if (!p) p = ws_promise_rejected_pending();
  ws_then(p, ws_start_fulfilled, ws_start_rejected, ws_rcontroller_retain(c), false);
  scr_promise_release(p);
}

static WsReadable *ws_readable_alloc(void) {
  WsReadable *s = ws_obj_new(sizeof *s, &ws_readable_type);
  s->state = WS_STATE_READABLE;
  return s;
}

static WsRController *ws_rcontroller_attach(WsReadable *s, double high_water_mark) {
  WsRController *c = ws_obj_new(sizeof *c, &ws_rcontroller_type);
  c->stream = ws_readable_retain(s);
  c->high_water_mark = high_water_mark;
  s->controller = c; /* the stream's reference */
  return c;
}

/* createReadableStream with native algorithms and the nonOp start: the new
 * stream (+1). The native context's reference moves in. */
static WsReadable *ws_readable_create_native(const WsSourceOps *ops, void *ctx, int branch, double high_water_mark) {
  ws_install();
  WsReadable *s = ws_readable_alloc();
  WsRController *c = ws_rcontroller_attach(s, high_water_mark);
  c->native = ops;
  c->native_ctx = ctx;
  c->native_branch = branch;
  ScrDyn *u = ws_undef();
  ws_rcontroller_started_with(c, u);
  scr_dyn_release(u);
  return s;
}

/* extractHighWaterMark: false with the exception pending. */
static bool ws_extract_high_water_mark(ScrDyn *value, double fallback, double *out) {
  if (value->kind == SCR_DYN_UNDEF) {
    *out = fallback;
    return true;
  }
  double coerced = scr_dyn_number_coerce(value);
  if (scr_exc_pending()) return false;
  if (isnan(coerced) || coerced < 0) {
    ws_range_arg_value("strategy.highWaterMark", value);
    return false;
  }
  *out = coerced;
  return true;
}

/* new ReadableStream(source, strategy): +1 handle, or NULL with the
 * exception pending. */
static ScrDyn *ws_readable_construct(ScrDyn *const *args, size_t argc) {
  ScrDyn *source = argc > 0 && args[0]->kind != SCR_DYN_UNDEF ? args[0] : NULL;
  ScrDyn *strategy = argc > 1 && args[1]->kind != SCR_DYN_UNDEF ? args[1] : NULL;
  ScrDyn *empty = NULL;
  if (!source || !strategy) empty = scr_dyn_new_obj();
  if (!source) source = empty;
  if (!strategy) strategy = empty;
  ScrDyn *result = NULL;
  ScrDyn *size = NULL, *hwm = NULL, *type = NULL, *start = NULL, *pull = NULL, *cancel = NULL;
  if (!ws_validate_object(source, "source", false) || !ws_validate_object(strategy, "strategy", true)) goto done;
  if (!(size = ws_get(strategy, "size"))) goto done;
  if (!(hwm = ws_get(strategy, "highWaterMark"))) goto done;
  if (!(type = ws_get(source, "type"))) goto done;
  if (type->kind != SCR_DYN_UNDEF) {
    ScrStr *text = scr_dyn_string_coerce_js(type);
    if (!text) goto done;
    bool bytes = text->len == 5 && memcmp(text->data, "bytes", 5) == 0;
    scr_str_release(text);
    if (bytes) {
      static const char message[] = "ReadableStream byte streams ({ type: 'bytes' }) are not supported yet";
      scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
      goto done;
    }
    scr_dyn_arg_value_fail("source.type", NULL, type);
    goto done;
  }
  double high_water_mark;
  if (!ws_extract_high_water_mark(hwm, 1, &high_water_mark)) goto done;
  if (size->kind != SCR_DYN_UNDEF && !ws_validate_function(size, "strategy.size")) goto done;
  if (!(start = ws_get(source, "start"))) goto done;
  if (!(pull = ws_get(source, "pull"))) goto done;
  if (!(cancel = ws_get(source, "cancel"))) goto done;
  bool has_pull = scr_dyn_truthy(pull), has_cancel = scr_dyn_truthy(cancel);
  if (has_pull && !ws_validate_function(pull, "source.pull")) goto done;
  if (has_cancel && !ws_validate_function(cancel, "source.cancel")) goto done;
  ws_install();
  WsReadable *s = ws_readable_alloc();
  WsRController *c = ws_rcontroller_attach(s, high_water_mark);
  c->source = scr_dyn_retain(source);
  if (has_pull) c->pull_fn = scr_dyn_retain(pull);
  if (has_cancel) c->cancel_fn = scr_dyn_retain(cancel);
  if (size->kind != SCR_DYN_UNDEF) c->size_fn = scr_dyn_retain(size);
  ScrDyn *start_result;
  if (scr_dyn_truthy(start)) {
    ScrDyn *controller = ws_rcontroller_box(c);
    start_result = ws_call(start, source, &controller, 1, "source.start");
    scr_dyn_release(controller);
  } else {
    start_result = ws_undef();
  }
  if (!start_result) {
    ws_readable_release(s);
    goto done;
  }
  ws_rcontroller_started_with(c, start_result);
  scr_dyn_release(start_result);
  result = ws_stream_box(s);
  ws_readable_release(s);
done:
  if (empty) scr_dyn_release(empty);
  if (size) scr_dyn_release(size);
  if (hwm) scr_dyn_release(hwm);
  if (type) scr_dyn_release(type);
  if (start) scr_dyn_release(start);
  if (pull) scr_dyn_release(pull);
  if (cancel) scr_dyn_release(cancel);
  return result;
}

/* ── tee (readableStreamDefaultTee) ───────────────────────────────── */

struct WsTee {
  WsObj obj;
  WsReader *reader;
  bool reading, canceled1, canceled2;
  ScrDyn *reason1, *reason2;
  WsReadable *branch1, *branch2; /* +1 each */
  WsDeferred cancel_promise;
  ScrDyn *pending_chunk;
  ScrDyn *source_error; /* the error the source stream errored with */
  bool request_live;
};

static void ws_tee_trace(void *obj, ScrTraceVisit visit, void *ctx) {
  WsTee *t = obj;
  ws_visit(t->reader, visit, ctx);
  ws_visit(t->reason1, visit, ctx);
  ws_visit(t->reason2, visit, ctx);
  ws_visit(t->pending_chunk, visit, ctx);
  ws_visit(t->source_error, visit, ctx);
  ws_visit(t->branch1, visit, ctx);
  ws_visit(t->branch2, visit, ctx);
  ws_visit(t->cancel_promise.promise, visit, ctx);
}

static void ws_tee_drop(void *obj, bool gc) {
  WsTee *t = obj;
  ws_drop_obj(t->reader, gc);
  ws_drop_dyn(t->reason1, gc);
  ws_drop_dyn(t->reason2, gc);
  ws_drop_dyn(t->pending_chunk, gc);
  ws_drop_dyn(t->source_error, gc);
  ws_drop_obj(t->branch1, gc);
  ws_drop_obj(t->branch2, gc);
  ws_drop_promise(t->cancel_promise.promise, gc);
}

static const WsObjType ws_tee_type = {ws_tee_trace, ws_tee_drop};

static void ws_tee_release(WsTee *t) { ws_release(t); }

static void ws_tee_forward_chunk(void *ctx, ScrDyn *unused) {
  (void)unused;
  WsTee *t = ctx;
  t->reading = false;
  ScrDyn *value = t->pending_chunk;
  t->pending_chunk = NULL;
  if (!t->canceled1) ws_rcontroller_enqueue(t->branch1->controller, value);
  if (scr_exc_pending()) scr_exc_clear();
  if (!t->canceled2) ws_rcontroller_enqueue(t->branch2->controller, value);
  if (scr_exc_pending()) scr_exc_clear();
  scr_dyn_release(value);
}

static void ws_tee_request_chunk(WsReadRequest *q, ScrDyn *chunk) {
  WsTee *t = q->ctx;
  if (t->pending_chunk) scr_dyn_release(t->pending_chunk);
  t->pending_chunk = scr_dyn_retain(chunk);
  ws_then(ws_resolved_singleton(), ws_tee_forward_chunk, NULL, t, false); /* the request's reference moves */
  free(q);
}

static void ws_tee_close_tick(void *ctx, ScrDyn *unused) {
  (void)unused;
  WsTee *t = ctx;
  t->reading = false;
  if (!t->canceled1) ws_rcontroller_close(t->branch1->controller);
  if (!t->canceled2) ws_rcontroller_close(t->branch2->controller);
  if (!t->canceled1 || !t->canceled2) ws_deferred_resolve_undefined(&t->cancel_promise);
}

static void ws_tee_request_close(WsReadRequest *q) {
  WsTee *t = q->ctx;
  ws_next_tick(ws_tee_close_tick, t); /* the request's reference moves */
  free(q);
}

static void ws_tee_request_error(WsReadRequest *q, ScrDyn *error) {
  (void)error;
  WsTee *t = q->ctx;
  t->reading = false;
  ws_tee_release(t);
  free(q);
}

static const WsReadRequestOps ws_tee_request_ops = {ws_tee_request_chunk, ws_tee_request_close, ws_tee_request_error};

static ScrDyn *ws_tee_pull(void *ctx, WsRController *c) {
  (void)c;
  WsTee *t = ctx;
  /* `async function pullAlgorithm`: a promise fulfilled with undefined. */
  if (!t->reading) {
    t->reading = true;
    WsReadRequest *q = ws_alloc(sizeof *q);
    q->ops = &ws_tee_request_ops;
    q->ctx = ws_retain(t);
    ws_reader_read_request(t->reader, q);
  }
  ScrDyn *u = ws_undef();
  ScrPromise *p = ws_promise_resolved(u);
  scr_dyn_release(u);
  ScrDyn *box = scr_dyn_new_promise(p);
  scr_promise_release(p);
  return box;
}

static ScrPromise *ws_tee_cancel(void *ctx, WsRController *c, ScrDyn *reason) {
  WsTee *t = ctx;
  if (c->native_branch == 1) {
    t->canceled1 = true;
    t->reason1 = scr_dyn_retain(reason);
  } else {
    t->canceled2 = true;
    t->reason2 = scr_dyn_retain(reason);
  }
  if (t->canceled1 && t->canceled2) {
    ScrDyn *composite = scr_dyn_new_arr();
    scr_dyn_arr_push(composite, scr_dyn_retain(t->reason1));
    scr_dyn_arr_push(composite, scr_dyn_retain(t->reason2));
    ScrPromise *cancel = ws_readable_cancel(t->reader->stream, composite);
    scr_dyn_release(composite);
    ws_deferred_resolve_promise(&t->cancel_promise, cancel);
    scr_promise_release(cancel);
  }
  return scr_promise_retain(t->cancel_promise.promise);
}

static const WsSourceOps ws_tee_source_ops = {ws_tee_pull, ws_tee_cancel};

/* The reaction to the reader's closed promise rejecting (Node's tee). */
static void ws_tee_source_errored(void *ctx, ScrDyn *unused) {
  (void)unused;
  WsTee *t = ctx;
  ScrDyn *error = t->source_error;
  ws_rcontroller_error(t->branch1->controller, error);
  ws_rcontroller_error(t->branch2->controller, error);
  if (!t->canceled1 || !t->canceled2) ws_deferred_resolve_undefined(&t->cancel_promise);
}

/* The source stream errored: the reaction job runs where the closed
 * promise's would. */
static void ws_tee_source_error(WsTee *t, ScrDyn *error) {
  if (t->source_error) return;
  t->source_error = scr_dyn_retain(error);
  ws_queue_microtask(ws_tee_source_errored, ws_retain(t));
}

/* readableStreamDefaultTee: false with the exception pending. */
static bool ws_readable_tee(WsReadable *s, WsReadable **out1, WsReadable **out2) {
  WsReader *reader = ws_reader_new(s);
  if (!reader) return false;
  WsTee *t = ws_obj_new(sizeof *t, &ws_tee_type);
  t->reader = reader;
  ws_deferred_init(&t->cancel_promise);
  /* Each branch's controller holds the tee as its source until it clears
   * its algorithms, and the tee holds the branches. */
  t->branch1 = ws_readable_create_native(&ws_tee_source_ops, ws_retain(t), 1, 1);
  t->branch2 = ws_readable_create_native(&ws_tee_source_ops, ws_retain(t), 2, 1);
  reader->tee = ws_retain(t);
  if (s->state == WS_STATE_ERRORED) ws_tee_source_error(t, s->stored_error);
  *out1 = ws_readable_retain(t->branch1);
  *out2 = ws_readable_retain(t->branch2);
  ws_tee_release(t);
  return true;
}

/* ── ReadableStream.from (readableStreamFromIterable) ─────────────── */

typedef struct WsFrom {
  WsObj obj;
  WsReadable *stream; /* +1 until the stream clears its algorithms */
  ScrDyn *iterator;
  ScrDyn *next_method;
  ScrDyn *pending_result;
} WsFrom;

static void ws_from_trace(void *obj, ScrTraceVisit visit, void *ctx) {
  WsFrom *f = obj;
  ws_visit(f->stream, visit, ctx);
  ws_visit(f->iterator, visit, ctx);
  ws_visit(f->next_method, visit, ctx);
  ws_visit(f->pending_result, visit, ctx);
}

static void ws_from_drop(void *obj, bool gc) {
  WsFrom *f = obj;
  ws_drop_obj(f->stream, gc);
  ws_drop_dyn(f->iterator, gc);
  ws_drop_dyn(f->next_method, gc);
  ws_drop_dyn(f->pending_result, gc);
}

static const WsObjType ws_from_type = {ws_from_trace, ws_from_drop};

/* The stream's controller while it still holds this source; NULL once it
 * cleared its algorithms (closed, errored or canceled). */
static WsRController *ws_from_controller(WsFrom *f) {
  WsRController *c = f->stream->controller;
  return c->algorithms_cleared ? NULL : c;
}

static void ws_from_reject_pull(void *ctx, ScrDyn *error) {
  WsRController *c = ws_from_controller(ctx);
  if (c) ws_rcontroller_error(c, error);
}

static void ws_from_pull_fulfilled(WsFrom *f) {
  WsRController *c = ws_from_controller(f);
  if (c) ws_pull_fulfilled(c, NULL);
}

static void ws_from_enqueue_value(void *ctx, ScrDyn *value) {
  WsFrom *f = ctx;
  WsRController *c = ws_from_controller(f);
  if (!c) return;
  if (!ws_rcontroller_enqueue(c, value)) {
    ScrDyn *error = ws_take_pending();
    ws_from_reject_pull(f, error);
    scr_dyn_release(error);
    return;
  }
  ws_from_pull_fulfilled(f);
}

static void ws_from_process_result(void *ctx, ScrDyn *result) {
  WsFrom *f = ctx;
  WsRController *c = ws_from_controller(f);
  if (!c) return;
  if (!ws_is_object(result)) {
    ScrDyn *error = ws_state_error_value(
        "The promise returned by the iterator.next() method must fulfill with an object");
    ws_from_reject_pull(f, error);
    scr_dyn_release(error);
    return;
  }
  ScrDyn *done = ws_get(result, "done");
  if (!done) goto threw;
  bool finished = scr_dyn_truthy(done);
  scr_dyn_release(done);
  if (finished) {
    ws_rcontroller_close(c);
  } else {
    ScrDyn *value = ws_get(result, "value");
    if (!value) goto threw;
    if (ws_is_object(value)) {
      ScrPromise *p = ws_promise_resolve(value);
      scr_dyn_release(value);
      if (!p) goto threw;
      ws_then(p, ws_from_enqueue_value, ws_from_reject_pull, ws_retain(f), false);
      scr_promise_release(p);
      return;
    }
    bool ok = ws_rcontroller_enqueue(c, value);
    scr_dyn_release(value);
    if (!ok) goto threw;
  }
  ws_from_pull_fulfilled(f);
  return;
threw: {
  ScrDyn *error = ws_take_pending();
  ws_from_reject_pull(f, error);
  scr_dyn_release(error);
}
}

static void ws_from_process_pending(void *ctx, ScrDyn *unused) {
  (void)unused;
  WsFrom *f = ctx;
  ScrDyn *result = f->pending_result;
  f->pending_result = NULL;
  ws_from_process_result(f, result);
  scr_dyn_release(result);
}

static ScrDyn *ws_from_pull(void *ctx, WsRController *c) {
  (void)c;
  WsFrom *f = ctx;
  /* A native iterator (an array's) answers next as a member call. */
  ScrDyn *next = scr_dyn_is_callable(f->next_method)
                     ? ws_call(f->next_method, f->iterator, NULL, 0, "iterator.next")
                     : scr_dyn_invoke(f->iterator, "next", NULL, 0, "iterator.next");
  if (!next) return NULL;
  if (ws_is_object(next)) {
    ScrPromise *p = ws_promise_resolve(next);
    scr_dyn_release(next);
    if (!p) return NULL;
    ws_then(p, ws_from_process_result, ws_from_reject_pull, ws_retain(f), false);
    scr_promise_release(p);
    return WS_PARKED;
  }
  if (f->pending_result) scr_dyn_release(f->pending_result);
  f->pending_result = next;
  ws_then(ws_resolved_singleton(), ws_from_process_pending, NULL, ws_retain(f), false);
  return WS_PARKED;
}

/* `async function cancelAlgorithm(reason)`: awaits iterator.return. */
typedef struct WsFromCancel {
  WsObj obj;
  WsDeferred result;
} WsFromCancel;

static void ws_from_cancel_trace(void *obj, ScrTraceVisit visit, void *ctx) {
  ws_visit(((WsFromCancel *)obj)->result.promise, visit, ctx);
}

static void ws_from_cancel_drop(void *obj, bool gc) { ws_drop_promise(((WsFromCancel *)obj)->result.promise, gc); }

static const WsObjType ws_from_cancel_type = {ws_from_cancel_trace, ws_from_cancel_drop};

static void ws_from_cancel_returned(void *ctx, ScrDyn *iter_result) {
  WsDeferred *d = &((WsFromCancel *)ctx)->result;
  if (!ws_is_object(iter_result)) {
    ScrDyn *error = ws_state_error_value(
        "The promise returned by the iterator.return() method must fulfill with an object");
    ws_deferred_reject(d, error);
    scr_dyn_release(error);
    return;
  }
  ws_deferred_resolve_undefined(d);
}

static void ws_from_cancel_failed(void *ctx, ScrDyn *error) {
  ws_deferred_reject(&((WsFromCancel *)ctx)->result, error);
}

static ScrPromise *ws_from_cancel(void *ctx, WsRController *c, ScrDyn *reason) {
  (void)c;
  WsFrom *f = ctx;
  ScrDyn *method = ws_get(f->iterator, "return");
  if (!method) return ws_promise_rejected_pending();
  if (method->kind == SCR_DYN_UNDEF) {
    scr_dyn_release(method);
    ScrDyn *u = ws_undef();
    ScrPromise *p = ws_promise_resolved(u);
    scr_dyn_release(u);
    return p;
  }
  ScrDyn *returned = ws_call(method, f->iterator, &reason, 1, "iterator.return");
  scr_dyn_release(method);
  if (!returned) return ws_promise_rejected_pending();
  /* `await returned`, then the check. */
  ScrPromise *awaited = ws_promise_resolve(returned);
  scr_dyn_release(returned);
  if (!awaited) return ws_promise_rejected_pending();
  WsFromCancel *wait = ws_obj_new(sizeof *wait, &ws_from_cancel_type);
  ws_deferred_init(&wait->result);
  ScrPromise *result = scr_promise_retain(wait->result.promise);
  ws_then(awaited, ws_from_cancel_returned, ws_from_cancel_failed, wait, false);
  scr_promise_release(awaited);
  return result;
}

static const WsSourceOps ws_from_source_ops = {ws_from_pull, ws_from_cancel};

static ScrDyn *ws_readable_from(ScrDyn *iterable) {
  /* `iterable[SymbolAsyncIterator]` on undefined or null. */
  if (iterable->kind == SCR_DYN_UNDEF || iterable->kind == SCR_DYN_NULL) {
    char buf[96];
    int n = snprintf(buf, sizeof buf, "Cannot read properties of %s (reading 'Symbol(Symbol.asyncIterator)')",
                     iterable->kind == SCR_DYN_NULL ? "null" : "undefined");
    scr_throw_error_msg(SCR_ERR_TYPE, buf, (size_t)n);
    return NULL;
  }
  int kind = 0;
  ScrDyn *iterator = scr_dyn_open_iterator(iterable, &kind, true);
  if (kind < 0) return NULL;
  if (!iterator) {
    /* ERR_ARG_NOT_ITERABLE's '%s must be iterable', which renders a
     * function by its source text. */
    if (scr_dyn_is_callable(iterable)) {
      static const char message[] = "ReadableStream.from of a function that is not iterable is not supported yet";
      scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
      return NULL;
    }
    ScrStr *text = scr_insp_dyn_format_s(iterable, 0);
    if (!text) return NULL;
    size_t n = text->len + 17;
    char *buf = malloc(n);
    if (!buf) ws_oom();
    memcpy(buf, text->data, text->len);
    memcpy(buf + text->len, " must be iterable", 17);
    scr_str_release(text);
    scr_throw_error_msg_code(SCR_ERR_TYPE, buf, n, "ERR_ARG_NOT_ITERABLE");
    free(buf);
    return NULL;
  }
  if (!ws_is_object(iterator)) {
    scr_dyn_release(iterator);
    ws_state_error("The iterator method must return an object");
    return NULL;
  }
  ScrDyn *next = ws_get(iterator, "next");
  if (!next) {
    scr_dyn_release(iterator);
    return NULL;
  }
  WsFrom *f = ws_obj_new(sizeof *f, &ws_from_type);
  f->iterator = iterator;
  f->next_method = next;
  WsReadable *s = ws_readable_create_native(&ws_from_source_ops, f, 0, 0);
  f->stream = ws_readable_retain(s);
  ScrDyn *box = ws_stream_box(s);
  ws_readable_release(s);
  return box;
}

static ScrDyn *ws_readable_from_thunk(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure;
  return ws_readable_from(argc > 0 ? args[0] : scr_dyn_undefined());
}

/* ── streams over another unit's reads (scr_webstream_readable_over) ─ */

typedef struct WsOver {
  WsObj obj;
  WsReadable *stream; /* +1 */
  const ScrWebStreamSource *source;
  void *ctx; /* released through source->release */
} WsOver;

static void ws_over_trace(void *obj, ScrTraceVisit visit, void *ctx) { ws_visit(((WsOver *)obj)->stream, visit, ctx); }

static void ws_over_drop(void *obj, bool gc) {
  WsOver *o = obj;
  ws_drop_obj(o->stream, gc);
  o->stream = NULL;
  /* The context is the other unit's, outside the collector. */
  void *ctx = o->ctx;
  o->ctx = NULL;
  if (ctx) o->source->release(ctx);
}

static const WsObjType ws_over_type = {ws_over_trace, ws_over_drop};

/* The stream's controller while it still holds this source. */
static WsRController *ws_over_controller(WsOver *o) {
  WsRController *c = o->stream ? o->stream->controller : NULL;
  return c && !c->algorithms_cleared ? c : NULL;
}

static void ws_over_chunk(void *ctx, ScrDyn *value) {
  WsOver *o = ctx;
  WsRController *c = ws_over_controller(o);
  if (c) {
    if (ws_rcontroller_enqueue(c, value)) {
      ws_pull_fulfilled(c, NULL);
    } else {
      ScrDyn *error = ws_take_pending();
      ws_rcontroller_error(c, error);
      scr_dyn_release(error);
    }
  }
  ws_release(o);
}

static void ws_over_close(void *ctx) {
  WsOver *o = ctx;
  WsRController *c = ws_over_controller(o);
  if (c) ws_rcontroller_close(c);
  ws_release(o);
}

static void ws_over_error(void *ctx, ScrDyn *reason) {
  WsOver *o = ctx;
  WsRController *c = ws_over_controller(o);
  if (c) ws_rcontroller_error(c, reason ? reason : scr_dyn_undefined());
  ws_release(o);
}

static const ScrFetchReadSink ws_over_sink = {ws_over_chunk, ws_over_close, ws_over_error};

static ScrDyn *ws_over_pull(void *ctx, WsRController *c) {
  (void)c;
  WsOver *o = ctx;
  if (!o->source->read_into(o->ctx, &ws_over_sink, ws_retain(o))) {
    ws_release(o);
    return NULL;
  }
  return WS_PARKED;
}

static ScrPromise *ws_over_cancel(void *ctx, WsRController *c, ScrDyn *reason) {
  (void)c;
  WsOver *o = ctx;
  return o->source->cancel(o->ctx, reason);
}

static const WsSourceOps ws_over_source_ops = {ws_over_pull, ws_over_cancel};

ScrDyn *scr_webstream_readable_over(const ScrWebStreamSource *source, void *ctx) {
  ws_install();
  WsOver *o = ws_obj_new(sizeof *o, &ws_over_type);
  o->source = source;
  o->ctx = ctx;
  WsReadable *s = ws_readable_create_native(&ws_over_source_ops, o, 0, 0);
  o->stream = ws_readable_retain(s);
  ScrDyn *box = ws_stream_box(s);
  ws_readable_release(s);
  return box;
}

/* ── async iteration (ReadableStream.prototype.values) ────────────── */

typedef struct WsIter {
  WsObj obj;
  WsReader *reader;
  bool done, started, prevent_cancel;
  ScrPromise *current; /* state.current, +1 when set */
} WsIter;

static void ws_iter_trace(void *obj, ScrTraceVisit visit, void *ctx) {
  WsIter *it = obj;
  ws_visit(it->reader, visit, ctx);
  ws_visit(it->current, visit, ctx);
}

static void ws_iter_drop(void *obj, bool gc) {
  WsIter *it = obj;
  ws_drop_obj(it->reader, gc);
  ws_drop_promise(it->current, gc);
}

static const WsObjType ws_iter_type = {ws_iter_trace, ws_iter_drop};

static void ws_iter_release(WsIter *it) { ws_release(it); }

static void ws_iter_set_current(WsIter *it, ScrPromise *p) {
  if (it->current) scr_promise_release(it->current);
  it->current = p;
}

static ScrDyn *ws_iter_result(bool done, ScrDyn *value) {
  ScrDyn *result = scr_dyn_new_obj();
  scr_dyn_obj_set(result, "done", 4, scr_dyn_new_bool(done));
  scr_dyn_obj_set(result, "value", 5, scr_dyn_retain(value));
  return result;
}

static void ws_iter_chunk(WsReadRequest *q, ScrDyn *chunk) {
  WsIter *it = q->ctx;
  ws_iter_set_current(it, NULL);
  ScrDyn *result = ws_read_result(chunk, false);
  ws_fulfill(q->promise, result);
  scr_dyn_release(result);
  scr_promise_release(q->promise);
  ws_iter_release(it);
  free(q);
}

static void ws_iter_close(WsReadRequest *q) {
  WsIter *it = q->ctx;
  ws_iter_set_current(it, NULL);
  it->done = true;
  if (it->reader->stream) ws_reader_generic_release(it->reader);
  ScrDyn *u = ws_undef();
  ScrDyn *result = ws_iter_result(true, u);
  scr_dyn_release(u);
  ws_fulfill(q->promise, result);
  scr_dyn_release(result);
  scr_promise_release(q->promise);
  ws_iter_release(it);
  free(q);
}

static void ws_iter_error(WsReadRequest *q, ScrDyn *error) {
  WsIter *it = q->ctx;
  ws_iter_set_current(it, NULL);
  it->done = true;
  if (it->reader->stream) ws_reader_generic_release(it->reader);
  ws_reject(q->promise, error);
  scr_promise_release(q->promise);
  ws_iter_release(it);
  free(q);
}

static const WsReadRequestOps ws_iter_request_ops = {ws_iter_chunk, ws_iter_close, ws_iter_error};

/* nextSteps: +1 promise. */
static ScrPromise *ws_iter_next_steps(void *ctx, ScrDyn *unused) {
  (void)unused;
  WsIter *it = ctx;
  if (it->done) {
    ScrDyn *u = ws_undef();
    ScrDyn *result = ws_iter_result(true, u);
    scr_dyn_release(u);
    ScrPromise *p = ws_promise_resolved(result);
    scr_dyn_release(result);
    return p;
  }
  if (!it->reader->stream) {
    ScrDyn *error = ws_state_error_value("The reader is not bound to a ReadableStream");
    ScrPromise *p = ws_promise_rejected(error);
    scr_dyn_release(error);
    return p;
  }
  WsReadRequest *q = ws_alloc(sizeof *q);
  q->ops = &ws_iter_request_ops;
  q->promise = scr_promise_new();
  q->ctx = ws_retain(it);
  ScrPromise *result = scr_promise_retain(q->promise);
  ws_reader_read_request(it->reader, q);
  return result;
}

/* The read() and next() fast path: a queued chunk, dequeued now. */
static bool ws_dequeue_fast(WsReadable *s, ScrDyn **chunk_out) {
  if (!s || s->state != WS_STATE_READABLE) return false;
  WsRController *c = s->controller;
  if (!c->queue.length) return false;
  s->disturbed = true;
  double size;
  ScrDyn *chunk = ws_queue_shift(&c->queue, &size);
  c->queue_total_size = fmax(0, c->queue_total_size - size);
  if (c->close_requested && !c->queue.length) {
    ws_rcontroller_clear_algorithms(c);
    ws_readable_close(s);
  } else if (!c->close_requested && c->started && c->high_water_mark - c->queue_total_size > 0) {
    ws_rcontroller_pull(c);
  }
  *chunk_out = chunk;
  return true;
}

static WsIter *ws_iter_of(ScrClosure *closure) { return scr_box_get_ref(closure->caps[0]); }

static ScrDyn *ws_iter_next(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc;
  WsIter *it = ws_iter_of(closure);
  ScrPromise *result;
  if (!it->started) {
    ScrDyn *u = ws_undef();
    ws_iter_set_current(it, ws_promise_resolved(u));
    scr_dyn_release(u);
    it->started = true;
  }
  ScrDyn *chunk;
  if (it->current) {
    ScrPromise *chained = ws_then_adopt(it->current, ws_iter_next_steps, ws_iter_next_steps, ws_retain(it));
    ws_iter_set_current(it, chained);
    result = scr_promise_retain(chained);
  } else if (!it->done && ws_dequeue_fast(it->reader->stream, &chunk)) {
    ScrDyn *record = ws_read_result(chunk, false);
    scr_dyn_release(chunk);
    result = ws_promise_resolved(record);
    scr_dyn_release(record);
  } else {
    result = ws_iter_next_steps(it, NULL);
    ws_iter_set_current(it, scr_promise_retain(result));
  }
  ws_iter_release(it);
  ScrDyn *box = scr_dyn_new_promise(result);
  scr_promise_release(result);
  return box;
}

/* returnSteps(value): `async function`, so the result is a promise. */
typedef struct WsIterReturn {
  WsObj obj;
  WsIter *it;
  ScrDyn *value;
} WsIterReturn;

static void ws_iter_return_trace(void *obj, ScrTraceVisit visit, void *ctx) {
  WsIterReturn *r = obj;
  ws_visit(r->it, visit, ctx);
  ws_visit(r->value, visit, ctx);
}

static void ws_iter_return_drop(void *obj, bool gc) {
  WsIterReturn *r = obj;
  ws_drop_obj(r->it, gc);
  ws_drop_dyn(r->value, gc);
}

static const WsObjType ws_iter_return_type = {ws_iter_return_trace, ws_iter_return_drop};

/* `await result; return record` inside returnSteps. */
typedef struct WsAwaitReturn {
  WsObj obj;
  ScrPromise *out;
  ScrDyn *record;
} WsAwaitReturn;

static void ws_await_return_trace(void *obj, ScrTraceVisit visit, void *ctx) {
  WsAwaitReturn *a = obj;
  ws_visit(a->out, visit, ctx);
  ws_visit(a->record, visit, ctx);
}

static void ws_await_return_drop(void *obj, bool gc) {
  WsAwaitReturn *a = obj;
  ws_drop_promise(a->out, gc);
  ws_drop_dyn(a->record, gc);
}

static const WsObjType ws_await_return_type = {ws_await_return_trace, ws_await_return_drop};

static void ws_await_return_ok(void *ctx, ScrDyn *unused) {
  (void)unused;
  WsAwaitReturn *a = ctx;
  ws_fulfill(a->out, a->record);
}

static void ws_await_return_err(void *ctx, ScrDyn *reason) {
  WsAwaitReturn *a = ctx;
  ws_reject(a->out, reason);
}

static ScrPromise *ws_iter_return_steps(WsIter *it, ScrDyn *value) {
  ScrDyn *record = ws_iter_result(true, value);
  ScrPromise *out;
  if (it->done) {
    out = ws_promise_resolved(record);
    scr_dyn_release(record);
    return out;
  }
  it->done = true;
  if (!it->reader->stream) {
    scr_dyn_release(record);
    ScrDyn *error = ws_state_error_value("The reader is not bound to a ReadableStream");
    out = ws_promise_rejected(error);
    scr_dyn_release(error);
    return out;
  }
  if (!it->prevent_cancel) {
    ScrPromise *cancel = ws_readable_cancel(it->reader->stream, value);
    ws_reader_generic_release(it->reader);
    WsAwaitReturn *a = ws_obj_new(sizeof *a, &ws_await_return_type);
    out = scr_promise_new();
    a->out = scr_promise_retain(out);
    a->record = record;
    ws_then(cancel, ws_await_return_ok, ws_await_return_err, a, false);
    scr_promise_release(cancel);
    return out;
  }
  ws_reader_generic_release(it->reader);
  out = ws_promise_resolved(record);
  scr_dyn_release(record);
  return out;
}

static ScrPromise *ws_iter_return_pstep(void *ctx, ScrDyn *unused) {
  (void)unused;
  WsIterReturn *r = ctx;
  return ws_iter_return_steps(r->it, r->value);
}

static ScrDyn *ws_iter_return(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  WsIter *it = ws_iter_of(closure);
  ScrDyn *value = argc > 0 ? args[0] : scr_dyn_undefined();
  it->started = true;
  ScrPromise *result;
  if (it->current) {
    WsIterReturn *r = ws_obj_new(sizeof *r, &ws_iter_return_type);
    r->it = ws_retain(it);
    r->value = scr_dyn_retain(value);
    result = ws_then_adopt(it->current, ws_iter_return_pstep, ws_iter_return_pstep, r);
  } else {
    result = ws_iter_return_steps(it, value);
  }
  ws_iter_set_current(it, scr_promise_retain(result));
  ws_iter_release(it);
  ScrDyn *box = scr_dyn_new_promise(result);
  scr_promise_release(result);
  return box;
}

static ScrDyn *ws_iter_method(WsIter *it, ScrDynThunk thunk, const char *name) {
  ScrClosure *closure = scr_closure_new(NULL, 1);
  /* A box with a trace visits its payload, which carries a header. */
  closure->caps[0] = scr_box_new_obj(ws_retain, ws_release, ws_obj_trace);
  scr_box_set_ref(closure->caps[0], ws_retain(it));
  return scr_dyn_new_func(closure, thunk, 0, "", name);
}

static ScrDyn *ws_self_thunk(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure;
  (void)args;
  (void)argc;
  return scr_dyn_this_get();
}

/* values(options): the async iterator object, +1. */
static ScrDyn *ws_readable_values(WsReadable *s, ScrDyn *options) {
  if (!ws_validate_object(options, "options", true)) return NULL;
  ScrDyn *prevent = ws_get(options, "preventCancel");
  if (!prevent) return NULL;
  bool prevent_cancel = scr_dyn_truthy(prevent);
  scr_dyn_release(prevent);
  WsReader *reader = ws_reader_new(s);
  if (!reader) return NULL;
  WsIter *it = ws_obj_new(sizeof *it, &ws_iter_type);
  it->reader = reader;
  it->prevent_cancel = prevent_cancel;
  ScrDyn *object = scr_dyn_new_obj();
  scr_dyn_obj_set(object, "next", 4, ws_iter_method(it, ws_iter_next, "next"));
  scr_dyn_obj_set(object, "return", 6, ws_iter_method(it, ws_iter_return, "return"));
  ScrDyn *self_fn = scr_dyn_new_func(scr_closure_new(NULL, 0), ws_self_thunk, 0, "", "[Symbol.asyncIterator]");
  ScrDyn *key = scr_dyn_async_iterator_symbol_value();
  if (key) {
    scr_dyn_symbol_key_set(object, key, self_fn);
    scr_dyn_release(key);
  }
  scr_dyn_release(self_fn);
  ws_iter_release(it);
  return object;
}

/* ── sink read requests (Readable.fromWeb) ─────────────────────────── */

typedef struct WsSinkRequest {
  WsReadRequest base;
  const ScrFetchReadSink *sink;
  void *sink_ctx;
} WsSinkRequest;

static void ws_sink_chunk(WsReadRequest *q, ScrDyn *chunk) {
  WsSinkRequest *r = (WsSinkRequest *)q;
  r->sink->chunk(r->sink_ctx, chunk);
  free(r);
}

static void ws_sink_close(WsReadRequest *q) {
  WsSinkRequest *r = (WsSinkRequest *)q;
  r->sink->close(r->sink_ctx);
  free(r);
}

static void ws_sink_error(WsReadRequest *q, ScrDyn *error) {
  WsSinkRequest *r = (WsSinkRequest *)q;
  r->sink->error(r->sink_ctx, error);
  free(r);
}

static const WsReadRequestOps ws_sink_request_ops = {ws_sink_chunk, ws_sink_close, ws_sink_error};

static bool ws_reader_read_into(ScrDyn *reader, const ScrFetchReadSink *sink, void *ctx) {
  WsReader *r = reader->v.handle.ptr;
  if (!r->stream) {
    ws_state_error("The reader is not attached to a stream");
    return false;
  }
  WsSinkRequest *q = ws_alloc(sizeof *q);
  q->base.ops = &ws_sink_request_ops;
  q->sink = sink;
  q->sink_ctx = ctx;
  ws_reader_read_request(r, &q->base);
  return true;
}

/* A stream that cannot be a Response or Request body. */
static bool ws_readable_unusable(const ScrDyn *stream) {
  WsReadable *s = ws_stream_of(stream);
  return !s || ws_readable_locked(s) || s->disturbed;
}

static bool ws_readable_disturbed(const ScrDyn *stream) {
  WsReadable *s = ws_stream_of(stream);
  return s && s->disturbed;
}

static const ScrWebStreamBridge ws_fetch_bridge = {ws_reader_read_into, ws_readable_unusable, ws_readable_disturbed};

/* ── WritableStream (lib/internal/webstreams/writablestream.js) ──── */

typedef enum { WS_W_WRITABLE, WS_W_ERRORING, WS_W_ERRORED, WS_W_CLOSED } WsWState;

typedef struct WsWritable WsWritable;
typedef struct WsWriter WsWriter;
typedef struct WsWController WsWController;

/* Native sink algorithms for streams the runtime makes (a TransformStream's
 * writable side): write and close answer the algorithm's result (+1 dyn,
 * or NULL with the exception pending), abort a promise (+1). The context
 * is a WsObj the controller holds until it clears its algorithms. */
typedef struct WsSinkOps {
  ScrDyn *(*write)(void *ctx, WsWController *c, ScrDyn *chunk);
  ScrPromise *(*close)(void *ctx, WsWController *c);
  ScrPromise *(*abort)(void *ctx, WsWController *c, ScrDyn *reason);
} WsSinkOps;

/* A promise record (PromiseWithResolvers, resolvedRecord or
 * rejectedHandledRecord): the promise (+1), and whether its resolvers are
 * live. NULL until materialized. A pipe parks on a writer's backpressure
 * by installing a record whose resolve is its hook (a forever-pending
 * promise with a no-op reject, as Node's pipeTo does). */
typedef struct WsRecord {
  ScrPromise *promise;
  bool live;
  void (*hook)(void *ctx);
  void *hook_ctx; /* weak: the pipe owns the writer */
} WsRecord;

typedef struct WsPipe WsPipe;

/* A write request: its promise (+1), or the shared tracker of the pipe
 * that wrote the chunk (+1; pipeTo). */
typedef struct WsWriteRequest {
  ScrPromise *promise;
  WsPipe *tracker;
} WsWriteRequest;

struct WsWritable {
  WsObj obj;
  WsWState state;
  ScrDyn *stored_error; /* +1, or NULL for undefined */
  WsWriter *writer;     /* +1 while locked */
  WsWController *controller;
  ScrPromise *close_request;  /* +1 while queued */
  WsWriteRequest inflight_write; /* both NULL when none is in flight */
  ScrPromise *inflight_close; /* +1 */
  bool close_queued_or_inflight;
  /* pendingAbortRequest */
  ScrPromise *abort_request; /* +1 */
  ScrDyn *abort_reason;      /* +1, or NULL for undefined */
  bool abort_was_already_erroring;
  bool backpressure;
  /* writeRequests, a ring. */
  WsWriteRequest *requests;
  size_t requests_head, requests_len, requests_cap;
};

struct WsWriter {
  WsObj obj;
  WsWritable *stream; /* +1 while attached */
  WsRecord closed;
  WsRecord ready;
};

struct WsWController {
  WsObj obj;
  WsWritable *stream; /* +1 */
  WsQueue queue;
  double queue_total_size;
  double high_water_mark;
  bool started, algorithms_cleared;
  ScrDyn *sink;
  ScrDyn *write_fn, *close_fn, *abort_fn;
  ScrDyn *size_fn; /* NULL = the default size algorithm */
  const WsSinkOps *native;
  void *native_ctx; /* +1 */
  /* The AbortController, made when the signal is first read; until then
   * an abort records its reason (no listener can observe it). */
  ScrDyn *abort_controller; /* +1 */
  bool aborted;
  ScrDyn *aborted_reason; /* +1 */
};

/* kCloseSentinel. */
static ScrDyn ws_close_sentinel = {.rc = SIZE_MAX, .kind = SCR_DYN_UNDEF};

static ScrDyn *ws_writer_released_error(void) {
  if (!ws_writer_released_error_value) {
    ws_register_teardown();
    ws_writer_released_error_value = ws_state_error_value("Writer has been released");
  }
  return ws_writer_released_error_value;
}

static void ws_writable_trace(void *obj, ScrTraceVisit visit, void *ctx) {
  WsWritable *s = obj;
  ws_visit(s->stored_error, visit, ctx);
  ws_visit(s->writer, visit, ctx);
  ws_visit(s->controller, visit, ctx);
  ws_visit(s->close_request, visit, ctx);
  ws_visit(s->inflight_write.promise, visit, ctx);
  ws_visit(s->inflight_write.tracker, visit, ctx);
  ws_visit(s->inflight_close, visit, ctx);
  ws_visit(s->abort_request, visit, ctx);
  ws_visit(s->abort_reason, visit, ctx);
  for (size_t i = 0; i < s->requests_len; i++) {
    WsWriteRequest *q = &s->requests[(s->requests_head + i) % s->requests_cap];
    ws_visit(q->promise, visit, ctx);
    ws_visit(q->tracker, visit, ctx);
  }
}

static void ws_writable_drop(void *obj, bool gc) {
  WsWritable *s = obj;
  ws_drop_dyn(s->stored_error, gc);
  ws_drop_obj(s->writer, gc);
  ws_drop_obj(s->controller, gc);
  ws_drop_promise(s->close_request, gc);
  ws_drop_promise(s->inflight_write.promise, gc);
  ws_drop_obj(s->inflight_write.tracker, gc);
  ws_drop_promise(s->inflight_close, gc);
  ws_drop_promise(s->abort_request, gc);
  ws_drop_dyn(s->abort_reason, gc);
  for (size_t i = 0; i < s->requests_len; i++) {
    WsWriteRequest *q = &s->requests[(s->requests_head + i) % s->requests_cap];
    ws_drop_promise(q->promise, gc);
    ws_drop_obj(q->tracker, gc);
  }
  free(s->requests);
}

static const WsObjType ws_writable_type = {ws_writable_trace, ws_writable_drop, "WritableStream", ws_writable_accessors};

static void ws_writer_trace(void *obj, ScrTraceVisit visit, void *ctx) {
  WsWriter *w = obj;
  ws_visit(w->stream, visit, ctx);
  ws_visit(w->closed.promise, visit, ctx);
  ws_visit(w->ready.promise, visit, ctx);
}

static void ws_writer_drop(void *obj, bool gc) {
  WsWriter *w = obj;
  ws_drop_obj(w->stream, gc);
  ws_drop_promise(w->closed.promise, gc);
  ws_drop_promise(w->ready.promise, gc);
}

static const WsObjType ws_writer_type = {ws_writer_trace, ws_writer_drop, "WritableStreamDefaultWriter", ws_writer_accessors};

static void ws_wcontroller_trace(void *obj, ScrTraceVisit visit, void *ctx) {
  WsWController *c = obj;
  ws_visit(c->stream, visit, ctx);
  ws_queue_trace(&c->queue, visit, ctx);
  ws_visit(c->sink, visit, ctx);
  ws_visit(c->write_fn, visit, ctx);
  ws_visit(c->close_fn, visit, ctx);
  ws_visit(c->abort_fn, visit, ctx);
  ws_visit(c->size_fn, visit, ctx);
  ws_visit(c->native_ctx, visit, ctx);
  ws_visit(c->abort_controller, visit, ctx);
  ws_visit(c->aborted_reason, visit, ctx);
}

static void ws_wcontroller_drop(void *obj, bool gc) {
  WsWController *c = obj;
  ws_queue_drop(&c->queue, gc);
  ws_drop_dyn(c->sink, gc);
  ws_drop_dyn(c->write_fn, gc);
  ws_drop_dyn(c->close_fn, gc);
  ws_drop_dyn(c->abort_fn, gc);
  ws_drop_dyn(c->size_fn, gc);
  ws_drop_obj(c->native_ctx, gc);
  ws_drop_dyn(c->abort_controller, gc);
  ws_drop_dyn(c->aborted_reason, gc);
  ws_drop_obj(c->stream, gc);
}

static const WsObjType ws_wcontroller_type = {ws_wcontroller_trace, ws_wcontroller_drop, "WritableStreamDefaultController", ws_wcontroller_accessors};

static ScrDyn *ws_writable_box(WsWritable *s) { return ws_box(s, SCR_DYNH_WS_WRITABLE); }
static ScrDyn *ws_writer_box(WsWriter *w) { return ws_box(w, SCR_DYNH_WS_WRITER); }
static ScrDyn *ws_wcontroller_box(WsWController *c) { return ws_box(c, SCR_DYNH_WS_WCONTROLLER); }

static WsWritable *ws_writable_of(const ScrDyn *d) {
  return d && d->kind == SCR_DYN_HANDLE && d->v.handle.tag == SCR_DYNH_WS_WRITABLE ? d->v.handle.ptr : NULL;
}

/* undefined for a NULL stored value (+1). */
static ScrDyn *ws_or_undef(ScrDyn *d) { return d ? scr_dyn_retain(d) : ws_undef(); }

/* ── records ── */

static void ws_record_set(WsRecord *r, ScrPromise *p, bool live) {
  if (r->promise) scr_promise_release(r->promise);
  r->promise = p;
  r->live = live;
  r->hook = NULL;
  r->hook_ctx = NULL;
}

static void ws_record_clear(WsRecord *r) { ws_record_set(r, NULL, false); }

static bool ws_record_pending(const WsRecord *r) {
  return r->promise && scr_promise_is_pending(r->promise);
}

/* record.resolve?.() */
static void ws_record_resolve(WsRecord *r) {
  if (r->hook) {
    r->hook(r->hook_ctx);
    return;
  }
  if (!r->promise || !r->live || !scr_promise_is_pending(r->promise)) return;
  ScrDyn *u = ws_undef();
  ws_fulfill(r->promise, u);
  scr_dyn_release(u);
}

static void ws_record_reject(WsRecord *r, ScrDyn *reason) {
  if (r->hook || !r->promise || !r->live || !scr_promise_is_pending(r->promise)) return;
  ScrDyn *e = ws_or_undef(reason);
  ws_reject(r->promise, e);
  scr_dyn_release(e);
}

static void ws_record_resolved(WsRecord *r) {
  ScrDyn *u = ws_undef();
  ws_record_set(r, ws_promise_resolved(u), false);
  scr_dyn_release(u);
}

static void ws_record_rejected_handled(WsRecord *r, ScrDyn *reason) {
  ScrDyn *e = ws_or_undef(reason);
  ScrPromise *p = ws_promise_rejected(e);
  scr_dyn_release(e);
  ws_set_handled(p);
  ws_record_set(r, p, false);
}

static void ws_promise_fulfill_undefined(ScrPromise *p) {
  ScrDyn *u = ws_undef();
  ws_fulfill(p, u);
  scr_dyn_release(u);
}

static void ws_promise_reject_with(ScrPromise *p, ScrDyn *reason) {
  ScrDyn *e = ws_or_undef(reason);
  ws_reject(p, e);
  scr_dyn_release(e);
}

/* PromiseReject(e) / PromiseResolve() as boxed values. */
static ScrPromise *ws_promise_rejected_with(ScrDyn *reason) {
  ScrDyn *e = ws_or_undef(reason);
  ScrPromise *p = ws_promise_rejected(e);
  scr_dyn_release(e);
  return p;
}

static ScrPromise *ws_promise_resolved_undefined(void) {
  ScrDyn *u = ws_undef();
  ScrPromise *p = ws_promise_resolved(u);
  scr_dyn_release(u);
  return p;
}

static ScrPromise *ws_promise_state_rejected(const char *message) {
  ScrDyn *error = ws_state_error_value(message);
  ScrPromise *p = ws_promise_rejected(error);
  scr_dyn_release(error);
  return p;
}

/* ── the write request queue ── */

static void ws_requests_push(WsWritable *s, WsWriteRequest q) {
  if (s->requests_len == s->requests_cap) {
    size_t cap = s->requests_cap ? s->requests_cap * 2 : 4;
    WsWriteRequest *requests = malloc(cap * sizeof *requests);
    if (!requests) ws_oom();
    for (size_t i = 0; i < s->requests_len; i++)
      requests[i] = s->requests[(s->requests_head + i) % s->requests_cap];
    free(s->requests);
    s->requests = requests;
    s->requests_head = 0;
    s->requests_cap = cap;
  }
  s->requests[(s->requests_head + s->requests_len) % s->requests_cap] = q;
  s->requests_len++;
}

static WsWriteRequest ws_requests_shift(WsWritable *s) {
  WsWriteRequest p = s->requests[s->requests_head];
  s->requests_head = (s->requests_head + 1) % s->requests_cap;
  s->requests_len--;
  if (!s->requests_len) s->requests_head = 0;
  return p;
}

static void ws_pipe_tracker_resolve(WsPipe *p);
static void ws_pipe_tracker_reject(WsPipe *p, ScrDyn *error);

static bool ws_write_request_live(WsWriteRequest q) { return q.promise || q.tracker; }

/* request.resolve() and request.reject(error); the request's reference
 * goes. */
static void ws_write_request_resolve(WsWriteRequest q) {
  if (q.promise) {
    ws_promise_fulfill_undefined(q.promise);
    scr_promise_release(q.promise);
  } else if (q.tracker) {
    ws_pipe_tracker_resolve(q.tracker);
    ws_release(q.tracker);
  }
}

static void ws_write_request_reject(WsWriteRequest q, ScrDyn *error) {
  ScrDyn *e = ws_or_undef(error);
  if (q.promise) {
    ws_reject(q.promise, e);
    scr_promise_release(q.promise);
  } else if (q.tracker) {
    ws_pipe_tracker_reject(q.tracker, e);
    ws_release(q.tracker);
  }
  scr_dyn_release(e);
}

/* ── the stream's abstract operations ── */

static bool ws_writable_locked(WsWritable *s) { return s->writer != NULL; }

static void ws_wcontroller_advance_queue_if_needed(WsWController *c);
static void ws_wcontroller_clear_algorithms(WsWController *c);
static void ws_writable_finish_erroring(WsWritable *s);

/* writerClosedPromise / writerReadyPromise: the records, materialized. */
static ScrPromise *ws_writer_closed_promise(WsWriter *w) {
  if (!w->closed.promise) {
    WsWritable *s = w->stream;
    if (!s) ws_record_rejected_handled(&w->closed, ws_writer_released_error());
    else if (s->state == WS_W_WRITABLE || s->state == WS_W_ERRORING) ws_record_set(&w->closed, scr_promise_new(), true);
    else if (s->state == WS_W_CLOSED) ws_record_resolved(&w->closed);
    else ws_record_rejected_handled(&w->closed, s->stored_error);
  }
  return w->closed.promise;
}

static ScrPromise *ws_writer_ready_promise(WsWriter *w) {
  if (!w->ready.promise) {
    WsWritable *s = w->stream;
    if (!s) ws_record_rejected_handled(&w->ready, ws_writer_released_error());
    else if (s->state == WS_W_WRITABLE) {
      if (!s->close_queued_or_inflight && s->backpressure) ws_record_set(&w->ready, scr_promise_new(), true);
      else ws_record_resolved(&w->ready);
    } else if (s->state == WS_W_CLOSED) ws_record_resolved(&w->ready);
    else ws_record_rejected_handled(&w->ready, s->stored_error);
  }
  return w->ready.promise;
}

static void ws_writer_ensure_ready_rejected(WsWriter *w, ScrDyn *error) {
  if (ws_record_pending(&w->ready)) {
    ws_record_reject(&w->ready, error);
    ws_set_handled(w->ready.promise);
  } else {
    ws_record_clear(&w->ready);
  }
}

static void ws_writer_ensure_closed_rejected(WsWriter *w, ScrDyn *error) {
  if (ws_record_pending(&w->closed)) {
    ws_record_reject(&w->closed, error);
    ws_set_handled(w->closed.promise);
  } else {
    ws_record_clear(&w->closed);
  }
}

/* abortController.abort(reason) */
static void ws_wcontroller_signal_abort(WsWController *c, ScrDyn *reason) {
  if (c->aborted) return;
  c->aborted = true;
  c->aborted_reason = ws_or_undef(reason);
  if (!c->abort_controller) return;
  ScrDyn *arg = c->aborted_reason;
  ScrDyn *r = scr_dyn_invoke(c->abort_controller, "abort", &arg, 1, "abortController.abort");
  if (r) scr_dyn_release(r);
}

static void ws_writable_start_erroring(WsWritable *s, ScrDyn *reason) {
  WsWController *c = s->controller;
  s->state = WS_W_ERRORING;
  s->stored_error = ws_or_undef(reason);
  if (s->writer) ws_writer_ensure_ready_rejected(s->writer, s->stored_error);
  if (!ws_write_request_live(s->inflight_write) && !s->inflight_close && c->started) ws_writable_finish_erroring(s);
}

static void ws_writable_reject_close_and_closed_if_needed(WsWritable *s) {
  if (s->close_request) {
    ScrPromise *p = s->close_request;
    s->close_request = NULL;
    s->close_queued_or_inflight = false;
    ws_promise_reject_with(p, s->stored_error);
    scr_promise_release(p);
  }
  if (s->writer && ws_record_pending(&s->writer->closed)) {
    ws_set_handled(s->writer->closed.promise);
    ws_record_reject(&s->writer->closed, s->stored_error);
  }
}

/* The abort request's reaction to the sink's abort algorithm. */
typedef struct WsAbortWait {
  WsObj obj;
  WsWritable *stream;
  ScrPromise *abort_request;
} WsAbortWait;

static void ws_abort_wait_trace(void *obj, ScrTraceVisit visit, void *ctx) {
  WsAbortWait *a = obj;
  ws_visit(a->stream, visit, ctx);
  ws_visit(a->abort_request, visit, ctx);
}

static void ws_abort_wait_drop(void *obj, bool gc) {
  WsAbortWait *a = obj;
  ws_drop_obj(a->stream, gc);
  ws_drop_promise(a->abort_request, gc);
}

static const WsObjType ws_abort_wait_type = {ws_abort_wait_trace, ws_abort_wait_drop};

static void ws_abort_sink_fulfilled(void *ctx, ScrDyn *value) {
  (void)value;
  WsAbortWait *a = ctx;
  ws_promise_fulfill_undefined(a->abort_request);
  ws_writable_reject_close_and_closed_if_needed(a->stream);
}

static void ws_abort_sink_rejected(void *ctx, ScrDyn *error) {
  WsAbortWait *a = ctx;
  ws_reject(a->abort_request, error);
  ws_writable_reject_close_and_closed_if_needed(a->stream);
}

/* controller[kAbort](reason): the abort algorithm's promise (+1). */
static ScrPromise *ws_wcontroller_abort_steps(WsWController *c, ScrDyn *reason) {
  ScrPromise *result;
  if (c->algorithms_cleared) {
    result = ws_promise_resolved_undefined();
  } else if (c->native) {
    result = c->native->abort(c->native_ctx, c, reason);
  } else if (c->abort_fn) {
    /* createPromiseCallback1Param: an async arrow around the call. */
    ScrDyn *abort = scr_dyn_retain(c->abort_fn);
    ScrDyn *sink = scr_dyn_retain(c->sink);
    ScrDyn *arg = ws_or_undef(reason);
    ScrDyn *r = ws_call(abort, sink, &arg, 1, "sink.abort");
    scr_dyn_release(arg);
    scr_dyn_release(abort);
    scr_dyn_release(sink);
    if (!r) {
      result = ws_promise_rejected_pending();
    } else {
      result = ws_promise_resolving(r);
      scr_dyn_release(r);
    }
  } else {
    result = ws_promise_resolved_undefined(); /* nonOpCancel */
  }
  ws_wcontroller_clear_algorithms(c);
  return result;
}

static void ws_writable_finish_erroring(WsWritable *s) {
  s->state = WS_W_ERRORED;
  WsWController *c = s->controller;
  /* controller[kError](): resetQueue */
  ws_queue_reset(&c->queue);
  c->queue_total_size = 0;
  ScrDyn *stored = ws_or_undef(s->stored_error);
  while (s->requests_len) ws_write_request_reject(ws_requests_shift(s), stored);
  if (!s->abort_request) {
    ws_writable_reject_close_and_closed_if_needed(s);
    scr_dyn_release(stored);
    return;
  }
  ScrPromise *abort_request = s->abort_request;
  ScrDyn *abort_reason = s->abort_reason;
  bool was_already_erroring = s->abort_was_already_erroring;
  s->abort_request = NULL;
  s->abort_reason = NULL;
  s->abort_was_already_erroring = false;
  if (was_already_erroring) {
    ws_reject(abort_request, stored);
    ws_writable_reject_close_and_closed_if_needed(s);
    scr_promise_release(abort_request);
    if (abort_reason) scr_dyn_release(abort_reason);
    scr_dyn_release(stored);
    return;
  }
  /* The closed promises reject once the sink's abort settles: materialize
   * them now, so an observation in between sees them pending. */
  if (s->writer && !s->writer->closed.promise) ws_record_set(&s->writer->closed, scr_promise_new(), true);
  ScrPromise *sink = ws_wcontroller_abort_steps(c, abort_reason);
  WsAbortWait *a = ws_obj_new(sizeof *a, &ws_abort_wait_type);
  a->stream = ws_retain(s);
  a->abort_request = abort_request; /* the reference moves */
  ws_then(sink, ws_abort_sink_fulfilled, ws_abort_sink_rejected, a, false);
  scr_promise_release(sink);
  if (abort_reason) scr_dyn_release(abort_reason);
  scr_dyn_release(stored);
}

static void ws_writable_deal_with_rejection(WsWritable *s, ScrDyn *error) {
  if (s->state == WS_W_WRITABLE) {
    ws_writable_start_erroring(s, error);
    return;
  }
  ws_writable_finish_erroring(s);
}

/* writableStreamAbort: +1 promise. */
static ScrPromise *ws_writable_abort(WsWritable *s, ScrDyn *reason) {
  if (s->state == WS_W_CLOSED || s->state == WS_W_ERRORED) return ws_promise_resolved_undefined();
  ws_wcontroller_signal_abort(s->controller, reason);
  if (s->state == WS_W_CLOSED || s->state == WS_W_ERRORED) return ws_promise_resolved_undefined();
  if (s->abort_request) return scr_promise_retain(s->abort_request);
  bool was_already_erroring = false;
  if (s->state == WS_W_ERRORING) {
    was_already_erroring = true;
    reason = NULL;
  }
  s->abort_request = scr_promise_new();
  s->abort_reason = reason && reason->kind != SCR_DYN_UNDEF ? scr_dyn_retain(reason) : NULL;
  s->abort_was_already_erroring = was_already_erroring;
  ScrPromise *result = scr_promise_retain(s->abort_request);
  if (!was_already_erroring) ws_writable_start_erroring(s, reason);
  return result;
}

static void ws_wcontroller_close(WsWController *c);

/* writableStreamClose: +1 promise. */
static ScrPromise *ws_writable_close(WsWritable *s) {
  if (s->state == WS_W_CLOSED || s->state == WS_W_ERRORED)
    return ws_promise_state_rejected("WritableStream is closed");
  s->close_request = scr_promise_new();
  s->close_queued_or_inflight = true;
  ScrPromise *result = scr_promise_retain(s->close_request);
  if (s->writer && s->backpressure && s->state == WS_W_WRITABLE) ws_record_resolve(&s->writer->ready);
  ws_wcontroller_close(s->controller);
  return result;
}

static void ws_writable_update_backpressure(WsWController *c, WsWritable *s) {
  bool backpressure = c->high_water_mark - c->queue_total_size <= 0;
  bool changed = s->backpressure != backpressure;
  s->backpressure = backpressure;
  if (s->writer && changed) {
    if (backpressure) ws_record_clear(&s->writer->ready);
    else ws_record_resolve(&s->writer->ready);
  }
}

static void ws_writable_finish_inflight_write(WsWritable *s) {
  WsWriteRequest q = s->inflight_write;
  s->inflight_write = (WsWriteRequest){NULL, NULL};
  ws_write_request_resolve(q);
}

static void ws_writable_finish_inflight_write_with_error(WsWritable *s, ScrDyn *error) {
  WsWriteRequest q = s->inflight_write;
  s->inflight_write = (WsWriteRequest){NULL, NULL};
  ws_write_request_reject(q, error);
  ws_writable_deal_with_rejection(s, error);
}

static void ws_writable_finish_inflight_close(WsWritable *s) {
  ScrPromise *p = s->inflight_close;
  s->inflight_close = NULL;
  s->close_queued_or_inflight = false;
  ws_promise_fulfill_undefined(p);
  scr_promise_release(p);
  if (s->state == WS_W_ERRORING) {
    if (s->stored_error) scr_dyn_release(s->stored_error);
    s->stored_error = NULL;
    if (s->abort_request) {
      ScrPromise *a = s->abort_request;
      s->abort_request = NULL;
      if (s->abort_reason) scr_dyn_release(s->abort_reason);
      s->abort_reason = NULL;
      ws_promise_fulfill_undefined(a);
      scr_promise_release(a);
    }
  }
  s->state = WS_W_CLOSED;
  if (s->writer) ws_record_resolve(&s->writer->closed);
}

static void ws_writable_finish_inflight_close_with_error(WsWritable *s, ScrDyn *error) {
  ScrPromise *p = s->inflight_close;
  s->inflight_close = NULL;
  s->close_queued_or_inflight = false;
  ws_reject(p, error);
  scr_promise_release(p);
  if (s->abort_request) {
    ScrPromise *a = s->abort_request;
    s->abort_request = NULL;
    if (s->abort_reason) scr_dyn_release(s->abort_reason);
    s->abort_reason = NULL;
    ws_reject(a, error);
    scr_promise_release(a);
  }
  ws_writable_deal_with_rejection(s, error);
}

/* ── the writer ── */

static WsWriter *ws_writer_new(WsWritable *s) {
  if (ws_writable_locked(s)) {
    ws_state_error("WritableStream is locked");
    return NULL;
  }
  WsWriter *w = ws_obj_new(sizeof *w, &ws_writer_type);
  w->stream = ws_retain(s);
  s->writer = ws_retain(w);
  return w;
}

static void ws_writer_release_lock(WsWriter *w) {
  WsWritable *s = w->stream;
  ScrDyn *released = ws_writer_released_error();
  ws_writer_ensure_ready_rejected(w, released);
  ws_writer_ensure_closed_rejected(w, released);
  s->writer = NULL;
  w->stream = NULL;
  ws_release(w); /* the stream's reference */
  ws_release(s);
}

static ScrDyn *ws_writer_desired_size(WsWriter *w) {
  WsWritable *s = w->stream;
  switch (s->state) {
  case WS_W_ERRORED:
  case WS_W_ERRORING: return scr_dyn_new_null();
  case WS_W_CLOSED: return scr_dyn_new_num(0);
  default: return scr_dyn_new_num(s->controller->high_water_mark - s->controller->queue_total_size);
  }
}

/* writableStreamDefaultControllerGetChunkSize: the size algorithm's raw
 * result (+1), or NULL for 1. */
static ScrDyn *ws_wcontroller_chunk_size(WsWController *c, ScrDyn *chunk);
static void ws_wcontroller_write(WsWController *c, ScrDyn *chunk, ScrDyn *size);

/* writableStreamDefaultWriterWrite: +1 promise. */
static ScrPromise *ws_writer_write(WsWriter *w, ScrDyn *chunk) {
  WsWritable *s = w->stream;
  ws_retain(s);
  WsWController *c = s->controller;
  ScrDyn *size = ws_wcontroller_chunk_size(c, chunk);
  ScrPromise *result;
  if (s != w->stream) result = ws_promise_state_rejected("Mismatched WritableStreams");
  else if (s->state == WS_W_ERRORED) result = ws_promise_rejected_with(s->stored_error);
  else if (s->close_queued_or_inflight || s->state == WS_W_CLOSED)
    result = ws_promise_state_rejected("WritableStream is closed");
  else if (s->state == WS_W_ERRORING) result = ws_promise_rejected_with(s->stored_error);
  else {
    ScrPromise *request = scr_promise_new();
    ws_requests_push(s, (WsWriteRequest){request, NULL});
    result = scr_promise_retain(request);
    ws_wcontroller_write(c, chunk, size);
  }
  if (size) scr_dyn_release(size);
  ws_release(s);
  return result;
}

/* ── the default controller ── */

static void ws_wcontroller_clear_algorithms(WsWController *c) {
  if (c->algorithms_cleared) return;
  c->algorithms_cleared = true;
  ScrDyn *sink = c->sink, *write = c->write_fn, *close = c->close_fn, *abort = c->abort_fn, *size = c->size_fn;
  void *native_ctx = c->native_ctx;
  c->sink = c->write_fn = c->close_fn = c->abort_fn = c->size_fn = NULL;
  c->native_ctx = NULL;
  if (sink) scr_dyn_release(sink);
  if (write) scr_dyn_release(write);
  if (close) scr_dyn_release(close);
  if (abort) scr_dyn_release(abort);
  if (size) scr_dyn_release(size);
  ws_release(native_ctx);
}

static void ws_wcontroller_error(WsWController *c, ScrDyn *error) {
  ws_wcontroller_clear_algorithms(c);
  ws_writable_start_erroring(c->stream, error);
}

static void ws_wcontroller_error_if_needed(WsWController *c, ScrDyn *error) {
  if (c->stream->state == WS_W_WRITABLE) ws_wcontroller_error(c, error);
}

static ScrDyn *ws_wcontroller_chunk_size(WsWController *c, ScrDyn *chunk) {
  if (c->algorithms_cleared || !c->size_fn) return NULL;
  ScrDyn *size_fn = scr_dyn_retain(c->size_fn);
  ScrDyn *size = ws_call(size_fn, scr_dyn_undefined(), &chunk, 1, "strategy.size");
  scr_dyn_release(size_fn);
  if (!size) {
    ScrDyn *error = ws_take_pending();
    ws_wcontroller_error_if_needed(c, error);
    scr_dyn_release(error);
  }
  return size;
}

/* writableStreamDefaultControllerWrite: enqueueValueWithSize coerces the
 * size; a failure errors the stream. */
static void ws_wcontroller_write(WsWController *c, ScrDyn *chunk, ScrDyn *size_value) {
  double size = 1;
  if (size_value) {
    size = scr_dyn_number_coerce(size_value);
    if (!scr_exc_pending() && (isnan(size) || size < 0 || isinf(size))) ws_range_arg_value("size", size_value);
    if (scr_exc_pending()) {
      ScrDyn *error = ws_take_pending();
      ws_wcontroller_error_if_needed(c, error);
      scr_dyn_release(error);
      return;
    }
  }
  ws_queue_push(&c->queue, chunk, size);
  c->queue_total_size += size;
  WsWritable *s = c->stream;
  if (!s->close_queued_or_inflight && s->state == WS_W_WRITABLE) ws_writable_update_backpressure(c, s);
  ws_wcontroller_advance_queue_if_needed(c);
}

static void ws_wcontroller_close(WsWController *c) {
  ws_queue_push(&c->queue, &ws_close_sentinel, 0);
  ws_wcontroller_advance_queue_if_needed(c);
}

static void ws_write_fulfilled(void *ctx, ScrDyn *value) {
  (void)value;
  WsWController *c = ctx;
  WsWritable *s = c->stream;
  ws_writable_finish_inflight_write(s);
  double size;
  ScrDyn *chunk = ws_queue_shift(&c->queue, &size);
  scr_dyn_release(chunk);
  c->queue_total_size = fmax(0, c->queue_total_size - size);
  if (!s->close_queued_or_inflight && s->state == WS_W_WRITABLE) ws_writable_update_backpressure(c, s);
  ws_wcontroller_advance_queue_if_needed(c);
}

static void ws_write_rejected(void *ctx, ScrDyn *error) {
  WsWController *c = ctx;
  if (c->stream->state == WS_W_WRITABLE) ws_wcontroller_clear_algorithms(c);
  ws_writable_finish_inflight_write_with_error(c->stream, error);
}

static void ws_wcontroller_process_write(WsWController *c, ScrDyn *chunk) {
  WsWritable *s = c->stream;
  s->inflight_write = ws_requests_shift(s);
  ScrDyn *result;
  if (c->native) {
    result = c->native->write(c->native_ctx, c, chunk);
  } else if (c->write_fn) {
    ScrDyn *controller = ws_wcontroller_box(c);
    ScrDyn *write = scr_dyn_retain(c->write_fn);
    ScrDyn *sink = scr_dyn_retain(c->sink);
    ScrDyn *args[2] = {chunk, controller};
    result = ws_call(write, sink, args, 2, "sink.write");
    scr_dyn_release(write);
    scr_dyn_release(sink);
    scr_dyn_release(controller);
  } else {
    result = ws_undef(); /* nonOpCallback */
  }
  if (result == WS_PARKED) return;
  if (!result) {
    ScrPromise *rejected = ws_promise_rejected_pending();
    ws_then(rejected, ws_write_fulfilled, ws_write_rejected, ws_retain(c), false);
    scr_promise_release(rejected);
    return;
  }
  ws_then_algorithm_result(result, ws_write_fulfilled, ws_write_rejected, c);
  scr_dyn_release(result);
}

static void ws_close_fulfilled(void *ctx, ScrDyn *value) {
  (void)value;
  ws_writable_finish_inflight_close(((WsWController *)ctx)->stream);
}

static void ws_close_rejected(void *ctx, ScrDyn *error) {
  ws_writable_finish_inflight_close_with_error(((WsWController *)ctx)->stream, error);
}

static void ws_wcontroller_process_close(WsWController *c) {
  WsWritable *s = c->stream;
  s->inflight_close = s->close_request;
  s->close_request = NULL;
  double size;
  ScrDyn *sentinel = ws_queue_shift(&c->queue, &size);
  (void)sentinel;
  c->queue_total_size = fmax(0, c->queue_total_size - size);
  ScrPromise *sink_close;
  if (c->native) {
    sink_close = c->native->close(c->native_ctx, c);
  } else if (c->close_fn) {
    /* createPromiseCallbackNoParams: an async arrow around the call. */
    ScrDyn *close = scr_dyn_retain(c->close_fn);
    ScrDyn *sink = scr_dyn_retain(c->sink);
    ScrDyn *r = ws_call(close, sink, NULL, 0, "sink.close");
    scr_dyn_release(close);
    scr_dyn_release(sink);
    if (!r) {
      sink_close = ws_promise_rejected_pending();
    } else {
      sink_close = ws_promise_resolving(r);
      scr_dyn_release(r);
    }
  } else {
    sink_close = ws_promise_resolved_undefined(); /* nonOpCancel */
  }
  ws_wcontroller_clear_algorithms(c);
  ws_then(sink_close, ws_close_fulfilled, ws_close_rejected, ws_retain(c), false);
  scr_promise_release(sink_close);
}

static void ws_wcontroller_advance_queue_if_needed(WsWController *c) {
  WsWritable *s = c->stream;
  if (!c->started || ws_write_request_live(s->inflight_write)) return;
  if (s->state == WS_W_ERRORING) {
    ws_writable_finish_erroring(s);
    return;
  }
  if (!c->queue.length) return;
  ScrDyn *value = c->queue.values[c->queue.head];
  if (value == &ws_close_sentinel) ws_wcontroller_process_close(c);
  else ws_wcontroller_process_write(c, value);
}

static void ws_wstart_fulfilled(void *ctx, ScrDyn *value) {
  (void)value;
  WsWController *c = ctx;
  c->started = true;
  ws_wcontroller_advance_queue_if_needed(c);
}

static void ws_wstart_rejected(void *ctx, ScrDyn *error) {
  WsWController *c = ctx;
  c->started = true;
  ws_writable_deal_with_rejection(c->stream, error);
}

/* setupWritableStreamDefaultController after the algorithms are in place. */
static void ws_wcontroller_started_with(WsWController *c, ScrDyn *start_result) {
  if (!ws_is_object(start_result)) {
    ws_queue_microtask(ws_wstart_fulfilled, ws_retain(c));
    return;
  }
  ScrPromise *p = ws_promise_resolving(start_result);
  if (!p) p = ws_promise_rejected_pending();
  ws_then(p, ws_wstart_fulfilled, ws_wstart_rejected, ws_retain(c), false);
  scr_promise_release(p);
}

static WsWController *ws_writable_attach(WsWritable *s, double high_water_mark) {
  WsWController *c = ws_obj_new(sizeof *c, &ws_wcontroller_type);
  c->stream = ws_retain(s);
  c->high_water_mark = high_water_mark;
  s->controller = c; /* the stream's reference */
  ws_writable_update_backpressure(c, s);
  return c;
}

static WsWritable *ws_writable_alloc(void) {
  WsWritable *s = ws_obj_new(sizeof *s, &ws_writable_type);
  s->state = WS_W_WRITABLE;
  return s;
}

/* The signal getter: the AbortController's signal, made on first read. */
static ScrDyn *ws_wcontroller_signal(WsWController *c) {
  if (!c->abort_controller) {
    c->abort_controller = scr_fetch_abort_controller_new();
    if (c->aborted) {
      ScrDyn *arg = c->aborted_reason;
      ScrDyn *r = scr_dyn_invoke(c->abort_controller, "abort", &arg, 1, "abortController.abort");
      if (!r) return NULL;
      scr_dyn_release(r);
    }
  }
  ScrStr *key = scr_str_new("signal", 6);
  ScrDyn *signal = scr_dyn_handle_key_get(c->abort_controller, key);
  scr_str_release(key);
  return signal;
}

/* Bind must be called on a function: Function.prototype.bind on a start
 * member that is not callable. */
static void ws_bind_error(void) {
  static const char message[] = "Bind must be called on a function";
  scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
}

/* new WritableStream(sink, strategy): +1 handle, or NULL with the
 * exception pending. */
static ScrDyn *ws_writable_construct(ScrDyn *const *args, size_t argc) {
  ScrDyn *sink = argc > 0 && args[0]->kind != SCR_DYN_UNDEF ? args[0] : NULL;
  ScrDyn *strategy = argc > 1 && args[1]->kind != SCR_DYN_UNDEF ? args[1] : NULL;
  ScrDyn *empty = NULL;
  if (!sink || !strategy) empty = scr_dyn_new_obj();
  if (!sink) sink = empty;
  if (!strategy) strategy = empty;
  ScrDyn *result = NULL;
  ScrDyn *type = NULL, *size = NULL, *hwm = NULL, *start = NULL, *write = NULL, *close = NULL, *abort = NULL;
  if (!ws_validate_object(sink, "sink", false) || !ws_validate_object(strategy, "strategy", true)) goto done;
  if (!(type = ws_get(sink, "type"))) goto done;
  if (type->kind != SCR_DYN_UNDEF) {
    ws_range_arg_value("type", type);
    goto done;
  }
  if (!(size = ws_get(strategy, "size"))) goto done;
  if (size->kind != SCR_DYN_UNDEF && !ws_validate_function(size, "strategy.size")) goto done;
  if (!(hwm = ws_get(strategy, "highWaterMark"))) goto done;
  double high_water_mark;
  if (!ws_extract_high_water_mark(hwm, 1, &high_water_mark)) goto done;
  if (!(start = ws_get(sink, "start"))) goto done;
  if (!(write = ws_get(sink, "write"))) goto done;
  if (!(close = ws_get(sink, "close"))) goto done;
  if (!(abort = ws_get(sink, "abort"))) goto done;
  bool has_start = scr_dyn_truthy(start), has_write = scr_dyn_truthy(write);
  bool has_close = scr_dyn_truthy(close), has_abort = scr_dyn_truthy(abort);
  if (has_start && !scr_dyn_is_callable(start)) {
    ws_bind_error();
    goto done;
  }
  if (has_write && !ws_validate_function(write, "sink.write")) goto done;
  if (has_close && !ws_validate_function(close, "sink.close")) goto done;
  if (has_abort && !ws_validate_function(abort, "sink.abort")) goto done;
  ws_install();
  WsWritable *s = ws_writable_alloc();
  WsWController *c = ws_writable_attach(s, high_water_mark);
  c->sink = scr_dyn_retain(sink);
  if (has_write) c->write_fn = scr_dyn_retain(write);
  if (has_close) c->close_fn = scr_dyn_retain(close);
  if (has_abort) c->abort_fn = scr_dyn_retain(abort);
  if (size->kind != SCR_DYN_UNDEF) c->size_fn = scr_dyn_retain(size);
  ScrDyn *start_result;
  if (has_start) {
    ScrDyn *controller = ws_wcontroller_box(c);
    start_result = ws_call(start, sink, &controller, 1, "sink.start");
    scr_dyn_release(controller);
  } else {
    start_result = ws_undef();
  }
  if (!start_result) {
    ws_release(s);
    goto done;
  }
  ws_wcontroller_started_with(c, start_result);
  scr_dyn_release(start_result);
  result = ws_writable_box(s);
  ws_release(s);
done:
  if (empty) scr_dyn_release(empty);
  if (type) scr_dyn_release(type);
  if (size) scr_dyn_release(size);
  if (hwm) scr_dyn_release(hwm);
  if (start) scr_dyn_release(start);
  if (write) scr_dyn_release(write);
  if (close) scr_dyn_release(close);
  if (abort) scr_dyn_release(abort);
  return result;
}

/* ── TransformStream (lib/internal/webstreams/transformstream.js) ── */

typedef struct WsTransform WsTransform;
typedef struct WsTController WsTController;

static ScrDyn *ws_promise_box(ScrPromise *p);

struct WsTransform {
  WsObj obj;
  WsReadable *readable; /* +1 */
  WsWritable *writable; /* +1 */
  WsTController *controller;
  bool backpressure;
  /* The continuation slots that stand for [[backpressureChangePromise]]. */
  bool pull_pending;
  bool pending_write_parked;
  ScrDyn *pending_write_chunk; /* +1 */
};

struct WsTController {
  WsObj obj;
  WsTransform *stream; /* +1 */
  bool algorithms_cleared;
  ScrDyn *transformer;
  ScrDyn *transform_fn; /* NULL = the default transform (enqueue) */
  ScrDyn *flush_fn;
  ScrDyn *cancel_fn;
  ScrPromise *finish_promise; /* +1 */
};

static void ws_transform_trace(void *obj, ScrTraceVisit visit, void *ctx) {
  WsTransform *t = obj;
  ws_visit(t->readable, visit, ctx);
  ws_visit(t->writable, visit, ctx);
  ws_visit(t->controller, visit, ctx);
  ws_visit(t->pending_write_chunk, visit, ctx);
}

static void ws_transform_drop(void *obj, bool gc) {
  WsTransform *t = obj;
  ws_drop_obj(t->readable, gc);
  ws_drop_obj(t->writable, gc);
  ws_drop_obj(t->controller, gc);
  ws_drop_dyn(t->pending_write_chunk, gc);
}

static const WsObjType ws_transform_type = {ws_transform_trace, ws_transform_drop, "TransformStream", ws_transform_accessors};

static void ws_tcontroller_trace(void *obj, ScrTraceVisit visit, void *ctx) {
  WsTController *c = obj;
  ws_visit(c->stream, visit, ctx);
  ws_visit(c->transformer, visit, ctx);
  ws_visit(c->transform_fn, visit, ctx);
  ws_visit(c->flush_fn, visit, ctx);
  ws_visit(c->cancel_fn, visit, ctx);
  ws_visit(c->finish_promise, visit, ctx);
}

static void ws_tcontroller_drop(void *obj, bool gc) {
  WsTController *c = obj;
  ws_drop_obj(c->stream, gc);
  ws_drop_dyn(c->transformer, gc);
  ws_drop_dyn(c->transform_fn, gc);
  ws_drop_dyn(c->flush_fn, gc);
  ws_drop_dyn(c->cancel_fn, gc);
  ws_drop_promise(c->finish_promise, gc);
}

static const WsObjType ws_tcontroller_type = {ws_tcontroller_trace, ws_tcontroller_drop, "TransformStreamDefaultController", ws_tcontroller_accessors};

static ScrDyn *ws_transform_box(WsTransform *t) { return ws_box(t, SCR_DYNH_WS_TRANSFORM); }
static ScrDyn *ws_tcontroller_box(WsTController *c) { return ws_box(c, SCR_DYNH_WS_TCONTROLLER); }

static void ws_tcontroller_clear_algorithms(WsTController *c) {
  if (c->algorithms_cleared) return;
  c->algorithms_cleared = true;
  ScrDyn *transformer = c->transformer, *transform = c->transform_fn, *flush = c->flush_fn, *cancel = c->cancel_fn;
  c->transformer = c->transform_fn = c->flush_fn = c->cancel_fn = NULL;
  if (transformer) scr_dyn_release(transformer);
  if (transform) scr_dyn_release(transform);
  if (flush) scr_dyn_release(flush);
  if (cancel) scr_dyn_release(cancel);
}

/* The parked write's continuation when the writable side errored
 * meanwhile: the write reaction rejects with its stored error. */
typedef struct WsWriteReject {
  WsObj obj;
  WsWController *controller;
  ScrDyn *error;
} WsWriteReject;

static void ws_write_reject_trace(void *obj, ScrTraceVisit visit, void *ctx) {
  WsWriteReject *r = obj;
  ws_visit(r->controller, visit, ctx);
  ws_visit(r->error, visit, ctx);
}

static void ws_write_reject_drop(void *obj, bool gc) {
  WsWriteReject *r = obj;
  ws_drop_obj(r->controller, gc);
  ws_drop_dyn(r->error, gc);
}

static const WsObjType ws_write_reject_type = {ws_write_reject_trace, ws_write_reject_drop};

static void ws_write_reject_step(void *ctx, ScrDyn *unused) {
  (void)unused;
  WsWriteReject *r = ctx;
  ws_write_rejected(r->controller, r->error);
}

static ScrPromise *ws_tcontroller_perform_transform(WsTController *c, ScrDyn *chunk);

/* writeContinuation: completes the parked write. */
static void ws_transform_write_continuation(void *ctx, ScrDyn *unused) {
  (void)unused;
  WsTransform *t = ctx;
  ScrDyn *chunk = t->pending_write_chunk;
  t->pending_write_parked = false;
  t->pending_write_chunk = NULL;
  WsWritable *w = t->writable;
  WsWController *wc = w->controller;
  if (w->state == WS_W_ERRORING) {
    WsWriteReject *r = ws_obj_new(sizeof *r, &ws_write_reject_type);
    r->controller = ws_retain(wc);
    r->error = ws_or_undef(w->stored_error);
    ws_queue_microtask(ws_write_reject_step, r);
    if (chunk) scr_dyn_release(chunk);
    return;
  }
  ScrDyn *value = chunk ? chunk : ws_undef();
  ScrPromise *result = ws_tcontroller_perform_transform(t->controller, value);
  scr_dyn_release(value);
  ws_then(result, ws_write_fulfilled, ws_write_rejected, ws_retain(wc), false);
  scr_promise_release(result);
}

/* transformStreamSetBackpressure. */
static void ws_transform_set_backpressure(WsTransform *t, bool backpressure) {
  t->backpressure = backpressure;
  if (backpressure) {
    if (t->pull_pending) {
      t->pull_pending = false;
      ws_queue_microtask(ws_pull_fulfilled, ws_retain(t->readable->controller));
    }
  } else if (t->pending_write_parked) {
    ws_queue_microtask(ws_transform_write_continuation, ws_retain(t));
  }
}

static void ws_transform_unblock_write(WsTransform *t) {
  if (t->backpressure) ws_transform_set_backpressure(t, false);
}

static void ws_transform_error_writable_and_unblock_write(WsTransform *t, ScrDyn *error) {
  ws_tcontroller_clear_algorithms(t->controller);
  ws_wcontroller_error_if_needed(t->writable->controller, error);
  ws_transform_unblock_write(t);
}

static void ws_transform_error(WsTransform *t, ScrDyn *error) {
  ws_rcontroller_error(t->readable->controller, error);
  ws_transform_error_writable_and_unblock_write(t, error);
}

/* transformStreamDefaultControllerEnqueue: false with the exception
 * pending. */
static bool ws_tcontroller_enqueue(WsTController *c, ScrDyn *chunk) {
  WsTransform *t = c->stream;
  WsRController *rc = t->readable->controller;
  if (!ws_rcontroller_can_close_or_enqueue(rc)) {
    ws_state_error("Unable to enqueue");
    return false;
  }
  if (!ws_rcontroller_enqueue(rc, chunk)) {
    ScrDyn *error = ws_take_pending();
    ws_transform_error_writable_and_unblock_write(t, error);
    scr_dyn_release(error);
    scr_dyn_throw(ws_or_undef(t->readable->stored_error));
    return false;
  }
  bool backpressure = !ws_rcontroller_should_call_pull(rc);
  if (backpressure != t->backpressure) ws_transform_set_backpressure(t, true);
  return true;
}

static void ws_tcontroller_terminate(WsTController *c) {
  WsTransform *t = c->stream;
  ws_retain(t);
  ws_rcontroller_close(t->readable->controller);
  ScrDyn *error = ws_state_error_value("TransformStream has been terminated");
  ws_transform_error_writable_and_unblock_write(t, error);
  scr_dyn_release(error);
  ws_release(t);
}

/* The perform-transform rejection step: errors the stream, then rethrows
 * so the derived promise rejects with the error. */
static void ws_perform_transform_rejected(void *ctx, ScrDyn *error) {
  WsTController *c = ctx;
  ws_transform_error(c->stream, error);
  scr_dyn_throw(scr_dyn_retain(error));
}

/* transformStreamDefaultControllerPerformTransform: +1 promise. */
static ScrPromise *ws_tcontroller_perform_transform(WsTController *c, ScrDyn *chunk) {
  if (c->algorithms_cleared) return scr_promise_retain(ws_resolved_singleton());
  ScrDyn *result;
  if (c->transform_fn) {
    ScrDyn *controller = ws_tcontroller_box(c);
    ScrDyn *transform = scr_dyn_retain(c->transform_fn);
    ScrDyn *transformer = scr_dyn_retain(c->transformer);
    ScrDyn *args[2] = {chunk, controller};
    result = ws_call(transform, transformer, args, 2, "transformer.transform");
    scr_dyn_release(transform);
    scr_dyn_release(transformer);
    scr_dyn_release(controller);
  } else {
    /* defaultTransformAlgorithm */
    result = ws_tcontroller_enqueue(c, chunk) ? ws_undef() : NULL;
  }
  ScrPromise *p;
  if (!result) {
    p = ws_promise_rejected_pending();
  } else if (!ws_is_object(result)) {
    p = scr_promise_retain(ws_resolved_singleton());
  } else {
    p = ws_promise_resolve(result);
    if (!p) p = ws_promise_rejected_pending();
  }
  if (result) scr_dyn_release(result);
  ScrPromise *derived = ws_then(p, NULL, ws_perform_transform_rejected, ws_retain(c), true);
  scr_promise_release(p);
  return derived;
}

/* The steps the sink close, sink abort and source cancel algorithms run on
 * their callback's promise. */
typedef enum { WS_FINISH_CLOSE, WS_FINISH_ABORT, WS_FINISH_CANCEL } WsFinishKind;

typedef struct WsFinish {
  WsObj obj;
  WsTransform *stream;
  ScrPromise *finish; /* +1 */
  ScrDyn *reason;     /* +1, the abort or cancel reason */
  WsFinishKind kind;
} WsFinish;

static void ws_finish_trace(void *obj, ScrTraceVisit visit, void *ctx) {
  WsFinish *f = obj;
  ws_visit(f->stream, visit, ctx);
  ws_visit(f->finish, visit, ctx);
  ws_visit(f->reason, visit, ctx);
}

static void ws_finish_drop(void *obj, bool gc) {
  WsFinish *f = obj;
  ws_drop_obj(f->stream, gc);
  ws_drop_promise(f->finish, gc);
  ws_drop_dyn(f->reason, gc);
}

static const WsObjType ws_finish_type = {ws_finish_trace, ws_finish_drop};

static void ws_finish_fulfilled(void *ctx, ScrDyn *unused) {
  (void)unused;
  WsFinish *f = ctx;
  WsTransform *t = f->stream;
  if (f->kind == WS_FINISH_CANCEL) {
    WsWritable *w = t->writable;
    if (w->state == WS_W_ERRORED) {
      ws_promise_reject_with(f->finish, w->stored_error);
      return;
    }
    ws_wcontroller_error_if_needed(w->controller, f->reason);
    ws_transform_unblock_write(t);
    ws_promise_fulfill_undefined(f->finish);
    return;
  }
  WsReadable *r = t->readable;
  if (r->state == WS_STATE_ERRORED) {
    ws_promise_reject_with(f->finish, r->stored_error);
    return;
  }
  if (f->kind == WS_FINISH_CLOSE) ws_rcontroller_close(r->controller);
  else ws_rcontroller_error(r->controller, f->reason);
  ws_promise_fulfill_undefined(f->finish);
}

static void ws_finish_rejected(void *ctx, ScrDyn *error) {
  WsFinish *f = ctx;
  WsTransform *t = f->stream;
  if (f->kind == WS_FINISH_CANCEL) {
    ws_wcontroller_error_if_needed(t->writable->controller, error);
    ws_transform_unblock_write(t);
  } else {
    ws_rcontroller_error(t->readable->controller, error);
  }
  ws_reject(f->finish, error);
}

/* A transformer callback wrapped by createPromiseCallback1Param, or the
 * nonOp default: +1 promise. */
static ScrPromise *ws_tcontroller_callback(WsTController *c, ScrDyn *fn, ScrDyn *arg, const char *what) {
  if (!fn) return ws_promise_resolved_undefined();
  ScrDyn *callee = scr_dyn_retain(fn);
  ScrDyn *transformer = scr_dyn_retain(c->transformer);
  ScrDyn *r = ws_call(callee, transformer, &arg, 1, what);
  scr_dyn_release(callee);
  scr_dyn_release(transformer);
  if (!r) return ws_promise_rejected_pending();
  ScrPromise *p = ws_promise_resolving(r);
  scr_dyn_release(r);
  return p;
}

/* The finish promise of the transform's close, abort or cancel: +1. */
static ScrPromise *ws_transform_finish(WsTransform *t, WsFinishKind kind, ScrDyn *reason) {
  WsTController *c = t->controller;
  if (c->finish_promise) return scr_promise_retain(c->finish_promise);
  c->finish_promise = scr_promise_new();
  ScrPromise *callback;
  if (kind == WS_FINISH_CLOSE) {
    ScrDyn *controller = ws_tcontroller_box(c);
    callback = ws_tcontroller_callback(c, c->flush_fn, controller, "transformer.flush");
    scr_dyn_release(controller);
  } else {
    ScrDyn *arg = ws_or_undef(reason);
    callback = ws_tcontroller_callback(c, c->cancel_fn, arg, "transformer.cancel");
    scr_dyn_release(arg);
  }
  ws_tcontroller_clear_algorithms(c);
  WsFinish *f = ws_obj_new(sizeof *f, &ws_finish_type);
  f->stream = ws_retain(t);
  f->finish = scr_promise_retain(c->finish_promise);
  f->reason = ws_or_undef(reason);
  f->kind = kind;
  ws_then(callback, ws_finish_fulfilled, ws_finish_rejected, f, false);
  scr_promise_release(callback);
  return scr_promise_retain(c->finish_promise);
}

/* The writable side's algorithms. */
static ScrDyn *ws_transform_sink_write(void *ctx, WsWController *wc, ScrDyn *chunk) {
  (void)wc;
  WsTransform *t = ctx;
  if (t->backpressure) {
    t->pending_write_parked = true;
    t->pending_write_chunk = scr_dyn_retain(chunk);
    return WS_PARKED;
  }
  return ws_promise_box(ws_tcontroller_perform_transform(t->controller, chunk));
}

static ScrPromise *ws_transform_sink_close(void *ctx, WsWController *wc) {
  (void)wc;
  return ws_transform_finish(ctx, WS_FINISH_CLOSE, NULL);
}

/* `async function transformStreamDefaultSinkAbortAlgorithm`: the result
 * adopts the finish promise. */
static ScrPromise *ws_transform_sink_abort(void *ctx, WsWController *wc, ScrDyn *reason) {
  (void)wc;
  ScrPromise *finish = ws_transform_finish(ctx, WS_FINISH_ABORT, reason);
  ScrDyn *box = ws_promise_box(finish);
  ScrPromise *result = ws_promise_resolving(box);
  scr_dyn_release(box);
  return result;
}

static const WsSinkOps ws_transform_sink_ops = {ws_transform_sink_write, ws_transform_sink_close,
                                                ws_transform_sink_abort};

/* The readable side's algorithms. */
static ScrDyn *ws_transform_source_pull(void *ctx, WsRController *rc) {
  (void)rc;
  WsTransform *t = ctx;
  ws_transform_set_backpressure(t, false);
  t->pull_pending = true;
  return WS_PARKED;
}

static ScrPromise *ws_transform_source_cancel(void *ctx, WsRController *rc, ScrDyn *reason) {
  (void)rc;
  return ws_transform_finish(ctx, WS_FINISH_CANCEL, reason);
}

static const WsSourceOps ws_transform_source_ops = {ws_transform_source_pull, ws_transform_source_cancel};

/* `start` called through FunctionPrototypeCall: a value that is not
 * callable throws its TypeError. */
static void ws_function_call_error(void) {
  static const char message[] = "FunctionPrototypeCall is not a function";
  scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
}

/* new TransformStream(transformer, writableStrategy, readableStrategy):
 * +1 handle, or NULL with the exception pending. */
static ScrDyn *ws_transform_construct(ScrDyn *const *args, size_t argc) {
  ScrDyn *transformer = argc > 0 && args[0]->kind != SCR_DYN_UNDEF ? args[0] : NULL;
  ScrDyn *wstrategy = argc > 1 && args[1]->kind != SCR_DYN_UNDEF ? args[1] : NULL;
  ScrDyn *rstrategy = argc > 2 && args[2]->kind != SCR_DYN_UNDEF ? args[2] : NULL;
  ScrDyn *empty = NULL;
  if (!transformer || !wstrategy || !rstrategy) empty = scr_dyn_new_obj();
  if (!transformer) transformer = empty;
  if (!wstrategy) wstrategy = empty;
  if (!rstrategy) rstrategy = empty;
  ScrDyn *result = NULL;
  ScrDyn *rtype = NULL, *wtype = NULL, *start = NULL, *rhwm = NULL, *rsize = NULL, *whwm = NULL, *wsize = NULL;
  ScrDyn *transform = NULL, *flush = NULL, *cancel = NULL;
  if (!ws_validate_object(transformer, "transformer", false) ||
      !ws_validate_object(wstrategy, "writableStrategy", true) ||
      !ws_validate_object(rstrategy, "readableStrategy", true))
    goto done;
  if (!(rtype = ws_get(transformer, "readableType"))) goto done;
  if (!(wtype = ws_get(transformer, "writableType"))) goto done;
  if (!(start = ws_get(transformer, "start"))) goto done;
  if (rtype->kind != SCR_DYN_UNDEF) {
    ws_range_arg_value("transformer.readableType", rtype);
    goto done;
  }
  if (wtype->kind != SCR_DYN_UNDEF) {
    ws_range_arg_value("transformer.writableType", wtype);
    goto done;
  }
  if (!(rhwm = ws_get(rstrategy, "highWaterMark"))) goto done;
  if (!(rsize = ws_get(rstrategy, "size"))) goto done;
  if (!(whwm = ws_get(wstrategy, "highWaterMark"))) goto done;
  if (!(wsize = ws_get(wstrategy, "size"))) goto done;
  double readable_hwm, writable_hwm;
  if (!ws_extract_high_water_mark(rhwm, 0, &readable_hwm)) goto done;
  if (rsize->kind != SCR_DYN_UNDEF && !ws_validate_function(rsize, "strategy.size")) goto done;
  if (!ws_extract_high_water_mark(whwm, 1, &writable_hwm)) goto done;
  if (wsize->kind != SCR_DYN_UNDEF && !ws_validate_function(wsize, "strategy.size")) goto done;
  ws_install();
  WsTransform *t = ws_obj_new(sizeof *t, &ws_transform_type);
  ScrPromise *start_promise = scr_promise_new();
  ScrDyn *start_box = scr_dyn_new_promise(start_promise);
  /* initializeTransformStream: the writable side first. */
  t->writable = ws_writable_alloc();
  WsWController *wc = ws_writable_attach(t->writable, writable_hwm);
  wc->native = &ws_transform_sink_ops;
  wc->native_ctx = ws_retain(t);
  if (wsize->kind != SCR_DYN_UNDEF) wc->size_fn = scr_dyn_retain(wsize);
  ws_wcontroller_started_with(wc, start_box);
  t->readable = ws_readable_alloc();
  WsRController *rc = ws_rcontroller_attach(t->readable, readable_hwm);
  rc->native = &ws_transform_source_ops;
  rc->native_ctx = ws_retain(t);
  if (rsize->kind != SCR_DYN_UNDEF) rc->size_fn = scr_dyn_retain(rsize);
  ws_rcontroller_started_with(rc, start_box);
  scr_dyn_release(start_box);
  ws_transform_set_backpressure(t, true);
  /* setupTransformStreamDefaultControllerFromTransformer */
  WsTController *c = ws_obj_new(sizeof *c, &ws_tcontroller_type);
  c->stream = ws_retain(t);
  t->controller = c; /* the stream's reference */
  bool ok = (transform = ws_get(transformer, "transform")) && (flush = ws_get(transformer, "flush")) &&
            (cancel = ws_get(transformer, "cancel"));
  if (ok && scr_dyn_truthy(transform)) ok = ws_validate_function(transform, "transformer.transform");
  if (ok && scr_dyn_truthy(flush)) ok = ws_validate_function(flush, "transformer.flush");
  if (ok && scr_dyn_truthy(cancel)) ok = ws_validate_function(cancel, "transformer.cancel");
  if (!ok) {
    scr_promise_release(start_promise);
    ws_release(t);
    goto done;
  }
  c->transformer = scr_dyn_retain(transformer);
  if (scr_dyn_truthy(transform)) c->transform_fn = scr_dyn_retain(transform);
  if (scr_dyn_truthy(flush)) c->flush_fn = scr_dyn_retain(flush);
  if (scr_dyn_truthy(cancel)) c->cancel_fn = scr_dyn_retain(cancel);
  if (start->kind != SCR_DYN_UNDEF) {
    if (!scr_dyn_is_callable(start)) {
      ws_function_call_error();
      scr_promise_release(start_promise);
      ws_release(t);
      goto done;
    }
    ScrDyn *controller = ws_tcontroller_box(c);
    ScrDyn *value = ws_call(start, transformer, &controller, 1, "transformer.start");
    scr_dyn_release(controller);
    if (!value) {
      scr_promise_release(start_promise);
      ws_release(t);
      goto done;
    }
    /* startPromise.resolve(result): a thenable result adopts through its
     * resolve job, so both sides start when it settles. */
    scr_dyn_promise_resolve_with(start_promise, value);
    scr_dyn_release(value);
  } else {
    ws_promise_fulfill_undefined(start_promise);
  }
  scr_promise_release(start_promise);
  result = ws_transform_box(t);
  ws_release(t);
done:
  if (empty) scr_dyn_release(empty);
  ScrDyn *gets[] = {rtype, wtype, start, rhwm, rsize, whwm, wsize, transform, flush, cancel};
  for (size_t i = 0; i < sizeof gets / sizeof gets[0]; i++)
    if (gets[i]) scr_dyn_release(gets[i]);
  return result;
}

/* ── pipeTo (readableStreamPipeTo) ────────────────────────────────── */

/* writableStreamDefaultWriterWriteWithRequest: the pipe's write of one
 * chunk, tracked by its shared request; a write that cannot proceed
 * latches the failure on it. */
static void ws_writer_write_with_tracker(WsWriter *w, ScrDyn *chunk, WsPipe *tracker);

/* writableStreamDefaultWriterCloseWithErrorPropagation: +1 promise. */
static ScrPromise *ws_writer_close_with_error_propagation(WsWriter *w) {
  WsWritable *s = w->stream;
  if (s->close_queued_or_inflight || s->state == WS_W_CLOSED) return ws_promise_resolved_undefined();
  if (s->state == WS_W_ERRORED) return ws_promise_rejected_with(s->stored_error);
  return ws_writable_close(s);
}

typedef enum {
  WS_PIPE_ABORT_DEST,
  WS_PIPE_CANCEL_SOURCE,
  WS_PIPE_CLOSE_DEST,
  WS_PIPE_SIGNAL,
} WsPipeAction;

struct WsPipe {
  WsObj obj;
  WsReadable *source;
  WsWritable *dest;
  WsReader *reader;
  WsWriter *writer;
  bool prevent_close, prevent_abort, prevent_cancel;
  ScrDyn *signal;     /* +1, or NULL */
  ScrDyn *disposable; /* +1: the abort listener's dispose */
  bool shutting_down;
  ScrPromise *promise; /* the pipeTo result, +1 */
  /* The shared write request. */
  size_t pending;
  bool failed;
  ScrDyn *failure;   /* +1 */
  ScrPromise *stall; /* +1 while armed */
  ScrDyn *pending_chunk;
  ScrPromise *ready_promise; /* the ready hook's forever-pending promise */
  /* The shutdown in progress. */
  WsPipeAction action;
  bool rejected;
  ScrDyn *original_error; /* +1, or NULL for undefined */
  ScrDyn *action_error;   /* the action's argument (+1) */
};

static void ws_pipe_trace(void *obj, ScrTraceVisit visit, void *ctx) {
  WsPipe *p = obj;
  ws_visit(p->source, visit, ctx);
  ws_visit(p->dest, visit, ctx);
  ws_visit(p->reader, visit, ctx);
  ws_visit(p->writer, visit, ctx);
  ws_visit(p->signal, visit, ctx);
  ws_visit(p->disposable, visit, ctx);
  ws_visit(p->promise, visit, ctx);
  ws_visit(p->failure, visit, ctx);
  ws_visit(p->stall, visit, ctx);
  ws_visit(p->pending_chunk, visit, ctx);
  ws_visit(p->ready_promise, visit, ctx);
  ws_visit(p->original_error, visit, ctx);
  ws_visit(p->action_error, visit, ctx);
}

static void ws_pipe_drop(void *obj, bool gc) {
  WsPipe *p = obj;
  ws_drop_obj(p->source, gc);
  ws_drop_obj(p->dest, gc);
  ws_drop_obj(p->reader, gc);
  ws_drop_obj(p->writer, gc);
  ws_drop_dyn(p->signal, gc);
  ws_drop_dyn(p->disposable, gc);
  ws_drop_promise(p->promise, gc);
  ws_drop_dyn(p->failure, gc);
  ws_drop_promise(p->stall, gc);
  ws_drop_dyn(p->pending_chunk, gc);
  ws_drop_promise(p->ready_promise, gc);
  ws_drop_dyn(p->original_error, gc);
  ws_drop_dyn(p->action_error, gc);
}

static const WsObjType ws_pipe_type = {ws_pipe_trace, ws_pipe_drop};

static void ws_pipe_tracker_resolve(WsPipe *p) {
  if (--p->pending == 0 && p->stall) {
    ScrPromise *stall = p->stall;
    p->stall = NULL;
    if (p->failed) ws_reject(stall, p->failure);
    else ws_promise_fulfill_undefined(stall);
    scr_promise_release(stall);
  }
}

static void ws_pipe_tracker_reject(WsPipe *p, ScrDyn *error) {
  p->pending--;
  p->failed = true;
  if (p->failure) scr_dyn_release(p->failure);
  p->failure = scr_dyn_retain(error);
  if (p->stall) {
    ScrPromise *stall = p->stall;
    p->stall = NULL;
    ws_reject(stall, error);
    scr_promise_release(stall);
  }
}

static void ws_writer_write_with_tracker(WsWriter *w, ScrDyn *chunk, WsPipe *tracker) {
  WsWritable *s = w->stream;
  ws_retain(s);
  WsWController *c = s->controller;
  ScrDyn *size = ws_wcontroller_chunk_size(c, chunk);
  ScrDyn *failure = NULL;
  if (s != w->stream) failure = ws_state_error_value("Mismatched WritableStreams");
  else if (s->state == WS_W_ERRORED) failure = ws_or_undef(s->stored_error);
  else if (s->close_queued_or_inflight || s->state == WS_W_CLOSED)
    failure = ws_state_error_value("WritableStream is closed");
  else if (s->state == WS_W_ERRORING) failure = ws_or_undef(s->stored_error);
  if (failure) {
    tracker->failed = true;
    if (tracker->failure) scr_dyn_release(tracker->failure);
    tracker->failure = failure;
  } else {
    ws_requests_push(s, (WsWriteRequest){NULL, ws_retain(tracker)});
    tracker->pending++;
    ws_wcontroller_write(c, chunk, size);
  }
  if (size) scr_dyn_release(size);
  ws_release(s);
}

static void ws_pipe_finalize(WsPipe *p, bool rejected, ScrDyn *error) {
  ws_retain(p);
  if (p->writer->stream) ws_writer_release_lock(p->writer);
  if (p->reader->stream) ws_reader_generic_release(p->reader);
  if (p->disposable) {
    ScrDyn *dispose = p->disposable;
    p->disposable = NULL;
    ScrDyn *r = scr_dyn_call(dispose, NULL, 0, "[Symbol.dispose]");
    if (r) scr_dyn_release(r);
    else if (scr_exc_pending()) scr_exc_clear();
    scr_dyn_release(dispose);
  }
  if (rejected) ws_promise_reject_with(p->promise, error);
  else ws_promise_fulfill_undefined(p->promise);
  ws_release(p);
}

static void ws_pipe_finalize_original(void *ctx, ScrDyn *unused) {
  (void)unused;
  WsPipe *p = ctx;
  ws_pipe_finalize(p, p->rejected, p->original_error);
}

static void ws_pipe_finalize_error(void *ctx, ScrDyn *error) { ws_pipe_finalize(ctx, true, error); }

/* waitForPendingWrites: +1 promise. */
static ScrPromise *ws_pipe_wait_for_pending_writes(WsPipe *p) {
  if (p->pending == 0) return p->failed ? ws_promise_rejected_with(p->failure) : ws_promise_resolved_undefined();
  if (p->stall) scr_promise_release(p->stall);
  p->stall = scr_promise_new();
  return scr_promise_retain(p->stall);
}

/* Promise.all over the abort algorithm's actions, through the primordial
 * SafePromiseAll: each entry resolves a promise of its own, and the
 * combined result settles a promise the caller's then observes. */
typedef struct WsPipeAll {
  WsObj obj;
  ScrPromise *all; /* +1 */
  size_t remaining;
  bool settled;
} WsPipeAll;

static void ws_pipe_all_trace(void *obj, ScrTraceVisit visit, void *ctx) { ws_visit(((WsPipeAll *)obj)->all, visit, ctx); }

static void ws_pipe_all_drop(void *obj, bool gc) { ws_drop_promise(((WsPipeAll *)obj)->all, gc); }

static const WsObjType ws_pipe_all_type = {ws_pipe_all_trace, ws_pipe_all_drop};

static void ws_pipe_all_fulfilled(void *ctx, ScrDyn *unused) {
  (void)unused;
  WsPipeAll *a = ctx;
  if (a->settled || --a->remaining != 0) return;
  a->settled = true;
  ws_promise_fulfill_undefined(a->all);
}

static void ws_pipe_all_rejected(void *ctx, ScrDyn *error) {
  WsPipeAll *a = ctx;
  if (a->settled) return;
  a->settled = true;
  ws_reject(a->all, error);
}

/* The shutdown action's promise: +1. */
static ScrPromise *ws_pipe_run_action(WsPipe *p) {
  ScrDyn *error = p->action_error;
  switch (p->action) {
  case WS_PIPE_ABORT_DEST: return ws_writable_abort(p->dest, error);
  case WS_PIPE_CANCEL_SOURCE: return ws_readable_cancel(p->source, error);
  case WS_PIPE_CLOSE_DEST: return ws_writer_close_with_error_propagation(p->writer);
  case WS_PIPE_SIGNAL: break;
  }
  ScrPromise *entries[2];
  size_t n = 0;
  if (!p->prevent_abort)
    entries[n++] = p->dest->state == WS_W_WRITABLE ? ws_writable_abort(p->dest, error) : ws_promise_resolved_undefined();
  if (!p->prevent_cancel)
    entries[n++] = p->source->state == WS_STATE_READABLE ? ws_readable_cancel(p->source, error)
                                                          : ws_promise_resolved_undefined();
  WsPipeAll *a = ws_obj_new(sizeof *a, &ws_pipe_all_type);
  a->all = scr_promise_new();
  a->remaining = n;
  if (n == 0) {
    a->settled = true;
    ws_promise_fulfill_undefined(a->all);
  }
  for (size_t i = 0; i < n; i++) {
    ScrDyn *box = ws_promise_box(entries[i]);
    ScrPromise *own = ws_promise_resolving(box);
    scr_dyn_release(box);
    ws_then(own, ws_pipe_all_fulfilled, ws_pipe_all_rejected, ws_retain(a), false);
    scr_promise_release(own);
  }
  ScrPromise *result = ws_then_void(a->all);
  ws_release(a);
  return result;
}

static void ws_pipe_complete(void *ctx, ScrDyn *unused) {
  (void)unused;
  WsPipe *p = ctx;
  ScrPromise *action = ws_pipe_run_action(p);
  ws_then(action, ws_pipe_finalize_original, ws_pipe_finalize_error, ws_retain(p), false);
  scr_promise_release(action);
}

static void ws_pipe_shutdown_with_action(WsPipe *p, WsPipeAction action, bool rejected, ScrDyn *original_error,
                                         ScrDyn *action_error) {
  if (p->shutting_down) return;
  p->shutting_down = true;
  p->action = action;
  p->rejected = rejected;
  p->original_error = original_error ? scr_dyn_retain(original_error) : NULL;
  p->action_error = ws_or_undef(action_error);
  if (p->dest->state == WS_W_WRITABLE && !p->dest->close_queued_or_inflight) {
    ScrPromise *wait = ws_pipe_wait_for_pending_writes(p);
    ws_then(wait, ws_pipe_complete, ws_pipe_finalize_error, ws_retain(p), false);
    scr_promise_release(wait);
    return;
  }
  ws_pipe_complete(p, NULL);
}

static void ws_pipe_shutdown(WsPipe *p, bool rejected, ScrDyn *error) {
  if (p->shutting_down) return;
  p->shutting_down = true;
  p->rejected = rejected;
  p->original_error = error ? scr_dyn_retain(error) : NULL;
  if (p->dest->state == WS_W_WRITABLE && !p->dest->close_queued_or_inflight) {
    ScrPromise *wait = ws_pipe_wait_for_pending_writes(p);
    ws_then(wait, ws_pipe_finalize_original, ws_pipe_finalize_error, ws_retain(p), false);
    scr_promise_release(wait);
    return;
  }
  ws_pipe_finalize(p, rejected, error);
}

static void ws_pipe_abort_algorithm(WsPipe *p) {
  ScrDyn *error = ws_get(p->signal, "reason");
  if (!error) {
    error = ws_take_pending();
  }
  ws_pipe_shutdown_with_action(p, WS_PIPE_SIGNAL, true, error, error);
  scr_dyn_release(error);
}

static void ws_pipe_pump(WsPipe *p);

static void ws_pipe_pump_hook(void *ctx) { ws_pipe_pump(ctx); }

static void ws_pipe_pump_step(void *ctx, ScrDyn *unused) {
  (void)unused;
  ws_pipe_pump(ctx);
}

static void ws_pipe_park_on_ready(WsPipe *p) {
  if (!p->ready_promise) p->ready_promise = scr_promise_new();
  WsRecord *ready = &p->writer->ready;
  ws_record_set(ready, scr_promise_retain(p->ready_promise), true);
  ready->hook = ws_pipe_pump_hook;
  ready->hook_ctx = p;
}

static void ws_pipe_forward_chunk(void *ctx, ScrDyn *unused) {
  (void)unused;
  WsPipe *p = ctx;
  ScrDyn *chunk = p->pending_chunk;
  p->pending_chunk = NULL;
  ws_writer_write_with_tracker(p->writer, chunk, p);
  scr_dyn_release(chunk);
  ws_pipe_pump(p);
}

static void ws_pipe_read_chunk(WsReadRequest *q, ScrDyn *chunk) {
  WsPipe *p = q->ctx;
  if (p->pending_chunk) scr_dyn_release(p->pending_chunk);
  p->pending_chunk = scr_dyn_retain(chunk);
  ws_queue_microtask(ws_pipe_forward_chunk, p); /* the request's reference moves */
  free(q);
}

static void ws_pipe_read_done(WsReadRequest *q) {
  ws_release(q->ctx);
  free(q);
}

static void ws_pipe_read_error(WsReadRequest *q, ScrDyn *error) {
  (void)error;
  ws_pipe_read_done(q);
}

static const WsReadRequestOps ws_pipe_read_ops = {ws_pipe_read_chunk, ws_pipe_read_done, ws_pipe_read_error};

static void ws_pipe_pump(WsPipe *p) {
  if (p->shutting_down) return;
  WsWritable *dest = p->dest;
  if (dest->backpressure) {
    ws_pipe_park_on_ready(p);
    return;
  }
  WsReadable *source = p->source;
  WsRController *c = source->controller;
  if (source->state == WS_STATE_READABLE && c->queue.length > 0) {
    ws_retain(p);
    while (c->queue.length > 0) {
      if (p->shutting_down) {
        ws_release(p);
        return;
      }
      double size;
      ScrDyn *chunk = ws_queue_shift(&c->queue, &size);
      c->queue_total_size = fmax(0, c->queue_total_size - size);
      if (c->close_requested && !c->queue.length) {
        ws_rcontroller_clear_algorithms(c);
        ws_readable_close(source);
      }
      ws_writer_write_with_tracker(p->writer, chunk, p);
      scr_dyn_release(chunk);
      if (dest->backpressure) break;
      if (dest->state != WS_W_WRITABLE || dest->close_queued_or_inflight) break;
    }
    ws_rcontroller_call_pull_if_needed(c);
    if (source->state == WS_STATE_CLOSED) {
      ws_release(p);
      return;
    }
    if (dest->backpressure) {
      ws_pipe_park_on_ready(p);
      ws_release(p);
      return;
    }
    ws_queue_microtask(ws_pipe_pump_step, p); /* the reference moves */
    return;
  }
  WsReadRequest *q = ws_alloc(sizeof *q);
  q->ops = &ws_pipe_read_ops;
  q->ctx = ws_retain(p);
  ws_reader_read_request(p->reader, q);
}

/* The watchers on the reader's and writer's closed promises. */
static void ws_pipe_source_errored(void *ctx, ScrDyn *error) {
  WsPipe *p = ctx;
  if (!p->prevent_abort) ws_pipe_shutdown_with_action(p, WS_PIPE_ABORT_DEST, true, error, error);
  else ws_pipe_shutdown(p, true, error);
}

static void ws_pipe_dest_errored(void *ctx, ScrDyn *error) {
  WsPipe *p = ctx;
  if (!p->prevent_cancel) ws_pipe_shutdown_with_action(p, WS_PIPE_CANCEL_SOURCE, true, error, error);
  else ws_pipe_shutdown(p, true, error);
}

static void ws_pipe_source_closed(void *ctx, ScrDyn *unused) {
  (void)unused;
  WsPipe *p = ctx;
  if (!p->prevent_close) ws_pipe_shutdown_with_action(p, WS_PIPE_CLOSE_DEST, false, NULL, NULL);
  else ws_pipe_shutdown(p, false, NULL);
}

static void ws_pipe_ignore(void *ctx, ScrDyn *unused) {
  (void)ctx;
  (void)unused;
}

static ScrDyn *ws_pipe_abort_listener(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc;
  WsPipe *p = scr_box_get_ref(closure->caps[0]);
  ws_pipe_abort_algorithm(p);
  ws_release(p);
  return ws_undef();
}

/* readableStreamPipeTo: +1 promise. The streams are unlocked. */
static ScrPromise *ws_readable_pipe_to(WsReadable *source, WsWritable *dest, bool prevent_close, bool prevent_abort,
                                       bool prevent_cancel, ScrDyn *signal) {
  WsReader *reader = ws_reader_new(source);
  if (!reader) return ws_promise_rejected_pending();
  WsWriter *writer = ws_writer_new(dest);
  if (!writer) {
    ws_release(reader);
    return ws_promise_rejected_pending();
  }
  source->disturbed = true;
  WsPipe *p = ws_obj_new(sizeof *p, &ws_pipe_type);
  p->source = ws_retain(source);
  p->dest = ws_retain(dest);
  p->reader = reader;
  p->writer = writer;
  p->prevent_close = prevent_close;
  p->prevent_abort = prevent_abort;
  p->prevent_cancel = prevent_cancel;
  p->promise = scr_promise_new();
  ScrPromise *result = scr_promise_retain(p->promise);
  if (signal) {
    p->signal = scr_dyn_retain(signal);
    ScrDyn *aborted = ws_get(signal, "aborted");
    bool is_aborted = aborted && scr_dyn_truthy(aborted);
    if (aborted) scr_dyn_release(aborted);
    else if (scr_exc_pending()) scr_exc_clear();
    if (is_aborted) {
      ws_pipe_abort_algorithm(p);
      ws_release(p);
      return result;
    }
    ScrClosure *closure = scr_closure_new(NULL, 1);
    closure->caps[0] = scr_box_new_obj(ws_retain, ws_release, ws_obj_trace);
    scr_box_set_ref(closure->caps[0], ws_retain(p));
    ScrDyn *listener = scr_dyn_new_func(closure, ws_pipe_abort_listener, 0, "", "abortAlgorithm");
    p->disposable = scr_events_add_abort_listener(signal, listener);
    scr_dyn_release(listener);
    if (!p->disposable && scr_exc_pending()) scr_exc_clear();
  }
  ws_pipe_pump(p);
  if (source->state == WS_STATE_ERRORED) ws_pipe_source_errored(p, source->stored_error);
  else ws_then(ws_reader_closed_promise(reader), NULL, ws_pipe_source_errored, ws_retain(p), false);
  if (dest->state == WS_W_ERRORED) ws_pipe_dest_errored(p, dest->stored_error);
  else ws_then(ws_writer_closed_promise(writer), NULL, ws_pipe_dest_errored, ws_retain(p), false);
  if (source->state == WS_STATE_CLOSED) ws_pipe_source_closed(p, NULL);
  else ws_then(ws_reader_closed_promise(reader), ws_pipe_source_closed, ws_pipe_ignore, ws_retain(p), false);
  if (dest->close_queued_or_inflight || dest->state == WS_W_CLOSED) {
    ScrDyn *error = ws_state_error_value("Destination WritableStream is closed");
    if (!prevent_cancel) ws_pipe_shutdown_with_action(p, WS_PIPE_CANCEL_SOURCE, true, error, error);
    else ws_pipe_shutdown(p, true, error);
    scr_dyn_release(error);
  }
  ws_release(p);
  return result;
}

/* pipeTo(destination, options) and pipeThrough(transform, options): the
 * options read in Node's order, and the checks before the pipe starts.
 * false with the exception pending. */
static bool ws_pipe_options(ScrDyn *options, bool *prevent_close, bool *prevent_abort, bool *prevent_cancel,
                            ScrDyn **signal_out) {
  *signal_out = NULL;
  if (!ws_validate_object(options, "options", true)) return false;
  ScrDyn *abort = ws_get(options, "preventAbort");
  if (!abort) return false;
  ScrDyn *cancel = ws_get(options, "preventCancel");
  if (!cancel) {
    scr_dyn_release(abort);
    return false;
  }
  ScrDyn *close = ws_get(options, "preventClose");
  if (!close) {
    scr_dyn_release(abort);
    scr_dyn_release(cancel);
    return false;
  }
  ScrDyn *signal = ws_get(options, "signal");
  *prevent_abort = scr_dyn_truthy(abort);
  *prevent_cancel = scr_dyn_truthy(cancel);
  *prevent_close = scr_dyn_truthy(close);
  scr_dyn_release(abort);
  scr_dyn_release(cancel);
  scr_dyn_release(close);
  if (!signal) return false;
  if (signal->kind == SCR_DYN_UNDEF) {
    scr_dyn_release(signal);
    return true;
  }
  /* validateAbortSignal: an object with an `aborted` member. */
  bool valid = false;
  if (ws_is_object(signal)) {
    ScrStr *key = scr_str_new("aborted", 7);
    valid = scr_dyn_in(signal, key);
    scr_str_release(key);
    if (scr_exc_pending()) {
      scr_dyn_release(signal);
      return false;
    }
  }
  if (!valid) {
    scr_dyn_arg_type_fail("options.signal", "an instance of AbortSignal", signal);
    scr_dyn_release(signal);
    return false;
  }
  *signal_out = signal;
  return true;
}

/* ── own properties ── */

/* An own property a program set on the state's object (+1), or NULL. */
static ScrDyn *ws_own_get(void *obj, const char *key, size_t len) {
  /* scr_dyn_handle_class_method reads methods through a handle without a
   * state. */
  if (!obj) return NULL;
  ScrDyn *own = ((WsObj *)obj)->own;
  ScrDyn *value = own ? scr_dyn_obj_get(own, key, len) : NULL;
  return value ? scr_dyn_retain(value) : NULL;
}

/* A method call that an own property of the name overrides: true with
 * *result set (+1, or NULL with the exception pending). */
static bool ws_own_invoke(void *obj, ScrDyn *self, const char *method, ScrDyn *const *args, size_t argc,
                          const char *what, ScrDyn **result) {
  ScrDyn *fn = ws_own_get(obj, method, strlen(method));
  if (!fn) return false;
  if (!scr_dyn_is_callable(fn)) {
    scr_dyn_release(fn);
    char buf[256];
    int n = snprintf(buf, sizeof buf, "%s is not a function", what && *what ? what : method);
    scr_throw_error_msg(SCR_ERR_TYPE, buf, (size_t)n);
    *result = NULL;
    return true;
  }
  *result = ws_call(fn, self, args, argc, what);
  scr_dyn_release(fn);
  return true;
}

/* A write of a property on the state's object: an own property, except a
 * getter-only member of the class, which strict code cannot write. */
static bool ws_own_set(void *h, const char *key, size_t len, const ScrDyn *value) {
  WsObj *o = h;
  for (const ScrDynHandleAccessor *a = o->type->accessors; a && a->name; a++) {
    if (strlen(a->name) != len || memcmp(a->name, key, len) != 0) continue;
    char buf[256];
    int n = snprintf(buf, sizeof buf, "Cannot set property %.*s of #<%s> which has only a getter", (int)len, key,
                     o->type->cls);
    scr_throw_error_msg(SCR_ERR_TYPE, buf, (size_t)n);
    return true;
  }
  if (!o->own) o->own = scr_dyn_new_obj();
  scr_dyn_obj_set(o->own, key, len, scr_dyn_retain((ScrDyn *)value));
  return true;
}

/* ── the handle surfaces ───────────────────────────────────────────── */

static bool ws_name(const char *key, size_t len, const char *want) {
  return strlen(want) == len && memcmp(key, want, len) == 0;
}

/* A member call of a name that is no method of the class: the member's
 * value (an accessor such as a strategy's size), called with the handle as
 * its receiver; "<what> is not a function" when it is not callable. */
static ScrDyn *ws_invoke_member(ScrDyn *self, const char *method, ScrDyn *const *args, size_t argc,
                                const char *what) {
  ScrStr *key = scr_str_new(method, strlen(method));
  ScrDyn *member = scr_dyn_handle_key_get(self, key);
  scr_str_release(key);
  if (!member) return NULL;
  if (!scr_dyn_is_callable(member)) {
    scr_dyn_release(member);
    char buf[256];
    int n = snprintf(buf, sizeof buf, "%s is not a function", what && *what ? what : method);
    scr_throw_error_msg(SCR_ERR_TYPE, buf, (size_t)n);
    return NULL;
  }
  ScrDyn *result = ws_call(member, self, args, argc, what);
  scr_dyn_release(member);
  return result;
}

static ScrDyn *ws_arg(ScrDyn *const *args, size_t argc, size_t i) {
  return i < argc ? args[i] : scr_dyn_undefined();
}

/* A member call on a handle (ScrDynHandleOps.invoke): an own property of
 * the name first, then the class's method (<name>_method). The class's
 * method values call <name>_method directly (ScrDynHandleClass's
 * method_invoke), so a wrapper an own property installs reaches it. */
#define WS_MEMBER_INVOKE(NAME)                                                                                 \
  static ScrDyn *NAME##_invoke(void *ptr, ScrDyn *self, const char *method, ScrDyn *const *args, size_t argc, \
                               const char *what) {                                                            \
    ScrDyn *own_result;                                                                                        \
    if (ws_own_invoke(ptr, self, method, args, argc, what, &own_result)) return own_result;                   \
    return NAME##_method(ptr, self, method, args, argc, what);                                                 \
  }

static ScrDyn *ws_promise_box(ScrPromise *p) {
  ScrDyn *box = scr_dyn_new_promise(p);
  scr_promise_release(p);
  return box;
}

static ScrDyn *ws_rejected_pending_box(void) { return ws_promise_box(ws_promise_rejected_pending()); }

/* ReadableStream */

static ScrDyn *ws_readable_get_reader(WsReadable *s, ScrDyn *options) {
  if (!ws_validate_object(options, "options", true)) return NULL;
  ScrDyn *mode = ws_get(options, "mode");
  if (!mode) return NULL;
  if (mode->kind != SCR_DYN_UNDEF) {
    ScrStr *text = scr_dyn_string_coerce_js(mode);
    if (!text) {
      scr_dyn_release(mode);
      return NULL;
    }
    bool byob = text->len == 4 && memcmp(text->data, "byob", 4) == 0;
    scr_str_release(text);
    if (byob) {
      scr_dyn_release(mode);
      static const char message[] = "ReadableStreamBYOBReader is not supported yet";
      scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
      return NULL;
    }
    scr_dyn_arg_value_fail("options.mode", NULL, mode);
    scr_dyn_release(mode);
    return NULL;
  }
  scr_dyn_release(mode);
  WsReader *r = ws_reader_new(s);
  if (!r) return NULL;
  ScrDyn *box = ws_reader_box(r);
  ws_reader_release(r);
  return box;
}

static ScrDyn *ws_readable_method(void *ptr, ScrDyn *self, const char *method, ScrDyn *const *args, size_t argc,
                                  const char *what) {
  (void)self;
  (void)what;
  WsReadable *s = ptr;
  size_t len = strlen(method);
  if (ws_name(method, len, "cancel")) {
    if (ws_readable_locked(s)) {
      ScrDyn *error = ws_state_error_value("ReadableStream is locked");
      ScrPromise *p = ws_promise_rejected(error);
      scr_dyn_release(error);
      return ws_promise_box(p);
    }
    return ws_promise_box(ws_readable_cancel(s, ws_arg(args, argc, 0)));
  }
  if (ws_name(method, len, "getReader")) {
    ScrDyn *options = ws_arg(args, argc, 0);
    ScrDyn *empty = options->kind == SCR_DYN_UNDEF ? scr_dyn_new_obj() : NULL;
    ScrDyn *reader = ws_readable_get_reader(s, empty ? empty : options);
    if (empty) scr_dyn_release(empty);
    return reader;
  }
  if (ws_name(method, len, "tee")) {
    WsReadable *a, *b;
    if (!ws_readable_tee(s, &a, &b)) return NULL;
    ScrDyn *pair = scr_dyn_new_arr();
    scr_dyn_arr_push(pair, ws_stream_box(a));
    scr_dyn_arr_push(pair, ws_stream_box(b));
    ws_readable_release(a);
    ws_readable_release(b);
    return pair;
  }
  if (ws_name(method, len, "values")) {
    ScrDyn *options = ws_arg(args, argc, 0);
    ScrDyn *empty = options->kind == SCR_DYN_UNDEF ? scr_dyn_new_obj() : NULL;
    ScrDyn *iterator = ws_readable_values(s, empty ? empty : options);
    if (empty) scr_dyn_release(empty);
    return iterator;
  }
  if (ws_name(method, len, "pipeTo")) {
    ScrDyn *destination = ws_arg(args, argc, 0);
    WsWritable *dest = ws_writable_of(destination);
    if (!dest) {
      scr_dyn_arg_type_fail("transform.writable", "an instance of WritableStream", destination);
      return ws_rejected_pending_box();
    }
    ScrDyn *options = ws_arg(args, argc, 1);
    ScrDyn *empty = options->kind == SCR_DYN_UNDEF ? scr_dyn_new_obj() : NULL;
    bool prevent_close = false, prevent_abort = false, prevent_cancel = false;
    ScrDyn *signal;
    bool ok = ws_pipe_options(empty ? empty : options, &prevent_close, &prevent_abort, &prevent_cancel, &signal);
    if (empty) scr_dyn_release(empty);
    if (!ok) return ws_rejected_pending_box();
    ScrPromise *result;
    if (ws_readable_locked(s)) result = ws_promise_state_rejected("The ReadableStream is locked");
    else if (ws_writable_locked(dest)) result = ws_promise_state_rejected("The WritableStream is locked");
    else result = ws_readable_pipe_to(s, dest, prevent_close, prevent_abort, prevent_cancel, signal);
    if (signal) scr_dyn_release(signal);
    return ws_promise_box(result);
  }
  if (ws_name(method, len, "pipeThrough")) {
    ScrDyn *transform = ws_arg(args, argc, 0);
    ScrDyn *readable = ws_get(transform, "readable");
    if (!readable) return NULL;
    if (!ws_stream_of(readable)) {
      scr_dyn_arg_type_fail("transform.readable", "an instance of ReadableStream", readable);
      scr_dyn_release(readable);
      return NULL;
    }
    ScrDyn *writable = ws_get(transform, "writable");
    if (!writable) {
      scr_dyn_release(readable);
      return NULL;
    }
    WsWritable *dest = ws_writable_of(writable);
    if (!dest) {
      scr_dyn_arg_type_fail("transform.writable", "an instance of WritableStream", writable);
      scr_dyn_release(readable);
      scr_dyn_release(writable);
      return NULL;
    }
    ScrDyn *options = ws_arg(args, argc, 1);
    ScrDyn *empty = options->kind == SCR_DYN_UNDEF ? scr_dyn_new_obj() : NULL;
    bool prevent_close = false, prevent_abort = false, prevent_cancel = false;
    ScrDyn *signal = NULL;
    bool ok = ws_pipe_options(empty ? empty : options, &prevent_close, &prevent_abort, &prevent_cancel, &signal);
    if (empty) scr_dyn_release(empty);
    if (ok && ws_readable_locked(s)) {
      ws_state_error("The ReadableStream is locked");
      ok = false;
    } else if (ok && ws_writable_locked(dest)) {
      ws_state_error("The WritableStream is locked");
      ok = false;
    }
    if (ok) {
      ScrPromise *piped = ws_readable_pipe_to(s, dest, prevent_close, prevent_abort, prevent_cancel, signal);
      ws_set_handled(piped);
      scr_promise_release(piped);
    }
    if (signal) scr_dyn_release(signal);
    scr_dyn_release(writable);
    if (!ok) {
      scr_dyn_release(readable);
      return NULL;
    }
    return readable;
  }
  return ws_invoke_member(self, method, args, argc, what);
}
WS_MEMBER_INVOKE(ws_readable)

static ScrDyn *ws_readable_get(void *ptr, const char *key, size_t len) {
  WsReadable *s = ptr;
  if (ws_name(key, len, "locked")) return scr_dyn_new_bool(ws_readable_locked(s));
  ScrDyn *own = ws_own_get(ptr, key, len);
  if (own) return own;
  return scr_dyn_handle_class_member(SCR_DYNH_WS_READABLE, ptr, key, len);
}

/* Symbol.asyncIterator is values. */
static ScrDyn *ws_readable_symbol_get(void *ptr, const ScrDyn *key) {
  (void)ptr;
  if (!scr_dyn_is_async_iterator_symbol(key)) return NULL;
  return scr_dyn_handle_class_method(SCR_DYNH_WS_READABLE, "values");
}

static ScrDyn *ws_rejected_value(void) { return ws_rejected_pending_box(); }

static const ScrDynHandleMethod ws_readable_methods[] = {
    {"cancel", 0, true, NULL}, {"getReader", 0, false, NULL}, {"pipeThrough", 1, false, NULL},
    {"pipeTo", 1, true, NULL}, {"tee", 0, false, NULL},       {"values", 0, false, NULL},
    {NULL, 0, false, NULL},
};


static const ScrDynHandleStatic ws_readable_statics[] = {{"from", 1, ws_readable_from_thunk}, {NULL, 0, NULL}};

static const char *const ws_readable_order[] = {"locked", "cancel", "getReader", "pipeThrough", "pipeTo",
                                                "tee",    "values", NULL};

static const ScrDynHandleClass ws_readable_class = {
    "ReadableStream", 0, ws_readable_construct, ws_readable_accessors, ws_readable_statics, ws_readable_order, ws_readable_method,
};

/* ReadableStreamDefaultReader */

static ScrDyn *ws_reader_construct(ScrDyn *const *args, size_t argc) {
  ScrDyn *stream = ws_arg(args, argc, 0);
  WsReadable *s = ws_stream_of(stream);
  if (!s) {
    scr_dyn_arg_type_fail("stream", "an instance of ReadableStream", stream);
    return NULL;
  }
  WsReader *r = ws_reader_new(s);
  if (!r) return NULL;
  ScrDyn *box = ws_reader_box(r);
  ws_reader_release(r);
  return box;
}

static ScrDyn *ws_reader_detached(void) {
  ScrDyn *error = ws_state_error_value("The reader is not attached to a stream");
  ScrPromise *p = ws_promise_rejected(error);
  scr_dyn_release(error);
  return ws_promise_box(p);
}

static ScrDyn *ws_reader_read(WsReader *r) {
  if (!r->stream) return ws_reader_detached();
  ScrDyn *chunk;
  if (ws_dequeue_fast(r->stream, &chunk)) {
    ScrDyn *record = ws_read_result(chunk, false);
    scr_dyn_release(chunk);
    ScrPromise *p = ws_promise_resolved(record);
    scr_dyn_release(record);
    return ws_promise_box(p);
  }
  WsReadRequest *q = ws_alloc(sizeof *q);
  q->ops = &ws_default_request_ops;
  q->promise = scr_promise_new();
  ScrPromise *result = scr_promise_retain(q->promise);
  ws_reader_read_request(r, q);
  return ws_promise_box(result);
}

static ScrDyn *ws_reader_method(void *ptr, ScrDyn *self, const char *method, ScrDyn *const *args, size_t argc,
                                const char *what) {
  (void)self;
  (void)what;
  WsReader *r = ptr;
  size_t len = strlen(method);
  if (ws_name(method, len, "read")) return ws_reader_read(r);
  if (ws_name(method, len, "releaseLock")) {
    if (r->stream) ws_reader_release_lock(r);
    return ws_undef();
  }
  if (ws_name(method, len, "cancel")) {
    if (!r->stream) return ws_reader_detached();
    return ws_promise_box(ws_readable_cancel(r->stream, ws_arg(args, argc, 0)));
  }
  return ws_invoke_member(self, method, args, argc, what);
}
WS_MEMBER_INVOKE(ws_reader)

static ScrDyn *ws_reader_get(void *ptr, const char *key, size_t len) {
  WsReader *r = ptr;
  if (ws_name(key, len, "closed")) return scr_dyn_new_promise(ws_reader_closed_promise(r));
  ScrDyn *own = ws_own_get(ptr, key, len);
  if (own) return own;
  return scr_dyn_handle_class_member(SCR_DYNH_WS_READER, ptr, key, len);
}

static const ScrDynHandleMethod ws_reader_methods[] = {
    {"read", 0, true, NULL}, {"releaseLock", 0, false, NULL}, {"cancel", 0, true, NULL}, {NULL, 0, false, NULL},
};


static const char *const ws_reader_order[] = {"read", "releaseLock", "closed", "cancel", NULL};

static const ScrDynHandleClass ws_reader_class = {
    "ReadableStreamDefaultReader", 1, ws_reader_construct, ws_reader_accessors, NULL, ws_reader_order, ws_reader_method,
};

/* ReadableStreamDefaultController */

static ScrDyn *ws_rcontroller_method(void *ptr, ScrDyn *self, const char *method, ScrDyn *const *args,
                                     size_t argc, const char *what) {
  (void)self;
  (void)what;
  WsRController *c = ptr;
  size_t len = strlen(method);
  if (ws_name(method, len, "close")) {
    if (!ws_rcontroller_can_close_or_enqueue(c)) {
      ws_state_error("Controller is already closed");
      return NULL;
    }
    ws_rcontroller_close(c);
    return ws_undef();
  }
  if (ws_name(method, len, "enqueue")) {
    if (!ws_rcontroller_can_close_or_enqueue(c)) {
      ws_state_error("Controller is already closed");
      return NULL;
    }
    if (!ws_rcontroller_enqueue(c, ws_arg(args, argc, 0))) return NULL;
    return ws_undef();
  }
  if (ws_name(method, len, "error")) {
    ws_rcontroller_error(c, ws_arg(args, argc, 0));
    return ws_undef();
  }
  return ws_invoke_member(self, method, args, argc, what);
}
WS_MEMBER_INVOKE(ws_rcontroller)

static ScrDyn *ws_rcontroller_get(void *ptr, const char *key, size_t len) {
  if (ws_name(key, len, "desiredSize")) return ws_rcontroller_desired_size(ptr);
  ScrDyn *own = ws_own_get(ptr, key, len);
  if (own) return own;
  return scr_dyn_handle_class_member(SCR_DYNH_WS_RCONTROLLER, ptr, key, len);
}

static const ScrDynHandleMethod ws_rcontroller_methods[] = {
    {"close", 0, false, NULL}, {"enqueue", 0, false, NULL}, {"error", 0, false, NULL}, {NULL, 0, false, NULL},
};


static const char *const ws_rcontroller_order[] = {"desiredSize", "close", "enqueue", "error", NULL};

static const ScrDynHandleClass ws_rcontroller_class = {
    "ReadableStreamDefaultController", 0, NULL, ws_rcontroller_accessors, NULL, ws_rcontroller_order, ws_rcontroller_method,
};

/* WritableStream */
static ScrDyn *ws_writable_method(void *ptr, ScrDyn *self, const char *method, ScrDyn *const *args, size_t argc,
                                  const char *what) {
  WsWritable *s = ptr;
  size_t len = strlen(method);
  if (ws_name(method, len, "abort")) {
    if (ws_writable_locked(s)) return ws_promise_box(ws_promise_state_rejected("WritableStream is locked"));
    return ws_promise_box(ws_writable_abort(s, ws_arg(args, argc, 0)));
  }
  if (ws_name(method, len, "close")) {
    if (ws_writable_locked(s)) return ws_promise_box(ws_promise_state_rejected("WritableStream is locked"));
    if (s->close_queued_or_inflight)
      return ws_promise_box(ws_promise_state_rejected("Failure closing WritableStream"));
    return ws_promise_box(ws_writable_close(s));
  }
  if (ws_name(method, len, "getWriter")) {
    WsWriter *w = ws_writer_new(s);
    if (!w) return NULL;
    ScrDyn *box = ws_writer_box(w);
    ws_release(w);
    return box;
  }
  return ws_invoke_member(self, method, args, argc, what);
}
WS_MEMBER_INVOKE(ws_writable)

static ScrDyn *ws_writable_get(void *ptr, const char *key, size_t len) {
  WsWritable *s = ptr;
  if (ws_name(key, len, "locked")) return scr_dyn_new_bool(ws_writable_locked(s));
  ScrDyn *own = ws_own_get(ptr, key, len);
  if (own) return own;
  return scr_dyn_handle_class_member(SCR_DYNH_WS_WRITABLE, ptr, key, len);
}

static const ScrDynHandleMethod ws_writable_methods[] = {
    {"abort", 0, true, NULL}, {"close", 0, true, NULL}, {"getWriter", 0, false, NULL}, {NULL, 0, false, NULL},
};


static const char *const ws_writable_order[] = {"locked", "abort", "close", "getWriter", NULL};

static const ScrDynHandleClass ws_writable_class = {
    "WritableStream", 0, ws_writable_construct, ws_writable_accessors, NULL, ws_writable_order, ws_writable_method,
};

/* WritableStreamDefaultWriter */
static ScrDyn *ws_writer_construct(ScrDyn *const *args, size_t argc) {
  ScrDyn *stream = ws_arg(args, argc, 0);
  WsWritable *s = ws_writable_of(stream);
  if (!s) {
    scr_dyn_arg_type_fail("stream", "an instance of WritableStream", stream);
    return NULL;
  }
  WsWriter *w = ws_writer_new(s);
  if (!w) return NULL;
  ScrDyn *box = ws_writer_box(w);
  ws_release(w);
  return box;
}

static const char ws_writer_unbound[] = "Writer is not bound to a WritableStream";

static ScrDyn *ws_writer_method(void *ptr, ScrDyn *self, const char *method, ScrDyn *const *args, size_t argc,
                                const char *what) {
  WsWriter *w = ptr;
  size_t len = strlen(method);
  if (ws_name(method, len, "abort")) {
    if (!w->stream) return ws_promise_box(ws_promise_state_rejected(ws_writer_unbound));
    return ws_promise_box(ws_writable_abort(w->stream, ws_arg(args, argc, 0)));
  }
  if (ws_name(method, len, "close")) {
    if (!w->stream) return ws_promise_box(ws_promise_state_rejected(ws_writer_unbound));
    if (w->stream->close_queued_or_inflight)
      return ws_promise_box(ws_promise_state_rejected("Failure to close WritableStream"));
    return ws_promise_box(ws_writable_close(w->stream));
  }
  if (ws_name(method, len, "releaseLock")) {
    if (w->stream) ws_writer_release_lock(w);
    return ws_undef();
  }
  if (ws_name(method, len, "write")) {
    if (!w->stream) return ws_promise_box(ws_promise_state_rejected(ws_writer_unbound));
    return ws_promise_box(ws_writer_write(w, ws_arg(args, argc, 0)));
  }
  return ws_invoke_member(self, method, args, argc, what);
}
WS_MEMBER_INVOKE(ws_writer)

static ScrDyn *ws_writer_get(void *ptr, const char *key, size_t len) {
  WsWriter *w = ptr;
  if (ws_name(key, len, "closed")) return scr_dyn_new_promise(ws_writer_closed_promise(w));
  if (ws_name(key, len, "ready")) return scr_dyn_new_promise(ws_writer_ready_promise(w));
  if (ws_name(key, len, "desiredSize")) {
    if (!w->stream) {
      ws_state_error(ws_writer_unbound);
      return NULL;
    }
    return ws_writer_desired_size(w);
  }
  ScrDyn *own = ws_own_get(ptr, key, len);
  if (own) return own;
  return scr_dyn_handle_class_member(SCR_DYNH_WS_WRITER, ptr, key, len);
}

static const ScrDynHandleMethod ws_writer_methods[] = {
    {"abort", 0, true, NULL},       {"close", 0, true, NULL}, {"releaseLock", 0, false, NULL},
    {"write", 0, true, NULL},       {NULL, 0, false, NULL},
};


static const char *const ws_writer_order[] = {"closed", "desiredSize", "ready", "abort",
                                              "close",  "releaseLock", "write", NULL};

static const ScrDynHandleClass ws_writer_class = {
    "WritableStreamDefaultWriter", 1, ws_writer_construct, ws_writer_accessors, NULL, ws_writer_order, ws_writer_method,
};

/* WritableStreamDefaultController */
static ScrDyn *ws_wcontroller_method(void *ptr, ScrDyn *self, const char *method, ScrDyn *const *args,
                                     size_t argc, const char *what) {
  WsWController *c = ptr;
  size_t len = strlen(method);
  if (ws_name(method, len, "error")) {
    if (c->stream->state == WS_W_WRITABLE) ws_wcontroller_error(c, ws_arg(args, argc, 0));
    return ws_undef();
  }
  return ws_invoke_member(self, method, args, argc, what);
}
WS_MEMBER_INVOKE(ws_wcontroller)

static ScrDyn *ws_wcontroller_get(void *ptr, const char *key, size_t len) {
  if (ws_name(key, len, "signal")) return ws_wcontroller_signal(ptr);
  ScrDyn *own = ws_own_get(ptr, key, len);
  if (own) return own;
  return scr_dyn_handle_class_member(SCR_DYNH_WS_WCONTROLLER, ptr, key, len);
}

static const ScrDynHandleMethod ws_wcontroller_methods[] = {{"error", 0, false, NULL}, {NULL, 0, false, NULL}};


static const char *const ws_wcontroller_order[] = {"signal", "error", NULL};

static const ScrDynHandleClass ws_wcontroller_class = {
    "WritableStreamDefaultController", 0, NULL, ws_wcontroller_accessors, NULL, ws_wcontroller_order, ws_wcontroller_method,
};

/* TransformStream */
static ScrDyn *ws_transform_get(void *ptr, const char *key, size_t len) {
  WsTransform *t = ptr;
  if (ws_name(key, len, "readable")) return ws_stream_box(t->readable);
  if (ws_name(key, len, "writable")) return ws_writable_box(t->writable);
  ScrDyn *own = ws_own_get(ptr, key, len);
  if (own) return own;
  return scr_dyn_handle_class_member(SCR_DYNH_WS_TRANSFORM, ptr, key, len);
}

static ScrDyn *ws_transform_method(void *ptr, ScrDyn *self, const char *method, ScrDyn *const *args, size_t argc,
                                   const char *what) {
  (void)ptr;
  return ws_invoke_member(self, method, args, argc, what);
}
WS_MEMBER_INVOKE(ws_transform)


static const ScrDynHandleClass ws_transform_class = {
    "TransformStream", 0, ws_transform_construct, ws_transform_accessors, NULL, NULL, ws_transform_method,
};

/* TransformStreamDefaultController */
static ScrDyn *ws_tcontroller_method(void *ptr, ScrDyn *self, const char *method, ScrDyn *const *args,
                                     size_t argc, const char *what) {
  WsTController *c = ptr;
  size_t len = strlen(method);
  if (ws_name(method, len, "enqueue")) {
    if (!ws_tcontroller_enqueue(c, ws_arg(args, argc, 0))) return NULL;
    return ws_undef();
  }
  if (ws_name(method, len, "error")) {
    ws_transform_error(c->stream, ws_arg(args, argc, 0));
    return ws_undef();
  }
  if (ws_name(method, len, "terminate")) {
    ws_tcontroller_terminate(c);
    return ws_undef();
  }
  return ws_invoke_member(self, method, args, argc, what);
}
WS_MEMBER_INVOKE(ws_tcontroller)

static ScrDyn *ws_tcontroller_get(void *ptr, const char *key, size_t len) {
  WsTController *c = ptr;
  if (ws_name(key, len, "desiredSize")) return ws_rcontroller_desired_size(c->stream->readable->controller);
  ScrDyn *own = ws_own_get(ptr, key, len);
  if (own) return own;
  return scr_dyn_handle_class_member(SCR_DYNH_WS_TCONTROLLER, ptr, key, len);
}

static const ScrDynHandleMethod ws_tcontroller_methods[] = {
    {"enqueue", 0, false, NULL}, {"error", 0, false, NULL}, {"terminate", 0, false, NULL}, {NULL, 0, false, NULL},
};


static const char *const ws_tcontroller_order[] = {"desiredSize", "enqueue", "error", "terminate", NULL};

static const ScrDynHandleClass ws_tcontroller_class = {
    "TransformStreamDefaultController", 0, NULL, ws_tcontroller_accessors, NULL, ws_tcontroller_order, ws_tcontroller_method,
};

/* ── TextEncoderStream and TextDecoderStream (webstreams/encoding.js) */

/* A TransformStream whose transformer callbacks are native functions, as
 * Node's arrow-function transformers are. */
typedef struct WsTextStream {
  WsObj obj;
  WsTransform *transform; /* +1 */
  bool decoder;
  /* TextEncoderStream: the trailing lone high surrogate of the last chunk
   * (its 3-byte WTF-8 storage), or NULL. */
  ScrStr *pending_high;
  /* TextDecoderStream: the decoder's encoding id (-1 = utf-8), flags and
   * streaming state. */
  double encoding;
  bool fatal, ignore_bom;
  ScrDyn *state; /* +1 */
} WsTextStream;

static void ws_text_trace(void *obj, ScrTraceVisit visit, void *ctx) {
  WsTextStream *t = obj;
  ws_visit(t->transform, visit, ctx);
  ws_visit(t->state, visit, ctx);
}

static void ws_text_drop(void *obj, bool gc) {
  WsTextStream *t = obj;
  ws_drop_obj(t->transform, gc);
  if (t->pending_high) scr_str_release(t->pending_high);
  ws_drop_dyn(t->state, gc);
}

static const WsObjType ws_text_encoder_type = {ws_text_trace, ws_text_drop, "TextEncoderStream",
                                               ws_text_encoder_accessors};
static const WsObjType ws_text_decoder_type = {ws_text_trace, ws_text_drop, "TextDecoderStream",
                                               ws_text_decoder_accessors};

static WsTextStream *ws_text_of(ScrClosure *closure) { return scr_box_get_ref(closure->caps[0]); }

/* The controller argument of a transformer callback. */
static WsTController *ws_text_controller(ScrDyn *const *args, size_t argc) {
  ScrDyn *c = ws_arg(args, argc, 1);
  if (c->kind == SCR_DYN_HANDLE && c->v.handle.tag == SCR_DYNH_WS_TCONTROLLER) return c->v.handle.ptr;
  return NULL;
}

/* String(value): ToString, with a symbol's description. */
static ScrStr *ws_string_of(ScrDyn *value) {
  if (value->kind == SCR_DYN_SYMBOL) return scr_sym_to_string(value->v.symbol.value);
  return scr_dyn_string_coerce_js(value);
}

/* The bytes as a Uint8Array chunk enqueued on the transform: false with
 * the exception pending. */
static bool ws_text_enqueue_bytes(WsTController *c, ScrBytes *bytes) {
  bytes->is_buffer = false;
  ScrDyn *chunk = scr_dyn_new_bytes(bytes);
  bool ok = ws_tcontroller_enqueue(c, chunk);
  scr_dyn_release(chunk);
  return ok;
}

static ScrDyn *ws_text_encoder_transform(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  WsTextStream *t = ws_text_of(closure);
  WsTController *c = ws_text_controller(args, argc);
  ScrDyn *result = NULL;
  ScrStr *chunk = ws_string_of(ws_arg(args, argc, 0));
  if (!chunk) goto done;
  if (chunk->len == 0) {
    result = ws_undef();
    goto done;
  }
  if (t->pending_high) {
    ScrStr *joined = scr_str_concat(t->pending_high, chunk);
    scr_str_release(chunk);
    scr_str_release(t->pending_high);
    t->pending_high = NULL;
    chunk = joined;
  }
  /* A lone high surrogate D800..DBFF is ED A0..AF xx. */
  size_t len = chunk->len;
  if (len >= 3 && (unsigned char)chunk->data[len - 3] == 0xED &&
      ((unsigned char)chunk->data[len - 2] & 0xF0) == 0xA0) {
    t->pending_high = scr_str_new(chunk->data + len - 3, 3);
    ScrStr *rest = scr_str_new(chunk->data, len - 3);
    scr_str_release(chunk);
    chunk = rest;
    if (chunk->len == 0) {
      result = ws_undef();
      goto done;
    }
  }
  ScrStr *utf8 = scr_str_new("utf8", 4);
  ScrBytes *bytes = scr_bytes_from_str(chunk, utf8);
  scr_str_release(utf8);
  bool ok = c && ws_text_enqueue_bytes(c, bytes);
  scr_bytes_release(bytes);
  if (ok) result = ws_undef();
done:
  if (chunk) scr_str_release(chunk);
  ws_release(t);
  return result;
}

static ScrDyn *ws_text_encoder_flush(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  WsTextStream *t = ws_text_of(closure);
  /* flush receives the controller as its only argument. */
  ScrDyn *cv = ws_arg(args, argc, 0);
  WsTController *c = cv->kind == SCR_DYN_HANDLE && cv->v.handle.tag == SCR_DYNH_WS_TCONTROLLER ? cv->v.handle.ptr : NULL;
  ScrDyn *result = ws_undef();
  if (t->pending_high && c) {
    ScrBytes *bytes = scr_bytes_new(SCR_BYTES_U8, 3);
    bytes->data[0] = 0xEF;
    bytes->data[1] = 0xBF;
    bytes->data[2] = 0xBD;
    if (!ws_text_enqueue_bytes(c, bytes)) {
      scr_dyn_release(result);
      result = NULL;
    }
    scr_bytes_release(bytes);
  }
  ws_release(t);
  return result;
}

static ScrDyn *ws_text_decoder_transform(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  WsTextStream *t = ws_text_of(closure);
  WsTController *c = ws_text_controller(args, argc);
  ScrDyn *result = NULL;
  ScrDyn *chunk = ws_arg(args, argc, 0);
  if (chunk->kind == SCR_DYN_UNDEF) {
    scr_dyn_arg_type_fail("chunk", "of type string", chunk);
    ws_release(t);
    return NULL;
  }
  ScrBytes *bytes = scr_bytes_buffer_source(chunk);
  if (!bytes) {
    ws_release(t);
    return NULL;
  }
  ScrStr *text = scr_text_decode_stream(t->state, bytes, t->encoding, t->fatal, t->ignore_bom, true);
  scr_bytes_release(bytes);
  if (text) {
    bool ok = true;
    if (text->len) {
      ScrDyn *value = scr_dyn_new_str(text);
      ok = c && ws_tcontroller_enqueue(c, value);
      scr_dyn_release(value);
    }
    scr_str_release(text);
    if (ok) result = ws_undef();
  }
  ws_release(t);
  return result;
}

static ScrDyn *ws_text_decoder_flush(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  WsTextStream *t = ws_text_of(closure);
  ScrDyn *cv = ws_arg(args, argc, 0);
  WsTController *c = cv->kind == SCR_DYN_HANDLE && cv->v.handle.tag == SCR_DYNH_WS_TCONTROLLER ? cv->v.handle.ptr : NULL;
  ScrDyn *result = NULL;
  ScrBytes *empty = scr_bytes_new(SCR_BYTES_U8, 0);
  ScrStr *text = scr_text_decode_stream(t->state, empty, t->encoding, t->fatal, t->ignore_bom, false);
  scr_bytes_release(empty);
  if (text) {
    bool ok = true;
    if (text->len) {
      ScrDyn *value = scr_dyn_new_str(text);
      ok = c && ws_tcontroller_enqueue(c, value);
      scr_dyn_release(value);
    }
    scr_str_release(text);
    if (ok && c) ws_tcontroller_terminate(c);
    if (ok) result = ws_undef();
  }
  ws_release(t);
  return result;
}

static ScrDyn *ws_text_callback(WsTextStream *t, ScrDynThunk thunk, uint32_t arity, const char *name) {
  ScrClosure *closure = scr_closure_new(NULL, 1);
  closure->caps[0] = scr_box_new_obj(ws_retain, ws_release, ws_obj_trace);
  scr_box_set_ref(closure->caps[0], ws_retain(t));
  return scr_dyn_new_func(closure, thunk, arity, "", name);
}

/* The transform with the stream's native transformer: false with the
 * exception pending. */
static bool ws_text_attach(WsTextStream *t, ScrDynThunk transform, ScrDynThunk flush) {
  ScrDyn *transformer = scr_dyn_new_obj();
  scr_dyn_obj_set(transformer, "transform", 9, ws_text_callback(t, transform, 2, "transform"));
  scr_dyn_obj_set(transformer, "flush", 5, ws_text_callback(t, flush, 1, "flush"));
  ScrDyn *box = ws_transform_construct(&transformer, 1);
  scr_dyn_release(transformer);
  if (!box) return false;
  t->transform = ws_retain(box->v.handle.ptr);
  scr_dyn_release(box);
  return true;
}

static ScrDyn *ws_text_encoder_construct(ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc;
  ws_install();
  WsTextStream *t = ws_obj_new(sizeof *t, &ws_text_encoder_type);
  ScrDyn *result = NULL;
  if (ws_text_attach(t, ws_text_encoder_transform, ws_text_encoder_flush))
    result = ws_box(t, SCR_DYNH_WS_TEXT_ENCODER);
  ws_release(t);
  return result;
}

/* new TextDecoder(encoding, options) as TextDecoderStream makes it. */
static ScrDyn *ws_text_decoder_construct(ScrDyn *const *args, size_t argc) {
  ScrDyn *label = argc > 0 && args[0]->kind != SCR_DYN_UNDEF ? args[0] : NULL;
  ScrDyn *options = argc > 1 && args[1]->kind != SCR_DYN_UNDEF ? args[1] : NULL;
  double encoding = -1;
  if (label) {
    encoding = scr_text_decoder_encoding(label);
    if (scr_exc_pending()) return NULL;
  }
  bool fatal = false, ignore_bom = false;
  if (options) {
    if (!ws_validate_object(options, "options", true)) return NULL;
    ScrDyn *f = ws_get(options, "fatal");
    if (!f) return NULL;
    fatal = scr_dyn_truthy(f);
    scr_dyn_release(f);
    ScrDyn *b = ws_get(options, "ignoreBOM");
    if (!b) return NULL;
    ignore_bom = scr_dyn_truthy(b);
    scr_dyn_release(b);
  }
  if (encoding >= 0) {
    ScrStr *name = scr_text_decoder_name(encoding);
    char buf[160];
    int n = snprintf(buf, sizeof buf, "TextDecoderStream for the '%.*s' encoding is not supported yet", (int)name->len,
                     name->data);
    scr_str_release(name);
    scr_throw_error_msg_code(SCR_ERR_ERROR, buf, (size_t)n, "SC2020");
    return NULL;
  }
  ws_install();
  WsTextStream *t = ws_obj_new(sizeof *t, &ws_text_decoder_type);
  t->decoder = true;
  t->encoding = encoding;
  t->fatal = fatal;
  t->ignore_bom = ignore_bom;
  t->state = scr_dyn_new_obj();
  ScrDyn *result = NULL;
  if (ws_text_attach(t, ws_text_decoder_transform, ws_text_decoder_flush))
    result = ws_box(t, SCR_DYNH_WS_TEXT_DECODER);
  ws_release(t);
  return result;
}

static ScrDyn *ws_text_get(void *ptr, const char *key, size_t len) {
  WsTextStream *t = ptr;
  ScrDynHandleTag tag = t->decoder ? SCR_DYNH_WS_TEXT_DECODER : SCR_DYNH_WS_TEXT_ENCODER;
  if (ws_name(key, len, "encoding")) {
    ScrStr *name = scr_text_decoder_name(t->decoder ? t->encoding : -1);
    ScrDyn *value = scr_dyn_new_str(name);
    scr_str_release(name);
    return value;
  }
  if (ws_name(key, len, "readable")) return ws_stream_box(t->transform->readable);
  if (ws_name(key, len, "writable")) return ws_writable_box(t->transform->writable);
  if (t->decoder && ws_name(key, len, "fatal")) return scr_dyn_new_bool(t->fatal);
  if (t->decoder && ws_name(key, len, "ignoreBOM")) return scr_dyn_new_bool(t->ignore_bom);
  ScrDyn *own = ws_own_get(ptr, key, len);
  if (own) return own;
  return scr_dyn_handle_class_member(tag, ptr, key, len);
}

static ScrDyn *ws_text_method(void *ptr, ScrDyn *self, const char *method, ScrDyn *const *args, size_t argc,
                              const char *what) {
  return ws_invoke_member(self, method, args, argc, what);
}
WS_MEMBER_INVOKE(ws_text)

static const ScrDynHandleClass ws_text_encoder_class = {
    "TextEncoderStream", 0, ws_text_encoder_construct, ws_text_encoder_accessors, NULL, NULL, ws_text_method,
};

static const ScrDynHandleClass ws_text_decoder_class = {
    "TextDecoderStream", 0, ws_text_decoder_construct, ws_text_decoder_accessors, NULL, NULL, ws_text_method,
};

/* ── queuing strategies ────────────────────────────────────────────── */

typedef struct WsStrategy {
  size_t rc;
  bool bytes;
  double high_water_mark;
} WsStrategy;

static void *ws_strategy_retain(void *p) {
  ((WsStrategy *)p)->rc++;
  return p;
}
static void ws_strategy_release(void *p) {
  WsStrategy *q = p;
  if (--q->rc == 0) free(q);
}

static ScrDyn *ws_count_size(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure;
  (void)args;
  (void)argc;
  return scr_dyn_new_num(1);
}

/* (chunk) => chunk.byteLength */
static ScrDyn *ws_byte_size(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure;
  return ws_get(ws_arg(args, argc, 0), "byteLength");
}

static SCR_TL ScrDyn *ws_size_functions[2];

static void ws_size_functions_teardown(void) {
  for (int i = 0; i < 2; i++) {
    if (ws_size_functions[i]) scr_dyn_release(ws_size_functions[i]);
    ws_size_functions[i] = NULL;
  }
}

static ScrDyn *ws_size_function(bool bytes) {
  int i = bytes ? 1 : 0;
  if (!ws_size_functions[i]) {
    if (!ws_size_functions[0] && !ws_size_functions[1]) scr_atexit(ws_size_functions_teardown);
    ws_size_functions[i] = scr_dyn_new_func(scr_closure_new(NULL, 0), bytes ? ws_byte_size : ws_count_size,
                                            bytes ? 1 : 0, "", "size");
  }
  return scr_dyn_retain(ws_size_functions[i]);
}

static ScrDyn *ws_strategy_construct(ScrDyn *const *args, size_t argc, bool bytes) {
  ScrDyn *init = ws_arg(args, argc, 0);
  /* validateObject without options: arrays and functions are refused too. */
  if (init->kind == SCR_DYN_ARR || init->kind == SCR_DYN_FUNC || !ws_validate_object(init, "init", false)) {
    if (!scr_exc_pending()) scr_dyn_arg_type_fail("init", "of type object", init);
    return NULL;
  }
  ScrDyn *hwm = ws_get(init, "highWaterMark");
  if (!hwm) return NULL;
  if (hwm->kind == SCR_DYN_UNDEF) {
    scr_dyn_release(hwm);
    static const char message[] = "init.highWaterMark is required";
    scr_throw_error_msg_code(SCR_ERR_TYPE, message, sizeof message - 1, "ERR_MISSING_OPTION");
    return NULL;
  }
  double value = scr_dyn_number_coerce(hwm);
  scr_dyn_release(hwm);
  if (scr_exc_pending()) return NULL;
  ws_install();
  WsStrategy *q = ws_alloc(sizeof *q);
  q->rc = 1;
  q->bytes = bytes;
  q->high_water_mark = value;
  ScrDyn *box = scr_dyn_new_handle(q, bytes ? SCR_DYNH_WS_BYTE_STRATEGY : SCR_DYNH_WS_COUNT_STRATEGY);
  ws_strategy_release(q);
  return box;
}

static ScrDyn *ws_count_strategy_construct(ScrDyn *const *args, size_t argc) {
  return ws_strategy_construct(args, argc, false);
}

static ScrDyn *ws_byte_strategy_construct(ScrDyn *const *args, size_t argc) {
  return ws_strategy_construct(args, argc, true);
}

static ScrDyn *ws_strategy_get(void *ptr, const char *key, size_t len) {
  WsStrategy *q = ptr;
  if (ws_name(key, len, "highWaterMark")) return scr_dyn_new_num(q->high_water_mark);
  if (ws_name(key, len, "size")) return ws_size_function(q->bytes);
  return scr_dyn_handle_class_member(q->bytes ? SCR_DYNH_WS_BYTE_STRATEGY : SCR_DYNH_WS_COUNT_STRATEGY, ptr, key, len);
}

static ScrDyn *ws_strategy_invoke(void *ptr, ScrDyn *self, const char *method, ScrDyn *const *args, size_t argc,
                                  const char *what) {
  (void)ptr;
  return ws_invoke_member(self, method, args, argc, what);
}

static const ScrDynHandleAccessor ws_strategy_accessors[] = {{"highWaterMark", false}, {"size", false}, {NULL, false}};

static const ScrDynHandleClass ws_count_strategy_class = {
    "CountQueuingStrategy", 1, ws_count_strategy_construct, ws_strategy_accessors, NULL, NULL,
};

static const ScrDynHandleClass ws_byte_strategy_class = {
    "ByteLengthQueuingStrategy", 1, ws_byte_strategy_construct, ws_strategy_accessors, NULL, NULL,
};

/* ── installation and the compiler's entry points ─────────────────── */

static bool ws_set_noop(void *h, const char *key, size_t len, const ScrDyn *value) {
  (void)h;
  (void)key;
  (void)len;
  (void)value;
  return false;
}

#define WS_OPS(NAME, CLS, RETAIN, RELEASE, INVOKE, GET, SET, METHODS, INVALID) \
  static const ScrDynHandleOps NAME = {                                           \
      .cls = CLS,                                                                 \
      .retain = RETAIN,                                                           \
      .release = RELEASE,                                                         \
      .invoke = INVOKE,                                                           \
      .get = GET,                                                                 \
      .set = SET,                                                                 \
      .json_empty_object = true,                                                  \
      .to_string_tag = CLS,                                                       \
      .methods = METHODS,                                                         \
      .invalid_this = INVALID,                                                    \
      .rejected = ws_rejected_value,                                              \
  }

static const ScrDynHandleOps ws_readable_ops = {
    .cls = "ReadableStream",
    .retain = ws_retain,
    .release = ws_release,
    .invoke = ws_readable_invoke,
    .get = ws_readable_get,
    .set = ws_own_set,
    .json_empty_object = true,
    .to_string_tag = "ReadableStream",
    .symbol_get = ws_readable_symbol_get,
    .methods = ws_readable_methods,
    .invalid_this = "Value of \"this\" must be of type ReadableStream",
    .rejected = ws_rejected_value,
};

WS_OPS(ws_reader_ops, "ReadableStreamDefaultReader", ws_retain, ws_release, ws_reader_invoke, ws_reader_get, ws_own_set, ws_reader_methods,
       "Value of \"this\" must be of type ReadableStreamDefaultReader");
WS_OPS(ws_rcontroller_ops, "ReadableStreamDefaultController", ws_retain, ws_release, ws_rcontroller_invoke, ws_rcontroller_get, ws_own_set, ws_rcontroller_methods,
       "Value of \"this\" must be of type ReadableStreamDefaultController");
WS_OPS(ws_writable_ops, "WritableStream", ws_retain, ws_release, ws_writable_invoke, ws_writable_get, ws_own_set,
       ws_writable_methods, "Value of \"this\" must be of type WritableStream");
WS_OPS(ws_writer_ops, "WritableStreamDefaultWriter", ws_retain, ws_release, ws_writer_invoke, ws_writer_get, ws_own_set,
       ws_writer_methods, "Value of \"this\" must be of type WritableStreamDefaultWriter");
WS_OPS(ws_wcontroller_ops, "WritableStreamDefaultController", ws_retain, ws_release, ws_wcontroller_invoke, ws_wcontroller_get, ws_own_set, ws_wcontroller_methods, "Value of \"this\" must be of type WritableStreamDefaultController");
WS_OPS(ws_transform_ops, "TransformStream", ws_retain, ws_release, ws_transform_invoke, ws_transform_get, ws_own_set, NULL,
       "Value of \"this\" must be of type TransformStream");
WS_OPS(ws_tcontroller_ops, "TransformStreamDefaultController", ws_retain, ws_release, ws_tcontroller_invoke, ws_tcontroller_get, ws_own_set, ws_tcontroller_methods, "Value of \"this\" must be of type TransformStreamDefaultController");
/* TextEncoderStream and TextDecoderStream have no @@toStringTag. */
static const ScrDynHandleOps ws_text_encoder_ops = {
    .cls = "TextEncoderStream",
    .retain = ws_retain,
    .release = ws_release,
    .invoke = ws_text_invoke,
    .get = ws_text_get,
    .set = ws_own_set,
    .json_empty_object = true,
    .invalid_this = "Value of \"this\" must be of type TextEncoderStream",
    .rejected = ws_rejected_value,
};
static const ScrDynHandleOps ws_text_decoder_ops = {
    .cls = "TextDecoderStream",
    .retain = ws_retain,
    .release = ws_release,
    .invoke = ws_text_invoke,
    .get = ws_text_get,
    .set = ws_own_set,
    .json_empty_object = true,
    .invalid_this = "Value of \"this\" must be of type TextDecoderStream",
    .rejected = ws_rejected_value,
};
WS_OPS(ws_count_strategy_ops, "CountQueuingStrategy", ws_strategy_retain, ws_strategy_release, ws_strategy_invoke, ws_strategy_get, ws_set_noop, NULL, "Value of \"this\" must be of type CountQueuingStrategy");
WS_OPS(ws_byte_strategy_ops, "ByteLengthQueuingStrategy", ws_strategy_retain, ws_strategy_release, ws_strategy_invoke, ws_strategy_get, ws_set_noop, NULL,
       "Value of \"this\" must be of type ByteLengthQueuingStrategy");

static SCR_TL bool ws_installed;

static void ws_install(void) {
  if (ws_installed) return;
  ws_installed = true;
  /* Symbol.asyncIterator, which the streams answer async iteration by
   * (scr_dyn_iterable_kind, for await). */
  ScrStr *name = scr_str_new("asyncIterator", 13);
  scr_sym_release(scr_sym_well_known(name));
  scr_str_release(name);
  scr_web_stream_bridge = &ws_fetch_bridge;
  scr_dyn_handle_class_install(SCR_DYNH_WS_READABLE, &ws_readable_ops, &ws_readable_class);
  scr_dyn_handle_class_install(SCR_DYNH_WS_READER, &ws_reader_ops, &ws_reader_class);
  scr_dyn_handle_class_install(SCR_DYNH_WS_RCONTROLLER, &ws_rcontroller_ops, &ws_rcontroller_class);
  scr_dyn_handle_class_install(SCR_DYNH_WS_COUNT_STRATEGY, &ws_count_strategy_ops, &ws_count_strategy_class);
  scr_dyn_handle_class_install(SCR_DYNH_WS_BYTE_STRATEGY, &ws_byte_strategy_ops, &ws_byte_strategy_class);
  scr_dyn_handle_class_install(SCR_DYNH_WS_WRITABLE, &ws_writable_ops, &ws_writable_class);
  scr_dyn_handle_class_install(SCR_DYNH_WS_WRITER, &ws_writer_ops, &ws_writer_class);
  scr_dyn_handle_class_install(SCR_DYNH_WS_WCONTROLLER, &ws_wcontroller_ops, &ws_wcontroller_class);
  scr_dyn_handle_class_install(SCR_DYNH_WS_TRANSFORM, &ws_transform_ops, &ws_transform_class);
  scr_dyn_handle_class_install(SCR_DYNH_WS_TCONTROLLER, &ws_tcontroller_ops, &ws_tcontroller_class);
  scr_dyn_handle_class_install(SCR_DYNH_WS_TEXT_ENCODER, &ws_text_encoder_ops, &ws_text_encoder_class);
  scr_dyn_handle_class_install(SCR_DYNH_WS_TEXT_DECODER, &ws_text_decoder_ops, &ws_text_decoder_class);
  /* The fetch unit's streams, readers, controllers, writers and identity
   * transforms (a Response body) are instances of the same classes. */
  scr_dyn_handle_class_alias(SCR_DYNH_WEB_STREAM, SCR_DYNH_WS_READABLE);
  scr_dyn_handle_class_alias(SCR_DYNH_WEB_READER, SCR_DYNH_WS_READER);
  scr_dyn_handle_class_alias(SCR_DYNH_WEB_CONTROLLER, SCR_DYNH_WS_RCONTROLLER);
  scr_dyn_handle_class_alias(SCR_DYNH_WEB_WRITABLE, SCR_DYNH_WS_WRITABLE);
  scr_dyn_handle_class_alias(SCR_DYNH_WEB_WRITER, SCR_DYNH_WS_WRITER);
  scr_dyn_handle_class_alias(SCR_DYNH_WEB_TRANSFORM, SCR_DYNH_WS_TRANSFORM);
}

/* The classes in the frontend's WEB_STREAM_CLASSES order. */
static ScrDynHandleTag ws_class_tag(double kind) {
  static const ScrDynHandleTag tags[] = {
      SCR_DYNH_WS_READABLE,      SCR_DYNH_WS_READER, SCR_DYNH_WS_RCONTROLLER,
      SCR_DYNH_WS_COUNT_STRATEGY, SCR_DYNH_WS_BYTE_STRATEGY, SCR_DYNH_WS_WRITABLE,
      SCR_DYNH_WS_WRITER,        SCR_DYNH_WS_WCONTROLLER,  SCR_DYNH_WS_TRANSFORM,
      SCR_DYNH_WS_TCONTROLLER,   SCR_DYNH_WS_TEXT_ENCODER, SCR_DYNH_WS_TEXT_DECODER,
  };
  int index = (int)kind;
  if (index < 0 || index >= (int)(sizeof tags / sizeof tags[0])) scr_trap("scriptc: unknown web stream class\n");
  return tags[index];
}

void scr_webstream_install(void) { ws_install(); }

/* The web stream class `kind` names as a constructor value (+1): the
 * compiler's webstream.class. */
ScrDyn *scr_webstream_class(double kind) {
  ws_install();
  return scr_dyn_handle_class_value(ws_class_tag(kind));
}

/* `value instanceof <class>` (webstream.instanceOf): a handle of the class,
 * or an object with the class's prototype on its chain. */
bool scr_webstream_instanceof(ScrDyn *value, double kind) {
  ws_install();
  ScrDynHandleTag tag = ws_class_tag(kind);
  if (value->kind == SCR_DYN_HANDLE) return scr_dyn_handle_class_tag_of(value) == tag;
  if (value->kind != SCR_DYN_OBJ && value->kind != SCR_DYN_ARR && value->kind != SCR_DYN_FUNC) return false;
  ScrDyn *prototype = scr_dyn_handle_class_prototype(tag);
  bool found = false;
  ScrDyn *current = scr_dyn_get_prototype(value);
  while (current && current->kind != SCR_DYN_NULL && current->kind == SCR_DYN_OBJ) {
    if (current == prototype) {
      found = true;
      break;
    }
    ScrDyn *next = scr_dyn_get_prototype(current);
    scr_dyn_release(current);
    current = next;
  }
  if (current) scr_dyn_release(current);
  if (scr_exc_pending()) scr_exc_clear();
  scr_dyn_release(prototype);
  return found;
}
