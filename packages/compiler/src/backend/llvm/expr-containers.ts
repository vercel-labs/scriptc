import { dynDesc } from "../../ir/analysis.js";
/* Focused LLVM expression emission extracted from emitter.ts. */
import { arraySearchHelperName, arraySearchKind } from "./array-search.js";
import { InternalCompilerError } from "../../errors.js";
import { isStableReceiverOperand, undefinedArmTag } from "../../ir/analysis.js";
import { F64, type IrExpr, type IrType, isRefCounted, typeEquals, typeKey } from "../../ir/ir.js";
import {
  arrOps,
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
import { F64_INF, f64Lit, loadArrCount, sizeToDouble } from "./common.js";
import { MUTATING_COLLECTION_METHODS } from "../publication.js";
import { borrowsStringInputs, emitStringInputs } from "./string-lifetimes.js";
import {
  emitMapLookupKey,
  borrowsMapReadInputs,
  borrowsMapMutationReceiver,
  inlineNumberKey,
  entryStringKey,
} from "./map-read-lifetimes.js";
import {
  emitMapIterCount,
  emitMapIterEntry,
  emitMapIterSlot,
  compactMapValues,
  mapEntryLayout,
  emitMapIterStart,
  emitMapSize,
  emitNumberMapGetRef,
  emitNumberMapGetScalar,
  emitNumberMapHas,
  emitNumberMapSetScalar,
  emitStringMapGetRef,
  emitStringMapGetScalar,
  emitStringMapHas,
  noteNumberMapKey,
} from "./map-number-lookup.js";
import { emitBorrowedInput } from "./borrowed-inputs.js";
import { emitFusedMapSet, rememberMapEntry } from "./map-entry-fusion.js";
import { emitScratchStringSlice, emitStringSliceRead } from "./string-slices.js";
import {
  STRING_CHAR_AT_DECL,
  STRING_CP_AT_BYTE_DECL,
  STRING_CHAR_AT_INT_MARKER,
  STRING_CHAR_CODE_AT_DECL,
  STRING_CHAR_CODE_AT_INT_MARKER,
  emitAsciiChar,
  emitAsciiCharCode,
  emitStringByteLength,
  emitUnitCharCode,
  STRING_UTF16_LEN_DECL,
} from "./string-reads.js";
import { exactInteger, widenInteger } from "./integer-values.js";
import {
  emitDenseArrayNumber,
  emitDenseArrayNumberInt32,
  emitDenseArrayPop,
  emitDenseArrayPush,
  runtimeAccess,
  type ArrayAccess,
} from "./dense-array-access.js";
import { INT32_ARRAY_METHODS } from "../../ir/int32-arrays.js";
import { INT32_RANGE } from "../../ir/integer-ranges.js";
import { emitUnionWiden } from "./expr-records.js";
import { registerReplay } from "./emit-journal.js";

export function resolveThunkFor(host: LlvmEmitterContext, inner: IrType): string {
  const key = typeKey(inner);
  let sym = host.resolveThunks.get(key);
  if (!sym) {
    sym = host.contentSymbol("sc_rslv_", key);
    host.resolveThunks.set(key, sym);
    host.journal?.allocated(sym, "resolveThunkFor", [inner]);
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
    host.journal?.built();
  }
  return sym;
}

export function tagInSet(
  host: LlvmEmitterContext,
  uName: string,
  unionId: string,
  tags: number[],
): string {
  const B = host.B;
  const tag = host.unionTag(uName, unionId);
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

/** `element`: the array's element type, or null for arrays whose
 * elements are not compact class references (dense-array-access.ts
 * slotKind). */
export function arrPush(
  host: LlvmEmitterContext,
  arr: string,
  acc: ArrayAccess,
  value: string,
  element: IrType | null,
): string {
  return emitDenseArrayPush(host, arr, acc, element, value);
}

/** Move evaluated values through one bounded slot buffer per call site. */
export function emitArrayValues(
  host: LlvmEmitterContext,
  arr: string,
  acc: ArrayAccess,
  element: IrType,
  values: LlValue[],
  prepend = false,
  sharedBuffer?: string,
): string {
  const B = host.B;
  if (acc === "ref") values.forEach((value) => host.toHeap(value));
  if (values.length === 0) {
    host.declare("declare double @scr_arr_len(ptr)");
    const result = B.tmp();
    B.line(`${result} = call double @scr_arr_len(ptr ${arr})`);
    return result;
  }
  if (values.length === 1) {
    if (!prepend) return arrPush(host, arr, acc, values[0]!.name, element);
    const flat = runtimeAccess(acc);
    const ty = flat === "f64" ? "double" : flat === "bool" ? "i1" : "ptr";
    host.declare(
      `declare double @scr_arr_unshift_${flat}(ptr, ${ty}${flat === "bool" ? " zeroext" : ""})`,
    );
    const result = B.tmp();
    B.line(
      `${result} = call double @scr_arr_unshift_${flat}(ptr ${arr}, ${ty} ${values[0]!.name})`,
    );
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
      // The runtime takes double bits for int32 arrays too, and converts.
      const pack =
        acc === "f64" || acc === "i32"
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

/** A splice whose removed-elements array is discarded (statement position)
 * and whose insertion items, if any, are plain evaluated values: evaluate
 * the receiver, start, count, and items in order, then splice the values in
 * without a result or argument array. Returns false for every other shape,
 * which keeps the ordinary intrinsic. */
export function emitDiscardedSplice(host: LlvmEmitterContext, e: IrExpr): boolean {
  if (!discardsSplice(e)) return false;
  emitDiscarded(host, e);
  return true;
}

/** The plain-value items of a splice that can drop its result, or null. */
function droppableSpliceItems(e: IrExpr): IrExpr[] | null {
  if (e.kind !== "arrIntrinsic" || e.receiver.type.kind !== "array") return null;
  if (e.method === "splice") return [];
  if (e.method !== "spliceInsert") return null;
  const list = e.args[2];
  if (list?.kind !== "arrayLit" || (list.spreads?.length ?? 0) > 0) return null;
  return list.elems.length <= 64 ? list.elems : null;
}

/** A droppable splice, possibly behind statements or one arm of a
 * conditional (the runtime-optional item lowering). */
function discardsSplice(e: IrExpr): boolean {
  if (e.kind === "seqExpr") return discardsSplice(e.result);
  if (e.kind === "ternary") return discardsSplice(e.then) || discardsSplice(e.else_);
  return droppableSpliceItems(e) !== null;
}

/** Emit an expression whose value is unused. Ternary arms keep their own
 * frames, exactly like an evaluated conditional. */
function emitDiscarded(host: LlvmEmitterContext, e: IrExpr): void {
  const B = host.B;
  if (e.kind === "seqExpr") {
    for (const s of e.stmts) host.emitStmt(s);
    emitDiscarded(host, e.result);
    return;
  }
  if (e.kind === "ternary") {
    const c = host.emitExpr(e.cond);
    const lt = B.newLabel("drop.t"),
      lf = B.newLabel("drop.f"),
      lj = B.newLabel("drop.j");
    B.condBr(c.name, lt, lf);
    for (const [label, arm] of [
      [lt, e.then],
      [lf, e.else_],
    ] as const) {
      B.startBlock(label);
      host.frames.push([]);
      emitDiscarded(host, arm);
      host.releaseTemps(host.frames.pop()!);
      B.br(lj);
    }
    B.startBlock(lj);
    return;
  }
  const items = droppableSpliceItems(e);
  if (items === null || e.kind !== "arrIntrinsic" || e.receiver.type.kind !== "array") {
    host.emitExpr(e);
    return;
  }
  const r = emitBorrowedInput(host, e.receiver);
  const acc = elemAccess(e.receiver.type.elem);
  const start = host.emitExpr(e.args[0]!);
  const count = e.args[1] ? host.emitExpr(e.args[1]).name : F64_INF;
  const values = items.map((item) => host.emitExpr(item));
  // Before the values move into the buffer: a throw releases them with the
  // frame.
  host.emitPublishedArrayGuard(
    r.name,
    e.receiver.type,
    10,
    start.name,
    count,
    f64Lit(values.length),
  );
  if (acc === "ref") values.forEach((value) => host.toHeap(value));
  let buffer = "null";
  if (values.length > 0) {
    buffer = B.tmp();
    B.entryAllocas.push(`${buffer} = alloca [${values.length} x i64]`);
    values.forEach((value, i) => {
      const slot = B.tmp(),
        pointer = B.tmp();
      const pack =
        acc === "f64"
          ? `bitcast double ${value.name} to i64`
          : acc === "bool"
            ? `zext i1 ${value.name} to i64`
            : `ptrtoint ptr ${value.name} to i64`;
      B.line(`${slot} = ${pack}`);
      B.line(`${pointer} = getelementptr inbounds i64, ptr ${buffer}, ${host.sizeType} ${i}`);
      B.line(`store i64 ${slot}, ptr ${pointer}`);
    });
  }
  host.declare(`declare void @scr_arr_splice_drop(ptr, double, double, ${host.sizeType}, ptr)`);
  B.line(
    `call void @scr_arr_splice_drop(ptr ${r.name}, double ${start.name}, double ${count}, ${host.sizeType} ${values.length}, ptr ${buffer})`,
  );
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

/** `s.charCodeAt(i)` in place of `s.charAt(i)`, the same index read as a
 * code unit. The emitter records the charAt it stands for
 * (charAtUnitReads), so a loop version's proof for the charAt covers it. */
export function charAtUnitRead(
  host: LlvmEmitterContext,
  charAt: IrExpr & { kind: "strIntrinsic" },
): IrExpr & { kind: "strIntrinsic" } {
  const read: IrExpr & { kind: "strIntrinsic" } = {
    kind: "strIntrinsic",
    method: "charCodeAt",
    receiver: charAt.receiver,
    args: charAt.args,
    type: F64,
    loc: charAt.loc,
  };
  host.charAtUnitReads.set(read, charAt);
  return read;
}

/** The UTF-16 units an enclosing loop version proved the index of `e`
 * below the count of (string-unit-versions.ts). */
function provenUnitsRead(host: LlvmEmitterContext, e: IrExpr): string | null {
  const units = host.stringUnitReads.get(e);
  if (units !== undefined) return units;
  const origin = host.charAtUnitReads.get(e);
  return origin !== undefined ? (host.stringUnitReads.get(origin) ?? null) : null;
}

/** An enclosing loop version proved the string of `e` ASCII and its index
 * below the length (bytes-loop-versions.ts). */
function provenStringRead(host: LlvmEmitterContext, e: IrExpr): boolean {
  if (host.bytesBounds.has(e)) return true;
  const origin = host.charAtUnitReads.get(e);
  return origin !== undefined && host.bytesBounds.has(origin);
}

export function emitStrIntrinsic(
  host: LlvmEmitterContext,
  e: IrExpr & { kind: "strIntrinsic" },
): LlValue {
  // String/array-returning methods hand back a +1 reference, including
  // identity returns. Inputs keep either a proven owner or a frame temp.
  // Omitted optional args get the C-side defaults from docs/ir.md.
  const B = host.B;
  const slice = emitStringSliceRead(host, e);
  if (slice) return slice;
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
    case "length": {
      const t = B.tmp();
      const length = host.stringLengthReads.get(e);
      if (length !== undefined) {
        B.line(`${t} = sitofp i64 ${length} to double`);
        return { name: t, type: e.type };
      }
      // sc_str_utf16_len (string-reads.ts) answers proven-ASCII strings inline.
      host.declare(STRING_UTF16_LEN_DECL);
      B.line(`${t} = call double @sc_str_utf16_len(ptr ${r.name})`);
      return { name: t, type: e.type };
    }
    case "charCodeAt": {
      host.declare(STRING_CHAR_CODE_AT_DECL);
      const t = B.tmp();
      const index = e.args[0] ? exactInteger(host, args[0]!, e.args[0]) : null;
      if (index) {
        const wide = widenInteger(host, index);
        const units = provenUnitsRead(host, e);
        if (units !== null) return { name: emitUnitCharCode(host, units, wide), type: e.type };
        if (provenStringRead(host, e))
          return { name: emitAsciiCharCode(host, r.name, wide), type: e.type };
        host.declare(STRING_CHAR_CODE_AT_INT_MARKER);
        B.line(`${t} = call double @sc_str_char_code_at_int(ptr ${r.name}, i64 ${wide})`);
        return { name: t, type: e.type };
      }
      B.line(`${t} = call double @sc_str_char_code_at(ptr ${r.name}, double ${args[0]!.name})`);
      return { name: t, type: e.type };
    }
    case "charAt": {
      // sc_str_char_at (string-reads.ts) answers proven-ASCII strings inline.
      host.declare(STRING_CHAR_AT_DECL);
      const t = B.tmp();
      const index = e.args[0] ? exactInteger(host, args[0]!, e.args[0]) : null;
      if (index) {
        const wide = widenInteger(host, index);
        // The table entry is immortal: nothing owns it.
        if (provenStringRead(host, e))
          return host.markImmortal({ name: emitAsciiChar(host, r.name, wide), type: e.type });
        host.declare(STRING_CHAR_AT_INT_MARKER);
        B.line(`${t} = call ptr @sc_str_char_at_int(ptr ${r.name}, i64 ${wide})`);
      } else {
        const at = args[0]?.name ?? f64Lit(0);
        B.line(`${t} = call ptr @sc_str_char_at(ptr ${r.name}, double ${at})`);
      }
      return host.own({ name: t, type: e.type });
    }
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
      if (host.scratchStringSlices.has(e)) return emitScratchStringSlice(host, e, r, args);
      return call(
        "scr_str_slice",
        "ptr (ptr, double, double)",
        `ptr ${r.name}, double ${args[0]?.name ?? f64Lit(0)}, double ${args[1]?.name ?? F64_INF}`,
        "ptr",
        true,
      );
    case "substring":
      if (host.scratchStringSlices.has(e)) return emitScratchStringSlice(host, e, r, args);
      return call(
        "scr_str_substring",
        "ptr (ptr, double, double)",
        `ptr ${r.name}, double ${args[0]!.name}, double ${args[1]?.name ?? F64_INF}`,
        "ptr",
        true,
      );
    case "repeat": {
      // A negative or infinite count throws Node's catchable RangeError.
      const result = call(
        "scr_str_repeat",
        "ptr (ptr, double)",
        `ptr ${r.name}, double ${args[0]!.name}`,
        "ptr",
        true,
      );
      host.emitPendingCheck();
      return result;
    }
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
    // The well-formedness pair: whether the receiver holds a lone
    // surrogate, and its U+FFFD replacement (scr_string.c).
    case "isWellFormed":
      return call("scr_str_is_well_formed", "zeroext i1 (ptr)", `ptr ${r.name}`, "i1", false);
    case "toWellFormed":
      return call("scr_str_to_well_formed", "ptr (ptr)", `ptr ${r.name}`, "ptr", true);
    case "byteLength": {
      const t = B.tmp();
      // A byte count fits in a signed size, whose conversion is one instruction.
      B.line(`${t} = sitofp ${host.sizeType} ${emitStringByteLength(host, r.name)} to double`);
      return { name: t, type: e.type };
    }
    case "cpAtByte": {
      // sc_str_cp_at_byte (string-reads.ts) answers ASCII bytes from the
      // charAt table inline. The cursor is a character start, an exact
      // integer below the byte count.
      host.declare(STRING_CHAR_AT_DECL);
      host.declare(STRING_CP_AT_BYTE_DECL);
      const index = e.args[0] ? exactInteger(host, args[0]!, e.args[0]) : null;
      let wide: string;
      if (index) {
        wide = widenInteger(host, index);
      } else {
        wide = B.tmp();
        B.line(`${wide} = fptosi double ${args[0]!.name} to i64`);
      }
      const t = B.tmp();
      B.line(`${t} = call ptr @sc_str_cp_at_byte(ptr ${r.name}, i64 ${wide})`);
      return host.own({ name: t, type: e.type });
    }
    default: {
      const _exhaustive: never = method;
      void _exhaustive;
      throw new InternalCompilerError("unreachable");
    }
  }
}

/** The `i32 order, ptr key` arguments of the runtime comparator sorts:
 * 0 and null unless the comparator orders by a number key. */
function emitSortKeyArgs(
  host: LlvmEmitterContext,
  order: IrExpr | undefined,
  key: IrExpr | undefined,
): string {
  const direction = order?.kind === "numLit" ? order.value : 0;
  const reader = key ? emitBorrowedInput(host, key).name : "null";
  return `i32 ${direction}, ptr ${reader}`;
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
      host.B.line(`${value} = load ptr, ptr ${b.slot}${host.slotAlias(receiver.localId)}`);
      return { name: value, type: receiver.type };
    }
  }
  return host.emitExpr(receiver);
}

export function emitArrIntrinsic(
  host: LlvmEmitterContext,
  e: IrExpr & { kind: "arrIntrinsic" },
  /** A `pop`/`shift` of number or boolean elements stores its scalar
   * union result's tag and payload bits here instead of boxing it. */
  into?: { box: string; tag: string; payload: string },
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
  // Int32 arrays (ir/int32-arrays.ts) reach only these methods; the others
  // take the runtime family's flat access. One with checked stores tests
  // its kind at each inline access (emitByElementKind) and otherwise takes
  // the double entry points, which serve both kinds.
  const checked = host.checkedInt32Array(e.receiver);
  const access = checked ? "f64" : host.arrayAccess(e.receiver, elem);
  if ((access === "i32" || checked) && !INT32_ARRAY_METHODS.has(e.method))
    throw new InternalCompilerError(`llvm emitter bug: ${e.method} on an int32 array`);
  const acc = runtimeAccess(access);
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
      loadArrCount(host, len, p, host.fieldAliasAttachment(p));
      B.line(`${t} = ${sizeToDouble(host.sizeType)} ${host.sizeType} ${len} to double`);
      return { name: t, type: e.type };
    }
    case "getNumber": {
      const index = host.emitExpr(e.args[0]!);
      const table =
        e.receiver.kind === "varRef"
          ? host.constantNumericTables.get(e.receiver.localId)
          : undefined;
      if (!table && elem.kind === "f64" && checked) {
        const proven = host.provenDenseIndex(e.receiver, e.args[0]!);
        const value = host.emitByElementKind(r.name, "double", (kind) =>
          emitDenseArrayNumber(host, r.name, index, e.args[0], proven, kind),
        )!;
        return { name: value, type: e.type };
      }
      // In a store statement of an int32 kind loop's fast copy, a read that
      // is not an int32 (a missing element's NaN) leaves for the
      // statement's resume point, so the element is at hand as an i32.
      if (!table && elem.kind === "f64" && access === "i32" && host.int32KindResume !== null) {
        const read = emitDenseArrayNumberInt32(
          host,
          r.name,
          index,
          e.args[0],
          host.provenDenseIndex(e.receiver, e.args[0]!),
          host.int32KindResume,
        );
        return {
          name: read.value,
          type: e.type,
          uint32: read.int32,
          integer: { name: read.int32, type: "i32", signed: true, range: INT32_RANGE },
        };
      }
      if (!table && elem.kind === "f64")
        return {
          name: emitDenseArrayNumber(
            host,
            r.name,
            index,
            e.args[0],
            host.provenDenseIndex(e.receiver, e.args[0]!),
            access === "i32" ? "i32" : "f64",
          ),
          type: e.type,
        };
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
      host.emitPublishedArrayGuard(r.name, e.receiver.type, 1, f64Lit(0), f64Lit(vs.length));
      if (checked && vs.length > 0) {
        // Each value appends in its own kind test: one that is not an int32
        // widens the array before it is pushed.
        let length = "";
        vs.forEach((v, i) => {
          length = host.emitByElementKind(r.name, "double", (kind, widened) => {
            if (kind === "i32") host.emitCheckedInt32Store(r.name, v.name, e.args[i]!, widened);
            return arrPush(host, r.name, kind, v.name, elem);
          })!;
        });
        return { name: length, type: e.type };
      }
      // In an int32 kind loop's fast copy, every value is checked before
      // the first appends.
      vs.forEach((v, i) => host.emitInt32KindStoreCheck(e.receiver, v, e.args[i]!));
      return { name: emitArrayValues(host, r.name, access, elem, vs), type: e.type };
    }
    case "pushSpread": {
      // `a.push(...src)`: append src's elements in order (borrowed src,
      // count snapshotted). Result: the new length.
      const src = emitBorrowedInput(host, e.args[0]!);
      if (host.publishedTypes?.containerGuarded(e.receiver.type) === true) {
        host.declare(`declare double @scr_arr_len(ptr)`);
        const n = B.tmp();
        B.line(`${n} = call double @scr_arr_len(ptr ${src.name})`);
        host.emitPublishedArrayGuard(r.name, e.receiver.type, 1, f64Lit(0), n);
      }
      host.emitArrayCopyLoop(r.name, src.name, acc);
      host.declare(`declare double @scr_arr_len(ptr)`);
      const t = B.tmp();
      B.line(`${t} = call double @scr_arr_len(ptr ${r.name})`);
      return { name: t, type: e.type };
    }
    case "concatSpread": {
      // Appends to concat's fresh result: its storage grows to exactly
      // the combined length (scr_arr_concat_copy_exact).
      const src = emitBorrowedInput(host, e.args[0]!);
      host.declare(`declare double @scr_arr_concat_copy_exact(ptr, ptr)`);
      const t = B.tmp();
      B.line(`${t} = call double @scr_arr_concat_copy_exact(ptr ${r.name}, ptr ${src.name})`);
      return { name: t, type: e.type };
    }
    case "unshift": {
      // Evaluate every argument before the first mutation, then insert
      // from right to left so the final front order is source order.
      const vs = e.args.map((a) => host.emitExpr(a));
      host.emitPublishedArrayGuard(r.name, e.receiver.type, 4, f64Lit(0), f64Lit(vs.length));
      return { name: emitArrayValues(host, r.name, acc, elem, vs, true), type: e.type };
    }
    case "unshiftSpread": {
      // The runtime snapshots the borrowed source and handles self-spread.
      const src = emitBorrowedInput(host, e.args[0]!);
      if (host.publishedTypes?.containerGuarded(e.receiver.type) === true) {
        host.declare(`declare double @scr_arr_len(ptr)`);
        const n = B.tmp();
        B.line(`${n} = call double @scr_arr_len(ptr ${src.name})`);
        host.emitPublishedArrayGuard(r.name, e.receiver.type, 4, f64Lit(0), n);
      }
      host.declare(`declare double @scr_arr_unshift_spread(ptr, ptr)`);
      const t = B.tmp();
      B.line(`${t} = call double @scr_arr_unshift_spread(ptr ${r.name}, ptr ${src.name})`);
      return { name: t, type: e.type };
    }
    case "pop":
    case "shift": {
      host.emitPublishedArrayGuard(r.name, e.receiver.type, method === "pop" ? 2 : 6);
      const checkedValue = elem.kind === "dyn" && e.type.kind === "dyn";
      // A foreign element (SCR_ARR_FOREIGN) cannot be the typed result:
      // removing one throws the checked conversion's TypeError.
      const foreignElements = !checkedValue && host.mayHoldForeign(elem);
      if (!checkedValue && e.type.kind !== "union")
        throw new InternalCompilerError("llvm emitter bug: array removal result is not a union");
      const def = e.type.kind === "union" ? host.unionsById.get(e.type.unionId) : undefined;
      const tag = def ? def.arms.findIndex((arm) => typeEquals(arm, elem)) : -1;
      const undefTag = undefinedArmTag(e.type, host.unionsById);
      const sameUnion = elem.kind === "union" && typeEquals(elem, e.type);
      if (!checkedValue && ((!sameUnion && tag < 0) || undefTag < 0))
        throw new InternalCompilerError("llvm emitter bug: array removal union lacks its arms");
      host.declare(`declare zeroext i8 @scr_arr_${method}_state(ptr, ptr)`);
      const rawSlot = B.slot();
      const resultSlot = B.slot();
      B.entryAllocas.push(`${rawSlot} = alloca i64`, `${resultSlot} = alloca ptr`);
      const lp = B.newLabel("remove.p");
      const la = B.newLabel("remove.a");
      const lj = B.newLabel("remove.j");
      // pop answers an empty or packed array inline; shift and every other
      // pop take the runtime call.
      let denseRaw: string | null = null;
      let denseLabel = "";
      let slowLabel = "";
      if (method === "pop") {
        slowLabel = B.newLabel("remove.slow");
        const empty = la,
          slow = slowLabel;
        denseRaw = checked
          ? host.emitByElementKind(r.name, "i64", (kind) =>
              emitDenseArrayPop(host, r.name, kind, elem, empty, slow),
            )!
          : emitDenseArrayPop(host, r.name, access, elem, la, slowLabel);
        denseLabel = B.currentLabel();
        B.br(lp);
        B.startBlock(slowLabel);
      }
      B.line(`store i64 0, ptr ${rawSlot}`);
      const state = B.tmp();
      const has = B.tmp();
      const slowRaw = B.tmp();
      B.line(
        `${state} = call zeroext i8 @scr_arr_${method}_state(ptr ${r.name}, ptr ${rawSlot})${denseRaw === null ? "" : " cold"}`,
      );
      B.line(`${slowRaw} = load i64, ptr ${rawSlot}`);
      B.line(`${has} = icmp eq i8 ${state}, 1`);
      const lf = foreignElements ? B.newLabel("remove.f") : la;
      B.condBr(has, lp, lf);
      if (foreignElements) {
        // Only the runtime call removes a foreign element; its value moves
        // out with the slot, and the throw releases it.
        B.startBlock(lf);
        const foreign = B.tmp();
        const throwLabel = B.newLabel("remove.foreign");
        B.line(`${foreign} = icmp eq i8 ${state}, 3`);
        B.condBr(foreign, throwLabel, la);
        B.startBlock(throwLabel);
        const payload = B.tmp();
        B.line(`${payload} = inttoptr i64 ${slowRaw} to ptr`);
        host.declare(`declare void @scr_dyn_foreign_throw(ptr, ptr)`);
        const want = host.cstr(dynDesc(e.type, host.recordsById, host.unionsById));
        B.line(`call void @scr_dyn_foreign_throw(ptr ${payload}, ptr ${want})`);
        host.emitAlwaysPendingUnwind();
        B.br(la);
      }
      B.startBlock(lp);
      let raw = slowRaw;
      const value = B.tmp();
      if (denseRaw !== null) {
        raw = B.tmp();
        B.line(`${raw} = phi i64 [ ${denseRaw}, %${denseLabel} ], [ ${slowRaw}, %${slowLabel} ]`);
      }
      if (into) {
        // Slot bits for f64; a canonical 0/1 for bool, like scr_union_new_bool.
        let bits = raw;
        if (elem.kind === "bool") {
          const nonzero = B.tmp();
          bits = B.tmp();
          B.line(`${nonzero} = icmp ne i64 ${raw}, 0`);
          B.line(`${bits} = zext i1 ${nonzero} to i64`);
        }
        B.line(`store i32 ${tag}, ptr ${into.tag}`);
        B.line(`store i64 ${bits}, ptr ${into.payload}`);
        B.br(lj);
        B.startBlock(la);
        B.line(`store i32 ${undefTag}, ptr ${into.tag}`);
        B.line(`store i64 0, ptr ${into.payload}`);
        B.br(lj);
        B.startBlock(lj);
        return { name: into.box, type: e.type };
      }
      if (elem.kind === "f64") B.line(`${value} = bitcast i64 ${raw} to double`);
      else if (elem.kind === "bool") B.line(`${value} = icmp ne i64 ${raw}, 0`);
      else B.line(`${value} = inttoptr i64 ${raw} to ptr`);
      B.line(
        `store ptr ${checkedValue || sameUnion || e.type.kind !== "union" ? value : host.unionNewOwned(e.type.unionId, tag, { name: value, type: elem })}, ptr ${resultSlot}`,
      );
      B.br(lj);
      B.startBlock(la);
      if (checkedValue) {
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
      // by content, everything else by pointer). Strict equality. Arrays of
      // objects and strings scan inline (array-search.ts).
      const v = host.emitExpr(e.args[0]!);
      const search = acc === "ref" ? arraySearchKind(elem, host.compactArrayElem(elem)) : null;
      if (search !== null) {
        host.arraySearchKinds.add(search);
        const t = B.tmp();
        B.line(
          `${t} = call double @${arraySearchHelperName(search)}(ptr ${r.name}, ptr ${v.name})`,
        );
        return { name: t, type: e.type };
      }
      host.declare(`declare double @scr_arr_index_of_${acc}(ptr, ${accArg})`);
      const t = B.tmp();
      B.line(`${t} = call double @scr_arr_index_of_${acc}(ptr ${r.name}, ${accTy} ${v.name})`);
      return { name: t, type: e.type };
    }
    case "includes": {
      // Borrowed needle, SameValueZero (NaN matches NaN). For the inline
      // searches SameValueZero is strict equality.
      const v = host.emitExpr(e.args[0]!);
      const search = acc === "ref" ? arraySearchKind(elem, host.compactArrayElem(elem)) : null;
      if (search !== null) {
        host.arraySearchKinds.add(search);
        const at = B.tmp(),
          t = B.tmp();
        B.line(
          `${at} = call double @${arraySearchHelperName(search)}(ptr ${r.name}, ptr ${v.name})`,
        );
        B.line(`${t} = fcmp oge double ${at}, 0.0`);
        return { name: t, type: e.type };
      }
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
      if (elem.kind === "date") {
        host.declare(`declare ptr @scr_date_arr_join(ptr, ptr)`);
        const t = B.tmp();
        B.line(`${t} = call ptr @scr_date_arr_join(ptr ${r.name}, ptr ${sep.name})`);
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
    case "sortPrimitive":
    case "toSortedPrimitive": {
      if (e.method === "sortPrimitive") host.emitPublishedArrayGuard(r.name, e.receiver.type, 7);
      if (elem.kind === "date") {
        // Dates order by their toString() text.
        host.declare(`declare ptr @scr_arr_sort_by_text(ptr, i1 zeroext, ptr)`);
        host.declare(`declare ptr @scr_date_object_to_string(ptr)`);
        const sorted = B.tmp();
        B.line(
          `${sorted} = call ptr @scr_arr_sort_by_text(ptr ${r.name}, i1 ${e.method === "toSortedPrimitive" ? 1 : 0}, ptr @scr_date_object_to_string)`,
        );
        return host.own({ name: sorted, type: e.type });
      }
      host.declare(`declare ptr @scr_arr_sort_primitive(ptr, i1 zeroext)`);
      const result = B.tmp();
      B.line(
        `${result} = call ptr @scr_arr_sort_primitive(ptr ${r.name}, i1 ${e.method === "toSortedPrimitive" ? 1 : 0})`,
      );
      return host.own({ name: result, type: e.type });
    }
    case "sortValues": {
      // The runtime invokes the borrowed comparator with the callValue ABI
      // and stops at the first pending exception.
      const count = host.emitExpr(e.args[0]!);
      const comparator = emitBorrowedInput(host, e.args[1]!);
      const cmp = e.args[1]!.type;
      const arity = cmp.kind === "func" ? cmp.params.length : 0;
      const keyed = emitSortKeyArgs(host, e.args[2], e.args[3]);
      host.declare(`declare void @scr_arr_sort_values(ptr, double, ptr, i32, i32, ptr)`);
      B.line(
        `call void @scr_arr_sort_values(ptr ${r.name}, double ${count.name}, ptr ${comparator.name}, i32 ${arity}, ${keyed})`,
      );
      host.emitPendingCheck();
      return { name: "", type: e.type };
    }
    case "sortDense": {
      // Answers false, without calling the comparator, when the receiver
      // needs the compacting snapshot path.
      const comparator = emitBorrowedInput(host, e.args[0]!);
      const owned = e.args[1]!.kind === "boolLit" && e.args[1]!.value;
      const cmp = e.args[0]!.type;
      const arity = cmp.kind === "func" ? cmp.params.length : 0;
      const keyed = emitSortKeyArgs(host, e.args[2], e.args[3]);
      host.declare(`declare zeroext i1 @scr_arr_sort_dense(ptr, ptr, i32, i1 zeroext, i32, ptr)`);
      const handled = B.tmp();
      B.line(
        `${handled} = call zeroext i1 @scr_arr_sort_dense(ptr ${r.name}, ptr ${comparator.name}, i32 ${arity}, i1 ${owned ? 1 : 0}, ${keyed})`,
      );
      host.emitPendingCheck();
      return { name: handled, type: e.type };
    }
    case "reverse": {
      // Mutates in place and returns the same receiver as a fresh +1.
      host.emitPublishedArrayGuard(r.name, e.receiver.type, 7);
      host.declare(`declare ptr @scr_arr_reverse(ptr)`);
      const t = B.tmp();
      B.line(`${t} = call ptr @scr_arr_reverse(ptr ${r.name})`);
      return host.own({ name: t, type: e.type });
    }
    case "copyWithin":
    case "fill":
    case "fillUndefined": {
      const args = e.args.map((arg) => host.emitExpr(arg));
      // fill's range is its last two arguments; copyWithin's target,
      // start and end are its three.
      if (e.method === "copyWithin")
        host.emitPublishedArrayGuard(
          r.name,
          e.receiver.type,
          9,
          args[0]!.name,
          args[1]!.name,
          args[2]!.name,
        );
      else
        host.emitPublishedArrayGuard(
          r.name,
          e.receiver.type,
          8,
          args[args.length - 2]!.name,
          args[args.length - 1]!.name,
        );
      if (host.checkedFills.has(e)) {
        // A new int32 array with checked stores, filled with a value that
        // may not be an int32: widen it first then.
        const filled = B.newLabel("arr.fill.kind");
        host.emitCheckedInt32Store(r.name, args[0]!.name, e.args[0]!, filled);
        B.br(filled);
        B.startBlock(filled);
      }
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
      host.emitPublishedArrayGuard(r.name, e.receiver.type, 10, start.name, cnt, f64Lit(0));
      host.declare(`declare ptr @scr_arr_splice(ptr, double, double)`);
      const t = B.tmp();
      B.line(`${t} = call ptr @scr_arr_splice(ptr ${r.name}, double ${start.name}, double ${cnt})`);
      return host.own({ name: t, type: e.type });
    }
    case "spliceInsert": {
      const start = host.emitExpr(e.args[0]!);
      const count = host.emitExpr(e.args[1]!);
      const items = emitBorrowedInput(host, e.args[2]!);
      if (host.publishedTypes?.containerGuarded(e.receiver.type) === true) {
        host.declare(`declare double @scr_arr_len(ptr)`);
        const n = B.tmp();
        B.line(`${n} = call double @scr_arr_len(ptr ${items.name})`);
        host.emitPublishedArrayGuard(r.name, e.receiver.type, 10, start.name, count.name, n);
      }
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

/** Whether `e` is a Map.get that emitBorrowedMapGet can emit without a
 * retain: a typed map with number or inline string keys, a reference value,
 * and a nullable result (the value's pointer, or the absent arm's). */
export function borrowableMapGet(host: LlvmEmitterContext, e: IrExpr): boolean {
  if (e.kind !== "mapIntrinsic" || e.method !== "get" || e.args.length !== 1) return false;
  if (!borrowsMapReadInputs(e) || e.receiver.type.kind !== "map") return false;
  const { key, value } = e.receiver.type;
  if (!isRefCounted(value) || value.kind === "union" || key.kind === "union") return false;
  if (e.type.kind !== "union" || !host.nullableUnions.has(e.type.unionId)) return false;
  const arg = e.args[0]!;
  const access = mapKeyAccess(key);
  return (
    (access === "f64" && arg.type.kind === "f64") ||
    (access === "str" && arg.type.kind === "string")
  );
}

/** A borrowableMapGet read as the entry's own reference: no retain, and
 * no owner. The caller proves that nothing can change the map while the
 * value is used (findMapReadBorrows). Null, before emitting anything, for
 * a key held as a split span, which takes the runtime's owned lookup. */
export function emitBorrowedMapGet(
  host: LlvmEmitterContext,
  e: IrExpr & { kind: "mapIntrinsic" },
): LlValue | null {
  const arg = e.args[0]!;
  if (arg.kind === "varRef" && host.splitSpans.get(arg.localId) !== undefined) return null;
  const B = host.B;
  const mapType = e.receiver.type as IrType & { kind: "map" };
  const r = host.emitStableReceiver(e.receiver, e.args);
  const k = emitMapLookupKey(host, e.args[0]!, true);
  const numberKey = inlineNumberKey(k);
  const stringKey = entryStringKey(k);
  const value = mapType.value;
  let raw: string;
  if (numberKey !== null) raw = emitNumberMapGetRef(host, r.name, numberKey, value, true);
  else if (stringKey !== null)
    raw = emitStringMapGetRef(
      host,
      r.name,
      stringKey,
      value,
      compactMapValues(host, mapType.key, value),
      true,
    );
  else throw new InternalCompilerError("llvm emitter bug: borrowed Map.get without an inline key");
  const resultType = e.type as IrType & { kind: "union" };
  const absent = host.unitInstanceRef(
    resultType.unionId,
    undefinedArmTag(resultType, host.unionsById),
  );
  if (absent === "null") return { name: raw, type: e.type };
  const isnull = B.tmp(),
    t = B.tmp();
  B.line(`${isnull} = icmp eq ptr ${raw}, null`);
  B.line(`${t} = select i1 ${isnull}, ptr ${absent}, ptr ${raw}`);
  return { name: t, type: e.type };
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
  if (host.nullableUnions.has(resultType.unionId)) {
    // A nullable union is its present payload, or the absent arm's encoding.
    const absent = host.unitInstanceRef(resultType.unionId, absentTag);
    if (raw === present && absent === "null") return host.own({ name: present, type: resultType });
    const isnull = B.tmp(),
      t = B.tmp();
    B.line(`${isnull} = icmp eq ptr ${raw}, null`);
    B.line(`${t} = select i1 ${isnull}, ptr ${absent}, ptr ${present}`);
    return host.own({ name: t, type: resultType });
  }
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
    `store ptr ${host.unionNewOwned(resultType.unionId, valueTag, { name: present, type: valueType })}, ptr ${slot}`,
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

/** The ScrMapOps descriptor of a Map or Set with these key and value
 * types: the reference adapters of each side and, for a union of value
 * arms, the key kind of every arm (immutable module data); all-reference
 * unions keep their existing identity-only representation. */
function collectionOps(host: LlvmEmitterContext, key: IrType, value: IrType): string {
  const rc = isRefCounted(value)
    ? vAdapters(host.shapeHost, value)
    : { retain: "null", release: "null" };
  const keyRc =
    mapKeyAccess(key) === "ref"
      ? { ...vAdapters(host.shapeHost, key), trace: traceArg(host.shapeHost, key) }
      : { retain: "null", release: "null", trace: "null" };
  const arms = key.kind === "union" ? host.unionsById.get(key.unionId)?.arms : undefined;
  let unionKeys = "null";
  if (mapKeyKindNum(key, arms) === 7) {
    if (!arms) throw new InternalCompilerError("llvm emitter bug: collection key union missing");
    unionKeys = host.cstr(arms.map((arm) => String.fromCharCode(mapKeyKindNum(arm))).join(""));
  }
  return host.shapeHost.mapOps([
    keyRc.retain,
    keyRc.release,
    keyRc.trace,
    rc.retain,
    rc.release,
    traceArg(host.shapeHost, value),
    unionKeys,
  ]);
}

/** Construct matching key/value storage once for Maps and Sets. */
function newCollection(host: LlvmEmitterContext, key: IrType, value: IrType): string {
  const B = host.B;
  const arms = key.kind === "union" ? host.unionsById.get(key.unionId)?.arms : undefined;
  // SCR_MAP_KEY_REF (2): shape-union keys are record pointers.
  const kind =
    key.kind === "union" && host.nullableUnions.shapes(key.unionId) ? 2 : mapKeyKindNum(key, arms);
  const m = B.tmp();
  host.declare(`declare ptr @scr_map_new(i32, i32, ptr)`);
  // SCR_MAP_VAL_CREF (3): string keys and compact values (compactMapValues).
  const valKind = compactMapValues(host, key, value) ? 3 : mapValKindNum(value);
  B.line(
    `${m} = call ptr @scr_map_new(i32 ${kind}, i32 ${valKind}, ptr ${collectionOps(host, key, value)})`,
  );
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
    if (vAcc === "ref") host.toHeap(v); // the value MOVES in
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
  // The map keeps compact values in 16-byte entries (SCR_MAP_VAL_CREF).
  const compact = receiverType.kind === "map" && compactMapValues(host, key, receiverType.value);
  const layout = mapEntryLayout(key, compact);
  const method = e.method;
  // A published Map or Set rejects mutation (the guard precedes the
  // operands, which each method evaluates itself).
  if (MUTATING_COLLECTION_METHODS.has(method))
    host.emitPublishedCollectionGuard(r.name, receiverType);
  if (method === "clone" || method === "keySet") {
    const keysOnly = method === "keySet" || receiverType.kind === "set";
    const checked =
      key.kind === "dyn" &&
      (keysOnly || (receiverType.kind === "map" && receiverType.value.kind === "dyn"));
    const result = B.tmp();
    if (checked) {
      host.declare(`declare ptr @scr_map_clone_dyn(ptr, i1 zeroext)`);
      B.line(`${result} = call ptr @scr_map_clone_dyn(ptr ${r.name}, i1 ${keysOnly})`);
    } else {
      // A Map's key Set drops the value adapters: it takes the descriptor
      // of a Set of the Map's keys.
      const ops = method === "keySet" ? collectionOps(host, key, { kind: "f64" }) : "null";
      host.declare(`declare ptr @scr_map_clone(ptr, i1 zeroext, ptr)`);
      B.line(`${result} = call ptr @scr_map_clone(ptr ${r.name}, i1 ${keysOnly}, ptr ${ops})`);
    }
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
      if (
        value.kind === "union" &&
        host.nullableUnions.has(value.unionId) &&
        !typeEquals(value, e.type)
      ) {
        // A nullable `C | null` value widens into `C | null | undefined`:
        // NULL is the stored null, so presence decides the undefined arm.
        host.declare(`declare zeroext i1 @scr_map_has_${kAcc}(ptr, ${kTy})`);
        host.declare(`declare ptr @scr_map_get_${kAcc}_ref(ptr, ${kTy})`);
        const has = B.tmp();
        B.line(`${has} = call zeroext i1 @scr_map_has_${kAcc}(ptr ${r.name}, ${k.args})`);
        const slot = B.slot();
        B.entryAllocas.push(`${slot} = alloca ptr`);
        const lp = B.newLabel("mgn.p");
        const la = B.newLabel("mgn.a");
        const lj = B.newLabel("mgn.j");
        B.condBr(has, lp, la);
        B.startBlock(lp);
        const raw = B.tmp();
        B.line(`${raw} = call ptr @scr_map_get_${kAcc}_ref(ptr ${r.name}, ${k.args})`);
        const widened = emitUnionWiden(host, raw, value.unionId, e.type.unionId, true);
        B.line(`store ptr ${widened}, ptr ${slot}`);
        B.br(lj);
        B.startBlock(la);
        B.line(`store ptr ${absent}, ptr ${slot}`);
        B.br(lj);
        B.startBlock(lj);
        const t = B.tmp();
        B.line(`${t} = load ptr, ptr ${slot}`);
        return host.own({ name: t, type: e.type });
      }
      const numberKey = inlineNumberKey(k);
      const stringKey = entryStringKey(k);
      if (value.kind === "union") {
        const isnull = B.tmp();
        const t = B.tmp();
        let raw: string;
        if (numberKey !== null) {
          raw = emitNumberMapGetRef(host, r.name, numberKey, value);
        } else if (stringKey !== null) {
          raw = emitStringMapGetRef(host, r.name, stringKey, value, compact);
        } else {
          host.declare(`declare ptr @scr_map_get_${kAcc}_ref(ptr, ${kTy})`);
          raw = B.tmp();
          B.line(`${raw} = call ptr @scr_map_get_${kAcc}_ref(ptr ${r.name}, ${k.args})`);
        }
        B.line(`${isnull} = icmp eq ptr ${raw}, null`);
        B.line(`${t} = select i1 ${isnull}, ptr ${absent}, ptr ${raw}`);
        return host.own({ name: t, type: e.type });
      }
      const valueTag = def.arms.findIndex((a) => typeEquals(a, value));
      if (valueTag < 0)
        throw new InternalCompilerError("llvm emitter bug: map get union lacks its value arm");
      if (value.kind === "f64" || value.kind === "bool") {
        const outTy = value.kind === "f64" ? "double" : "i8";
        let found: string;
        let readHit: () => string;
        if (numberKey !== null || stringKey !== null) {
          const scalar =
            numberKey !== null
              ? emitNumberMapGetScalar(host, r.name, numberKey)
              : emitStringMapGetScalar(host, r.name, stringKey!);
          found = scalar.found;
          if (stringKey !== null) rememberMapEntry(host, e, r.name, stringKey, scalar.entry);
          else rememberMapEntry(host, e, r.name, numberKey!, scalar.entry, "double");
          readHit = () => {
            const hit = B.tmp();
            B.line(
              value.kind === "f64"
                ? `${hit} = bitcast i64 ${scalar.bits} to double`
                : `${hit} = icmp ne i64 ${scalar.bits}, 0`,
            );
            return hit;
          };
        } else {
          const outSlot = B.slot();
          B.entryAllocas.push(`${outSlot} = alloca ${outTy}`);
          B.line(`store ${outTy} ${value.kind === "f64" ? f64Lit(0) : "0"}, ptr ${outSlot}`);
          host.declare(
            `declare zeroext i1 @scr_map_get_${kAcc}_${value.kind === "f64" ? "f64" : "bool"}(ptr, ${kTy}, ptr)`,
          );
          found = B.tmp();
          B.line(
            `${found} = call zeroext i1 @scr_map_get_${kAcc}_${value.kind === "f64" ? "f64" : "bool"}(ptr ${r.name}, ${k.args}, ptr ${outSlot})`,
          );
          readHit = () => {
            const rawOut = B.tmp();
            B.line(`${rawOut} = load ${outTy}, ptr ${outSlot}`);
            if (value.kind !== "bool") return rawOut;
            const hit = B.tmp();
            B.line(`${hit} = trunc i8 ${rawOut} to i1`);
            return hit;
          };
        }
        const slot = B.slot();
        B.entryAllocas.push(`${slot} = alloca ptr`);
        const lp = B.newLabel("mg.p");
        const la = B.newLabel("mg.a");
        const lj = B.newLabel("mg.j");
        B.condBr(found, lp, la);
        B.startBlock(lp);
        const hit = readHit();
        B.line(
          `store ptr ${host.unionNewOwned(e.type.unionId, valueTag, { name: hit, type: value })}, ptr ${slot}`,
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
      if (numberKey !== null && isRefCounted(value)) {
        const raw = emitNumberMapGetRef(host, r.name, numberKey, value);
        return host.wrapNullable(raw, raw, value, valueTag, e.type, undefTag);
      }
      if (stringKey !== null && isRefCounted(value)) {
        const raw = emitStringMapGetRef(host, r.name, stringKey, value, compact);
        return host.wrapNullable(raw, raw, value, valueTag, e.type, undefTag);
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
      if (kAcc === "f64") noteNumberMapKey(host, k, e.args[0]!);
      const v = host.emitExpr(e.args[1]!);
      const vAcc = elemAccess(receiverType.value);
      if (vAcc === "ref") host.toHeap(v);
      const ordinary = (): void => host.mapSet(r.name, kAcc, vAcc, k.name, v.name);
      if (
        (kAcc === "str" || kAcc === "f64") &&
        vAcc !== "ref" &&
        emitFusedMapSet(host, e, r.name, k.name, { name: v.name, access: vAcc }, ordinary)
      ) {
        // Written through the read's entry, or inserted.
      } else if (kAcc === "f64" && vAcc !== "ref" && host.readNumberMapWrites.has(e)) {
        const bits = B.tmp();
        B.line(
          vAcc === "f64"
            ? `${bits} = bitcast double ${v.name} to i64`
            : `${bits} = zext i1 ${v.name} to i64`,
        );
        emitNumberMapSetScalar(host, r.name, k.name, bits, ordinary);
      } else ordinary();
      return { name: "", type: e.type };
    }
    case "add": {
      if (receiverType.kind !== "set") throw new InternalCompilerError("unreachable");
      // Element borrowed (the runtime retains stored strings); the unit
      // value is 0. Re-adding overwrites in place, preserving insertion.
      const k = emitBorrowedInput(host, e.args[0]!);
      if (kAcc === "f64") noteNumberMapKey(host, k, e.args[0]!);
      if (kAcc === "f64" && host.readNumberMapWrites.has(e))
        emitNumberMapSetScalar(host, r.name, k.name, null, () =>
          host.mapSet(r.name, kAcc, "f64", k.name, f64Lit(0)),
        );
      else host.mapSet(r.name, kAcc, "f64", k.name, f64Lit(0));
      return { name: "", type: e.type };
    }
    case "has": {
      const k = borrowInputs ? host.emitReadReceiver(e.args[0]!) : host.emitExpr(e.args[0]!);
      if (kAcc === "f64") {
        noteNumberMapKey(host, k, e.args[0]!);
        return { name: emitNumberMapHas(host, r.name, k.name), type: e.type };
      }
      if (kAcc === "str")
        return { name: emitStringMapHas(host, r.name, k.name, compact), type: e.type };
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
    case "size":
      return { name: emitMapSize(host, r.name), type: e.type };
    case "clear":
      host.declare(`declare void @scr_map_clear(ptr)`);
      B.line(`call void @scr_map_clear(ptr ${r.name})`);
      return { name: "", type: e.type };
    case "iterCount":
      return { name: emitMapIterCount(host, r.name), type: e.type };
    case "iterStart":
      return { name: emitMapIterStart(host, r.name), type: e.type };
    case "iterLive": {
      const i = host.emitExpr(e.args[0]!);
      const entry = emitMapIterEntry(host, r.name, i.name, layout);
      const t = B.tmp();
      B.line(`${t} = icmp ne ptr ${entry}, null`);
      return { name: t, type: e.type };
    }
    case "iterKey": {
      // String/ref keys come back +1 (own registers the owned temp).
      const i = host.emitExpr(e.args[0]!);
      if (kAcc !== "ref") {
        const retTy = kAcc === "f64" ? "double" : kAcc === "bool" ? "zeroext i1" : "ptr";
        const symbol = `scr_map_iter_key_${kAcc}`;
        const t = emitMapIterSlot(
          host,
          r.name,
          i.name,
          0,
          kAcc === "str" ? "ref" : kAcc,
          key,
          { decl: `declare ${retTy} @${symbol}(ptr, double)`, symbol },
          layout,
        );
        return host.own({ name: t, type: e.type });
      }
      const retTy = "ptr";
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
      const symbol = `scr_map_iter_val_${vAcc}`;
      const t = emitMapIterSlot(
        host,
        r.name,
        i.name,
        1,
        vAcc,
        receiverType.value,
        {
          decl: `declare ${vAcc === "bool" ? "zeroext i1" : retTy} @${symbol}(ptr, double)`,
          symbol,
        },
        layout,
      );
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
      // Fresh +1 elem[] of the live entries in insertion order; a REF result
      // takes its element type's array descriptor.
      const t = B.tmp();
      if (kAcc === "ref") {
        host.declare(`declare ptr @scr_set_to_arr_ref(ptr, ptr)`);
        B.line(
          `${t} = call ptr @scr_set_to_arr_ref(ptr ${r.name}, ptr ${arrOps(host.shapeHost, receiverType.elem)})`,
        );
      } else {
        host.declare(`declare ptr @scr_set_to_arr_${kAcc}(ptr)`);
        B.line(`${t} = call ptr @scr_set_to_arr_${kAcc}(ptr ${r.name})`);
      }
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

registerReplay("resolveThunkFor", (host, args) => resolveThunkFor(host, args[0] as IrType));
