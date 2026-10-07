/* Focused LLVM expression emission extracted from emitter.ts. */
import { InternalCompilerError } from "../../errors.js";
import { isStableReceiverOperand, undefinedArmTag } from "../../ir/analysis.js";
import { type IrExpr, type IrType, isRefCounted, typeEquals, typeKey } from "../../ir/ir.js";
import { mangleResolveThunk } from "../mangle.js";
import {
  elemAccess,
  FN_ATTRS,
  mapKeyAccess,
  type MapKeyAccess,
  mapKeyKindNum,
  mapKeyParamType,
  mapValKindNum,
  traceArg,
  vAdapters,
} from "./shapes.js";
import type { LlvmEmitterContext, LlValue } from "./expr-context.js";
import { F64_INF, f64Lit } from "./common.js";
import { borrowsStringInputs, emitStringInputs } from "./string-lifetimes.js";
import {
  emitMapLookupKey,
  borrowsMapReadInputs,
  borrowsMapMutationReceiver,
} from "./map-read-lifetimes.js";
import { emitBorrowedInput } from "./borrowed-inputs.js";

export function resolveThunkFor(host: LlvmEmitterContext, inner: IrType): string {
  const key = typeKey(inner);
  let sym = host.resolveThunks.get(key);
  if (!sym) {
    sym = mangleResolveThunk(host.resolveThunks.size);
    host.resolveThunks.set(key, sym);
    const v = vAdapters(host.shapeHost, inner);
    host.declare(`declare void @scr_resolve_ref_impl(ptr, ptr, ptr, ptr, ptr)`);
    host.resolveThunkDefs.push(
      `define internal void @${sym}(ptr %self, ptr %v) ${FN_ATTRS} { ; resolve<${key}>`,
      `entry:`,
      `  call void @scr_resolve_ref_impl(ptr %self, ptr %v, ptr ${v.retain}, ptr ${v.release}, ptr ${traceArg(host.shapeHost, inner)})`,
      `  ret void`,
      `}`,
      ``,
    );
  }
  return sym;
}

export function tagInSet(host: LlvmEmitterContext, uName: string, tags: number[]): string {
  const B = host.B;
  const tag = host.unionTag(uName);
  let acc = "";
  for (const t of tags) {
    const c = B.tmp();
    B.line(`${c} = icmp eq i32 ${tag}, ${t}`);
    if (acc === "") {
      acc = c;
    } else {
      const o = B.tmp();
      B.line(`${o} = or i1 ${acc}, ${c}`);
      acc = o;
    }
  }
  return acc;
}

export function arrPush(
  host: LlvmEmitterContext,
  arr: string,
  acc: "f64" | "bool" | "ref",
  value: string,
): string {
  const argTy = acc === "f64" ? "double" : acc === "bool" ? "i1" : "ptr";
  host.declare(
    `declare double @scr_arr_push_${acc}(ptr, ${argTy === "i1" ? "i1 zeroext" : argTy})`,
  );
  const t = host.B.tmp();
  host.B.line(`${t} = call double @scr_arr_push_${acc}(ptr ${arr}, ${argTy} ${value})`);
  return t;
}

/** Move evaluated values through one bounded slot buffer per call site. */
export function emitArrayValues(
  host: LlvmEmitterContext,
  arr: string,
  acc: "f64" | "bool" | "ref",
  values: LlValue[],
  prepend = false,
  sharedBuffer?: string,
): string {
  const B = host.B;
  if (acc === "ref") values.forEach((value) => host.moveTemp(value));
  if (values.length === 0) {
    host.declare("declare double @scr_arr_len(ptr)");
    const result = B.tmp();
    B.line(`${result} = call double @scr_arr_len(ptr ${arr})`);
    return result;
  }
  if (values.length === 1) {
    if (!prepend) return arrPush(host, arr, acc, values[0]!.name);
    const ty = acc === "f64" ? "double" : acc === "bool" ? "i1" : "ptr";
    host.declare(
      `declare double @scr_arr_unshift_${acc}(ptr, ${ty}${acc === "bool" ? " zeroext" : ""})`,
    );
    const result = B.tmp();
    B.line(`${result} = call double @scr_arr_unshift_${acc}(ptr ${arr}, ${ty} ${values[0]!.name})`);
    return result;
  }
  const capacity = Math.min(values.length, 64);
  const buffer = sharedBuffer ?? B.tmp();
  if (sharedBuffer === undefined) B.entryAllocas.push(`${buffer} = alloca [${capacity} x i64]`);
  const helper = prepend ? "scr_arr_unshift_many" : "scr_arr_push_many";
  host.declare(`declare double @${helper}(ptr, ${host.sizeType}, ptr)`);
  let result = "";
  for (let processed = 0; processed < values.length; processed += capacity) {
    const count = Math.min(capacity, values.length - processed);
    // Prepending consumes chunks from the end, preserving source order
    // both within each chunk and across the completed operation.
    const start = prepend ? values.length - processed - count : processed;
    for (let i = 0; i < count; i++) {
      const slot = B.tmp(),
        pointer = B.tmp();
      const value = values[start + i]!.name;
      const pack =
        acc === "f64"
          ? `bitcast double ${value} to i64`
          : acc === "bool"
            ? `zext i1 ${value} to i64`
            : `ptrtoint ptr ${value} to i64`;
      B.line(`${slot} = ${pack}`);
      B.line(`${pointer} = getelementptr inbounds i64, ptr ${buffer}, ${host.sizeType} ${i}`);
      B.line(`store i64 ${slot}, ptr ${pointer}`);
    }
    result = B.tmp();
    B.line(
      `${result} = call double @${helper}(ptr ${arr}, ${host.sizeType} ${count}, ptr ${buffer})`,
    );
  }
  return result;
}

export function emitArrayCopyLoop(
  host: LlvmEmitterContext,
  dst: string,
  src: string,
  acc: "f64" | "bool" | "ref",
): void {
  void acc;
  host.declare(`declare double @scr_arr_push_spread(ptr, ptr)`);
  host.B.line(`call double @scr_arr_push_spread(ptr ${dst}, ptr ${src})`);
}

export function emitStrIntrinsic(
  host: LlvmEmitterContext,
  e: IrExpr & { kind: "strIntrinsic" },
): LlValue {
  // String/array-returning methods hand back a +1 reference, including
  // identity returns. Inputs keep either a proven owner or a frame temp.
  // Omitted optional args get the C-side defaults from docs/ir.md.
  const B = host.B;
  const inputs = [e.receiver, ...e.args];
  const values = borrowsStringInputs(e.method)
    ? emitStringInputs(host, inputs)
    : inputs.map((a) => host.emitExpr(a));
  const r = values[0]!;
  const args = values.slice(1);
  const call = (
    sym: string,
    sig: string,
    argText: string,
    retTy: string,
    owned: boolean,
  ): LlValue => {
    // sig reads "<ret> (<params>)" — respelled to LLVM's declare form.
    const m = /^(.+?) \((.*)\)$/.exec(sig);
    if (!m) throw new InternalCompilerError(`llvm emitter bug: bad strIntrinsic sig ${sig}`);
    host.declare(`declare ${m[1]} @${sym}(${m[2]})`);
    const t = B.tmp();
    B.line(`${t} = call ${retTy} @${sym}(${argText})`);
    return owned ? host.own({ name: t, type: e.type }) : { name: t, type: e.type };
  };
  const method = e.method;
  switch (method) {
    case "length":
      return call("scr_str_utf16_len", "double (ptr)", `ptr ${r.name}`, "double", false);
    case "charCodeAt":
      return call(
        "scr_str_char_code_at",
        "double (ptr, double)",
        `ptr ${r.name}, double ${args[0]!.name}`,
        "double",
        false,
      );
    case "charAt":
      return call(
        "scr_str_char_at",
        "ptr (ptr, double)",
        `ptr ${r.name}, double ${args[0]!.name}`,
        "ptr",
        true,
      );
    case "indexOf":
      return call(
        "scr_str_index_of",
        "double (ptr, ptr, double)",
        `ptr ${r.name}, ptr ${args[0]!.name}, double ${args[1]?.name ?? f64Lit(0)}`,
        "double",
        false,
      );
    case "includes": {
      if (args[1]) {
        // The position form is indexOf's clamp exactly: found ⇔ != -1.
        const idx = call(
          "scr_str_index_of",
          "double (ptr, ptr, double)",
          `ptr ${r.name}, ptr ${args[0]!.name}, double ${args[1].name}`,
          "double",
          false,
        );
        const t = B.tmp();
        B.line(`${t} = fcmp une double ${idx.name}, ${f64Lit(-1)}`);
        return { name: t, type: e.type };
      }
      return call(
        "scr_str_includes",
        "zeroext i1 (ptr, ptr)",
        `ptr ${r.name}, ptr ${args[0]!.name}`,
        "i1",
        false,
      );
    }
    case "startsWith":
      return args[1]
        ? call(
            "scr_str_starts_with_from",
            "zeroext i1 (ptr, ptr, double)",
            `ptr ${r.name}, ptr ${args[0]!.name}, double ${args[1].name}`,
            "i1",
            false,
          )
        : call(
            "scr_str_starts_with",
            "zeroext i1 (ptr, ptr)",
            `ptr ${r.name}, ptr ${args[0]!.name}`,
            "i1",
            false,
          );
    case "endsWith":
      return args[1]
        ? call(
            "scr_str_ends_with_from",
            "zeroext i1 (ptr, ptr, double)",
            `ptr ${r.name}, ptr ${args[0]!.name}, double ${args[1].name}`,
            "i1",
            false,
          )
        : call(
            "scr_str_ends_with",
            "zeroext i1 (ptr, ptr)",
            `ptr ${r.name}, ptr ${args[0]!.name}`,
            "i1",
            false,
          );
    case "slice":
      return call(
        "scr_str_slice",
        "ptr (ptr, double, double)",
        `ptr ${r.name}, double ${args[0]?.name ?? f64Lit(0)}, double ${args[1]?.name ?? F64_INF}`,
        "ptr",
        true,
      );
    case "substring":
      return call(
        "scr_str_substring",
        "ptr (ptr, double, double)",
        `ptr ${r.name}, double ${args[0]!.name}, double ${args[1]?.name ?? F64_INF}`,
        "ptr",
        true,
      );
    case "repeat":
      return call(
        "scr_str_repeat",
        "ptr (ptr, double)",
        `ptr ${r.name}, double ${args[0]!.name}`,
        "ptr",
        true,
      );
    case "trim":
      return call("scr_str_trim", "ptr (ptr)", `ptr ${r.name}`, "ptr", true);
    case "trimStart":
      return call("scr_str_trim_start", "ptr (ptr)", `ptr ${r.name}`, "ptr", true);
    case "trimEnd":
      return call("scr_str_trim_end", "ptr (ptr)", `ptr ${r.name}`, "ptr", true);
    case "split":
      return call(
        "scr_str_split_limit",
        "ptr (ptr, ptr, double)",
        `ptr ${r.name}, ptr ${args[0]!.name}, double ${args[1]!.name}`,
        "ptr",
        true,
      );
    case "padStart":
      return call(
        "scr_str_pad_start",
        "ptr (ptr, double, ptr)",
        `ptr ${r.name}, double ${args[0]!.name}, ptr ${args[1]!.name}`,
        "ptr",
        true,
      );
    case "padEnd":
      return call(
        "scr_str_pad_end",
        "ptr (ptr, double, ptr)",
        `ptr ${r.name}, double ${args[0]!.name}, ptr ${args[1]!.name}`,
        "ptr",
        true,
      );
    case "toLowerCase":
      return call("scr_str_to_lower", "ptr (ptr)", `ptr ${r.name}`, "ptr", true);
    case "toUpperCase":
      return call("scr_str_to_upper", "ptr (ptr)", `ptr ${r.name}`, "ptr", true);
    case "normalize": {
      const result = call(
        "scr_str_normalize",
        "ptr (ptr, ptr)",
        `ptr ${r.name}, ptr ${args[0]!.name}`,
        "ptr",
        true,
      );
      host.emitPendingCheck();
      return result;
    }
    // The well-formedness pair: no-ops over well-formed storage
    // (constant true / retained identity; scr_string.c).
    case "isWellFormed":
      return call("scr_str_is_well_formed", "zeroext i1 (ptr)", `ptr ${r.name}`, "i1", false);
    case "toWellFormed":
      return call("scr_str_to_well_formed", "ptr (ptr)", `ptr ${r.name}`, "ptr", true);
    case "cpAt":
      // The code point AT an index as a one-code-point string (+1) —
      // the string-for-of desugar's read.
      return call(
        "scr_str_cp_at",
        "ptr (ptr, double)",
        `ptr ${r.name}, double ${args[0]!.name}`,
        "ptr",
        true,
      );
    default: {
      const _exhaustive: never = method;
      void _exhaustive;
      throw new InternalCompilerError("unreachable");
    }
  }
}

export function emitStableReceiver(
  host: LlvmEmitterContext,
  receiver: IrExpr,
  following: IrExpr[],
): LlValue {
  if (host.canBorrowCallArgument(receiver)) return host.emitReadReceiver(receiver);
  // A projection stays rooted while later operands preserve existing
  // reference edges. Checked narrowing may throw; the caller still owns
  // the projection's root while that statement unwinds.
  if (
    host.canBorrowReceiver(receiver) &&
    following.every((operand) => host.referenceEffects.preserves(operand))
  ) {
    return host.emitReadReceiver(receiver);
  }
  if (
    receiver.kind === "varRef" &&
    following.every((operand) => isStableReceiverOperand(operand, receiver.localId))
  ) {
    const b = host.binding(receiver.localId);
    if (b.kind !== "boxed") {
      if (b.kind === "global") host.checkGlobalTdz(receiver.localId);
      const value = host.B.tmp();
      host.B.line(`${value} = load ptr, ptr ${b.slot}`);
      return { name: value, type: receiver.type };
    }
  }
  return host.emitExpr(receiver);
}

export function emitArrIntrinsic(
  host: LlvmEmitterContext,
  e: IrExpr & { kind: "arrIntrinsic" },
): LlValue {
  const B = host.B;
  // Every array intrinsic borrows its receiver, including mutation and
  // retained-identity results. Scalar reads also admit the narrower proof
  // that a mutable binding survives the remaining operand evaluations.
  const r =
    e.method === "getNumber" || e.method === "indexEq" || e.method === "length"
      ? host.emitStableReceiver(e.receiver, e.args)
      : emitBorrowedInput(host, e.receiver);
  if (e.receiver.type.kind !== "array")
    throw new InternalCompilerError("llvm emitter bug: arrIntrinsic on non-array");
  const elem = e.receiver.type.elem;
  const acc = elemAccess(elem);
  const accTy = acc === "f64" ? "double" : acc === "bool" ? "i1" : "ptr";
  const accArg = acc === "bool" ? "i1 zeroext" : accTy;
  const method = e.method;
  switch (method) {
    case "length": {
      const p = B.tmp(),
        len = B.tmp(),
        t = B.tmp();
      B.line(`${p} = getelementptr inbounds %ScrArr, ptr ${r.name}, i32 0, i32 1`);
      host.markMemoryPointer(p, "array:header");
      B.line(`${len} = load ${host.sizeType}, ptr ${p}${host.fieldAliasAttachment(p)}`);
      B.line(`${t} = uitofp ${host.sizeType} ${len} to double`);
      return { name: t, type: e.type };
    }
    case "getNumber": {
      const index = host.emitExpr(e.args[0]!);
      const table =
        e.receiver.kind === "varRef"
          ? host.constantNumericTables.get(e.receiver.localId)
          : undefined;
      host.declare(`declare double @scr_arr_get_number(ptr, double)`);
      const t = B.tmp();
      B.line(
        `${t} = call double @${table ? `${table.symbol}_get` : "scr_arr_get_number"}(ptr ${r.name}, double ${index.name})`,
      );
      return { name: t, type: e.type };
    }
    case "nextPresent": {
      const start = host.emitExpr(e.args[0]!);
      host.declare(`declare double @scr_arr_next_present(ptr, double)`);
      const t = B.tmp();
      B.line(`${t} = call double @scr_arr_next_present(ptr ${r.name}, double ${start.name})`);
      return { name: t, type: e.type };
    }
    case "indexEq": {
      const index = host.emitExpr(e.args[0]!);
      const other = host.emitStableReceiver(e.args[1]!, [e.args[2]!]);
      const otherIndex = host.emitExpr(e.args[2]!);
      host.declare(`declare zeroext i1 @scr_arr_index_eq(ptr, double, ptr, double)`);
      const t = B.tmp();
      B.line(
        `${t} = call zeroext i1 @scr_arr_index_eq(ptr ${r.name}, double ${index.name}, ptr ${other.name}, double ${otherIndex.name})`,
      );
      return { name: t, type: e.type };
    }
    case "push": {
      // Variadic like JS: every argument evaluates first (left to
      // right), then each appends in order. Ownership of refcounted
      // arguments moves into the array; the result is the new length —
      // the last push's return, or the unchanged length for Node's
      // no-op zero-argument call.
      const vs = e.args.map((a) => host.emitExpr(a));
      return { name: emitArrayValues(host, r.name, acc, vs), type: e.type };
    }
    case "pushSpread": {
      // `a.push(...src)`: append src's elements in order (borrowed src,
      // count snapshotted). Result: the new length.
      const src = emitBorrowedInput(host, e.args[0]!);
      host.emitArrayCopyLoop(r.name, src.name, acc);
      host.declare(`declare double @scr_arr_len(ptr)`);
      const t = B.tmp();
      B.line(`${t} = call double @scr_arr_len(ptr ${r.name})`);
      return { name: t, type: e.type };
    }
    case "concatSpread": {
      const src = emitBorrowedInput(host, e.args[0]!);
      host.declare(`declare double @scr_arr_concat_copy(ptr, ptr)`);
      const t = B.tmp();
      B.line(`${t} = call double @scr_arr_concat_copy(ptr ${r.name}, ptr ${src.name})`);
      return { name: t, type: e.type };
    }
    case "unshift": {
      // Evaluate every argument before the first mutation, then insert
      // from right to left so the final front order is source order.
      const vs = e.args.map((a) => host.emitExpr(a));
      return { name: emitArrayValues(host, r.name, acc, vs, true), type: e.type };
    }
    case "unshiftSpread": {
      // The runtime snapshots the borrowed source and handles self-spread.
      const src = emitBorrowedInput(host, e.args[0]!);
      host.declare(`declare double @scr_arr_unshift_spread(ptr, ptr)`);
      const t = B.tmp();
      B.line(`${t} = call double @scr_arr_unshift_spread(ptr ${r.name}, ptr ${src.name})`);
      return { name: t, type: e.type };
    }
    case "pop":
    case "shift": {
      const dynamic = elem.kind === "dyn" && e.type.kind === "dyn";
      if (!dynamic && e.type.kind !== "union")
        throw new InternalCompilerError("llvm emitter bug: array removal result is not a union");
      const def = e.type.kind === "union" ? host.unionsById.get(e.type.unionId) : undefined;
      const tag = def ? def.arms.findIndex((arm) => typeEquals(arm, elem)) : -1;
      const undefTag = undefinedArmTag(e.type, host.unionsById);
      const sameUnion = elem.kind === "union" && typeEquals(elem, e.type);
      if (!dynamic && ((!sameUnion && tag < 0) || undefTag < 0))
        throw new InternalCompilerError("llvm emitter bug: array removal union lacks its arms");
      host.declare(`declare zeroext i8 @scr_arr_${method}_state(ptr, ptr)`);
      const rawSlot = B.slot();
      const resultSlot = B.slot();
      B.entryAllocas.push(`${rawSlot} = alloca i64`, `${resultSlot} = alloca ptr`);
      B.line(`store i64 0, ptr ${rawSlot}`);
      const state = B.tmp();
      const has = B.tmp();
      B.line(`${state} = call zeroext i8 @scr_arr_${method}_state(ptr ${r.name}, ptr ${rawSlot})`);
      B.line(`${has} = icmp eq i8 ${state}, 1`);
      const lp = B.newLabel("remove.p");
      const la = B.newLabel("remove.a");
      const lj = B.newLabel("remove.j");
      B.condBr(has, lp, la);
      B.startBlock(lp);
      const raw = B.tmp();
      const value = B.tmp();
      B.line(`${raw} = load i64, ptr ${rawSlot}`);
      if (elem.kind === "f64") B.line(`${value} = bitcast i64 ${raw} to double`);
      else if (elem.kind === "bool") B.line(`${value} = icmp ne i64 ${raw}, 0`);
      else B.line(`${value} = inttoptr i64 ${raw} to ptr`);
      B.line(
        `store ptr ${dynamic || sameUnion ? value : host.unionNewOwned(tag, { name: value, type: elem })}, ptr ${resultSlot}`,
      );
      B.br(lj);
      B.startBlock(la);
      if (dynamic) {
        host.declare(`declare ptr @scr_dyn_undefined()`);
        const absent = B.tmp();
        B.line(`${absent} = call ptr @scr_dyn_undefined()`);
        B.line(`store ptr ${absent}, ptr ${resultSlot}`);
      } else if (e.type.kind === "union") {
        B.line(`store ptr ${host.unitInstanceRef(e.type.unionId, undefTag)}, ptr ${resultSlot}`);
      }
      B.br(lj);
      B.startBlock(lj);
      const out = B.tmp();
      B.line(`${out} = load ptr, ptr ${resultSlot}`);
      return host.own({ name: out, type: e.type });
    }
    case "indexOf": {
      // The needle is BORROWED (released with this statement's frame);
      // the ref variant dispatches on the array's element kind (strings
      // by content, everything else by pointer). Strict equality.
      const v = host.emitExpr(e.args[0]!);
      host.declare(`declare double @scr_arr_index_of_${acc}(ptr, ${accArg})`);
      const t = B.tmp();
      B.line(`${t} = call double @scr_arr_index_of_${acc}(ptr ${r.name}, ${accTy} ${v.name})`);
      return { name: t, type: e.type };
    }
    case "includes": {
      // Borrowed needle, SameValueZero (NaN matches NaN).
      const v = host.emitExpr(e.args[0]!);
      host.declare(`declare zeroext i1 @scr_arr_includes_${acc}(ptr, ${accArg})`);
      const t = B.tmp();
      B.line(`${t} = call zeroext i1 @scr_arr_includes_${acc}(ptr ${r.name}, ${accTy} ${v.name})`);
      return { name: t, type: e.type };
    }
    case "join": {
      // Separator borrowed; the result is an owned (+1) string. Union
      // elements use the scalar join walker: nullish arms print empty,
      // and other arms append their String() spelling directly.
      const sep = emitBorrowedInput(host, e.args[0]!);
      if (elem.kind === "union") {
        const helper = host.walkers.unionJoinHelper(elem.unionId);
        const t = B.tmp();
        B.line(`${t} = call ptr @${helper}(ptr ${r.name}, ptr ${sep.name})`);
        return host.own({ name: t, type: e.type });
      }
      host.declare(`declare ptr @scr_arr_join(ptr, ptr)`);
      const t = B.tmp();
      B.line(`${t} = call ptr @scr_arr_join(ptr ${r.name}, ptr ${sep.name})`);
      return host.own({ name: t, type: e.type });
    }
    case "slice": {
      // Receiver borrowed; the result a fresh +1 shallow copy (ref
      // elements retained). Omitted indices get the JS defaults.
      const start = e.args[0] ? host.emitExpr(e.args[0]).name : f64Lit(0);
      const end = e.args[1] ? host.emitExpr(e.args[1]).name : F64_INF;
      host.declare(`declare ptr @scr_arr_slice(ptr, double, double)`);
      const t = B.tmp();
      B.line(`${t} = call ptr @scr_arr_slice(ptr ${r.name}, double ${start}, double ${end})`);
      return host.own({ name: t, type: e.type });
    }
    case "toReversed": {
      host.declare(`declare ptr @scr_arr_to_reversed(ptr)`);
      const t = B.tmp();
      B.line(`${t} = call ptr @scr_arr_to_reversed(ptr ${r.name})`);
      return host.own({ name: t, type: e.type });
    }
    case "reverse": {
      // Mutates in place and returns the same receiver as a fresh +1.
      host.declare(`declare ptr @scr_arr_reverse(ptr)`);
      const t = B.tmp();
      B.line(`${t} = call ptr @scr_arr_reverse(ptr ${r.name})`);
      return host.own({ name: t, type: e.type });
    }
    case "copyWithin":
    case "fill":
    case "fillUndefined": {
      const args = e.args.map((arg) => host.emitExpr(arg));
      const helper =
        e.method === "copyWithin"
          ? "scr_arr_copy_within"
          : e.method === "fillUndefined"
            ? "scr_arr_fill_undefined"
            : `scr_arr_fill_${acc}`;
      const types = e.method === "fill" ? [accTy, "double", "double"] : args.map(() => "double");
      const signature = e.method === "fill" ? [accArg, "double", "double"] : types;
      host.declare(`declare ptr @${helper}(ptr, ${signature.join(", ")})`);
      const result = B.tmp();
      B.line(
        `${result} = call ptr @${helper}(ptr ${r.name}, ${args.map((arg, i) => `${types[i]} ${arg.name}`).join(", ")})`,
      );
      return host.own({ name: result, type: e.type });
    }
    case "toSpliced": {
      const start = host.emitExpr(e.args[0]!);
      const count = host.emitExpr(e.args[1]!);
      const items = emitBorrowedInput(host, e.args[2]!);
      host.declare(`declare ptr @scr_arr_to_spliced(ptr, double, double, ptr)`);
      const t = B.tmp();
      B.line(
        `${t} = call ptr @scr_arr_to_spliced(ptr ${r.name}, double ${start.name}, ` +
          `double ${count.name}, ptr ${items.name})`,
      );
      return host.own({ name: t, type: e.type });
    }
    case "with": {
      const index = host.emitExpr(e.args[0]!);
      const value = emitBorrowedInput(host, e.args[1]!);
      host.declare(`declare ptr @scr_arr_with_${acc}(ptr, double, ${accArg})`);
      const t = B.tmp();
      B.line(
        `${t} = call ptr @scr_arr_with_${acc}(ptr ${r.name}, double ${index.name}, ` +
          `${accTy} ${value.name})`,
      );
      const out = host.own({ name: t, type: e.type });
      host.emitPendingCheck();
      return out;
    }
    case "withUndefined": {
      const index = host.emitExpr(e.args[0]!);
      host.declare(`declare ptr @scr_arr_with_undefined(ptr, double)`);
      const t = B.tmp();
      B.line(`${t} = call ptr @scr_arr_with_undefined(ptr ${r.name}, double ${index.name})`);
      const out = host.own({ name: t, type: e.type });
      host.emitPendingCheck();
      return out;
    }
    case "splice": {
      // The removal splice: removed elements come back as a fresh +1
      // array, ownership MOVED out of the receiver. An omitted count
      // removes to the end (+Infinity, the slice convention).
      const start = host.emitExpr(e.args[0]!);
      const cnt = e.args[1] ? host.emitExpr(e.args[1]).name : F64_INF;
      host.declare(`declare ptr @scr_arr_splice(ptr, double, double)`);
      const t = B.tmp();
      B.line(`${t} = call ptr @scr_arr_splice(ptr ${r.name}, double ${start.name}, double ${cnt})`);
      return host.own({ name: t, type: e.type });
    }
    case "spliceInsert": {
      const start = host.emitExpr(e.args[0]!);
      const count = host.emitExpr(e.args[1]!);
      const items = emitBorrowedInput(host, e.args[2]!);
      host.declare(`declare ptr @scr_arr_splice_insert(ptr, double, double, ptr)`);
      const t = B.tmp();
      B.line(
        `${t} = call ptr @scr_arr_splice_insert(ptr ${r.name}, double ${start.name}, double ${count.name}, ptr ${items.name})`,
      );
      return host.own({ name: t, type: e.type });
    }
    case "flatCopy":
    case "flatOne": {
      const out = emitBorrowedInput(host, e.args[0]!);
      host.declare(`declare ptr @scr_arr_flat_copy(ptr, ptr, i1)`);
      const t = B.tmp();
      B.line(
        `${t} = call ptr @scr_arr_flat_copy(ptr ${r.name}, ptr ${out.name}, i1 ${method === "flatOne" ? 1 : 0})`,
      );
      return host.own({ name: t, type: e.type });
    }
    default: {
      const _exhaustive: never = method;
      void _exhaustive;
      throw new InternalCompilerError("unreachable");
    }
  }
}

export function wrapNullable(
  host: LlvmEmitterContext,
  raw: string,
  present: string,
  valueType: IrType,
  valueTag: number,
  resultType: IrType & { kind: "union" },
  absentTag: number,
): LlValue {
  const B = host.B;
  const slot = B.slot();
  B.entryAllocas.push(`${slot} = alloca ptr`);
  const isnull = B.tmp();
  B.line(`${isnull} = icmp eq ptr ${raw}, null`);
  const lp = B.newLabel("nw.p");
  const la = B.newLabel("nw.a");
  const lj = B.newLabel("nw.j");
  B.condBr(isnull, la, lp);
  B.startBlock(lp);
  B.line(
    `store ptr ${host.unionNewOwned(valueTag, { name: present, type: valueType })}, ptr ${slot}`,
  );
  B.br(lj);
  B.startBlock(la);
  B.line(`store ptr ${host.unitInstanceRef(resultType.unionId, absentTag)}, ptr ${slot}`);
  B.br(lj);
  B.startBlock(lj);
  const t = B.tmp();
  B.line(`${t} = load ptr, ptr ${slot}`);
  return host.own({ name: t, type: resultType });
}

/** Construct matching key/value storage once for Maps and Sets. Union arm
 * descriptors are immutable module data; all-reference unions keep their
 * existing identity-only representation. */
function newCollection(host: LlvmEmitterContext, key: IrType, value: IrType): string {
  const B = host.B;
  const rc = isRefCounted(value)
    ? vAdapters(host.shapeHost, value)
    : { retain: "null", release: "null" };
  const arms = key.kind === "union" ? host.unionsById.get(key.unionId)?.arms : undefined;
  const kind = mapKeyKindNum(key, arms);
  const m = B.tmp();
  if (mapKeyAccess(key) === "ref") {
    const keyRc = vAdapters(host.shapeHost, key);
    host.declare(`declare ptr @scr_map_new_typed(i32, i32, ptr, ptr, ptr, ptr, ptr, ptr)`);
    B.line(
      `${m} = call ptr @scr_map_new_typed(i32 ${kind}, i32 ${mapValKindNum(value)}, ptr ${keyRc.retain}, ptr ${keyRc.release}, ptr ${traceArg(host.shapeHost, key)}, ptr ${rc.retain}, ptr ${rc.release}, ptr ${traceArg(host.shapeHost, value)})`,
    );
  } else {
    host.declare(`declare ptr @scr_map_new(i32, i32, ptr, ptr, ptr)`);
    B.line(
      `${m} = call ptr @scr_map_new(i32 ${kind}, i32 ${mapValKindNum(value)}, ptr ${rc.retain}, ptr ${rc.release}, ptr ${traceArg(host.shapeHost, value)})`,
    );
  }
  if (kind === 7) {
    if (!arms) throw new InternalCompilerError("llvm emitter bug: collection key union missing");
    const kinds = arms.map((arm) => String.fromCharCode(mapKeyKindNum(arm))).join("");
    host.declare(`declare void @scr_map_union_keys(ptr, ptr)`);
    B.line(`call void @scr_map_union_keys(ptr ${m}, ptr ${host.cstr(kinds)})`);
  }
  return m;
}

export function emitMapNew(host: LlvmEmitterContext, e: IrExpr & { kind: "mapNew" }): LlValue {
  if (e.type.kind !== "map")
    throw new InternalCompilerError("llvm emitter bug: mapNew of non-map type");
  const value = e.type.value;
  const kAcc = mapKeyAccess(e.type.key);
  const m = newCollection(host, e.type.key, value);
  const out = host.own({ name: m, type: e.type });
  // Seeded construction: set() each pair in source order — a repeated
  // key overwrites (the runtime releases the old value).
  const vAcc = elemAccess(value);
  for (const pair of e.seed ?? []) {
    const k = emitBorrowedInput(host, pair.key);
    const v = host.emitExpr(pair.value);
    if (vAcc === "ref") host.moveTemp(v); // the value MOVES in
    host.mapSet(m, kAcc, vAcc, k.name, v.name);
  }
  return out;
}

export function mapSet(
  host: LlvmEmitterContext,
  m: string,
  kAcc: MapKeyAccess,
  vAcc: "f64" | "bool" | "ref",
  key: string,
  value: string,
): void {
  const kTy = mapKeyParamType(kAcc);
  const vTy = vAcc === "f64" ? "double" : vAcc === "bool" ? "i1" : "ptr";
  host.declare(
    `declare void @scr_map_set_${kAcc}_${vAcc}(ptr, ${kTy}, ${vTy === "i1" ? "i1 zeroext" : vTy})`,
  );
  host.B.line(`call void @scr_map_set_${kAcc}_${vAcc}(ptr ${m}, ${kTy} ${key}, ${vTy} ${value})`);
}

export function emitMapLikeIntrinsic(
  host: LlvmEmitterContext,
  e: Extract<IrExpr, { kind: "mapIntrinsic" | "setIntrinsic" }>,
): LlValue {
  const B = host.B;
  const borrowInputs = borrowsMapReadInputs(e);
  const r =
    borrowInputs || borrowsMapMutationReceiver(e)
      ? host.emitStableReceiver(e.receiver, e.args)
      : emitBorrowedInput(host, e.receiver);
  const receiverType = e.receiver.type;
  if (e.kind === "mapIntrinsic" && receiverType.kind !== "map") {
    throw new InternalCompilerError("llvm emitter bug: mapIntrinsic on non-map");
  }
  if (e.kind === "setIntrinsic" && receiverType.kind !== "set") {
    throw new InternalCompilerError("llvm emitter bug: setIntrinsic on non-set");
  }
  if (receiverType.kind !== "map" && receiverType.kind !== "set") {
    throw new InternalCompilerError("unreachable");
  }
  const key = receiverType.kind === "map" ? receiverType.key : receiverType.elem;
  const kAcc = mapKeyAccess(key);
  const kTy = mapKeyParamType(kAcc);
  const method = e.method;
  if (method === "clone" || method === "keySet") {
    const keysOnly = method === "keySet" || receiverType.kind === "set";
    const checked =
      key.kind === "dyn" &&
      (keysOnly || (receiverType.kind === "map" && receiverType.value.kind === "dyn"));
    const helper = checked ? "scr_map_clone_dyn" : "scr_map_clone";
    host.declare(`declare ptr @${helper}(ptr, i1 zeroext)`);
    const result = B.tmp();
    B.line(`${result} = call ptr @${helper}(ptr ${r.name}, i1 ${keysOnly})`);
    return host.own({ name: result, type: e.type });
  }
  if (method === "valueSet") {
    if (receiverType.kind !== "map")
      throw new InternalCompilerError("llvm emitter bug: values from non-map");
    const result = newCollection(host, receiverType.value, { kind: "f64" });
    const out = host.own({ name: result, type: e.type });
    host.declare(`declare void @scr_map_values_into(ptr, ptr, i1 zeroext)`);
    B.line(
      `call void @scr_map_values_into(ptr ${result}, ptr ${r.name}, i1 ${receiverType.value.kind === "dyn"})`,
    );
    return out;
  }
  // A generic Map/Set view may share typed native storage. These accessors
  // consult its boxing adapters instead of reinterpreting scalar slots.
  if (key.kind === "dyn" && (receiverType.kind === "set" || receiverType.value.kind === "dyn")) {
    switch (method) {
      case "get": {
        const k = host.emitExpr(e.args[0]!);
        host.declare(`declare ptr @scr_map_dyn_get(ptr, ptr)`);
        const result = B.tmp();
        B.line(`${result} = call ptr @scr_map_dyn_get(ptr ${r.name}, ptr ${k.name})`);
        const owned = host.own({ name: result, type: e.type });
        host.emitPendingCheck();
        return owned;
      }
      case "set":
      case "add": {
        const k = host.emitExpr(e.args[0]!);
        const v = method === "set" ? host.emitExpr(e.args[1]!) : null;
        host.declare(`declare void @scr_map_dyn_set(ptr, ptr, ptr, i1 zeroext)`);
        B.line(
          `call void @scr_map_dyn_set(ptr ${r.name}, ptr ${k.name}, ptr ${v?.name ?? "null"}, i1 ${method === "add" ? "true" : "false"})`,
        );
        host.emitPendingCheck();
        return { name: "", type: e.type };
      }
      case "has":
      case "delete": {
        const k = host.emitExpr(e.args[0]!);
        host.declare(`declare zeroext i1 @scr_map_dyn_has(ptr, ptr, i1 zeroext)`);
        const result = B.tmp();
        B.line(
          `${result} = call zeroext i1 @scr_map_dyn_has(ptr ${r.name}, ptr ${k.name}, i1 ${method === "delete" ? "true" : "false"})`,
        );
        host.emitPendingCheck();
        return { name: result, type: e.type };
      }
      case "iterKey":
      case "iterValue": {
        const index = host.emitExpr(e.args[0]!);
        const accessor = method === "iterKey" ? "key" : "value";
        host.declare(`declare ptr @scr_map_dyn_${accessor}(ptr, double)`);
        const result = B.tmp();
        B.line(
          `${result} = call ptr @scr_map_dyn_${accessor}(ptr ${r.name}, double ${index.name})`,
        );
        return host.own({ name: result, type: e.type });
      }
      case "toArray": {
        host.declare(`declare ptr @scr_set_to_arr_dyn(ptr)`);
        const result = B.tmp();
        B.line(`${result} = call ptr @scr_set_to_arr_dyn(ptr ${r.name})`);
        return host.own({ name: result, type: e.type });
      }
      default:
        break;
    }
  }
  switch (method) {
    case "get": {
      if (receiverType.kind !== "map") throw new InternalCompilerError("unreachable");
      const value = receiverType.value;
      // The union construction is type-directed HERE, like envGet — the
      // runtime knows no tags. Ref values come back +1 (ownership MOVES
      // into the fresh union box on a hit); scalars ride an out-param
      // behind a found flag; a miss is the interned undefined-arm
      // instance. When V is itself a union, the stored box IS the
      // result (`undefined` sorts last in canonical arm order).
      const k = emitMapLookupKey(host, e.args[0]!, borrowInputs);
      const kAcc = k.access;
      const kTy = k.types;
      if (value.kind === "dyn") {
        host.declare(`declare ptr @scr_map_get_${kAcc}_ref(ptr, ${kTy})`);
        host.declare(`declare ptr @scr_dyn_undefined()`);
        const raw = B.tmp();
        const absent = B.tmp();
        const isnull = B.tmp();
        const result = B.tmp();
        B.line(`${raw} = call ptr @scr_map_get_${kAcc}_ref(ptr ${r.name}, ${k.args})`);
        B.line(`${absent} = call ptr @scr_dyn_undefined()`);
        B.line(`${isnull} = icmp eq ptr ${raw}, null`);
        B.line(`${result} = select i1 ${isnull}, ptr ${absent}, ptr ${raw}`);
        return host.own({ name: result, type: e.type });
      }
      if (e.type.kind !== "union")
        throw new InternalCompilerError("llvm emitter bug: map get result is not a union");
      const def = host.unionsById.get(e.type.unionId);
      const undefTag = undefinedArmTag(e.type, host.unionsById);
      if (!def || undefTag < 0)
        throw new InternalCompilerError("llvm emitter bug: map get union lacks its undefined arm");
      const absent = host.unitInstanceRef(e.type.unionId, undefTag);
      if (value.kind === "union") {
        host.declare(`declare ptr @scr_map_get_${kAcc}_ref(ptr, ${kTy})`);
        const raw = B.tmp();
        const isnull = B.tmp();
        const t = B.tmp();
        B.line(`${raw} = call ptr @scr_map_get_${kAcc}_ref(ptr ${r.name}, ${k.args})`);
        B.line(`${isnull} = icmp eq ptr ${raw}, null`);
        B.line(`${t} = select i1 ${isnull}, ptr ${absent}, ptr ${raw}`);
        return host.own({ name: t, type: e.type });
      }
      const valueTag = def.arms.findIndex((a) => typeEquals(a, value));
      if (valueTag < 0)
        throw new InternalCompilerError("llvm emitter bug: map get union lacks its value arm");
      if (value.kind === "f64" || value.kind === "bool") {
        const outTy = value.kind === "f64" ? "double" : "i8";
        const outSlot = B.slot();
        B.entryAllocas.push(`${outSlot} = alloca ${outTy}`);
        B.line(`store ${outTy} ${value.kind === "f64" ? f64Lit(0) : "0"}, ptr ${outSlot}`);
        host.declare(
          `declare zeroext i1 @scr_map_get_${kAcc}_${value.kind === "f64" ? "f64" : "bool"}(ptr, ${kTy}, ptr)`,
        );
        const found = B.tmp();
        B.line(
          `${found} = call zeroext i1 @scr_map_get_${kAcc}_${value.kind === "f64" ? "f64" : "bool"}(ptr ${r.name}, ${k.args}, ptr ${outSlot})`,
        );
        const slot = B.slot();
        B.entryAllocas.push(`${slot} = alloca ptr`);
        const lp = B.newLabel("mg.p");
        const la = B.newLabel("mg.a");
        const lj = B.newLabel("mg.j");
        B.condBr(found, lp, la);
        B.startBlock(lp);
        const rawOut = B.tmp();
        B.line(`${rawOut} = load ${outTy}, ptr ${outSlot}`);
        let hit = rawOut;
        if (value.kind === "bool") {
          hit = B.tmp();
          B.line(`${hit} = trunc i8 ${rawOut} to i1`);
        }
        B.line(
          `store ptr ${host.unionNewOwned(valueTag, { name: hit, type: value })}, ptr ${slot}`,
        );
        B.br(lj);
        B.startBlock(la);
        B.line(`store ptr ${absent}, ptr ${slot}`);
        B.br(lj);
        B.startBlock(lj);
        const t = B.tmp();
        B.line(`${t} = load ptr, ptr ${slot}`);
        return host.own({ name: t, type: e.type });
      }
      host.declare(`declare ptr @scr_map_get_${kAcc}_ref(ptr, ${kTy})`);
      const raw = B.tmp();
      B.line(`${raw} = call ptr @scr_map_get_${kAcc}_ref(ptr ${r.name}, ${k.args})`);
      return host.wrapNullable(raw, raw, value, valueTag, e.type, undefTag);
    }
    case "set": {
      if (receiverType.kind !== "map") throw new InternalCompilerError("unreachable");
      // Key borrowed (the runtime retains stored string keys); the
      // value MOVES in (replacement releases the old value inside).
      const k = emitBorrowedInput(host, e.args[0]!);
      const v = host.emitExpr(e.args[1]!);
      const vAcc = elemAccess(receiverType.value);
      if (vAcc === "ref") host.moveTemp(v);
      host.mapSet(r.name, kAcc, vAcc, k.name, v.name);
      return { name: "", type: e.type };
    }
    case "add": {
      if (receiverType.kind !== "set") throw new InternalCompilerError("unreachable");
      // Element borrowed (the runtime retains stored strings); the unit
      // value is 0. Re-adding overwrites in place, preserving insertion.
      const k = emitBorrowedInput(host, e.args[0]!);
      host.mapSet(r.name, kAcc, "f64", k.name, f64Lit(0));
      return { name: "", type: e.type };
    }
    case "has": {
      const k = borrowInputs ? host.emitReadReceiver(e.args[0]!) : host.emitExpr(e.args[0]!);
      host.declare(`declare zeroext i1 @scr_map_has_${kAcc}(ptr, ${kTy})`);
      const t = B.tmp();
      B.line(`${t} = call zeroext i1 @scr_map_has_${kAcc}(ptr ${r.name}, ${kTy} ${k.name})`);
      return { name: t, type: e.type };
    }
    case "delete": {
      const k = emitBorrowedInput(host, e.args[0]!);
      host.declare(`declare zeroext i1 @scr_map_delete_${kAcc}(ptr, ${kTy})`);
      const t = B.tmp();
      B.line(`${t} = call zeroext i1 @scr_map_delete_${kAcc}(ptr ${r.name}, ${kTy} ${k.name})`);
      return { name: t, type: e.type };
    }
    case "size": {
      host.declare(`declare double @scr_map_size(ptr)`);
      const t = B.tmp();
      B.line(`${t} = call double @scr_map_size(ptr ${r.name})`);
      return { name: t, type: e.type };
    }
    case "clear":
      host.declare(`declare void @scr_map_clear(ptr)`);
      B.line(`call void @scr_map_clear(ptr ${r.name})`);
      return { name: "", type: e.type };
    case "iterCount": {
      host.declare(`declare double @scr_map_iter_count(ptr)`);
      const t = B.tmp();
      B.line(`${t} = call double @scr_map_iter_count(ptr ${r.name})`);
      return { name: t, type: e.type };
    }
    case "iterLive": {
      const i = host.emitExpr(e.args[0]!);
      host.declare(`declare zeroext i1 @scr_map_iter_live(ptr, double)`);
      const t = B.tmp();
      B.line(`${t} = call zeroext i1 @scr_map_iter_live(ptr ${r.name}, double ${i.name})`);
      return { name: t, type: e.type };
    }
    case "iterKey": {
      // String/ref keys come back +1 (own registers the owned temp).
      const i = host.emitExpr(e.args[0]!);
      const retTy = kAcc === "f64" ? "double" : kAcc === "bool" ? "zeroext i1" : "ptr";
      host.declare(`declare ${retTy} @scr_map_iter_key_${kAcc}(ptr, double)`);
      const t = B.tmp();
      B.line(`${t} = call ${retTy} @scr_map_iter_key_${kAcc}(ptr ${r.name}, double ${i.name})`);
      return host.own({ name: t, type: e.type });
    }
    case "iterValue": {
      if (receiverType.kind !== "map") throw new InternalCompilerError("unreachable");
      const vAcc = elemAccess(receiverType.value);
      const i = host.emitExpr(e.args[0]!);
      const retTy = vAcc === "f64" ? "double" : vAcc === "bool" ? "i1" : "ptr";
      host.declare(
        `declare ${vAcc === "bool" ? "zeroext i1" : retTy} @scr_map_iter_val_${vAcc}(ptr, double)`,
      );
      const t = B.tmp();
      B.line(`${t} = call ${retTy} @scr_map_iter_val_${vAcc}(ptr ${r.name}, double ${i.name})`);
      return host.own({ name: t, type: e.type });
    }
    case "iterEnter":
      host.declare(`declare void @scr_map_iter_enter(ptr)`);
      B.line(`call void @scr_map_iter_enter(ptr ${r.name})`);
      return { name: "", type: e.type };
    case "iterExit":
      host.declare(`declare void @scr_map_iter_exit(ptr)`);
      B.line(`call void @scr_map_iter_exit(ptr ${r.name})`);
      return { name: "", type: e.type };
    case "toArray": {
      if (receiverType.kind !== "set") throw new InternalCompilerError("unreachable");
      // Fresh +1 elem[] of the live entries in insertion order.
      host.declare(`declare ptr @scr_set_to_arr_${kAcc}(ptr)`);
      const t = B.tmp();
      B.line(`${t} = call ptr @scr_set_to_arr_${kAcc}(ptr ${r.name})`);
      return host.own({ name: t, type: e.type });
    }
    default: {
      const _exhaustive: never = method;
      void _exhaustive;
      throw new InternalCompilerError("unreachable");
    }
  }
}

export function emitSetNew(host: LlvmEmitterContext, e: IrExpr & { kind: "setNew" }): LlValue {
  if (e.type.kind !== "set")
    throw new InternalCompilerError("llvm emitter bug: setNew of non-set type");
  const B = host.B;
  const s = newCollection(host, e.type.elem, { kind: "f64" });
  const out = host.own({ name: s, type: e.type });
  if (e.seed) {
    // Seeded construction (`new Set(values)`): one borrowed T[] whose
    // elements add() in order (duplicates keep first insertion position).
    const arr = host.emitExpr(e.seed);
    host.declare(`declare void @scr_set_add_all(ptr, ptr)`);
    B.line(`call void @scr_set_add_all(ptr ${s}, ptr ${arr.name})`);
  }
  return out;
}
