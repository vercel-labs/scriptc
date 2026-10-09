import { emitBorrowedInput } from "./borrowed-inputs.js";
/* Focused LLVM expression emission extracted from emitter.ts. */
import { InternalCompilerError } from "../../errors.js";
import { undefinedArmTag } from "../../ir/analysis.js";
import { isRefCounted, isUnitType, typeEquals } from "../../ir/ir.js";
import { DYN_KIND } from "./dyn.js";
import { LlvmUnsupportedError } from "./unsupported.js";
import type { LlvmEmitterContext, ExprOf, LlValue } from "./expr-context.js";
import { f64Lit } from "./common.js";

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
  const B = host.B;
  switch (e.kind) {
    case "dynDestrCheck": {
      // RequireObjectCoercible with V8's destructuring TypeError. dyn
      // values check in the runtime helper and pass through unchanged
      // (same temp, same ownership); island values check in the engine
      // (a fresh +1 cell for the same value comes back).
      const v = host.emitExpr(e.value);
      const first = e.firstProp !== undefined ? host.cstr(e.firstProp) : "null";
      if (e.value.type.kind === "jsval") {
        host.declare(`declare ptr @scr_jsval_destr_check(ptr, ptr, ptr)`);
        const t = B.tmp();
        B.line(
          `${t} = call ptr @scr_jsval_destr_check(ptr ${v.name}, ptr ${host.cstr(e.spelling)}, ptr ${first})`,
        );
        const out = host.own({ name: t, type: e.type });
        host.emitPendingCheck();
        return out;
      }
      const helper = host.dyn.dynDestrCheckHelper();
      B.line(`call void @${helper}(ptr ${v.name}, ptr ${host.cstr(e.spelling)}, ptr ${first})`);
      host.emitPendingCheck();
      return v;
    }
    case "dynIterN": {
      // GetIterator + first-N steps as a fresh array (V8's exact
      // not-iterable TypeError on non-iterables): the dyn helper for
      // dyn operands, the engine's real iterator protocol for island
      // ones.
      const v = emitBorrowedInput(host, e.value);
      if (e.value.type.kind === "jsval") {
        host.declare(`declare ptr @scr_jsval_iter_n(ptr, double)`);
        const t = B.tmp();
        B.line(`${t} = call ptr @scr_jsval_iter_n(ptr ${v.name}, double ${f64Lit(e.count)})`);
        const out = host.own({ name: t, type: e.type });
        host.emitPendingCheck();
        return out;
      }
      const helper = host.dyn.dynIterNHelper();
      const t = B.tmp();
      B.line(
        `${t} = call ptr @${helper}(ptr ${v.name}, ${host.sizeType} ${e.count}, ptr ${e.notIterableMessage ? host.cstr(e.notIterableMessage) : "null"})`,
      );
      const out = host.own({ name: t, type: e.type });
      host.emitPendingCheck();
      return out;
    }
    case "toBool":
      return { name: host.truthy(host.emitUnionProjection(e.operand)), type: e.type };
    case "logical": {
      // JS value semantics: the result is the deciding operand itself.
      // Left evaluates once, ownership moves into the result slot; when
      // the branch takes the right operand the stale left releases first
      // and the right runs in its own frame.
      const ty = host.llType(e.type);
      const l = host.emitExpr(e.left);
      host.moveTemp(l);
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
      if (isRefCounted(e.type)) host.releaseValue(l.name, e.type);
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
    case "ternary": {
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
      return host.own({ name: t, type: e.type });
    }
    case "optChain": {
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
          host.releaseFrame(host.frames.pop()!);
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
      if (e.receiver.type.kind === "jsval") {
        // Island-handle chain: the nullish test asks the engine value;
        // the unit path result is the engine's undefined (+1 cell), the
        // body runs lazily over the bound handle otherwise.
        const r = host.emitExpr(e.receiver);
        host.declare(`declare zeroext i1 @scr_jsval_is_nullish(ptr)`);
        host.declare(`declare ptr @scr_jsval_retain_v(ptr)`);
        const isN = B.tmp();
        B.line(`${isN} = call zeroext i1 @scr_jsval_is_nullish(ptr ${r.name})`);
        const bind = B.slot();
        B.entryAllocas.push(`${bind} = alloca ptr`);
        B.line(`store ptr null, ptr ${bind}`);
        host.ownSlot(bind, e.receiver.type);
        if (e.type.kind === "void") {
          const lb = B.newLabel("ocj.b");
          const lj = B.newLabel("ocj.j");
          B.condBr(isN, lj, lb);
          B.startBlock(lb);
          const rr = B.tmp();
          B.line(`${rr} = call ptr @scr_jsval_retain_v(ptr ${r.name})`);
          B.line(`store ptr ${rr}, ptr ${bind}`);
          host.chainSlots.set(e.id, { name: bind, type: e.receiver.type, slot: true });
          host.frames.push([]);
          host.emitExpr(e.body);
          host.releaseFrame(host.frames.pop()!);
          host.chainSlots.delete(e.id);
          B.br(lj);
          B.startBlock(lj);
          return { name: "", type: e.type };
        }
        if (e.type.kind !== "jsval")
          throw new InternalCompilerError("llvm emitter bug: jsval optChain result kind");
        const slot = B.slot();
        B.entryAllocas.push(`${slot} = alloca ptr`);
        const lu = B.newLabel("ocj.u");
        const lb = B.newLabel("ocj.b");
        const lj = B.newLabel("ocj.j");
        B.condBr(isN, lu, lb);
        B.startBlock(lu);
        host.declare(`declare ptr @scr_jsval_undefined()`);
        const un = B.tmp();
        B.line(`${un} = call ptr @scr_jsval_undefined()`);
        B.line(`store ptr ${un}, ptr ${slot}`);
        B.br(lj);
        B.startBlock(lb);
        const rr = B.tmp();
        B.line(`${rr} = call ptr @scr_jsval_retain_v(ptr ${r.name})`);
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
      // A single present arm is only tested and extracted (+1) before the
      // body runs, so a fresh receiver box can stay on the stack.
      const r =
        !multiple && host.canStackReceiver(e.receiver)
          ? host.emitReadReceiver(e.receiver)
          : host.emitExpr(e.receiver);
      const bind = B.slot();
      B.entryAllocas.push(`${bind} = alloca ${host.llType(narrowed)}`);
      B.line(
        `store ${host.llType(narrowed)} ${host.llType(narrowed) === "ptr" ? "null" : host.llType(narrowed) === "double" ? f64Lit(0) : "false"}, ptr ${bind}`,
      );
      host.ownSlot(bind, narrowed);
      const isUnit = host.tagInSet(r.name, def.id, unitTags);
      const extract = (): string =>
        multiple ? host.retainValue(r.name, narrowed) : host.unionExtract(r.name, def.id, narrowed);
      if (e.type.kind === "void") {
        // Statement form (cb?.()): no result value at all.
        const lb = B.newLabel("oc.b");
        const lj = B.newLabel("oc.j");
        B.condBr(isUnit, lj, lb);
        B.startBlock(lb);
        B.line(`store ${host.llType(narrowed)} ${extract()}, ptr ${bind}`);
        host.chainSlots.set(e.id, { name: bind, type: narrowed, slot: true });
        host.frames.push([]);
        host.emitExpr(e.body);
        host.releaseFrame(host.frames.pop()!);
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
        B.line(`store ${host.llType(narrowed)} ${extract()}, ptr ${bind}`);
        host.chainSlots.set(e.id, { name: bind, type: narrowed, slot: true });
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
        throw new InternalCompilerError(
          "llvm emitter bug: optChain result lacks its undefined arm",
        );
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
      B.line(`store ${host.llType(narrowed)} ${extract()}, ptr ${bind}`);
      host.chainSlots.set(e.id, { name: bind, type: narrowed, slot: true });
      host.emitBranchInto(slot, e.body);
      host.chainSlots.delete(e.id);
      B.br(lj);
      B.startBlock(lj);
      const t = B.tmp();
      B.line(`${t} = load ${ty}, ptr ${slot}`);
      return host.own({ name: t, type: e.type });
    }
    case "chainRecv": {
      const bound = host.chainSlots.get(e.id);
      if (!bound)
        throw new InternalCompilerError(`llvm emitter bug: chainRecv "${e.id}" outside its chain`);
      const v = B.tmp();
      B.line(`${v} = load ${host.llType(bound.type)}, ptr ${bound.name}`);
      if (!isRefCounted(e.type)) return { name: v, type: e.type };
      return host.own({ name: host.retainValue(v, e.type), type: e.type });
    }
    case "orDefault": {
      // `u || d` narrowed to the single non-unit arm: nullish's dance
      // with the union TRUTHY switch as the test — truthy extracts the
      // arm (+1 for ref kinds), falsy releases and runs the default.
      if (e.left.type.kind !== "union")
        throw new InternalCompilerError("llvm emitter bug: orDefault left is not a union");
      const l = host.emitExpr(e.left);
      host.moveTemp(l);
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
        B.line(
          `${t} = call ${ty} @${host.callTarget(e.retag)}(${host.llType(e.left.type)} ${l.name})`,
        );
        B.line(`store ${ty} ${t}, ptr ${slot}`);
        if (host.mayThrow.has(e.retag)) host.emitPendingCheck();
      } else if (host.nullableUnions.has(e.left.type.unionId)) {
        // The owned nullable pointer IS the owned arm value.
        B.line(`store ${ty} ${l.name}, ptr ${slot}`);
      } else {
        B.line(
          `store ${ty} ${host.unionExtract(l.name, e.left.type.unionId, e.type)}, ptr ${slot}`,
        );
        host.releaseValue(l.name, e.left.type);
      }
      B.br(lj);
      B.startBlock(lf);
      host.releaseValue(l.name, e.left.type);
      host.emitBranchInto(slot, e.right);
      B.br(lj);
      B.startBlock(lj);
      const t = B.tmp();
      B.line(`${t} = load ${ty}, ptr ${slot}`);
      return host.own({ name: t, type: e.type });
    }
    case "nullish": {
      // `a ?? b`: logical's move/release dance with the left's runtime
      // TAG against its unit arms as the test. Pass-through shape: the
      // result IS the left box. Narrowed shape: the single non-unit
      // arm's payload extracts (+1 for ref kinds) and the box releases.
      if (e.left.type.kind === "jsval") {
        // The island form: engine nullish test, lazy right (jsval).
        const l = host.emitExpr(e.left);
        host.moveTemp(l);
        host.declare(`declare zeroext i1 @scr_jsval_is_nullish(ptr)`);
        const slot = B.slot();
        B.entryAllocas.push(`${slot} = alloca ptr`);
        const isN = B.tmp();
        B.line(`${isN} = call zeroext i1 @scr_jsval_is_nullish(ptr ${l.name})`);
        const lu = B.newLabel("nulj.u");
        const lv = B.newLabel("nulj.v");
        const lj = B.newLabel("nulj.j");
        B.condBr(isN, lu, lv);
        B.startBlock(lu);
        host.releaseValue(l.name, e.left.type);
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
      if (e.left.type.kind === "dyn") {
        // The checked-dynamic form: the runtime kind decides (UNDEF/
        // NULL take the default; a wrapped island value asks the
        // engine); the right runs lazily in its branch (already dyn).
        const l = host.emitExpr(e.left);
        host.moveTemp(l);
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
        host.releaseValue(l.name, e.left.type);
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
      host.moveTemp(l);
      const ty = host.llType(e.type);
      const slot = B.slot();
      B.entryAllocas.push(`${slot} = alloca ${ty}`);
      const isUnit = host.tagInSet(l.name, def.id, unitTags);
      const lu = B.newLabel("nul.u");
      const lv = B.newLabel("nul.v");
      const lj = B.newLabel("nul.j");
      B.condBr(isUnit, lu, lv);
      B.startBlock(lu);
      host.releaseValue(l.name, e.left.type);
      host.emitBranchInto(slot, e.right);
      B.br(lj);
      B.startBlock(lv);
      if (typeEquals(e.type, e.left.type) || host.nullableUnions.has(def.id)) {
        // Pass-through, or a nullable pointer that IS its owned arm value.
        B.line(`store ${ty} ${l.name}, ptr ${slot}`);
      } else {
        B.line(`store ${ty} ${host.unionExtract(l.name, def.id, e.type)}, ptr ${slot}`);
        host.releaseValue(l.name, e.left.type);
      }
      B.br(lj);
      B.startBlock(lj);
      const t = B.tmp();
      B.line(`${t} = load ${ty}, ptr ${slot}`);
      return host.own({ name: t, type: e.type });
    }
    default: {
      const _exhaustive: never = e;
      void _exhaustive;
      throw new InternalCompilerError("unreachable");
    }
  }
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
  const r = host.canStackReceiver(chain.receiver)
    ? host.emitReadReceiver(chain.receiver)
    : host.emitExpr(chain.receiver);
  const bindTy = host.llType(narrowed);
  const bind = B.slot();
  B.entryAllocas.push(`${bind} = alloca ${bindTy}`);
  B.line(
    `store ${bindTy} ${bindTy === "ptr" ? "null" : bindTy === "double" ? f64Lit(0) : "false"}, ptr ${bind}`,
  );
  host.ownSlot(bind, narrowed);
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
  B.line(`store ${bindTy} ${host.unionExtract(r.name, receiverDef.id, narrowed)}, ptr ${bind}`);
  host.chainSlots.set(chain.id, { name: bind, type: narrowed, slot: true });
  host.emitBranchInto(slot, chain.body.value);
  host.chainSlots.delete(chain.id);
  B.br(lj);
  B.startBlock(lj);
  const t = B.tmp();
  B.line(`${t} = load ${ty}, ptr ${slot}`);
  return host.own({ name: t, type: e.type });
}
