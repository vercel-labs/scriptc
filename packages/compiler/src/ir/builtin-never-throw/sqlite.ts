import type { IrLibFn } from "../builtin-signatures.js";

/** The builtins in the sqlite module decided never to throw. */
export const sqliteNeverThrow: readonly IrLibFn[] = [
  // scr_global_binding_value looks the name up in the global object's own
  // properties and retains what it finds.
  // scr_sqlite_is compares a handle's tag.
  "sqlite.is",
];
