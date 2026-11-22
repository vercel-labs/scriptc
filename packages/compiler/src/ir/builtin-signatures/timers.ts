import { BOOL, DYN, F64, VOID } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The timers builtin call slots. */
export const timersSignatures = defineLibFnSignatures({
  "timers.setTimeout": { argTypes: [{ kind: "func", params: [], ret: VOID }, F64], result: VOID },
  /** A setTimeout/setInterval delay that is not a literal in [1, 2^31-1]:
   * the delay unchanged, after the warning Node's Timeout constructor
   * emits when it sets the delay to 1 (scr_timer_user_delay). The second
   * argument is 0 for the global setTimeout, 1 for the global
   * setInterval and 2 for a node:timers import, plus 4 for a delay read
   * from an array element. */
  "timers.userDelay": { argTypes: [F64, F64], result: F64 },
  /** A timer callback that runs with `this` bound to its handle, as Node
   * calls it with the Timeout or Immediate (scr_timer_this_callback). */
  "timers.thisCallback": {
    argTypes: [{ kind: "func", params: [], ret: VOID }],
    result: { kind: "func", params: [], ret: VOID },
  },
  /** The repeating timer pair. setInterval takes (callback, ms) like
   * setTimeout and RETURNS the f64 handle the fallback declarations
   * promise (ids start at 1, so truthiness narrowing works); the loop
   * owns the callback until clearInterval removes the entry (eagerly — a
   * live interval keeps the loop alive, a cleared one releases it, like
   * Node). Neither throws; a throw ESCAPING an interval callback ends the
   * program like a setTimeout throw. */
  "timers.setInterval": { argTypes: [{ kind: "func", params: [], ret: VOID }, F64], result: F64 },
  "timers.clearInterval": { argTypes: [F64], result: VOID },
  /** setTimeout WITH a clear handle (the f64 id) — the clearable/unref-able
   * one-shot; clearTimeout cancels it, .unref() drops it from loop
   * liveness. The plain timers.setTimeout stays the handle-less
   * fire-and-forget. */
  "timers.setTimeoutHandle": {
    argTypes: [{ kind: "func", params: [], ret: VOID }, F64],
    result: F64,
  },
  "timers.clearTimeout": { argTypes: [F64], result: VOID },
  /** Timeout.close() — clearTimeout(this) that returns the handle for
   * chaining. Node's legacy cancel; mock-aware like clearTimeout. */
  "timers.close": { argTypes: [F64], result: F64 },
  /** Immediate.prototype[Symbol.dispose]() — clearImmediate(this), which
   * acts on the handle itself rather than through the global clearTimeout
   * and clearImmediate that mock.timers replaces. */
  "timers.immediateClose": { argTypes: [F64], result: F64 },
  /** Timeout.prototype[Symbol.dispose]() and Immediate.prototype
   * [Symbol.dispose]() — the same handle-owned clears as close(), whose
   * result Node discards: the call answers undefined, not the handle. */
  "timers.dispose": { argTypes: [F64], result: VOID },
  "timers.immediateDispose": { argTypes: [F64], result: VOID },
  /** Timeout.unref()/ref()/hasRef() — loop-liveness bookkeeping over the
   * handle id. unref/ref RETURN the handle (f64) for chaining; hasRef
   * returns bool. */
  "timers.unref": { argTypes: [F64], result: F64 },
  "timers.ref": { argTypes: [F64], result: F64 },
  "timers.hasRef": { argTypes: [F64], result: BOOL },
  /** Timeout.refresh() — re-arm to now + the original delay (from the
   * heap or from inside the firing callback; a one-shot that fired on an
   * earlier turn is gone and no-ops — documented divergence). Returns
   * the handle for chaining like unref/ref. */
  "timers.refresh": { argTypes: [F64], result: F64 },
  /** setImmediate/clearImmediate — Node's check phase: callbacks run
   * once per loop turn AFTER due timers, FIFO, and immediates queued
   * mid-phase wait for the next turn. setImmediate returns the f64
   * handle (its own id space — clearTimeout of an Immediate no-ops,
   * like Node); the Immediate ref trio mirrors the Timeout one (an
   * unref'd pending immediate neither keeps the loop alive nor fires
   * once nothing reffed remains). */
  "timers.setImmediate": { argTypes: [{ kind: "func", params: [], ret: VOID }], result: F64 },
  /** queueMicrotask (scr_async.c): the callback enters the SAME FIFO
   * promise continuations ride — one microtask order, like V8's queue —
   * and a throw is an UNCAUGHT exception (never a rejection).
   * timers.queueMicrotask takes an owned zero-param closure and never
   * throws; the Dyn form (checked-dynamic arguments — the mustCall
   * wrapper, the suite's invalid-input probes) throws Node's
   * ERR_INVALID_ARG_TYPE synchronously on a non-function value and calls
   * the function with zero arguments at drain. */
  "timers.queueMicrotask": { argTypes: [{ kind: "func", params: [], ret: VOID }], result: VOID },
  "timers.queueMicrotaskDyn": { argTypes: [DYN], result: VOID },
  /** Node's synchronous timer callback gate (scr_timers_check_callback):
   * a non-function throws ERR_INVALID_ARG_TYPE before anything schedules.
   * Lowered only for a callback that is not statically a function — a
   * checked-dynamic value — and sequenced after every argument
   * expression evaluates, where Node validates the callback. */
  "timers.checkCallback": { argTypes: [DYN], result: VOID },
  "timers.clearImmediate": { argTypes: [F64], result: VOID },
  "timers.immediateUnref": { argTypes: [F64], result: F64 },
  "timers.immediateRef": { argTypes: [F64], result: F64 },
  "timers.immediateHasRef": { argTypes: [F64], result: BOOL },
  /** The tolerated non-handle clear (`clearTimeout(null)`,
   * `clearInterval({})`, zero-argument forms): Node ignores anything
   * that is not a live handle without an error — a VOID no-op the emitter drops
   * (only syntactically side-effect-free arguments take this path). */
  "timers.clearNoop": { argTypes: [], result: VOID },
  /** TracingChannel (dc.tracingChannel): a registry entry of the five
   * event channels, an f64 handle like Channel (type-mapper.ts). tcSubscribe/
   * tcUnsubscribe walk a dyn handlers object's five event keys (truthy
   * non-function slots throw the per-channel ERR_INVALID_ARG_TYPE);
   * tcTraceSync/tcTraceCallback/tcTracePromise run Node's publish choreography in C over
   * dyn values (fn, ctx, thisArg, args-array) with thisArg bound as the
   * ambient receiver — the traced call's throw and any subscriber throw
   * both propagate (MAY THROW). tcTraceCallback wraps args[position] in a
   * native error/result + asyncStart/asyncEnd publisher and throws Node's
   * TypeError when that slot is not callable. tracingChannelOf is the
   * five-Channel collection form of the constructor. */
  /** setImmediate as a first-class dyn value (scr_async.c): a minted dyn
   * callable scheduling args[0](args[1..]) on the immediate queue — the
   * Node-suite traceCallback shape (`traceCallback(setImmediate, ...)`).
   * Calling it validates the callback (the dyn call machinery); minting
   * never throws. */
  "timers.setImmediateFnValue": { argTypes: [], result: DYN },
  /** `new Promise(setImmediate)` (the Node-suite early-exit shape): a
   * fresh promise an immediate fulfills with the undefined dyn value —
   * the executor IS setImmediate, so resolve rides the immediate queue
   * (scr_async.c). Never throws. */
  "timers.immediatePromise": { argTypes: [], result: { kind: "promise", inner: DYN } },
});
