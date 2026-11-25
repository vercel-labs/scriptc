import type { IrLibFn } from "../builtin-signatures.js";

/** The builtins in the formdata module decided never to throw. */
export const formdataNeverThrow: readonly IrLibFn[] = [
  // new FormData() allocates the entry list; the constructor takes no
  // arguments, so nothing converts or validates.
  "formdata.new",
  // The class value and the brand test run no program code.
  "formdata.class",
  "formdata.is",
];
