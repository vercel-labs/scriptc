import type { IrStmt } from "../ir/ir.js";

/** Prefix of a function's result-slot entry: `%into.<name>(...params, dst)`
 * writes the function's fresh result object into `dst` and returns nothing
 * (llvm/record-results.ts). */
export const RESULT_ENTRY_PREFIX = "%into.";

export function resultEntryName(name: string): string {
  return `${RESULT_ENTRY_PREFIX}${name}`;
}

/** The local id of a result-slot entry's destination parameter. The
 * caller passes zeroed frame storage, and on every path the entry stores
 * each of its fields at most once, so a store into it is an
 * initialization: there is no old value to release. */
export const RESULT_DST_ID = "%into.dst";

/** Whether `s`, a statement of the function `fnName`, is a result-slot
 * entry's store into its destination. The destination is frame storage of
 * a caller that only projects the value (llvm/stack-objects.ts), so the
 * store initializes a field of an object no other object can point to. */
export function resultSlotStore(fnName: string, s: IrStmt): boolean {
  return (
    s.kind === "recordSet" &&
    s.obj.kind === "varRef" &&
    s.obj.localId === RESULT_DST_ID &&
    fnName.startsWith(RESULT_ENTRY_PREFIX)
  );
}
