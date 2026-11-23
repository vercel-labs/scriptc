import type { IrLibFn } from "../builtin-signatures.js";

/** The builtins in the urlpattern module decided never to throw. */
export const urlpatternNeverThrow: readonly IrLibFn[] = [
  // The URLPattern handle tag test runs no program code.
  "urlpattern.is",
];
