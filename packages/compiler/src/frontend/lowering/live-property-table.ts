/* Which typed representations keep a live own-property table when they
 * cross into dynamic code. Those values are the ones an expando write
 * (`match.index = 0`, `arr.extra = v`) can reach: the write lands in the
 * live checked-dynamic capsule (the record source table, the array's
 * named-property table, an instance's dynamic view, a function's property
 * table) and every later read — typed,
 * dynamic or reflective — observes it.
 *
 * A Date, RegExp, Map, Set or stream handle has no such table: its box is
 * a per-box expando that would not survive the identity the handle keeps,
 * so writes to those values stay fenced. A byte view is excluded for the
 * read side: an undeclared member name on one answers undefined from a
 * static decision that Node's typed-array prototypes lack it, so a write
 * this path allowed could not be read back the same way. */
import type { Lowerer } from "./lowerer.js";
import type { IrType } from "../../ir/ir.js";

export function keepsLivePropertyTable(lowerer: Lowerer, type: IrType): boolean {
  switch (type.kind) {
    case "record":
    case "array":
    case "func":
      return true;
    case "object": {
      const info = lowerer.classes.get(type.className);
      return (
        !!info &&
        !info.def.runtime &&
        !info.builtinError &&
        !info.builtinEmitter &&
        !info.builtinStream
      );
    }
    default:
      return false;
  }
}
