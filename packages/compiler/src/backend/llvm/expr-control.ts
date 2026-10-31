import { emitBorrowedInput } from "./borrowed-inputs.js";
/* Focused LLVM expression emission extracted from emitter.ts. */
import { InternalCompilerError } from "../../errors.js";
import { undefinedArmTag } from "../../ir/analysis.js";
import { isRefCounted, isUnitType, typeEquals, type IrExpr, type IrType } from "../../ir/ir.js";
import { DYN_KIND } from "./dyn.js";
import { LlvmUnsupportedError } from "./unsupported.js";
import type { LlvmEmitterContext, ExprOf, LlValue } from "./expr-context.js";
import { f64Lit } from "./common.js";
import { emitRecordKeyGetOr } from "./expr-records.js";
import { NULLABLE_NULL, SHAPE_WORD_INDEX, shapeWordHeader } from "./nullable-unions.js";
import { emitUnionTag } from "./union-repr.js";

/** Each kind emits in a function of its own: emitting a nested chain of
 * these expressions holds one emitControlExpr frame per level, and in an
 * unoptimized build of the compiler a frame holds every local of the
 * function. */
export function emitControlExpr(
  host: LlvmEmitterContext,
  e: ExprOf<
    | "dynDestrCheck"
    | "dynIterN"
    | "toBool"
    | "logical"
    | "ternary"
    | "optChain"
    | "chainRecv"
    | "orDefault"
    | "nullish"
  >,
): LlValue {
  switch (e.kind) {
    case "dynDestrCheck":
      return emitDynDestrCheck(host, e);
    case "dynIterN":
      return emitDynIterN(host, e);
    case "toBool":
      return { name: host.truthy(host.emitUnionProjection(e.operand)), type: e.type };
    case "logical":
      return emitLogical(host, e);
    case "ternary":
      return emitTernary(host, e);
    case "optChain":
      return emitOptChain(host, e);
    case "chainRecv":
      return emitChainRecv(host, e);
    case "orDefault":
      return emitOrDefault(host, e);
    case "nullish":
      return emitNullish(host, e);
    default: {
      const _exhaustive: never = e;
      void _exhaustive;
      throw new InternalCompilerError("unreachable");
    }
  }
}

function emitDynDestrCheck(host: LlvmEmitterContext, e: ExprOf<"dynDestrCheck">): LlValue {
  const B = host.B;
  // RequireObjectCoercible with V8's destructuring TypeError. dyn
  // values check in the runtime helper and pass through unchanged.
  const v = host.emitExpr(e.value);
  const first = e.firstProp !== undefined ? host.cstr(e.firstProp) : "null";

  const helper = host.dyn.dynDestrCheckHelper();
  B.line(`call void @${helper}(ptr ${v.name}, ptr ${host.cstr(e.spelling)}, ptr ${first})`);
  host.emitPendingCheck();
  return v;
}

function emitDynIterN(host: LlvmEmitterContext, e: ExprOf<"dynIterN">): LlValue {
  const B = host.B;
  // GetIterator + first-N steps as a fresh array (V8's exact
  // not-iterable TypeError on non-iterables) through the native dyn helper.
  const v = emitBorrowedInput(host, e.value);

  const helper = host.dyn.dynIterNHelper();
  const t = B.tmp();
  B.line(
    `${t} = call ptr @${helper}(ptr ${v.name}, ${host.sizeType} ${e.count}, ptr ${e.notIterableMessage ? host.cstr(e.notIterableMessage) : "null"})`,
  );
  const out = host.own({ name: t, type: e.type });
  host.emitPendingCheck();
  return out;
}

function emitLogical(host: LlvmEmitterContext, e: ExprOf<"logical">): LlValue {
  const B = host.B;
  const tagSet = e.op === "||" ? unionTagSet(e) : null;
  if (tagSet) return { name: emitUnionTagSet(host, tagSet), type: e.type };
  // JS value semantics: the result is the deciding operand itself.
  // Left evaluates once, ownership moves into the result slot; when
  // the branch takes the right operand the stale left releases first
  // and the right runs in its own frame.
  const ty = host.llType(e.type);
  const l = host.emitExpr(e.left);
  host.toFrame(l);
  const slot = B.slot();
  B.entryAllocas.push(`${slot} = alloca ${ty}`);
  B.line(`store ${ty} ${l.name}, ptr ${slot}`);
  const integerSlot = e.type.kind === "f64" && l.uint32 !== undefined ? B.slot() : undefined;
  if (integerSlot !== undefined) {
    B.entryAllocas.push(`${integerSlot} = alloca i32`);
    B.line(`store i32 ${l.uint32!}, ptr ${integerSlot}`);
  }
  const truthy = host.truthy(l);
  const rightLabel = B.newLabel("log.r");
  const joinLabel = B.newLabel("log.j");
  if (e.op === "&&") B.condBr(truthy, rightLabel, joinLabel);
  else B.condBr(truthy, joinLabel, rightLabel);
  B.startBlock(rightLabel);
  if (isRefCounted(e.type)) host.releaseFrame(l.name, e.type);
  const rightInteger = host.emitBranchInto(slot, e.right, integerSlot);
  B.br(joinLabel);
  B.startBlock(joinLabel);
  const t = B.tmp();
  B.line(`${t} = load ${ty}, ptr ${slot}`);
  if (integerSlot !== undefined && rightInteger) {
    const uint32 = B.tmp();
    B.line(`${uint32} = load i32, ptr ${integerSlot}`);
    return { name: t, type: e.type, uint32 };
  }
  return host.own({ name: t, type: e.type });
}

function emitTernary(host: LlvmEmitterContext, e: ExprOf<"ternary">): LlValue {
  const B = host.B;
  // Exactly one arm evaluates; each arm runs in its own frame and
  // moves the chosen value into the result slot.
  const ty = host.llType(e.type);
  const c = host.emitExpr(e.cond);
  const slot = B.slot();
  B.entryAllocas.push(`${slot} = alloca ${ty}`);
  const integerSlot = e.type.kind === "f64" ? B.slot() : undefined;
  if (integerSlot !== undefined) B.entryAllocas.push(`${integerSlot} = alloca i32`);
  const lt = B.newLabel("tern.t");
  const lf = B.newLabel("tern.f");
  const lj = B.newLabel("tern.j");
  B.condBr(c.name, lt, lf);
  B.startBlock(lt);
  const thenInteger = host.emitBranchInto(slot, e.then, integerSlot);
  B.br(lj);
  B.startBlock(lf);
  const elseInteger = host.emitBranchInto(slot, e.else_, integerSlot);
  B.br(lj);
  B.startBlock(lj);
  const t = B.tmp();
  B.line(`${t} = load ${ty}, ptr ${slot}`);
  // A view is available only when every incoming branch wrote it.
  // Incomplete views are unused and disappear during promotion.
  if (integerSlot !== undefined && thenInteger && elseInteger) {
    const uint32 = B.tmp();
    B.line(`${uint32} = load i32, ptr ${integerSlot}`);
    return { name: t, type: e.type, uint32 };
  }
  // A choice between interned literals is an interned literal: like a
  // strLit operand, nothing owns it (retain and release are no-ops).
  if (literalChoice(e)) return host.markImmortal({ name: t, type: e.type });
  return host.own({ name: t, type: e.type });
}

function emitOptChain(host: LlvmEmitterContext, e: ExprOf<"optChain">): LlValue {
  const B = host.B;
  // `a?.b` / `f?.()`: the nullish test inverted. The receiver
  // evaluates once into an ordinary frame temp (borrowed); on a unit
  // tag the result is the interned undefined arm and the body never
  // runs; otherwise the narrowed payload fills the bind slot (+1,
  // frame-owned through a SLOT entry — NULL on the unit path, where
  // the frame's release is a no-op) and the body reads it through
  // chainRecv.
  if (e.receiver.type.kind === "dyn") {
    // A dyn (dyn) receiver — the `rawName?.match(re)` step: the
    // nullish test reads the node's kind tag; the unit path is the
    // undefined dyn singleton (dyn results) or nothing (void
    // bodies), the body runs over the bound receiver otherwise.
    const r = host.emitExpr(e.receiver);
    const kd = host.dynKind(r.name);
    const isU = B.tmp();
    const isN = B.tmp();
    const isUnit = B.tmp();
    B.line(`${isU} = icmp eq i32 ${kd}, ${DYN_KIND.UNDEF}`);
    B.line(`${isN} = icmp eq i32 ${kd}, ${DYN_KIND.NULL}`);
    B.line(`${isUnit} = or i1 ${isU}, ${isN}`);
    const bind = B.slot();
    B.entryAllocas.push(`${bind} = alloca ptr`);
    B.line(`store ptr null, ptr ${bind}`);
    host.ownSlot(bind, e.receiver.type);
    host.declare(`declare ptr @scr_dyn_retain_v(ptr)`);
    if (e.type.kind === "void") {
      const lb = B.newLabel("ocd.b");
      const lj = B.newLabel("ocd.j");
      B.condBr(isUnit, lj, lb);
      B.startBlock(lb);
      const rr = B.tmp();
      B.line(`${rr} = call ptr @scr_dyn_retain_v(ptr ${r.name})`);
      B.line(`store ptr ${rr}, ptr ${bind}`);
      host.chainSlots.set(e.id, { name: bind, type: e.receiver.type, slot: true });
      host.frames.push([]);
      host.emitExpr(e.body);
      host.releaseTemps(host.frames.pop()!);
      host.chainSlots.delete(e.id);
      B.br(lj);
      B.startBlock(lj);
      return { name: "", type: e.type };
    }
    if (e.type.kind !== "dyn")
      throw new InternalCompilerError("llvm emitter bug: dyn optChain result kind");
    const slot = B.slot();
    B.entryAllocas.push(`${slot} = alloca ptr`);
    const lu = B.newLabel("ocd.u");
    const lb = B.newLabel("ocd.b");
    const lj = B.newLabel("ocd.j");
    B.condBr(isUnit, lu, lb);
    B.startBlock(lu);
    host.declare(`declare ptr @scr_dyn_undefined()`);
    const un = B.tmp();
    const ur = B.tmp();
    B.line(`${un} = call ptr @scr_dyn_undefined()`);
    B.line(`${ur} = call ptr @scr_dyn_retain_v(ptr ${un})`);
    B.line(`store ptr ${ur}, ptr ${slot}`);
    B.br(lj);
    B.startBlock(lb);
    const rr = B.tmp();
    B.line(`${rr} = call ptr @scr_dyn_retain_v(ptr ${r.name})`);
    B.line(`store ptr ${rr}, ptr ${bind}`);
    host.chainSlots.set(e.id, { name: bind, type: e.receiver.type, slot: true });
    host.emitBranchInto(slot, e.body);
    host.chainSlots.delete(e.id);
    B.br(lj);
    B.startBlock(lj);
    const t = B.tmp();
    B.line(`${t} = load ptr, ptr ${slot}`);
    return host.own({ name: t, type: e.type });
  }

  const { isUnit, bindPresent } = emitOptionalChainReceiver(host, e);
  if (e.type.kind === "void") {
    // Statement form (cb?.()): no result value at all.
    const lb = B.newLabel("oc.b");
    const lj = B.newLabel("oc.j");
    B.condBr(isUnit, lj, lb);
    B.startBlock(lb);
    bindPresent();
    host.frames.push([]);
    host.emitExpr(e.body);
    host.releaseTemps(host.frames.pop()!);
    host.chainSlots.delete(e.id);
    B.br(lj);
    B.startBlock(lj);
    return { name: "", type: e.type };
  }
  if (e.type.kind === "dyn") {
    // A dyn-typed chain (`pricing?.[key]` over an unknown-valued
    // index signature): the unit path is the undefined dyn value —
    // dyn represents undefined directly, no union wrapper exists.
    const slotD = B.slot();
    B.entryAllocas.push(`${slotD} = alloca ptr`);
    const lu = B.newLabel("ocu.u");
    const lb = B.newLabel("ocu.b");
    const lj = B.newLabel("ocu.j");
    B.condBr(isUnit, lu, lb);
    B.startBlock(lu);
    host.declare(`declare ptr @scr_dyn_undefined()`);
    host.declare(`declare ptr @scr_dyn_retain_v(ptr)`);
    const un = B.tmp();
    const ur = B.tmp();
    B.line(`${un} = call ptr @scr_dyn_undefined()`);
    B.line(`${ur} = call ptr @scr_dyn_retain_v(ptr ${un})`);
    B.line(`store ptr ${ur}, ptr ${slotD}`);
    B.br(lj);
    B.startBlock(lb);
    bindPresent();
    host.emitBranchInto(slotD, e.body);
    host.chainSlots.delete(e.id);
    B.br(lj);
    B.startBlock(lj);
    const t = B.tmp();
    B.line(`${t} = load ptr, ptr ${slotD}`);
    return host.own({ name: t, type: e.type });
  }
  if (e.type.kind !== "union")
    throw new LlvmUnsupportedError(`optChainResult:${e.type.kind}`, e.loc);
  const undefTag = undefinedArmTag(e.type, host.unionsById);
  if (undefTag < 0)
    throw new InternalCompilerError("llvm emitter bug: optChain result lacks its undefined arm");
  const ty = host.llType(e.type);
  const slot = B.slot();
  B.entryAllocas.push(`${slot} = alloca ${ty}`);
  const lu = B.newLabel("oc.u");
  const lb = B.newLabel("oc.b");
  const lj = B.newLabel("oc.j");
  B.condBr(isUnit, lu, lb);
  B.startBlock(lu);
  B.line(`store ptr ${host.unitInstanceRef(e.type.unionId, undefTag)}, ptr ${slot}`);
  B.br(lj);
  B.startBlock(lb);
  bindPresent();
  host.emitBranchInto(slot, e.body);
  host.chainSlots.delete(e.id);
  B.br(lj);
  B.startBlock(lj);
  const t = B.tmp();
  B.line(`${t} = load ${ty}, ptr ${slot}`);
  return host.own({ name: t, type: e.type });
}

function emitChainRecv(host: LlvmEmitterContext, e: ExprOf<"chainRecv">): LlValue {
  const B = host.B;
  const bound = host.chainSlots.get(e.id);
  if (!bound)
    throw new InternalCompilerError(`llvm emitter bug: chainRecv "${e.id}" outside its chain`);
  const v = B.tmp();
  B.line(`${v} = load ${host.llType(bound.type)}, ptr ${bound.name}`);
  if (!isRefCounted(e.type)) return { name: v, type: e.type };
  return host.own({ name: host.retainFrame(v, e.type), type: e.type });
}

function emitOrDefault(host: LlvmEmitterContext, e: ExprOf<"orDefault">): LlValue {
  const B = host.B;
  // `u || d` narrowed to the single non-unit arm: nullish's dance
  // with the union TRUTHY switch as the test — truthy extracts the
  // arm (+1 for ref kinds), falsy releases and runs the default.
  if (e.left.type.kind !== "union")
    throw new InternalCompilerError("llvm emitter bug: orDefault left is not a union");
  if (
    e.retag === undefined &&
    !host.nullableUnions.has(e.left.type.unionId) &&
    host.isStackUnionSource(e.left)
  ) {
    // A stack box (`arr[i] || d`): test truthiness and extract the
    // payload (+1). The box is never retained or released.
    const l = host.emitUnionProjection(e.left);
    const ty = host.llType(e.type);
    const slot = B.slot();
    B.entryAllocas.push(`${slot} = alloca ${ty}`);
    const lt = B.newLabel("ord.t"),
      lf = B.newLabel("ord.f"),
      lj = B.newLabel("ord.j");
    B.condBr(host.truthy(l), lt, lf);
    B.startBlock(lt);
    B.line(`store ${ty} ${host.unionExtract(l.name, e.left.type.unionId, e.type)}, ptr ${slot}`);
    B.br(lj);
    B.startBlock(lf);
    host.emitBranchInto(slot, e.right);
    B.br(lj);
    B.startBlock(lj);
    const t = B.tmp();
    B.line(`${t} = load ${ty}, ptr ${slot}`);
    return host.own({ name: t, type: e.type });
  }
  const l = host.emitExpr(e.left);
  host.toFrame(l);
  const ty = host.llType(e.type);
  const slot = B.slot();
  B.entryAllocas.push(`${slot} = alloca ${ty}`);
  const truthy = host.truthy(l);
  const lt = B.newLabel("ord.t");
  const lf = B.newLabel("ord.f");
  const lj = B.newLabel("ord.j");
  B.condBr(truthy, lt, lf);
  B.startBlock(lt);
  if (e.retag !== undefined) {
    // Retagged shape: the whole box goes to the union→union helper,
    // which CONSUMES it (callees own their params) — no release on
    // this side. The store precedes the pending check so an unwind
    // leaves only the NULL dummy behind, in a slot nothing reads.
    const t = B.tmp();
    B.line(`${t} = call ${ty} @${host.callTarget(e.retag)}(${host.llType(e.left.type)} ${l.name})`);
    B.line(`store ${ty} ${t}, ptr ${slot}`);
    if (host.mayThrow.has(e.retag)) host.emitPendingCheck();
  } else if (host.nullableUnions.single(e.left.type.unionId)) {
    // The owned nullable pointer IS the owned arm value.
    B.line(`store ${ty} ${l.name}, ptr ${slot}`);
  } else {
    B.line(`store ${ty} ${host.unionExtract(l.name, e.left.type.unionId, e.type)}, ptr ${slot}`);
    host.releaseFrame(l.name, e.left.type);
  }
  B.br(lj);
  B.startBlock(lf);
  host.releaseFrame(l.name, e.left.type);
  host.emitBranchInto(slot, e.right);
  B.br(lj);
  B.startBlock(lj);
  const t = B.tmp();
  B.line(`${t} = load ${ty}, ptr ${slot}`);
  return host.own({ name: t, type: e.type });
}

function emitNullish(host: LlvmEmitterContext, e: ExprOf<"nullish">): LlValue {
  const B = host.B;
  // `a ?? b`: logical's move/release dance with the left's runtime
  // TAG against its unit arms as the test. Pass-through shape: the
  // result IS the left box. Narrowed shape: the single non-unit
  // arm's payload extracts (+1 for ref kinds) and the box releases.

  if (e.left.type.kind === "dyn") {
    // The native checked-value kind decides whether the left is
    // nullish; the right runs lazily in its branch.
    const l = host.emitExpr(e.left);
    host.toFrame(l);
    host.declare(`declare zeroext i1 @scr_dyn_is_nullish(ptr)`);
    const slot = B.slot();
    B.entryAllocas.push(`${slot} = alloca ptr`);
    const isN = B.tmp();
    B.line(`${isN} = call zeroext i1 @scr_dyn_is_nullish(ptr ${l.name})`);
    const lu = B.newLabel("nuld.u");
    const lv = B.newLabel("nuld.v");
    const lj = B.newLabel("nuld.j");
    B.condBr(isN, lu, lv);
    B.startBlock(lu);
    host.releaseFrame(l.name, e.left.type);
    host.emitBranchInto(slot, e.right);
    B.br(lj);
    B.startBlock(lv);
    B.line(`store ptr ${l.name}, ptr ${slot}`);
    B.br(lj);
    B.startBlock(lj);
    const t = B.tmp();
    B.line(`${t} = load ptr, ptr ${slot}`);
    return host.own({ name: t, type: e.type });
  }
  if (e.left.type.kind !== "union")
    throw new InternalCompilerError("llvm emitter bug: nullish left is not a union");
  const def = host.unionsById.get(e.left.type.unionId);
  if (!def)
    throw new InternalCompilerError(
      `llvm emitter bug: nullish of unknown union ${e.left.type.unionId}`,
    );
  const unitTags = def.arms.flatMap((a, i) => (isUnitType(a) ? [i] : []));
  if (unitTags.length === 0)
    throw new InternalCompilerError("llvm emitter bug: nullish union lacks unit arms");
  const fused = emitNullishOptionalChain(host, e);
  if (fused) return fused;
  if (
    e.left.kind === "recordKeyGet" &&
    e.left.missNaN !== true &&
    typeEquals(e.type, e.left.type) &&
    storesNoUnit(host, e.left)
  )
    return emitRecordKeyGetOr(host, e.left, e.right);
  if (
    !typeEquals(e.type, e.left.type) &&
    (e.left.kind === "varRef" ||
      host.isStackUnionSource(e.left) ||
      host.nullableFieldGet(e.left) !== null)
  ) {
    // Narrowed shape over a binding or a stack box (`arr[i] ?? d`,
    // `map.get(k) ?? d`): test the tag and extract the payload (+1).
    // The box is never retained or released. A binding is borrowed:
    // no code runs between its read and the extraction, and the
    // default never touches it. Bindings proven projection-only may
    // hold stack boxes, which must never reach RC entry points.
    const l = host.emitUnionProjection(e.left);
    const ty = host.llType(e.type);
    const slot = B.slot();
    B.entryAllocas.push(`${slot} = alloca ${ty}`);
    const isUnit = host.tagInSet(l.name, def.id, unitTags);
    const lu = B.newLabel("nul.u");
    const lv = B.newLabel("nul.v");
    const lj = B.newLabel("nul.j");
    B.condBr(isUnit, lu, lv);
    B.startBlock(lu);
    host.emitBranchInto(slot, e.right);
    B.br(lj);
    B.startBlock(lv);
    B.line(`store ${ty} ${host.unionExtract(l.name, def.id, e.type)}, ptr ${slot}`);
    B.br(lj);
    B.startBlock(lj);
    const t = B.tmp();
    B.line(`${t} = load ${ty}, ptr ${slot}`);
    return host.own({ name: t, type: e.type });
  }
  const l = host.emitExpr(e.left);
  host.toFrame(l);
  const ty = host.llType(e.type);
  const slot = B.slot();
  B.entryAllocas.push(`${slot} = alloca ${ty}`);
  const isUnit = host.tagInSet(l.name, def.id, unitTags);
  const lu = B.newLabel("nul.u");
  const lv = B.newLabel("nul.v");
  const lj = B.newLabel("nul.j");
  B.condBr(isUnit, lu, lv);
  B.startBlock(lu);
  host.releaseFrame(l.name, e.left.type);
  host.emitBranchInto(slot, e.right);
  B.br(lj);
  B.startBlock(lv);
  if (typeEquals(e.type, e.left.type) || host.nullableUnions.single(def.id)) {
    // Pass-through, or a nullable pointer that IS its owned arm value.
    B.line(`store ${ty} ${l.name}, ptr ${slot}`);
  } else {
    B.line(`store ${ty} ${host.unionExtract(l.name, def.id, e.type)}, ptr ${slot}`);
    host.releaseFrame(l.name, e.left.type);
  }
  B.br(lj);
  B.startBlock(lj);
  const t = B.tmp();
  B.line(`${t} = load ${ty}, ptr ${slot}`);
  return host.own({ name: t, type: e.type });
}

/** The receiver half of a union-receiver `a?.b`. The receiver evaluates
 * once; `isUnit` tests its unit arms, and `bindPresent` fills the chain's
 * bind slot with the narrowed payload for the body to read through
 * chainRecv. The caller deletes the chain slot after the body. */
export function emitOptionalChainReceiver(
  host: LlvmEmitterContext,
  e: ExprOf<"optChain">,
): { isUnit: string; bindPresent: () => void } {
  const B = host.B;
  if (e.receiver.type.kind !== "union")
    throw new LlvmUnsupportedError(`optChain:${e.receiver.type.kind}`, e.loc);
  const def = host.unionsById.get(e.receiver.type.unionId);
  if (!def)
    throw new InternalCompilerError(
      `llvm emitter bug: optChain of unknown union ${e.receiver.type.unionId}`,
    );
  const unitTags = def.arms.flatMap((a, i) => (isUnitType(a) ? [i] : []));
  const narrowIdx = def.arms.findIndex((a) => !isUnitType(a));
  if (unitTags.length === 0 || narrowIdx < 0)
    throw new InternalCompilerError("llvm emitter bug: optChain union arms");
  const multiple = def.arms.length - unitTags.length > 1;
  const narrowed = multiple ? e.receiver.type : def.arms[narrowIdx]!;
  // `owner.field?.member`: a receiver projected from a borrowable owner
  // needs no reference of its own while the body cannot remove an edge
  // (so nothing can overwrite the projection before the body finishes).
  const borrowReceiver =
    !multiple && isRefCounted(narrowed) && borrowsChainReceiver(host, e.receiver, e.body);
  // An optional array read of a nullable-pointer union is the element
  // pointer itself, read inline and owned by the statement frame until
  // the body finishes; the bind slot borrows it like an emitExpr value.
  const nullableRead =
    !borrowReceiver &&
    !multiple &&
    host.nullableUnions.has(def.id) &&
    host.optionalArrayReads.get(e.receiver) !== null;
  // A single present arm is only tested and extracted (+1) before the
  // body runs, so a fresh receiver box can stay on the stack.
  const stacked =
    !borrowReceiver && !nullableRead && !multiple && host.canStackReceiver(e.receiver);
  let r: LlValue;
  const nullableField = borrowReceiver ? host.nullableFieldGet(e.receiver) : null;
  if (nullableField !== null && e.receiver.kind === "fieldGet") {
    // A nullable-pointer field stores no union: test and peek the
    // pointer itself, through a private stack box when the union's own
    // representation is boxed (emitUnionProjection's form).
    const owner = host.emitReadReceiver(e.receiver.obj);
    const { ptr } = host.classFieldPtr(
      owner.name,
      e.receiver.className,
      e.receiver.field,
      "compressed",
    );
    const p = host.loadRef(ptr);
    r = {
      name: host.nullableUnions.get(def.id) ? p : host.stackNullableBox(p, nullableField),
      type: e.receiver.type,
    };
  } else if (borrowReceiver || stacked || nullableRead) r = host.emitReadReceiver(e.receiver);
  else r = host.emitExpr(e.receiver);
  // The bind slot borrows a ref payload whenever something else keeps it
  // alive until the body finishes: the borrowed projection above, or the
  // receiver value the statement frame owns (emitExpr). Stack receivers
  // may borrow their payload from a container, so they keep their +1.
  const borrowBind = !multiple && !stacked && isRefCounted(narrowed);
  const bind = B.slot();
  B.entryAllocas.push(`${bind} = alloca ${host.llType(narrowed)}`);
  B.line(
    `store ${host.llType(narrowed)} ${host.llType(narrowed) === "ptr" ? "null" : host.llType(narrowed) === "double" ? f64Lit(0) : "false"}, ptr ${bind}`,
  );
  if (!borrowBind) host.ownSlot(bind, narrowed);
  const isUnit = host.tagInSet(r.name, def.id, unitTags);
  const extract = (): string =>
    multiple
      ? host.retainFrame(r.name, narrowed)
      : borrowBind
        ? host.unionPeek(r.name, def.id)
        : host.unionExtract(r.name, def.id, narrowed);
  return {
    isUnit,
    bindPresent: () => {
      B.line(`store ${host.llType(narrowed)} ${extract()}, ptr ${bind}`);
      host.chainSlots.set(e.id, { name: bind, type: narrowed, slot: true });
    },
  };
}

/** An optional chain's receiver can lend its payload to the bind slot when
 * the body leaves the receiver's locations alone: it removes no edge at
 * all, or it writes none of the locations the receiver reads. */
function borrowsChainReceiver(host: LlvmEmitterContext, receiver: IrExpr, body: IrExpr): boolean {
  if (!host.canBorrowReceiver(receiver)) return false;
  if (host.referenceEffects.preserves(body)) return true;
  const writes = host.referenceWrites;
  return writes !== null && host.unwrittenRead(receiver, writes.expr(body));
}

/** `a?.b ?? d` narrowed to the chain body's present arm. The body wraps a
 * value of the result type in a non-unit arm, so the default runs exactly
 * when the receiver is nullish and the intermediate result box is never
 * built. Receiver, body and default keep their evaluation order. */
function emitNullishOptionalChain(host: LlvmEmitterContext, e: ExprOf<"nullish">): LlValue | null {
  const chain = e.left;
  if (
    chain.kind !== "optChain" ||
    chain.receiver.type.kind !== "union" ||
    chain.type.kind !== "union" ||
    chain.body.kind !== "unionWrap" ||
    chain.body.unionId !== chain.type.unionId ||
    !typeEquals(chain.body.value.type, e.type) ||
    isUnitType(e.type) ||
    e.type.kind === "void"
  )
    return null;
  const resultArm = host.unionsById.get(chain.type.unionId)?.arms[chain.body.tag];
  const receiverDef = host.unionsById.get(chain.receiver.type.unionId);
  if (!resultArm || isUnitType(resultArm) || !typeEquals(resultArm, e.type) || !receiverDef)
    return null;
  const unitTags = receiverDef.arms.flatMap((a, i) => (isUnitType(a) ? [i] : []));
  const present = receiverDef.arms.flatMap((a, i) => (isUnitType(a) ? [] : [i]));
  if (unitTags.length === 0 || present.length !== 1) return null;
  const B = host.B;
  const narrowed = receiverDef.arms[present[0]!]!;
  // A receiver read from a location the body cannot write lends its
  // payload to the bind slot for the whole body (`table[k]?.(…) ?? d`).
  const borrowed =
    isRefCounted(narrowed) && borrowsChainReceiver(host, chain.receiver, chain.body.value);
  const r =
    borrowed || host.canStackReceiver(chain.receiver)
      ? host.emitReadReceiver(chain.receiver)
      : host.emitExpr(chain.receiver);
  const bindTy = host.llType(narrowed);
  const bind = B.slot();
  B.entryAllocas.push(`${bind} = alloca ${bindTy}`);
  B.line(
    `store ${bindTy} ${bindTy === "ptr" ? "null" : bindTy === "double" ? f64Lit(0) : "false"}, ptr ${bind}`,
  );
  if (!borrowed) host.ownSlot(bind, narrowed);
  const isUnit = host.tagInSet(r.name, receiverDef.id, unitTags);
  const ty = host.llType(e.type);
  const slot = B.slot();
  B.entryAllocas.push(`${slot} = alloca ${ty}`);
  const lu = B.newLabel("nulc.u"),
    lb = B.newLabel("nulc.b"),
    lj = B.newLabel("nulc.j");
  B.condBr(isUnit, lu, lb);
  B.startBlock(lu);
  host.emitBranchInto(slot, e.right);
  B.br(lj);
  B.startBlock(lb);
  const payload = borrowed
    ? host.unionPeek(r.name, receiverDef.id)
    : host.unionExtract(r.name, receiverDef.id, narrowed);
  B.line(`store ${bindTy} ${payload}, ptr ${bind}`);
  host.chainSlots.set(chain.id, { name: bind, type: narrowed, slot: true });
  host.emitBranchInto(slot, chain.body.value);
  host.chainSlots.delete(chain.id);
  B.br(lj);
  B.startBlock(lj);
  const t = B.tmp();
  B.line(`${t} = load ${ty}, ptr ${slot}`);
  return host.own({ name: t, type: e.type });
}

/** Whether every arm of a (nested) ternary is a string literal. */
function literalChoice(e: IrExpr): boolean {
  if (e.kind === "strLit") return true;
  return e.kind === "ternary" && literalChoice(e.then) && literalChoice(e.else_);
}

type TagSet = { unionId: string; value: IrExpr; tags: Set<number> };

/** An `||` chain of two or more tag tests of one local (`isTag(u, 1) ||
 * isTag(u, 4) || ...`, the shape of a union conversion's identity test). */
function unionTagSet(e: IrExpr & { kind: "logical" }): TagSet | null {
  const leaves: IrExpr[] = [];
  const collect = (x: IrExpr): void => {
    if (x.kind === "logical" && x.op === "||") {
      collect(x.left);
      collect(x.right);
    } else leaves.push(x);
  };
  collect(e);
  const first = leaves[0]!;
  if (first.kind !== "unionIsTag" || first.value.kind !== "varRef") return null;
  const localId = first.value.localId;
  const tags = new Set<number>();
  for (const leaf of leaves) {
    if (
      leaf.kind !== "unionIsTag" ||
      leaf.negated ||
      leaf.unionId !== first.unionId ||
      leaf.value.kind !== "varRef" ||
      leaf.value.localId !== localId
    )
      return null;
    tags.add(leaf.tag);
  }
  return { unionId: first.unionId, value: first.value, tags };
}

/** i1: the union value holds one of the tags. One read of the tag and one
 * switch over the set; a shape union switches on the record's shape word
 * after its unit encodings. */
function emitUnionTagSet(host: LlvmEmitterContext, set: TagSet): string {
  const B = host.B;
  const u = host.emitUnionProjection(set.value).name;
  const nullable = host.nullableUnions.get(set.unionId);
  const yes = B.newLabel("tags.y");
  const no = B.newLabel("tags.n");
  const join = B.newLabel("tags.j");
  const target = (tag: number): string => (set.tags.has(tag) ? yes : no);
  if (nullable?.repr === "shapes") {
    if (nullable.unitTag >= 0) {
      const isNull = B.tmp();
      const next = B.newLabel("tags.r");
      B.line(`${isNull} = icmp eq ptr ${u}, null`);
      B.condBr(isNull, target(nullable.unitTag), next);
      B.startBlock(next);
    }
    if (nullable.nullTag >= 0) {
      const isNullArm = B.tmp();
      const next = B.newLabel("tags.r");
      B.line(`${isNullArm} = icmp eq ptr ${u}, ${NULLABLE_NULL}`);
      B.condBr(isNullArm, target(nullable.nullTag), next);
      B.startBlock(next);
    }
    const wp = B.tmp();
    const w = B.tmp();
    B.line(
      `${wp} = getelementptr inbounds ${shapeWordHeader(host.sizeType)}, ptr ${u}, i32 0, i32 ${SHAPE_WORD_INDEX}`,
    );
    B.line(`${w} = load i32, ptr ${wp}`);
    const cases = nullable.arms
      .filter((arm) => set.tags.has(arm.tag))
      .map((arm) => `i32 ${host.nullableUnions.shapeNumber(arm.shapeId)}, label %${yes}`);
    B.terminate(`switch i32 ${w}, label %${no} [ ${cases.join(" ")} ]`);
  } else {
    const tag = nullable ? emitUnionTag(B, nullable, u) : host.unionTag(u, set.unionId);
    const cases = [...set.tags].map((t) => `i32 ${t}, label %${yes}`);
    B.terminate(`switch i32 ${tag}, label %${no} [ ${cases.join(" ")} ]`);
  }
  B.startBlock(yes);
  B.br(join);
  B.startBlock(no);
  B.br(join);
  B.startBlock(join);
  const t = B.tmp();
  B.line(`${t} = phi i1 [ true, %${yes} ], [ false, %${no} ]`);
  return t;
}

/** Every value a keyed read can hit is present (no stored undefined or
 * null), so only a missing key yields the read's unit arm. */
function storesNoUnit(host: LlvmEmitterContext, e: ExprOf<"recordKeyGet">): boolean {
  const shape = host.recordShape(e.shapeId);
  const holdsUnit = (t: IrType): boolean =>
    isUnitType(t) ||
    t.kind === "dyn" ||
    (t.kind === "union" && (host.unionsById.get(t.unionId)?.arms ?? []).some(isUnitType));
  if (shape.indexValue !== undefined && holdsUnit(shape.indexValue)) return false;
  return e.overflowOnly === true || !shape.fields.some((f) => holdsUnit(f.type));
}
