import { BOOL, DYN, F64, VOID } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The als builtin call slots. */
export const alsSignatures = defineLibFnSignatures({
  "als.new": { argTypes: [], result: F64 },
  "als.get": { argTypes: [F64], result: DYN },
  "als.run": { argTypes: [F64, DYN, DYN, DYN], result: DYN },
  "als.exitRun": { argTypes: [F64, DYN, DYN], result: DYN },
  "als.enterWith": { argTypes: [F64, DYN], result: VOID },
  "als.disable": { argTypes: [F64], result: VOID },
  /** new AsyncLocalStorage(options) (Node's object check throws; MAY
   * THROW) and the store's name option (dyn; "" without one). */
  "als.newOptions": { argTypes: [DYN], result: F64 },
  "als.name": { argTypes: [F64], result: DYN },
  /** A function bound to the active context: the completion callbacks of
   * callback-style APIs (always false: an empty context leaves the
   * callback unbound) and AsyncLocalStorage.bind (always true). The typed
   * form answers its closure argument's type; the dyn form throws Node's
   * ERR_INVALID_ARG_TYPE for a non-function when always (MAY THROW). */
  "als.bindCallback": { argTypes: [null, BOOL], result: VOID },
  "als.bindCallbackDyn": { argTypes: [DYN, BOOL], result: DYN },
  /** AsyncLocalStorage.snapshot(): a dyn function (cb, ...args) that runs
   * cb in the context active at the snapshot. */
  "als.snapshot": { argTypes: [], result: DYN },
  /** AsyncLocalStorage.withScope(store): enters the store now and answers
   * the native RunScope handle whose dispose()/[Symbol.dispose] installs
   * the value getStore() answered before it again. */
  "als.withScope": { argTypes: [F64, DYN], result: DYN },
});
