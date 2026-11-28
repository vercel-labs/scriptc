import { type Lowerer } from "./lowerer.js";
import {
  type IrType,
  isJsonStringifyDynamicType,
  isJsonStringifyRuntimeScalarType,
} from "../../ir/ir.js";

/** Whether a record, or something inside one, declares a toJSON function.
 * JSON.stringify calls it, so the type-directed serializer (which omits
 * function-valued fields) cannot be used; the value crosses into the runtime
 * walker instead. Shared by JSON.stringify and by process.send, which Node
 * also serializes with JSON.stringify. */
export function recordDeclaresToJson(
  lowerer: Lowerer,
  t: IrType,
  visiting: Set<string> = new Set(),
): boolean {
  switch (t.kind) {
    case "array":
      return recordDeclaresToJson(lowerer, t.elem, visiting);
    case "record": {
      const shape = lowerer.shapes.get(t.shapeId);
      if (shape === undefined || visiting.has(t.shapeId)) return false;
      visiting.add(t.shapeId);
      for (const field of shape.fields) {
        if (field.name === "toJSON" && field.type.kind === "func") return true;
        if (recordDeclaresToJson(lowerer, field.type, visiting)) return true;
      }
      return shape.indexValue !== undefined
        ? recordDeclaresToJson(lowerer, shape.indexValue, visiting)
        : false;
    }
    case "union": {
      const def = lowerer.unions.get(t.unionId);
      const key = `union:${t.unionId}`;
      if (def === undefined || visiting.has(key)) return false;
      visiting.add(key);
      return def.arms.some((arm) => recordDeclaresToJson(lowerer, arm, visiting));
    }
    default:
      return false;
  }
}

/** Whether serializing `t` needs the runtime JSON walker rather than the
 * type-directed serializer: a JSON-shaped container whose payloads are
 * checked-dynamic, a value that can hold a symbol, bigint or undefined at
 * any position, or a record that declares toJSON. */
export function needsJsonRuntimeWalker(lowerer: Lowerer, t: IrType): boolean {
  const getRecord = (id: string) => lowerer.shapes.get(id);
  const getUnion = (id: string) => lowerer.unions.get(id);
  return (
    isJsonStringifyDynamicType(t, getRecord, getUnion) ||
    isJsonStringifyRuntimeScalarType(t, getRecord, getUnion) ||
    recordDeclaresToJson(lowerer, t)
  );
}
