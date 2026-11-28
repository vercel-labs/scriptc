import { BOOL, DYN, STRING, VOID } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The promise builtin call slots. */
export const promiseSignatures = defineLibFnSignatures({
  /** `Promise.<s>.call(C, value)` in a JavaScript source (scr_js_
   * promise_generic.c): the static's name, the `this` constructor and the
   * one argument the algorithm takes. Answers the capability's promise as
   * a checked-dynamic value (a foreign C may answer anything). */
  "promise.genericStatic": { argTypes: [STRING, DYN, DYN], result: DYN },
  /** The value of a FULFILLED promise, read without a microtask turn (+1
   * for references): the tuple form of Promise.all reads its entries this
   * way once the combinator fulfills, each entry widened to Promise<void>
   * and read at the type it was built with (program-dependent). */
  "promise.fulfilledValue": { argTypes: [null], result: VOID },
  /** A dynamic Promise.race entry: the promise a settled entry fulfills (the
   * call's own type), or the named refusal for a thenable. */
  "promise.raceDynEntry": { argTypes: [DYN], result: { kind: "promise", inner: DYN } },
  /** Promise.all's tuple form as a value: the entries (each widened to
   * Promise<void>) join the runtime combinator, and when it fulfills the
   * function reads the fulfilled entries into the tuple inside that
   * settlement, so the result settles on the combinator's turn; a
   * rejection settles it the same way. The result is the tuple's promise
   * (program-dependent). */
  "promise.allTuple": { argTypes: [null, null], result: VOID },
  /** Promise.allSettled's tuple form as a value: promise.allTuple over the
   * combinator that waits for every entry. The function receives every
   * settled entry, fulfilled or rejected, and builds the tuple of settled
   * records (program-dependent result). */
  "promise.allSettledTuple": { argTypes: [null, null], result: VOID },
  /** Whether a settled entry of the settled tuple form rejected (the
   * entry, a Promise<void> view of a program-dependent promise). */
  "promise.entryRejected": { argTypes: [null], result: BOOL },
  /** The reason of a rejected entry of the settled tuple form as a
   * checked-dynamic value, with the identity a catch would see. */
  "promise.entryReason": { argTypes: [null], result: DYN },
  /** `promise.adopt(resolve, promise)`: the resolve function of a typed
   * `new Promise` whose `resolves` is set, called with a promise
   * (scr_resolve_adopt): the new promise settles as that one does, two
   * turns after it, and is resolved from the call on. `resolve` is the
   * closure the executor received; `promise` has the new promise's type.
   * Borrows both. Never throws. */
  "promise.adopt": { argTypes: [null, null], result: VOID },
});
