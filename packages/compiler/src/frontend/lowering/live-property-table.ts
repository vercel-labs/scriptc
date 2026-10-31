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
 * this path allowed could not be read back the same way. A record with a
 * hidden `%`-prefixed field is the same kind of handle (a builtin object
 * the compiler boxes, `new TextEncoder()` becomes `{ "%TextEncoder": n }`),
 * not a JavaScript object with properties, so it stays fenced too. */
import type { Lowerer } from "./lowerer.js";
import type { IrType } from "../../ir/ir.js";

function isBuiltinHandleRecord(lowerer: Lowerer, shapeId: string): boolean {
  const shape = lowerer.shapes.get(shapeId);
  return !!shape && shape.fields.some((field) => field.name.startsWith("%"));
}

/** A TUPLE shape is positional: its struct has a slot per position and no
 * overflow, and a checked conversion of it keeps no source table
 * (recordMayKeepSource excludes tuples), so a named property written into
 * its capsule is lost by the next conversion — the array snapshot the
 * read answers from never carries it. Tuple values stay fenced. */
function isTupleRecord(lowerer: Lowerer, shapeId: string): boolean {
  return lowerer.shapes.get(shapeId)?.tuple === true;
}

/** Whether any function in the program registered an expando member under
 * this name. Those writes live in a MODULE GLOBAL keyed by the declaring
 * function's symbol (lower-expando.ts), which a read through any other
 * reference cannot reach: the function's live property table never holds
 * the value, so such reads stay fenced rather than answering undefined. */
export function registryExpandoName(lowerer: Lowerer, name: string): boolean {
  for (const members of lowerer.expandoMembers.values()) {
    if (members.names.has(name)) return true;
  }
  return false;
}

export function keepsLivePropertyTable(lowerer: Lowerer, type: IrType): boolean {
  switch (type.kind) {
    case "record":
      return !isBuiltinHandleRecord(lowerer, type.shapeId) && !isTupleRecord(lowerer, type.shapeId);
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
