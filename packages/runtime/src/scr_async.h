/* scriptc runtime — promises, fibers, the event loop, AsyncLocalStorage,
 * promise combinators and timers (scr_async.c, scr_async_dyn.c). Included by
 * scr_runtime.h, which says where new declarations go. */
#ifndef SCR_ASYNC_H
#define SCR_ASYNC_H

#include "scr_dyn.h"

/* ── node:timers/promises (scr_async.c) ──────────────────────────────
 * The promisified pair: a PENDING void promise a one-shot heap timer /
 * the immediate queue fulfills (the armed entry keeps the loop alive
 * until it fires, like Node). Results +1; neither throws. */
ScrPromise *scr_tp_set_timeout(double ms);
ScrPromise *scr_tp_set_timeout_value(double ms, ScrPromise *value, bool ref);
ScrPromise *scr_tp_set_immediate_value(ScrPromise *value, bool ref);
ScrPromise *scr_tp_set_immediate(void);

/* ── async: promises, fibers, event loop ────────────────────────────
 * Async function bodies run on stackful fibers; `await` parks the fiber on
 * a promise; a dependency-free loop (microtasks before timers, FIFO
 * tiebreaks) drives everything after %main returns. See scr_async.c.
 */
ScrPromise *scr_promise_new(void);
void scr_promise_share_identity(ScrPromise *dst, ScrPromise *src);
bool scr_promise_identity_equal(ScrPromise *a, ScrPromise *b);
ScrPromise *scr_promise_retain(ScrPromise *p);
void scr_promise_release(ScrPromise *p);
void *scr_promise_retain_v(void *p);
void scr_promise_release_v(void *p);

typedef struct ScrFiber ScrFiber;
/* Spawn + run eagerly to the first suspension; returns the promise, +1. */
ScrPromise *scr_async_spawn(void (*entry)(ScrFiber *, void *), void *argpack);
/* `await f(...)` of a fiber-backed async f: spawn and await in one call,
 * returning the awaited value (a rejection re-throws into the caller). */
void scr_async_spawn_await_void(void (*entry)(ScrFiber *, void *), void *argpack);
double scr_async_spawn_await_f64(void (*entry)(ScrFiber *, void *), void *argpack);
bool scr_async_spawn_await_bool(void (*entry)(ScrFiber *, void *), void *argpack);
ScrStr *scr_async_spawn_await_str(void (*entry)(ScrFiber *, void *), void *argpack);
void *scr_async_spawn_await_ref(void (*entry)(ScrFiber *, void *), void *argpack);
/* Runtime-authored C waiters cannot themselves become LLVM switched
 * coroutines on wasm32. Spawn after `dependency` settles so their first
 * (and only) await is extraction from an already-settled promise, while
 * retaining the ordinary promise-job hop on every target. +1. */
ScrPromise *scr_async_spawn_after(ScrPromise *dependency,
                                  void (*entry)(ScrFiber *, void *),
                                  void *argpack);
/* Fiberless async call (native targets): the compiler proves an async body
 * can never park its execution context and runs it directly on the
 * caller's stack between enter and leave. The frame saves what a fresh
 * fiber would isolate — the Error.stack frame chain and the
 * AsyncLocalStorage context — and leave restores both, returning a fresh
 * pending promise (+1) the caller settles from the body's outcome. */
typedef struct ScrAsyncInline {
  void *stack;
  void *als;
} ScrAsyncInline;
void scr_async_inline_enter(ScrAsyncInline *frame);
ScrPromise *scr_async_inline_leave(ScrAsyncInline *frame);
/* Leaves the frame without creating the call's promise: `await f()` of a
 * fiberless f consumes the result directly (the emitted await-call entry
 * still takes the await's microtask turn). */
void scr_async_inline_exit(ScrAsyncInline *frame);

/* wasm32-wasi lowers async functions and generators through LLVM switched
 * coroutines instead of the native stack-switching implementations. The
 * first two adapters are emitted into the program module; the remaining
 * helpers let scr_async.c register, queue, and finish those coroutine
 * frames through the same ScrFiber scheduler. These declarations are part
 * of the LLVM/runtime ABI even though native targets never call them. */
void scr_wasi_coro_resume(void *handle);
void scr_wasi_coro_destroy(void *handle);
void scr_wasi_coro_started(void *handle);
void scr_wasi_await_prepare(ScrFiber *self, ScrPromise *p);
void scr_wasi_await_hop_prepare(ScrFiber *self);
bool scr_wasi_module_await_prepare(ScrFiber *self, ScrPromise *p);
void scr_wasi_async_finish(ScrFiber *self);
void scr_wasi_gen_finish(ScrFiber *self);

/* Native stackless async functions: an async body the compiler lowered to
 * an LLVM switched coroutine because it suspends only at its own awaits.
 * It runs on whichever stack resumes it (the spawner's for the eager
 * prefix, the loop's afterwards) with a heap frame holding the values live
 * across its awaits, instead of a dedicated fiber stack. Each await first
 * prepares the continuation (true: the coroutine must suspend; false: it
 * continues in place, exactly where a fiber's hop would continue without
 * switching), then extracts the settled result after resuming without any
 * further hop or park (a rejection re-throws). */
ScrPromise *scr_async_spawn_stackless(void (*entry)(ScrFiber *, void *), void *argpack);
bool scr_coro_await_prepare(ScrFiber *self, ScrPromise *p);
bool scr_coro_hop_prepare(ScrFiber *self);
void scr_coro_async_finish(ScrFiber *self);
void scr_coro_await_void(ScrPromise *p);
double scr_coro_await_f64(ScrPromise *p);
bool scr_coro_await_bool(ScrPromise *p);
ScrStr *scr_coro_await_str(ScrPromise *p); /* +1 */
void *scr_coro_await_ref(ScrPromise *p);   /* +1 via the stored retain */

double scr_await_f64(ScrPromise *p); /* rejected promises re-throw */
bool scr_await_bool(ScrPromise *p);
ScrStr *scr_await_str(ScrPromise *p); /* +1 */
void *scr_await_ref(ScrPromise *p);   /* +1 via the stored retain */
void scr_await_void(ScrPromise *p);
/* Internal ESM dependency wait: parks while pending but, unlike a
 * JavaScript await expression, does not hop when already settled. */
void scr_module_await(ScrPromise *p);
/* After the root-aware event loop returns, inspect the executable's async
 * module-root promise without another microtask hop: 0 = fulfilled,
 * 1 = rejected, 13 = still pending with no ref'd work capable of settling
 * it (Node's unsettled top-level-await exit status). A rejected root is
 * marked observed here but re-thrown separately; earlier-checkpoint
 * rejections were already decided by the loop and same-checkpoint
 * competitors are suppressed by the executable-module verdict. */
int scr_promise_finish_top_level(ScrPromise *p);
void scr_promise_rethrow_top_level(ScrPromise *p);
/* The checked-dynamic tree-crossing await (SCR_DYN_PROMISE's boundary contract): the
 * payload as a dyn value (+1; void fulfillments answer the undefined
 * value), or NULL with the rejection re-thrown into the awaiter. */
ScrDyn *scr_await_dyn(ScrPromise *p);
ScrDyn *scr_await_dyn_value_settled(ScrDyn *value);
void scr_promise_resolve_dyn(ScrPromise *destination, ScrDyn *value);
/* `await v` over a checked-dynamic VALUE: dyn promises adopt, everything
 * else takes JS's one-hop non-thenable await and answers itself (+1). */
ScrDyn *scr_await_dyn_value(ScrDyn *v);
/* .then/.catch/.finally over a dyn promise (scr_dyn_invoke's promise arm
 * and the compiled dyn-receiver path): one reaction fiber per
 * registration — awaits src, runs the checked-dynamic tree handler (non-callable handlers
 * pass the settlement through; a returned dyn promise is adopted), and
 * settles a fresh result promise, answered BOXED (+1). Microtask-exact
 * ordering rides the fiber machinery. */
ScrDyn *scr_dyn_promise_then(ScrPromise *src, ScrDyn *onf, ScrDyn *onr, ScrDyn *onfin);
/* ── AsyncLocalStorage (node:async_hooks — scr_async.c) ───────────────
 * Stores are process-lived f64 handles; the CONTEXT is an immutable
 * refcounted snapshot of (store → dyn value) entries riding the fiber
 * machinery: one active-slot pointer (the exc-cell pattern) swapped at
 * every fiber switch, inherited by spawned fibers (Node's init-time
 * capture). enter answers the PREVIOUS snapshot (owned) for restore —
 * strict nesting is the callers' contract (run/runStores wrap calls). */
/* The snapshot layout (full declaration — the ScrExcCell stance: the
 * fiber machinery in scr_async.c owns the active slot and the RC pair;
 * the gated API TU (scr_async_dyn.c) builds and reads snapshots). */
typedef struct {
  double id;
  ScrDyn *value; /* owned */
} ScrAlsEntry;
typedef struct ScrAlsCtx {
  size_t rc;
  size_t len;
  ScrAlsEntry entries[]; /* flexible */
} ScrAlsCtx;
/* Runtime-internal (the fiber machinery's always-linked core). */
extern SCR_TL ScrAlsCtx **scr_als_active;
#ifdef SCR_WORKERS
ScrAlsCtx **scr_als_slot(void);
#define SCR_ALS_SLOT() scr_als_slot()
#else
#define SCR_ALS_SLOT() scr_als_active
#endif
ScrAlsCtx *scr_als_ctx_retain(ScrAlsCtx *c);
void scr_als_ctx_release(ScrAlsCtx *c);
double scr_als_new(void);
ScrDyn *scr_als_get(double id); /* +1; the undefined value when unset */
ScrAlsCtx *scr_als_enter(double id, ScrDyn *value); /* borrows value; prev out (owned) */
ScrAlsCtx *scr_als_enter_absent(double id);         /* exit()'s cleared arm */
void scr_als_restore(ScrAlsCtx *prev);              /* moves prev back in */
void scr_als_enter_with(double id, ScrDyn *value);  /* no restore point (enterWith) */
void scr_als_disable(double id);
/* run/exit: enter (or clear), call the dyn function with the forwarded
 * argument vector, restore (the finally). Result +1 or NULL pending. */
ScrDyn *scr_als_run(double id, ScrDyn *value, ScrDyn *fn, ScrDyn *args);
ScrDyn *scr_als_exit_run(double id, ScrDyn *fn, ScrDyn *args);

/* process.on/once('unhandledRejection', fn): dyn listeners dispatched
 * per never-observed rejection at the end of its nextTick/microtask
 * checkpoint — (reason, promise), suppressing the default report and the
 * exit-1. `once` auto-removes after one delivery; off removes by closure
 * identity (the warning registry's story). Throws Node's
 * ERR_INVALID_ARG_TYPE on a non-function. */
void scr_process_on_unhandled_rejection(ScrDyn *fn, bool once);
void scr_process_off_unhandled_rejection(ScrDyn *fn);
/* process.on/once/off('rejectionHandled', fn): the sibling registry. A
 * promise handled after its unhandledRejection delivery fires once, with
 * the promise as Node's payload. */
void scr_process_on_rejection_handled(ScrDyn *fn, bool once);
void scr_process_off_rejection_handled(ScrDyn *fn);
/* The checkpoint delivery hook the registration above installs
 * (scr_async_dyn.c → scr_report_unhandled_rejections; NULL = default
 * report). Runtime-internal. */
extern SCR_TL bool (*scr_urj_deliver_fn)(ScrPromise *p);
/* The late-handled hook (scr_async_dyn.c installs it when a
 * 'rejectionHandled' listener registers): scr_async.c calls it when a
 * promise the report already delivered as unhandled gains a handler.
 * Runtime-internal. */
extern SCR_TL void (*scr_rjh_notify_fn)(ScrPromise *p);
/* The attach-time handled mark (a dyn then/catch carrying a rejection
 * handler, or the module loader taking ownership of an evaluation
 * promise): marks pending and rejected sources observed at Node's attach
 * moment, firing the late-handled hook when the report already delivered
 * it. Runtime-internal. */
void scr_promise_mark_handled(ScrPromise *p);
/* A rejected promise's reason as a dyn value (identity-preserving for
 * dyn payloads and %Error instances). +1. */
ScrDyn *scr_promise_reason_dyn(const ScrPromise *p);
/* process warnings (scr_lib.c — always linked so any unit can emit a
 * deprecation): dyn listeners plus Node's default stderr report
 * ("(node:pid) [CODE] Name: message" and a detail second line).
 * scr_process_emit_warning takes the ARGUMENT VECTOR as one dyn array,
 * applies Node's full grammar/TypeErrors at the call and emits on the
 * next tick, as Node does; scr_emit_warning is the C-side entry and
 * reports synchronously. */
void scr_process_on_warning(ScrDyn *fn);
void scr_process_off_warning(ScrDyn *fn);
void scr_process_emit_warning(ScrDyn *args);
void scr_emit_warning(const char *name, const char *code, ScrStr *message);
/* scr_emit_warning once a 'warning' listener exists (scr_lib.c; set by the
 * listener registration): units that cannot link the dyn-async unit route
 * their warnings through it, and print the default report otherwise. */
extern SCR_TL void (*scr_warning_emit_hook)(const char *name, const char *code, ScrStr *message);
/* process.noDeprecation (which 0) and process.throwDeprecation (which 1):
 * the stored value (+1; undefined until assigned), the assignment
 * (borrowed), and the truthiness the warning paths test. */
ScrDyn *scr_process_deprecation_flag(double which);
void scr_process_set_deprecation_flag(double which, ScrDyn *value);
bool scr_process_deprecation_flag_on(int which);
/* Node's emitWarning tail on the next tick (util.deprecate): a
 * DeprecationWarning is dropped under noDeprecation and thrown from its
 * own tick under throwDeprecation; otherwise the report and the 'warning'
 * listeners run. scr_warning_new builds the string form's warning value
 * (borrows; +1). */
void scr_warning_emit_deferred(ScrDyn *warning);
ScrDyn *scr_warning_new(ScrStr *message, const char *type, const ScrStr *code);
/* The promise-or-absent await's unit arm: one microtask hop, like JS's
 * await of any non-thenable (and like awaiting a settled promise). */
void scr_await_hop(void);

void scr_promise_fulfill_f64(ScrPromise *p, double v);
void scr_promise_fulfill_bool(ScrPromise *p, bool v);
void scr_promise_fulfill_str(ScrPromise *p, ScrStr *v); /* moves in */
/* trace: non-NULL iff the payload type carries a cycle header (a promise
 * fulfilled with a cycle-capable value is itself a cycle member candidate:
 * its trace visits the payload). */
void scr_promise_fulfill_ref(ScrPromise *p, void *v, void *(*retain)(void *), void (*release)(void *), ScrTraceFn trace);
/* Fulfills p with src's fulfillment value (src fulfilled; its payload is
 * retained), so a promise of the same inner type settles without a
 * conversion. */
void scr_promise_fulfill_like(ScrPromise *p, const ScrPromise *src);
void scr_promise_fulfill_void(ScrPromise *p);

void scr_promise_reject_pending(ScrPromise *p);

/* Mint an ALREADY-SETTLED promise from a just-run synchronous operation:
 * a pending exception in the active cell moves in as the REJECTION (the
 * cell resets — callers' pending checks see it clean) and the payload is
 * dropped; otherwise the payload fulfills. The fs/promises bridge. */
ScrPromise *scr_promise_settled_str(ScrStr *v); /* moves v in */
ScrPromise *scr_promise_settled_void(void);
ScrPromise *scr_promise_settled_ref(void *v, void *(*retain)(void *), void (*release)(void *), ScrTraceFn trace);

/* ── Promise.race (compiler-emitted combinator plumbing) ──────────────
 * race_join: subscribe the result to an entry with a reaction job that
 * runs one microtask turn after the entry settles (or after the join, for
 * an entry already settled) — fulfillments run `adapt` (an emitted
 * per-type adapter building the result's inner type from the entry's
 * payload; scr_promise_adapt_copy is the same-type one), rejections copy
 * raw; the entry counts as HANDLED from the join. race_add is the same
 * callback run inside the entry's own settlement (or now, if settled),
 * for destinations that view the entry at another inner type. The
 * payload accessors return retained/by-value fulfillment payloads for
 * the emitted adapters (losing entries keep their settlements). */
void scr_promise_race_join(ScrPromise *race, ScrPromise *in,
                            void (*adapt)(ScrPromise *dst, ScrPromise *src));
void scr_promise_race_add(ScrPromise *race, ScrPromise *in,
                           void (*adapt)(ScrPromise *dst, ScrPromise *src));

/* ── Promise.all (compiler-emitted combinator plumbing) ───────────────
 * BORROWS the Promise<T>[] entries array and the pre-capacity (empty,
 * cap >= ps->len) values array — NULL values/store for Promise<void>
 * entries, whose result fulfills void — retains what it keeps, and
 * returns the result promise +1. Node-exact: each entry settles the
 * result through a reaction job one microtask turn after it settles,
 * values land at their INPUT index regardless of settlement order, the
 * first rejection's job wins (every entry counts as handled), and the
 * empty array fulfills immediately. The store helpers are the
 * per-element-kind payload writers the compiler picks from. */
ScrPromise *scr_promise_all(ScrArr *ps, ScrArr *values,
                             void (*store)(ScrArr *a, double i, ScrPromise *src));

/* ── Promise.allSettled / Promise.any ─────────────────────────────────
 * The same countdown and per-entry reaction jobs as Promise.all, with
 * the mode deciding what an entry's job does. allSettled stores EVERY
 * settlement through `store` (the emitted or dyn settled-record builder)
 * and fulfills with the array once every entry has settled. any settles
 * the result from the first fulfillment (same inner type — a copy),
 * stores each rejection reason into `errors` at its input index, and
 * once every entry has rejected calls `fail(result, errors)`, which
 * rejects the result (the AggregateError). The empty array fulfills /
 * fails immediately. Both BORROW their arrays and return +1.
 *
 * The builder underneath (ScrCombine) takes entries one at a time, so a
 * caller that runs other work between entries — the dyn path's
 * thenable jobs — keeps Node's queue order: settled entries batch into
 * one job until scr_promise_combine_flush closes the batch. */
typedef void (*ScrAllStore)(ScrArr *a, double i, ScrPromise *src);
typedef void (*ScrAnyFail)(ScrPromise *result, ScrArr *errors);
enum { SCR_COMBINE_ALL = 0, SCR_COMBINE_ALL_SETTLED = 1, SCR_COMBINE_ANY = 2 };
typedef struct ScrCombine {
  struct ScrAllState *st;
  ScrPromise *result;
  size_t next;          /* input index of the next entry */
  size_t batched;       /* settled entries counted in the open batch */
  ScrPromise *decided;  /* the open batch's first deciding entry (+1) */
  bool open;            /* the open batch holds at least one entry */
} ScrCombine;
void scr_promise_combine_begin(ScrCombine *c, int mode, size_t n, ScrArr *values,
                               ScrAllStore store, ScrAnyFail fail);
void scr_promise_combine_add(ScrCombine *c, ScrPromise *in); /* borrowed */
void scr_promise_combine_flush(ScrCombine *c);
ScrPromise *scr_promise_combine_end(ScrCombine *c); /* +1 */
ScrPromise *scr_promise_all_settled(ScrArr *ps, ScrArr *values, ScrAllStore store);
ScrPromise *scr_promise_any(ScrArr *ps, ScrArr *errors, ScrAllStore store, ScrAnyFail fail);
/* The typed Promise.any entry (scr_async_dyn.c): reasons collect as dyn
 * values and exhaustion rejects with an AggregateError. */
ScrPromise *scr_promise_any_typed(ScrArr *ps);
void scr_promise_all_store_f64(ScrArr *a, double i, ScrPromise *src);
void scr_promise_all_store_bool(ScrArr *a, double i, ScrPromise *src);
void scr_promise_all_store_str(ScrArr *a, double i, ScrPromise *src);
void scr_promise_all_store_ref(ScrArr *a, double i, ScrPromise *src);
void scr_promise_adapt_copy(ScrPromise *dst, ScrPromise *src);
double scr_promise_payload_f64(ScrPromise *p);
bool scr_promise_payload_bool(ScrPromise *p);
ScrStr *scr_promise_payload_str(ScrPromise *p); /* +1 */
void *scr_promise_payload_ref(ScrPromise *p);   /* +1 via the stored retain */
/* Thin payload views for the gated dyn-async TU (scr_async_dyn.c). */
int scr_promise_payload_kind(const ScrPromise *p);   /* ScrExcKind */
bool scr_promise_is_rejected(const ScrPromise *p);
bool scr_promise_is_pending(const ScrPromise *p);
bool scr_promise_payload_is_dyn(const ScrPromise *p);
double scr_promise_payload_num(const ScrPromise *p);
bool scr_promise_payload_flag(const ScrPromise *p);
bool scr_promise_await_settled(ScrPromise *p); /* park/hop; false = rethrown */
/* An already-settled promise's outcome without awaiting (no job hop, no
 * parking): false while p is pending; otherwise true, with the rejection
 * rethrown when p rejected. payload_truthy is the fulfillment value's
 * JavaScript truthiness. */
bool scr_promise_settled_now(ScrPromise *p);
bool scr_promise_payload_truthy(const ScrPromise *p);
void scr_promise_payload_release(const ScrPromise *p, void *v);

void scr_set_timeout(ScrClosure *cb, double ms); /* cb ownership moves in */
/* A native callback delivered on a later loop turn: FIFO, one per
 * checkpoint (the fs error-first callbacks). cb moves in and is called as
 * a zero-argument closure. */
void scr_loop_defer(ScrClosure *cb);
/* setInterval/clearInterval: the handle is the number the fallback
 * declarations promise (ids start at 1, so `if (handle)` narrows like
 * Node's Timeout truthiness). A live interval keeps the loop alive;
 * clearInterval removes it eagerly (clearing from inside its own callback
 * works). An unknown handle is a no-op, like Node. */
double scr_set_interval(ScrClosure *cb, double ms); /* cb ownership moves in */
/* `new Promise(setImmediate)`: a fresh promise an armed immediate
 * fulfills with the undefined dyn value (+1). */
ScrPromise *scr_immediate_promise(void);
void scr_clear_interval(double handle);

double scr_set_timeout_handle(ScrClosure *cb, double ms); /* cb ownership moves in */
void scr_timers_teardown(void);
/* Timeout.unref()/ref()/hasRef(): loop-liveness bookkeeping over the timer
 * handle (setTimeout/setInterval's id). unref drops the timer from the
 * liveness count — it still fires if the loop runs on, but never keeps the
 * process alive by itself (Node's semantics); ref restores it; hasRef
 * answers the current state. Absent/NaN handles are tolerated no-ops. */
void scr_timer_unref(double handle);
void scr_timer_ref(double handle);
bool scr_timer_has_ref(double handle);
/* Timeout.refresh(): re-arm to now + the original delay. Works on armed
 * heap entries and from inside the firing timer's own callback (the loop
 * re-arms after the callback returns); a one-shot that already fired on
 * an earlier turn is gone and no-ops (documented divergence). */
void scr_timer_refresh(double handle);
/* setImmediate/clearImmediate — Node's check phase: FIFO once per loop
 * turn after due timers, immediates queued mid-phase wait for the next
 * turn. The handle is an f64 id in its own space (clearTimeout of an
 * Immediate is a no-op, like Node); the Immediate ref trio mirrors the
 * Timeout one (unref'd pending immediates don't keep the loop alive and
 * never fire once nothing reffed remains). scr_timers_teardown sweeps
 * the immediate queue too. */
double scr_set_immediate(ScrClosure *cb); /* cb ownership moves in */
/* queueMicrotask: the callback enters the SAME FIFO promise continuations
 * ride (one microtask order, like V8's queue); a throw is an UNCAUGHT
 * exception, never a rejection. cb ownership moves in. The _dyn form
 * (checked-dynamic arguments) throws Node's ERR_INVALID_ARG_TYPE
 * synchronously on a non-function; borrowed. */
void scr_queue_microtask(ScrClosure *cb);
void scr_queue_microtask_dyn(const ScrDyn *cb);
/* setImmediate AS A dyn VALUE (the traceCallback shape): a minted dyn
 * callable that schedules args[0](args[1..]) on the immediate queue and
 * answers undefined; a non-function first argument throws Node's
 * ERR_INVALID_ARG_TYPE. Result +1. */
struct ScrDyn *scr_set_immediate_dyn_value(void);
void scr_clear_immediate(double handle);
void scr_immediate_unref(double handle);
void scr_immediate_ref(double handle);
bool scr_immediate_has_ref(double handle);
/* process.nextTick: enqueue a zero-param callback on the user tick
 * queue — drained BEFORE promise jobs at every loop checkpoint, to
 * joint exhaustion with them (Node's tick-then-microtask order).
 * Pending ticks keep the loop alive; ticks left queued at termination
 * ('exit' listeners, the uncaught paths) never run and release in
 * scr_timers_teardown — and in scr_nticks_teardown, which the
 * exit-listener runner calls for ticks enqueued AFTER the loop's own
 * teardown (they must never run yet must not leak). cb ownership moves
 * in. */
void scr_next_tick(ScrClosure *cb);
/* A successful process.stdout/stderr.write completion on that same queue.
 * The callback and its program-shaped Error | null adapter both MOVE into
 * the entry; the adapter is invoked with NULL (Node's success argument). */
void scr_process_write_callback(ScrClosure *cb, ScrFsRenameFn fn);
/* A raw C-hook entry on the SAME queue: the stream unit enqueues one
 * marker per deferred stream emission, so stream ticks and user
 * nextTicks run in true FIFO order (in Node they are the same queue).
 * Teardown drops markers without running them. */
void scr_next_tick_raw(void (*fn)(void));
void scr_nticks_teardown(void);

#endif /* SCR_ASYNC_H */
