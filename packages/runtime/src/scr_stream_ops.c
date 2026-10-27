/* node:stream's Readable operators (lib/internal/streams/operators.js):
 * map, filter, forEach, toArray, some, find, every, flatMap, drop, take
 * and reduce, over streams whose chunks are strings or Buffers. Linked
 * only when a program calls one (the streamOps feature).
 *
 * Node writes the operators as async functions and async generators, and
 * wraps the stream-returning ones in Readable.from. Their observable
 * ordering (when callbacks run relative to the consumer, when promises
 * settle) is the order of those functions' awaits, so this unit follows
 * the JavaScript source step for step: every `await x` is one op_await
 * (a promise job after x settles, the same hop a compiled await takes),
 * the generators follow the async generator protocol (request queue,
 * yield awaiting its operand, return and throw requests), and the
 * Readable.from(generator) wrapper is from.js's nextAsync/close. Each
 * step runs on its own fiber through scr_async_spawn_after, so the unit
 * works on every target, wasm32 included.
 *
 * The user's callbacks are checked-dynamic function values called with
 * one argument (the chunk); callbacks that declare the options argument
 * ({ signal }) are refused, because the AbortSignal Node passes there has
 * no representation here. options.signal itself is polled where Node
 * polls it (signal.aborted), so no listener is needed. Stream-returning
 * operators produce object-mode Readables whose entries are strings or
 * Buffers; any other value is refused when it would be pushed. */
#include "scr_runtime.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void op_oom(void) {
  fputs("scriptc: out of memory\n", stderr);
  abort();
}

static void *op_alloc(size_t n) {
  void *p = calloc(1, n);
  if (!p) op_oom();
  return p;
}

/* ── refcounted step owners ────────────────────────────────────────── */

typedef struct OpObj OpObj;
struct OpObj {
  size_t rc;
  void (*drop)(OpObj *self); /* frees the object's own fields and itself */
};

static void *op_ref(void *o) {
  ((OpObj *)o)->rc++;
  return o;
}

static void op_unref(void *o) {
  OpObj *b = o;
  if (--b->rc == 0) b->drop(b);
}

/* ── sentinels ─────────────────────────────────────────────────────── */

/* kEmpty (a callback result that yields nothing), kEof (the pump's end
 * marker) and the generators' done marker: process-lived objects
 * compared by identity, never visible to the program. */
static SCR_TL ScrDyn *op_k_empty = NULL;
static SCR_TL ScrDyn *op_k_eof = NULL;
static SCR_TL ScrDyn *op_k_done = NULL;

static void op_sentinels_free(void) {
  scr_dyn_release(op_k_empty);
  scr_dyn_release(op_k_eof);
  scr_dyn_release(op_k_done);
  op_k_empty = op_k_eof = op_k_done = NULL;
}

static void op_sentinels_init(void) {
  if (op_k_empty) return;
  op_k_empty = scr_dyn_new_obj();
  op_k_eof = scr_dyn_new_obj();
  op_k_done = scr_stream_from_done(); /* shared with pumpToNode (scr_stream.c) */
  scr_atexit(op_sentinels_free);
}

/* ── awaits ────────────────────────────────────────────────────────── */

/* A continuation receives the awaited value (+1), or NULL with the
 * rejection pending in the exception cell. It must leave no exception
 * pending when it returns. */
typedef void (*OpCont)(void *self, ScrDyn *value);

typedef struct {
  void *self;
  OpCont k;
  ScrPromise *p;
} OpAwait;

static void op_await_entry(ScrFiber *fiber, void *arg) {
  (void)fiber;
  OpAwait a = *(OpAwait *)arg;
  free(arg);
  ScrDyn *v = scr_await_dyn(a.p);
  scr_promise_release(a.p);
  a.k(a.self, v);
  if (scr_exc_pending()) scr_exc_clear();
  op_unref(a.self);
}

/* `await p`: k runs in the promise job after p settles. Borrows p. */
static void op_await(ScrPromise *p, OpCont k, void *self) {
  OpAwait *a = op_alloc(sizeof *a);
  a->self = op_ref(self);
  a->k = k;
  a->p = scr_promise_retain(p);
  ScrPromise *fiber = scr_async_spawn_after(p, &op_await_entry, a);
  scr_promise_release(fiber);
}

static ScrPromise *op_resolved(ScrDyn *v /*borrowed*/) {
  ScrPromise *p = scr_promise_new();
  scr_promise_fulfill_ref(p, scr_dyn_retain(v), scr_dyn_retain_v, scr_dyn_release_v, NULL);
  return p;
}

/* `await v` over a value: a promise is awaited, anything else is awaited
 * as an already resolved promise (one job). Borrows v. */
static void op_await_value(ScrDyn *v, OpCont k, void *self) {
  if (v->kind == SCR_DYN_PROMISE) {
    op_await(v->v.promise, k, self);
    return;
  }
  ScrPromise *p = op_resolved(v);
  op_await(p, k, self);
  scr_promise_release(p);
}

static void op_fulfill(ScrPromise *p, ScrDyn *v /*borrowed*/) {
  scr_promise_fulfill_ref(p, scr_dyn_retain(v), scr_dyn_retain_v, scr_dyn_release_v, NULL);
}

/* Rejects p with a saved exception (borrowed). */
static void op_reject(ScrPromise *p, const ScrCaught *c) {
  scr_rethrow(c);
  scr_promise_reject_pending(p);
}

/* PromiseReject(err) for a saved exception: +1 dyn promise. */
static ScrDyn *op_rejected_dyn(const ScrCaught *c) {
  ScrPromise *p = scr_promise_new();
  op_reject(p, c);
  ScrDyn *d = scr_dyn_new_promise(p);
  scr_promise_release(p);
  return d;
}

/* ── errors ────────────────────────────────────────────────────────── */

static ScrCaught *op_take_error(ScrError *e /*moves*/) {
  scr_throw_obj(e, &scr_error_retain_v, &scr_error_release_v, scr_error_trace_arg());
  return scr_exc_take();
}

/* new AbortError() or new AbortError(undefined, { cause }) */
static ScrError *op_abort_error(const ScrDyn *cause /*NULL: no cause*/) {
  ScrStr *message = scr_str_new("The operation was aborted", 25);
  ScrError *e = scr_error_new(SCR_ERR_ERROR, message);
  scr_str_release(message);
  scr_str_release(e->name);
  e->name = scr_str_new("AbortError", 10);
  /* AbortError assigns code, then name: own enumerable properties */
  scr_error_set_code(e, "ABORT_ERR");
  e->name_present = true;
  e->name_enumerable = true;
  if (cause) scr_error_define_cause(e, (ScrDyn *)cause);
  return e;
}

static ScrError *op_coded_error(int kind, const char *code, const char *message) {
  ScrStr *m = scr_str_new(message, strlen(message));
  ScrError *e = scr_error_new(kind, m);
  scr_str_release(m);
  scr_error_set_code(e, code);
  return e;
}

/* ERR_OUT_OF_RANGE: `The value of "<name>" is out of range. It must be
 * <range>. Received <n>` (thrown; pending on return). */
static void op_throw_out_of_range(const char *name, const char *range, double received) {
  char num[48];
  scr_num_received(received, num);
  char msg[256];
  int n = snprintf(msg, sizeof msg, "The value of \"%s\" is out of range. It must be %s. Received %s",
                   name, range, num);
  scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)n, "ERR_OUT_OF_RANGE");
}

/* The runtime refusal for a value outside the string/Buffer model. */
static ScrError *op_unsupported(const char *what) {
  char msg[256];
  int n = snprintf(msg, sizeof msg, "%s is not supported yet", what);
  ScrStr *m = scr_str_new(msg, (size_t)n);
  ScrError *e = scr_error_new(SCR_ERR_ERROR, m);
  scr_str_release(m);
  return e;
}

/* ── options ───────────────────────────────────────────────────────── */

static ScrDyn *op_get(const ScrDyn *obj, const char *key) {
  if (!obj) return NULL;
  size_t n = strlen(key);
  if (obj->kind == SCR_DYN_OBJ) {
    ScrDyn *v = scr_dyn_obj_get(obj, key, n);
    return v ? scr_dyn_retain(v) : NULL;
  }
  if (obj->kind == SCR_DYN_HANDLE) {
    ScrStr *k = scr_str_new(key, n);
    ScrDyn *v = scr_dyn_handle_key_get(obj, k);
    scr_str_release(k);
    return v;
  }
  return NULL;
}

static bool op_nullish(const ScrDyn *v) {
  return v == NULL || v->kind == SCR_DYN_UNDEF || v->kind == SCR_DYN_NULL;
}

/* validateObject(options, 'options') when options != null: false with
 * ERR_INVALID_ARG_TYPE pending. */
static bool op_check_options(const ScrDyn *options) {
  if (op_nullish(options)) return true;
  if ((options->kind == SCR_DYN_OBJ || options->kind == SCR_DYN_HANDLE) &&
      !scr_dyn_is_callable(options)) {
    return true;
  }
  scr_dyn_arg_type_fail("options", "of type object", options);
  return false;
}

/* options.signal when != null, validated (validateAbortSignal): +1, or
 * NULL when absent. *ok false with ERR_INVALID_ARG_TYPE pending. */
static ScrDyn *op_signal(const ScrDyn *options, bool *ok) {
  *ok = true;
  ScrDyn *s = op_get(options, "signal");
  if (op_nullish(s)) {
    if (s) scr_dyn_release(s);
    return NULL;
  }
  ScrDyn *aborted = NULL;
  if (s->kind == SCR_DYN_OBJ || s->kind == SCR_DYN_HANDLE) aborted = op_get(s, "aborted");
  if (!aborted) {
    scr_dyn_prop_type_fail("options.signal", "an instance of AbortSignal", s);
    scr_dyn_release(s);
    *ok = false;
    return NULL;
  }
  scr_dyn_release(aborted);
  return s;
}

static bool op_aborted(const ScrDyn *signal) {
  if (!signal) return false;
  ScrDyn *a = op_get(signal, "aborted");
  bool r = a && scr_dyn_truthy(a);
  if (a) scr_dyn_release(a);
  return r;
}

/* The callback argument: validateFunction. False with the error pending.
 * (The options argument the callback may read is the operator's
 * cb_opts.) */
static bool op_check_fn(const ScrDyn *fn, const char *name, uint32_t max) {
  (void)max;
  if (!fn || !scr_dyn_is_callable(fn)) {
    scr_dyn_arg_type_fail(name, "of type function", fn ? fn : scr_dyn_undefined());
    return false;
  }
  return true;
}

/* ── iteration sources ─────────────────────────────────────────────── */

typedef struct OpGen OpGen;

/* `for await (const v of src)` over a Readable (its async iterator) or an
 * operator generator. */
typedef struct {
  ScrStream *s; /* +1, or NULL */
  OpGen *g;     /* +1, or NULL */
} OpSrc;

static ScrPromise *gen_next(OpGen *g);
static ScrPromise *gen_return(OpGen *g, ScrDyn *v);
static ScrPromise *gen_throw(OpGen *g, const ScrCaught *c);

/* iterator.next(): +1 promise of the next value or the end. */
static ScrPromise *src_next(OpSrc *src) {
  return src->s ? scr_stream_next_chunk_dyn(src->s) : gen_next(src->g);
}

static bool src_done(const OpSrc *src, const ScrDyn *v) {
  return src->s ? scr_stream_chunk_done(v) : v == op_k_done;
}

/* The Readable iterator's return(): the iterator generator resumes at its
 * yield with a return completion (one await), its finally destroys the
 * stream (destroyer: an AbortError when not finished), and the request
 * settles. */
typedef struct {
  OpObj base;
  ScrStream *s;
  ScrPromise *p;
} OpStreamReturn;

static void op_stream_return_drop(OpObj *o) {
  OpStreamReturn *r = (OpStreamReturn *)o;
  scr_stream_release(r->s);
  scr_promise_release(r->p);
  free(r);
}

static void op_stream_return_k(void *self, ScrDyn *v) {
  OpStreamReturn *r = self;
  if (v) scr_dyn_release(v);
  scr_stream_release(scr_stream_iterator_close(r->s));
  op_fulfill(r->p, op_k_done);
}

static ScrPromise *src_return(OpSrc *src) {
  if (src->g) return gen_return(src->g, scr_dyn_undefined());
  OpStreamReturn *r = op_alloc(sizeof *r);
  r->base.rc = 1;
  r->base.drop = &op_stream_return_drop;
  r->s = scr_stream_retain(src->s);
  r->p = scr_promise_new();
  ScrPromise *result = scr_promise_retain(r->p);
  op_await_value(scr_dyn_undefined(), &op_stream_return_k, r);
  op_unref(r);
  return result;
}

static void src_release(OpSrc *src) {
  if (src->s) scr_stream_release(src->s);
  if (src->g) op_unref(src->g);
  src->s = NULL;
  src->g = NULL;
}

/* ── the async generator protocol ──────────────────────────────────── */

enum { GS_START, GS_SUSPENDED, GS_EXECUTING, GS_AWAIT_RETURN, GS_DONE };
enum { GR_NEXT, GR_RETURN, GR_THROW };

typedef struct {
  ScrPromise *p;
  int kind;
  ScrDyn *value;    /* return value (+1) */
  ScrCaught *error; /* throw value (+1) */
} OpGenReq;

/* An operator generator: the protocol state plus the body's entry points.
 * resume runs the body from its start or from the yield it is suspended
 * at (normal completion); ret delivers a return completion at that yield
 * (after the unwrap await) and thr a throw completion. */
struct OpGen {
  OpObj base;
  int state;
  OpGenReq *q;
  size_t qh, qn, qcap;
  void (*resume)(OpGen *g);
  void (*ret)(OpGen *g, ScrDyn *v);
  void (*thr)(OpGen *g, ScrCaught *c);
  void (*body_drop)(OpGen *g);
};

static void gen_drop(OpObj *o) {
  OpGen *g = (OpGen *)o;
  for (size_t i = g->qh; i < g->qn; i++) {
    scr_promise_release(g->q[i].p);
    if (g->q[i].value) scr_dyn_release(g->q[i].value);
    if (g->q[i].error) scr_caught_release(g->q[i].error);
  }
  free(g->q);
  g->body_drop(g);
}

static ScrPromise *gen_enqueue(OpGen *g, int kind, ScrDyn *value, const ScrCaught *error) {
  if (g->qn == g->qcap) {
    if (g->qh > 0) {
      memmove(g->q, g->q + g->qh, (g->qn - g->qh) * sizeof *g->q);
      g->qn -= g->qh;
      g->qh = 0;
    }
    if (g->qn == g->qcap) {
      g->qcap = g->qcap ? g->qcap * 2 : 4;
      g->q = realloc(g->q, g->qcap * sizeof *g->q);
      if (!g->q) op_oom();
    }
  }
  OpGenReq *r = &g->q[g->qn++];
  r->p = scr_promise_new();
  r->kind = kind;
  r->value = value ? scr_dyn_retain(value) : NULL;
  r->error = error ? scr_caught_retain((ScrCaught *)error) : NULL;
  return scr_promise_retain(r->p);
}

static bool gen_has_req(const OpGen *g) { return g->qh < g->qn; }

static OpGenReq gen_shift(OpGen *g) {
  OpGenReq r = g->q[g->qh++];
  if (g->qh == g->qn) g->qh = g->qn = 0;
  return r;
}

static void gen_req_release(OpGenReq *r) {
  scr_promise_release(r->p);
  if (r->value) scr_dyn_release(r->value);
  if (r->error) scr_caught_release(r->error);
}

static void gen_drain(OpGen *g);

/* AsyncGeneratorAwaitReturn: await the value, then the request settles
 * done (a rejection rejects it). */
typedef struct {
  OpObj base;
  OpGen *g;
  ScrPromise *p;
} OpAwaitReturn;

static void op_await_return_drop(OpObj *o) {
  OpAwaitReturn *a = (OpAwaitReturn *)o;
  op_unref(a->g);
  scr_promise_release(a->p);
  free(a);
}

static void op_await_return_k(void *self, ScrDyn *v) {
  OpAwaitReturn *a = self;
  OpGen *g = a->g;
  if (v) {
    scr_dyn_release(v);
    op_fulfill(a->p, op_k_done);
  } else {
    scr_promise_reject_pending(a->p);
  }
  g->state = GS_DONE;
  gen_drain(g);
}

static void gen_await_return(OpGen *g, OpGenReq *r) {
  g->state = GS_AWAIT_RETURN;
  OpAwaitReturn *a = op_alloc(sizeof *a);
  a->base.rc = 1;
  a->base.drop = &op_await_return_drop;
  a->g = op_ref(g);
  a->p = scr_promise_retain(r->p);
  op_await_value(r->value ? r->value : scr_dyn_undefined(), &op_await_return_k, a);
  op_unref(a);
}

/* The completed generator answers its queued requests: next settles done
 * at once, throw rejects at once, return awaits its value first. */
static void gen_drain(OpGen *g) {
  while (g->state == GS_DONE && gen_has_req(g)) {
    OpGenReq r = gen_shift(g);
    if (r.kind == GR_RETURN) {
      gen_await_return(g, &r);
      gen_req_release(&r);
      return;
    }
    if (r.kind == GR_THROW) {
      op_reject(r.p, r.error);
    } else {
      op_fulfill(r.p, op_k_done);
    }
    gen_req_release(&r);
  }
}

/* The body finished: the first request settles (done, or rejected with
 * the body's exception), then the queue drains. Borrows c. */
static void gen_complete(OpGen *g, const ScrCaught *c) {
  g->state = GS_DONE;
  if (gen_has_req(g)) {
    OpGenReq r = gen_shift(g);
    if (c) op_reject(r.p, c);
    else op_fulfill(r.p, op_k_done);
    gen_req_release(&r);
  }
  gen_drain(g);
}

/* Delivers the first queued request to a body suspended at a yield (or
 * already running its continuation): next resumes it, return awaits the
 * value and then delivers the return completion, throw delivers the
 * throw completion. */
typedef struct {
  OpObj base;
  OpGen *g;
} OpUnwrapReturn;

static void op_unwrap_return_drop(OpObj *o) {
  OpUnwrapReturn *u = (OpUnwrapReturn *)o;
  op_unref(u->g);
  free(u);
}

static void op_unwrap_return_k(void *self, ScrDyn *v) {
  OpGen *g = ((OpUnwrapReturn *)self)->g;
  if (!v) {
    ScrCaught *c = scr_exc_take();
    g->thr(g, c);
    scr_caught_release(c);
    return;
  }
  g->ret(g, v);
  scr_dyn_release(v);
}

static void gen_deliver(OpGen *g) {
  OpGenReq *r = &g->q[g->qh];
  g->state = GS_EXECUTING;
  if (r->kind == GR_NEXT) {
    g->resume(g);
  } else if (r->kind == GR_THROW) {
    g->thr(g, r->error);
  } else {
    OpUnwrapReturn *u = op_alloc(sizeof *u);
    u->base.rc = 1;
    u->base.drop = &op_unwrap_return_drop;
    u->g = op_ref(g);
    op_await_value(r->value ? r->value : scr_dyn_undefined(), &op_unwrap_return_k, u);
    op_unref(u);
  }
}

static ScrPromise *gen_request(OpGen *g, int kind, ScrDyn *value, const ScrCaught *error) {
  ScrPromise *p = gen_enqueue(g, kind, value, error);
  if (g->state == GS_START) {
    if (kind == GR_NEXT) {
      gen_deliver(g);
    } else {
      /* A generator that never started completes without running. */
      g->state = GS_DONE;
      gen_drain(g);
    }
  } else if (g->state == GS_SUSPENDED) {
    gen_deliver(g);
  } else if (g->state == GS_DONE) {
    gen_drain(g);
  }
  return p;
}

static ScrPromise *gen_next(OpGen *g) { return gen_request(g, GR_NEXT, NULL, NULL); }
static ScrPromise *gen_return(OpGen *g, ScrDyn *v) { return gen_request(g, GR_RETURN, v, NULL); }
static ScrPromise *gen_throw(OpGen *g, const ScrCaught *c) { return gen_request(g, GR_THROW, NULL, c); }

/* The body yields an awaited value: the request settles with it, and the
 * body continues at once when another request is queued (the generator
 * never suspends), or suspends until the next one. Borrows v. */
static void gen_yield_now(OpGen *g, ScrDyn *v) {
  OpGenReq r = gen_shift(g);
  op_fulfill(r.p, v);
  gen_req_release(&r);
  if (gen_has_req(g)) {
    gen_deliver(g);
  } else {
    g->state = GS_SUSPENDED;
  }
}

/* `yield v` in an async generator awaits v first. */
static void op_yield_k(void *self, ScrDyn *v) {
  OpGen *g = self;
  if (!v) {
    ScrCaught *c = scr_exc_take();
    g->thr(g, c);
    scr_caught_release(c);
    return;
  }
  gen_yield_now(g, v);
  scr_dyn_release(v);
}

static void gen_yield(OpGen *g, ScrDyn *v /*borrowed*/) { op_await_value(v, &op_yield_k, g); }

static void gen_init(OpGen *g, void (*body_drop)(OpGen *)) {
  g->base.rc = 1;
  g->base.drop = &gen_drop;
  g->state = GS_START;
  g->body_drop = body_drop;
}

/* ── map (and filter, forEach, every through it) ───────────────────── */

/* How each source value turns into the queued result: map calls fn
 * directly; filter, forEach and every go through Node's async wrappers
 * (filterFn, forEachFn, and every's negating predicate inside filterFn). */
enum { MODE_MAP, MODE_FILTER, MODE_FOREACH, MODE_EVERY };

typedef struct {
  OpGen g;
  OpSrc src;
  ScrDyn *fn;      /* +1 */
  ScrDyn *signal;  /* +1 or NULL */
  ScrDyn *cb_opts; /* +1: the { signal } fn takes as its second argument, or NULL */
  int mode;
  double concurrency, hwm;
  ScrDyn **queue; /* +1 entries: dyn promises or kEof */
  size_t qh, qn, qcap;
  double cnt;
  bool done;
  ScrPromise *next_p;   /* the consumer's `await new Promise(r => next = r)` */
  ScrPromise *resume_p; /* the pump's `await new Promise(r => resume = r)` */
  bool started;
} OpMap;

static void op_map_body_drop(OpGen *g) {
  OpMap *m = (OpMap *)g;
  src_release(&m->src);
  scr_dyn_release(m->fn);
  if (m->signal) scr_dyn_release(m->signal);
  if (m->cb_opts) scr_dyn_release(m->cb_opts);
  for (size_t i = m->qh; i < m->qn; i++) scr_dyn_release(m->queue[i]);
  free(m->queue);
  if (m->next_p) scr_promise_release(m->next_p);
  if (m->resume_p) scr_promise_release(m->resume_p);
  free(m);
}

static void map_push(OpMap *m, ScrDyn *v /*moves*/) {
  if (m->qn == m->qcap) {
    if (m->qh > 0) {
      memmove(m->queue, m->queue + m->qh, (m->qn - m->qh) * sizeof *m->queue);
      m->qn -= m->qh;
      m->qh = 0;
    }
    if (m->qn == m->qcap) {
      m->qcap = m->qcap ? m->qcap * 2 : 4;
      m->queue = realloc(m->queue, m->qcap * sizeof *m->queue);
      if (!m->queue) op_oom();
    }
  }
  m->queue[m->qn++] = v;
}

static size_t map_qlen(const OpMap *m) { return m->qn - m->qh; }

/* resolve() of the pending resume/next promise */
static void map_wake(ScrPromise **slot) {
  if (!*slot) return;
  ScrPromise *p = *slot;
  *slot = NULL;
  op_fulfill(p, scr_dyn_undefined());
  scr_promise_release(p);
}

static void map_maybe_resume(OpMap *m) {
  if (m->resume_p && !m->done && m->cnt < m->concurrency && (double)map_qlen(m) < m->hwm) {
    map_wake(&m->resume_p);
  }
}

static void map_after_item(OpMap *m) {
  m->cnt -= 1;
  map_maybe_resume(m);
}

/* PromisePrototypeThen(val, afterItemProcessed, onCatch) */
static void map_item_settled_k(void *self, ScrDyn *v) {
  OpMap *m = self;
  if (v) {
    scr_dyn_release(v);
  } else {
    scr_exc_clear();
    m->done = true;
  }
  map_after_item(m);
}

/* ── the async wrappers around the user's callback ── */

/* An async function's promise settled from an awaited inner value. */
typedef struct {
  OpObj base;
  ScrPromise *p;   /* the wrapper's promise */
  ScrDyn *chunk;   /* the source value (filter returns it) */
  int mode;
  int stage;       /* MODE_EVERY: 0 the negating arrow, 1 filterFn */
} OpWrap;

static void op_wrap_drop(OpObj *o) {
  OpWrap *w = (OpWrap *)o;
  scr_promise_release(w->p);
  if (w->chunk) scr_dyn_release(w->chunk);
  free(w);
}

static OpWrap *op_wrap_new(int mode, ScrDyn *chunk, int stage) {
  OpWrap *w = op_alloc(sizeof *w);
  w->base.rc = 1;
  w->base.drop = &op_wrap_drop;
  w->p = scr_promise_new();
  w->chunk = chunk ? scr_dyn_retain(chunk) : NULL;
  w->mode = mode;
  w->stage = stage;
  return w;
}

static void op_wrap_k(void *self, ScrDyn *v) {
  OpWrap *w = self;
  if (!v) {
    scr_promise_reject_pending(w->p);
    return;
  }
  ScrDyn *out;
  if (w->mode == MODE_FOREACH) {
    out = scr_dyn_retain(op_k_empty);
  } else if (w->mode == MODE_EVERY && w->stage == 0) {
    out = scr_dyn_new_bool(!scr_dyn_truthy(v));
  } else {
    out = scr_dyn_retain(scr_dyn_truthy(v) ? w->chunk : op_k_empty);
  }
  scr_dyn_release(v);
  op_fulfill(w->p, out);
  scr_dyn_release(out);
}

/* Calls fn(chunk): +1 result, or NULL with the exception pending. */
/* Calls fn(chunk, signalOpt) — the second argument when the callback
 * declares it. +1 result, or NULL with the exception pending. */
static ScrDyn *op_call(OpMap *m, ScrDyn *chunk) {
  ScrDyn *args[2] = {chunk, m->cb_opts};
  return scr_dyn_call(m->fn, args, m->cb_opts ? 2 : 1, "fn");
}

/* An async wrapper body: `await fn(chunk)` then its transform. The
 * wrapper's promise rejects at once when fn throws synchronously. +1. */
static ScrPromise *op_wrap_call(OpMap *m, ScrDyn *chunk, int mode, int stage) {
  OpWrap *w = op_wrap_new(mode, chunk, stage);
  ScrPromise *result = scr_promise_retain(w->p);
  ScrDyn *r = op_call(m, chunk);
  if (!r) {
    scr_promise_reject_pending(w->p);
  } else {
    op_await_value(r, &op_wrap_k, w);
    scr_dyn_release(r);
  }
  op_unref(w);
  return result;
}

/* every's filterFn: `await predicate(value)` where predicate is the
 * negating async arrow, then filterFn's own test. */
static ScrPromise *op_every_call(OpMap *m, ScrDyn *chunk) {
  ScrPromise *inner = op_wrap_call(m, chunk, MODE_EVERY, 0);
  OpWrap *w = op_wrap_new(MODE_EVERY, chunk, 1);
  ScrPromise *result = scr_promise_retain(w->p);
  op_await(inner, &op_wrap_k, w);
  scr_promise_release(inner);
  op_unref(w);
  return result;
}

/* val = fn(val, signalOpt), then PromiseResolve(val) — or
 * PromiseReject(err) when the call throws. +1 dyn promise. */
static ScrDyn *map_item(OpMap *m, ScrDyn *chunk) {
  ScrPromise *p;
  if (m->mode == MODE_MAP) {
    ScrDyn *r = op_call(m, chunk);
    if (!r) {
      ScrCaught *c = scr_exc_take();
      ScrDyn *d = op_rejected_dyn(c);
      scr_caught_release(c);
      return d;
    }
    if (r->kind == SCR_DYN_PROMISE) return r;
    p = op_resolved(r);
    scr_dyn_release(r);
  } else if (m->mode == MODE_EVERY) {
    p = op_every_call(m, chunk);
  } else {
    p = op_wrap_call(m, chunk, m->mode, 0);
  }
  ScrDyn *d = scr_dyn_new_promise(p);
  scr_promise_release(p);
  return d;
}

/* ── the pump: `for await (let val of stream)` filling the queue ── */

static void map_pump_next(OpMap *m);

static void map_pump_finally(OpMap *m) {
  m->done = true;
  map_wake(&m->next_p);
}

/* catch (err): a rejected entry the consumer will throw. Borrows c. */
static void map_pump_catch(OpMap *m, const ScrCaught *c) {
  ScrDyn *val = op_rejected_dyn(c);
  op_await_value(val, &map_item_settled_k, m);
  map_push(m, val);
  map_pump_finally(m);
}

/* After the loop's AsyncIteratorClose: a return (`if (done) return`) or
 * the AbortError thrown in the body. */
typedef struct {
  OpObj base;
  OpMap *m;
  ScrCaught *thrown; /* +1, or NULL for the return */
} OpPumpClose;

static void op_pump_close_drop(OpObj *o) {
  OpPumpClose *c = (OpPumpClose *)o;
  op_unref(c->m);
  if (c->thrown) scr_caught_release(c->thrown);
  free(c);
}

static void op_pump_close_k(void *self, ScrDyn *v) {
  OpPumpClose *c = self;
  if (v) scr_dyn_release(v);
  else scr_exc_clear(); /* a throw completion keeps the original error */
  if (c->thrown) map_pump_catch(c->m, c->thrown);
  else map_pump_finally(c->m);
}

static void map_pump_close(OpMap *m, ScrCaught *thrown /*moves or NULL*/) {
  OpPumpClose *c = op_alloc(sizeof *c);
  c->base.rc = 1;
  c->base.drop = &op_pump_close_drop;
  c->m = op_ref(m);
  c->thrown = thrown;
  ScrPromise *p = src_return(&m->src);
  op_await(p, &op_pump_close_k, c);
  scr_promise_release(p);
  op_unref(c);
}

static void map_pump_resumed_k(void *self, ScrDyn *v) {
  if (v) scr_dyn_release(v);
  map_pump_next(self);
}

static void map_pump_val_k(void *self, ScrDyn *v) {
  OpMap *m = self;
  if (!v) {
    ScrCaught *c = scr_exc_take();
    map_pump_catch(m, c);
    scr_caught_release(c);
    return;
  }
  if (src_done(&m->src, v)) {
    scr_dyn_release(v);
    map_push(m, scr_dyn_retain(op_k_eof));
    map_pump_finally(m);
    return;
  }
  if (m->done) {
    scr_dyn_release(v);
    map_pump_close(m, NULL);
    return;
  }
  if (op_aborted(m->signal)) {
    scr_dyn_release(v);
    map_pump_close(m, op_take_error(op_abort_error(NULL)));
    return;
  }
  ScrDyn *val = map_item(m, v);
  scr_dyn_release(v);
  m->cnt += 1;
  op_await_value(val, &map_item_settled_k, m);
  map_push(m, val);
  map_wake(&m->next_p);
  if (!m->done && ((double)map_qlen(m) >= m->hwm || m->cnt >= m->concurrency)) {
    m->resume_p = scr_promise_new();
    op_await(m->resume_p, &map_pump_resumed_k, m);
    return;
  }
  map_pump_next(m);
}

static void map_pump_next(OpMap *m) {
  ScrPromise *p = src_next(&m->src);
  op_await(p, &map_pump_val_k, m);
  scr_promise_release(p);
}

/* ── the generator body: awaiting queue[0] and yielding ── */

static void map_consume(OpMap *m);

/* finally { done = true; if (resume) { resume(); resume = null; } } */
static void map_finally(OpMap *m) {
  m->done = true;
  map_wake(&m->resume_p);
}

static void map_cons_next_k(void *self, ScrDyn *v) {
  if (v) scr_dyn_release(v);
  map_consume(self);
}

static void map_cons_val_k(void *self, ScrDyn *v) {
  OpMap *m = self;
  OpGen *g = &m->g;
  if (!v) {
    ScrCaught *c = scr_exc_take();
    map_finally(m);
    gen_complete(g, c);
    scr_caught_release(c);
    return;
  }
  if (v == op_k_eof) {
    scr_dyn_release(v);
    map_finally(m);
    gen_complete(g, NULL);
    return;
  }
  if (op_aborted(m->signal)) {
    scr_dyn_release(v);
    ScrCaught *c = op_take_error(op_abort_error(NULL));
    map_finally(m);
    gen_complete(g, c);
    scr_caught_release(c);
    return;
  }
  if (v != op_k_empty) {
    gen_yield(g, v);
    scr_dyn_release(v);
    return;
  }
  scr_dyn_release(v);
  scr_dyn_release(m->queue[m->qh++]);
  map_maybe_resume(m);
  map_consume(m);
}

static void map_consume(OpMap *m) {
  if (map_qlen(m) > 0) {
    op_await_value(m->queue[m->qh], &map_cons_val_k, m);
    return;
  }
  m->next_p = scr_promise_new();
  op_await(m->next_p, &map_cons_next_k, m);
}

/* Resumed after a yield, or started: the first resumption starts the pump
 * (pump() runs before the consumer loop), a later one shifts the entry
 * that was yielded. */
static void map_resume(OpGen *g) {
  OpMap *m = (OpMap *)g;
  if (!m->started) {
    m->started = true;
    map_pump_next(m);
  } else {
    scr_dyn_release(m->queue[m->qh++]);
    map_maybe_resume(m);
  }
  map_consume(m);
}

/* A return or throw delivered at the yield: the finally block, then the
 * generator completes. */
static void map_ret(OpGen *g, ScrDyn *v) {
  (void)v;
  map_finally((OpMap *)g);
  gen_complete(g, NULL);
}

static void map_thr(OpGen *g, ScrCaught *c) {
  map_finally((OpMap *)g);
  gen_complete(g, c);
}

static OpMap *map_new(ScrStream *s, ScrDyn *fn, int mode, double concurrency, double hwm,
                      ScrDyn *signal, ScrDyn *cb_opts) {
  OpMap *m = op_alloc(sizeof *m);
  gen_init(&m->g, &op_map_body_drop);
  m->g.resume = &map_resume;
  m->g.ret = &map_ret;
  m->g.thr = &map_thr;
  m->src.s = scr_stream_retain(s);
  m->fn = scr_dyn_retain(fn);
  m->signal = signal ? scr_dyn_retain(signal) : NULL;
  m->cb_opts = cb_opts && cb_opts->kind != SCR_DYN_UNDEF ? scr_dyn_retain(cb_opts) : NULL;
  m->mode = mode;
  m->concurrency = concurrency;
  m->hwm = hwm;
  return m;
}

/* ── drop and take ─────────────────────────────────────────────────── */

/* async function* drop() / take(): `for await (const val of this)` with
 * the signal polled before the loop and at every value; take returns once
 * its count is spent, closing the source (which destroys it). */
typedef struct {
  OpGen g;
  OpSrc src;
  ScrDyn *signal; /* +1 or NULL */
  double number;
  bool take;
  bool started;
} OpSlice;

static void op_slice_body_drop(OpGen *g) {
  OpSlice *t = (OpSlice *)g;
  src_release(&t->src);
  if (t->signal) scr_dyn_release(t->signal);
  free(t);
}

static void slice_next(OpSlice *t);

/* AsyncIteratorClose(source), then the generator completes (with the
 * thrown exception when one is given). */
typedef struct {
  OpObj base;
  OpGen *g;
  ScrCaught *thrown; /* +1 or NULL */
} OpGenClose;

static void op_gen_close_drop(OpObj *o) {
  OpGenClose *c = (OpGenClose *)o;
  op_unref(c->g);
  if (c->thrown) scr_caught_release(c->thrown);
  free(c);
}

static void op_gen_close_k(void *self, ScrDyn *v) {
  OpGenClose *c = self;
  if (v) {
    scr_dyn_release(v);
    gen_complete(c->g, c->thrown);
    return;
  }
  /* A rejected return() replaces a normal completion; a throw keeps its
   * own exception. */
  ScrCaught *err = scr_exc_take();
  gen_complete(c->g, c->thrown ? c->thrown : err);
  scr_caught_release(err);
}

static void gen_close_source(OpGen *g, OpSrc *src, ScrCaught *thrown /*moves or NULL*/) {
  OpGenClose *c = op_alloc(sizeof *c);
  c->base.rc = 1;
  c->base.drop = &op_gen_close_drop;
  c->g = op_ref(g);
  c->thrown = thrown;
  ScrPromise *p = src_return(src);
  op_await(p, &op_gen_close_k, c);
  scr_promise_release(p);
  op_unref(c);
}

static void slice_val_k(void *self, ScrDyn *v) {
  OpSlice *t = self;
  if (!v) {
    ScrCaught *c = scr_exc_take();
    gen_complete(&t->g, c);
    scr_caught_release(c);
    return;
  }
  if (src_done(&t->src, v)) {
    scr_dyn_release(v);
    gen_complete(&t->g, NULL);
    return;
  }
  if (op_aborted(t->signal)) {
    scr_dyn_release(v);
    gen_close_source(&t->g, &t->src, op_take_error(op_abort_error(NULL)));
    return;
  }
  bool yield;
  if (t->take) {
    yield = t->number-- > 0;
  } else {
    yield = t->number-- <= 0;
  }
  if (yield) {
    gen_yield(&t->g, v);
    scr_dyn_release(v);
    return;
  }
  scr_dyn_release(v);
  if (t->take && t->number <= 0) {
    gen_close_source(&t->g, &t->src, NULL);
    return;
  }
  slice_next(t);
}

static void slice_next(OpSlice *t) {
  ScrPromise *p = src_next(&t->src);
  op_await(p, &slice_val_k, t);
  scr_promise_release(p);
}

static void slice_resume(OpGen *g) {
  OpSlice *t = (OpSlice *)g;
  if (!t->started) {
    t->started = true;
    if (op_aborted(t->signal)) {
      ScrCaught *c = op_take_error(op_abort_error(NULL));
      gen_complete(g, c);
      scr_caught_release(c);
      return;
    }
  } else if (t->take && t->number <= 0) {
    /* `if (number <= 0) return;` after the yield */
    gen_close_source(g, &t->src, NULL);
    return;
  }
  slice_next(t);
}

static void slice_ret(OpGen *g, ScrDyn *v) {
  (void)v;
  gen_close_source(g, &((OpSlice *)g)->src, NULL);
}

static void slice_thr(OpGen *g, ScrCaught *c) {
  gen_close_source(g, &((OpSlice *)g)->src, scr_caught_retain(c));
}

/* ── flatMap ───────────────────────────────────────────────────────── */

/* async function* flatMap() { for await (const val of values) yield* val; }
 * over map's generator. yield* over an array (or a string's code points)
 * goes through the async-from-sync iterator: each step resolves after the
 * element's PromiseResolve job, and yield* awaits that result before
 * yielding without a further await. */
/* yield* over the delegate: an array or string (its elements, through
 * the async-from-sync iterator), another iterable's iterator (FLAT_SYNC
 * through the async-from-sync iterator, FLAT_ASYNC awaiting next()), or a
 * native Readable (FLAT_STREAM, its async iterator). */
enum { FLAT_NONE, FLAT_SYNC, FLAT_ASYNC, FLAT_STREAM, FLAT_GEN_SYNC, FLAT_GEN_ASYNC };

typedef ScrDyn *(*FromSyncFn)(ScrClosure *, ScrGen *);
typedef ScrDyn *(*FromSyncThrowFn)(ScrClosure *, ScrGen *, ScrDyn *);
typedef ScrPromise *(*FromAsyncFn)(ScrClosure *, ScrGen *);
typedef ScrPromise *(*FromAsyncThrowFn)(ScrClosure *, ScrGen *, ScrDyn *);
typedef ScrDyn *(*FromReadFn)(ScrClosure *, void *);
static void op_await_gen(ScrPromise *p, ScrClosure *read, OpCont k, void *self);

typedef struct {
  OpGen g;
  OpSrc values; /* the map generator */
  ScrDyn *inner; /* +1: the array or string being delegated to, or NULL */
  size_t idx;    /* element index, or the string's byte offset */
  ScrPromise *step; /* the async-from-sync iterator result being awaited */
  ScrDyn *iter;      /* +1: the delegate's iterator (FLAT_SYNC / FLAT_ASYNC), or NULL */
  ScrStream *stream; /* +1: the delegate stream (FLAT_STREAM), or NULL */
  ScrGen *gen;       /* +1: a compiled generator delegate (FLAT_GEN_*), or NULL */
  /* The compiler's helpers over the callback's generator type (+1 each,
   * or NULL): next/return/throw, and read for an async generator. */
  ScrClosure *gnext, *gread, *gret, *gthr;
  bool gen_async;
  int iter_kind;
  bool started;
} OpFlat;

/* A delegate's member (+1), read as the IR's keyed read does: a compiled
 * value (a generator, its result record) through its typed ref, anything
 * else through the iterator-result read. NULL with the error pending. */
static ScrDyn *flat_get(const ScrDyn *v, const char *key) {
  if (v->kind == SCR_DYN_TYPED_REF) {
    ScrStr *k = scr_str_new(key, strlen(key));
    ScrDyn *r = scr_dyn_typed_ref_key_get(v, k);
    scr_str_release(k);
    return r;
  }
  return scr_dyn_iterator_result_get(v, key, strlen(key));
}

/* iterator[name](...args) with the iterator as this: +1, or NULL with the
 * error pending. */
static ScrDyn *flat_call(const ScrDyn *iter, const char *name, ScrDyn *const *args, size_t argc) {
  ScrDyn *m = flat_get(iter, name);
  if (!m) return NULL;
  scr_dyn_this_push_dyn(iter);
  ScrDyn *r = scr_dyn_call(m, args, argc, name);
  scr_dyn_this_pop();
  scr_dyn_release(m);
  return r;
}

/* `const { value, done } = result`: +1 value with *done set, or NULL with
 * the error pending. */
static ScrDyn *flat_result(const ScrDyn *r, bool *done) {
  if (r->kind == SCR_DYN_UNDEF || r->kind == SCR_DYN_NULL || r->kind == SCR_DYN_NUM ||
      r->kind == SCR_DYN_STR || r->kind == SCR_DYN_BOOL) {
    ScrDyn *checked = scr_dyn_iterator_result((ScrDyn *)r); /* throws V8's TypeError */
    if (checked) scr_dyn_release(checked);
    return NULL;
  }
  ScrDyn *d = flat_get(r, "done");
  if (!d) return NULL;
  *done = scr_dyn_truthy(d);
  scr_dyn_release(d);
  return flat_get(r, "value");
}

static void flat_drop_delegate(OpFlat *f) {
  if (f->inner) scr_dyn_release(f->inner);
  if (f->iter) scr_dyn_release(f->iter);
  if (f->stream) scr_stream_release(f->stream);
  if (f->gen) scr_gen_release(f->gen);
  f->inner = f->iter = NULL;
  f->stream = NULL;
  f->gen = NULL;
  f->iter_kind = FLAT_NONE;
}

static void op_flat_body_drop(OpGen *g) {
  OpFlat *f = (OpFlat *)g;
  src_release(&f->values);
  flat_drop_delegate(f);
  if (f->step) scr_promise_release(f->step);
  if (f->gnext) scr_closure_release(f->gnext);
  if (f->gread) scr_closure_release(f->gread);
  if (f->gret) scr_closure_release(f->gret);
  if (f->gthr) scr_closure_release(f->gthr);
  free(f);
}

static void flat_next_value(OpFlat *f);

/* The next element (+1), or NULL when the delegate is exhausted; for a
 * sync iterator NULL with *failed set when next() threw (pending). */
static ScrDyn *flat_take_element(OpFlat *f, bool *failed) {
  *failed = false;
  if (f->iter_kind == FLAT_GEN_SYNC) {
    ScrDyn *v = ((FromSyncFn)f->gnext->fn)(f->gnext, scr_gen_retain(f->gen));
    if (!v) {
      *failed = true;
      return NULL;
    }
    if (v == op_k_done) {
      scr_dyn_release(v);
      return NULL;
    }
    return v;
  }
  if (f->iter_kind == FLAT_SYNC) {
    ScrDyn *r = flat_call(f->iter, "next", NULL, 0);
    if (!r) {
      *failed = true;
      return NULL;
    }
    bool done = false;
    ScrDyn *v = flat_result(r, &done);
    scr_dyn_release(r);
    if (!v) {
      *failed = true;
      return NULL;
    }
    if (done) {
      scr_dyn_release(v);
      return NULL;
    }
    return v;
  }
  ScrDyn *in = f->inner;
  if (in->kind == SCR_DYN_ARR) {
    if (f->idx >= in->v.arr.len) return NULL;
    ScrDyn *e = in->v.arr.items[f->idx++];
    return e ? scr_dyn_retain(e) : scr_dyn_retain(scr_dyn_undefined());
  }
  /* a string iterates by code point */
  const ScrStr *s = in->v.str;
  if (f->idx >= s->len) return NULL;
  size_t i = f->idx;
  unsigned char c = (unsigned char)s->data[i];
  size_t n = c < 0x80 ? 1 : c < 0xE0 ? 2 : c < 0xF0 ? 3 : 4;
  if (i + n > s->len) n = s->len - i;
  f->idx += n;
  ScrStr *piece = scr_str_new(s->data + i, n);
  ScrDyn *d = scr_dyn_new_str(piece);
  scr_str_release(piece);
  return d;
}

/* Await(innerResult): the iterator result is ready one job later. */
static void flat_step_k(void *self, ScrDyn *v) {
  OpFlat *f = self;
  if (f->step) {
    scr_promise_release(f->step);
    f->step = NULL;
  }
  if (!v) {
    /* the delegate's next() threw: it leaves the for await */
    flat_drop_delegate(f);
    gen_close_source(&f->g, &f->values, scr_exc_take());
    return;
  }
  if (v == op_k_done || v == op_k_eof) {
    scr_dyn_release(v);
    flat_drop_delegate(f);
    flat_next_value(f);
    return;
  }
  gen_yield_now(&f->g, v);
  scr_dyn_release(v);
}

/* Await(innerResult) for an async delegate: done ends it, else its value
 * is yielded as it is. */
static void flat_iter_k(void *self, ScrDyn *v) {
  OpFlat *f = self;
  if (!v) {
    flat_drop_delegate(f);
    gen_close_source(&f->g, &f->values, scr_exc_take());
    return;
  }
  bool done = false;
  ScrDyn *value = flat_result(v, &done);
  scr_dyn_release(v);
  if (!value) {
    flat_drop_delegate(f);
    gen_close_source(&f->g, &f->values, scr_exc_take());
    return;
  }
  if (done) {
    scr_dyn_release(value);
    flat_drop_delegate(f);
    flat_next_value(f);
    return;
  }
  gen_yield_now(&f->g, value);
  scr_dyn_release(value);
}

/* The async-from-sync continuation: PromiseResolve(value) then the result
 * promise settles; yield* awaits that promise. */
typedef struct {
  OpObj base;
  ScrPromise *p;
  bool done;
} OpFlatWrap;

static void op_flat_wrap_drop(OpObj *o) {
  OpFlatWrap *w = (OpFlatWrap *)o;
  scr_promise_release(w->p);
  free(w);
}

static void op_flat_wrap_k(void *self, ScrDyn *v) {
  OpFlatWrap *w = self;
  if (!v) {
    scr_promise_reject_pending(w->p);
    return;
  }
  op_fulfill(w->p, w->done ? op_k_done : v);
  scr_dyn_release(v);
}

/* The awaited resume of an async compiled generator delegate, read to its
 * value or the done marker: done ends it, else the value is yielded. */
static void flat_gen_k(void *self, ScrDyn *v) {
  OpFlat *f = self;
  if (!v) {
    flat_drop_delegate(f);
    gen_close_source(&f->g, &f->values, scr_exc_take());
    return;
  }
  if (v == op_k_done) {
    scr_dyn_release(v);
    flat_drop_delegate(f);
    flat_next_value(f);
    return;
  }
  gen_yield_now(&f->g, v);
  scr_dyn_release(v);
}

static void flat_delegate_step(OpFlat *f) {
  if (f->iter_kind == FLAT_GEN_ASYNC) {
    ScrPromise *p = ((FromAsyncFn)f->gnext->fn)(f->gnext, scr_gen_retain(f->gen));
    op_await_gen(p, f->gread, &flat_gen_k, f);
    scr_promise_release(p);
    return;
  }
  if (f->iter_kind == FLAT_ASYNC) {
    ScrDyn *r = flat_call(f->iter, "next", NULL, 0);
    if (!r) {
      flat_drop_delegate(f);
      gen_close_source(&f->g, &f->values, scr_exc_take());
      return;
    }
    op_await_value(r, &flat_iter_k, f);
    scr_dyn_release(r);
    return;
  }
  if (f->iter_kind == FLAT_STREAM) {
    ScrPromise *p = scr_stream_next_result_dyn(f->stream);
    op_await(p, &flat_iter_k, f);
    scr_promise_release(p);
    return;
  }
  bool failed = false;
  ScrDyn *e = flat_take_element(f, &failed);
  if (failed) {
    flat_drop_delegate(f);
    gen_close_source(&f->g, &f->values, scr_exc_take());
    return;
  }
  OpFlatWrap *w = op_alloc(sizeof *w);
  w->base.rc = 1;
  w->base.drop = &op_flat_wrap_drop;
  w->p = scr_promise_new();
  w->done = e == NULL;
  f->step = scr_promise_retain(w->p);
  op_await_value(e ? e : scr_dyn_undefined(), &op_flat_wrap_k, w);
  if (e) scr_dyn_release(e);
  op_await(w->p, &flat_step_k, f);
  op_unref(w);
}

static void flat_val_k(void *self, ScrDyn *v) {
  OpFlat *f = self;
  if (!v) {
    ScrCaught *c = scr_exc_take();
    gen_complete(&f->g, c);
    scr_caught_release(c);
    return;
  }
  if (src_done(&f->values, v)) {
    scr_dyn_release(v);
    gen_complete(&f->g, NULL);
    return;
  }
  if (v->kind == SCR_DYN_ARR || v->kind == SCR_DYN_STR) {
    f->inner = v;
    f->idx = 0;
    flat_delegate_step(f);
    return;
  }
  ScrStream *stream = scr_stream_native_readable_of_dyn(v);
  if (stream) {
    scr_dyn_release(v);
    f->stream = stream;
    f->iter_kind = FLAT_STREAM;
    flat_delegate_step(f);
    return;
  }
  /* a compiled generator of the callback's declared type: stepped through
   * the compiler's helpers */
  if (f->gnext && v->kind == SCR_DYN_TYPED_REF && v->v.typed_ref.type_key &&
      !strncmp(v->v.typed_ref.type_key, f->gen_async ? "async-generator<" : "generator<",
               f->gen_async ? 16 : 10)) {
    f->gen = scr_dyn_typed_ref_unbox(v);
    scr_dyn_release(v);
    f->iter_kind = f->gen_async ? FLAT_GEN_ASYNC : FLAT_GEN_SYNC;
    flat_delegate_step(f);
    return;
  }
  /* yield* val: GetIterator(val, async); a compiled generator is its own
   * iterator */
  int kind = 0;
  ScrDyn *iter = NULL;
  if (v->kind == SCR_DYN_TYPED_REF && v->v.typed_ref.type_key &&
      (!strncmp(v->v.typed_ref.type_key, "async-generator<", 16) ||
       !strncmp(v->v.typed_ref.type_key, "generator<", 10))) {
    kind = v->v.typed_ref.type_key[0] == 'a' ? 2 : 1;
    iter = scr_dyn_retain(v);
  } else {
    iter = scr_dyn_open_iterator(v, &kind, true);
  }
  if (!iter && kind == 0 && !scr_exc_pending()) {
    /* V8's GetIterator over a value without either method */
    if (v->kind == SCR_DYN_NULL || v->kind == SCR_DYN_UNDEF) {
      char m[96];
      int n = snprintf(m, sizeof m,
                       "Cannot read properties of %s (reading 'Symbol(Symbol.asyncIterator)')",
                       v->kind == SCR_DYN_NULL ? "null" : "undefined");
      scr_throw_error_msg(SCR_ERR_TYPE, m, (size_t)n);
    } else {
      static const char m[] = "undefined is not a function";
      scr_throw_error_msg(SCR_ERR_TYPE, m, sizeof m - 1);
    }
  }
  scr_dyn_release(v);
  if (!iter) {
    gen_close_source(&f->g, &f->values, scr_exc_take());
    return;
  }
  f->iter = iter;
  f->iter_kind = kind == 2 ? FLAT_ASYNC : FLAT_SYNC;
  flat_delegate_step(f);
}

static void flat_next_value(OpFlat *f) {
  ScrPromise *p = src_next(&f->values);
  op_await(p, &flat_val_k, f);
  scr_promise_release(p);
}

static void flat_resume(OpGen *g) {
  OpFlat *f = (OpFlat *)g;
  if (!f->started) {
    f->started = true;
    flat_next_value(f);
    return;
  }
  flat_delegate_step(f);
}

/* A return during delegation: the async-from-sync iterator's return()
 * resolves at once (arrays have no return method), yield* awaits it and
 * then the return value, and the return completion leaves the for await,
 * closing map's generator. */
typedef struct {
  OpObj base;
  OpFlat *f;
  int stage;
} OpFlatRet;

static void op_flat_ret_drop(OpObj *o) {
  OpFlatRet *r = (OpFlatRet *)o;
  op_unref(r->f);
  free(r);
}

static void op_flat_ret_k(void *self, ScrDyn *v) {
  OpFlatRet *r = self;
  if (v) scr_dyn_release(v);
  else scr_exc_clear();
  if (r->stage == 0) {
    r->stage = 1;
    op_await_value(scr_dyn_undefined(), &op_flat_ret_k, r);
    return;
  }
  flat_drop_delegate(r->f);
  gen_close_source(&r->f->g, &r->f->values, NULL);
}

/* Whether the delegate's iterator has a callable `name` method. */
static bool flat_iter_has(OpFlat *f, const char *name) {
  if (!f->iter) return false;
  ScrDyn *m = flat_get(f->iter, name);
  if (!m) {
    scr_exc_clear();
    return false;
  }
  bool callable = scr_dyn_is_callable(m);
  scr_dyn_release(m);
  return callable;
}

static void flat_ret(OpGen *g, ScrDyn *v) {
  (void)v;
  OpFlat *f = (OpFlat *)g;
  OpFlatRet *r = op_alloc(sizeof *r);
  r->base.rc = 1;
  r->base.drop = &op_flat_ret_drop;
  r->f = op_ref(f);
  if (f->iter_kind == FLAT_GEN_ASYNC) {
    /* the generator's return(): awaited, then the value */
    ScrPromise *p = ((FromAsyncFn)f->gret->fn)(f->gret, scr_gen_retain(f->gen));
    op_await_gen(p, f->gread, &op_flat_ret_k, r);
    scr_promise_release(p);
    op_unref(r);
    return;
  }
  if (f->iter_kind == FLAT_GEN_SYNC) {
    ScrDyn *res = ((FromSyncFn)f->gret->fn)(f->gret, scr_gen_retain(f->gen));
    if (!res) {
      flat_drop_delegate(f);
      gen_close_source(g, &f->values, scr_exc_take());
      op_unref(r);
      return;
    }
    scr_dyn_release(res);
    op_await_value(scr_dyn_undefined(), &op_flat_ret_k, r);
    op_unref(r);
    return;
  }
  if (f->iter_kind == FLAT_ASYNC) {
    /* yield*'s return: Await(iterator.return(value)), then the value */
    if (flat_iter_has(f, "return")) {
      ScrDyn *arg = scr_dyn_undefined();
      ScrDyn *res = flat_call(f->iter, "return", &arg, 1);
      if (!res) {
        flat_drop_delegate(f);
        gen_close_source(g, &f->values, scr_exc_take());
        op_unref(r);
        return;
      }
      op_await_value(res, &op_flat_ret_k, r);
      scr_dyn_release(res);
    } else {
      r->stage = 1;
      op_await_value(scr_dyn_undefined(), &op_flat_ret_k, r);
    }
    op_unref(r);
    return;
  }
  if (f->iter_kind == FLAT_SYNC && flat_iter_has(f, "return")) {
    /* the async-from-sync iterator's return() calls the sync one */
    ScrDyn *arg = scr_dyn_undefined();
    ScrDyn *res = flat_call(f->iter, "return", &arg, 1);
    if (!res) {
      flat_drop_delegate(f);
      gen_close_source(g, &f->values, scr_exc_take());
      op_unref(r);
      return;
    }
    scr_dyn_release(res);
  } else if (f->iter_kind == FLAT_STREAM) {
    scr_stream_release(scr_stream_iterator_close(f->stream));
  }
  op_await_value(scr_dyn_undefined(), &op_flat_ret_k, r);
  op_unref(r);
}

/* A throw during delegation: the array iterator has no throw method, so
 * yield* rejects with Node's TypeError, which leaves the for await and
 * closes map's generator. */
static void flat_thr(OpGen *g, ScrCaught *c) {
  OpFlat *f = (OpFlat *)g;
  if (f->iter_kind == FLAT_GEN_ASYNC || f->iter_kind == FLAT_GEN_SYNC) {
    /* the generator's throw(error) answers the next step */
    ScrDyn *err = scr_caught_to_dyn(c);
    if (f->iter_kind == FLAT_GEN_ASYNC) {
      ScrPromise *p = ((FromAsyncThrowFn)f->gthr->fn)(f->gthr, scr_gen_retain(f->gen), err);
      op_await_gen(p, f->gread, &flat_gen_k, f);
      scr_promise_release(p);
      return;
    }
    ScrDyn *v = ((FromSyncThrowFn)f->gthr->fn)(f->gthr, scr_gen_retain(f->gen), err);
    if (!v) {
      flat_drop_delegate(f);
      gen_close_source(g, &f->values, scr_exc_take());
      return;
    }
    if (v == op_k_done) {
      scr_dyn_release(v);
      flat_drop_delegate(f);
      flat_next_value(f);
      return;
    }
    op_await_value(v, &flat_step_k, f);
    scr_dyn_release(v);
    return;
  }
  if ((f->iter_kind == FLAT_ASYNC || f->iter_kind == FLAT_SYNC) && flat_iter_has(f, "throw")) {
    /* yield*'s throw: the delegate's throw(error) answers the next step */
    ScrDyn *err = scr_caught_to_dyn(c);
    ScrDyn *res = flat_call(f->iter, "throw", &err, 1);
    scr_dyn_release(err);
    if (!res) {
      flat_drop_delegate(f);
      gen_close_source(g, &f->values, scr_exc_take());
      return;
    }
    if (f->iter_kind == FLAT_ASYNC) {
      op_await_value(res, &flat_iter_k, f);
      scr_dyn_release(res);
      return;
    }
    ScrPromise *p = op_resolved(res);
    scr_dyn_release(res);
    op_await(p, &flat_iter_k, f);
    scr_promise_release(p);
    return;
  }
  if (f->iter_kind == FLAT_STREAM) {
    /* the stream's iterator rethrows after destroying the stream */
    ScrDyn *err = scr_caught_to_dyn(c);
    ScrError *e = err ? scr_error_from_dyn(err) : NULL;
    if (scr_exc_pending()) scr_exc_clear();
    if (err) scr_dyn_release(err);
    scr_stream_release(scr_stream_destroy(f->stream, e));
    if (e) scr_error_release(e);
    flat_drop_delegate(f);
    gen_close_source(g, &f->values, scr_caught_retain(c));
    return;
  }
  if (f->iter_kind != FLAT_NONE && flat_iter_has(f, "return")) {
    /* no throw method: the iterator closes first */
    ScrDyn *res = flat_call(f->iter, "return", NULL, 0);
    if (res) scr_dyn_release(res);
    else scr_exc_clear();
  }
  flat_drop_delegate(f);
  ScrError *e = op_coded_error(SCR_ERR_TYPE, NULL, "The iterator does not provide a 'throw' method.");
  gen_close_source(g, &f->values, op_take_error(e));
}

/* ── Readable.from(generator) ──────────────────────────────────────── */

/* The operator's output stream: from.js's nextAsync pulls the generator
 * while push() accepts, and _destroy runs close(error) (the generator's
 * throw, then return) before the destroy callback, on a nextTick. */
enum { FROM_OP, FROM_SYNC, FROM_ASYNC, FROM_DYN };

typedef struct {
  OpObj base;
  int kind;
  OpGen *g;        /* +1 (FROM_OP: an operator's generator) */
  /* FROM_SYNC / FROM_ASYNC: a compiled generator and the compiler's
   * helpers over it (+1 each). next/ret/thr answer the next value or the
   * done marker (sync), or the resume's promise (async, read through
   * `read`). */
  ScrGen *gen;
  ScrClosure *next, *ret, *thr, *read;
  /* FROM_DYN: the checked-dynamic iterator from.js keeps (+1), and
   * whether it came from Symbol.asyncIterator */
  ScrDyn *iter;
  bool async_iter;
  ScrStream *out;  /* borrowed: the stream owns this object */
  bool reading;
} OpFrom;

static void op_from_drop(OpObj *o) {
  OpFrom *f = (OpFrom *)o;
  if (f->g) op_unref(f->g);
  scr_gen_release(f->gen);
  if (f->next) scr_closure_release(f->next);
  if (f->ret) scr_closure_release(f->ret);
  if (f->thr) scr_closure_release(f->thr);
  if (f->read) scr_closure_release(f->read);
  if (f->iter) scr_dyn_release(f->iter);
  free(f);
}

/* The helper ABIs: the closure first, then the declared parameters, which
 * the callee owns. */
/* `await p` over an async generator's resume promise: the IteratorResult
 * record goes through `read` (the value, or the done marker) before k.
 * Awaiting the typed promise itself keeps from.js's single await. */
typedef struct {
  void *self;
  OpCont k;
  ScrPromise *p;
  ScrClosure *read;
} OpAwaitGen;

static void op_await_gen_entry(ScrFiber *fiber, void *arg) {
  (void)fiber;
  OpAwaitGen a = *(OpAwaitGen *)arg;
  free(arg);
  void *rec = scr_await_ref(a.p);
  scr_promise_release(a.p);
  ScrDyn *v = scr_exc_pending() ? NULL : ((FromReadFn)a.read->fn)(a.read, rec);
  scr_closure_release(a.read);
  a.k(a.self, v);
  if (scr_exc_pending()) scr_exc_clear();
  op_unref(a.self);
}

static void op_await_gen(ScrPromise *p, ScrClosure *read, OpCont k, void *self) {
  OpAwaitGen *a = op_alloc(sizeof *a);
  a->self = op_ref(self);
  a->k = k;
  a->p = scr_promise_retain(p);
  a->read = scr_closure_retain(read);
  ScrPromise *fiber = scr_async_spawn_after(p, &op_await_gen_entry, a);
  scr_promise_release(fiber);
}

/* One pull: the stream is held for the await. */
typedef struct {
  OpObj base;
  OpFrom *from;
  ScrStream *out; /* +1 */
} OpFromStep;

static void op_from_step_drop(OpObj *o) {
  OpFromStep *st = (OpFromStep *)o;
  op_unref(st->from);
  scr_stream_release(st->out);
  free(st);
}

static void from_next(OpFrom *f, ScrStream *out);

/* An operator error as a stream error: Error values as themselves, any
 * other thrown value refused. +1. */
static ScrError *op_caught_error(const ScrCaught *c) {
  ScrDyn *d = scr_caught_to_dyn(c);
  ScrError *e = d ? scr_errdyn_err_of(d) : NULL;
  if (d) scr_dyn_release(d);
  if (e) return e;
  return op_unsupported("a stream operator rejection that is not an Error object");
}

static void op_from_destroy_with(ScrStream *out, ScrError *e /*moves*/) {
  scr_stream_release(scr_stream_destroy(out, e));
  scr_error_release(e);
}

/* A compiled generator's value: from.js's push, with null and values
 * other than strings or Buffers destroying the stream. Answers whether
 * to pull again. Moves v (NULL: the resume threw, pending). */
static bool from_take(OpFrom *f, ScrStream *out, ScrDyn *v) {
  if (!v) {
    ScrCaught *c = scr_exc_take();
    op_from_destroy_with(out, op_caught_error(c));
    scr_caught_release(c);
    return false;
  }
  if (v == op_k_done) {
    scr_dyn_release(v);
    scr_stream_push_null(out);
    return false;
  }
  if (v->kind == SCR_DYN_NULL) f->reading = false;
  int pushed = scr_stream_from_push(out, v);
  scr_dyn_release(v);
  if (pushed < 0 || scr_exc_pending()) return false;
  if (pushed) return true;
  f->reading = false;
  return false;
}

static void op_from_step_k(void *self, ScrDyn *v) {
  OpFromStep *st = self;
  OpFrom *f = st->from;
  ScrStream *out = st->out;
  if (f->kind != FROM_OP) {
    if (from_take(f, out, v)) from_next(f, out);
    return;
  }
  if (!v) {
    ScrCaught *c = scr_exc_take();
    op_from_destroy_with(out, op_caught_error(c));
    scr_caught_release(c);
    return;
  }
  if (v == op_k_done) {
    scr_dyn_release(v);
    scr_stream_push_null(out);
    return;
  }
  if (v->kind == SCR_DYN_NULL) {
    scr_dyn_release(v);
    f->reading = false;
    op_from_destroy_with(out, op_coded_error(SCR_ERR_TYPE, "ERR_STREAM_NULL_VALUES",
                                             "May not write null values to stream"));
    return;
  }
  int pushed = scr_stream_push_object(out, v);
  scr_dyn_release(v);
  if (pushed) {
    from_next(f, out);
    return;
  }
  f->reading = false;
}

/* iterator[name](...args): the method is read through the property on
 * every call. +1, or NULL with the error pending ("<what> is not a
 * function" for a method that cannot be called). */
static ScrDyn *from_dyn_call(const ScrDyn *iter, const char *name, ScrDyn *const *args,
                             size_t argc, const char *what) {
  ScrDyn *m = scr_dyn_iterator_result_get(iter, name, strlen(name));
  if (!m) return NULL;
  scr_dyn_this_push_dyn(iter);
  ScrDyn *r = scr_dyn_call(m, args, argc, what);
  scr_dyn_this_pop();
  scr_dyn_release(m);
  return r;
}

/* `const { value, done } = result` over an iterator result: value, then
 * done, each read once. what spells the result expression in the
 * TypeError for a nullish result. +1 value with *done set, or NULL with
 * the error pending. Borrows r. */
static ScrDyn *from_dyn_result(const ScrDyn *r, const char *what, bool *done) {
  if (r->kind == SCR_DYN_UNDEF || r->kind == SCR_DYN_NULL) {
    char msg[160];
    int n = snprintf(msg, sizeof msg, "Cannot destructure property 'value' of '%s' as it is %s.",
                     what, r->kind == SCR_DYN_UNDEF ? "undefined" : "null");
    scr_throw_error_msg(SCR_ERR_TYPE, msg, (size_t)n);
    return NULL;
  }
  ScrDyn *v = scr_dyn_iterator_result_get(r, "value", 5);
  if (!v) return NULL;
  ScrDyn *d = scr_dyn_iterator_result_get(r, "done", 4);
  if (!d) {
    scr_dyn_release(v);
    return NULL;
  }
  *done = scr_dyn_truthy(d);
  scr_dyn_release(d);
  return v;
}

/* `value && typeof value.then === 'function'`: 1 for a promise, 0 for
 * no then method, -1 for another thenable (refused: the await of a
 * non-promise thenable has no lowering), -2 with the error pending. */
static int from_dyn_thenable(const ScrDyn *v) {
  if (v->kind == SCR_DYN_PROMISE) return 1;
  if (!scr_dyn_truthy(v)) return 0;
  if (v->kind != SCR_DYN_OBJ && v->kind != SCR_DYN_FUNC && v->kind != SCR_DYN_PROXY &&
      v->kind != SCR_DYN_TYPED_REF) {
    return 0;
  }
  ScrDyn *then = scr_dyn_iterator_result_get(v, "then", 4);
  if (!then) return -2;
  bool callable = scr_dyn_is_callable(then);
  scr_dyn_release(then);
  return callable ? -1 : 0;
}

static OpFromStep *from_step_new(OpFrom *f, ScrStream *out) {
  OpFromStep *st = op_alloc(sizeof *st);
  st->base.rc = 1;
  st->base.drop = &op_from_step_drop;
  st->from = op_ref(f);
  st->out = scr_stream_retain(out);
  return st;
}

/* nextAsync's `await iterator.next()` result, destructured: the value,
 * the done marker, or NULL (the await rejected or the result read threw,
 * pending). Moves r. */
static ScrDyn *from_dyn_async_result(ScrDyn *r) {
  if (!r) return NULL;
  bool done = false;
  ScrDyn *v = from_dyn_result(r, "(intermediate value)", &done);
  scr_dyn_release(r);
  if (v && done) {
    scr_dyn_release(v);
    return scr_dyn_retain(op_k_done);
  }
  return v;
}

static void op_from_dyn_async_k(void *self, ScrDyn *r) {
  OpFromStep *st = self;
  if (from_take(st->from, st->out, from_dyn_async_result(r))) {
    from_next(st->from, st->out);
  }
}

/* from.js over a checked-dynamic iterator. A sync iterator pushes while
 * push() accepts and awaits only promise values (nextSyncWithSyncValues,
 * changeToAsyncValues and nextSyncWithAsyncValues behave the same way);
 * an async iterator awaits each next() result (nextAsync). Each pull
 * calls iterator.next() through its property. */
static void from_dyn_next(OpFrom *f, ScrStream *out) {
  if (f->async_iter) {
    ScrDyn *r = from_dyn_call(f->iter, "next", NULL, 0, "iterator.next");
    if (!r) {
      from_take(f, out, NULL);
      return;
    }
    OpFromStep *st = from_step_new(f, out);
    op_await_value(r, &op_from_dyn_async_k, st);
    scr_dyn_release(r);
    op_unref(st);
    return;
  }
  for (;;) {
    ScrDyn *r = from_dyn_call(f->iter, "next", NULL, 0, "iterator.next");
    bool done = false;
    ScrDyn *v = NULL;
    if (r) {
      v = from_dyn_result(r, "iterator.next(...)", &done);
      scr_dyn_release(r);
    }
    if (v && done) {
      scr_dyn_release(v);
      v = scr_dyn_retain(op_k_done);
    } else if (v) {
      int thenable = from_dyn_thenable(v);
      if (thenable == 1) {
        OpFromStep *st = from_step_new(f, out);
        op_await_value(v, &op_from_step_k, st);
        scr_dyn_release(v);
        op_unref(st);
        return;
      }
      if (thenable < 0) {
        scr_dyn_release(v);
        v = NULL;
        if (thenable == -1) {
          ScrError *e = op_unsupported("Readable.from over a value with a then method that is not a promise");
          scr_throw_obj(e, &scr_error_retain_v, &scr_error_release_v, scr_error_trace_arg());
        }
      }
    }
    if (!from_take(f, out, v)) return;
  }
}

static void from_next(OpFrom *f, ScrStream *out) {
  if (f->kind == FROM_DYN) {
    from_dyn_next(f, out);
    return;
  }
  if (f->kind == FROM_SYNC) {
    /* nextSyncWithSyncValues: no awaits between the pushes */
    while (from_take(f, out, ((FromSyncFn)f->next->fn)(f->next, scr_gen_retain(f->gen)))) {
    }
    return;
  }
  OpFromStep *st = op_alloc(sizeof *st);
  st->base.rc = 1;
  st->base.drop = &op_from_step_drop;
  st->from = op_ref(f);
  st->out = scr_stream_retain(out);
  if (f->kind == FROM_ASYNC) {
    ScrPromise *p = ((FromAsyncFn)f->next->fn)(f->next, scr_gen_retain(f->gen));
    op_await_gen(p, f->read, &op_from_step_k, st);
    scr_promise_release(p);
  } else {
    ScrPromise *p = gen_next(f->g);
    op_await(p, &op_from_step_k, st);
    scr_promise_release(p);
  }
  op_unref(st);
}

static OpFrom *op_from_of(ScrClosure *cb) { return scr_box_get_ref(cb->caps[0]); /* +1 */ }

/* readable._read */
static void op_from_read_inv(ScrClosure *cb, ScrStream *s, double size) {
  (void)size;
  OpFrom *f = op_from_of(cb);
  if (!f->reading) {
    f->reading = true;
    from_next(f, s);
  }
  op_unref(f);
}

/* close(error): `await iterator.throw(error)` (when there is an error),
 * `await value`, then `await iterator.return()` and `await value`; the
 * destroy callback follows on a nextTick from the promise's reaction. */
typedef struct {
  OpObj base;
  OpFrom *from;
  ScrStream *out;  /* +1 */
  ScrError *error; /* +1, the destroy error, or NULL */
  ScrError *fail;  /* +1, close()'s rejection */
  int stage;
  bool thr_done;   /* FROM_DYN: the throw() result's done */
} OpFromClose;

static void op_from_close_drop(OpObj *o) {
  OpFromClose *c = (OpFromClose *)o;
  op_unref(c->from);
  scr_stream_release(c->out);
  if (c->error) scr_error_release(c->error);
  if (c->fail) scr_error_release(c->fail);
  free(c);
}

/* aggregateTwoErrors(inner, outer) from internal/errors.js: two distinct
 * errors become an AggregateError of [outer, inner] with outer's message
 * and code, or inner joins outer.errors when that is an array; otherwise
 * whichever is set. +1, or NULL for neither. */
static ScrError *op_aggregate_two(ScrError *inner, ScrError *outer) {
  if (!inner || !outer || inner == outer) {
    ScrError *e = inner ? inner : outer;
    return e ? scr_error_retain(e) : NULL;
  }
  ScrDyn *od = scr_dyn_from_error(outer);
  ScrDyn *list = od ? scr_dyn_iterator_result_get(od, "errors", 6) : NULL;
  if (list && list->kind == SCR_DYN_ARR) {
    scr_dyn_arr_push(list, scr_dyn_from_error(inner));
    scr_dyn_release(list);
    scr_dyn_release(od);
    return scr_error_retain(outer);
  }
  if (list) scr_dyn_release(list);
  /* err.code = outerError.code: a code assigned in JavaScript is a
   * property of the error's checked-dynamic view */
  ScrDyn *code = od ? scr_dyn_iterator_result_get(od, "code", 4) : NULL;
  if (od) scr_dyn_release(od);
  if (scr_exc_pending()) scr_exc_clear();
  ScrDyn *m = scr_dyn_new_str(outer->message);
  ScrError *e = scr_aggregate_new(m, scr_dyn_undefined());
  scr_dyn_release(m);
  if (!e) {
    scr_exc_clear();
    if (code) scr_dyn_release(code);
    return scr_error_retain(outer);
  }
  ScrDyn *errors = scr_dyn_new_arr();
  scr_dyn_arr_push(errors, scr_dyn_from_error(outer));
  scr_dyn_arr_push(errors, scr_dyn_from_error(inner));
  scr_aggregate_set_errors(e, errors);
  scr_dyn_release(errors);
  if (code && code->kind == SCR_DYN_STR) e->code = scr_str_retain(code->v.str);
  if (code) scr_dyn_release(code);
  return e;
}

static void op_from_cb_tick(ScrClosure *job) {
  OpFromClose *c = scr_box_get_ref(job->caps[0]);
  /* cb(combinedError), or cb(aggregateTwoErrors(combinedError, closeError)) */
  scr_stream_destroy_done(c->out, op_aggregate_two(c->error, c->fail));
  op_unref(c);
}

static void op_from_close_settled(OpFromClose *c) {
  /* PromisePrototypeThen(close(error), ...): the reaction job, then
   * process.nextTick(cb, ...) */
  ScrClosure *job = scr_closure_new((void *)&op_from_cb_tick, 1);
  job->caps[0] = scr_box_new_obj(&op_ref, &op_unref, NULL);
  scr_box_set_ref(job->caps[0], op_ref(c));
  scr_next_tick(job);
}

static void op_from_close_k(void *self, ScrDyn *v);

static void op_from_close_step(OpFromClose *c, ScrPromise *p) {
  op_await(p, &op_from_close_k, c);
  scr_promise_release(p);
}

/* `await iterator.throw(error)` (err set) or `await iterator.return()`:
 * op_from_close_k receives the result's value, or the done marker. A
 * compiled sync generator answers at once (one job for the await); a
 * compiled async generator answers through its promise. */
static void from_close_resume(OpFromClose *c, ScrError *err) {
  OpFrom *f = c->from;
  if (f->kind == FROM_OP) {
    if (err) {
      ScrCaught *thrown = op_take_error(scr_error_retain(err));
      op_from_close_step(c, gen_throw(f->g, thrown));
      scr_caught_release(thrown);
    } else {
      op_from_close_step(c, gen_return(f->g, scr_dyn_undefined()));
    }
    return;
  }
  ScrDyn *e = err ? scr_dyn_from_error(err) : NULL;
  if (f->kind == FROM_SYNC) {
    ScrDyn *v = e ? ((FromSyncThrowFn)f->thr->fn)(f->thr, scr_gen_retain(f->gen), e)
                  : ((FromSyncFn)f->ret->fn)(f->ret, scr_gen_retain(f->gen));
    if (!v) {
      op_from_close_k(c, NULL); /* close() rejects without an await */
      return;
    }
    op_await_value(v, &op_from_close_k, c);
    scr_dyn_release(v);
    return;
  }
  ScrPromise *p = e ? ((FromAsyncThrowFn)f->thr->fn)(f->thr, scr_gen_retain(f->gen), e)
                    : ((FromAsyncFn)f->ret->fn)(f->ret, scr_gen_retain(f->gen));
  op_await_gen(p, f->read, &op_from_close_k, c);
  scr_promise_release(p);
}

static void op_from_close_k(void *self, ScrDyn *v) {
  OpFromClose *c = self;
  if (!v) {
    ScrCaught *err = scr_exc_take();
    c->fail = op_caught_error(err);
    scr_caught_release(err);
    c->stage = 9;
    op_await_value(scr_dyn_undefined(), &op_from_close_k, c);
    return;
  }
  bool done = v == op_k_done;
  scr_dyn_release(v);
  switch (c->stage) {
  case 0: /* await iterator.throw(error) */
    c->stage = done ? 2 : 1;
    op_await_value(scr_dyn_undefined(), &op_from_close_k, c); /* await value */
    return;
  case 1: /* not done: iterator.return() */
  case 3:
    c->stage = 4;
    from_close_resume(c, NULL);
    return;
  case 2: /* done after the throw: close() returns */
  case 5:
  case 9:
    op_from_close_settled(c);
    return;
  case 4: /* await iterator.return() */
    c->stage = 5;
    op_await_value(scr_dyn_undefined(), &op_from_close_k, c); /* await value */
    return;
  default:
    op_from_close_settled(c);
  }
}

/* close(error) over a checked-dynamic iterator: `typeof iterator.throw`
 * and `typeof iterator.return` are read when close runs, and each result
 * is destructured and its value awaited as in from.js. Stages 20/21 await
 * throw()'s result and value, 22/23 return()'s, and 24 is the job of a
 * close that awaited nothing. */
static void op_from_dyn_close_k(void *self, ScrDyn *v);

/* typeof iterator[name] === 'function': 1, 0, or -1 with the error
 * pending. */
static int from_dyn_has_method(const ScrDyn *iter, const char *name, size_t len) {
  ScrDyn *m = scr_dyn_iterator_result_get(iter, name, len);
  if (!m) return -1;
  bool callable = scr_dyn_is_callable(m);
  scr_dyn_release(m);
  return callable ? 1 : 0;
}

/* Calls iterator[name](args) and awaits the result at stage. */
static void from_dyn_close_call(OpFromClose *c, const char *name, ScrDyn *const *args,
                                size_t argc, int stage) {
  char what[16];
  snprintf(what, sizeof what, "iterator.%s", name);
  ScrDyn *r = from_dyn_call(c->from->iter, name, args, argc, what);
  if (!r) {
    op_from_close_k(c, NULL);
    return;
  }
  c->stage = stage;
  op_await_value(r, &op_from_dyn_close_k, c);
  scr_dyn_release(r);
}

static void from_dyn_close_return(OpFromClose *c) {
  int has = from_dyn_has_method(c->from->iter, "return", 6);
  if (has < 0) {
    op_from_close_k(c, NULL);
    return;
  }
  if (has) {
    from_dyn_close_call(c, "return", NULL, 0, 22);
    return;
  }
  c->stage = 24;
  op_await_value(scr_dyn_undefined(), &op_from_dyn_close_k, c);
}

static void from_dyn_close_start(OpFromClose *c) {
  if (c->error) {
    int has = from_dyn_has_method(c->from->iter, "throw", 5);
    if (has < 0) {
      op_from_close_k(c, NULL);
      return;
    }
    if (has) {
      ScrDyn *e = scr_dyn_from_error(c->error);
      from_dyn_close_call(c, "throw", &e, 1, 20);
      scr_dyn_release(e);
      return;
    }
  }
  from_dyn_close_return(c);
}

static void op_from_dyn_close_k(void *self, ScrDyn *v) {
  OpFromClose *c = self;
  if (!v) {
    op_from_close_k(c, NULL);
    return;
  }
  switch (c->stage) {
  case 20:   /* const { value, done } = await iterator.throw(error) */
  case 22: { /* const { value } = await iterator.return() */
    bool done = false;
    ScrDyn *value = from_dyn_result(v, "(intermediate value)", &done);
    scr_dyn_release(v);
    if (!value) {
      op_from_close_k(c, NULL);
      return;
    }
    c->thr_done = done;
    c->stage++;
    op_await_value(value, &op_from_dyn_close_k, c); /* await value */
    scr_dyn_release(value);
    return;
  }
  case 21: /* if (done) return; */
    scr_dyn_release(v);
    if (c->thr_done) op_from_close_settled(c);
    else from_dyn_close_return(c);
    return;
  default: /* 23, 24 */
    scr_dyn_release(v);
    op_from_close_settled(c);
  }
}

static void op_from_destroy_inv(ScrClosure *cb, ScrStream *s, ScrError *err) {
  OpFrom *f = op_from_of(cb);
  OpFromClose *c = op_alloc(sizeof *c);
  c->base.rc = 1;
  c->base.drop = &op_from_close_drop;
  c->from = f; /* the +1 from op_from_of moves here */
  c->out = scr_stream_retain(s);
  c->error = err ? scr_error_retain(err) : NULL;
  if (f->kind == FROM_DYN) {
    from_dyn_close_start(c);
  } else {
    c->stage = err ? 0 : 4;
    from_close_resume(c, err);
  }
  op_unref(c);
}

static ScrClosure *op_from_closure(void *fn, OpFrom *f) {
  ScrClosure *c = scr_closure_new(fn, 1);
  c->caps[0] = scr_box_new_obj(&op_ref, &op_unref, NULL);
  scr_box_set_ref(c->caps[0], op_ref(f));
  return c;
}

/* Readable.from(generator): +1 object-mode stream (hwm 1). Moves g. */
static ScrStream *op_from_gen(OpGen *g) {
  OpFrom *f = op_alloc(sizeof *f);
  f->base.rc = 1;
  f->base.drop = &op_from_drop;
  f->g = g;
  ScrStream *out = scr_stream_new_object_readable(op_from_closure((void *)&op_from_read_inv, f),
                                                  &op_from_read_inv,
                                                  op_from_closure((void *)&op_from_destroy_inv, f),
                                                  &op_from_destroy_inv);
  f->out = out;
  op_unref(f);
  return out;
}

/* Readable.from over a compiled generator (the compiler's helpers move
 * in, borrowed; g borrowed). +1, or NULL with ERR_INVALID_ARG_VALUE
 * pending for a bad highWaterMark. */
static ScrStream *op_from_compiled(int kind, ScrGen *g, ScrClosure *next, ScrClosure *read,
                                   ScrClosure *ret, ScrClosure *thr, double flags, double hwm) {
  OpFrom *f = op_alloc(sizeof *f);
  f->base.rc = 1;
  f->base.drop = &op_from_drop;
  f->kind = kind;
  f->gen = scr_gen_retain(g);
  f->next = scr_closure_retain(next);
  f->read = read ? scr_closure_retain(read) : NULL;
  f->ret = scr_closure_retain(ret);
  f->thr = scr_closure_retain(thr);
  ScrStream *out = scr_stream_new_from_readable(op_from_closure((void *)&op_from_read_inv, f),
                                                &op_from_read_inv,
                                                op_from_closure((void *)&op_from_destroy_inv, f),
                                                &op_from_destroy_inv, flags, hwm);
  f->out = out;
  op_unref(f);
  return out;
}

ScrStream *scr_stream_from_gen(ScrGen *g, ScrClosure *next, ScrClosure *ret, ScrClosure *thr,
                               double flags, double hwm) {
  op_sentinels_init();
  return op_from_compiled(FROM_SYNC, g, next, NULL, ret, thr, flags, hwm);
}

ScrStream *scr_stream_from_async_gen(ScrGen *g, ScrClosure *next, ScrClosure *read,
                                     ScrClosure *ret, ScrClosure *thr, double flags,
                                     double hwm) {
  op_sentinels_init();
  return op_from_compiled(FROM_ASYNC, g, next, read, ret, thr, flags, hwm);
}

ScrStream *scr_stream_from_dyn_iter(ScrDyn *iter, bool async_iter, double flags, double hwm) {
  op_sentinels_init();
  OpFrom *f = op_alloc(sizeof *f);
  f->base.rc = 1;
  f->base.drop = &op_from_drop;
  f->kind = FROM_DYN;
  f->iter = iter;
  f->async_iter = async_iter;
  ScrStream *out = scr_stream_new_from_readable(op_from_closure((void *)&op_from_read_inv, f),
                                                &op_from_read_inv,
                                                op_from_closure((void *)&op_from_destroy_inv, f),
                                                &op_from_destroy_inv, flags, hwm);
  f->out = out;
  op_unref(f);
  return out;
}

ScrStream *scr_stream_from_iter(ScrDyn *iter, double flags, double hwm) {
  return scr_stream_from_dyn_iter(scr_dyn_retain(iter), false, flags, hwm);
}

ScrStream *scr_stream_from_async_iter(ScrDyn *iter, double flags, double hwm) {
  return scr_stream_from_dyn_iter(scr_dyn_retain(iter), true, flags, hwm);
}

/* ── Duplex.from (duplexify.js) ─────────────────────────────────────
 * Duplex.from(asyncGeneratorFunction): fromAsyncGen hands the function a
 * source generator that the writes and the final feed through a deferred
 * promise, and from(Duplexify, value, { objectMode: true, write, final,
 * destroy }) reads what the function yields. The source generator is
 * compiled (the frontend's Duplex.from source helper):
 *
 *   while (true) { const v = await next(); ack(); if (v is done) return; yield v; }
 *
 * next() answers the current deferred, a write or the final settles it
 * (the chunk, or the done marker), and ack() is fromAsyncGen's
 * `process.nextTick(cb)` followed by a fresh deferred. */

enum { CHAN_NONE, CHAN_WRITE, CHAN_FINAL, CHAN_ABORT, CHAN_FINAL_ASYNC };

typedef struct OpChan OpChan;
struct OpChan {
  OpObj base;
  ScrStream *d;         /* +1, dropped at destroy (or exit) */
  ScrPromise *promise;  /* +1: the deferred next() answers, NULL once taken */
  ScrPromise *resolve;  /* +1: the deferred a write or the final settles, NULL once settled */
  int settled;          /* CHAN_*: what settled the deferred, for ack() */
  bool aborted;         /* destroy ran (fromAsyncGen's ac.abort()) */
  ScrClosure *abort;    /* +1: the body's AbortController's abort(), or NULL */
  /* An async function body: its promise's then() (duplexify.js) settles
   * `promise` there; the final waits for it. */
  bool finalized;       /* final() has started */
  bool body_settled;    /* the then() callbacks ran */
  bool final_waiting;   /* the final's callback awaits the settlement */
  ScrError *body_err;   /* +1: what awaiting the then() result throws, or NULL */
  OpChan *live_prev, *live_next;
};

static SCR_TL OpChan *op_chan_live = NULL;

static void op_chan_drop(OpObj *o) {
  OpChan *c = (OpChan *)o;
  if (c->body_err) scr_error_release(c->body_err);
  if (c->abort) scr_closure_release(c->abort);
  if (c->d) scr_stream_release(c->d);
  if (c->promise) scr_promise_release(c->promise);
  if (c->resolve) scr_promise_release(c->resolve);
  free(c);
}

/* createDeferredPromise() */
static void op_chan_defer(OpChan *c) {
  ScrPromise *p = scr_promise_new();
  if (c->promise) scr_promise_release(c->promise);
  if (c->resolve) scr_promise_release(c->resolve);
  c->promise = p;
  c->resolve = scr_promise_retain(p);
}

/* Unlinks the channel from the live list and drops its stream and its
 * deferred (a source still awaiting it stays pending, as in Node). */
static void op_chan_retire(OpChan *c) {
  if (c->live_prev) c->live_prev->live_next = c->live_next;
  else if (op_chan_live == c) op_chan_live = c->live_next;
  else return; /* already retired */
  if (c->live_next) c->live_next->live_prev = c->live_prev;
  c->live_prev = c->live_next = NULL;
  ScrStream *d = c->d;
  c->d = NULL;
  if (c->abort) scr_closure_release(c->abort);
  c->abort = NULL;
  if (c->promise) scr_promise_release(c->promise);
  if (c->resolve) scr_promise_release(c->resolve);
  c->promise = c->resolve = NULL;
  if (d) scr_stream_release(d);
  op_unref(c); /* the live list's reference */
}

static void op_chan_atexit(void) {
  while (op_chan_live) op_chan_retire(op_chan_live);
}

static ScrClosure *op_chan_closure(void *fn, OpChan *c) {
  ScrClosure *cl = scr_closure_new(fn, 1);
  cl->caps[0] = scr_box_new_obj(&op_ref, &op_unref, NULL);
  scr_box_set_ref(cl->caps[0], op_ref(c));
  return cl;
}

static OpChan *op_chan_of(ScrClosure *cb) { return scr_box_get_ref(cb->caps[0]); /* +1 */ }

/* process.nextTick(cb): the write's or the final's completion. */
static void op_chan_done_tick(ScrClosure *job) {
  ScrStream *d = scr_box_get_ref(job->caps[0]);
  bool final = scr_box_get_bool(job->caps[1]);
  if (final) scr_stream_final_done(d, NULL);
  else scr_stream_write_done(d, NULL);
  scr_stream_release(d);
}

/* The source's `await _promise`: the current deferred (+1). */
static ScrPromise *op_chan_next_inv(ScrClosure *cb) {
  OpChan *c = op_chan_of(cb);
  ScrPromise *p = c->promise;
  c->promise = NULL;
  op_unref(c);
  return p ? p : scr_promise_new();
}

static ScrError *op_chan_abort_error(void) {
  ScrStr *message = scr_str_new("The operation was aborted", 25);
  ScrError *e = scr_error_new(SCR_ERR_ERROR, message);
  scr_str_release(message);
  scr_str_release(e->name);
  e->name = scr_str_new("AbortError", 10);
  scr_error_set_code(e, "ABORT_ERR");
  e->name_present = true;
  e->name_enumerable = true;
  return e;
}

/* After the source's await: process.nextTick(cb), then (unless done) the
 * aborted check and a fresh deferred. */
static void op_chan_final_async_wait(OpChan *c);

/* The final's completion after `await promise`: process.nextTick(cb, err) */
static void op_chan_final_async_done(ScrClosure *job) {
  OpChan *c = op_chan_of(job);
  if (c->d) {
    ScrError *err = c->body_err ? scr_error_retain(c->body_err) : NULL;
    ScrStream *d = scr_stream_retain(c->d);
    scr_stream_final_done(d, err);
    scr_stream_release(d);
  }
  op_unref(c);
}

/* `await promise` resumed: the completion follows on the next tick */
static void op_chan_final_async_resume(ScrClosure *job) {
  OpChan *c = op_chan_of(job);
  scr_next_tick(op_chan_closure((void *)&op_chan_final_async_done, c));
  op_unref(c);
}

/* The final's async callback (run by the source's nextTick): it awaits
 * the then() result, which may still be pending. */
static void op_chan_final_async_tick(ScrClosure *job) {
  OpChan *c = op_chan_of(job);
  op_chan_final_async_wait(c);
  op_unref(c);
}

static void op_chan_final_async_wait(OpChan *c) {
  if (c->body_settled) scr_queue_microtask(op_chan_closure((void *)&op_chan_final_async_resume, c));
  else c->final_waiting = true;
}

static void op_chan_ack_inv(ScrClosure *cb) {
  OpChan *c = op_chan_of(cb);
  int settled = c->settled;
  c->settled = CHAN_NONE;
  if (settled == CHAN_FINAL_ASYNC) {
    scr_next_tick(op_chan_closure((void *)&op_chan_final_async_tick, c));
    op_unref(c);
    return;
  }
  if (c->d && (settled == CHAN_WRITE || settled == CHAN_FINAL)) {
    ScrClosure *tick = scr_closure_new((void *)&op_chan_done_tick, 2);
    tick->caps[0] = scr_box_new_obj(&scr_stream_retain_v, &scr_stream_release_v, &scr_stream_trace);
    scr_box_set_ref(tick->caps[0], scr_stream_retain(c->d));
    tick->caps[1] = scr_box_new(SCR_BOX_BOOL);
    scr_box_set_bool(tick->caps[1], settled == CHAN_FINAL);
    scr_next_tick(tick);
  }
  if (settled != CHAN_FINAL && settled != CHAN_ABORT) {
    if (c->aborted) {
      ScrError *e = op_chan_abort_error();
      scr_throw_obj(e, &scr_error_retain_v, &scr_error_release_v, scr_error_trace_arg());
    } else if (c->d) {
      op_chan_defer(c);
    }
  }
  op_unref(c);
}

/* `_resolve(value)`: the write's chunk or the final's done marker. */
static void op_chan_settle(OpChan *c, ScrDyn *v /*moves*/, int kind) {
  ScrPromise *p = c->resolve;
  c->resolve = NULL;
  if (!p) {
    scr_dyn_release(v);
    return;
  }
  c->settled = kind;
  scr_promise_fulfill_ref(p, v, scr_dyn_retain_v, scr_dyn_release_v, NULL);
  scr_promise_release(p);
}

/* Duplexify's write(chunk, encoding, cb) */
static void op_chan_write_inv(ScrClosure *cb, ScrStream *s, ScrBytes *chunk) {
  OpChan *c = op_chan_of(cb);
  op_chan_settle(c, scr_stream_chunk_value(s, chunk), CHAN_WRITE);
  op_unref(c);
}

/* Duplexify's final(cb) */
static void op_chan_final_inv(ScrClosure *cb, ScrStream *s) {
  (void)s;
  OpChan *c = op_chan_of(cb);
  op_chan_settle(c, scr_stream_from_done(), CHAN_FINAL);
  op_unref(c);
}

/* fromAsyncGen's ac.abort(err): the body's signal fires its abort
 * listeners once (a body that declares the options argument); without an
 * error the reason is null (destroy passes `err || null`). */
static void op_chan_abort(OpChan *c, ScrError *err) {
  c->aborted = true;
  ScrClosure *abort = c->abort;
  if (!abort) return;
  c->abort = NULL;
  ScrDyn *reason = err ? scr_dyn_from_error(err) : NULL;
  if (!reason) reason = scr_dyn_new_null();
  ((void (*)(ScrClosure *, ScrDyn *))abort->fn)(abort, reason); /* reason moves in */
  if (scr_exc_pending()) scr_exc_clear();
  scr_closure_release(abort);
}

/* destroy: fromAsyncGen's (ac.abort(); a source waiting for a write or
 * the final is unblocked with the done marker and a no-op callback;
 * cb(err)), then from()'s close of the function's iterator. caps: the
 * channel and the from() destroy closure. */
static void op_dup_destroy_inv(ScrClosure *cb, ScrStream *s, ScrError *err) {
  OpChan *c = scr_box_get_ref(cb->caps[0]);
  ScrClosure *from = scr_box_get_ref(cb->caps[1]);
  op_chan_abort(c, err);
  if (c->resolve) op_chan_settle(c, scr_stream_from_done(), CHAN_ABORT);
  op_chan_retire(c);
  op_unref(c);
  op_from_destroy_inv(from, s, err);
  scr_closure_release(from);
}

typedef ScrGen *(*OpSourceFn)(ScrClosure *, ScrClosure *, ScrClosure *);
typedef ScrGen *(*OpStageFn)(ScrClosure *, ScrGen *);
typedef ScrGen *(*OpStageOptsFn)(ScrClosure *, ScrGen *, ScrDyn *);

/* A new channel; with a signal (borrowed), the body's AbortController's
 * abort() (borrowed) is kept for destroy and *opts is { signal } (+1). */
static OpChan *op_chan_new(ScrClosure *abort, ScrDyn *signal, ScrDyn **opts) {
  op_sentinels_init();
  static SCR_TL bool registered = false;
  if (!registered) {
    registered = true;
    scr_atexit(op_chan_atexit);
  }
  OpChan *c = op_alloc(sizeof *c);
  c->base.rc = 1;
  c->base.drop = &op_chan_drop;
  *opts = NULL;
  if (signal) {
    c->abort = scr_closure_retain(abort);
    *opts = scr_dyn_new_obj();
    scr_dyn_obj_set(*opts, "signal", 6, scr_dyn_retain(signal));
  }
  op_chan_defer(c);
  return c;
}

/* Duplex.from(fn) for an async generator function: the compiled stage
 * (borrowed) takes the source generator and answers its own; source
 * (borrowed) makes the source generator from next() and ack(); the
 * compiler's helpers over the stage's generator are borrowed. With a
 * signal, the stage also takes { signal }. +1, or NULL with the
 * function's throw pending. */
static ScrStream *op_duplex_from_gen(ScrClosure *stage, ScrClosure *source, ScrClosure *next,
                                     ScrClosure *read, ScrClosure *ret, ScrClosure *thr,
                                     ScrClosure *abort, ScrDyn *signal) {
  ScrDyn *opts;
  OpChan *c = op_chan_new(abort, signal, &opts);
  ScrGen *src = ((OpSourceFn)source->fn)(source, op_chan_closure((void *)&op_chan_next_inv, c),
                                         op_chan_closure((void *)&op_chan_ack_inv, c));
  ScrGen *g = NULL; /* src and opts move in */
  if (scr_exc_pending()) {
    if (opts) scr_dyn_release(opts);
  } else {
    g = opts ? ((OpStageOptsFn)stage->fn)(stage, src, opts) : ((OpStageFn)stage->fn)(stage, src);
  }
  if (scr_exc_pending()) {
    if (g) scr_gen_release(g);
    op_unref(c);
    return NULL;
  }
  OpFrom *f = op_alloc(sizeof *f);
  f->base.rc = 1;
  f->base.drop = &op_from_drop;
  f->kind = FROM_ASYNC;
  f->gen = g;
  f->next = scr_closure_retain(next);
  f->read = scr_closure_retain(read);
  f->ret = scr_closure_retain(ret);
  f->thr = scr_closure_retain(thr);
  ScrClosure *destroy = scr_closure_new((void *)&op_dup_destroy_inv, 2);
  destroy->caps[0] = scr_box_new_obj(&op_ref, &op_unref, NULL);
  scr_box_set_ref(destroy->caps[0], op_ref(c));
  destroy->caps[1] = scr_box_new_obj(&scr_closure_retain_v, &scr_closure_release_v, &scr_closure_trace_v);
  scr_box_set_ref(destroy->caps[1], op_from_closure((void *)&op_from_destroy_inv, f));
  /* Duplexify({ objectMode: true, highWaterMark: 1, write, final, destroy }) */
  ScrStream *d = scr_stream_new_duplex(1, 1, true, true, true, true, true,
                                       op_from_closure((void *)&op_from_read_inv, f), &op_from_read_inv,
                                       op_chan_closure((void *)&op_chan_write_inv, c), &op_chan_write_inv,
                                       op_chan_closure((void *)&op_chan_final_inv, c), &op_chan_final_inv,
                                       destroy, &op_dup_destroy_inv);
  scr_stream_set_object_mode(d, true, true);
  d->cls = "Duplexify";
  f->out = d;
  op_unref(f);
  c->d = scr_stream_retain(d);
  c->live_next = op_chan_live;
  if (op_chan_live) op_chan_live->live_prev = c;
  op_chan_live = c; /* the reference c was created with */
  return d;
}

ScrStream *scr_stream_duplex_from_gen(ScrClosure *stage, ScrClosure *source, ScrClosure *next,
                                      ScrClosure *read, ScrClosure *ret, ScrClosure *thr) {
  return op_duplex_from_gen(stage, source, next, read, ret, thr, NULL, NULL);
}

ScrStream *scr_stream_duplex_from_gen_signal(ScrClosure *stage, ScrClosure *source, ScrClosure *next,
                                             ScrClosure *read, ScrClosure *ret, ScrClosure *thr,
                                             ScrClosure *abort, ScrDyn *signal) {
  return op_duplex_from_gen(stage, source, next, read, ret, thr, abort, signal);
}

/* ── Duplex.from(asyncFunction) ── duplexify.js: the function's promise
 * must settle to a nullish value (else ERR_INVALID_RETURN_VALUE when the
 * final awaits it), a return before the input was consumed destroys the
 * Duplex, a rejection destroys it with the reason, and the Duplexify is
 * writable only, its final waiting for the promise. */

typedef ScrPromise *(*OpAsyncStageFn)(ScrClosure *, ScrGen *);
typedef ScrPromise *(*OpAsyncStageOptsFn)(ScrClosure *, ScrGen *, ScrDyn *);
typedef ScrDyn *(*OpBoxFn)(ScrClosure *, ScrPromise *);

typedef struct {
  OpChan *c;     /* +1 */
  ScrDyn *boxed; /* +1, the function's promise boxed */
} OpAsyncBody;

static void op_async_body_entry(ScrFiber *fiber, void *arg) {
  (void)fiber;
  OpAsyncBody b = *(OpAsyncBody *)arg;
  free(arg);
  OpChan *c = b.c;
  ScrDyn *v = scr_await_ref(b.boxed->v.promise); /* NULL: undefined */
  ScrStream *d = c->d ? scr_stream_retain(c->d) : NULL;
  if (!scr_exc_pending()) {
    if (v && v->kind != SCR_DYN_NULL && v->kind != SCR_DYN_UNDEF) {
      /* the then() callback throws: awaiting its result rejects */
      char detail[160];
      const char *got = scr_dyn_specific_type(v, detail, sizeof detail);
      char msg[320];
      int n = snprintf(msg, sizeof msg,
                       "Expected nully to be returned from the \"body\" function but got %s.", got);
      c->body_err = op_coded_error(SCR_ERR_TYPE, "ERR_INVALID_RETURN_VALUE", msg);
      (void)n;
    } else if (!c->finalized && d) {
      /* returned without consuming the input: destroyer(d) */
      ScrError *e = op_chan_abort_error();
      scr_stream_release(scr_stream_destroy(d, e));
      scr_error_release(e);
    }
    if (v) scr_dyn_release(v);
  } else {
    ScrCaught *caught = scr_exc_take();
    ScrError *err = op_caught_error(caught);
    scr_caught_release(caught);
    if (d) scr_stream_release(scr_stream_destroy(d, err));
    scr_error_release(err);
  }
  if (scr_exc_pending()) scr_exc_clear();
  if (d) scr_stream_release(d);
  c->body_settled = true;
  if (c->final_waiting) {
    c->final_waiting = false;
    op_chan_final_async_wait(c);
  }
  op_unref(c);
  scr_dyn_release(b.boxed);
}

/* Duplexify's final(cb) for an async function body: finalized, then
 * fromAsyncGen's final with the awaiting callback */
static void op_chan_final_async_inv(ScrClosure *cb, ScrStream *s) {
  (void)s;
  OpChan *c = op_chan_of(cb);
  c->finalized = true;
  op_chan_settle(c, scr_stream_from_done(), CHAN_FINAL_ASYNC);
  op_unref(c);
}

/* fromAsyncGen's destroy alone (no from() iterator to close) */
static void op_chan_destroy_inv(ScrClosure *cb, ScrStream *s, ScrError *err) {
  OpChan *c = op_chan_of(cb);
  op_chan_abort(c, err);
  if (c->resolve) op_chan_settle(c, scr_stream_from_done(), CHAN_ABORT);
  op_chan_retire(c);
  op_unref(c);
  scr_stream_destroy_done(s, err ? scr_error_retain(err) : NULL);
}

/* Duplex.from(fn) for an async function: the compiled stage (borrowed)
 * takes the source generator (and, with a signal, { signal }) and answers
 * its promise; source and box (promise → dyn promise) borrowed. +1, or
 * NULL with the function's throw pending. */
static ScrStream *op_duplex_from_async_fn(ScrClosure *stage, ScrClosure *source, ScrClosure *box,
                                          ScrClosure *abort, ScrDyn *signal) {
  ScrDyn *opts;
  OpChan *c = op_chan_new(abort, signal, &opts);
  ScrGen *src = ((OpSourceFn)source->fn)(source, op_chan_closure((void *)&op_chan_next_inv, c),
                                         op_chan_closure((void *)&op_chan_ack_inv, c));
  ScrPromise *p = NULL; /* src and opts move in */
  if (scr_exc_pending()) {
    if (opts) scr_dyn_release(opts);
  } else {
    p = opts ? ((OpAsyncStageOptsFn)stage->fn)(stage, src, opts)
             : ((OpAsyncStageFn)stage->fn)(stage, src);
  }
  if (scr_exc_pending()) {
    if (p) scr_promise_release(p);
    op_unref(c);
    return NULL;
  }
  /* Duplexify({ objectMode: true, readable: false, write, final, destroy }) */
  ScrStream *d = scr_stream_new_duplex(16, 16, true, true, true, false, true, NULL, NULL,
                                       op_chan_closure((void *)&op_chan_write_inv, c), &op_chan_write_inv,
                                       op_chan_closure((void *)&op_chan_final_async_inv, c),
                                       &op_chan_final_async_inv,
                                       op_chan_closure((void *)&op_chan_destroy_inv, c), &op_chan_destroy_inv);
  scr_stream_set_object_mode(d, true, true);
  d->cls = "Duplexify";
  c->d = scr_stream_retain(d);
  c->live_next = op_chan_live;
  if (op_chan_live) op_chan_live->live_prev = c;
  op_chan_live = c; /* the reference c was created with */
  /* value.then(onFulfilled, onRejected) */
  OpAsyncBody *b = malloc(sizeof *b);
  if (!b) op_oom();
  b->c = op_ref(c);
  b->boxed = ((OpBoxFn)box->fn)(box, p); /* p moves */
  scr_promise_release(scr_async_spawn_after(b->boxed->v.promise, &op_async_body_entry, b));
  return d;
}

ScrStream *scr_stream_duplex_from_async_fn(ScrClosure *stage, ScrClosure *source, ScrClosure *box) {
  return op_duplex_from_async_fn(stage, source, box, NULL, NULL);
}

ScrStream *scr_stream_duplex_from_async_fn_signal(ScrClosure *stage, ScrClosure *source,
                                                  ScrClosure *box, ScrClosure *abort,
                                                  ScrDyn *signal) {
  return op_duplex_from_async_fn(stage, source, box, abort, signal);
}

/* ── the promise operators ─────────────────────────────────────────── */

enum { PK_DYN, PK_F64, PK_BOOL, PK_STR, PK_VOID };

/* An async operator function: its promise and the loop state. */
typedef struct {
  OpObj base;
  ScrPromise *p;
  OpSrc src;
  ScrDyn *fn;     /* +1 or NULL */
  ScrDyn *signal; /* +1 or NULL */
  ScrDyn *acc;    /* toArray's array / reduce's accumulator (+1) */
  ScrClosure *ctl; /* +1: reduce's ac.abort(), run when it ends, or NULL */
  ScrDyn *cb_opts; /* +1: the { signal } the reducer takes as its third argument, or NULL */
  int op;
  int kind;       /* the promise payload (PK_*) */
  bool has_init, got_any, negate;
} OpFn;

enum { FN_TO_ARRAY, FN_REDUCE, FN_SOME, FN_FIND, FN_EVERY, FN_FOR_EACH };

static void op_fn_drop(OpObj *o) {
  OpFn *a = (OpFn *)o;
  scr_promise_release(a->p);
  src_release(&a->src);
  if (a->fn) scr_dyn_release(a->fn);
  if (a->signal) scr_dyn_release(a->signal);
  if (a->acc) scr_dyn_release(a->acc);
  if (a->ctl) scr_closure_release(a->ctl);
  if (a->cb_opts) scr_dyn_release(a->cb_opts);
  free(a);
}

/* reduce's `finally { ac.abort(); }`, before its promise settles. */
static void op_fn_abort_ctl(OpFn *a) {
  if (!a->ctl) return;
  ScrClosure *ctl = a->ctl;
  a->ctl = NULL;
  ((void (*)(ScrClosure *))ctl->fn)(ctl);
  if (scr_exc_pending()) scr_exc_clear();
  scr_closure_release(ctl);
}

static OpFn *op_fn_new(int op, int kind) {
  OpFn *a = op_alloc(sizeof *a);
  a->base.rc = 1;
  a->base.drop = &op_fn_drop;
  a->p = scr_promise_new();
  a->op = op;
  a->kind = kind;
  return a;
}

/* Settles the operator's promise with v converted to its payload kind (a
 * value of the wrong kind rejects with the checked conversion's error). */
static void op_fn_resolve(OpFn *a, ScrDyn *v /*borrowed*/) {
  op_fn_abort_ctl(a);
  switch (a->kind) {
  case PK_VOID:
    scr_promise_fulfill_void(a->p);
    return;
  case PK_BOOL:
    scr_promise_fulfill_bool(a->p, scr_dyn_truthy(v));
    return;
  case PK_F64:
    if (v->kind != SCR_DYN_NUM) break;
    scr_promise_fulfill_f64(a->p, v->v.num);
    return;
  case PK_STR:
    if (v->kind != SCR_DYN_STR) break;
    scr_promise_fulfill_str(a->p, scr_str_retain(v->v.str));
    return;
  default:
    op_fulfill(a->p, v);
    return;
  }
  static const char m[] = "reduce result does not match its declared type";
  scr_throw_error_msg(SCR_ERR_TYPE, m, sizeof m - 1);
  scr_promise_reject_pending(a->p);
}

static void op_fn_reject(OpFn *a, const ScrCaught *c) {
  op_fn_abort_ctl(a);
  op_reject(a->p, c);
}

static void op_fn_next(OpFn *a);

/* After the loop's AsyncIteratorClose: the throw that left the loop, or
 * the early return's result. */
typedef struct {
  OpObj base;
  OpFn *a;
  ScrCaught *thrown; /* +1 or NULL */
  ScrDyn *result;    /* +1 or NULL */
} OpFnClose;

static void op_fn_close_drop(OpObj *o) {
  OpFnClose *c = (OpFnClose *)o;
  op_unref(c->a);
  if (c->thrown) scr_caught_release(c->thrown);
  if (c->result) scr_dyn_release(c->result);
  free(c);
}

static void op_fn_finish(OpFn *a, ScrDyn *result);

static void op_fn_close_k(void *self, ScrDyn *v) {
  OpFnClose *c = self;
  if (v) {
    scr_dyn_release(v);
  } else if (!c->thrown) {
    ScrCaught *err = scr_exc_take();
    op_fn_reject(c->a, err);
    scr_caught_release(err);
    return;
  } else {
    scr_exc_clear();
  }
  if (c->thrown) op_fn_reject(c->a, c->thrown);
  else op_fn_finish(c->a, c->result);
}

static void op_fn_close(OpFn *a, ScrCaught *thrown /*moves*/, ScrDyn *result /*moves*/) {
  OpFnClose *c = op_alloc(sizeof *c);
  c->base.rc = 1;
  c->base.drop = &op_fn_close_drop;
  c->a = op_ref(a);
  c->thrown = thrown;
  c->result = result;
  ScrPromise *p = src_return(&a->src);
  op_await(p, &op_fn_close_k, c);
  scr_promise_release(p);
  op_unref(c);
}

/* every: `!(await some(...))` — one more job after some's result. */
static void op_every_k(void *self, ScrDyn *v) {
  OpFn *a = self;
  if (!v) {
    scr_promise_reject_pending(a->p);
    return;
  }
  scr_promise_fulfill_bool(a->p, !scr_dyn_truthy(v));
  scr_dyn_release(v);
}

static void op_fn_finish(OpFn *a, ScrDyn *result) {
  op_fn_resolve(a, result ? result : scr_dyn_undefined());
}

static void op_reduce_value_k(void *self, ScrDyn *v) {
  OpFn *a = self;
  if (!v) {
    /* the rejection leaves the for await: AsyncIteratorClose */
    op_fn_close(a, scr_exc_take(), NULL);
    return;
  }
  scr_dyn_release(a->acc);
  a->acc = v;
  op_fn_next(a);
}

static void op_fn_val_k(void *self, ScrDyn *v) {
  OpFn *a = self;
  if (!v) {
    ScrCaught *c = scr_exc_take();
    op_fn_reject(a, c);
    scr_caught_release(c);
    return;
  }
  if (src_done(&a->src, v)) {
    scr_dyn_release(v);
    switch (a->op) {
    case FN_TO_ARRAY:
    case FN_REDUCE:
      if (a->op == FN_REDUCE && !a->got_any && !a->has_init) {
        ScrError *e = op_coded_error(SCR_ERR_TYPE, "ERR_MISSING_ARGS",
                                     "Reduce of an empty stream requires an initial value");
        ScrCaught *c = op_take_error(e);
        op_fn_reject(a, c);
        scr_caught_release(c);
        return;
      }
      op_fn_finish(a, a->acc);
      return;
    case FN_SOME:
    case FN_EVERY: {
      ScrDyn *f = scr_dyn_new_bool(false);
      op_fn_finish(a, f);
      scr_dyn_release(f);
      return;
    }
    default:
      op_fn_finish(a, NULL);
      return;
    }
  }
  switch (a->op) {
  case FN_TO_ARRAY:
    if (op_aborted(a->signal)) {
      ScrDyn *reason = op_get(a->signal, "reason");
      ScrError *e = op_abort_error(reason ? reason : scr_dyn_undefined());
      if (reason) scr_dyn_release(reason);
      scr_dyn_release(v);
      op_fn_close(a, op_take_error(e), NULL);
      return;
    }
    scr_dyn_arr_push(a->acc, v); /* moves v */
    op_fn_next(a);
    return;
  case FN_REDUCE: {
    a->got_any = true;
    if (op_aborted(a->signal)) {
      scr_dyn_release(v);
      op_fn_close(a, op_take_error(op_abort_error(NULL)), NULL);
      return;
    }
    if (!a->has_init) {
      scr_dyn_release(a->acc);
      a->acc = v;
      a->has_init = true;
      op_fn_next(a);
      return;
    }
    ScrDyn *args[3] = {a->acc, v, a->cb_opts};
    ScrDyn *r = scr_dyn_call(a->fn, args, a->cb_opts ? 3 : 2, "reducer");
    scr_dyn_release(v);
    if (!r) {
      op_fn_close(a, scr_exc_take(), NULL);
      return;
    }
    op_await_value(r, &op_reduce_value_k, a);
    scr_dyn_release(r);
    return;
  }
  case FN_SOME:
  case FN_EVERY: {
    scr_dyn_release(v);
    op_fn_close(a, NULL, scr_dyn_new_bool(true));
    return;
  }
  case FN_FIND:
    op_fn_close(a, NULL, v);
    return;
  default: /* forEach never receives a value */
    scr_dyn_release(v);
    op_fn_next(a);
    return;
  }
}

static void op_fn_next(OpFn *a) {
  ScrPromise *p = src_next(&a->src);
  op_await(p, &op_fn_val_k, a);
  scr_promise_release(p);
}

/* ── validation and entry points ───────────────────────────────────── */

/* map()'s option reading: concurrency, highWaterMark (MathFloor, then
 * validateInteger). False with the error pending. */
static bool op_map_options(const ScrDyn *options, double *concurrency, double *hwm) {
  *concurrency = 1;
  ScrDyn *c = op_get(options, "concurrency");
  if (!op_nullish(c)) {
    double n = scr_dyn_number_coerce(c);
    if (scr_exc_pending()) {
      scr_dyn_release(c);
      return false;
    }
    *concurrency = floor(n);
  }
  if (c) scr_dyn_release(c);
  *hwm = *concurrency - 1;
  ScrDyn *h = op_get(options, "highWaterMark");
  if (!op_nullish(h)) {
    double n = scr_dyn_number_coerce(h);
    if (scr_exc_pending()) {
      scr_dyn_release(h);
      return false;
    }
    *hwm = floor(n);
  }
  if (h) scr_dyn_release(h);
  const double max = 9007199254740991.0;
  if (!isfinite(*concurrency) || floor(*concurrency) != *concurrency) {
    op_throw_out_of_range("options.concurrency", "an integer", *concurrency);
    return false;
  }
  if (*concurrency < 1 || *concurrency > max) {
    op_throw_out_of_range("options.concurrency", ">= 1 && <= 9007199254740991", *concurrency);
    return false;
  }
  if (!isfinite(*hwm) || floor(*hwm) != *hwm) {
    op_throw_out_of_range("options.highWaterMark", "an integer", *hwm);
    return false;
  }
  if (*hwm < 0 || *hwm > max) {
    op_throw_out_of_range("options.highWaterMark", ">= 0 && <= 9007199254740991", *hwm);
    return false;
  }
  *hwm += *concurrency;
  return true;
}

/* map(fn, options) with fn already checked: +1 generator, or NULL with
 * the error pending. */
static OpMap *op_map_make(ScrStream *s, ScrDyn *fn, ScrDyn *options, int mode, ScrDyn *cb_opts) {
  op_sentinels_init();
  if (!op_check_options(options)) return NULL;
  bool ok;
  ScrDyn *signal = op_signal(options, &ok);
  if (!ok) return NULL;
  double concurrency, hwm;
  if (!op_map_options(options, &concurrency, &hwm)) {
    if (signal) scr_dyn_release(signal);
    return NULL;
  }
  OpMap *m = map_new(s, fn, mode, concurrency, hwm, signal, cb_opts);
  if (signal) scr_dyn_release(signal);
  return m;
}

ScrStream *scr_stream_op_map(ScrStream *s, ScrDyn *fn, ScrDyn *options, ScrDyn *cb_opts) {
  if (!op_check_fn(fn, "fn", 1)) return NULL;
  OpMap *m = op_map_make(s, fn, options, MODE_MAP, cb_opts);
  return m ? op_from_gen(&m->g) : NULL;
}

ScrStream *scr_stream_op_filter(ScrStream *s, ScrDyn *fn, ScrDyn *options, ScrDyn *cb_opts) {
  if (!op_check_fn(fn, "fn", 1)) return NULL;
  OpMap *m = op_map_make(s, fn, options, MODE_FILTER, cb_opts);
  return m ? op_from_gen(&m->g) : NULL;
}

static ScrStream *op_flat_map(ScrStream *s, ScrDyn *fn, ScrDyn *options, ScrDyn *cb_opts,
                              ScrClosure *next, ScrClosure *read, ScrClosure *ret,
                              ScrClosure *thr, bool async_gen) {
  if (!op_check_fn(fn, "fn", 1)) return NULL;
  OpMap *m = op_map_make(s, fn, options, MODE_MAP, cb_opts);
  if (!m) return NULL;
  OpFlat *f = op_alloc(sizeof *f);
  gen_init(&f->g, &op_flat_body_drop);
  f->g.resume = &flat_resume;
  f->g.ret = &flat_ret;
  f->g.thr = &flat_thr;
  f->values.g = &m->g; /* moves */
  if (next) {
    f->gnext = scr_closure_retain(next);
    f->gread = read ? scr_closure_retain(read) : NULL;
    f->gret = scr_closure_retain(ret);
    f->gthr = scr_closure_retain(thr);
    f->gen_async = async_gen;
  }
  return op_from_gen(&f->g);
}

ScrStream *scr_stream_op_flat_map(ScrStream *s, ScrDyn *fn, ScrDyn *options, ScrDyn *cb_opts) {
  return op_flat_map(s, fn, options, cb_opts, NULL, NULL, NULL, NULL, false);
}

/* flatMap whose callback returns a compiled generator: the helpers over
 * its type (borrowed) step the generators it yields from. */
ScrStream *scr_stream_op_flat_map_async_gen(ScrStream *s, ScrDyn *fn, ScrDyn *options,
                                            ScrDyn *cb_opts, ScrClosure *next, ScrClosure *read,
                                            ScrClosure *ret, ScrClosure *thr) {
  return op_flat_map(s, fn, options, cb_opts, next, read, ret, thr, true);
}

ScrStream *scr_stream_op_flat_map_sync_gen(ScrStream *s, ScrDyn *fn, ScrDyn *options,
                                           ScrDyn *cb_opts, ScrClosure *next, ScrClosure *ret,
                                           ScrClosure *thr) {
  return op_flat_map(s, fn, options, cb_opts, next, NULL, ret, thr, false);
}

/* drop(number, options) / take(number, options) */
static ScrStream *op_slice(ScrStream *s, ScrDyn *number, ScrDyn *options, bool take) {
  op_sentinels_init();
  if (!op_check_options(options)) return NULL;
  bool ok;
  ScrDyn *signal = op_signal(options, &ok);
  if (!ok) return NULL;
  /* toIntegerOrInfinity: Number(number), NaN → 0, negative → out of range */
  double n = scr_dyn_number_constructor(number ? number : scr_dyn_undefined());
  if (scr_exc_pending()) {
    if (signal) scr_dyn_release(signal);
    return NULL;
  }
  if (isnan(n)) n = 0;
  if (n < 0) {
    op_throw_out_of_range("number", ">= 0", n);
    if (signal) scr_dyn_release(signal);
    return NULL;
  }
  OpSlice *t = op_alloc(sizeof *t);
  gen_init(&t->g, &op_slice_body_drop);
  t->g.resume = &slice_resume;
  t->g.ret = &slice_ret;
  t->g.thr = &slice_thr;
  t->src.s = scr_stream_retain(s);
  t->signal = signal;
  t->number = n;
  t->take = take;
  return op_from_gen(&t->g);
}

ScrStream *scr_stream_op_drop(ScrStream *s, ScrDyn *number, ScrDyn *options) {
  return op_slice(s, number, options, false);
}

ScrStream *scr_stream_op_take(ScrStream *s, ScrDyn *number, ScrDyn *options) {
  return op_slice(s, number, options, true);
}

/* An async operator whose synchronous prefix threw: the promise rejects. */
static ScrPromise *op_fn_reject_now(OpFn *a) {
  scr_promise_reject_pending(a->p);
  ScrPromise *p = scr_promise_retain(a->p);
  op_unref(a);
  return p;
}

static ScrPromise *op_fn_start(OpFn *a) {
  ScrPromise *p = scr_promise_retain(a->p);
  op_fn_next(a);
  op_unref(a);
  return p;
}

ScrPromise *scr_stream_op_to_array(ScrStream *s, ScrDyn *options) {
  op_sentinels_init();
  OpFn *a = op_fn_new(FN_TO_ARRAY, PK_DYN);
  if (!op_check_options(options)) return op_fn_reject_now(a);
  bool ok;
  a->signal = op_signal(options, &ok);
  if (!ok) return op_fn_reject_now(a);
  a->acc = scr_dyn_new_arr();
  a->src.s = scr_stream_retain(s);
  return op_fn_start(a);
}

/* reduce's pre-aborted path: destroy with the AbortError, wait for the
 * stream to finish, then reject with that error. */
static void op_reduce_aborted_k(void *self, ScrDyn *v) {
  OpFn *a = self;
  if (v) scr_dyn_release(v);
  else scr_exc_clear();
  ScrError *e = scr_stream_errored(a->src.s);
  if (!e) e = op_abort_error(NULL);
  ScrCaught *c = op_take_error(e);
  op_fn_reject(a, c);
  scr_caught_release(c);
}

static void op_noop_listener(ScrClosure *cb, void *err) {
  (void)cb;
  (void)err;
}

static ScrPromise *op_reduce(ScrStream *s, ScrDyn *fn, ScrDyn *init, bool has_init,
                             ScrDyn *options, double kind, ScrClosure *ctl, ScrDyn *cb_opts) {
  op_sentinels_init();
  OpFn *a = op_fn_new(FN_REDUCE, (int)kind);
  if (!op_check_fn(fn, "reducer", 2)) return op_fn_reject_now(a);
  if (!op_check_options(options)) return op_fn_reject_now(a);
  bool ok;
  a->signal = op_signal(options, &ok);
  if (!ok) return op_fn_reject_now(a);
  a->fn = scr_dyn_retain(fn);
  a->has_init = has_init;
  a->acc = scr_dyn_retain(init && has_init ? init : scr_dyn_undefined());
  a->src.s = scr_stream_retain(s);
  if (op_aborted(a->signal)) {
    ScrDyn *reason = op_get(a->signal, "reason");
    ScrError *e = op_abort_error(reason ? reason : scr_dyn_undefined());
    if (reason) scr_dyn_release(reason);
    /* (thrown before the controller exists) */
    /* this.once('error', () => {}) */
    ScrStr *name = scr_str_new("error", 5);
    scr_emitter_release(scr_emitter_on((ScrEmitter *)s, name,
                                       scr_closure_new((void *)&op_noop_listener, 0),
                                       scr_ee_inv_fixed1, true, false));
    scr_str_release(name);
    scr_stream_release(scr_stream_destroy(s, e));
    scr_error_release(e);
    ScrPromise *fin = scr_sp_finished(s);
    ScrPromise *p = scr_promise_retain(a->p);
    op_await(fin, &op_reduce_aborted_k, a);
    scr_promise_release(fin);
    op_unref(a);
    return p;
  }
  /* const ac = new AbortController() (options.signal's listener that
   * aborts it too is registered by the caller) */
  if (ctl) {
    a->ctl = scr_closure_retain(ctl);
    a->cb_opts = cb_opts && cb_opts->kind != SCR_DYN_UNDEF ? scr_dyn_retain(cb_opts) : NULL;
  }
  return op_fn_start(a);
}

ScrPromise *scr_stream_op_reduce(ScrStream *s, ScrDyn *fn, ScrDyn *init, bool has_init,
                                 ScrDyn *options, double kind) {
  return op_reduce(s, fn, init, has_init, options, kind, NULL, NULL);
}

/* reduce with a reducer that reads its { signal }: abort is ac.abort()
 * (borrowed), cb_opts `{ signal: ac.signal }`. */
ScrPromise *scr_stream_op_reduce_signal(ScrStream *s, ScrDyn *fn, ScrDyn *init, bool has_init,
                                        ScrDyn *options, double kind, ScrClosure *abort,
                                        ScrDyn *cb_opts) {
  return op_reduce(s, fn, init, has_init, options, kind, abort, cb_opts);
}

/* `options?.signal`: +1, undefined when absent. */
ScrDyn *scr_stream_op_signal_of(ScrDyn *options) {
  if (!options || options->kind == SCR_DYN_UNDEF || options->kind == SCR_DYN_NULL)
    return scr_dyn_retain(scr_dyn_undefined());
  ScrDyn *sig = op_get(options, "signal");
  if (scr_exc_pending()) scr_exc_clear();
  return sig ? sig : scr_dyn_retain(scr_dyn_undefined());
}

/* `{ once: true }`: +1. */
ScrDyn *scr_stream_op_once_options(void) {
  ScrDyn *o = scr_dyn_new_obj();
  scr_dyn_obj_set(o, "once", 4, scr_dyn_new_bool(true));
  return o;
}

/* `[options?.signal].filter(Boolean)` for AbortSignal.any: +1 array. */
ScrDyn *scr_stream_op_signal_list(ScrDyn *options) {
  ScrDyn *list = scr_dyn_new_arr();
  if (options && options->kind != SCR_DYN_UNDEF && options->kind != SCR_DYN_NULL) {
    /* A signal that fails validateAbortSignal is left out: the operator
     * itself throws Node's ERR_INVALID_ARG_TYPE for it. */
    bool ok;
    ScrDyn *sig = op_signal(options, &ok);
    if (sig) scr_dyn_arr_push(list, sig); /* moves */
    if (scr_exc_pending()) scr_exc_clear();
  }
  return list;
}

/* `{ signal }`, the callbacks' second argument: +1 object (borrows signal). */
ScrDyn *scr_stream_op_signal_opts(ScrDyn *signal) {
  ScrDyn *o = scr_dyn_new_obj();
  scr_dyn_obj_set(o, "signal", 6, scr_dyn_retain(signal));
  return o;
}

/* some/find/every/forEach: the loop over map's generator (filter's for
 * some, find and every). */
static ScrPromise *op_gen_fn(ScrStream *s, ScrDyn *fn, ScrDyn *options, int op, int mode, int kind,
                             ScrDyn *cb_opts) {
  op_sentinels_init();
  OpFn *a = op_fn_new(op, kind);
  if (!op_check_fn(fn, "fn", 1)) return op_fn_reject_now(a);
  OpMap *m = op_map_make(s, fn, options, mode, cb_opts);
  if (!m) return op_fn_reject_now(a);
  a->src.g = &m->g; /* moves */
  return op_fn_start(a);
}

ScrPromise *scr_stream_op_some(ScrStream *s, ScrDyn *fn, ScrDyn *options, ScrDyn *cb_opts) {
  return op_gen_fn(s, fn, options, FN_SOME, MODE_FILTER, PK_BOOL, cb_opts);
}

ScrPromise *scr_stream_op_find(ScrStream *s, ScrDyn *fn, ScrDyn *options, ScrDyn *cb_opts) {
  return op_gen_fn(s, fn, options, FN_FIND, MODE_FILTER, PK_DYN, cb_opts);
}

ScrPromise *scr_stream_op_for_each(ScrStream *s, ScrDyn *fn, ScrDyn *options, ScrDyn *cb_opts) {
  return op_gen_fn(s, fn, options, FN_FOR_EACH, MODE_FOREACH, PK_VOID, cb_opts);
}

/* every(fn, options) = !(await some.call(this, async (...args) =>
 * !(await fn(...args)), options)) */
ScrPromise *scr_stream_op_every(ScrStream *s, ScrDyn *fn, ScrDyn *options, ScrDyn *cb_opts) {
  op_sentinels_init();
  OpFn *outer = op_fn_new(FN_EVERY, PK_BOOL);
  if (!op_check_fn(fn, "fn", 1)) return op_fn_reject_now(outer);
  ScrPromise *some = op_gen_fn(s, fn, options, FN_EVERY, MODE_EVERY, PK_DYN, cb_opts);
  ScrPromise *p = scr_promise_retain(outer->p);
  op_await(some, &op_every_k, outer);
  scr_promise_release(some);
  op_unref(outer);
  return p;
}
