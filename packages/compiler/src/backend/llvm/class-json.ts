/* Reading a class instance's own properties for the type-directed JSON
 * writer (walkers.ts emitClassWriter).
 *
 * A class the frontend marked `jsonLayout` creates every own enumerable
 * property it can be observed with, in its slot, in the order the runtime
 * walk lists them (frontend/lowering/class-json.ts). The writer reads those
 * slots directly. One path stays with the runtime: an instance that took a
 * property through an untyped reference holds it in the compiler-owned
 * property bag, past the layout, so the writer tests the bag first and
 * hands such an instance to the runtime walk from its live capsule.
 */
import { InternalCompilerError } from "../../errors.js";
import { DYN_CLASS_PROPERTIES, isClassOwnEnumerableFieldName, type IrType } from "../../ir/ir.js";
import type { BlockBuilder } from "./blocks.js";
import {
  classFieldIndex,
  classStructSym,
  compactRefLoadLines,
  type LlClassMeta,
} from "./classes.js";
import type { LlvmEmitterContext } from "./expr-context.js";
import { nullableFieldUnion } from "./expr-stream-bridges.js";
import { inlineFieldTail } from "./inline-arrays.js";
import { arrOps, llFieldType, loadStructField } from "./shapes.js";

/** One property the writer emits: its key and the slot's type. */
export interface ClassJsonField {
  readonly name: string;
  readonly type: IrType;
}

/** The own enumerable properties of `className`'s instances, in layout
 * order — which the frontend established is also the order the runtime
 * walk lists them. Compiler-owned words, symbol-keyed fields and
 * function-valued fields contribute no key (`JSON.stringify` omits a
 * function value), and a field that can only hold `undefined` is dropped
 * the way the walk drops it. */
export function classJsonFields(host: LlvmEmitterContext, className: string): ClassJsonField[] {
  const meta = host.classMeta.get(className);
  if (meta === undefined) return [];
  const symbols = new Set((meta.def.symbolFields ?? []).map((entry) => entry.field));
  return meta.def.fields.filter(
    (field) =>
      isClassOwnEnumerableFieldName(field.name) &&
      !symbols.has(field.name) &&
      field.type.kind !== "func" &&
      field.type.kind !== "undefinedT",
  );
}

/** Reads `field` of the instance `obj` (typed `className`) as the value the
 * writer for `field.type` takes: the field's storage form, with an inline
 * union boxed on the stack and a nullable reference field boxed as the
 * union it is typed as. `release` frees the read's own temporary (an inline
 * array's view, a nullable field's union box) after the write, or is null
 * when the read borrows the slot. */
export function emitClassJsonFieldRead(
  host: LlvmEmitterContext,
  B: BlockBuilder,
  obj: string,
  className: string,
  field: ClassJsonField,
): { value: string; release: string | null } {
  const meta = host.classMeta.get(className);
  if (meta === undefined)
    throw new InternalCompilerError(
      `llvm emitter bug: JSON writer for undeclared class ${className}`,
    );
  const t = field.type;
  // An inline array field reads as a frozen array over the instance's
  // elements (inline-arrays.ts, classFieldDynValue).
  const tail = inlineFieldTail(host, className, field.name);
  if (tail !== undefined) {
    const countp = B.tmp(),
      count = B.tmp(),
      at = B.tmp(),
      view = B.tmp();
    B.line(
      `${countp} = getelementptr inbounds %${classStructSym(className)}, ptr ${obj}, i64 0, i32 ${meta.compactSlots[tail.field]!}`,
    );
    B.line(`${count} = load i32, ptr ${countp}`);
    B.line(`${at} = getelementptr inbounds i8, ptr ${obj}, i64 ${tail.tailOffset}`);
    const ops = arrOps(host.shapeHost, { kind: "object", className: tail.elemClass });
    host.declare(`declare ptr @scr_arr_view_cref(ptr, ptr, i32)`);
    host.declare(`declare void @scr_arr_release(ptr)`);
    B.line(`${view} = call ptr @scr_arr_view_cref(ptr ${ops}, ptr ${at}, i32 ${count})`);
    return { value: view, release: `call void @scr_arr_release(ptr ${view})` };
  }
  const { index, compressed } = classFieldIndex(meta, field.name, "compressed");
  const slot = B.tmp();
  B.line(
    `${slot} = getelementptr inbounds %${classStructSym(className)}, ptr ${obj}, i64 0, i32 ${index}`,
  );
  let value: string;
  if (host.int32Slots.isField(className, field.name)) {
    // An integer-valued field: the slot holds the i32 the number always is.
    const raw = B.tmp();
    B.line(`${raw} = load i32, ptr ${slot}`);
    value = B.tmp();
    B.line(`${value} = sitofp i32 ${raw} to double`);
  } else if (host.inlineUnions.classField(className, field.name)) {
    value = loadStructField(B, host.sizeType, slot, t, true);
  } else if (compressed) {
    const idx = B.tmp();
    B.line(`${idx} = load i32, ptr ${slot}`);
    value = B.tmp();
    for (const line of compactRefLoadLines(host.compactRefBase, idx, value, `${value}.r`))
      B.line(line.trimStart());
  } else {
    value = B.tmp();
    B.line(`${value} = load ${llFieldType(t, false)}, ptr ${slot}`);
  }
  if (llFieldType(t, false) === "i8") {
    const bool = B.tmp();
    B.line(`${bool} = trunc i8 ${value} to i1`);
    value = bool;
  }
  const nullable = host.nullableFields.get(className, field.name);
  if (nullable !== null) {
    // The slot holds the arm pointer itself (NULL for the unit arm); the
    // writer takes the union the field is typed as.
    host.declare(`declare void @scr_union_release(ptr)`);
    value = nullableFieldUnion(host, B, value, nullable);
    return { value, release: `call void @scr_union_release(ptr ${value})` };
  }
  return { value, release: null };
}

/** i1: the instance's property bag holds anything, so properties exist past
 * the layout (a property taken through an untyped reference, a field a
 * tracked class recorded, a deletion), or null when the class has no bag at
 * all — then nothing outside the layout can exist. */
export function emitClassJsonBagHeld(
  host: LlvmEmitterContext,
  B: BlockBuilder,
  obj: string,
  className: string,
): string | null {
  const meta = host.classMeta.get(className);
  if (meta === undefined || !meta.def.fields.some((f) => f.name === DYN_CLASS_PROPERTIES))
    return null;
  const { index, compressed } = classFieldIndex(meta, DYN_CLASS_PROPERTIES, "compressed");
  const slot = B.tmp();
  B.line(
    `${slot} = getelementptr inbounds %${classStructSym(className)}, ptr ${obj}, i64 0, i32 ${index}`,
  );
  let bag: string;
  if (compressed) {
    const idx = B.tmp();
    B.line(`${idx} = load i32, ptr ${slot}`);
    bag = B.tmp();
    for (const line of compactRefLoadLines(host.compactRefBase, idx, bag, `${bag}.b`))
      B.line(line.trimStart());
  } else {
    bag = B.tmp();
    B.line(`${bag} = load ptr, ptr ${slot}`);
  }
  // The bag is absent both as NULL (no field written) and as the shared
  // undefined value it starts out as; anything else is a live object.
  host.declare(`declare ptr @scr_dyn_undefined()`);
  const nonNull = B.tmp(),
    undefinedWord = B.tmp(),
    defined = B.tmp(),
    held = B.tmp();
  B.line(`${nonNull} = icmp ne ptr ${bag}, null`);
  B.line(`${undefinedWord} = call ptr @scr_dyn_undefined()`);
  B.line(`${defined} = icmp ne ptr ${bag}, ${undefinedWord}`);
  B.line(`${held} = and i1 ${nonNull}, ${defined}`);
  return held;
}

/** Writes the instance through the runtime walk: its live capsule keeps the
 * native slots, the property bag and the prototype, so the walk sees the
 * same own properties, in the same order, as it would without the compiler
 * (toJSON, getters, the circular-structure stack included). */
export function emitClassJsonDynWrite(
  host: LlvmEmitterContext,
  B: BlockBuilder,
  buf: string,
  obj: string,
  className: string,
): void {
  const conv = host.dyn.toDynHelper({ kind: "object", className });
  const box = B.tmp();
  B.line(`${box} = call ptr @${conv}(ptr ${obj}) ; +1`);
  host.declare(`declare void @scr_jb_put_dyn(ptr, ptr)`);
  B.line(`call void @scr_jb_put_dyn(ptr ${buf}, ptr ${box})`);
  host.declare(`declare void @scr_dyn_release(ptr)`);
  B.line(`call void @scr_dyn_release(ptr ${box})`);
}

/** Whether the writer for `meta` reads the layout: the frontend admitted
 * the class (jsonLayout) and the class graph still gives it no subclass
 * whose instance could stand in for it. */
export function classJsonReadsLayout(meta: LlClassMeta): boolean {
  return (
    meta.def.jsonLayout === true &&
    meta.children.length === 0 &&
    meta.def.runtime !== true &&
    meta.root.def.runtime !== true &&
    !meta.def.fields.some((f) => f.name.startsWith("%attr:"))
  );
}
