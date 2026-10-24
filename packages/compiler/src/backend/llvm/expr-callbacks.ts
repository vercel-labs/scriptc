/* Focused LLVM expression emission extracted from emitter.ts. */
import { InternalCompilerError } from "../../errors.js";
import {
  type IrType,
  UNDEFINED_T,
  isRefCounted,
  isUnitType,
  typeEquals,
  typeKey,
} from "../../ir/ir.js";
import { mangleRecordNew, mangleRecordStruct } from "../mangle.js";
import { FN_ATTRS, llFieldType, releaseSym, retainSym, traceArg, vAdapters } from "./shapes.js";
import { LlvmUnsupportedError } from "./unsupported.js";
import type { LlvmEmitterContext } from "./expr-context.js";
import { unionPeekLines, unionTagLines } from "./union-repr.js";
import { inlineUnionCopyLines } from "./inline-unions.js";
import { registerReplay } from "./emit-journal.js";

/** Text-template union construction around an owned (+1) reference payload:
 * a fresh box, or the payload itself for a nullable union. */
function unionWrapRefLines(
  host: LlvmEmitterContext,
  unionId: string,
  tag: number,
  arm: IrType,
  payload: string,
  out: string,
): string[] {
  if (host.nullableUnions.has(unionId))
    return [`  ${out} = getelementptr i8, ptr ${payload}, i64 0`];
  const av = vAdapters(host.shapeHost, arm);
  host.declare(`declare ptr @scr_union_new_ref(i32, ptr, ptr, ptr, ptr)`);
  return [
    `  ${out} = call ptr @scr_union_new_ref(i32 ${tag}, ptr ${payload}, ptr ${av.retain}, ptr ${av.release}, ptr ${traceArg(host.shapeHost, arm)})`,
  ];
}

export function dynKind(host: LlvmEmitterContext, d: string): string {
  const B = host.B;
  const p = B.tmp();
  const k = B.tmp();
  B.line(
    `${p} = getelementptr inbounds i8, ptr ${d}, i64 ${host.sizeType === "i32" ? 4 : 8} ; ->kind`,
  );
  B.line(`${k} = load i32, ptr ${p}`);
  return k;
}

export function raceAdapterFor(host: LlvmEmitterContext, from: IrType, to: IrType): string {
  if (typeEquals(from, to)) {
    host.declare(`declare void @scr_promise_adapt_copy(ptr, ptr)`);
    return "scr_promise_adapt_copy";
  }
  const key = `race:${typeKey(from)}=>${typeKey(to)}`;
  let sym = host.resolveThunks.get(key);
  if (sym) return sym;
  sym = host.contentSymbol("sc_race_", key);
  host.resolveThunks.set(key, sym);
  host.journal?.allocated(sym, "raceAdapterFor", [from, to]);
  const toArms = to.kind === "union" ? (host.unionsById.get(to.unionId)?.arms ?? []) : [];
  if (from.kind === "void" && !toArms.some((a) => a.kind === "undefinedT")) {
    // A Promise<never> entry (the frontend admits void entries without an
    // undefined result arm only for those): it can only reject, so its
    // fulfillment adapter never runs.
    host.declare(`declare void @scr_trap(ptr)`);
    const msg = host.cstr("scriptc: a Promise<never> race entry fulfilled\n");
    host.resolveThunkDefs.push(
      `define internal void @${sym}(ptr %dst, ptr %src) ${FN_ATTRS} { ; race ${key}`,
      `entry:`,
      `  call void @scr_trap(ptr ${msg})`,
      `  unreachable`,
      `}`,
      ``,
    );
    host.journal?.built();
    return sym;
  }
  if (to.kind !== "union")
    throw new InternalCompilerError("llvm emitter bug: race adapter to a non-union");
  const toDef = host.unionsById.get(to.unionId);
  if (!toDef) throw new InternalCompilerError("llvm emitter bug: race adapter to an unknown union");
  const tagOf = (t: IrType): number => {
    const tag = toDef.arms.findIndex((a) => typeEquals(a, t));
    if (tag < 0)
      throw new InternalCompilerError(
        "llvm emitter bug: race adapter arm missing (frontend must fence)",
      );
    return tag;
  };
  const rv = vAdapters(host.shapeHost, to);
  host.declare(`declare void @scr_promise_fulfill_ref(ptr, ptr, ptr, ptr, ptr)`);
  const fulfill = (value: string): string =>
    `call void @scr_promise_fulfill_ref(ptr %dst, ptr ${value}, ptr ${rv.retain}, ptr ${rv.release}, ptr ${traceArg(host.shapeHost, to)})`;
  const d: string[] = [
    `define internal void @${sym}(ptr %dst, ptr %src) ${FN_ATTRS} { ; race ${key}`,
    `entry:`,
  ];
  if (from.kind === "void") {
    // A Promise<void> entry fulfills with undefined: the result's
    // undefined arm, whatever the entry's payload slot holds.
    const tag = tagOf(UNDEFINED_T);
    d.push(`  ${fulfill(host.unitInstanceRef(to.unionId, tag))}`, `  ret void`, `}`, ``);
    host.resolveThunkDefs.push(...d);
    host.journal?.built();
    return sym;
  }
  if (from.kind !== "union") {
    // One arm wrap, straight off the payload accessors.
    const tag = tagOf(from);
    if (from.kind === "f64") {
      host.declare(`declare double @scr_promise_payload_f64(ptr)`);
      host.declare(`declare ptr @scr_union_new_f64(i32, double)`);
      d.push(
        `  %x = call double @scr_promise_payload_f64(ptr %src)`,
        `  %u = call ptr @scr_union_new_f64(i32 ${tag}, double %x)`,
      );
    } else if (from.kind === "bool") {
      host.declare(`declare zeroext i1 @scr_promise_payload_bool(ptr)`);
      host.declare(`declare ptr @scr_union_new_bool(i32, i1 zeroext)`);
      d.push(
        `  %x = call zeroext i1 @scr_promise_payload_bool(ptr %src)`,
        `  %u = call ptr @scr_union_new_bool(i32 ${tag}, i1 %x)`,
      );
    } else if (from.kind === "string") {
      host.declare(`declare ptr @scr_promise_payload_str(ptr)`);
      d.push(
        `  %x = call ptr @scr_promise_payload_str(ptr %src)`,
        ...unionWrapRefLines(host, to.unionId, tag, from, "%x", "%u"),
      );
    } else if (host.nullableUnions.has(to.unionId)) {
      // The nullable result union is the (+1) reference payload itself.
      host.declare(`declare ptr @scr_promise_payload_ref(ptr)`);
      d.push(`  %u = call ptr @scr_promise_payload_ref(ptr %src)`);
    } else {
      const fv = vAdapters(host.shapeHost, from);
      host.declare(`declare ptr @scr_promise_payload_ref(ptr)`);
      host.declare(`declare ptr @scr_union_new_ref(i32, ptr, ptr, ptr, ptr)`);
      d.push(
        `  %x = call ptr @scr_promise_payload_ref(ptr %src)`,
        `  %u = call ptr @scr_union_new_ref(i32 ${tag}, ptr %x, ptr ${fv.retain}, ptr ${fv.release}, ptr ${traceArg(host.shapeHost, from)})`,
      );
    }
    d.push(`  ${fulfill("%u")}`, `  ret void`, `}`, ``);
    host.resolveThunkDefs.push(...d);
    host.journal?.built();
    return sym;
  }
  // Sub-union re-tag: switch over the entry's arms, rebuild under the
  // result's tags (payloads retained through each arm's own adapters).
  const fromDef = host.unionsById.get(from.unionId);
  if (!fromDef)
    throw new InternalCompilerError("llvm emitter bug: race adapter from an unknown union");
  host.declare(`declare ptr @scr_promise_payload_ref(ptr)`);
  const fromNullable = host.nullableUnions.get(from.unionId);
  d.push(
    `  %u0 = call ptr @scr_promise_payload_ref(ptr %src)`,
    ...unionTagLines(fromNullable, "%u0", "%tag"),
    `  %slot = alloca ptr`,
    `  switch i32 %tag, label %bad [ ${fromDef.arms.map((_, i) => `i32 ${i}, label %a${i}`).join(" ")} ]`,
  );
  fromDef.arms.forEach((arm, i) => {
    d.push(`a${i}:`);
    const tag = tagOf(arm);
    if (isUnitType(arm)) {
      d.push(`  store ptr ${host.unitInstanceRef(to.unionId, tag)}, ptr %slot`, `  br label %join`);
    } else if (arm.kind === "f64") {
      host.declare(`declare double @scr_union_get_f64(ptr)`);
      host.declare(`declare ptr @scr_union_new_f64(i32, double)`);
      d.push(
        `  %x${i} = call double @scr_union_get_f64(ptr %u0)`,
        `  %v${i} = call ptr @scr_union_new_f64(i32 ${tag}, double %x${i})`,
        `  store ptr %v${i}, ptr %slot`,
        `  br label %join`,
      );
    } else if (arm.kind === "bool") {
      host.declare(`declare zeroext i1 @scr_union_get_bool(ptr)`);
      host.declare(`declare ptr @scr_union_new_bool(i32, i1 zeroext)`);
      d.push(
        `  %x${i} = call zeroext i1 @scr_union_get_bool(ptr %u0)`,
        `  %v${i} = call ptr @scr_union_new_bool(i32 ${tag}, i1 %x${i})`,
        `  store ptr %v${i}, ptr %slot`,
        `  br label %join`,
      );
    } else {
      const av = vAdapters(host.shapeHost, arm);
      d.push(
        ...unionPeekLines(fromNullable, "%u0", `%p${i}`),
        `  %r${i} = call ptr ${av.retain}(ptr %p${i})`,
        ...unionWrapRefLines(host, to.unionId, tag, arm, `%r${i}`, `%v${i}`),
        `  store ptr %v${i}, ptr %slot`,
        `  br label %join`,
      );
    }
  });
  d.push(
    `bad:`,
    `  store ptr null, ptr %slot`,
    `  br label %join`,
    `join:`,
    `  call void ${releaseSym(host.shapeHost, from)}(ptr %u0)`,
    `  %v = load ptr, ptr %slot`,
    `  ${fulfill("%v")}`,
    `  ret void`,
    `}`,
    ``,
  );
  host.resolveThunkDefs.push(...d);
  host.journal?.built();
  return sym;
}

export function genResultThunkFor(
  host: LlvmEmitterContext,
  genT: IrType & { kind: "generator" },
  recT: IrType & { kind: "record" },
): string {
  const key = `gr:${typeKey(genT)}`;
  let sym = host.resolveThunks.get(key);
  if (sym) return sym;
  sym = host.contentSymbol("sc_gres_", key);
  host.resolveThunks.set(key, sym);
  host.journal?.allocated(sym, "genResultThunkFor", [genT, recT]);
  const shape = host.recordsById.get(recT.shapeId);
  const base = host.nullableUnions.fieldBase(recT.shapeId);
  const valueT = shape?.fields.find((f) => f.name === "value")?.type;
  if (!shape || !valueT)
    throw new InternalCompilerError("llvm emitter bug: genResume record lacks its value field");
  if (valueT.kind === "dyn") {
    // A checked channel: OUT holds a dyn, or a typed value of a concrete
    // yield/return channel beside a dyn one (boxed here), or nothing —
    // undefined.
    const doneIdxD = shape.fields.findIndex((f) => f.name === "done");
    const valueIdxD = shape.fields.findIndex((f) => f.name === "value");
    if (doneIdxD < 0 || valueIdxD < 0)
      throw new InternalCompilerError("llvm emitter bug: genResume record shape");
    host.declare(`declare zeroext i1 @scr_gen_done(ptr)`);
    host.declare(`declare zeroext i1 @scr_gen_out_has(ptr)`);
    host.declare(`declare ptr @scr_dyn_undefined()`);
    host.declare(`declare ptr @scr_dyn_retain_v(ptr)`);
    // The lines that move OUT (holding a `srcT` value) into %vslot as an
    // owned dyn, then branch to %join.
    const boxFrom = (srcT: IrType, px: string): string[] => {
      if (srcT.kind === "f64") {
        host.declare(`declare double @scr_gen_take_out_f64(ptr)`);
        return [
          `  %${px}x = call double @scr_gen_take_out_f64(ptr %g)`,
          `  %${px}v = call ptr @${host.dyn.toDynHelper(srcT)}(double %${px}x)`,
          `  store ptr %${px}v, ptr %vslot`,
          `  br label %join`,
        ];
      }
      if (srcT.kind === "bool") {
        host.declare(`declare zeroext i1 @scr_gen_take_out_bool(ptr)`);
        return [
          `  %${px}x = call zeroext i1 @scr_gen_take_out_bool(ptr %g)`,
          `  %${px}v = call ptr @${host.dyn.toDynHelper(srcT)}(i1 %${px}x)`,
          `  store ptr %${px}v, ptr %vslot`,
          `  br label %join`,
        ];
      }
      host.declare(`declare ptr @scr_gen_take_out_ref(ptr)`);
      if (srcT.kind === "dyn") {
        return [
          `  %${px}v = call ptr @scr_gen_take_out_ref(ptr %g)`,
          `  store ptr %${px}v, ptr %vslot`,
          `  br label %join`,
        ];
      }
      // Ref converters borrow their payload: box, then drop OUT's +1.
      return [
        `  %${px}x = call ptr @scr_gen_take_out_ref(ptr %g)`,
        `  %${px}v = call ptr @${host.dyn.toDynHelper(srcT)}(ptr %${px}x)`,
        `  call void ${releaseSym(host.shapeHost, srcT)}(ptr %${px}x)`,
        `  store ptr %${px}v, ptr %vslot`,
        `  br label %join`,
      ];
    };
    const d: string[] = [
      `define internal ptr @${sym}(ptr %g) ${FN_ATTRS} { ; IteratorResult<${typeKey(genT)}> (dyn channel)`,
      `entry:`,
      `  %vslot = alloca ptr`,
      `  %r = call ptr @${mangleRecordNew(recT.shapeId)}()`,
      `  %d = call zeroext i1 @scr_gen_done(ptr %g)`,
      `  %dz = zext i1 %d to i8`,
      `  %dp = getelementptr inbounds %${mangleRecordStruct(recT.shapeId)}, ptr %r, i64 0, i32 ${doneIdxD + base}`,
      `  store i8 %dz, ptr %dp`,
      `  %has = call zeroext i1 @scr_gen_out_has(ptr %g)`,
      `  br i1 %has, label %take, label %undefv`,
      `take:`,
      `  br i1 %d, label %retv, label %yieldv`,
      `yieldv:`,
      ...(genT.yieldT.kind === "void" ? [`  br label %undefv`] : boxFrom(genT.yieldT, "y")),
      `retv:`,
      ...(genT.retT.kind === "void" ? [`  br label %undefv`] : boxFrom(genT.retT, "r")),
      `undefv:`,
      `  %u = call ptr @scr_dyn_undefined()`,
      `  %u1 = call ptr @scr_dyn_retain_v(ptr %u)`,
      `  store ptr %u1, ptr %vslot`,
      `  br label %join`,
      `join:`,
      `  %v = load ptr, ptr %vslot`,
      `  %vp = getelementptr inbounds %${mangleRecordStruct(recT.shapeId)}, ptr %r, i64 0, i32 ${valueIdxD + base}`,
      `  store ptr %v, ptr %vp`,
      `  ret ptr %r`,
      `}`,
      ``,
    ];
    host.resolveThunkDefs.push(...d);
    host.journal?.built();
    return sym;
  }
  if (valueT.kind !== "union") throw new LlvmUnsupportedError(`genResume:${valueT.kind}`);
  const def = host.unionsById.get(valueT.unionId);
  if (!def) throw new InternalCompilerError("llvm emitter bug: genResume value union unknown");
  const tagOf = (t: IrType): number => {
    const tag = def.arms.findIndex((a) => typeEquals(a, t));
    if (tag < 0)
      throw new InternalCompilerError("llvm emitter bug: genResume value union lacks an arm");
    return tag;
  };
  const undefTag = def.arms.findIndex((a) => a.kind === "undefinedT");
  if (undefTag < 0)
    throw new InternalCompilerError("llvm emitter bug: genResume value union lacks undefined");
  const doneIdx = shape.fields.findIndex((f) => f.name === "done");
  const valueIdx = shape.fields.findIndex((f) => f.name === "value");
  if (doneIdx < 0 || valueIdx < 0)
    throw new InternalCompilerError("llvm emitter bug: genResume record shape");
  host.declare(`declare zeroext i1 @scr_gen_done(ptr)`);
  host.declare(`declare zeroext i1 @scr_gen_out_has(ptr)`);
  const d: string[] = [
    `define internal ptr @${sym}(ptr %g) ${FN_ATTRS} { ; IteratorResult<${typeKey(genT)}>`,
    `entry:`,
    `  %vslot = alloca ptr`,
    `  %r = call ptr @${mangleRecordNew(recT.shapeId)}()`,
    `  %d = call zeroext i1 @scr_gen_done(ptr %g)`,
    `  %dz = zext i1 %d to i8`,
    `  %dp = getelementptr inbounds %${mangleRecordStruct(recT.shapeId)}, ptr %r, i64 0, i32 ${doneIdx + base}`,
    `  store i8 %dz, ptr %dp`,
    `  br i1 %d, label %doneb, label %susp`,
  ];
  const undefRef = host.unitInstanceRef(valueT.unionId, undefTag);
  // Lines that store the wrapped OUT value into %vslot and br %join,
  // taking OUT's payload — one copy per branch, prefix-unique temps.
  const wrapFrom = (srcT: IrType, px: string): string[] => {
    if (srcT.kind === "void") {
      // A channel that can never carry a value (TS `never` yields /
      // void returns): the undefined arm keeps the IR total.
      return [`  store ptr ${undefRef}, ptr %vslot`, `  br label %join`];
    }
    if (srcT.kind === "f64") {
      host.declare(`declare double @scr_gen_take_out_f64(ptr)`);
      host.declare(`declare ptr @scr_union_new_f64(i32, double)`);
      return [
        `  %${px}x = call double @scr_gen_take_out_f64(ptr %g)`,
        `  %${px}u = call ptr @scr_union_new_f64(i32 ${tagOf(srcT)}, double %${px}x)`,
        `  store ptr %${px}u, ptr %vslot`,
        `  br label %join`,
      ];
    }
    if (srcT.kind === "bool") {
      host.declare(`declare zeroext i1 @scr_gen_take_out_bool(ptr)`);
      host.declare(`declare ptr @scr_union_new_bool(i32, i1 zeroext)`);
      return [
        `  %${px}x = call zeroext i1 @scr_gen_take_out_bool(ptr %g)`,
        `  %${px}u = call ptr @scr_union_new_bool(i32 ${tagOf(srcT)}, i1 %${px}x)`,
        `  store ptr %${px}u, ptr %vslot`,
        `  br label %join`,
      ];
    }
    host.declare(`declare ptr @scr_gen_take_out_ref(ptr)`);
    if (srcT.kind !== "union") {
      return [
        `  %${px}x = call ptr @scr_gen_take_out_ref(ptr %g)`,
        ...unionWrapRefLines(host, valueT.unionId, tagOf(srcT), srcT, `%${px}x`, `%${px}u`),
        `  store ptr %${px}u, ptr %vslot`,
        `  br label %join`,
      ];
    }
    // A union channel: OUT holds the union box itself. Identical V
    // passes through; a superset V retags arm-wise.
    if (typeEquals(srcT, valueT)) {
      return [
        `  %${px}u = call ptr @scr_gen_take_out_ref(ptr %g)`,
        `  store ptr %${px}u, ptr %vslot`,
        `  br label %join`,
      ];
    }
    const srcDef = host.unionsById.get(srcT.unionId);
    if (!srcDef)
      throw new InternalCompilerError("llvm emitter bug: genResume channel union unknown");
    const srcNullable = host.nullableUnions.get(srcT.unionId);
    const lines: string[] = [
      `  %${px}u0 = call ptr @scr_gen_take_out_ref(ptr %g)`,
      ...unionTagLines(srcNullable, `%${px}u0`, `%${px}t`),
      `  switch i32 %${px}t, label %${px}bad [ ${srcDef.arms.map((_, i) => `i32 ${i}, label %${px}a${i}`).join(" ")} ]`,
    ];
    srcDef.arms.forEach((arm, i) => {
      lines.push(`${px}a${i}:`);
      const tag = tagOf(arm);
      if (isUnitType(arm)) {
        lines.push(`  store ptr ${host.unitInstanceRef(valueT.unionId, tag)}, ptr %vslot`);
      } else if (arm.kind === "f64") {
        host.declare(`declare double @scr_union_get_f64(ptr)`);
        host.declare(`declare ptr @scr_union_new_f64(i32, double)`);
        lines.push(
          `  %${px}x${i} = call double @scr_union_get_f64(ptr %${px}u0)`,
          `  %${px}v${i} = call ptr @scr_union_new_f64(i32 ${tag}, double %${px}x${i})`,
          `  store ptr %${px}v${i}, ptr %vslot`,
        );
      } else if (arm.kind === "bool") {
        host.declare(`declare zeroext i1 @scr_union_get_bool(ptr)`);
        host.declare(`declare ptr @scr_union_new_bool(i32, i1 zeroext)`);
        lines.push(
          `  %${px}x${i} = call zeroext i1 @scr_union_get_bool(ptr %${px}u0)`,
          `  %${px}v${i} = call ptr @scr_union_new_bool(i32 ${tag}, i1 %${px}x${i})`,
          `  store ptr %${px}v${i}, ptr %vslot`,
        );
      } else {
        const av = vAdapters(host.shapeHost, arm);
        lines.push(
          ...unionPeekLines(srcNullable, `%${px}u0`, `%${px}p${i}`),
          `  %${px}r${i} = call ptr ${av.retain}(ptr %${px}p${i})`,
          ...unionWrapRefLines(host, valueT.unionId, tag, arm, `%${px}r${i}`, `%${px}v${i}`),
          `  store ptr %${px}v${i}, ptr %vslot`,
        );
      }
      lines.push(`  br label %${px}rel`);
    });
    lines.push(
      `${px}bad:`,
      `  store ptr ${undefRef}, ptr %vslot`,
      `  br label %${px}rel`,
      `${px}rel:`,
      `  call void ${releaseSym(host.shapeHost, srcT)}(ptr %${px}u0)`,
      `  br label %join`,
    );
    return lines;
  };
  d.push(`susp:`);
  d.push(...wrapFrom(genT.yieldT, "y"));
  d.push(
    `doneb:`,
    `  %has = call zeroext i1 @scr_gen_out_has(ptr %g)`,
    `  br i1 %has, label %retv, label %undefv`,
    `retv:`,
  );
  d.push(...wrapFrom(genT.retT, "c"));
  d.push(
    `undefv:`,
    `  store ptr ${undefRef}, ptr %vslot`,
    `  br label %join`,
    `join:`,
    `  %v = load ptr, ptr %vslot`,
    `  %vp = getelementptr inbounds %${mangleRecordStruct(recT.shapeId)}, ptr %r, i64 0, i32 ${valueIdx + base}`,
    // An inline value field copies the box's bits and drops the box.
    ...(host.inlineUnions.record(valueT)
      ? [
          ...inlineUnionCopyLines("%v", "%vp", "%vi"),
          `  call void ${releaseSym(host.shapeHost, valueT)}(ptr %v)`,
        ]
      : [`  store ptr %v, ptr %vp`]),
    `  ret ptr %r`,
    `}`,
    ``,
  );
  host.resolveThunkDefs.push(...d);
  host.journal?.built();
  return sym;
}

export function childExitThunkFor(host: LlvmEmitterContext, param: IrType): string {
  if (param.kind !== "union")
    throw new InternalCompilerError("llvm emitter bug: exit listener param not a union");
  const key = `cx:${param.unionId}`;
  let sym = host.resolveThunks.get(key);
  if (sym) return sym;
  sym = host.contentSymbol("sc_cx_", key);
  host.resolveThunks.set(key, sym);
  host.journal?.allocated(sym, "childExitThunkFor", [param]);
  const def = host.unionsById.get(param.unionId);
  const f64Tag = def ? def.arms.findIndex((a) => a.kind === "f64") : -1;
  const nullTag = def ? def.arms.findIndex((a) => a.kind === "nullT") : -1;
  if (f64Tag < 0 || nullTag < 0)
    throw new InternalCompilerError("llvm emitter bug: exit listener union lacks its arms");
  host.declare(`declare ptr @scr_union_new_f64(i32, double)`);
  host.resolveThunkDefs.push(
    `define internal void @${sym}(ptr %cb, i1 zeroext %has, double %code, ptr %sig) ${FN_ATTRS} { ; child exit → ${param.unionId}`,
    `entry:`,
    `  %slot = alloca ptr`,
    `  br i1 %has, label %num, label %none`,
    `num:`,
    `  %u1 = call ptr @scr_union_new_f64(i32 ${f64Tag}, double %code)`,
    `  store ptr %u1, ptr %slot`,
    `  br label %go`,
    `none:`,
    `  store ptr ${host.unitInstanceRef(param.unionId, nullTag)}, ptr %slot`,
    `  br label %go`,
    `go:`,
    `  %u = load ptr, ptr %slot`,
    `  %fnp = getelementptr inbounds %ScrClosure, ptr %cb, i64 0, i32 1`,
    `  %fn = load ptr, ptr %fnp`,
    `  call void %fn(ptr %cb, ptr %u)`,
    `  ret void`,
    `}`,
    ``,
  );
  host.journal?.built();
  return sym;
}

export function childExitSignalThunkFor(
  host: LlvmEmitterContext,
  codeParam: IrType,
  sigParam: IrType,
): string {
  if (codeParam.kind !== "union" || sigParam.kind !== "union") {
    throw new InternalCompilerError("llvm emitter bug: exit listener params not unions");
  }
  const key = `cx2:${codeParam.unionId}+${sigParam.unionId}`;
  let sym = host.resolveThunks.get(key);
  if (sym) return sym;
  sym = host.contentSymbol("sc_cx_", key);
  host.resolveThunks.set(key, sym);
  host.journal?.allocated(sym, "childExitSignalThunkFor", [codeParam, sigParam]);
  const codeDef = host.unionsById.get(codeParam.unionId);
  const f64Tag = codeDef ? codeDef.arms.findIndex((a) => a.kind === "f64") : -1;
  const codeNullTag = codeDef ? codeDef.arms.findIndex((a) => a.kind === "nullT") : -1;
  const sigDef = host.unionsById.get(sigParam.unionId);
  const strTag = sigDef ? sigDef.arms.findIndex((a) => a.kind === "string") : -1;
  const sigNullTag = sigDef ? sigDef.arms.findIndex((a) => a.kind === "nullT") : -1;
  if (f64Tag < 0 || codeNullTag < 0 || strTag < 0 || sigNullTag < 0) {
    throw new InternalCompilerError("llvm emitter bug: exit listener unions lack their arms");
  }
  host.declare(`declare ptr @scr_union_new_f64(i32, double)`);
  host.declare(`declare ptr @scr_union_new_ref(i32, ptr, ptr, ptr, ptr)`);
  host.declare(`declare ptr @scr_str_new(ptr, ${host.sizeType})`);
  host.declare(`declare ${host.sizeType} @strlen(ptr)`);
  host.declare(`declare ptr @scr_str_retain_v(ptr)`);
  host.declare(`declare void @scr_str_release_v(ptr)`);
  host.resolveThunkDefs.push(
    `define internal void @${sym}(ptr %cb, i1 zeroext %has, double %code, ptr %sig) ${FN_ATTRS} { ; child exit (code, signal)`,
    `entry:`,
    `  %uslot = alloca ptr`,
    `  %sslot = alloca ptr`,
    `  br i1 %has, label %num, label %nonum`,
    `num:`,
    `  %u1 = call ptr @scr_union_new_f64(i32 ${f64Tag}, double %code)`,
    `  store ptr %u1, ptr %uslot`,
    `  br label %sigq`,
    `nonum:`,
    `  store ptr ${host.unitInstanceRef(codeParam.unionId, codeNullTag)}, ptr %uslot`,
    `  br label %sigq`,
    `sigq:`,
    `  %hassig = icmp ne ptr %sig, null`,
    `  br i1 %hassig, label %sigs, label %signull`,
    `sigs:`,
    `  %len = call ${host.sizeType} @strlen(ptr %sig)`,
    `  %ss = call ptr @scr_str_new(ptr %sig, ${host.sizeType} %len)`,
    ...unionWrapRefLines(host, sigParam.unionId, strTag, { kind: "string" }, "%ss", "%su"),
    `  store ptr %su, ptr %sslot`,
    `  br label %go`,
    `signull:`,
    `  store ptr ${host.unitInstanceRef(sigParam.unionId, sigNullTag)}, ptr %sslot`,
    `  br label %go`,
    `go:`,
    `  %u = load ptr, ptr %uslot`,
    `  %s = load ptr, ptr %sslot`,
    `  %fnp = getelementptr inbounds %ScrClosure, ptr %cb, i64 0, i32 1`,
    `  %fn = load ptr, ptr %fnp`,
    `  call void %fn(ptr %cb, ptr %u, ptr %s)`,
    `  ret void`,
    `}`,
    ``,
  );
  host.journal?.built();
  return sym;
}

export function execFileThunkFor(host: LlvmEmitterContext, cbT: IrType & { kind: "func" }): string {
  const key = `exec:${typeKey(cbT)}`;
  let sym = host.resolveThunks.get(key);
  if (sym) return sym;
  sym = host.contentSymbol("sc_exec_", key);
  host.resolveThunks.set(key, sym);
  host.journal?.allocated(sym, "execFileThunkFor", [cbT]);
  const errorParam = cbT.params[0];
  let errorTag = -1;
  let nullTag = -1;
  let errorArm: IrType | null = null;
  let errorTrace = "null";
  if (errorParam !== undefined) {
    if (errorParam.kind !== "union")
      throw new InternalCompilerError("llvm emitter bug: execFile error param not a union");
    const def = host.unionsById.get(errorParam.unionId);
    errorTag = def
      ? def.arms.findIndex((arm) => arm.kind === "object" && arm.className === "%Error")
      : -1;
    nullTag = def ? def.arms.findIndex((arm) => arm.kind === "nullT") : -1;
    errorArm = errorTag >= 0 ? (def?.arms[errorTag] ?? null) : null;
    if (errorTag < 0 || nullTag < 0 || errorArm === null) {
      throw new InternalCompilerError("llvm emitter bug: execFile error union lacks its arms");
    }
    errorTrace = traceArg(host.shapeHost, errorArm);
    host.declare(`declare ptr @scr_union_new_ref(i32, ptr, ptr, ptr, ptr)`);
    host.declare(`declare ptr @scr_error_retain_v(ptr)`);
    host.declare(`declare void @scr_error_release_v(ptr)`);
  } else {
    host.declare(`declare void @scr_error_release(ptr)`);
  }
  if (cbT.params.length < 3) host.declare(`declare void @scr_str_release(ptr)`);
  const d: string[] = [
    `define internal void @${sym}(ptr %cb, ptr %err, ptr %out, ptr %stderr) ${FN_ATTRS} { ; execFile callback ${typeKey(cbT)}`,
    `entry:`,
  ];
  if (errorParam !== undefined) {
    d.push(
      `  %eslot = alloca ptr`,
      `  %haserr = icmp ne ptr %err, null`,
      `  br i1 %haserr, label %errsome, label %errnone`,
      `errsome:`,
      `  %eu = call ptr @scr_union_new_ref(i32 ${errorTag}, ptr %err, ptr @scr_error_retain_v, ptr @scr_error_release_v, ptr ${errorTrace})`,
      `  store ptr %eu, ptr %eslot`,
      `  br label %go`,
      `errnone:`,
      `  store ptr ${host.unitInstanceRef(errorParam.unionId, nullTag)}, ptr %eslot`,
      `  br label %go`,
      `go:`,
      `  %e = load ptr, ptr %eslot`,
    );
  } else {
    d.push(`  call void @scr_error_release(ptr %err)`);
  }
  if (cbT.params.length < 2) d.push(`  call void @scr_str_release(ptr %out)`);
  if (cbT.params.length < 3) d.push(`  call void @scr_str_release(ptr %stderr)`);
  d.push(
    `  %fnp = getelementptr inbounds %ScrClosure, ptr %cb, i64 0, i32 1`,
    `  %fn = load ptr, ptr %fnp`,
    `  call void %fn(ptr %cb${errorParam !== undefined ? ", ptr %e" : ""}${cbT.params.length >= 2 ? ", ptr %out" : ""}${cbT.params.length >= 3 ? ", ptr %stderr" : ""})`,
    `  ret void`,
    `}`,
    ``,
  );
  host.resolveThunkDefs.push(...d);
  host.journal?.built();
  return sym;
}

export function ipcMessageThunkFor(
  host: LlvmEmitterContext,
  cbT: IrType & { kind: "func" },
): string {
  const key = `ipcmsg:${typeKey(cbT)}`;
  let sym = host.resolveThunks.get(key);
  if (sym) return sym;
  sym = host.contentSymbol("sc_ipc_msg_", key);
  host.resolveThunks.set(key, sym);
  host.journal?.allocated(sym, "ipcMessageThunkFor", [cbT]);
  const param = cbT.params[0];
  const d: string[] = [
    `define internal void @${sym}(ptr %cb, ptr %message) ${FN_ATTRS} { ; IPC message ${typeKey(cbT)}`,
    `entry:`,
  ];
  let passed = "";
  if (param !== undefined) {
    const ty = host.llType(param);
    if (param.kind === "dyn") {
      host.declare(`declare ptr @scr_dyn_retain_v(ptr)`);
      d.push(`  %value = call ptr @scr_dyn_retain_v(ptr %message)`);
    } else {
      const helper = host.dyn.dynCheckHelper(param);
      d.push(`  %value = call ${ty} @${helper}(ptr %message, ptr null)`);
      d.push(
        ...host.pendingTestLines("%bad"),
        `  br i1 %bad, label %fail, label %invoke`,
        `fail:`,
        ...(isRefCounted(param)
          ? [`  call void ${releaseSym(host.shapeHost, param)}(ptr %value)`]
          : []),
        `  ret void`,
        `invoke:`,
      );
    }
    passed = `, ${ty} %value`;
  }
  d.push(
    `  %fnp = getelementptr inbounds %ScrClosure, ptr %cb, i64 0, i32 1`,
    `  %fn = load ptr, ptr %fnp`,
  );
  const retTy = host.llType(cbT.ret);
  if (retTy === "void") d.push(`  call void %fn(ptr %cb${passed})`);
  else {
    d.push(`  %result = call ${retTy} %fn(ptr %cb${passed})`);
    if (isRefCounted(cbT.ret))
      d.push(`  call void ${releaseSym(host.shapeHost, cbT.ret)}(ptr %result)`);
  }
  d.push(`  ret void`, `}`, ``);
  host.resolveThunkDefs.push(...d);
  host.journal?.built();
  return sym;
}

export function ipcSendThunkFor(host: LlvmEmitterContext, cbT: IrType & { kind: "func" }): string {
  const key = `ipcsend:${typeKey(cbT)}`;
  let sym = host.resolveThunks.get(key);
  if (sym) return sym;
  sym = host.contentSymbol("sc_ipc_send_", key);
  host.resolveThunks.set(key, sym);
  host.journal?.allocated(sym, "ipcSendThunkFor", [cbT]);
  const param = cbT.params[0];
  const d: string[] = [
    `define internal void @${sym}(ptr %cb, ptr %error) ${FN_ATTRS} { ; IPC send callback ${typeKey(cbT)}`,
    `entry:`,
  ];
  if (param === undefined) {
    host.declare(`declare void @scr_error_release(ptr)`);
    d.push(
      `  call void @scr_error_release(ptr %error)`,
      `  %fnp = getelementptr inbounds %ScrClosure, ptr %cb, i64 0, i32 1`,
      `  %fn = load ptr, ptr %fnp`,
      `  call void %fn(ptr %cb)`,
    );
  } else {
    if (param.kind !== "union")
      throw new InternalCompilerError("llvm emitter bug: IPC send callback param not a union");
    const def = host.unionsById.get(param.unionId);
    const errorTag = def
      ? def.arms.findIndex((arm) => arm.kind === "object" && arm.className === "%Error")
      : -1;
    const nullTag = def ? def.arms.findIndex((arm) => arm.kind === "nullT") : -1;
    const errorArm = errorTag >= 0 ? def?.arms[errorTag] : undefined;
    if (errorTag < 0 || nullTag < 0 || !errorArm) {
      throw new InternalCompilerError("llvm emitter bug: IPC send callback union lacks Error|null");
    }
    host.declare(`declare ptr @scr_union_new_ref(i32, ptr, ptr, ptr, ptr)`);
    host.declare(`declare ptr @scr_error_retain_v(ptr)`);
    host.declare(`declare void @scr_error_release_v(ptr)`);
    d.push(
      `  %slot = alloca ptr`,
      `  %has = icmp ne ptr %error, null`,
      `  br i1 %has, label %some, label %none`,
      `some:`,
      `  %wrapped = call ptr @scr_union_new_ref(i32 ${errorTag}, ptr %error, ptr @scr_error_retain_v, ptr @scr_error_release_v, ptr ${traceArg(host.shapeHost, errorArm)})`,
      `  store ptr %wrapped, ptr %slot`,
      `  br label %invoke`,
      `none:`,
      `  store ptr ${host.unitInstanceRef(param.unionId, nullTag)}, ptr %slot`,
      `  br label %invoke`,
      `invoke:`,
      `  %value = load ptr, ptr %slot`,
      `  %fnp = getelementptr inbounds %ScrClosure, ptr %cb, i64 0, i32 1`,
      `  %fn = load ptr, ptr %fnp`,
      `  call void %fn(ptr %cb, ptr %value)`,
    );
  }
  d.push(`  ret void`, `}`, ``);
  host.resolveThunkDefs.push(...d);
  host.journal?.built();
  return sym;
}

export function childDataThunkFor(host: LlvmEmitterContext, param: IrType): string {
  if (param.kind !== "union")
    throw new InternalCompilerError("llvm emitter bug: stream data listener param not a union");
  const key = `cd:${param.unionId}`;
  let sym = host.resolveThunks.get(key);
  if (sym) return sym;
  sym = host.contentSymbol("sc_cd_", key);
  host.resolveThunks.set(key, sym);
  host.journal?.allocated(sym, "childDataThunkFor", [param]);
  const def = host.unionsById.get(param.unionId);
  const bytesTag = def ? def.arms.findIndex((a) => a.kind === "bytes" && a.elem === "u8") : -1;
  if (bytesTag < 0)
    throw new InternalCompilerError(
      "llvm emitter bug: stream data listener union lacks its Buffer arm",
    );
  host.declare(`declare ptr @scr_union_new_ref(i32, ptr, ptr, ptr, ptr)`);
  host.declare(`declare ptr @scr_bytes_retain_v(ptr)`);
  host.declare(`declare void @scr_bytes_release_v(ptr)`);
  host.resolveThunkDefs.push(
    `define internal void @${sym}(ptr %cb, ptr %chunk) ${FN_ATTRS} { ; child 'data' → ${param.unionId}`,
    `entry:`,
    `  %r = call ptr @scr_bytes_retain_v(ptr %chunk)`,
    `  %u = call ptr @scr_union_new_ref(i32 ${bytesTag}, ptr %r, ptr @scr_bytes_retain_v, ptr @scr_bytes_release_v, ptr null)`,
    `  %fnp = getelementptr inbounds %ScrClosure, ptr %cb, i64 0, i32 1`,
    `  %fn = load ptr, ptr %fnp`,
    `  call void %fn(ptr %cb, ptr %u)`,
    `  ret void`,
    `}`,
    ``,
  );
  host.journal?.built();
  return sym;
}

/** The child-stream 'data' thunk for an unknown/any chunk parameter: the
 * runtime's Buffer (or, after setEncoding, string) chunk boxes into a
 * checked-dynamic value the listener owns. */
export function childDataDynThunkFor(host: LlvmEmitterContext, chunk: "bytes" | "str"): string {
  const key = `cdd:${chunk}`;
  let sym = host.resolveThunks.get(key);
  if (sym) return sym;
  sym = host.contentSymbol("sc_cdd_", key);
  host.resolveThunks.set(key, sym);
  host.journal?.allocated(sym, "childDataDynThunkFor", [chunk]);
  const box = chunk === "bytes" ? "scr_dyn_new_buffer" : "scr_dyn_new_str";
  host.declare(`declare ptr @${box}(ptr)`);
  host.resolveThunkDefs.push(
    `define internal void @${sym}(ptr %cb, ptr %chunk) ${FN_ATTRS} { ; child 'data' → dyn (${chunk})`,
    `entry:`,
    `  %d = call ptr @${box}(ptr %chunk)`,
    `  %fnp = getelementptr inbounds %ScrClosure, ptr %cb, i64 0, i32 1`,
    `  %fn = load ptr, ptr %fnp`,
    `  call void %fn(ptr %cb, ptr %d)`,
    `  ret void`,
    `}`,
    ``,
  );
  host.journal?.built();
  return sym;
}

export function emitterFixedAdapter(
  host: LlvmEmitterContext,
  cbT: IrType & { kind: "func" },
): { fn: string; shim: string } {
  // Short tuples use direct fixed signatures. Longer listeners read an
  // opaque runtime cursor so no platform va_list layout leaks into LLVM.
  const cursor = cbT.params.length > 4;
  const shim = cursor ? "scr_ee_inv_args" : `scr_ee_inv_fixed${cbT.params.length}`;
  if (cursor) host.declare("declare ptr @scr_ee_arg_next(ptr)");
  // Only the shim's ADDRESS rides the .ll (the runtime calls it through
  // its real ScrEeInvoke type); the (ptr, ptr) spelling is layout-free.
  host.declare(`declare void @${shim}(ptr, ptr)`);
  const key = `ee:${typeKey(cbT)}`;
  let sym = host.resolveThunks.get(key);
  if (sym) return { fn: sym, shim };
  sym = host.contentSymbol("sc_ee_ad_", key);
  host.resolveThunks.set(key, sym);
  host.journal?.allocated(sym, "emitterFixedAdapter", [cbT]);
  host.declare(`declare ptr @scr_box_get_ref(ptr)`);
  host.declare(`declare void @scr_closure_release(ptr)`);
  const params = cursor ? "ptr %args" : cbT.params.map((_, i) => `ptr %a${i}`).join(", ");
  const d: string[] = [
    `define internal void @${sym}(ptr %cb${params ? ", " + params : ""}) ${FN_ATTRS} { ; emitter listener adapter ${typeKey(cbT)}`,
    `entry:`,
    `  %capsp = getelementptr inbounds %ScrClosure, ptr %cb, i64 1`,
    `  %bx = load ptr, ptr %capsp`,
    `  %orig = call ptr @scr_box_get_ref(ptr %bx) ; the listener, +1`,
  ];
  const passed: string[] = ["ptr %orig"];
  cbT.params.forEach((p, i) => {
    if (cursor) d.push(`  %a${i} = call ptr @scr_ee_arg_next(ptr %args)`);
    const ty = host.llType(p);
    if (ty === "double") {
      d.push(`  %d${i} = load double, ptr %a${i}`);
      passed.push(`double %d${i}`);
    } else if (ty === "i1") {
      d.push(`  %b${i} = load i1, ptr %a${i}`);
      passed.push(`i1 %b${i}`);
    } else if (isRefCounted(p)) {
      d.push(`  %r${i} = call ptr ${retainSym(host.shapeHost, p)}(ptr %a${i})`);
      passed.push(`ptr %r${i}`);
    } else {
      passed.push(`ptr %a${i}`);
    }
  });
  d.push(
    `  %fnp = getelementptr inbounds %ScrClosure, ptr %orig, i64 0, i32 1`,
    `  %fn = load ptr, ptr %fnp`,
  );
  const retTy = host.llType(cbT.ret);
  if (retTy === "void") {
    d.push(`  call void %fn(${passed.join(", ")})`);
  } else {
    d.push(`  %ret = call ${retTy} %fn(${passed.join(", ")})`);
    if (isRefCounted(cbT.ret)) {
      d.push(
        `  call void ${releaseSym(host.shapeHost, cbT.ret)}(ptr %ret) ; discarded listener result`,
      );
    }
  }
  d.push(`  call void @scr_closure_release(ptr %orig)`, `  ret void`, `}`, ``);
  host.resolveThunkDefs.push(...d);
  host.journal?.built();
  return { fn: sym, shim };
}

/** The typed listener adapter for an events.once boxer of type `boxerT`
 * (the event's tuple to any[]): the runtime-built listener closure holds
 * the boxer in caps[0], so the adapter calls it with the event's typed
 * arguments, as emitterFixedAdapter calls a listener, and hands the array
 * to scr_events_once_fire (or `fire`, the signal form's entry). */
export function emitterOnceAdapter(
  host: LlvmEmitterContext,
  boxerT: IrType & { kind: "func" },
  fire = "scr_events_once_fire",
): { fn: string; shim: string } {
  const cursor = boxerT.params.length > 4;
  const shim = cursor ? "scr_ee_inv_args" : `scr_ee_inv_fixed${boxerT.params.length}`;
  if (cursor) host.declare("declare ptr @scr_ee_arg_next(ptr)");
  host.declare(`declare void @${shim}(ptr, ptr)`);
  const key =
    fire === "scr_events_once_fire"
      ? `eeOnce:${typeKey(boxerT)}`
      : `eeOnce:${fire}:${typeKey(boxerT)}`;
  let sym = host.resolveThunks.get(key);
  if (sym) return { fn: sym, shim };
  sym = host.contentSymbol("sc_ee_once_", key);
  host.resolveThunks.set(key, sym);
  host.journal?.allocated(sym, "emitterOnceAdapter", [boxerT, fire]);
  host.declare(`declare ptr @scr_box_get_ref(ptr)`);
  host.declare(`declare void @scr_closure_release(ptr)`);
  host.declare(`declare void @${fire}(ptr, ptr)`);
  const params = cursor ? "ptr %args" : boxerT.params.map((_, i) => `ptr %a${i}`).join(", ");
  const d: string[] = [
    `define internal void @${sym}(ptr %cb${params ? ", " + params : ""}) ${FN_ATTRS} { ; events.once adapter ${typeKey(boxerT)}`,
    `entry:`,
    `  %capsp = getelementptr inbounds %ScrClosure, ptr %cb, i64 1`,
    `  %bx = load ptr, ptr %capsp`,
    `  %boxer = call ptr @scr_box_get_ref(ptr %bx) ; +1`,
  ];
  const passed: string[] = ["ptr %boxer"];
  boxerT.params.forEach((p, i) => {
    if (cursor) d.push(`  %a${i} = call ptr @scr_ee_arg_next(ptr %args)`);
    const ty = host.llType(p);
    if (ty === "double") {
      d.push(`  %d${i} = load double, ptr %a${i}`);
      passed.push(`double %d${i}`);
    } else if (ty === "i1") {
      d.push(`  %b${i} = load i1, ptr %a${i}`);
      passed.push(`i1 %b${i}`);
    } else if (isRefCounted(p)) {
      d.push(`  %r${i} = call ptr ${retainSym(host.shapeHost, p)}(ptr %a${i})`);
      passed.push(`ptr %r${i}`);
    } else {
      passed.push(`ptr %a${i}`);
    }
  });
  d.push(
    `  %fnp = getelementptr inbounds %ScrClosure, ptr %boxer, i64 0, i32 1`,
    `  %fn = load ptr, ptr %fnp`,
    `  %arr = call ptr %fn(${passed.join(", ")}) ; the boxed arguments, +1`,
    `  call void @scr_closure_release(ptr %boxer)`,
    `  call void @${fire}(ptr %cb, ptr %arr) ; moves %arr`,
    `  ret void`,
    `}`,
    ``,
  );
  host.resolveThunkDefs.push(...d);
  host.journal?.built();
  return { fn: sym, shim };
}

export function wrapEmitterListener(
  host: LlvmEmitterContext,
  target: string,
  adapterFn: string,
): string {
  const B = host.B;
  host.declare(`declare ptr @scr_closure_new(ptr, ${host.sizeType})`);
  host.declare(`declare ptr @scr_box_new(i32)`);
  host.declare(`declare void @scr_box_set_ref(ptr, ptr)`);
  const ad = B.tmp();
  B.line(`${ad} = call ptr @scr_closure_new(ptr @${adapterFn}, ${host.sizeType} 1)`);
  const bx = B.tmp();
  B.line(`${bx} = call ptr @scr_box_new(i32 4) ; SCR_BOX_FUNC`);
  const capsp = B.tmp();
  B.line(`${capsp} = getelementptr inbounds %ScrClosure, ptr ${ad}, i64 1`);
  B.line(`store ptr ${bx}, ptr ${capsp}`);
  B.line(`call void @scr_box_set_ref(ptr ${bx}, ptr ${target})`);
  return ad;
}

export function unwrapNullableClosure(
  host: LlvmEmitterContext,
  u: string,
  funcTag: number,
): string {
  const B = host.B;
  host.declare(`declare ptr @scr_closure_retain_v(ptr)`);
  const slot = B.slot();
  B.entryAllocas.push(`${slot} = alloca ptr`);
  B.line(`store ptr null, ptr ${slot}`);
  const tagP = B.tmp();
  const tag = B.tmp();
  B.line(`${tagP} = getelementptr inbounds %ScrUnion, ptr ${u}, i64 0, i32 1`);
  B.line(`${tag} = load i32, ptr ${tagP}`);
  const hit = B.tmp();
  B.line(`${hit} = icmp eq i32 ${tag}, ${funcTag}`);
  const ly = B.newLabel("uc.y");
  const lj = B.newLabel("uc.j");
  B.condBr(hit, ly, lj);
  B.startBlock(ly);
  const pp = B.tmp();
  const pv = B.tmp();
  B.line(`${pp} = getelementptr inbounds %ScrUnion, ptr ${u}, i64 0, i32 5`);
  B.line(`${pv} = load ptr, ptr ${pp}`);
  const r = B.tmp();
  B.line(`${r} = call ptr @scr_closure_retain_v(ptr ${pv})`);
  B.line(`store ptr ${r}, ptr ${slot}`);
  B.br(lj);
  B.startBlock(lj);
  const out = B.tmp();
  B.line(`${out} = load ptr, ptr ${slot}`);
  return out;
}

export function closeBindThunkFor(
  host: LlvmEmitterContext,
  cbUnion: IrType,
  retServer: boolean,
): string {
  if (cbUnion.kind !== "union")
    throw new InternalCompilerError("llvm emitter bug: bound-close callback param not a union");
  const key = `ncb:${cbUnion.unionId}:${retServer ? "srv" : "void"}`;
  let sym = host.resolveThunks.get(key);
  if (sym) return sym;
  sym = host.contentSymbol("sc_ncb_", key);
  host.resolveThunks.set(key, sym);
  host.journal?.allocated(sym, "closeBindThunkFor", [cbUnion, retServer]);
  const def = host.unionsById.get(cbUnion.unionId);
  const funcTag = def ? def.arms.findIndex((a) => a.kind === "func") : -1;
  const funcArm = funcTag >= 0 ? (def!.arms[funcTag] as IrType & { kind: "func" }) : null;
  if (!funcArm)
    throw new InternalCompilerError(
      "llvm emitter bug: bound-close callback union lacks its func arm",
    );
  const oneParam = funcArm.params.length === 1;
  host.declare(`declare ptr @scr_box_get_ref(ptr)`);
  host.declare(`declare void @scr_closure_release(ptr)`);
  host.declare(`declare void @scr_union_release(ptr)`);
  host.declare(`declare ptr @scr_closure_retain_v(ptr)`);
  host.declare(`declare void @scr_net_server_close_direct(ptr, ptr)`);
  let trampoline: string | null = null;
  if (oneParam) {
    const errParam = funcArm.params[0]!;
    if (errParam.kind !== "union")
      throw new InternalCompilerError(
        "llvm emitter bug: bound-close callback's err param is not a union",
      );
    const errDef = host.unionsById.get(errParam.unionId);
    const undefTag = errDef ? errDef.arms.findIndex((a) => a.kind === "undefinedT") : -1;
    if (undefTag < 0)
      throw new InternalCompilerError(
        "llvm emitter bug: bound-close err union lacks its undefined arm",
      );
    trampoline = `${sym}_cb`;
    host.resolveThunkDefs.push(
      `define internal void @${trampoline}(ptr %self) ${FN_ATTRS} { ; close cb: fire with no error`,
      `entry:`,
      `  %capsp = getelementptr inbounds %ScrClosure, ptr %self, i64 1`,
      `  %bx = load ptr, ptr %capsp`,
      `  %inner = call ptr @scr_box_get_ref(ptr %bx) ; +1`,
      `  %fnp = getelementptr inbounds %ScrClosure, ptr %inner, i64 0, i32 1`,
      `  %fn = load ptr, ptr %fnp`,
      `  call void %fn(ptr %inner, ptr ${host.unitInstanceRef(errParam.unionId, undefTag)})`,
      `  call void @scr_closure_release(ptr %inner)`,
      `  ret void`,
      `}`,
      ``,
    );
    host.declare(`declare ptr @scr_closure_new(ptr, ${host.sizeType})`);
    host.declare(`declare ptr @scr_box_new(i32)`);
    host.declare(`declare void @scr_box_set_ref(ptr, ptr)`);
  }
  if (!retServer) host.declare(`declare void @scr_net_server_release_v(ptr)`);
  const d: string[] = [
    `define internal ${retServer ? "ptr" : "void"} @${sym}(ptr %self, ptr %cbu) ${FN_ATTRS} { ; bound server.close`,
    `entry:`,
    `  %regslot = alloca ptr`,
    `  store ptr null, ptr %regslot`,
    `  %capsp = getelementptr inbounds %ScrClosure, ptr %self, i64 1`,
    `  %bx = load ptr, ptr %capsp`,
    `  %srv = call ptr @scr_box_get_ref(ptr %bx) ; +1`,
    `  %tagp = getelementptr inbounds %ScrUnion, ptr %cbu, i64 0, i32 1`,
    `  %tag = load i32, ptr %tagp`,
    `  %isfn = icmp eq i32 %tag, ${funcTag}`,
    `  br i1 %isfn, label %fn, label %go`,
    `fn:`,
    `  %pp = getelementptr inbounds %ScrUnion, ptr %cbu, i64 0, i32 5`,
    `  %pv = load ptr, ptr %pp`,
  ];
  if (oneParam) {
    d.push(
      `  %reg = call ptr @scr_closure_new(ptr @${trampoline}, ${host.sizeType} 1)`,
      `  %rbx = call ptr @scr_box_new(i32 4) ; SCR_BOX_FUNC`,
      `  %rcp = getelementptr inbounds %ScrClosure, ptr %reg, i64 1`,
      `  store ptr %rbx, ptr %rcp`,
      `  %pr = call ptr @scr_closure_retain_v(ptr %pv)`,
      `  call void @scr_box_set_ref(ptr %rbx, ptr %pr)`,
      `  store ptr %reg, ptr %regslot`,
    );
  } else {
    d.push(`  %reg = call ptr @scr_closure_retain_v(ptr %pv)`, `  store ptr %reg, ptr %regslot`);
  }
  d.push(
    `  br label %go`,
    `go:`,
    `  %regv = load ptr, ptr %regslot`,
    `  call void @scr_union_release(ptr %cbu) ; the callee owns its +1 param`,
    `  call void @scr_net_server_close_direct(ptr %srv, ptr %regv) ; reg moves`,
  );
  if (retServer) {
    d.push(`  ret ptr %srv ; +1 from the env read`);
  } else {
    d.push(`  call void @scr_net_server_release_v(ptr %srv)`, `  ret void`);
  }
  d.push(`}`, ``);
  host.resolveThunkDefs.push(...d);
  host.journal?.built();
  return sym;
}

export function closeOverrideWrapFor(
  host: LlvmEmitterContext,
  cbUnion: IrType,
  retServer: boolean,
): string {
  if (cbUnion.kind !== "union")
    throw new InternalCompilerError("llvm emitter bug: close-override callback param not a union");
  const key = `ncw:${cbUnion.unionId}:${retServer ? "srv" : "void"}`;
  let sym = host.resolveThunks.get(key);
  if (sym) return sym;
  sym = host.contentSymbol("sc_ncw_", key);
  host.resolveThunks.set(key, sym);
  host.journal?.allocated(sym, "closeOverrideWrapFor", [cbUnion, retServer]);
  const def = host.unionsById.get(cbUnion.unionId);
  const undefTag = def ? def.arms.findIndex((a) => a.kind === "undefinedT") : -1;
  if (undefTag < 0)
    throw new InternalCompilerError(
      "llvm emitter bug: close-override callback union lacks its undefined arm",
    );
  host.declare(`declare ptr @scr_box_get_ref(ptr)`);
  host.declare(`declare void @scr_closure_release(ptr)`);
  if (retServer) host.declare(`declare void @scr_net_server_release_v(ptr)`);
  host.resolveThunkDefs.push(
    `define internal void @${sym}(ptr %self) ${FN_ATTRS} { ; close override wrapper`,
    `entry:`,
    `  %capsp = getelementptr inbounds %ScrClosure, ptr %self, i64 1`,
    `  %bx = load ptr, ptr %capsp`,
    `  %inner = call ptr @scr_box_get_ref(ptr %bx) ; +1`,
    `  %fnp = getelementptr inbounds %ScrClosure, ptr %inner, i64 0, i32 1`,
    `  %fn = load ptr, ptr %fnp`,
    ...(retServer
      ? [
          `  %r = call ptr %fn(ptr %inner, ptr ${host.unitInstanceRef(cbUnion.unionId, undefTag)})`,
          `  call void @scr_net_server_release_v(ptr %r) ; the chaining return is unobserved here`,
        ]
      : [`  call void %fn(ptr %inner, ptr ${host.unitInstanceRef(cbUnion.unionId, undefTag)})`]),
    `  call void @scr_closure_release(ptr %inner)`,
    `  ret void`,
    `}`,
    ``,
  );
  host.journal?.built();
  return sym;
}

/** The Promise.allSettled store adapter for one (entry inner type →
 * PromiseSettledResult union) pair: builds the settled entry's
 * { status, value } or { status, reason } record (the reason as a dyn
 * value), wraps it in its union arm, and stores it at the entry's input
 * index (scr_promise_all_settled's ScrAllStore). */
export function settledStoreFor(
  host: LlvmEmitterContext,
  from: IrType,
  to: IrType & { kind: "union" },
): string {
  const key = `settled:${typeKey(from)}=>${typeKey(to)}`;
  let sym = host.resolveThunks.get(key);
  if (sym) return sym;
  sym = host.contentSymbol("sc_settled_", key);
  host.resolveThunks.set(key, sym);
  host.journal?.allocated(sym, "settledStoreFor", [from, to]);
  const def = host.unionsById.get(to.unionId);
  if (!def) throw new InternalCompilerError("llvm emitter bug: settled store to an unknown union");
  const armOf = (field: string): { tag: number; arm: IrType & { kind: "record" } } => {
    const tag = def.arms.findIndex(
      (arm) =>
        arm.kind === "record" &&
        host.recordsById.get(arm.shapeId)?.fields.some((f) => f.name === field) === true,
    );
    const arm = def.arms[tag];
    if (arm?.kind !== "record")
      throw new InternalCompilerError(`llvm emitter bug: settled union lacks its '${field}' arm`);
    return { tag, arm };
  };
  const fieldIndex = (arm: IrType & { kind: "record" }, field: string): number =>
    host.recordsById.get(arm.shapeId)!.fields.findIndex((f) => f.name === field) +
    host.nullableUnions.fieldBase(arm.shapeId);
  const fulfilled = armOf("value");
  const rejected = armOf("reason");
  const valueT = host.recordsById
    .get(fulfilled.arm.shapeId)!
    .fields.find((f) => f.name === "value")!.type;
  host.declare(`declare zeroext i1 @scr_promise_is_rejected(ptr)`);
  host.declare(`declare ptr @scr_promise_reason_dyn(ptr)`);
  host.declare(`declare void @scr_arr_set_ref(ptr, double, ptr)`);
  // One record per branch: status (an immortal literal), then the payload.
  const recordLines = (
    prefix: string,
    arm: { tag: number; arm: IrType & { kind: "record" } },
    status: string,
    field: string,
    fieldT: IrType,
    valueLines: string[],
  ): string[] => {
    const struct = `%${mangleRecordStruct(arm.arm.shapeId)}`;
    return [
      `  %${prefix}r = call ptr @${mangleRecordNew(arm.arm.shapeId)}()`,
      `  %${prefix}sp = getelementptr inbounds ${struct}, ptr %${prefix}r, i64 0, i32 ${fieldIndex(arm.arm, "status")}`,
      `  store ptr ${host.internLiteral(status)}, ptr %${prefix}sp`,
      ...valueLines,
      `  %${prefix}vp = getelementptr inbounds ${struct}, ptr %${prefix}r, i64 0, i32 ${fieldIndex(arm.arm, field)}`,
      // An inline union field copies the payload box's bits.
      ...(host.inlineUnions.record(fieldT)
        ? [
            ...inlineUnionCopyLines(`%${prefix}v`, `%${prefix}vp`, `%${prefix}vi`),
            `  call void ${releaseSym(host.shapeHost, fieldT)}(ptr %${prefix}v)`,
          ]
        : [`  store ${llFieldType(fieldT, false)} %${prefix}v, ptr %${prefix}vp`]),
      ...unionWrapRefLines(host, to.unionId, arm.tag, arm.arm, `%${prefix}r`, `%${prefix}u`),
      `  call void @scr_arr_set_ref(ptr %a, double %i, ptr %${prefix}u)`,
      `  ret void`,
    ];
  };
  let valueLines: string[];
  if (from.kind === "void") {
    host.declare(`declare ptr @scr_dyn_undefined()`);
    host.declare(`declare ptr @scr_dyn_retain_v(ptr)`);
    valueLines = [
      `  %fx = call ptr @scr_dyn_undefined()`,
      `  %fv = call ptr @scr_dyn_retain_v(ptr %fx)`,
    ];
  } else if (from.kind === "f64") {
    host.declare(`declare double @scr_promise_payload_f64(ptr)`);
    valueLines = [`  %fv = call double @scr_promise_payload_f64(ptr %src)`];
  } else if (from.kind === "bool") {
    host.declare(`declare zeroext i1 @scr_promise_payload_bool(ptr)`);
    valueLines = [
      `  %fb = call zeroext i1 @scr_promise_payload_bool(ptr %src)`,
      `  %fv = zext i1 %fb to i8`,
    ];
  } else if (from.kind === "string") {
    host.declare(`declare ptr @scr_promise_payload_str(ptr)`);
    valueLines = [`  %fv = call ptr @scr_promise_payload_str(ptr %src)`];
  } else {
    host.declare(`declare ptr @scr_promise_payload_ref(ptr)`);
    valueLines = [`  %fv = call ptr @scr_promise_payload_ref(ptr %src)`];
  }
  host.resolveThunkDefs.push(
    `define internal void @${sym}(ptr %a, double %i, ptr %src) ${FN_ATTRS} { ; settled ${key}`,
    `entry:`,
    `  %rej = call zeroext i1 @scr_promise_is_rejected(ptr %src)`,
    `  br i1 %rej, label %rejected, label %fulfilled`,
    `fulfilled:`,
    ...recordLines("f", fulfilled, "fulfilled", "value", valueT, valueLines),
    `rejected:`,
    ...recordLines("r", rejected, "rejected", "reason", { kind: "dyn" }, [
      `  %rv = call ptr @scr_promise_reason_dyn(ptr %src)`,
    ]),
    `}`,
    ``,
  );
  host.journal?.built();
  return sym;
}

registerReplay("raceAdapterFor", (host, args) =>
  raceAdapterFor(host, args[0] as IrType, args[1] as IrType),
);
registerReplay("genResultThunkFor", (host, args) =>
  genResultThunkFor(
    host,
    args[0] as IrType & { kind: "generator" },
    args[1] as IrType & { kind: "record" },
  ),
);
registerReplay("childExitThunkFor", (host, args) => childExitThunkFor(host, args[0] as IrType));
registerReplay("childExitSignalThunkFor", (host, args) =>
  childExitSignalThunkFor(host, args[0] as IrType, args[1] as IrType),
);
registerReplay("execFileThunkFor", (host, args) =>
  execFileThunkFor(host, args[0] as IrType & { kind: "func" }),
);
registerReplay("ipcMessageThunkFor", (host, args) =>
  ipcMessageThunkFor(host, args[0] as IrType & { kind: "func" }),
);
registerReplay("ipcSendThunkFor", (host, args) =>
  ipcSendThunkFor(host, args[0] as IrType & { kind: "func" }),
);
registerReplay("childDataThunkFor", (host, args) => childDataThunkFor(host, args[0] as IrType));
registerReplay("childDataDynThunkFor", (host, args) =>
  childDataDynThunkFor(host, args[0] as "bytes" | "str"),
);
registerReplay("closeBindThunkFor", (host, args) =>
  closeBindThunkFor(host, args[0] as IrType, args[1] as boolean),
);
registerReplay("closeOverrideWrapFor", (host, args) =>
  closeOverrideWrapFor(host, args[0] as IrType, args[1] as boolean),
);
registerReplay("settledStoreFor", (host, args) =>
  settledStoreFor(host, args[0] as IrType, args[1] as IrType & { kind: "union" }),
);
registerReplay(
  "emitterFixedAdapter",
  (host, args) => emitterFixedAdapter(host, args[0] as IrType & { kind: "func" }).fn,
);
registerReplay(
  "emitterOnceAdapter",
  (host, args) =>
    emitterOnceAdapter(host, args[0] as IrType & { kind: "func" }, args[1] as string).fn,
);
