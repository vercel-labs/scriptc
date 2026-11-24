import { BOOL, DYN, F64, VOID } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The tp builtin call slots. */
export const tpSignatures = defineLibFnSignatures({
  /** node:timers/promises — the promisified pair (scr_async.c, beside
   * the timer heap they ride): tp.setTimeout: [ms] → a pending void
   * promise a one-shot heap timer fulfills (the loop's timer phase, FIFO
   * against equal deadlines like Node); tp.setImmediate: [] → the same
   * through the immediate queue (fires before due timers of later loop
   * turns, Node's check phase). Neither throws. */
  "tp.setTimeout": { argTypes: [F64], result: { kind: "promise", inner: VOID } },
  // scheduler.wait(delay): tp.setTimeout's promise. It throws Node's
  // ERR_INVALID_THIS once mock.timers has restored the real scheduler.wait.
  "tp.schedulerWait": { argTypes: [F64], result: { kind: "promise", inner: VOID } },
  "tp.setImmediate": { argTypes: [], result: { kind: "promise", inner: VOID } },
  /** The resolve-value forms: [ms?, value, ref] → a pending promise of the
   * value's type that copies the borrowed already-resolved `value` promise
   * when the timer (or immediate) fires; ref false unrefs it. The result
   * type follows the value promise. */
  "tp.setTimeoutValue": { argTypes: [F64, null, BOOL], result: VOID },
  "tp.setImmediateValue": { argTypes: [null, BOOL], result: VOID },
  /** The same with options.signal (a checked-dynamic AbortSignal or
   * undefined) last: an abort clears the timer and rejects with an
   * AbortError (scr_event_target.c). */
  "tp.setTimeoutSignal": { argTypes: [F64, null, BOOL, DYN], result: VOID },
  "tp.setImmediateSignal": { argTypes: [null, BOOL, DYN], result: VOID },
  /** scheduler.wait(delay, options): tp.setTimeoutValue's and
   * tp.setTimeoutSignal's shapes, with tp.schedulerWait's throws. */
  "tp.schedulerWaitValue": { argTypes: [F64, null, BOOL], result: VOID },
  "tp.schedulerWaitSignal": { argTypes: [F64, null, BOOL, DYN], result: VOID },
});
