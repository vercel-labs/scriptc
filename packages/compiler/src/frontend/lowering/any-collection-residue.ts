import { type IrType, typeKey } from "../../ir/ir.js";
import type { Lowerer } from "./lowerer.js";

/** Whether `actual` is `declared` with every `Map<unknown, unknown>` or
 * `Set<unknown>` (TypeScript's `any` type arguments of an untyped empty
 * collection, mapped to unknown) replaced by a map or set of a concrete
 * layout, and with nothing else different. A union `declared` matches when
 * `actual` is one of its record arms and every other arm is the residue
 * form of that arm. */
export function anyResidueReplacedBy(lowerer: Lowerer, declared: IrType, actual: IrType): boolean {
  const residue = (t: IrType): boolean =>
    (t.kind === "map" && t.key.kind === "dyn" && t.value.kind === "dyn") ||
    (t.kind === "set" && t.elem.kind === "dyn");
  const replaces = (d: IrType, a: IrType, seen: Set<string>): boolean => {
    if (typeKey(d) === typeKey(a)) return true;
    if (residue(d)) return a.kind === d.kind && !residue(a);
    if (d.kind === "record" && a.kind === "record") {
      const pair = `${d.shapeId}>${a.shapeId}`;
      if (seen.has(pair)) return true;
      seen.add(pair);
      const from = lowerer.shapes.get(d.shapeId);
      const to = lowerer.shapes.get(a.shapeId);
      if (!from || !to || from.tuple || to.tuple || from.indexValue || to.indexValue) return false;
      if (from.fields.length !== to.fields.length) return false;
      return from.fields.every((field) => {
        const other = to.fields.find((f) => f.name === field.name);
        return other !== undefined && replaces(field.type, other.type, seen);
      });
    }
    return false;
  };
  if (declared.kind === "union" && actual.kind === "record") {
    const arms = lowerer.unions.get(declared.unionId)?.arms ?? [];
    return (
      arms.some((arm) => typeKey(arm) === typeKey(actual)) &&
      arms.every(
        (arm) =>
          typeKey(arm) === typeKey(actual) ||
          (arm.kind === "record" && replaces(arm, actual, new Set())),
      )
    );
  }
  return replaces(declared, actual, new Set());
}
