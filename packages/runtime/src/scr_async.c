/* Async runtime: stackful fibers, promises, and a dependency-free event
 * loop (microtask queue + timer min-heap).
 *
 * Model (see docs/ir.md):
 * - An async function's body is ordinary compiled C, run on its own fiber
 *   (heap-allocated ucontext stack). Calling it runs the body EAGERLY until
 *   the first suspension (JS's synchronous-prefix rule), then control
 *   returns to the spawner with a +1 promise.
 * - `await` on a pending promise parks the fiber on the promise's waiter
 *   list and switches back to whoever resumed it. Fulfillment moves waiters
 *   to the microtask queue (microtasks run before timers, like Node).
 * - Each fiber carries its own exception cell (scr_exc_swap_cell) so a
 *   pending exception can't leak across concurrent execution contexts. A
 *   throw escaping an async body rejects its promise; awaiting a rejected
 *   promise re-throws into the awaiter.
 * - Loop exhaustion with still-suspended fibers exits normally (Node's
 *   behavior); those stacks are deliberately not unwound, and the RC audit
 *   downgrades to a note in that case.
 */
#define _XOPEN_SOURCE 700
#include "scr_runtime.h"

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#ifdef _WIN32
/* Windows arm: fibers come from the Win32 Fibers API (CreateFiber /
 * SwitchToFiber — the direct ucontext analog: cooperatively scheduled,
 * same thread, own stack); the idle sleep is nanosleep (mingw-w64 ships
 * it, over Sleep). poll(2) has no Windows arm — see the sleep seam in
 * scr_loop_run: the poller-backed units (net/dgram/watch) are not built
 * for win32 targets (native-toolchain.ts gates them), so their fds never appear; the
 * events unit DOES cross-compile (scr_events.c's win32 arm) and is
 * served by a capped nanosleep — dispatch at the next turn's top, the
 * cap bounding signal/stdin latency instead of a pollable wake fd. */
#include <windows.h>
#elif defined(__wasi__)
#include <poll.h>
#else
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <ucontext.h>
#include <unistd.h>
#endif

#ifdef __wasi__
/* WASI Preview 1 has no process-spawn capability. The child unit is not
 * linked for this target, but the generic loop keeps its quiescence hooks;
 * their empty implementation makes the absence explicit at link time
 * without weakening async/timer support. */
bool scr_children_pending(void) { return false; }
bool scr_children_reffed_pending(void) { return false; }
bool scr_children_failed_pending(void) { return false; }
void scr_children_poll(void) {}
int scr_children_wake_fd(void) { return -1; }
bool scr_children_wait(double max_wait_ms) {
  (void)max_wait_ms;
  return false;
}
void scr_children_teardown(void) {}
#endif

#if defined(__has_feature)
#if __has_feature(address_sanitizer)
#define SCR_ASAN_FIBERS 1
void __sanitizer_start_switch_fiber(void **fake_stack_save, const void *bottom, size_t size);
void __sanitizer_finish_switch_fiber(void *fake_stack_save, const void **bottom_old, size_t *size_old);
#endif
#endif

/* ASan inflates stack frames severalfold (unoptimized locals + redzones),
 * so the sanitized lane gets proportionally bigger fiber stacks — same
 * headroom DISCIPLINE, instrumented scale. Keep the island's stack budget
 * (scr_island.c) at half of whichever size is active. 8MB under ASan is
 * the measured need: an engine call costs 64–96KB there, and a real
 * embedded graph entered FROM A FIBER (a commander action awaiting
 * generateText — zod parses inside promise chains) nests dozens of engine
 * frames; the memory is malloc'd and committed lazily, so idle fibers pay
 * address space, not RSS. */
#ifdef SCR_ASAN_FIBERS
#define SCR_FIBER_STACK (8 * 1024 * 1024)
#else
#define SCR_FIBER_STACK (256 * 1024)
#endif

/* ── promises ─────────────────────────────────────────────────────────── */

enum { SCR_PROM_PENDING = 0, SCR_PROM_FULFILLED = 1, SCR_PROM_REJECTED = 2 };

typedef struct ScrFiber ScrFiber;

struct ScrPromise {
  size_t rc;
  int state;
  /* Payload (fulfillment value or rejection reason), ScrExcCell-style.
   * trace_fn is non-NULL iff the REF payload type carries a cycle header
   * (a promise settled with a cycle-capable value can be a cycle member —
   * e.g. a closure that captures a box holding this very promise). */
  ScrExcKind payload_kind; /* NONE = void fulfillment */
  double f64;
  bool b;
  void *payload;
  void *(*retain_fn)(void *);
  void (*release_fn)(void *);
  ScrTraceFn trace_fn;
  /* Fibers parked on this promise. */
  ScrFiber **waiters;
  size_t nwaiters, waiters_cap;
  /* Combinator callbacks (Promise.race / Promise.all): at settle,
   * fulfilled promises run adapt(dst, this) — an emitted adapter
   * converting the payload into the destination's inner type — and
   * rejections copy raw (reasons are dynamically tagged). Each entry owns
   * a reference on its dst. Promise.all entries carry the shared
   * countdown state (`all` non-NULL, `all_idx` the entry's INPUT index);
   * race entries leave both zeroed and keep the adapt dispatch. */
  struct ScrPromiseCbWaiter {
    void (*adapt)(ScrPromise *dst, ScrPromise *src);
    ScrPromise *dst;
    struct ScrAllState *all;
    size_t all_idx;
  } *cbs;
  size_t ncbs, cbs_cap;
  /* Unhandled-rejection tracking: set when rejected, cleared on await. */
  bool rejection_observed;
  /* Set when the checkpoint report delivered THIS promise to
   * 'unhandledRejection' listeners — a handler attached after that is
   * Node's 'rejectionHandled' moment (scr_prom_observe below). */
  bool reported_unhandled;
};

#ifdef SCR_RC_AUDIT
static long scr_live_promises = 0;
long scr_promise_live_count(void) { return scr_live_promises; }
#endif

/* ── Promise.all shared state ─────────────────────────────────────────
 * One per Promise.all call: the values array filled per INPUT index as
 * entries fulfill, the countdown of fulfillments still missing, and the
 * per-element-kind store helper. The state holds +1 on `values` (NULL for
 * void-element all) and is itself refcounted by the entries that still
 * point at it (parked cb waiters plus the builder while it subscribes);
 * the RESULT promise is NOT held here — each parked entry's cb.dst is the
 * retained result, so promise teardown paths need no all-specific
 * destination handling. */
typedef struct ScrAllState {
  size_t rc;
  size_t remaining;
  ScrArr *values;
  void (*store)(ScrArr *a, double i, ScrPromise *src);
} ScrAllState;

static void scr_promise_all_state_release(ScrAllState *st) {
  if (--st->rc == 0) {
    if (st->values) scr_arr_release(st->values);
    free(st);
  }
}

static void scr_oom(void) {
  fputs("scriptc: out of memory\n", stderr);
  abort();
}

static void scr_promise_trace(void *o, ScrTraceVisit visit, void *ctx) {
  ScrPromise *p = (ScrPromise *)o;
  /* Waiters are fibers (not refcounted objects) — the settled payload and
   * the combinator destinations are the strong references this promise
   * owns (destination promises are cycle-headered). */
  if ((p->payload_kind == SCR_EXC_REF || p->payload_kind == SCR_EXC_OBJ) &&
      p->trace_fn) {
    visit(p->payload, ctx);
  }
  for (size_t i = 0; i < p->ncbs; i++) visit(p->cbs[i].dst, ctx);
}

/* Teardown for the collector: release the payload only when the trace does
 * NOT visit it (the complement — see the contract in scr_runtime.h). The
 * cb destinations are always visited, so only the array frees here. */
static void scr_promise_gcfree(void *o) {
  ScrPromise *p = (ScrPromise *)o;
  if (p->payload_kind == SCR_EXC_STR) {
    scr_str_release((ScrStr *)p->payload);
  } else if ((p->payload_kind == SCR_EXC_REF || p->payload_kind == SCR_EXC_OBJ) &&
             p->payload && !p->trace_fn) {
    p->release_fn(p->payload);
  }
  /* Parked Promise.all states are NOT traced children (their values array
   * is reachable only through them) — release like the untraced payload
   * above; the cb destinations stay untouched (trace visits them). */
  for (size_t i = 0; i < p->ncbs; i++) {
    if (p->cbs[i].all) scr_promise_all_state_release(p->cbs[i].all);
  }
  free(p->waiters);
  free(p->cbs);
#ifdef SCR_RC_AUDIT
  scr_live_promises--;
#endif
  scr_cyc_free(p);
}

ScrPromise *scr_promise_new(void) {
  ScrPromise *p = scr_cyc_alloc(sizeof *p, &scr_promise_trace, &scr_promise_gcfree);
  p->rc = 1;
#ifdef SCR_RC_AUDIT
  scr_live_promises++;
#endif
  return p;
}

/* The 'rejectionHandled' hook (scr_async_dyn.c installs it at listener
 * registration — the scr_urj_deliver_fn pattern, so listener-free
 * binaries keep their size class): called when a promise the checkpoint
 * report already delivered as unhandled gains a handler. */
void (*scr_rjh_notify_fn)(ScrPromise *p) = NULL;

/* Every handler attach funnels here: mark the rejection observed, and
 * fire Node's 'rejectionHandled' when the attach arrived AFTER the
 * report delivered this promise to 'unhandledRejection' listeners (the
 * model's one late-handling window — earlier handling keeps the promise
 * out of the report entirely). The flag clears on the first attach, so
 * one report fires at most one 'rejectionHandled' — Node's pairing. */
static void scr_prom_observe(ScrPromise *p) {
  p->rejection_observed = true;
  if (p->reported_unhandled) {
    p->reported_unhandled = false;
    if (scr_rjh_notify_fn != NULL) scr_rjh_notify_fn(p);
  }
}

/* The attach-time handled mark (scr_async_dyn.c's dyn then/catch with a
 * rejection handler, plus the module loader's ownership of every module
 * evaluation promise): Node marks a promise handled at ATTACH, including
 * while it is still pending, not when a later reaction runs. The pending
 * mark is essential for a module dependency whose importer aborts while
 * evaluating a later sibling — the loader still owns that dependency's
 * eventual rejection, so it must never surface as an unrelated unhandled
 * rejection. */
void scr_promise_mark_handled(ScrPromise *p) {
  scr_prom_observe(p);
}

ScrPromise *scr_promise_retain(ScrPromise *p) {
  if (p && p->rc != SIZE_MAX) {
    p->rc++;
    scr_cyc_mark_live(p);
  }
  return p;
}

static void scr_promise_release_payload(ScrPromise *p) {
  if (p->payload_kind == SCR_EXC_STR) scr_str_release((ScrStr *)p->payload);
  else if ((p->payload_kind == SCR_EXC_REF || p->payload_kind == SCR_EXC_OBJ) &&
           p->payload) p->release_fn(p->payload);
  p->payload_kind = SCR_EXC_NONE;
  p->payload = NULL;
}

void scr_promise_release(ScrPromise *p) {
  if (!p || p->rc == SIZE_MAX) return;
  if (--p->rc == 0) {
    scr_cyc_on_dead(p);
    scr_promise_release_payload(p);
    free(p->waiters);
    for (size_t i = 0; i < p->ncbs; i++) {
      scr_promise_release(p->cbs[i].dst);
      if (p->cbs[i].all) scr_promise_all_state_release(p->cbs[i].all);
    }
    free(p->cbs);
#ifdef SCR_RC_AUDIT
    scr_live_promises--;
#endif
    scr_cyc_free(p);
  } else {
    scr_cyc_on_release(p); /* possible cycle root; may collect — p is done */
  }
}

void *scr_promise_retain_v(void *p) { return scr_promise_retain((ScrPromise *)p); }
void scr_promise_release_v(void *p) { scr_promise_release((ScrPromise *)p); }
void scr_promise_trace_v(void *p, ScrTraceVisit visit, void *ctx) {
  scr_promise_trace(p, visit, ctx);
}

/* ── fibers and the scheduler ─────────────────────────────────────────── */

/* One saved execution context. POSIX: a ucontext_t (swapcontext saves the
 * outgoing context INTO the `from` slot). Windows: the fiber HANDLE —
 * SwitchToFiber saves the outgoing state inside the fiber object itself,
 * so the slot only needs to name the destination; `from` is unused. */
#ifdef _WIN32
typedef void *ScrCtx;
#elif defined(__wasi__)
typedef unsigned char ScrCtx;
#else
typedef ucontext_t ScrCtx;
#endif

struct ScrFiber {
  ScrCtx ctx;
  /* wasm32 uses LLVM's stackless switched-coroutine frame instead of a
   * native saved stack. The compiler emits these two generic wrappers in
   * every WASI module. */
  void *coro;
  ScrCtx *return_to; /* whoever resumed us last (spawner or the loop) */
  char *stack;       /* POSIX only; Windows fibers own their stack (NULL) */
  ScrPromise *promise; /* the promise this fiber settles (owned +1); NULL
                        * for generator fibers (gen non-NULL instead) */
  ScrGen *gen;         /* the generator this fiber runs (borrowed — the
                        * ScrGen owns the fiber, never the reverse) */
  ScrExcCell exc;
  /* AsyncLocalStorage context (owned; NULL = empty). Inherited from the
   * SPAWNER at spawn (Node's init-time capture), swapped active with the
   * fiber (the exc-cell pattern) so run()'s window rides awaits. */
  ScrAlsCtx *als;
  bool done;
  /* Trampoline args: the spawn wrapper stores a pointer to a stack-local
   * argpack; the trampoline copies it out before the spawner resumes. */
  void *argpack;
  void (*entry)(ScrFiber *self, void *argpack);
  /* queueMicrotask entries: a stackless pseudo-fiber — the READY queue's
   * FIFO IS the microtask queue, so a closure rides it as a fiber-shaped
   * envelope and scr_resume_fiber runs it on the main stack (a throw is
   * an UNCAUGHT exception, like Node's queueMicrotask, never a
   * rejection). Owned; NULL on real fibers. */
  ScrClosure *micro_cb;
#ifdef SCR_ASAN_FIBERS
  void *fake_stack;
#endif
};

/* ── AsyncLocalStorage (node:async_hooks) ─────────────────────────────
 * Stores are process-lived ids; the CONTEXT is an immutable refcounted
 * snapshot of (store id → dyn value) entries. One ACTIVE SLOT pointer
 * (the exc-cell pattern): main owns a static slot, every fiber owns its
 * own field, scr_switch repoints the active slot — so run()'s window
 * rides the fiber across awaits, and a spawned fiber INHERITS the
 * spawner's snapshot (Node's init-time capture through AsyncResource).
 * Snapshots are immutable: enter builds a fresh one (entries retained),
 * restore swaps the previous back — timer capture retains pointers. */

/* The ScrAlsCtx layout and the API over it live in scr_runtime.h /
 * scr_async_dyn.c (gated — the size-class stance); this always-linked
 * core keeps only what the fiber machinery itself touches: the active
 * slot, the snapshot RC pair, and the switch/spawn/destroy wiring. */
static ScrAlsCtx *scr_als_main_slot = NULL;
ScrAlsCtx **scr_als_active = &scr_als_main_slot;

ScrAlsCtx *scr_als_ctx_retain(ScrAlsCtx *c) {
  if (c) c->rc++;
  return c;
}

void scr_als_ctx_release(ScrAlsCtx *c) {
  if (!c || --c->rc != 0) return;
  for (size_t i = 0; i < c->len; i++) scr_dyn_release(c->entries[i].value);
  free(c);
}



static ScrCtx scr_loop_ctx; /* the main stack (scheduler home) */
static ScrFiber *scr_current = NULL;
static long scr_fibers_live = 0;
static long scr_fibers_abandoned = 0;

long scr_abandoned_fiber_count(void) { return scr_fibers_abandoned; }

/* True while executing on an async fiber (vs the main stack). The island
 * sizes its engine stack budget per stack: fibers are small and fixed,
 * the main stack is the process's megabytes (scr_island.c isl_entry). */
bool scr_on_fiber(void) { return scr_current != NULL; }
void *scr_fiber_self(void) { return scr_current; }

#ifdef __wasi__
extern void scr_wasi_coro_resume(void *handle);
extern void scr_wasi_coro_destroy(void *handle);

void scr_wasi_coro_started(void *handle) {
  if (scr_current == NULL) {
    fputs("scriptc: internal error: coroutine started outside a fiber\n", stderr);
    abort();
  }
  scr_current->coro = handle;
}
#endif

/* Microtask queue: ready fibers, FIFO. */
static ScrFiber **scr_ready = NULL;
static size_t scr_ready_head = 0, scr_ready_len = 0, scr_ready_cap = 0;

static void scr_ready_push(ScrFiber *f) {
  if (scr_ready_head + scr_ready_len == scr_ready_cap) {
    memmove(scr_ready, scr_ready + scr_ready_head, scr_ready_len * sizeof *scr_ready);
    scr_ready_head = 0;
    if (scr_ready_len == scr_ready_cap) {
      scr_ready_cap = scr_ready_cap ? scr_ready_cap * 2 : 16;
      scr_ready = realloc(scr_ready, scr_ready_cap * sizeof *scr_ready);
      if (!scr_ready) scr_oom();
    }
  }
  scr_ready[scr_ready_head + scr_ready_len++] = f;
}

/* Timer min-heap, FIFO tiebreak via sequence numbers. `id` is nonzero only
 * for setInterval entries (the clearInterval handle; setTimeout has no
 * clear surface, so plain timeouts never need one) and `repeat_ms` is the
 * interval's period — a fired interval re-enters the heap with a fresh
 * deadline and seq, so ties against later timers stay FIFO like Node's. */
typedef struct {
  double deadline_ms;
  unsigned long seq;
  ScrClosure *cb; /* owned */
  double repeat_ms;
  unsigned long id;
  bool reffed;     /* keeps the loop alive; unref() clears it (Node semantics) */
  double delay_ms; /* the original delay — refresh() re-arms to now + this */
} ScrTimer;

static ScrTimer *scr_timers = NULL;
static size_t scr_ntimers = 0, scr_timers_cap = 0;
static unsigned long scr_timer_seq = 0;
/* REF'd armed timers — the loop's timer-liveness count (an unref'd timer
 * sits in the heap and still FIRES if the loop runs for other reasons, but
 * does not by itself keep the loop alive). Kept in sync by push/pop/remove
 * and by ref/unref. */
static size_t scr_reffed_timers = 0;

/* Exported: the island's timer machinery (scr_web.c) shares this clock so
 * its deadlines are comparable with the loop's. */
double scr_now_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (double)ts.tv_sec * 1000.0 + (double)ts.tv_nsec / 1e6;
}

static bool scr_timer_before(const ScrTimer *a, const ScrTimer *b) {
  if (a->deadline_ms != b->deadline_ms) return a->deadline_ms < b->deadline_ms;
  return a->seq < b->seq;
}

static void scr_timer_push(ScrTimer t) {
  if (scr_ntimers == scr_timers_cap) {
    scr_timers_cap = scr_timers_cap ? scr_timers_cap * 2 : 16;
    scr_timers = realloc(scr_timers, scr_timers_cap * sizeof *scr_timers);
    if (!scr_timers) scr_oom();
  }
  if (t.reffed) scr_reffed_timers++;
  size_t i = scr_ntimers++;
  scr_timers[i] = t;
  while (i > 0) {
    size_t parent = (i - 1) / 2;
    if (!scr_timer_before(&scr_timers[i], &scr_timers[parent])) break;
    ScrTimer tmp = scr_timers[i];
    scr_timers[i] = scr_timers[parent];
    scr_timers[parent] = tmp;
    i = parent;
  }
}

static ScrTimer scr_timer_pop(void) {
  ScrTimer top = scr_timers[0];
  if (top.reffed && scr_reffed_timers > 0) scr_reffed_timers--;
  scr_timers[0] = scr_timers[--scr_ntimers];
  size_t i = 0;
  for (;;) {
    size_t l = 2 * i + 1, r = 2 * i + 2, min = i;
    if (l < scr_ntimers && scr_timer_before(&scr_timers[l], &scr_timers[min])) min = l;
    if (r < scr_ntimers && scr_timer_before(&scr_timers[r], &scr_timers[min])) min = r;
    if (min == i) break;
    ScrTimer tmp = scr_timers[i];
    scr_timers[i] = scr_timers[min];
    scr_timers[min] = tmp;
    i = min;
  }
  return top;
}

/* Node's delay coercion (lib/internal/timers.js): NaN/negative/sub-ms
 * clamp to 1, the delay TRUNCATES to integer milliseconds (setTimeout(cb,
 * 1.8) and setTimeout(cb, 1.1) both land in the 1ms bucket, so a batch of
 * fractional delays fires in REGISTRATION order — test-timers-non-integer-
 * delay's contract), and anything past TIMEOUT_MAX (2^31-1) becomes 1. */
static double scr_timer_coerce_ms(double ms) {
  if (!(ms >= 1)) return 1;
  if (ms > 2147483647.0) return 1; /* past TIMEOUT_MAX (also +Infinity) */
  return (double)(unsigned long long)ms; /* trunc: positive, finite, in range */
}

void scr_set_timeout(ScrClosure *cb, double ms) {
  ms = scr_timer_coerce_ms(ms);
  ScrTimer t = {scr_now_ms() + ms, scr_timer_seq++, cb /* ownership moves in */, 0, 0, true, ms};
  scr_timer_push(t);
}

/* ── setInterval / clearInterval ─────────────────────────────────────
 * Intervals ride the same heap: the entry carries its period and a
 * nonzero id (the compiled handle — Node's Timeout object reduced to the
 * number the fallback declarations promise). A live interval keeps the
 * loop alive exactly because it sits in the heap; clearInterval removes
 * the entry EAGERLY (a lazily-cancelled entry would hold the loop open
 * until its deadline — an interval cleared at t=0 with a one-hour period
 * must let the program exit NOW, like Node). Clearing the interval whose
 * callback is currently running (the self-clearing spinner pattern) is
 * handled by the firing pair below: the entry is out of the heap while
 * its callback runs, so the run loop re-pushes it only if the callback
 * did not clear it. */

static unsigned long scr_interval_next_id = 1;
static unsigned long scr_firing_id = 0; /* interval currently running */
static bool scr_firing_cleared = false;
static bool scr_firing_reffed = true;  /* the running interval's ref state */
static bool scr_firing_refresh = false; /* refresh() called mid-callback */

/* Removes heap entry i (swap-with-last, then sift whichever way the moved
 * entry needs). */
static void scr_timer_remove_at(size_t i) {
  if (scr_timers[i].reffed && scr_reffed_timers > 0) scr_reffed_timers--;
  scr_timers[i] = scr_timers[--scr_ntimers];
  if (i >= scr_ntimers) return;
  /* Sift up if the moved entry beats its parent, else sift down. */
  while (i > 0) {
    size_t parent = (i - 1) / 2;
    if (!scr_timer_before(&scr_timers[i], &scr_timers[parent])) break;
    ScrTimer tmp = scr_timers[i];
    scr_timers[i] = scr_timers[parent];
    scr_timers[parent] = tmp;
    i = parent;
  }
  for (;;) {
    size_t l = 2 * i + 1, r = 2 * i + 2, min = i;
    if (l < scr_ntimers && scr_timer_before(&scr_timers[l], &scr_timers[min])) min = l;
    if (r < scr_ntimers && scr_timer_before(&scr_timers[r], &scr_timers[min])) min = r;
    if (min == i) break;
    ScrTimer tmp = scr_timers[i];
    scr_timers[i] = scr_timers[min];
    scr_timers[min] = tmp;
    i = min;
  }
}

double scr_set_interval(ScrClosure *cb, double ms) {
  ms = scr_timer_coerce_ms(ms); /* Node's clamp-and-trunc, like setTimeout */
  unsigned long id = scr_interval_next_id++;
  ScrTimer t = {scr_now_ms() + ms, scr_timer_seq++, cb /* ownership moves in */, ms, id, true, ms};
  scr_timer_push(t);
  return (double)id;
}

/* A one-shot timer WITH a clear handle — the island's setTimeout (its
 * clearTimeout must cancel, unlike the static surface's clear-less
 * setTimeout). Rides the interval id space so scr_clear_interval serves
 * both; repeat_ms 0 keeps it one-shot at the firing site. */
double scr_set_timeout_handle(ScrClosure *cb, double ms) {
  ms = scr_timer_coerce_ms(ms);
  unsigned long id = scr_interval_next_id++;
  ScrTimer t = {scr_now_ms() + ms, scr_timer_seq++, cb /* ownership moves in */, 0, id, true, ms};
  scr_timer_push(t);
  return (double)id;
}

/* process.env-style timer ref bookkeeping: unref() drops a timer from the
 * loop's liveness count (it still fires if the loop runs on), ref() puts
 * it back. Node-exact for the static timer surface; NaN/0/absent handles
 * are tolerated (never a handle). The one-shot setTimeout with NO clear
 * handle (id 0) cannot be unref'd by id — the compiler routes .unref()
 * only over handle-returning timers, so id 0 never reaches here. */
static ScrTimer *scr_timer_find(unsigned long id) {
  for (size_t i = 0; i < scr_ntimers; i++) {
    if (scr_timers[i].id == id) return &scr_timers[i];
  }
  return NULL;
}

void scr_timer_unref(double handle) {
  if (!(handle >= 1)) return;
  unsigned long id = (unsigned long)handle;
  if (id == scr_firing_id) {
    /* Firing interval unref'ing itself: the re-arm carries the flag. */
    scr_firing_reffed = false;
    return;
  }
  ScrTimer *t = scr_timer_find(id);
  if (t && t->reffed) {
    t->reffed = false;
    if (scr_reffed_timers > 0) scr_reffed_timers--;
  }
}

void scr_timer_ref(double handle) {
  if (!(handle >= 1)) return;
  unsigned long id = (unsigned long)handle;
  if (id == scr_firing_id) {
    scr_firing_reffed = true;
    return;
  }
  ScrTimer *t = scr_timer_find(id);
  if (t && !t->reffed) {
    t->reffed = true;
    scr_reffed_timers++;
  }
}

/* refresh(): re-arm to now + the original delay — Node's Timeout.refresh.
 * A HEAP entry (armed timeout or interval between ticks) re-enters the
 * heap with a fresh deadline and seq (FIFO against later same-deadline
 * timers, like a brand-new timer); the timer whose callback is RUNNING
 * sets the firing flag and the loop re-arms the one-shot after the
 * callback returns (the interval re-arm already does). A one-shot that
 * fired on an earlier turn is gone — its closure released — so refresh
 * of a dead handle is a tolerated no-op (SEMANTICS: Node re-activates
 * even a fired Timeout; the compiled handle cannot). */
void scr_timer_refresh(double handle) {
  if (!(handle >= 1)) return;
  unsigned long id = (unsigned long)handle;
  if (id == scr_firing_id) {
    scr_firing_refresh = true;
    return;
  }
  for (size_t i = 0; i < scr_ntimers; i++) {
    if (scr_timers[i].id == id) {
      ScrTimer t = scr_timers[i];
      scr_timer_remove_at(i);
      t.deadline_ms = scr_now_ms() + t.delay_ms;
      t.seq = scr_timer_seq++;
      scr_timer_push(t);
      return;
    }
  }
}

/* hasRef(): true iff the handle names a live, still-reffed timer. */
bool scr_timer_has_ref(double handle) {
  if (!(handle >= 1)) return false;
  unsigned long id = (unsigned long)handle;
  if (id == scr_firing_id) return scr_firing_reffed;
  ScrTimer *t = scr_timer_find(id);
  return t != NULL && t->reffed;
}

/* ── process.getActiveResourcesInfo (the loop's own bookkeeping) ──────
 * 'Timeout' per armed heap timer — plus the firing, uncleared one (Node
 * counts a Timeout as active while its callback runs, until clearTimeout
 * drops it) — and 'Immediate' per queued, unfired immediate (a FIRED
 * immediate no longer counts, Node's current answer inside the
 * callback). Resource kinds this runtime does not model as loop handles
 * (TCP wraps, FS requests, ...) are absent — SEMANTICS.md names the
 * divergence. Result +1. */
static size_t scr_pending_immediates; /* defined below with the queue */
ScrArr *scr_active_resources(void) {
  ScrArr *arr = scr_arr_new(SCR_ELEM_STR, 8);
  size_t timeouts = scr_ntimers + ((scr_firing_id != 0 && !scr_firing_cleared) ? 1 : 0);
  for (size_t i = 0; i < timeouts; i++) scr_arr_push_ref(arr, scr_str_new("Timeout", 7));
  for (size_t i = 0; i < scr_pending_immediates; i++) scr_arr_push_ref(arr, scr_str_new("Immediate", 9));
  return arr;
}

/* ── process.nextTick (the user tick queue) ───────────────────────────
 * A FIFO of user callbacks drained BEFORE promise jobs at every loop
 * checkpoint, to joint exhaustion with them — Node's tick-then-microtask
 * order. Pending ticks are always-ready work: the loop neither sleeps
 * nor exits while any exist. Ticks scheduled from 'exit' listeners (or
 * left queued on the uncaught paths) never run — the teardown releases
 * them, like Node dropping the queue at exit. */
typedef struct ScrNtick {
  ScrClosure *cb;             /* owned; NULL for a raw C-hook entry */
  ScrFsRenameFn error_cb;     /* process-write success adapter, or NULL */
  void (*raw)(void);          /* hook when cb == NULL (stream markers) */
  struct ScrNtick *next;
} ScrNtick;

static ScrNtick *scr_nt_head = NULL;
static ScrNtick *scr_nt_tail = NULL;

/* Public: releases every queued tick without running it — the loop-exit
 * teardown below AND the exit-listener runner (scr_events.c) both call
 * it, because 'exit' listeners run AFTER the loop's teardown and may
 * enqueue ticks that must never run (Node) yet must not leak. */

void scr_next_tick(ScrClosure *cb /*moves*/) {
  ScrNtick *t = calloc(1, sizeof *t);
  if (!t) scr_oom();
  t->cb = cb;
  if (scr_nt_tail) scr_nt_tail->next = t;
  else scr_nt_head = t;
  scr_nt_tail = t;
}

/* stdout/stderr write completions are Node nextTicks too, but their
 * callback receives the success `null` argument. Reuse the error-first
 * adapter ABI also used by fs.rename: emitted adapters construct the
 * program's Error | null union, and NULL selects its null arm. */
void scr_process_write_callback(ScrClosure *cb /*moves*/, ScrFsRenameFn fn) {
  ScrNtick *t = calloc(1, sizeof *t);
  if (!t) scr_oom();
  t->cb = cb;
  t->error_cb = fn;
  if (scr_nt_tail) scr_nt_tail->next = t;
  else scr_nt_head = t;
  scr_nt_tail = t;
}

/* A RAW C-hook tick: the stream unit enqueues one marker per deferred
 * stream emission so those emissions interleave with user nextTicks in
 * true FIFO order — in Node they ARE nextTicks (resume_, emitReadable_,
 * endReadableNT, ...). The hook dispatches exactly one stream tick;
 * teardown just drops markers (the stream queue owns its entries). */
void scr_next_tick_raw(void (*fn)(void)) {
  ScrNtick *t = calloc(1, sizeof *t);
  if (!t) scr_oom();
  t->raw = fn;
  if (scr_nt_tail) scr_nt_tail->next = t;
  else scr_nt_head = t;
  scr_nt_tail = t;
}

void scr_nticks_teardown(void) {
  while (scr_nt_head != NULL) {
    ScrNtick *t = scr_nt_head;
    scr_nt_head = t->next;
    if (t->cb) scr_closure_release(t->cb);
    free(t);
  }
  scr_nt_tail = NULL;
}

/* Releases every armed timer — the island teardown calls this before the
 * engine dies so closures holding engine callbacks free first and the
 * counting allocator's zero-live audit holds (the loop only exits with
 * entries still armed on the uncaught/unhandled paths). */
static void scr_immediates_teardown(void);
void scr_timers_teardown(void) {
  for (size_t i = 0; i < scr_ntimers; i++) scr_closure_release(scr_timers[i].cb);
  scr_ntimers = 0;
  scr_reffed_timers = 0;
  scr_immediates_teardown();
  scr_nticks_teardown();
}

void scr_clear_interval(double handle) {
  if (!(handle >= 1)) return; /* NaN/0/negative: never a handle; Node tolerates */
  unsigned long id = (unsigned long)handle;
  if (id == scr_firing_id) {
    scr_firing_cleared = true; /* the run loop drops the callback */
    return;
  }
  for (size_t i = 0; i < scr_ntimers; i++) {
    if (scr_timers[i].id == id) {
      scr_closure_release(scr_timers[i].cb);
      scr_timer_remove_at(i);
      return;
    }
  }
}

/* ── immediates (Node's check phase) ──────────────────────────────────
 * setImmediate callbacks run once per loop turn, AFTER due timers, in
 * FIFO order — and immediates queued while the phase runs wait for the
 * NEXT turn (the phase snapshots its end index). The queue is an
 * append-only array with a head cursor; clearImmediate NULLs the slot in
 * place (order and indices stay stable mid-phase). Ids ride their own
 * space — clearTimeout of an Immediate is a no-op, like Node. */
typedef struct {
  unsigned long id;
  ScrClosure *cb; /* owned; NULL once fired or cleared */
  bool reffed;    /* keeps the loop alive; unref() clears it (Node semantics) */
} ScrImmediate;

static ScrImmediate *scr_immediates = NULL;
static size_t scr_nimmediates = 0, scr_immediates_head = 0, scr_immediates_cap = 0;
static unsigned long scr_immediate_seq = 0;
/* Pending (queued, uncleared) immediates and the reffed subset — the
 * loop's no-sleep signal and liveness count respectively. */
static size_t scr_pending_immediates = 0;
static size_t scr_reffed_immediates = 0;

double scr_set_immediate(ScrClosure *cb) {
  if (scr_nimmediates == scr_immediates_cap) {
    scr_immediates_cap = scr_immediates_cap ? scr_immediates_cap * 2 : 16;
    scr_immediates = realloc(scr_immediates, scr_immediates_cap * sizeof *scr_immediates);
    if (!scr_immediates) scr_oom();
  }
  unsigned long id = ++scr_immediate_seq;
  scr_immediates[scr_nimmediates].id = id;
  scr_immediates[scr_nimmediates].cb = cb; /* ownership moves in */
  scr_immediates[scr_nimmediates].reffed = true;
  scr_nimmediates++;
  scr_pending_immediates++;
  scr_reffed_immediates++;
  return (double)id;
}

static ScrImmediate *scr_immediate_find(unsigned long id) {
  for (size_t i = scr_immediates_head; i < scr_nimmediates; i++) {
    if (scr_immediates[i].id == id && scr_immediates[i].cb != NULL) return &scr_immediates[i];
  }
  return NULL;
}

void scr_clear_immediate(double handle) {
  if (!(handle >= 1)) return; /* NaN/0/negative: never a handle; Node tolerates */
  ScrImmediate *im = scr_immediate_find((unsigned long)handle);
  if (im == NULL) return; /* already fired/cleared: no-op, like Node */
  scr_closure_release(im->cb);
  im->cb = NULL;
  if (scr_pending_immediates > 0) scr_pending_immediates--;
  if (im->reffed) {
    im->reffed = false;
    if (scr_reffed_immediates > 0) scr_reffed_immediates--;
  }
}

/* Immediate.unref()/ref()/hasRef(): the Timeout trio's exact story over
 * the immediate queue. A fired or cleared handle is a tolerated no-op
 * (Node's Immediate methods on a dead handle do nothing). */
void scr_immediate_unref(double handle) {
  if (!(handle >= 1)) return;
  ScrImmediate *im = scr_immediate_find((unsigned long)handle);
  if (im && im->reffed) {
    im->reffed = false;
    if (scr_reffed_immediates > 0) scr_reffed_immediates--;
  }
}

void scr_immediate_ref(double handle) {
  if (!(handle >= 1)) return;
  ScrImmediate *im = scr_immediate_find((unsigned long)handle);
  if (im && !im->reffed) {
    im->reffed = true;
    scr_reffed_immediates++;
  }
}

bool scr_immediate_has_ref(double handle) {
  if (!(handle >= 1)) return false;
  ScrImmediate *im = scr_immediate_find((unsigned long)handle);
  return im != NULL && im->reffed;
}

/* The teardown sweep's immediate arm (called from scr_timers_teardown):
 * unref'd immediates left queued at normal loop exit never fire (Node),
 * so their closures release here or the RC audit counts them as leaks. */
static void scr_immediates_teardown(void) {
  for (size_t i = scr_immediates_head; i < scr_nimmediates; i++) {
    if (scr_immediates[i].cb != NULL) scr_closure_release(scr_immediates[i].cb);
  }
  scr_nimmediates = 0;
  scr_immediates_head = 0;
  scr_pending_immediates = 0;
  scr_reffed_immediates = 0;
}

/* Unhandled rejections: rejected promises retained here until observed. */
static ScrPromise **scr_maybe_unhandled = NULL;
static size_t scr_nunhandled = 0, scr_unhandled_cap = 0;

static void scr_track_rejection(ScrPromise *p) {
  if (scr_nunhandled == scr_unhandled_cap) {
    scr_unhandled_cap = scr_unhandled_cap ? scr_unhandled_cap * 2 : 8;
    scr_maybe_unhandled = realloc(scr_maybe_unhandled, scr_unhandled_cap * sizeof *scr_maybe_unhandled);
    if (!scr_maybe_unhandled) scr_oom();
  }
  scr_maybe_unhandled[scr_nunhandled++] = scr_promise_retain(p);
}

/* ── context switching (ASan-annotated) ───────────────────────────────── */

#ifdef SCR_ASAN_FIBERS
static void *scr_main_fake_stack; /* fake-stack slot for the main context */
#endif

#ifdef _WIN32
/* The current context's handle, converting the main thread to a fiber on
 * first need (SwitchToFiber requires the caller BE a fiber; the runtime is
 * single-threaded, so one lazy conversion covers the process). Also the
 * loop-home keeper: whenever main is the caller this IS scr_loop_ctx's
 * value — assigned at the conversion so parked fibers can always switch
 * back to it. */
static void *scr_win_self(void) {
  static bool converted = false;
  if (!converted) {
    scr_loop_ctx = ConvertThreadToFiber(NULL);
    if (scr_loop_ctx == NULL) {
      fputs("scriptc: ConvertThreadToFiber failed\n", stderr);
      abort();
    }
    converted = true;
  }
  return GetCurrentFiber();
}
#endif

static void scr_switch(ScrCtx *from, ScrCtx *to, ScrFiber *to_fiber) {
#ifdef SCR_ASAN_FIBERS
  ScrFiber *from_fiber = scr_current;
#endif
  scr_current = to_fiber;
  scr_exc_swap_cell(to_fiber ? &to_fiber->exc : NULL);
  scr_als_active = to_fiber ? &to_fiber->als : &scr_als_main_slot;
#ifdef _WIN32
  /* SwitchToFiber snapshots the outgoing fiber's state inside its own
   * fiber object — `from` has nothing to record. */
  (void)from;
  SwitchToFiber(*to);
#elif defined(__wasi__)
  (void)from;
  (void)to;
  scr_trap("scriptc: internal error: native stack switch reached on WASI\n");
#elif defined(SCR_ASAN_FIBERS)
  void **save = from_fiber ? &from_fiber->fake_stack : &scr_main_fake_stack;
  const void *bottom = to_fiber ? to_fiber->stack : NULL;
  size_t size = to_fiber ? SCR_FIBER_STACK : 0;
  __sanitizer_start_switch_fiber(save, bottom, size);
  swapcontext(from, to);
  const void *old_bottom;
  size_t old_size;
  __sanitizer_finish_switch_fiber(
      scr_current ? scr_current->fake_stack : scr_main_fake_stack, &old_bottom, &old_size);
#else
  swapcontext(from, to);
#endif
}

static void scr_promise_settle_wake(ScrPromise *p);

/* Copies src's settlement into a still-pending dst (payload RETAINED —
 * src can settle other destinations and still be awaited) and wakes dst's
 * waiters. A rejection consumed this way counts as HANDLED on src (a
 * combinator attached a handler, like Node's race). The Promise.race
 * same-inner-type adapter and the rejection path both land here. */
static void scr_promise_settle_from(ScrPromise *dst, ScrPromise *src) {
  if (dst->state == SCR_PROM_PENDING) {
    dst->state = src->state;
    dst->payload_kind = src->payload_kind;
    dst->f64 = src->f64;
    dst->b = src->b;
    dst->retain_fn = src->retain_fn;
    dst->release_fn = src->release_fn;
    dst->trace_fn = src->trace_fn;
    dst->payload = NULL;
    if (src->payload_kind == SCR_EXC_STR && src->payload) {
      dst->payload = scr_str_retain((ScrStr *)src->payload);
    } else if ((src->payload_kind == SCR_EXC_REF || src->payload_kind == SCR_EXC_OBJ) &&
               src->payload) {
      dst->payload = src->retain_fn(src->payload);
    }
    scr_promise_settle_wake(dst);
  }
  if (src->state == SCR_PROM_REJECTED) scr_prom_observe(src);
}

/* The emitted same-type Promise.race adapter (see raceAdapterFor). */
void scr_promise_adapt_copy(ScrPromise *dst, ScrPromise *src) {
  scr_promise_settle_from(dst, src);
}

/* One Promise.all entry settling: a fulfillment stores its payload into
 * the values array at the entry's INPUT index (input order regardless of
 * settlement order) and the LAST missing fulfillment fulfills the result
 * with the array (void-element all fulfills void); a rejection copies raw
 * into the result — the first one in SETTLEMENT order wins through the
 * destination's own pending check, and later ones still count as HANDLED
 * on their entries (settle_from marks them observed), exactly Node's
 * subscribe-to-everything behavior. */
static void scr_promise_all_settle(ScrAllState *st, ScrPromise *result, size_t idx,
                                    ScrPromise *src) {
  if (src->state == SCR_PROM_FULFILLED) {
    if (st->store) st->store(st->values, (double)idx, src);
    if (--st->remaining == 0 && result->state == SCR_PROM_PENDING) {
      if (st->values) {
        scr_promise_fulfill_ref(result, scr_arr_retain(st->values), scr_arr_retain_v,
                                 scr_arr_release_v,
                                 st->values->elem_trace ? scr_arr_trace_v : NULL);
      } else {
        scr_promise_fulfill_void(result);
      }
    }
  } else {
    scr_promise_settle_from(result, src);
  }
}

/* Settle helpers wake waiters into the microtask queue and run the
 * combinator callbacks: adapters for fulfillments (they convert the
 * payload to the destination's inner type), the raw copy for rejections
 * (reasons are dynamically tagged). first-settle-wins rides the
 * destination's own pending check. Promise.all entries dispatch through
 * their shared countdown state instead of the adapt pair. */
static void scr_promise_settle_wake(ScrPromise *p) {
  for (size_t i = 0; i < p->nwaiters; i++) scr_ready_push(p->waiters[i]);
  p->nwaiters = 0;
  for (size_t i = 0; i < p->ncbs; i++) {
    if (p->cbs[i].all) {
      scr_promise_all_settle(p->cbs[i].all, p->cbs[i].dst, p->cbs[i].all_idx, p);
      scr_promise_all_state_release(p->cbs[i].all);
    } else if (p->state == SCR_PROM_FULFILLED) {
      p->cbs[i].adapt(p->cbs[i].dst, p);
    } else {
      scr_promise_settle_from(p->cbs[i].dst, p);
    }
    scr_promise_release(p->cbs[i].dst);
  }
  p->ncbs = 0;
  if (p->state == SCR_PROM_REJECTED) scr_track_rejection(p);
}

/* ── Promise.race ─────────────────────────────────────────────────────
 * The compiler emits: a fresh result promise, then one race_add per
 * entry. A settled entry settles the result immediately (first add
 * wins); pending entries park a callback waiter that fires inside the
 * entry's settle. Fibers awaiting the result still wake through the
 * microtask queue. Losing entries keep their own settlements (payloads
 * are retained, not moved). */

void scr_promise_race_add(ScrPromise *race, ScrPromise *in,
                           void (*adapt)(ScrPromise *dst, ScrPromise *src)) {
  if (in->state != SCR_PROM_PENDING) {
    if (in->state == SCR_PROM_FULFILLED) adapt(race, in);
    else scr_promise_settle_from(race, in);
    return;
  }
  if (in->ncbs == in->cbs_cap) {
    in->cbs_cap = in->cbs_cap ? in->cbs_cap * 2 : 4;
    in->cbs = realloc(in->cbs, in->cbs_cap * sizeof *in->cbs);
    if (!in->cbs) scr_oom();
  }
  in->cbs[in->ncbs].adapt = adapt;
  in->cbs[in->ncbs].dst = scr_promise_retain(race);
  in->cbs[in->ncbs].all = NULL;
  in->cbs[in->ncbs].all_idx = 0;
  in->ncbs++;
}

/* ── Promise.all ──────────────────────────────────────────────────────
 * BORROWS the entries array `ps` and the pre-capacity values array
 * `values` (NULL for void elements), retains what it keeps, and returns
 * the result promise +1. `values` arrives EMPTY with cap >= ps->len (the
 * emitted construction passes the length) and is pre-sized here: every
 * slot's zero bits are the per-kind placeholder (0.0 / false / NULL),
 * legal to overwrite through the store helpers and to release. Entries
 * already settled settle inline (a rejection settles the result NOW —
 * first rejection in settlement order — and later rejected entries are
 * still marked handled); pending entries park a countdown waiter. The
 * empty array fulfills immediately (awaiters take the settled-await
 * microtask hop, like Node's one-tick resolve). */
ScrPromise *scr_promise_all(ScrArr *ps, ScrArr *values,
                             void (*store)(ScrArr *a, double i, ScrPromise *src)) {
  size_t n = ps->len;
  ScrPromise *result = scr_promise_new();
  if (values && n > 0) {
    memset(values->data, 0, n * sizeof *values->data);
    values->len = n;
  }
  ScrAllState *st = malloc(sizeof *st);
  if (!st) scr_oom();
  st->rc = 1; /* the builder's reference, dropped at the end */
  st->remaining = n;
  st->values = values ? scr_arr_retain(values) : NULL;
  st->store = store;
  for (size_t i = 0; i < n; i++) {
    ScrPromise *in = (ScrPromise *)scr_arr_get_ref(ps, (double)i); /* +1 */
    if (in->state != SCR_PROM_PENDING) {
      scr_promise_all_settle(st, result, i, in);
    } else {
      if (in->ncbs == in->cbs_cap) {
        in->cbs_cap = in->cbs_cap ? in->cbs_cap * 2 : 4;
        in->cbs = realloc(in->cbs, in->cbs_cap * sizeof *in->cbs);
        if (!in->cbs) scr_oom();
      }
      in->cbs[in->ncbs].adapt = NULL;
      in->cbs[in->ncbs].dst = scr_promise_retain(result);
      in->cbs[in->ncbs].all = st;
      in->cbs[in->ncbs].all_idx = i;
      in->ncbs++;
      st->rc++;
    }
    scr_promise_release(in);
  }
  /* n == 0, or every entry was already fulfilled inline. */
  if (st->remaining == 0 && result->state == SCR_PROM_PENDING) {
    if (st->values) {
      scr_promise_fulfill_ref(result, scr_arr_retain(st->values), scr_arr_retain_v,
                               scr_arr_release_v,
                               st->values->elem_trace ? scr_arr_trace_v : NULL);
    } else {
      scr_promise_fulfill_void(result);
    }
  }
  scr_promise_all_state_release(st);
  return result;
}

/* Per-element-kind store helpers for the emitted Promise.all: write the
 * entry's fulfillment payload into the values array at its input index.
 * The payload accessors return retained/by-value (losing a reference is
 * impossible: set_* takes ownership and releases the zero placeholder). */
void scr_promise_all_store_f64(ScrArr *a, double i, ScrPromise *src) {
  scr_arr_set_f64(a, i, scr_promise_payload_f64(src));
}
void scr_promise_all_store_bool(ScrArr *a, double i, ScrPromise *src) {
  scr_arr_set_bool(a, i, scr_promise_payload_bool(src));
}
void scr_promise_all_store_str(ScrArr *a, double i, ScrPromise *src) {
  scr_arr_set_ref(a, i, scr_promise_payload_str(src));
}
void scr_promise_all_store_ref(ScrArr *a, double i, ScrPromise *src) {
  scr_arr_set_ref(a, i, scr_promise_payload_ref(src));
}

/* Fulfillment payload accessors for the emitted race adapters — all
 * retained/by-value (the source keeps its settlement). */
double scr_promise_payload_f64(ScrPromise *p) { return p->f64; }
bool scr_promise_payload_bool(ScrPromise *p) { return p->b; }
ScrStr *scr_promise_payload_str(ScrPromise *p) {
  return scr_str_retain((ScrStr *)p->payload);
}
/* Thin views for the gated dyn-async TU (scr_async_dyn.c): the payload
 * KIND, whether a REF payload is a dyn value (the dyn adapters), and the
 * settled-await primitive (park/hop + rejection re-throw; true =
 * fulfilled). */
static bool scr_await_settled(ScrPromise *p); /* defined with the await family */
int scr_promise_payload_kind(const ScrPromise *p) { return (int)p->payload_kind; }
bool scr_promise_payload_is_dyn(const ScrPromise *p) { return p->retain_fn == scr_dyn_retain_v; }
double scr_promise_payload_num(const ScrPromise *p) { return p->f64; }
bool scr_promise_payload_flag(const ScrPromise *p) { return p->b; }
bool scr_promise_await_settled(ScrPromise *p) { return scr_await_settled(p); }
void scr_promise_payload_release(const ScrPromise *p, void *v) { p->release_fn(v); }

void *scr_promise_payload_ref(ScrPromise *p) {
  return p->payload ? p->retain_fn(p->payload) : NULL;
}

/* MOVES a pending exception out of `cell` into `p` as its rejection payload
 * (the cell resets to NONE). Shared by fiber completion and the new-Promise
 * executor runners; callers wake waiters themselves. */
static void scr_promise_reject_from_cell(ScrPromise *p, ScrExcCell *cell) {
  p->state = SCR_PROM_REJECTED;
  p->payload_kind = cell->kind;
  p->f64 = cell->f64;
  p->b = cell->b;
  p->payload = cell->payload;
  p->retain_fn = cell->retain_fn;
  p->release_fn = cell->release_fn;
  p->trace_fn = cell->trace_fn;
  cell->kind = SCR_EXC_NONE;
  cell->payload = NULL;
  cell->trace_fn = NULL;
}

static void scr_fiber_finish(ScrFiber *self) {
  if (self->gen != NULL) {
    /* Generator completion: the emitted trampoline already stored the
     * completion value (or consumed the GENRET sentinel); a real body
     * exception stays pending in this fiber's cell — the consumer-side
     * resume moves it into the resumer's cell. No promise to settle. */
    self->done = true;
    return;
  }
  ScrPromise *p = self->promise;
  if (scr_exc_pending()) {
    /* The body's exception escaped: the promise rejects with the payload
     * (moved from the fiber's cell into the promise). */
    scr_promise_reject_from_cell(p, &self->exc);
  }
  /* Fulfillment payload was stored by the trampoline before finishing. */
  scr_promise_settle_wake(p);
  self->done = true;
}

#ifdef _WIN32
static void CALLBACK scr_trampoline(void *param) {
  (void)param;
#else
static void scr_trampoline(void) {
#endif
#ifdef SCR_ASAN_FIBERS
  const void *ob;
  size_t os;
  __sanitizer_finish_switch_fiber(scr_current->fake_stack, &ob, &os);
#endif
  ScrFiber *self = scr_current;
  self->entry(self, self->argpack);
  scr_fiber_finish(self);
  /* Dead fiber: hop back to whoever resumed us. The loop frees us. */
  scr_switch(&self->ctx, self->return_to, NULL);
  /* unreachable */
}

/* Frees a finished fiber's execution resources (the promise release and
 * bookkeeping stay at the call sites). Windows: DeleteFiber tears down the
 * fiber object and its stack — legal here because a finished fiber has
 * switched away and can never be current again. */
static void scr_fiber_destroy(ScrFiber *f) {
#ifdef _WIN32
  DeleteFiber(f->ctx);
#elif defined(__wasi__)
  if (f->coro != NULL) scr_wasi_coro_destroy(f->coro);
#endif
  scr_als_ctx_release(f->als);
  free(f->stack);
  free(f);
}

/* Spawns and EAGERLY runs an async body until its first suspension (JS's
 * synchronous-prefix rule). Returns the fiber's promise, +1. */
ScrPromise *scr_async_spawn(void (*entry)(ScrFiber *, void *), void *argpack) {
  ScrFiber *f = calloc(1, sizeof *f);
  if (!f) scr_oom();
  f->promise = scr_promise_new();
  f->entry = entry;
  f->argpack = argpack;
  /* AsyncLocalStorage: the child runs in the SPAWNER's context (Node's
   * init-time capture); snapshots are immutable, so a retain suffices. */
  f->als = scr_als_ctx_retain(*scr_als_active);
  scr_fibers_live++;

#ifdef _WIN32
  /* The commit size is the ucontext stack's size; the reserve stays the
   * default 1MB. Committed lazily by the OS, like the malloc'd stacks. */
  ScrCtx here = scr_win_self();
  f->ctx = CreateFiber(SCR_FIBER_STACK, scr_trampoline, NULL);
  if (f->ctx == NULL) scr_oom();
#elif defined(__wasi__)
  ScrFiber *spawner = scr_current;
  scr_current = f;
  scr_exc_swap_cell(&f->exc);
  scr_als_active = &f->als;
  entry(f, argpack); /* eager prefix; returns at suspend/final suspend */
  scr_current = spawner;
  scr_exc_swap_cell(spawner ? &spawner->exc : NULL);
  scr_als_active = spawner ? &spawner->als : &scr_als_main_slot;
  ScrPromise *result = scr_promise_retain(f->promise);
  if (f->done) {
    scr_promise_release(f->promise);
    scr_fiber_destroy(f);
    scr_fibers_live--;
  }
  return result;
#else
  f->stack = malloc(SCR_FIBER_STACK);
  if (!f->stack) scr_oom();
  getcontext(&f->ctx);
  f->ctx.uc_stack.ss_sp = f->stack;
  f->ctx.uc_stack.ss_size = SCR_FIBER_STACK;
  f->ctx.uc_link = NULL;
  makecontext(&f->ctx, scr_trampoline, 0);

  ucontext_t here;
#endif
#ifndef __wasi__
  f->return_to = &here;
  ScrFiber *spawner = scr_current;
  scr_switch(&here, &f->ctx, f);
  /* back: the fiber suspended or finished. The switch back targeted NULL
   * (the child doesn't know who spawned it), which pointed both the current
   * fiber AND the exception machinery at main — restore the spawner's cell
   * too, or a fiber that eagerly spawned another keeps throwing/catching
   * against main's cell and completes with its own cell empty (a phantom
   * `undefined` rejection while the real payload leaks). */
  scr_current = spawner;
  scr_exc_swap_cell(spawner ? &spawner->exc : NULL);
  scr_als_active = spawner ? &spawner->als : &scr_als_main_slot;
  ScrPromise *result = scr_promise_retain(f->promise);
  if (f->done) {
    scr_promise_release(f->promise);
    scr_fiber_destroy(f);
    scr_fibers_live--;
  }
  return result;
#endif
}

/* A runtime-authored C continuation whose first operation awaits one known
 * dependency. Native fibers can park normally. wasm32 has no resumable C
 * stack, so queue the fiber only after the dependency settles; the entry's
 * await then extracts the result without attempting a stack switch. The
 * READY queue supplies the settled-await microtask hop in both cases. */
ScrPromise *scr_async_spawn_after(ScrPromise *dependency,
                                  void (*entry)(ScrFiber *, void *),
                                  void *argpack) {
#ifndef __wasi__
  (void)dependency;
  return scr_async_spawn(entry, argpack);
#else
  ScrFiber *f = calloc(1, sizeof *f);
  if (!f) scr_oom();
  f->promise = scr_promise_new();
  f->entry = entry;
  f->argpack = argpack;
  f->als = scr_als_ctx_retain(*scr_als_active);
  scr_fibers_live++;

  if (dependency->state == SCR_PROM_PENDING) {
    if (dependency->nwaiters == dependency->waiters_cap) {
      dependency->waiters_cap = dependency->waiters_cap ? dependency->waiters_cap * 2 : 4;
      dependency->waiters = realloc(
          dependency->waiters, dependency->waiters_cap * sizeof *dependency->waiters);
      if (!dependency->waiters) scr_oom();
    }
    dependency->waiters[dependency->nwaiters++] = f;
  } else {
    scr_ready_push(f);
  }
  return scr_promise_retain(f->promise);
#endif
}

/* Parks the current fiber on `p` until it settles. Only fibers await. */
static void scr_await_park(ScrPromise *p) {
  ScrFiber *self = scr_current;
  if (!self) {
    fputs("scriptc: internal error: await outside an async function\n", stderr);
    abort();
  }
  if (p->nwaiters == p->waiters_cap) {
    p->waiters_cap = p->waiters_cap ? p->waiters_cap * 2 : 4;
    p->waiters = realloc(p->waiters, p->waiters_cap * sizeof *p->waiters);
    if (!p->waiters) scr_oom();
  }
  p->waiters[p->nwaiters++] = self;
  scr_switch(&self->ctx, self->return_to, NULL);
  /* Resumed by the loop: return_to must now point at the loop's context. */
}

#ifdef __wasi__
/* The emitted coroutine suspends immediately after these preparation
 * calls. Settled promises still queue one ready turn; pending promises own
 * the continuation through their waiter list. */
void scr_wasi_await_prepare(ScrFiber *self, ScrPromise *p) {
  if (p->state == SCR_PROM_PENDING) {
    if (p->nwaiters == p->waiters_cap) {
      p->waiters_cap = p->waiters_cap ? p->waiters_cap * 2 : 4;
      p->waiters = realloc(p->waiters, p->waiters_cap * sizeof *p->waiters);
      if (!p->waiters) scr_oom();
    }
    p->waiters[p->nwaiters++] = self;
  } else {
    scr_ready_push(self);
  }
}

void scr_wasi_await_hop_prepare(ScrFiber *self) { scr_ready_push(self); }

bool scr_wasi_module_await_prepare(ScrFiber *self, ScrPromise *p) {
  if (p->state != SCR_PROM_PENDING) return false;
  scr_wasi_await_prepare(self, p);
  return true;
}

void scr_wasi_async_finish(ScrFiber *self) { scr_fiber_finish(self); }

void scr_wasi_gen_finish(ScrFiber *self) {
  if (scr_exc_genret_pending()) {
    scr_exc_clear();
    scr_gen_ret_to_out(self->gen);
  }
  scr_fiber_finish(self);
}
#endif

/* One microtask hop: park the current fiber on the READY queue itself and
 * yield. JS's `await` ALWAYS suspends — even on an already-settled promise
 * the continuation runs as a microtask — so without this hop an awaiter of
 * a settled promise would continue synchronously inside the spawner,
 * observably earlier than Node (corpus 1428 pins the ordering). */
static void scr_await_yield(void) {
  ScrFiber *self = scr_current;
  if (!self) {
    fputs("scriptc: internal error: await outside an async function\n", stderr);
    abort();
  }
  scr_ready_push(self);
  scr_switch(&self->ctx, self->return_to, NULL);
}

/* The emitted promise-or-absent await's unit arm (`await u` where u holds
 * undefined/null): JS awaits non-thenables through exactly one microtask
 * turn — the same hop a settled promise takes. */
void scr_await_hop(void) { scr_await_yield(); }

/* Copies a rejection into the active execution context's exception cell.
 * The payload is RETAINED, not moved — a promise can be awaited more than
 * once, and the executable's top-level completion probe consumes the same
 * settlement from the main stack after the loop drains. */
static void scr_promise_rethrow(ScrPromise *p) {
  switch (p->payload_kind) {
  case SCR_EXC_F64: scr_throw_f64(p->f64); break;
  case SCR_EXC_BOOL: scr_throw_bool(p->b); break;
  case SCR_EXC_STR: scr_throw_str(scr_str_retain((ScrStr *)p->payload)); break;
  case SCR_EXC_REF: scr_throw_ref(p->retain_fn(p->payload), p->retain_fn, p->release_fn, p->trace_fn); break;
  case SCR_EXC_OBJ: scr_throw_obj(p->retain_fn(p->payload), p->retain_fn, p->release_fn, p->trace_fn); break;
  case SCR_EXC_NONE:
  case SCR_EXC_GENRET: /* unreachable: the sentinel never settles a promise */
    scr_throw_str(scr_str_new("undefined", 9));
    break;
  }
}

/* Await result extraction. Rejection re-throws into the awaiter. */
static bool scr_await_settled(ScrPromise *p) {
#ifdef __wasi__
  if (p->state == SCR_PROM_PENDING) {
    fputs("scriptc: internal error: resumed before awaited promise settled\n", stderr);
    abort();
  }
#else
  if (p->state != SCR_PROM_PENDING) scr_await_yield();
  while (p->state == SCR_PROM_PENDING) scr_await_park(p);
#endif
  scr_prom_observe(p);
  if (p->state == SCR_PROM_REJECTED) {
    scr_promise_rethrow(p);
    return false;
  }
  return true;
}

double scr_await_f64(ScrPromise *p) {
  return scr_await_settled(p) ? p->f64 : 0;
}
bool scr_await_bool(ScrPromise *p) {
  return scr_await_settled(p) ? p->b : false;
}
void *scr_await_ref(ScrPromise *p) {
  return scr_await_settled(p) && p->payload ? p->retain_fn(p->payload) : NULL;
}
void scr_await_void(ScrPromise *p) { scr_await_settled(p); }

/* ECMAScript's INTERNAL module-dependency wait. Unlike a user-authored
 * await, an already-completed dependency does not introduce a promise-job
 * hop: the evaluator continues synchronously into the importer. A pending
 * dependency still parks this module fiber, and rejection propagates into
 * it exactly like an ordinary await. */
void scr_module_await(ScrPromise *p) {
#ifndef __wasi__
  while (p->state == SCR_PROM_PENDING) scr_await_park(p);
#endif
  scr_prom_observe(p);
  if (p->state == SCR_PROM_REJECTED) scr_promise_rethrow(p);
}

int scr_promise_finish_top_level(ScrPromise *p) {
  if (p->state == SCR_PROM_PENDING) {
    /* ECMAScript module evaluation is still pending, but Node's ref'd
     * event-loop work is exhausted. Node exits with its dedicated
     * unsettled-top-level-await status. */
    scr_exit_code_note(13);
    return 13;
  }
  scr_prom_observe(p);
  return p->state == SCR_PROM_REJECTED ? 1 : 0;
}

void scr_promise_rethrow_top_level(ScrPromise *p) {
  if (p->state == SCR_PROM_REJECTED) scr_promise_rethrow(p);
}





/* Fulfillment storers, called by the compiled trampolines / resolve thunks. */
void scr_promise_fulfill_f64(ScrPromise *p, double v) {
  if (p->state != SCR_PROM_PENDING) return; /* first settle wins */
  p->state = SCR_PROM_FULFILLED;
  p->payload_kind = SCR_EXC_F64;
  p->f64 = v;
  scr_promise_settle_wake(p);
}
void scr_promise_fulfill_bool(ScrPromise *p, bool v) {
  if (p->state != SCR_PROM_PENDING) return;
  p->state = SCR_PROM_FULFILLED;
  p->payload_kind = SCR_EXC_BOOL;
  p->b = v;
  scr_promise_settle_wake(p);
}
void scr_promise_fulfill_ref(ScrPromise *p, void *v, void *(*retain)(void *), void (*release)(void *), ScrTraceFn trace) {
  if (p->state != SCR_PROM_PENDING) {
    if (release) release(v); /* value was +1 for us; drop it */
    return;
  }
  p->state = SCR_PROM_FULFILLED;
  p->payload_kind = v ? SCR_EXC_REF : SCR_EXC_NONE;
  p->payload = v;
  p->retain_fn = retain;
  p->release_fn = release;
  p->trace_fn = trace;
  scr_promise_settle_wake(p);
}
void scr_promise_fulfill_void(ScrPromise *p) {
  if (p->state != SCR_PROM_PENDING) return;
  p->state = SCR_PROM_FULFILLED;
  p->payload_kind = SCR_EXC_NONE;
  scr_promise_settle_wake(p);
}

/* String payloads ride the STR kind so awaits type them precisely. */
void scr_promise_fulfill_str(ScrPromise *p, ScrStr *v) {
  if (p->state != SCR_PROM_PENDING) {
    scr_str_release(v);
    return;
  }
  p->state = SCR_PROM_FULFILLED;
  p->payload_kind = SCR_EXC_STR;
  p->payload = v; /* ownership moves in */
  p->retain_fn = (void *(*)(void *))scr_str_retain;
  p->release_fn = (void (*)(void *))scr_str_release;
  scr_promise_settle_wake(p);
}
ScrStr *scr_await_str(ScrPromise *p) {
  return scr_await_settled(p) && p->payload ? scr_str_retain((ScrStr *)p->payload) : NULL;
}

/* REJECTS `p` with the exception pending in the ACTIVE cell (moved out —
 * the cell resets, so the caller returns to the engine/loop with a clean
 * cell) and wakes waiters; the rejection enters the unhandled ledger like
 * any other. The island → static promise bridge's rejection half: its
 * settle callback converts the engine reason into a pending exception
 * (the exception bridge's one conversion), then lands it here. A no-op
 * with nothing pending; an already-settled `p` just clears the cell
 * (first settle wins, like resolve-then-throw). */
void scr_promise_reject_pending(ScrPromise *p) {
  if (!scr_exc_pending()) return;
  if (p->state == SCR_PROM_PENDING) {
    scr_promise_reject_from_cell(p, scr_exc_current_cell());
    scr_promise_settle_wake(p);
  } else {
    scr_exc_clear();
  }
}

/* ── settled-promise minting (the fs/promises bridge) ─────────────────
 * The promise-returning stdlib functions run their syscall SYNCHRONOUSLY
 * (the documented non-interleaving divergence, SEMANTICS.md) and wrap the
 * outcome here: a pending exception in the active cell becomes the
 * promise's REJECTION (moved out of the cell — the caller's pending check
 * then sees a clean cell, exactly like Node where fs/promises failures
 * reject instead of throwing), anything else fulfills with the payload.
 * The rejected case still enters the unhandled-rejection ledger, so a
 * never-awaited failure reports at exit like any other rejection. */

static ScrPromise *scr_promise_settled_common(void) {
  if (!scr_exc_pending()) return NULL;
  ScrPromise *p = scr_promise_new();
  scr_promise_reject_from_cell(p, scr_exc_current_cell());
  scr_promise_settle_wake(p); /* no waiters yet; enters the ledger */
  return p;
}

ScrPromise *scr_promise_settled_str(ScrStr *v) {
  ScrPromise *rejected = scr_promise_settled_common();
  if (rejected) {
    scr_str_release(v); /* NULL-tolerant; the op returned a dummy */
    return rejected;
  }
  ScrPromise *p = scr_promise_new();
  scr_promise_fulfill_str(p, v); /* moves in */
  return p;
}

ScrPromise *scr_promise_settled_void(void) {
  ScrPromise *rejected = scr_promise_settled_common();
  if (rejected) return rejected;
  ScrPromise *p = scr_promise_new();
  scr_promise_fulfill_void(p);
  return p;
}

ScrPromise *scr_promise_settled_ref(void *v, void *(*retain)(void *), void (*release)(void *),
                                     ScrTraceFn trace) {
  ScrPromise *rejected = scr_promise_settled_common();
  if (rejected) {
    if (v && release) release(v);
    return rejected;
  }
  ScrPromise *p = scr_promise_new();
  scr_promise_fulfill_ref(p, v, retain, release, trace); /* moves in */
  return p;
}

/* ── fs/promises ─────────────────────────────────────────────────────
 * The promise forms run the SAME sync operations and mint an already-
 * settled promise (scr_promise_settled_*): success fulfills, a pending
 * exception moves in as the rejection — catchable at the await, like
 * Node. DOCUMENTED DIVERGENCE (SEMANTICS.md): the syscall blocks the
 * event loop, so I/O never interleaves with timers or other fibers —
 * observable only in concurrent code, not in the sequential await
 * chains CLIs are made of. */

ScrPromise *scr_fsp_read_file(ScrStr *path) {
  return scr_promise_settled_str(scr_fs_read_file(path));
}

ScrPromise *scr_fsp_write_file(ScrStr *path, ScrStr *data) {
  scr_fs_write_file(path, data);
  return scr_promise_settled_void();
}

ScrPromise *scr_fsp_write_file_mode(ScrStr *path, ScrStr *data, double mode) {
  scr_fs_write_file_mode(path, data, mode);
  return scr_promise_settled_void();
}

ScrPromise *scr_fsp_mkdir(ScrStr *path) {
  scr_fs_mkdir(path);
  return scr_promise_settled_void();
}

ScrPromise *scr_fsp_mkdir_mode(ScrStr *path, double mode) {
  scr_fs_mkdir_mode(path, mode);
  return scr_promise_settled_void();
}

ScrPromise *scr_fsp_mkdir_recursive(ScrStr *path) {
  scr_fs_mkdir_recursive(path);
  return scr_promise_settled_void();
}

ScrPromise *scr_fsp_mkdir_recursive_mode(ScrStr *path, double mode) {
  scr_fs_mkdir_recursive_mode(path, mode);
  return scr_promise_settled_void();
}

ScrPromise *scr_fsp_unlink(ScrStr *path) {
  scr_fs_unlink(path);
  return scr_promise_settled_void();
}

ScrPromise *scr_fsp_chmod(ScrStr *path, double mode) {
  scr_fs_chmod(path, mode);
  return scr_promise_settled_void();
}

ScrPromise *scr_fsp_readdir(ScrStr *path) {
  ScrArr *names = scr_fs_readdir(path);
  return scr_promise_settled_ref(names, &scr_arr_retain_v, &scr_arr_release_v, NULL);
}

ScrPromise *scr_fsp_rm(ScrStr *path) {
  scr_fs_rm(path);
  return scr_promise_settled_void();
}

ScrPromise *scr_fsp_stat(ScrStr *path) {
  ScrStats *st = scr_fs_stat(path);
  return scr_promise_settled_ref(st, &scr_stats_retain_v, &scr_stats_release_v, NULL);
}

ScrPromise *scr_fsp_rename(ScrStr *oldpath, ScrStr *newpath) {
  scr_fs_rename(oldpath, newpath);
  return scr_promise_settled_void();
}

/* fs.rename(old, new, cb): the static callback surface. The OS operation
 * starts immediately on a native worker, matching libuv's key contract:
 * while JS/main is synchronously occupied, the filesystem request can still
 * make progress. Only immutable path bytes cross onto the worker. Error
 * construction, callback invocation, and every RC mutation stay on the main
 * runtime thread when a later loop turn observes completion.
 *
 * A compact operation queue is also the liveness handle: an outstanding
 * callback-style request keeps the loop alive. Four persistent workers mirror
 * libuv's default filesystem concurrency without creating one OS thread per
 * request. A platform mutex publishes each result and the syscall's filesystem
 * effects before the loop removes it from the completion queue. */
#if !defined(SCR_LIB) && !defined(__wasi__)
typedef struct ScrFsRenameOp {
  ScrStr *oldpath;
  ScrStr *newpath;
  ScrClosure *cb;
  ScrFsRenameFn fn;
  int error;
  struct ScrFsRenameOp *next;
} ScrFsRenameOp;

static ScrFsRenameOp *scr_fs_rename_work = NULL;
static ScrFsRenameOp **scr_fs_rename_work_tail = &scr_fs_rename_work;
static ScrFsRenameOp *scr_fs_rename_done = NULL;
static ScrFsRenameOp **scr_fs_rename_done_tail = &scr_fs_rename_done;
static size_t scr_fs_rename_pending_count = 0;
static size_t scr_fs_rename_worker_count = 0;
static bool scr_fs_rename_stopping = false;
static bool scr_fs_rename_shutdown_registered = false;

#ifdef _WIN32
static HANDLE scr_fs_rename_workers[4];
static SRWLOCK scr_fs_rename_lock = SRWLOCK_INIT;
static CONDITION_VARIABLE scr_fs_rename_cond = CONDITION_VARIABLE_INIT;
static void scr_fs_rename_lock_enter(void) { AcquireSRWLockExclusive(&scr_fs_rename_lock); }
static void scr_fs_rename_lock_leave(void) { ReleaseSRWLockExclusive(&scr_fs_rename_lock); }
static void scr_fs_rename_wait(void) {
  (void)SleepConditionVariableSRW(&scr_fs_rename_cond, &scr_fs_rename_lock, INFINITE, 0);
}
static void scr_fs_rename_signal(void) { WakeConditionVariable(&scr_fs_rename_cond); }
static void scr_fs_rename_broadcast(void) { WakeAllConditionVariable(&scr_fs_rename_cond); }
#else
static pthread_t scr_fs_rename_workers[4];
static pthread_mutex_t scr_fs_rename_lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t scr_fs_rename_cond = PTHREAD_COND_INITIALIZER;
static void scr_fs_rename_lock_enter(void) { (void)pthread_mutex_lock(&scr_fs_rename_lock); }
static void scr_fs_rename_lock_leave(void) { (void)pthread_mutex_unlock(&scr_fs_rename_lock); }
static void scr_fs_rename_wait(void) {
  (void)pthread_cond_wait(&scr_fs_rename_cond, &scr_fs_rename_lock);
}
static void scr_fs_rename_signal(void) { (void)pthread_cond_signal(&scr_fs_rename_cond); }
static void scr_fs_rename_broadcast(void) { (void)pthread_cond_broadcast(&scr_fs_rename_cond); }
#endif

static void scr_fs_rename_op_release(ScrFsRenameOp *op) {
  scr_str_release(op->oldpath);
  scr_str_release(op->newpath);
  scr_closure_release(op->cb);
  free(op);
}

static void scr_fs_rename_worker_loop(void) {
  for (;;) {
    scr_fs_rename_lock_enter();
    while (scr_fs_rename_work == NULL && !scr_fs_rename_stopping) scr_fs_rename_wait();
    if (scr_fs_rename_stopping) {
      scr_fs_rename_lock_leave();
      return;
    }
    ScrFsRenameOp *op = scr_fs_rename_work;
    scr_fs_rename_work = op->next;
    if (scr_fs_rename_work == NULL) scr_fs_rename_work_tail = &scr_fs_rename_work;
    scr_fs_rename_lock_leave();

    op->error = scr_fs_rename_raw(op->oldpath, op->newpath);

    scr_fs_rename_lock_enter();
    op->next = NULL;
    *scr_fs_rename_done_tail = op;
    scr_fs_rename_done_tail = &op->next;
    scr_fs_rename_lock_leave();
  }
}

#ifdef _WIN32
static DWORD WINAPI scr_fs_rename_worker(LPVOID payload) {
  (void)payload;
  scr_fs_rename_worker_loop();
  return 0;
}
#else
static void *scr_fs_rename_worker(void *payload) {
  (void)payload;
  scr_fs_rename_worker_loop();
  return NULL;
}
#endif

/* Runs before the ordinary runtime atexit cleanup/audit (it is registered
 * lazily by the first rename request, after scr_init/scr_lib_init). Fatal
 * top-level or callback exceptions can stop the loop with requests still in
 * flight; join the workers before releasing their retained path/callback
 * payloads so sanitized builds keep the program's real exit verdict. */
static void scr_fs_renames_shutdown(void) {
  scr_fs_rename_lock_enter();
  scr_fs_rename_stopping = true;
  scr_fs_rename_broadcast();
  scr_fs_rename_lock_leave();

  for (size_t i = 0; i < scr_fs_rename_worker_count; i++) {
#ifdef _WIN32
    (void)WaitForSingleObject(scr_fs_rename_workers[i], INFINITE);
    CloseHandle(scr_fs_rename_workers[i]);
#else
    (void)pthread_join(scr_fs_rename_workers[i], NULL);
#endif
  }

  scr_fs_rename_lock_enter();
  ScrFsRenameOp *work = scr_fs_rename_work;
  ScrFsRenameOp *done = scr_fs_rename_done;
  scr_fs_rename_work = NULL;
  scr_fs_rename_work_tail = &scr_fs_rename_work;
  scr_fs_rename_done = NULL;
  scr_fs_rename_done_tail = &scr_fs_rename_done;
  scr_fs_rename_pending_count = 0;
  scr_fs_rename_lock_leave();
  while (work != NULL) {
    ScrFsRenameOp *next = work->next;
    scr_fs_rename_op_release(work);
    work = next;
  }
  while (done != NULL) {
    ScrFsRenameOp *next = done->next;
    scr_fs_rename_op_release(done);
    done = next;
  }
}

static bool scr_fs_renames_pending(void) { return scr_fs_rename_pending_count != 0; }

static bool scr_fs_renames_dispatch(void) {
  scr_fs_rename_lock_enter();
  ScrFsRenameOp *op = scr_fs_rename_done;
  if (op != NULL) {
    scr_fs_rename_done = op->next;
    if (scr_fs_rename_done == NULL) scr_fs_rename_done_tail = &scr_fs_rename_done;
  }
  scr_fs_rename_lock_leave();
  if (op == NULL) return false;
  scr_fs_rename_pending_count--;
  ScrCaught *caught = NULL;
  ScrError *err = NULL;
  if (op->error != 0) {
    scr_fs_rename_error(op->error, op->oldpath, op->newpath);
    caught = scr_exc_take();
    if (caught && caught->kind == SCR_EXC_OBJ && scr_error_is(caught->payload)) {
      err = (ScrError *)caught->payload;
    }
  }
  op->fn(op->cb, err);
  scr_caught_release(caught);
  scr_fs_rename_op_release(op);
  return true;
}
#elif defined(__wasi__)
/* WASI Preview 1 has no threads, but rename itself is available. Queue the
 * request and perform it on the next loop turn so callback timing remains
 * asynchronous and the request remains a liveness handle. */
typedef struct ScrFsRenameOp {
  ScrStr *oldpath;
  ScrStr *newpath;
  ScrClosure *cb;
  ScrFsRenameFn fn;
  struct ScrFsRenameOp *next;
} ScrFsRenameOp;

static ScrFsRenameOp *scr_fs_rename_done = NULL;
static ScrFsRenameOp **scr_fs_rename_done_tail = &scr_fs_rename_done;
static size_t scr_fs_rename_pending_count = 0;

static bool scr_fs_renames_pending(void) { return scr_fs_rename_pending_count != 0; }

static bool scr_fs_renames_dispatch(void) {
  ScrFsRenameOp *op = scr_fs_rename_done;
  if (op == NULL) return false;
  scr_fs_rename_done = op->next;
  if (scr_fs_rename_done == NULL) scr_fs_rename_done_tail = &scr_fs_rename_done;
  scr_fs_rename_pending_count--;

  int error = scr_fs_rename_raw(op->oldpath, op->newpath);
  ScrCaught *caught = NULL;
  ScrError *err = NULL;
  if (error != 0) {
    scr_fs_rename_error(error, op->oldpath, op->newpath);
    caught = scr_exc_take();
    if (caught && caught->kind == SCR_EXC_OBJ && scr_error_is(caught->payload)) {
      err = (ScrError *)caught->payload;
    }
  }
  op->fn(op->cb, err);
  scr_caught_release(caught);
  scr_str_release(op->oldpath);
  scr_str_release(op->newpath);
  scr_closure_release(op->cb);
  free(op);
  return true;
}
#else
static bool scr_fs_renames_pending(void) { return false; }
static bool scr_fs_renames_dispatch(void) { return false; }
#endif

void scr_fs_rename_async(ScrStr *oldpath, ScrStr *newpath,
                         ScrClosure *cb, ScrFsRenameFn fn) {
#if defined(SCR_LIB)
  (void)oldpath; (void)newpath; (void)fn;
  scr_closure_release(cb);
  scr_trap("scriptc: callback-style fs.rename is not supported by this target\n");
#elif defined(__wasi__)
  ScrFsRenameOp *op = calloc(1, sizeof *op);
  if (!op) scr_trap("scriptc: out of memory\n");
  op->oldpath = scr_str_retain(oldpath);
  op->newpath = scr_str_retain(newpath);
  op->cb = cb;
  op->fn = fn;
  *scr_fs_rename_done_tail = op;
  scr_fs_rename_done_tail = &op->next;
  scr_fs_rename_pending_count++;
#else
  if (!scr_fs_rename_shutdown_registered) {
    if (atexit(scr_fs_renames_shutdown) != 0) {
      scr_trap("scriptc: could not register fs.rename worker cleanup\n");
    }
    scr_fs_rename_shutdown_registered = true;
  }
  ScrFsRenameOp *op = calloc(1, sizeof *op);
  if (!op) scr_trap("scriptc: out of memory\n");
  op->oldpath = scr_str_retain(oldpath);
  op->newpath = scr_str_retain(newpath);
  op->cb = cb;
  op->fn = fn;
  scr_fs_rename_pending_count++;
  scr_fs_rename_lock_enter();
  *scr_fs_rename_work_tail = op;
  scr_fs_rename_work_tail = &op->next;
  int create_error = 0;
  if (scr_fs_rename_worker_count < 4) {
#ifdef _WIN32
    HANDLE worker = CreateThread(NULL, 0, scr_fs_rename_worker, NULL, 0, NULL);
    if (worker != NULL) {
      scr_fs_rename_workers[scr_fs_rename_worker_count] = worker;
      scr_fs_rename_worker_count++;
    } else {
      create_error = EAGAIN;
    }
#else
    pthread_t worker;
    create_error = pthread_create(&worker, NULL, scr_fs_rename_worker, NULL);
    if (create_error == 0) {
      scr_fs_rename_workers[scr_fs_rename_worker_count] = worker;
      scr_fs_rename_worker_count++;
    }
#endif
  }
  if (create_error != 0 && scr_fs_rename_worker_count == 0) {
    /* Submission failure is still callback-asynchronous. No worker exists,
     * so publish every queued request as the same resource error. */
    while (scr_fs_rename_work != NULL) {
      ScrFsRenameOp *failed = scr_fs_rename_work;
      scr_fs_rename_work = failed->next;
      failed->error = create_error;
      failed->next = NULL;
      *scr_fs_rename_done_tail = failed;
      scr_fs_rename_done_tail = &failed->next;
    }
    scr_fs_rename_work_tail = &scr_fs_rename_work;
  } else {
    scr_fs_rename_signal();
  }
  scr_fs_rename_lock_leave();
#endif
}

void scr_fs_rename_thunk0(ScrClosure *cb, ScrError *err) {
  (void)err;
  ((void (*)(ScrClosure *))cb->fn)(cb);
}

/* ── node:timers/promises ────────────────────────────────────────────
 * The promisified pair: a PENDING void promise a one-shot heap timer
 * (setTimeout) or the immediate queue (setImmediate) fulfills — the
 * resolve closure is scr_make_resolve's void thunk, so settlement wakes
 * awaiting fibers exactly like every other promise, and the armed
 * timer/immediate keeps the loop alive until it fires (Node: an awaited
 * timers/promises sleep holds the process open). Neither throws; the
 * delay rides scr_set_timeout's own Node-exact coercion (clamp to 1,
 * truncate). */

ScrPromise *scr_tp_set_timeout(double ms) {
  ScrPromise *p = scr_promise_new();
  scr_set_timeout(scr_make_resolve(p, 3 /* void */), ms);
  return p;
}

ScrPromise *scr_tp_set_immediate(void) {
  ScrPromise *p = scr_promise_new();
  scr_set_immediate(scr_make_resolve(p, 3 /* void */));
  return p;
}

/* ── setImmediate as a first-class dyn value ─────────────────────────
 * The global passed AS A FUNCTION VALUE into untyped code (the Node-suite
 * traceCallback shape: `channel.traceCallback(setImmediate, 0, ctx, null,
 * cb)`). The minted dyn callable schedules its own immediate that calls
 * args[0] with the remaining arguments (Node's setImmediate(cb, ...args)
 * contract) and answers undefined (the Immediate handle object has no dyn
 * story — clearImmediate over this value is not modeled). A non-function
 * first argument throws Node's ERR_INVALID_ARG_TYPE synchronously. */

static void scr_imm_dyn_fire(ScrClosure *c) {
  ScrDyn *fn = (ScrDyn *)scr_box_get_ref(c->caps[0]);
  ScrDyn *args = (ScrDyn *)scr_box_get_ref(c->caps[1]);
  ScrDyn *r = scr_dyn_call(fn, args->v.arr.items, args->v.arr.len, "immediate callback");
  if (r != NULL) scr_dyn_release(r);
  scr_dyn_release(fn);
  scr_dyn_release(args);
}

static ScrDyn *scr_imm_dyn_thunk(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  (void)clo;
  if (argc == 0 || args[0]->kind != SCR_DYN_FUNC) {
    static const char msg[] = "The \"callback\" argument must be of type function.";
    scr_throw_error_msg_code(SCR_ERR_TYPE, msg, sizeof msg - 1, "ERR_INVALID_ARG_TYPE");
    return NULL;
  }
  ScrDyn *rest = scr_dyn_new_arr();
  for (size_t i = 1; i < argc; i++) scr_dyn_arr_push(rest, scr_dyn_retain(args[i]));
  ScrClosure *c = scr_closure_new((void *)scr_imm_dyn_fire, 2);
  c->caps[0] = scr_box_new_obj(scr_dyn_retain_v, scr_dyn_release_v, NULL);
  scr_box_set_ref(c->caps[0], scr_dyn_retain(args[0]));
  c->caps[1] = scr_box_new_obj(scr_dyn_retain_v, scr_dyn_release_v, NULL);
  scr_box_set_ref(c->caps[1], rest); /* moves */
  scr_set_immediate(c);
  return scr_dyn_retain(scr_dyn_undefined());
}

ScrDyn *scr_set_immediate_dyn_value(void) {
  return scr_dyn_new_func(scr_closure_new((void *)scr_imm_dyn_thunk, 0), scr_imm_dyn_thunk,
                          1, "(cb,...)", "setImmediate");
}

/* ── queueMicrotask ──────────────────────────────────────────────────
 * The READY queue's FIFO is the microtask queue (promise continuations
 * ride it as parked fibers), so a queueMicrotask callback enters the SAME
 * queue as a stackless envelope — one order across both producers, like
 * V8's single microtask queue. scr_resume_fiber runs the closure on the
 * main stack; a throw is an uncaught exception (Node's queueMicrotask),
 * never a rejection. */
void scr_queue_microtask(ScrClosure *cb) {
  ScrFiber *f = calloc(1, sizeof *f);
  if (!f) scr_oom();
  f->micro_cb = cb; /* ownership moves in */
  scr_ready_push(f);
}

/* The checked-dynamic argument form (JS files — common.mustCall wrappers
 * and the suite's invalid-input probes): a non-function throws Node's
 * ERR_INVALID_ARG_TYPE synchronously; a function value is called with
 * zero arguments (Node passes none — extra queueMicrotask arguments are
 * ignored). */
static void scr_micro_dyn_fire(ScrClosure *c) {
  ScrDyn *fn = (ScrDyn *)scr_box_get_ref(c->caps[0]);
  ScrDyn *r = scr_dyn_call(fn, NULL, 0, "queueMicrotask callback");
  if (r != NULL) scr_dyn_release(r);
  scr_dyn_release(fn);
}

void scr_queue_microtask_dyn(const ScrDyn *cb) {
  if (cb->kind != SCR_DYN_FUNC) {
    static const char msg[] = "The \"callback\" argument must be of type function.";
    scr_throw_error_msg_code(SCR_ERR_TYPE, msg, sizeof msg - 1, "ERR_INVALID_ARG_TYPE");
    return;
  }
  ScrClosure *c = scr_closure_new((void *)scr_micro_dyn_fire, 1);
  c->caps[0] = scr_box_new_obj(scr_dyn_retain_v, scr_dyn_release_v, NULL);
  scr_box_set_ref(c->caps[0], scr_dyn_retain((ScrDyn *)cb));
  scr_queue_microtask(c);
}

/* ── the event hooks (scr_events.c) ──────────────────────────────────
 * Process signal/exit events and the piped-stdin surface live in
 * scr_events.c, which links ONLY into binaries whose IR uses those
 * surfaces (the io-hook precedent, gated like scr_regex/scr_fetch):
 * scr_events_install() fills these slots before %main. Event-free
 * builds keep every slot NULL and the loop is byte-identical in
 * behavior. The scr_lib.c hooks live in scr_lib.c and the abnormal-exit
 * code hint in scr_exception.c, so each unit stays self-contained (the
 * runtime C tests link them separately). */

static bool (*scr_events_pending_fn)(void) = NULL;  /* keeps the loop alive */
static bool (*scr_events_watching_fn)(void) = NULL; /* wants the poll sleep */
static void (*scr_events_dispatch_fn)(void) = NULL; /* fire due listeners */
static int (*scr_events_pollfds_fn)(int out[2]) = NULL;

void scr_loop_set_events(bool (*pending)(void), bool (*watching)(void),
                          void (*dispatch)(void), int (*pollfds)(int out[2])) {
  scr_events_pending_fn = pending;
  scr_events_watching_fn = watching;
  scr_events_dispatch_fn = dispatch;
  scr_events_pollfds_fn = pollfds;
}

/* ── the event loop ───────────────────────────────────────────────────── */

static void scr_resume_fiber(ScrFiber *f) {
  /* A queueMicrotask envelope: run the closure on the main stack, no
   * context switch. A throw leaves the exception cell pending — every
   * drain site returns to main's uncaught report, Node's queueMicrotask
   * semantics (uncaughtException, never an unhandled rejection). */
  if (f->micro_cb != NULL) {
    ScrClosure *cb = f->micro_cb;
    free(f);
    ((void (*)(ScrClosure *))cb->fn)(cb);
    scr_closure_release(cb);
    return;
  }
#ifdef _WIN32
  /* The loop runs on the main stack; make sure scr_loop_ctx names its
   * fiber handle (a no-op after the first conversion). */
  (void)scr_win_self();
#endif
  f->return_to = &scr_loop_ctx;
#ifdef __wasi__
  scr_current = f;
  scr_exc_swap_cell(&f->exc);
  scr_als_active = &f->als;
  if (f->coro != NULL) {
    scr_wasi_coro_resume(f->coro);
  } else {
    /* scr_async_spawn_after's runtime C continuation. Its dependency is
     * settled, so the entry can extract through scr_await_* without a
     * stack switch and then completes in this turn. */
    f->entry(f, f->argpack);
    scr_fiber_finish(f);
  }
  scr_current = NULL;
  scr_exc_swap_cell(NULL);
  scr_als_active = &scr_als_main_slot;
#else
  scr_switch(&scr_loop_ctx, &f->ctx, f);
#endif
  if (f->done) {
    scr_promise_release(f->promise);
    scr_fiber_destroy(f);
    scr_fibers_live--;
  }
}

/* Reap granularity while children are pending on the POLLING fallback:
 * the loop polls waitpid(WNOHANG) at least this often instead of sleeping
 * to the next timer deadline. The primary path has no cap — the sleep
 * waits on the child watch (scr_children_wait — kqueue NOTE_EXIT on BSD,
 * pidfd epoll on Linux, the timer deadline riding the wait timeout) and a
 * child's exit wakes it immediately. The fallback covers platforms with
 * neither backend, children whose exit watch could not be armed, and
 * turns where the io poll takes the sleep (curl's fds can't join it). */
#define SCR_CHILD_POLL_MS 1.0

/* Sleep cap while only external io is pending (no timer models its
 * wakeup): the io poll sleeps on REAL fds inside this window (a fetch
 * transfer's sockets wake it early), so a generous cap costs nothing. */
#define SCR_IO_POLL_MS 1000.0

/* Sleep cap while signal handlers or stdin consumers are pending AND the
 * io poll owns the sleep (curl's fd wait retries on EINTR and can't watch
 * the wake pipe): bounded signal/stdin latency during a fetch at 20
 * wakeups/second. The dedicated poll(2) sleep needs no cap — it waits on
 * the wake pipe and fd 0 directly. */
#define SCR_SIGNAL_POLL_MS 50.0

/* The external io hook (scr_runtime.h): the dynamic island registers
 * engine-job draining + fetch transfer polling here. Static builds never
 * set it — both slots stay NULL and the loop is byte-identical in
 * behavior. */
static bool (*scr_io_pending_fn)(void) = NULL;
static void (*scr_io_poll_fn)(double max_wait_ms) = NULL;

void scr_loop_set_io(bool (*pending)(void), void (*poll)(double)) {
  scr_io_pending_fn = pending;
  scr_io_poll_fn = poll;
}

/* The island's earliest armed timer deadline (HUGE_VAL when none): caps
 * the sleep below so an armed AbortSignal.timeout fires on time while
 * the loop waits on socket readiness — without keeping the loop alive by
 * itself (the liveness test never consults it, Node's unref'd timer). */
static double (*scr_island_deadline_fn)(void) = NULL;

void scr_loop_set_island_deadline(double (*fn)(void)) { scr_island_deadline_fn = fn; }

/* The net hook (scr_net.c, when linked — the events-hook shape):
 * `pending` keeps the loop alive while servers/sockets are live,
 * `dispatch` fires at every turn top, and `pollfd` is the unit's poller
 * fd for the idle poll(2) sleep (readable while events are pending —
 * kqueue and epoll fds both behave this way).
 * Net-free builds keep every slot NULL and the loop is byte-identical. */
static bool (*scr_net_pending_fn)(void) = NULL;
static void (*scr_net_dispatch_fn)(void) = NULL;
static int (*scr_net_pollfd_fn)(void) = NULL;

void scr_loop_set_net(bool (*pending)(void), void (*dispatch)(void), int (*pollfd)(void)) {
  scr_net_pending_fn = pending;
  scr_net_dispatch_fn = dispatch;
  scr_net_pollfd_fn = pollfd;
}

/* The dgram hook (scr_dgram.c, when linked) — the net hook's exact shape:
 * one more set of nullable slots, byte-identical loop behavior when
 * unset. */
static bool (*scr_dgram_pending_fn)(void) = NULL;
static void (*scr_dgram_dispatch_fn)(void) = NULL;
static int (*scr_dgram_pollfd_fn)(void) = NULL;

void scr_loop_set_dgram(bool (*pending)(void), void (*dispatch)(void), int (*pollfd)(void)) {
  scr_dgram_pending_fn = pending;
  scr_dgram_dispatch_fn = dispatch;
  scr_dgram_pollfd_fn = pollfd;
}

/* The dns resolve and reverse threadpool hook (scr_dgram.c, when linked):
 * a nullable pending-only slot — in-flight jobs hold the loop alive and
 * cap the idle sleep at the child-reap granularity (the fs rename
 * worker's exact story: no platform poll handle, so completion is
 * noticed by the next short turn). */
static bool (*scr_dns_jobs_fn)(void) = NULL;

void scr_loop_set_dns_jobs(bool (*jobs_pending)(void)) { scr_dns_jobs_fn = jobs_pending; }

/* The fs.watch hook (scr_watch.c, when linked) — the net hook's exact
 * shape: one more set of nullable slots, byte-identical loop behavior
 * when unset. */
static bool (*scr_watch_pending_fn)(void) = NULL;
static void (*scr_watch_dispatch_fn)(void) = NULL;
static int (*scr_watch_pollfd_fn)(void) = NULL;

void scr_loop_set_watch(bool (*pending)(void), void (*dispatch)(void), int (*pollfd)(void)) {
  scr_watch_pending_fn = pending;
  scr_watch_dispatch_fn = dispatch;
  scr_watch_pollfd_fn = pollfd;
}

/* The foreign-FFI queue hook (scr_ffi.c when a format-5 descriptor exists).
 * Its pending count includes live registrations (reffed by default) and
 * queued deliveries; dispatch runs exactly one callback per loop turn. */
static bool (*scr_ffi_pending_fn)(void) = NULL;
static bool (*scr_ffi_dispatch_fn)(void) = NULL;
static int (*scr_ffi_pollfd_fn)(void) = NULL;
static void (*scr_ffi_stop_fn)(void) = NULL;

void scr_loop_set_ffi(bool (*pending)(void), bool (*dispatch)(void),
                      int (*pollfd)(void), void (*stop)(void)) {
  scr_ffi_pending_fn = pending;
  scr_ffi_dispatch_fn = dispatch;
  scr_ffi_pollfd_fn = pollfd;
  scr_ffi_stop_fn = stop;
}

/* The stream hook (scr_stream.c, when linked): `pending` keeps the loop
 * alive while deferred stream ticks exist, `dispatch` drains them at the
 * TOP of every turn — before the events/net stations, the closest
 * placement to Node's process.nextTick (whose stream emissions these
 * are). No poller fd: ticks are pure CPU work, always ready. */
static bool (*scr_stream_pending_fn)(void) = NULL;
static void (*scr_stream_dispatch_fn)(void) = NULL;

void scr_loop_set_stream(bool (*pending)(void), void (*dispatch)(void)) {
  scr_stream_pending_fn = pending;
  scr_stream_dispatch_fn = dispatch;
}

/* Dispatch hooks yield between event batches when fibers are already
 * queued, so promise jobs interleave with event delivery (Node's
 * microtask checkpoints between macrotasks). */
bool scr_loop_has_ready(void) { return scr_ready_len > 0; }

bool scr_loop_run(ScrPromise *top_level) {
  /* The FIRST checkpoint after the synchronous main body runs promise
   * jobs BEFORE the first tick drain: Node's main-module evaluation is
   * itself awaited (the runMain continuation is a microtask queued after
   * the body's own), so microtasks scheduled during the body beat ticks
   * scheduled during the body exactly once, at startup — differentially
   * pinned. Every later checkpoint drains ticks first. */
  bool first_checkpoint = true;
  bool rejection_failed = false;
  for (;;) {
    if (top_level != NULL && top_level->state == SCR_PROM_REJECTED) break;
    /* process.nextTick callbacks BEFORE promise jobs (Node's checkpoint
     * order): the tick queue to exhaustion, then the microtask queue to
     * exhaustion, and back while either has work — a microtask's
     * nextTick runs before the turn proceeds, but never preempts the
     * microtask queue mid-drain (V8 drains it fully). A tick's uncaught
     * throw ends the loop like any listener's (main reports it). */
    if (!first_checkpoint) {
      while (scr_nt_head != NULL) {
        ScrNtick *t = scr_nt_head;
        scr_nt_head = t->next;
        if (scr_nt_head == NULL) scr_nt_tail = NULL;
        ScrClosure *cb = t->cb;
        ScrFsRenameFn error_cb = t->error_cb;
        void (*raw)(void) = t->raw;
        free(t);
        if (cb) {
          if (error_cb) error_cb(cb, NULL);
          else ((void (*)(ScrClosure *))cb->fn)(cb);
          scr_closure_release(cb);
        } else {
          raw(); /* one stream tick, FIFO with the user ticks around it */
        }
        if (scr_exc_pending()) return false;
      }
    }
    /* Microtasks to exhaustion (Node: promise jobs before timers). */
    while (scr_ready_len > 0) {
      ScrFiber *f = scr_ready[scr_ready_head++];
      scr_ready_len--;
      scr_resume_fiber(f);
    }
    first_checkpoint = false;
    /* The ESM loader observes a rejected entry evaluation at a promise-job
     * checkpoint and terminates before later ref'd timers or I/O can run.
     * Wait until this checkpoint's ready queue is drained — the root's
     * rejection handler is itself promise-job ordered — then leave through
     * the normal teardown below. A fulfilled root deliberately does not
     * stop the loop. */
    if (top_level != NULL && top_level->state == SCR_PROM_REJECTED) break;
    if (scr_nt_head != NULL) continue;
    /* Node decides unhandled rejections at the END of each complete
     * nextTick/microtask checkpoint, before advancing to timers or I/O.
     * A rejected executable module root wins over OTHER rejections from
     * this same checkpoint (the root check above); rejections from an
     * earlier checkpoint have already delivered here. Handled listeners
     * may enqueue more jobs or ref'd work, so return to the checkpoint
     * head instead of declaring the loop exhausted underneath them. */
    if (scr_report_unhandled_rejections()) {
      rejection_failed = true;
      break;
    }
    if (scr_ready_len > 0 || scr_nt_head != NULL || scr_nunhandled > 0) continue;
    /* Quiescent between turns (microtasks drained, nothing running):
     * collect any cycles the turn left behind. One SCHEDULED pass — almost
     * always a nursery one, sized to the turn's own garbage. A full sweep
     * here would walk the whole live heap every turn, which is precisely
     * what the generations exist to avoid. No-op on an empty buffer. */
    scr_cyc_collect_scheduled();
    /* Completed callback-style filesystem work is delivered on the main
     * runtime thread. A worker may have finished while synchronous user code
     * occupied that thread. Deliver exactly one completion per checkpoint:
     * Node drains nextTicks and microtasks after each native callback before
     * invoking the next ready callback. */
    if (scr_fs_renames_pending()) {
      bool dispatched = scr_fs_renames_dispatch();
      if (scr_exc_pending()) return false;
      if (dispatched) continue;
    }
    /* Foreign native callbacks are macrotasks. Deliver one, then restart at
     * the microtask checkpoint before considering the next queued post. */
    if (scr_ffi_dispatch_fn != NULL && scr_ffi_dispatch_fn()) {
      if (scr_exc_pending()) return false;
      if (scr_ready_len > 0 || scr_nt_head != NULL || scr_nunhandled > 0) continue;
    }
    /* Stream tick dispatch (scr_stream.c, when linked): the deferred
     * next-tick emissions ('data' flow kicks, 'readable'/'end'/'finish'/
     * 'drain'/'error'/'close') fire now, FIRST — the nextTick station.
     * Listeners may enqueue microtasks or more ticks — restart the turn
     * so those drain first. */
    if (scr_stream_dispatch_fn != NULL) {
      scr_stream_dispatch_fn();
      if (scr_exc_pending()) return false; /* uncaught throw in a listener */
      if (scr_ready_len > 0) continue;
      if (scr_stream_pending_fn != NULL && scr_stream_pending_fn()) continue;
    }
    /* Event dispatch (scr_events.c, when linked): watched signals
     * delivered since the last turn fire their listeners now (macrotasks,
     * like timers), then stdin — while a consumer exists, probe fd 0 and
     * deliver one arrived chunk / the EOF events. Both may enqueue
     * microtasks — restart the turn so those drain first. */
    if (scr_events_dispatch_fn != NULL) {
      scr_events_dispatch_fn();
      if (scr_exc_pending()) return false; /* uncaught throw in a listener */
      if (scr_ready_len > 0) continue;
    }
    /* Net dispatch (scr_net.c, when linked): accepts, arrived data,
     * connect completions, and the deferred listening/error/close emits
     * fire now (macrotasks, like the events hook). Callbacks may enqueue
     * microtasks — restart the turn so those drain first. */
    if (scr_net_dispatch_fn != NULL) {
      scr_net_dispatch_fn();
      if (scr_exc_pending()) return false; /* uncaught throw in a listener */
      if (scr_ready_len > 0) continue;
    }
    /* Dgram dispatch (scr_dgram.c, when linked): arrived datagrams and
     * the deferred listening/connect/error/close emits (plus pending
     * dns.lookup callbacks) fire now — the net hook's exact station. */
    if (scr_dgram_dispatch_fn != NULL) {
      scr_dgram_dispatch_fn();
      if (scr_exc_pending()) return false; /* uncaught throw in a listener */
      if (scr_ready_len > 0) continue;
    }
    /* Watch dispatch (scr_watch.c, when linked): file events queued on
     * the unit's event backend fire their FSWatcher listeners now — the
     * net hook's exact station. */
    if (scr_watch_dispatch_fn != NULL) {
      scr_watch_dispatch_fn();
      if (scr_exc_pending()) return false; /* uncaught throw in a listener */
      if (scr_ready_len > 0) continue;
    }
    /* Reap spawned children and fire their listeners (before timers,
     * like Node's nextTick-ish spawn-failure "error"). A callback may
     * enqueue microtasks or spawn again — restart the turn if so.
     * EXCEPT when ONLY unref'd children remain: Node's liveness check
     * precedes any further poll/reap, so once nothing reffed holds the
     * loop their pending exits are DROPPED at loop exit — never
     * delivered. Without this gate the kill-then-exit shape (a timer's
     * last act kills an unref'd child) would race machine timing: a
     * death landing before this sweep fired its 'exit' where Node
     * deterministically never does. The teardown below releases the
     * undelivered listeners, so the RC audit stays clean. */
    if (scr_children_pending()) {
      bool held =
          scr_reffed_timers > 0 || scr_reffed_immediates > 0 || scr_children_reffed_pending() ||
          /* spawn failures settle regardless: their 'error' is a
           * next-tick event, delivered even on an unref'd child */
          scr_children_failed_pending() ||
          (scr_io_pending_fn != NULL && scr_io_pending_fn()) ||
          (scr_events_pending_fn != NULL && scr_events_pending_fn()) ||
          (scr_net_pending_fn != NULL && scr_net_pending_fn()) ||
          (scr_dgram_pending_fn != NULL && scr_dgram_pending_fn()) ||
          (scr_watch_pending_fn != NULL && scr_watch_pending_fn()) ||
          (scr_ffi_pending_fn != NULL && scr_ffi_pending_fn()) ||
          scr_fs_renames_pending();
      if (held) {
        scr_children_poll();
        if (scr_exc_pending()) return false; /* uncaught throw in a listener */
        if (scr_ready_len > 0) continue;
      }
    }
    /* Deferred stream ticks are always-ready work: never sleep or exit
     * while any exist (the dispatch above drains them, so reaching here
     * with ticks pending means a dispatch station enqueued more). User
     * nextTicks enqueued by a station listener are the same story. */
    if (scr_stream_pending_fn != NULL && scr_stream_pending_fn()) continue;
    if (scr_nt_head != NULL) continue;
    bool kids = scr_children_pending();
    bool io = scr_io_pending_fn != NULL && scr_io_pending_fn();
    bool events = scr_events_pending_fn != NULL && scr_events_pending_fn();
    bool net = scr_net_pending_fn != NULL && scr_net_pending_fn();
    bool dgram = scr_dgram_pending_fn != NULL && scr_dgram_pending_fn();
    bool dnsq = scr_dns_jobs_fn != NULL && scr_dns_jobs_fn();
    bool watch = scr_watch_pending_fn != NULL && scr_watch_pending_fn();
    bool ffi = scr_ffi_pending_fn != NULL && scr_ffi_pending_fn();
    bool renames = scr_fs_renames_pending();
    /* Timer liveness counts only REF'd timers: an unref'd timer stays in
     * the heap (and fires if the loop runs on for other reasons) but does
     * not by itself keep the process alive — Node's unref semantics.
     * Children follow the same rule: an unref'd child is still REAPED
     * while the loop runs (kids drives the sweeps and sleeps above) but
     * only reffed ones keep the process alive. */
    if (scr_reffed_timers == 0 && scr_reffed_immediates == 0 && !scr_children_reffed_pending() && !io && !events && !net && !dgram && !dnsq && !watch && !ffi && !renames) break;
    /* Sleep to the earliest deadline, then run every due timer (each may
     * enqueue microtasks, which the next iteration drains first). Who
     * sleeps depends on what is pending:
     * - external io: the io POLL takes the sleep — it waits on real fds
     *   up to the deadline (socket readiness wakes it early) and makes
     *   progress (engine jobs, arrived response data) before timers run.
     *   A child's exit can't wake curl's fds, so children re-impose the
     *   reap-granularity cap on this path.
     * - signals watched or stdin consumed: poll(2) takes the sleep — the
     *   wake pipe, fd 0, and the child watch's fd together, so any of
     *   them ends it immediately (details at the branch).
     * - children only: the sleep waits on the child watch — the exit
     *   wakeup and the timer deadline together via the wait timeout — so a
     *   child's exit ends the sleep immediately and the next turn's reap
     *   pass fires its listeners. scr_children_wait declines when it
     *   can't wake for every pending child; the ~1ms polling cap is the
     *   fallback.
     * - timers only: plain nanosleep to the deadline. */
    double now = scr_now_ms();
    double due = scr_ntimers > 0 ? scr_timers[0].deadline_ms : now + SCR_IO_POLL_MS;
    /* The rename worker has no platform poll handle yet. Bound the idle
     * wait exactly like the portable child fallback so completion is noticed
     * promptly even when another poller owns the sleep. */
    if (renames && due > now + SCR_CHILD_POLL_MS) due = now + SCR_CHILD_POLL_MS;
    if (dnsq && due > now + SCR_CHILD_POLL_MS) due = now + SCR_CHILD_POLL_MS;
    /* An armed island timer (AbortSignal.timeout) caps the sleep: it must
     * fire on time even while the poller waits on socket readiness. */
    if (scr_island_deadline_fn != NULL) {
      double isl_due = scr_island_deadline_fn();
      if (isl_due < due) due = isl_due;
    }
    /* Pending immediates are always-ready work: no sleep — run due timers
     * (Node's timers phase precedes check), then the check phase below. */
    if (scr_pending_immediates > 0) due = now;
    bool evw = scr_events_watching_fn != NULL && scr_events_watching_fn();
    if (io) {
      if (kids && due > now + SCR_CHILD_POLL_MS) due = now + SCR_CHILD_POLL_MS;
      /* Signals/stdin/net can't wake curl's fd wait (and its poll retries
       * on EINTR), so they re-impose a coarser cap — bounded Ctrl-C and
       * socket latency during a fetch, without the reap-granularity
       * cost. */
      else if ((evw || net || dgram || watch || ffi) && due > now + SCR_SIGNAL_POLL_MS) due = now + SCR_SIGNAL_POLL_MS;
      scr_io_poll_fn(due > now ? due - now : 0);
      now = scr_now_ms();
      if (scr_ready_len > 0) continue; /* io callbacks woke fibers */
    } else if (evw || net || dgram || watch || ffi) {
#if defined(_WIN32) || defined(__wasi__)
      /* The win32 arm, and WASI hosts whose poll_oneoff adapters do not
       * reliably wake for a closed inherited stdin pipe: the sleep is a capped nanosleep and
       * the next turn's dispatch does the work — signal flags (set by the
       * CRT handler on msvcrt's console-ctrl thread) and the stdin probe
       * at SCR_SIGNAL_POLL_MS granularity (scr_events.c), socket/dgram
       * readiness at the child-reap cap (scr_loop_wsapoll.c's zero-timeout
       * WSAPoll drains at dispatch; ~1ms keeps loopback exchanges inside
       * the granularity Node's IOCP-woken loop delivers, where 50ms could
       * reorder a socket emit past a short timer). When the caps ever
       * show up in a profile, the upgrade is a real waitable arm —
       * WaitForMultipleObjects over WSAEVENTs, or IOCP. */
      if (evw && due > now + SCR_SIGNAL_POLL_MS) due = now + SCR_SIGNAL_POLL_MS;
      if ((net || dgram || watch) && due > now + SCR_CHILD_POLL_MS) due = now + SCR_CHILD_POLL_MS;
      if (ffi && due > now + SCR_CHILD_POLL_MS) due = now + SCR_CHILD_POLL_MS;
      if (kids && due > now + SCR_CHILD_POLL_MS) due = now + SCR_CHILD_POLL_MS;
      if (due > now) {
        double wait = due - now;
        struct timespec ts = {(time_t)(wait / 1000.0), (long)((wait - (double)((time_t)(wait / 1000.0)) * 1000.0) * 1e6)};
        nanosleep(&ts, NULL);
      }
      now = scr_now_ms();
#else
      /* poll(2) takes the sleep: the events unit's fds — the signal wake
       * pipe (a signal delivered BEFORE the poll entered still has its
       * byte in the pipe — no lost-wakeup race) and fd 0 while stdin has
       * a consumer — plus the child watch's fd when it can represent
       * every pending child (kqueue and epoll fds poll readable when
       * events are pending); unrepresentable children keep the ~1ms reap cap
       * instead. Dispatch happens at the next turn's top — the poll only
       * decides how long to sleep. */
      struct pollfd fds[7];
      int nfds = 0;
      int evfds[2];
      int nev = evw && scr_events_pollfds_fn != NULL ? scr_events_pollfds_fn(evfds) : 0;
      for (int i = 0; i < nev; i++) {
        fds[nfds].fd = evfds[i];
        fds[nfds].events = POLLIN;
        fds[nfds++].revents = 0;
      }
      if (net) {
        /* The net unit's poller fd: readable while socket events are
         * pending, so arrived data/accepts end the sleep immediately.
         * Dispatch (which also DRAINS the poller) happens at the next
         * turn's top — the poll only decides how long to sleep. */
        int nfd = scr_net_pollfd_fn != NULL ? scr_net_pollfd_fn() : -1;
        if (nfd >= 0) {
          fds[nfds].fd = nfd;
          fds[nfds].events = POLLIN;
          fds[nfds++].revents = 0;
        } else if (due > now + SCR_SIGNAL_POLL_MS) {
          due = now + SCR_SIGNAL_POLL_MS;
        }
      }
      if (dgram) {
        /* The dgram unit's poller fd — the net slot's exact story. */
        int dfd = scr_dgram_pollfd_fn != NULL ? scr_dgram_pollfd_fn() : -1;
        if (dfd >= 0) {
          fds[nfds].fd = dfd;
          fds[nfds].events = POLLIN;
          fds[nfds++].revents = 0;
        } else if (due > now + SCR_SIGNAL_POLL_MS) {
          due = now + SCR_SIGNAL_POLL_MS;
        }
      }
      if (watch) {
        /* The watch unit's event fd — the net slot's exact story. */
        int wfd = scr_watch_pollfd_fn != NULL ? scr_watch_pollfd_fn() : -1;
        if (wfd >= 0) {
          fds[nfds].fd = wfd;
          fds[nfds].events = POLLIN;
          fds[nfds++].revents = 0;
        } else if (due > now + SCR_SIGNAL_POLL_MS) {
          due = now + SCR_SIGNAL_POLL_MS;
        }
      }
      if (ffi) {
        int ffd = scr_ffi_pollfd_fn != NULL ? scr_ffi_pollfd_fn() : -1;
        if (ffd >= 0) {
          fds[nfds].fd = ffd;
          fds[nfds].events = POLLIN;
          fds[nfds++].revents = 0;
        } else if (due > now + SCR_CHILD_POLL_MS) {
          due = now + SCR_CHILD_POLL_MS;
        }
      }
      if (kids) {
        int cfd = scr_children_wake_fd();
        if (cfd >= 0) {
          fds[nfds].fd = cfd;
          fds[nfds].events = POLLIN;
          fds[nfds++].revents = 0;
        } else if (due > now + SCR_CHILD_POLL_MS) {
          due = now + SCR_CHILD_POLL_MS;
        }
      }
      double wait = due > now ? due - now : 0;
      if (wait > 1e9) wait = 1e9; /* poll takes int ms */
      (void)poll(fds, (nfds_t)nfds, (int)(wait + 0.999));
      /* Consume queued child-exit events NOW (zero-timeout drain) — an
       * unconsumed event keeps the kqueue fd readable and would turn the
       * next poll into a busy spin while other children still run. The
       * WNOHANG sweep at the next turn's top stays the reaper. */
      if (kids) (void)scr_children_wait(0);
      now = scr_now_ms();
#endif /* !_WIN32 && !__wasi__ */
    } else if (kids && scr_children_wait(due > now ? due - now : 0)) {
      now = scr_now_ms(); /* woke early on an exit, or hit the deadline */
    } else {
      if (kids && due > now + SCR_CHILD_POLL_MS) due = now + SCR_CHILD_POLL_MS;
      if (due > now) {
        double wait = due - now;
        struct timespec ts = {(time_t)(wait / 1000.0), (long)((wait - (double)((time_t)(wait / 1000.0)) * 1000.0) * 1e6)};
        nanosleep(&ts, NULL);
        now = due;
      }
    }
    while (scr_ntimers > 0 && scr_timers[0].deadline_ms <= now) {
      ScrTimer t = scr_timer_pop();
      /* Timer callbacks are plain sync closures, run on the main stack.
       * An interval entry is OUT of the heap while its callback runs;
       * clearInterval(its own id) from inside sets the firing flag and
       * the re-arm below drops it instead. A throw kills the interval
       * with the program (Node: the uncaught exception ends the process
       * before any rescheduled tick could run). */
      if (t.id != 0) {
        scr_firing_id = t.id;
        scr_firing_cleared = false;
        scr_firing_reffed = t.reffed; /* unref/ref during the callback lands here */
        scr_firing_refresh = false;
      }
      ((void (*)(ScrClosure *))t.cb->fn)(t.cb);
      if (t.id != 0 && t.repeat_ms > 0 && !scr_firing_cleared && !scr_exc_pending()) {
        /* Re-arm relative to the post-callback clock (libuv's uv_timer
         * repeat behavior: no catch-up bursts after a slow callback). The
         * ref state carries across ticks (a self-unref'd interval stays
         * unref'd). */
        ScrTimer again = {scr_now_ms() + t.repeat_ms, scr_timer_seq++, t.cb, t.repeat_ms, t.id, scr_firing_reffed, t.delay_ms};
        scr_timer_push(again);
      } else if (t.id != 0 && scr_firing_refresh && !scr_firing_cleared && !scr_exc_pending()) {
        /* refresh() from inside the one-shot's own callback: re-arm to
         * now + the original delay, ref state carried (Node's
         * Timeout.refresh — the timer fires again). */
        ScrTimer again = {scr_now_ms() + t.delay_ms, scr_timer_seq++, t.cb, 0, t.id, scr_firing_reffed, t.delay_ms};
        scr_timer_push(again);
      } else {
        scr_closure_release(t.cb);
      }
      scr_firing_id = 0;
      if (scr_exc_pending()) return false; /* uncaught throw in a callback: main handles it */
      if (scr_ready_len > 0) break; /* drain microtasks before more timers */
    }
    /* The check phase: immediates queued BEFORE this phase started run
     * now, FIFO; ones a callback queues wait for the next turn (the end
     * snapshot — Node's once-per-turn rule, so a setImmediate chain can't
     * starve the loop). Cleared slots (cb NULL) skip. Microtasks drain
     * between callbacks, like Node's inter-macrotask checkpoints; a woken
     * fiber restarts the turn first (the timer loop's break above), so the
     * phase only runs on a drained queue. */
    if (scr_ready_len == 0 && scr_pending_immediates > 0) {
      size_t end = scr_nimmediates;
      while (scr_immediates_head < end) {
        size_t i = scr_immediates_head++;
        ScrClosure *cb = scr_immediates[i].cb;
        if (cb == NULL) continue; /* cleared */
        scr_immediates[i].cb = NULL; /* fired: clear/ref/unref on this id no-op now */
        if (scr_pending_immediates > 0) scr_pending_immediates--;
        if (scr_immediates[i].reffed) {
          scr_immediates[i].reffed = false;
          if (scr_reffed_immediates > 0) scr_reffed_immediates--;
        }
        ((void (*)(ScrClosure *))cb->fn)(cb);
        scr_closure_release(cb);
        if (scr_exc_pending()) return false; /* uncaught throw: main handles it */
        while (scr_ready_len > 0) {
          ScrFiber *f = scr_ready[scr_ready_head++];
          scr_ready_len--;
          scr_resume_fiber(f);
        }
        if (top_level != NULL && top_level->state == SCR_PROM_REJECTED) break;
      }
      /* Fully drained: reset the cursor so the array reuses its slots. */
      if (scr_immediates_head == scr_nimmediates) {
        scr_immediates_head = 0;
        scr_nimmediates = 0;
      }
    }
  }
  /* Exit can now leave UNREF'd timers armed in the heap (ordinary
   * exhaustion, a fatal module root, or an unhandled rejection). They
   * never fire, so release their closures here or the RC audit counts
   * them as leaks. Uncaught callback throws still return above for main
   * to report through the existing exceptional teardown path. */
  scr_timers_teardown();
  /* No reffed foreign registration or queued invocation remains at ordinary
   * exhaustion. Disarm posting before exit listeners/global teardown so a
   * straggling native thread becomes a safe silent drop. */
  if (scr_ffi_stop_fn != NULL) scr_ffi_stop_fn();
  /* Retained native FFI registrations are deliberately NOT torn down
   * here: process 'exit' listeners run after the loop returns (inline in
   * main, before any atexit handler) and may legitimately release a
   * registration or pump a native library one last time — exactly like
   * the process.exit() path, where the ledger is also still intact. On
   * returns that reach atexit, the sweep scr_ffi_retain registered (LIFO
   * before the RC audit) then drops the ledger's references. It does NOT
   * run on process.exit(): scr_process_exit ends in _Exit, skipping every
   * atexit handler — the sweep and the RC audit alike — and leaves the
   * ledger to the OS. */
  /* Unref'd children the loop never reaped: release the
   * registry's references (their listeners never fire — the process is
   * exiting, Node's behavior; the OS reparents the children). */
  scr_children_teardown();
  scr_fibers_abandoned = scr_fibers_live;
  scr_note_abandoned_fibers(scr_fibers_abandoned);
  return rejection_failed;
}

/* The island's half of the unhandled-rejection report (scr_island.c
 * registers it at engine boot): called with print=true when the static
 * ledger below reported nothing — one report, one voice, like Node's
 * first-unhandled-rejection death. Returns whether the island had any.
 * Static builds never set it. */
static bool (*scr_island_rejections_fn)(bool print) = NULL;
static int (*scr_island_jobs_drain_fn)(void) = NULL;

void scr_loop_set_island_rejections(bool (*fn)(bool print),
                                    int (*drain_jobs)(void)) {
  scr_island_rejections_fn = fn;
  scr_island_jobs_drain_fn = drain_jobs;
}

/* ── process.on('unhandledRejection') ─────────────────────────────────
 * Dyn listeners are called per never-observed rejection at the completed
 * nextTick/microtask checkpoint. A registered listener suppresses the
 * default report and exit 1, exactly Node's handled-event contract. */

/* The unhandled-rejection LISTENER hook (scr_async_dyn.c installs it at
 * registration — the loop-hook pattern, so listener-free binaries keep
 * their size class): called per never-observed rejection; false = a
 * listener threw (the uncaught crash path). */
bool (*scr_urj_deliver_fn)(ScrPromise *p) = NULL;

/* Unhandled rejections at a completed nextTick/microtask checkpoint:
 * Node prints an error and exits 1 when no listener handles the event.
 * Snapshot the ledger: a listener can reject another promise, but that
 * new rejection belongs to the NEXT checkpoint rather than this report. */
bool scr_report_unhandled_rejections(void) {
  /* Static fibers drain before engine jobs in this runtime's documented
   * island ordering. Complete BOTH halves of that microtask checkpoint
   * before deciding either rejection ledger; engine reactions can attach
   * a handler to a rejection that would otherwise look unhandled here.
   * A host callback can wake a static fiber/tick, in which case the loop
   * must drain that work before reporting too. */
  if (scr_island_jobs_drain_fn != NULL) {
    scr_island_jobs_drain_fn();
    if (scr_ready_len > 0 || scr_nt_head != NULL) return false;
  }
  bool any = false;
  bool crashed = false;
  size_t report_count = scr_nunhandled;
  for (size_t i = 0; i < report_count; i++) {
    ScrPromise *p = scr_maybe_unhandled[i];
    if (p->state == SCR_PROM_REJECTED && !p->rejection_observed && !crashed) {
      if (scr_urj_deliver_fn != NULL) {
        /* Listener dispatch (scr_async_dyn.c installed the hook at
         * registration): the event handles it, like Node — per entry,
         * no report, exit 0. A listener throw is the uncaught crash.
         * reported_unhandled arms the 'rejectionHandled' window: a
         * handler the listener itself attaches fires the sibling event
         * (scr_prom_observe). */
        p->rejection_observed = true;
        p->reported_unhandled = true;
        if (!scr_urj_deliver_fn(p)) crashed = true;
      } else if (!any) {
        any = true;
        fflush(stdout);
        fputs("Unhandled promise rejection: ", stderr);
        switch (p->payload_kind) {
        case SCR_EXC_F64: {
          char buf[32];
          scr_f64_to_str(p->f64, buf);
          fputs(buf, stderr);
          break;
        }
        case SCR_EXC_BOOL: fputs(p->b ? "true" : "false", stderr); break;
        case SCR_EXC_STR: fputs(((ScrStr *)p->payload)->data, stderr); break;
        case SCR_EXC_OBJ:
          /* Error rejections render "name: message", like the uncaught path. */
          if (scr_error_is(p->payload)) {
            ScrStr *s = scr_error_to_string((ScrError *)p->payload);
            fwrite(s->data, 1, s->len, stderr);
            scr_str_release(s);
            break;
          }
          /* fall through */
        default: fputs("[object]", stderr); break;
        }
        fputc('\n', stderr);
      }
    }
    scr_promise_release(p);
  }
  size_t remaining = scr_nunhandled - report_count;
  if (remaining > 0) {
    memmove(scr_maybe_unhandled, scr_maybe_unhandled + report_count,
            remaining * sizeof *scr_maybe_unhandled);
  }
  scr_nunhandled = remaining;
  if (crashed) {
    scr_exc_print_uncaught();
    scr_exit_code_note(1);
    return true;
  }
  if (scr_island_rejections_fn != NULL) {
    bool island = scr_island_rejections_fn(!any);
    any = any || island;
  }
  /* main returns 1 on a reported rejection — the 'exit' listeners (atexit)
   * must see that code, like Node's. */
  if (any) scr_exit_code_note(1);
  return any;
}

/* A fatal executable-module rejection suppresses unrelated rejections
 * created in the SAME checkpoint. Drop their retained ledger references
 * without delivering process events or a competing default report. */
void scr_discard_unhandled_rejections(void) {
  for (size_t i = 0; i < scr_nunhandled; i++) {
    scr_promise_release(scr_maybe_unhandled[i]);
  }
  scr_nunhandled = 0;
}

/* ── new Promise(executor) ────────────────────────────────────────────── */

/* resolve closures: caps[0] is a box whose slot holds the promise (+1). */
static ScrPromise *scr_resolve_target(ScrClosure *self) {
  return (ScrPromise *)scr_box_get_ref(self->caps[0]);
}
static void scr_resolve_thunk_f64(ScrClosure *self, double v) {
  ScrPromise *p = scr_resolve_target(self);
  scr_promise_fulfill_f64(p, v);
  scr_promise_release(p);
}
static void scr_resolve_thunk_bool(ScrClosure *self, bool v) {
  ScrPromise *p = scr_resolve_target(self);
  scr_promise_fulfill_bool(p, v);
  scr_promise_release(p);
}
static void scr_resolve_thunk_str(ScrClosure *self, ScrStr *v) {
  ScrPromise *p = scr_resolve_target(self);
  scr_promise_fulfill_str(p, v); /* callee owns its params: moves in */
  scr_promise_release(p);
}
static void scr_resolve_thunk_void(ScrClosure *self) {
  ScrPromise *p = scr_resolve_target(self);
  scr_promise_fulfill_void(p);
  scr_promise_release(p);
}
/* Ref payloads: emitted code passes the concrete retain/release via a
 * second box slot? Keep simple: ref resolve thunks are monomorphized by the
 * EMITTER (it knows the arm type) — it emits a tiny static thunk calling
 * scr_promise_fulfill_ref with the concrete helpers, wrapped over caps[0].
 * The runtime provides only the scalar/str/void thunks. */

ScrClosure *scr_make_resolve(ScrPromise *p, int kind /*0 f64,1 bool,2 str,3 void*/) {
  void *fns[4] = {(void *)&scr_resolve_thunk_f64, (void *)&scr_resolve_thunk_bool,
                  (void *)&scr_resolve_thunk_str, (void *)&scr_resolve_thunk_void};
  ScrClosure *c = scr_closure_new(fns[kind], 1);
  ScrBox *b = scr_box_new_obj(scr_promise_retain_v, scr_promise_release_v,
                               scr_promise_trace_v);
  scr_box_set_ref(b, scr_promise_retain(p));
  c->caps[0] = b;
  return c;
}

/* Emitted ref-kind resolve thunks call this. */
void scr_resolve_ref_impl(ScrClosure *self, void *v, void *(*retain)(void *), void (*release)(void *), ScrTraceFn trace) {
  ScrPromise *p = scr_resolve_target(self);
  scr_promise_fulfill_ref(p, v, retain, release, trace);
  scr_promise_release(p);
}

/* ── emitter support ──────────────────────────────────────────────────── */

ScrPromise *scr_fiber_promise(ScrFiber *f) { return f->promise; }

/* Generalized resolve construction: `fn` is an emitted thunk with closure
 * calling convention (self, value) that forwards to scr_resolve_ref_impl
 * with the concrete RC helpers. */
ScrClosure *scr_make_resolve_fn(ScrPromise *p, void *fn) {
  ScrClosure *c = scr_closure_new(fn, 1);
  ScrBox *b = scr_box_new_obj(scr_promise_retain_v, scr_promise_release_v,
                               scr_promise_trace_v);
  scr_box_set_ref(b, scr_promise_retain(p));
  c->caps[0] = b;
  return c;
}

/* ── reject closures (new Promise((resolve, reject) => ...)) ──────────
 * Mirror of the resolve closures: caps[0] is a box whose slot holds the
 * promise (+1). The reason is always an Error-hierarchy instance (the
 * frontend pins the reject parameter to `(reason: Error) => void`), and it
 * stores as SCR_EXC_OBJ — exactly the thrown-Error representation — so an
 * await rethrows it, catch-side instanceof answers, and the uncaught
 * printer prints "name: message". First settle wins, exactly JS: reject
 * after any settle (resolve-then-reject, double reject) releases the
 * reason and does nothing. The closure calling convention makes the thunk
 * own its param, like every compiled callee. */
static void scr_reject_thunk(ScrClosure *self, ScrError *reason) {
  ScrPromise *p = scr_resolve_target(self);
  if (p->state != SCR_PROM_PENDING) {
    scr_error_release(reason);
  } else {
    p->state = SCR_PROM_REJECTED;
    p->payload_kind = SCR_EXC_OBJ;
    p->payload = reason; /* ownership moves in */
    p->retain_fn = scr_error_retain_v;
    p->release_fn = scr_error_release_v;
    p->trace_fn = scr_error_trace_arg();
    scr_promise_settle_wake(p);
  }
  scr_promise_release(p);
}

ScrClosure *scr_make_reject(ScrPromise *p) {
  ScrClosure *c = scr_closure_new((void *)&scr_reject_thunk, 1);
  ScrBox *b = scr_box_new_obj(scr_promise_retain_v, scr_promise_release_v,
                               scr_promise_trace_v);
  scr_box_set_ref(b, scr_promise_retain(p));
  c->caps[0] = b;
  return c;
}

/* Shared executor epilogue: an escaping throw rejects a still-pending
 * promise (payload moved out of the active exception cell); a throw after
 * the promise settled is swallowed, like resolve-then-throw in JS. */
static void scr_executor_check_throw(ScrPromise *p) {
  if (!scr_exc_pending()) return;
  if (p->state == SCR_PROM_PENDING) {
    scr_promise_reject_from_cell(p, scr_exc_current_cell());
    scr_promise_settle_wake(p);
  } else {
    scr_exc_clear();
  }
}

/* Runs a `new Promise(executor)` executor synchronously; an escaping throw
 * rejects the promise (JS-exact). Borrows `p` and `exec`; `resolve`
 * ownership moves INTO the executor call (compiled callees own and finally
 * release their params). */
void scr_promise_run_executor(ScrPromise *p, ScrClosure *exec, ScrClosure *resolve) {
  ((void (*)(ScrClosure *, ScrClosure *))exec->fn)(exec, resolve);
  scr_executor_check_throw(p);
}

/* Zero-param executor (`new Promise(() => {})`): nothing can ever resolve —
 * a deliberately-forever-pending promise. Borrows both. */
void scr_promise_run_executor0(ScrPromise *p, ScrClosure *exec) {
  ((void (*)(ScrClosure *))exec->fn)(exec);
  scr_executor_check_throw(p);
}

/* Two-param executor (`new Promise((resolve, reject) => ...)`): same as
 * scr_promise_run_executor with the reject closure's +1 also moving into
 * the call. */
void scr_promise_run_executor2(ScrPromise *p, ScrClosure *exec, ScrClosure *resolve,
                                ScrClosure *reject) {
  ((void (*)(ScrClosure *, ScrClosure *, ScrClosure *))exec->fn)(exec, resolve, reject);
  scr_executor_check_throw(p);
}

/* ── sync generators (function*) ──────────────────────────────────────
 * Contract in scr_runtime.h. The fiber machinery above is the engine:
 * scr_switch is a synchronous coroutine hop, so generators need no event
 * loop — .next() from the main stack (or any fiber) blocks until the
 * yield. */

enum { SCR_GEN_UNSTARTED = 0, SCR_GEN_SUSPENDED, SCR_GEN_RUNNING, SCR_GEN_DONE };

/* One type-erased value slot: the exception cell's payload technique,
 * with only the release entry point (takes MOVE — nothing here retains). */
typedef struct {
  ScrExcKind kind; /* NONE / F64 / BOOL / REF (strings ride REF) */
  double f64;
  bool b;
  void *payload;
  void (*release_fn)(void *);
} ScrGenSlot;

static void scr_gen_slot_reset(ScrGenSlot *s) {
  if (s->kind == SCR_EXC_REF && s->payload != NULL) s->release_fn(s->payload);
  s->kind = SCR_EXC_NONE;
  s->payload = NULL;
  s->release_fn = NULL;
}

struct ScrGen {
  size_t rc;
  ScrFiber *fiber; /* NULL once torn down (done, or unstarted release) */
  int state;
  ScrGenSlot out; /* yielded value / completion value */
  ScrGenSlot in;  /* the .next(v) argument */
  ScrGenSlot ret; /* a parked .return(v) value */
  /* The never-started teardown: drops the packed (already-retained)
   * arguments the spawn wrapper built. Emitted per generator function. */
  void (*drop_args)(void *);
};

ScrGen *scr_gen_new(void (*entry)(ScrFiber *, void *), void *argpack,
                     void (*drop_args)(void *)) {
  ScrGen *g = calloc(1, sizeof *g);
  if (!g) scr_oom();
  g->rc = 1;
  g->state = SCR_GEN_UNSTARTED;
  g->drop_args = drop_args;
  scr_obj_alloc_note();

  ScrFiber *f = calloc(1, sizeof *f);
  if (!f) scr_oom();
  f->gen = g;
  f->entry = entry;
  f->argpack = argpack; /* owned by the fiber start; drop_args if never started */
  /* AsyncLocalStorage: generator bodies run in their CREATOR's context
   * (the spawn-inheritance stance; resumes swap it active like any
   * fiber switch). */
  f->als = scr_als_ctx_retain(*scr_als_active);
  scr_fibers_live++;
#ifdef _WIN32
  f->ctx = CreateFiber(SCR_FIBER_STACK, scr_trampoline, NULL);
  if (f->ctx == NULL) scr_oom();
#elif defined(__wasi__)
  f->ctx = 0;
#else
  f->stack = malloc(SCR_FIBER_STACK);
  if (!f->stack) scr_oom();
  getcontext(&f->ctx);
  f->ctx.uc_stack.ss_sp = f->stack;
  f->ctx.uc_stack.ss_size = SCR_FIBER_STACK;
  f->ctx.uc_link = NULL;
  makecontext(&f->ctx, scr_trampoline, 0);
#endif
  g->fiber = f;
  return g;
}

ScrGen *scr_gen_retain(ScrGen *g) {
  if (g) g->rc++;
  return g;
}

void scr_gen_release(ScrGen *g) {
  if (!g || --g->rc != 0) return;
  scr_gen_slot_reset(&g->out);
  scr_gen_slot_reset(&g->in);
  scr_gen_slot_reset(&g->ret);
  if (g->fiber != NULL) {
    if (g->state == SCR_GEN_UNSTARTED) {
      /* Never ran: nothing on the stack owns anything — clean teardown.
       * The packed arguments (+1 each) drop through the emitted helper. */
      if (g->drop_args != NULL) g->drop_args(g->fiber->argpack);
      else free(g->fiber->argpack);
      scr_fiber_destroy(g->fiber);
      scr_fibers_live--;
    } else {
      /* Suspended: the stack holds live locals — unwinding would run user
       * finally blocks Node's GC never runs, so the fiber is deliberately
       * ABANDONED (it stays in the live count; a program that drops a
       * suspended generator gets the abandoned-fiber audit note, the
       * loop-exhaustion story). The fiber's back-pointer clears so a
       * dangling resume can never reach the freed ScrGen. */
      g->fiber->gen = NULL;
    }
  }
  scr_obj_free_note();
  free(g);
}

void *scr_gen_retain_v(void *g) { return scr_gen_retain((ScrGen *)g); }
void scr_gen_release_v(void *g) { scr_gen_release((ScrGen *)g); }

bool scr_gen_done(ScrGen *g) { return g->state == SCR_GEN_DONE; }
ScrGen *scr_gen_of_fiber(ScrFiber *f) { return f->gen; }

/* Slot setters (release the previous occupant; payloads MOVE in). */
static void scr_gen_slot_f64(ScrGenSlot *s, double v) {
  scr_gen_slot_reset(s);
  s->kind = SCR_EXC_F64;
  s->f64 = v;
}
static void scr_gen_slot_bool(ScrGenSlot *s, bool v) {
  scr_gen_slot_reset(s);
  s->kind = SCR_EXC_BOOL;
  s->b = v;
}
static void scr_gen_slot_ref(ScrGenSlot *s, void *v, void (*release)(void *)) {
  scr_gen_slot_reset(s);
  s->kind = SCR_EXC_REF;
  s->payload = v;
  s->release_fn = release;
}

void scr_gen_in_f64(ScrGen *g, double v) { scr_gen_slot_f64(&g->in, v); }
void scr_gen_in_bool(ScrGen *g, bool v) { scr_gen_slot_bool(&g->in, v); }
void scr_gen_in_ref(ScrGen *g, void *v, void (*release)(void *)) {
  scr_gen_slot_ref(&g->in, v, release);
}
void scr_gen_in_none(ScrGen *g) { scr_gen_slot_reset(&g->in); }

void scr_gen_ret_f64(ScrGen *g, double v) { scr_gen_slot_f64(&g->ret, v); }
void scr_gen_ret_bool(ScrGen *g, bool v) { scr_gen_slot_bool(&g->ret, v); }
void scr_gen_ret_ref(ScrGen *g, void *v, void (*release)(void *)) {
  scr_gen_slot_ref(&g->ret, v, release);
}
void scr_gen_ret_none(ScrGen *g) { scr_gen_slot_reset(&g->ret); }

void scr_gen_out_f64(ScrGen *g, double v) { scr_gen_slot_f64(&g->out, v); }
void scr_gen_out_bool(ScrGen *g, bool v) { scr_gen_slot_bool(&g->out, v); }
void scr_gen_out_ref(ScrGen *g, void *v, void (*release)(void *)) {
  scr_gen_slot_ref(&g->out, v, release);
}

/* Takes MOVE the slot's value out (the slot resets — a done generator's
 * later resumes answer NONE, JS's undefined). */
static double scr_gen_slot_take_f64(ScrGenSlot *s) {
  double v = s->kind == SCR_EXC_F64 ? s->f64 : 0;
  s->kind = SCR_EXC_NONE;
  return v;
}
static bool scr_gen_slot_take_bool(ScrGenSlot *s) {
  bool v = s->kind == SCR_EXC_BOOL ? s->b : false;
  s->kind = SCR_EXC_NONE;
  return v;
}
static void *scr_gen_slot_take_ref(ScrGenSlot *s) {
  void *v = s->kind == SCR_EXC_REF ? s->payload : NULL;
  s->kind = SCR_EXC_NONE;
  s->payload = NULL;
  s->release_fn = NULL;
  return v;
}

bool scr_gen_out_has(ScrGen *g) { return g->out.kind != SCR_EXC_NONE; }
double scr_gen_take_out_f64(ScrGen *g) { return scr_gen_slot_take_f64(&g->out); }
bool scr_gen_take_out_bool(ScrGen *g) { return scr_gen_slot_take_bool(&g->out); }
void *scr_gen_take_out_ref(ScrGen *g) { return scr_gen_slot_take_ref(&g->out); }

/* The running fiber's generator — the body-side helpers' anchor. */
static ScrGen *scr_gen_self(void) {
  ScrGen *g = scr_current != NULL ? scr_current->gen : NULL;
  if (g == NULL) {
    fputs("scriptc: internal error: yield outside a generator\n", stderr);
    abort();
  }
  return g;
}

double scr_gen_take_in_f64(void) { return scr_gen_slot_take_f64(&scr_gen_self()->in); }
bool scr_gen_take_in_bool(void) { return scr_gen_slot_take_bool(&scr_gen_self()->in); }
void *scr_gen_take_in_ref(void) { return scr_gen_slot_take_ref(&scr_gen_self()->in); }

/* yield: park the value in OUT and hop back to the resumer. Control
 * returns here at the next resume — possibly with an injected .throw
 * payload or the GENRET sentinel pending (the emitted check handles it). */
static void scr_gen_yield_switch(void) {
  ScrFiber *self = scr_current;
  scr_switch(&self->ctx, self->return_to, NULL);
}
void scr_gen_yield_f64(double v) {
  scr_gen_slot_f64(&scr_gen_self()->out, v);
  scr_gen_yield_switch();
}
void scr_gen_yield_bool(bool v) {
  scr_gen_slot_bool(&scr_gen_self()->out, v);
  scr_gen_yield_switch();
}
void scr_gen_yield_ref(void *v, void (*release)(void *)) {
  scr_gen_slot_ref(&scr_gen_self()->out, v, release);
  scr_gen_yield_switch();
}

bool scr_exc_genret_pending(void) {
  return scr_exc_current_cell()->kind == SCR_EXC_GENRET;
}

void scr_gen_ret_to_out(ScrGen *g) {
  scr_gen_slot_reset(&g->out);
  g->out = g->ret;
  g->ret.kind = SCR_EXC_NONE;
  g->ret.payload = NULL;
  g->ret.release_fn = NULL;
}

/* The consumer→fiber hop shared by every resume mode: switches in, and on
 * the way back moves a pending body exception into the RESUMER's cell
 * (synchronous propagation — the await-rethrow analog) and tears down a
 * finished fiber. The gen is retained across the hop so a body that
 * releases the consumer's last reference cannot free it mid-run. */
static void scr_gen_switch_in(ScrGen *g) {
  ScrFiber *f = g->fiber;
  scr_gen_retain(g);
  g->state = SCR_GEN_RUNNING;
#ifdef _WIN32
  ScrCtx here = scr_win_self();
#elif defined(__wasi__)
  ScrCtx here = 0;
#else
  ucontext_t here;
#endif
  f->return_to = &here;
  ScrFiber *me = scr_current;
#ifdef __wasi__
  scr_current = f;
  scr_exc_swap_cell(&f->exc);
  scr_als_active = &f->als;
  if (f->coro == NULL) f->entry(f, f->argpack);
  else scr_wasi_coro_resume(f->coro);
  scr_current = me;
  scr_exc_swap_cell(me != NULL ? &me->exc : NULL);
  scr_als_active = me != NULL ? &me->als : &scr_als_main_slot;
#else
  scr_switch(&here, &f->ctx, f);
  /* Back on the consumer: restore identity + the consumer's cell (the
   * yield/finish switch targeted NULL — main's cell). */
  scr_current = me;
  scr_exc_swap_cell(me != NULL ? &me->exc : NULL);
#endif
  if (f->done) {
    g->state = SCR_GEN_DONE;
    if (f->exc.kind != SCR_EXC_NONE) {
      /* The body's exception escaped: move it into the resumer's cell
       * (replace semantics match a throw at the resume site; the resumer's
       * cell is clean here — a pending exception cannot reach a resume). */
      ScrExcCell *mine = scr_exc_current_cell();
      *mine = f->exc;
      f->exc.kind = SCR_EXC_NONE;
      f->exc.payload = NULL;
      f->exc.trace_fn = NULL;
    }
    scr_fiber_destroy(f);
    g->fiber = NULL;
    scr_fibers_live--;
  } else {
    g->state = SCR_GEN_SUSPENDED;
  }
  scr_gen_release(g);
}

void scr_gen_resume(ScrGen *g) {
  switch (g->state) {
  case SCR_GEN_RUNNING: {
    static const char sc_m[] = "Generator is already running";
    scr_throw_error_msg(SCR_ERR_TYPE, sc_m, sizeof sc_m - 1);
    return;
  }
  case SCR_GEN_DONE:
    /* next() on a done generator: { value: undefined, done: true } —
     * OUT is NONE (the completing resume took it). */
    return;
  default:
    scr_gen_switch_in(g);
  }
}

void scr_gen_resume_return(ScrGen *g) {
  switch (g->state) {
  case SCR_GEN_RUNNING: {
    static const char sc_m[] = "Generator is already running";
    scr_throw_error_msg(SCR_ERR_TYPE, sc_m, sizeof sc_m - 1);
    return;
  }
  case SCR_GEN_DONE:
    scr_gen_ret_to_out(g);
    return;
  case SCR_GEN_UNSTARTED:
    /* The body never runs: tear the fiber down cleanly (drop the packed
     * arguments) and complete with the parked value. */
    if (g->drop_args != NULL) g->drop_args(g->fiber->argpack);
    else free(g->fiber->argpack);
    scr_fiber_destroy(g->fiber);
    g->fiber = NULL;
    scr_fibers_live--;
    g->state = SCR_GEN_DONE;
    scr_gen_ret_to_out(g);
    return;
  default:
    /* Suspended at a yield: inject the sentinel (an earlier .return whose
     * unwind a finally-yield parked leaves it already set) and resume. */
    if (g->fiber->exc.kind == SCR_EXC_NONE) g->fiber->exc.kind = SCR_EXC_GENRET;
    scr_gen_switch_in(g);
  }
}

void scr_gen_resume_throw(ScrGen *g) {
  switch (g->state) {
  case SCR_GEN_RUNNING: {
    /* Replace the parked payload with Node's reentrancy TypeError. */
    static const char sc_m[] = "Generator is already running";
    scr_throw_error_msg(SCR_ERR_TYPE, sc_m, sizeof sc_m - 1);
    return;
  }
  case SCR_GEN_DONE:
    /* .throw on a done generator: it stays done; the payload stays
     * pending in the caller — the call site's check rethrows it. */
    return;
  case SCR_GEN_UNSTARTED:
    /* The body never runs; the generator becomes done and the payload
     * stays pending in the caller (probed Node behavior). */
    if (g->drop_args != NULL) g->drop_args(g->fiber->argpack);
    else free(g->fiber->argpack);
    scr_fiber_destroy(g->fiber);
    g->fiber = NULL;
    scr_fibers_live--;
    g->state = SCR_GEN_DONE;
    return;
  default: {
    /* Move the caller's pending payload into the fiber's cell (an
     * earlier sentinel parked by a finally-yield is replaced — the
     * injected throw wins, like a throw inside that finally). */
    ScrExcCell *mine = scr_exc_current_cell();
    ScrExcCell *dst = &g->fiber->exc;
    dst->kind = mine->kind;
    dst->f64 = mine->f64;
    dst->b = mine->b;
    dst->payload = mine->payload;
    dst->retain_fn = mine->retain_fn;
    dst->release_fn = mine->release_fn;
    dst->trace_fn = mine->trace_fn;
    mine->kind = SCR_EXC_NONE;
    mine->payload = NULL;
    mine->trace_fn = NULL;
    scr_gen_switch_in(g);
  }
  }
}
