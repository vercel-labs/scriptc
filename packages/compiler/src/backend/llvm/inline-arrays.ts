/* Inline array fields in the LLVM backend (ir/inline-arrays.ts plans them).
 *
 * A compact class with such a field (LlClassMeta.inlineTail) keeps the
 * field's element count as an i32 in the field's slot and the elements as
 * 32-bit region references after its fixed fields, at the subtree's tail
 * offset. `new` reads the count from the constructor argument the field is
 * written from and allocates the instance with room for them; the
 * constructor's write copies the argument's elements there
 * (scr_arr_copy_cref_tail). Reads that index the field, read its length or
 * iterate it load the elements directly; any other read gives a frozen array
 * over them (scr_arr_view_cref). */

import { isRefCounted, type IrModule, type IrType } from "../../ir/ir.js";
import { mangleClassStruct } from "../mangle.js";
import { compactRefLoadLines, type LlInlineTail } from "./classes.js";
import { f64Lit } from "./common.js";
import type { LlvmTargetOptions } from "./emitter.js";
import type { LlValue, LlvmEmitterContext } from "./expr-context.js";
import { arrOps } from "./shapes.js";

/** Whether `mod` emitted with `options` can keep inline array fields inline:
 * an executable for a 64-bit target whose compact instances live in the low
 * region (32-bit references), without lifetime regions (which keep their
 * own class layouts), and with fields to keep. */
export function inlineArraysApply(mod: IrModule, options: LlvmTargetOptions): boolean {
  return (
    (mod.contracts?.inlineArrays?.length ?? 0) > 0 &&
    options.pointerBits !== 32 &&
    options.lowRegion === true &&
    mod.lib === undefined &&
    mod.lifetimeRegions !== true
  );
}

/** Whether instances of `className` are ProgramLifetime instances: the
 * root of its hierarchy is declared `implements ProgramLifetime`. */
export function programLifetimeClassOf(mod: IrModule): (className: string) => boolean {
  const roots = new Set(mod.contracts?.programLifetime ?? []);
  const bases = new Map<string, string | undefined>();
  for (const cls of mod.classes ?? []) bases.set(cls.name, cls.base);
  return (className) => {
    let name: string | undefined = className;
    let root = className;
    while (name !== undefined && bases.has(name)) {
      root = name;
      name = bases.get(name);
    }
    return bases.has(className) && roots.has(root);
  };
}

/** The field of `className` whose elements its instances keep inline, when
 * `field` is it. */
export function inlineFieldTail(
  host: LlvmEmitterContext,
  className: string,
  field: string,
): LlInlineTail | undefined {
  const tail = host.inlineTailOf(className);
  if (tail === undefined) return undefined;
  return host.classMeta.get(className)!.def.fields[tail.field]!.name === field ? tail : undefined;
}

/** Loads the element count of the inline array field of `obj` (an instance
 * of `className`) as an i32; returns the value's name. */
export function emitInlineCount(
  host: LlvmEmitterContext,
  obj: string,
  className: string,
  tail: LlInlineTail,
): string {
  const B = host.B;
  const meta = host.classMeta.get(className)!;
  const countp = B.tmp();
  const count = B.tmp();
  B.line(
    `${countp} = getelementptr inbounds %${mangleClassStruct(className)}, ptr ${obj}, i64 0, i32 ${meta.compactSlots[tail.field]!}`,
  );
  B.line(`${count} = load i32, ptr ${countp}`);
  return count;
}

/** The address of the first element of the inline array field of `obj`. */
export function emitInlineElements(
  host: LlvmEmitterContext,
  obj: string,
  tail: LlInlineTail,
): string {
  const B = host.B;
  const at = B.tmp();
  B.line(`${at} = getelementptr inbounds i8, ptr ${obj}, i64 ${tail.tailOffset}`);
  return at;
}

/** The constructor's write of the inline array field of `obj`: copies the
 * elements of `value` (an array) into the instance, which `new` allocated
 * for that array's length. */
export function emitInlineArrayInit(
  host: LlvmEmitterContext,
  obj: string,
  className: string,
  tail: LlInlineTail,
  value: string,
): void {
  const count = emitInlineCount(host, obj, className, tail);
  const at = emitInlineElements(host, obj, tail);
  host.declare(`declare void @scr_arr_copy_cref_tail(ptr, ptr, i32)`);
  host.B.line(`call void @scr_arr_copy_cref_tail(ptr ${value}, ptr ${at}, i32 ${count})`);
}

/** The inline array field of `obj` as an array value: a frozen array over
 * the elements (scr_arr_view_cref). Returns the owned (+1) array's name. */
export function emitInlineArrayView(
  host: LlvmEmitterContext,
  obj: string,
  className: string,
  tail: LlInlineTail,
): string {
  const count = emitInlineCount(host, obj, className, tail);
  const at = emitInlineElements(host, obj, tail);
  const ops = arrOps(host.shapeHost, { kind: "object", className: tail.elemClass });
  host.declare(`declare ptr @scr_arr_view_cref(ptr, ptr, i32)`);
  const view = host.B.tmp();
  host.B.line(`${view} = call ptr @scr_arr_view_cref(ptr ${ops}, ptr ${at}, i32 ${count})`);
  return view;
}

/** The index as an i64 slot, and whether the number is an integer below
 * `count` (an i32). */
function emitInlineIndex(
  host: LlvmEmitterContext,
  count: string,
  index: LlValue,
): { slot: string; within: string } {
  const B = host.B;
  const bound = B.tmp();
  B.line(`${bound} = zext i32 ${count} to i64`);
  const integer = index.integer;
  if (integer !== undefined) {
    let slot = integer.name;
    if (integer.type === "i32") {
      slot = B.tmp();
      B.line(`${slot} = ${integer.signed ? "sext" : "zext"} i32 ${integer.name} to i64`);
    }
    const within = B.tmp();
    B.line(`${within} = icmp ult i64 ${slot}, ${bound}`);
    return { slot, within };
  }
  host.declare(`declare i64 @llvm.fptosi.sat.i64.f64(double)`);
  const truncated = B.tmp();
  const back = B.tmp();
  const exact = B.tmp();
  const below = B.tmp();
  const within = B.tmp();
  B.line(`${truncated} = call i64 @llvm.fptosi.sat.i64.f64(double ${index.name})`);
  B.line(`${back} = sitofp i64 ${truncated} to double`);
  B.line(`${exact} = fcmp oeq double ${back}, ${index.name}`);
  B.line(`${below} = icmp ult i64 ${truncated}, ${bound}`);
  B.line(`${within} = and i1 ${exact}, ${below}`);
  return { slot: truncated, within };
}

/** `index in obj.field` (`has`, an i1) or the slot state (`state`, a double:
 * HOLE=0, VALUE=1) for an inline array field. Its elements are instances,
 * never holes or undefined, so an index is present exactly when it is an
 * integer within the count. */
export function emitInlineArrayState(
  host: LlvmEmitterContext,
  obj: string,
  className: string,
  tail: LlInlineTail,
  index: LlValue,
  kind: "has" | "state",
): string {
  const count = emitInlineCount(host, obj, className, tail);
  const { within } = emitInlineIndex(host, count, index);
  if (kind === "has") return within;
  const state = host.B.tmp();
  host.B.line(`${state} = select i1 ${within}, double ${f64Lit(1)}, double ${f64Lit(0)}`);
  return state;
}

/** `obj.field[index]` for an inline array field: the element at an index
 * within the count, loaded from the instance. Any other index takes the
 * runtime getter over a view, which reports it like a read of an ordinary
 * array. With `retain`, the result is an owned reference when the element
 * type is reference counted (like emitDenseArrayRead); without, borrowed
 * from the instance. */
export function emitInlineArrayGet(
  host: LlvmEmitterContext,
  obj: string,
  className: string,
  tail: LlInlineTail,
  index: LlValue,
  element: IrType,
  retain: boolean,
): string {
  const B = host.B;
  const count = emitInlineCount(host, obj, className, tail);
  const at = emitInlineElements(host, obj, tail);
  const { slot, within } = emitInlineIndex(host, count, index);
  const hit = B.newLabel("inl.get.hit");
  const miss = B.newLabel("inl.get.miss");
  const join = B.newLabel("inl.get.join");
  B.condBr(within, hit, miss);
  B.startBlock(hit);
  const p = B.tmp();
  const ref = B.tmp();
  const raw = B.tmp();
  B.line(`${p} = getelementptr inbounds i32, ptr ${at}, i64 ${slot}`);
  B.line(`${ref} = load i32, ptr ${p}`);
  for (const line of compactRefLoadLines(ref, raw, `${raw}.r`)) B.line(line.trimStart());
  const value = retain && isRefCounted(element) ? host.retainFrame(raw, element) : raw;
  const hitEnd = B.currentLabel();
  B.br(join);
  B.startBlock(miss);
  // Outside the count: the getter of an ordinary array over the elements
  // decides, as for any array (an out-of-bounds read traps).
  const ops = arrOps(host.shapeHost, { kind: "object", className: tail.elemClass });
  const getter = retain ? "scr_arr_get_ref" : "scr_arr_borrow_ref";
  host.declare(`declare ptr @scr_arr_view_cref(ptr, ptr, i32)`);
  host.declare(`declare ptr @${getter}(ptr, double)`);
  host.declare(`declare void @scr_arr_release(ptr)`);
  const view = B.tmp();
  const slow = B.tmp();
  B.line(`${view} = call ptr @scr_arr_view_cref(ptr ${ops}, ptr ${at}, i32 ${count})`);
  B.line(`${slow} = call ptr @${getter}(ptr ${view}, double ${indexDouble(host, index)}) cold`);
  B.line(`call void @scr_arr_release(ptr ${view})`);
  const missEnd = B.currentLabel();
  B.br(join);
  B.startBlock(join);
  const result = B.tmp();
  B.line(`${result} = phi ptr [ ${value}, %${hitEnd} ], [ ${slow}, %${missEnd} ]`);
  return result;
}

/** The index as a double (an integer snapshot's own double is its name). */
function indexDouble(host: LlvmEmitterContext, index: LlValue): string {
  if (index.type.kind === "f64") return index.name;
  const d = host.B.tmp();
  host.B.line(`${d} = sitofp i32 ${index.name} to double`);
  return d;
}

/** `obj.field.length` for an inline array field. */
export function emitInlineArrayLength(
  host: LlvmEmitterContext,
  obj: string,
  className: string,
  tail: LlInlineTail,
  type: IrType,
): LlValue {
  const count = emitInlineCount(host, obj, className, tail);
  const length = host.B.tmp();
  host.B.line(`${length} = uitofp i32 ${count} to double`);
  return { name: length, type, uint32: count };
}
