import { BOOL, DYN, VOID } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The weakMap builtin call slots. */
export const weakMapSignatures = defineLibFnSignatures({
  /** A promise as the key of a WeakMap or WeakSet operation: the promise
   * itself in a checked-dynamic box (scr_dyn_new_promise), which the
   * collection reads only for its identity. No adapter promise is made, so
   * the key takes over nothing of the promise's rejection tracking. */
  "weakMap.promiseKey": { argTypes: [{ kind: "promise", inner: VOID }], result: DYN },
  "weakMap.is": { argTypes: [DYN], result: BOOL },
  "weakMap.new": { argTypes: [DYN], result: DYN },
});
