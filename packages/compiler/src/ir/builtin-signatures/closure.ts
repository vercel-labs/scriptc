import { F64, VOID } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The closure builtin call slots. */
export const closureSignatures = defineLibFnSignatures({
  /** `closure.shareIdentity(adapter, root, length)`: the function value
   * `adapter` stands for the function `root` from here on, so `===`,
   * SameValue, searches, collection keys and own properties see one
   * function (scr_closure_adopt_identity); `length` (a numLit) is the
   * `length` its untyped values report. Both are function-typed. Never
   * throws. */
  "closure.shareIdentity": { argTypes: [null, null, F64], result: VOID },
});
