/* Undeclared properties of checked records: the runtime keeps the source
 * object's own keys beside a closed record (scr_record_source_note and the
 * JSON schema parser) and identifies declared keys by their index in the
 * shape's declaration order. The name tables, the JSON schema's field list
 * and the per-shape JSON field writer must all use this one order. */
import type { IrRecordShape } from "../../ir/ir.js";

/** Field names in declaration order (the order the record serializes),
 * followed by fields the declaration order omits (internal '%'-fields). */
export function recordSourceFieldOrder(shape: IrRecordShape): string[] {
  const declared = new Set(shape.fields.map((f) => f.name));
  const order = (shape.declaredOrder ?? []).filter((name) => declared.has(name));
  const listed = new Set(order);
  return [...order, ...shape.fields.map((f) => f.name).filter((name) => !listed.has(name))];
}
