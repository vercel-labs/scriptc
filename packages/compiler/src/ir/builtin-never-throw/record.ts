import type { IrLibFn } from "../builtin-signatures.js";

/** The builtins in the record module decided never to throw. */
export const recordNeverThrow: readonly IrLibFn[] = [
  // scr_record_source_has_key asks the record's kept view whether it holds
  // an own key: no accessor runs, and a record without a view answers false.
  "record.sourceHasKey",
  // scr_record_reflects_static probes the kept-source table and the live
  // capsule table for the record's address: it reads no property.
  "record.reflectsStatic",
];
