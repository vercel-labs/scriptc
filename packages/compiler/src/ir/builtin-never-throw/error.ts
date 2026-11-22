import type { IrLibFn } from "../builtin-signatures.js";

/** The builtins in the error module decided never to throw. */
export const errorNeverThrow: readonly IrLibFn[] = [
  // Error.prepareStackTrace's program state: the get retains the stored value
  // (or builds the default function once) and the set retains and releases;
  // neither runs program code or raises a catchable error.
  "error.prepareStackTraceGet",
  "error.prepareStackTraceSet",
  // Error.prepareStackTrace as program state (scr_exception.c): the getter
  // and setter read and write the program's own cell, running no program
  // code and raising no catchable error.
  "error.prepareStackTraceGet",
  "error.prepareStackTraceSet",
];
