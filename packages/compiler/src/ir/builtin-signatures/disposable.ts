import { BOOL, DYN } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The disposable builtin call slots. */
export const disposableSignatures = defineLibFnSignatures({
  /** DisposableStack (scr_symbol.c): a new stack handle; whether a value is
   * one; and `stack.use(value)` for a class instance, registering the
   * compiler's disposal function for it. The last throws Node's
   * ReferenceError on a disposed stack. */
  "disposable.stackNew": { argTypes: [], result: DYN },
  "disposable.stackIs": { argTypes: [DYN], result: BOOL },
  "disposable.stackUseCallback": { argTypes: [DYN, DYN, DYN], result: BOOL },
});
