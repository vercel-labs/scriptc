/* Focused LLVM expression emission extracted from emitter.ts. */
import { InternalCompilerError } from "../../errors.js";
import { undefinedArmTag, unionWideningTags } from "../../ir/analysis.js";
import {
  type IrExpr,
  type IrType,
  isRefCounted,
  isUnitType,
  type SrcLoc,
  typeEquals,
} from "../../ir/ir.js";
import { LlvmUnsupportedError } from "./unsupported.js";
import type { LlvmEmitterContext, LlValue } from "./expr-context.js";
import { f64Lit, llvmCommentText } from "./common.js";
import { borrowableInputs, emitBorrowedInputs, emitBorrowedInput } from "./borrowed-inputs.js";
import { regexLiteralReplacer, regexLiteralTemplate } from "./expr-primitives.js";
import { canReplaceWith, regexLiteralCompiles } from "./regex-matchers.js";
import { isScalarUnionDef, loadInlineUnion, presentBits } from "./inline-unions.js";
import { preservesRegexInputs } from "./reference-effects.js";
import { emitNumberMapSlot, emitStringMapEntry } from "./map-number-lookup.js";
import { everyStmtList } from "../../ir/traverse.js";

/** Widen one tagged read. The source is borrowed unless the overflow map
 * supplied an owned value. Each selected reference payload is retained
 * before releasing an owned source, including cycle-traced references. */
export function emitUnionWiden(
  host: LlvmEmitterContext,
  value: string,
  fromId: string,
  toId: string,
  owned: boolean,
): string {
  const source = host.unionsById.get(fromId);
  const target = host.unionsById.get(toId);
  const tags = source && target ? unionWideningTags(source.arms, target.arms) : null;
  if (!source || !tags)
    throw new InternalCompilerError(`llvm emitter bug: cannot widen ${fromId} into ${toId}`);
  const B = host.B;
  const slot = B.slot();
  B.entryAllocas.push(`${slot} = alloca ptr`);
  const join = B.newLabel("widen.join");
  host.unionTagSwitch(value, source, (arm, index) => {
    const tag = tags[index]!;
    const result =
      arm.kind === "undefinedT" || arm.kind === "nullT"
        ? host.unitInstanceRef(toId, tag)
        : host.unionNewOwned(toId, tag, {
            name: host.unionExtract(value, fromId, arm),
            type: arm,
          });
    B.line(`store ptr ${result}, ptr ${slot}`);
    B.br(join);
  });
  B.startBlock(join);
  if (owned) host.releaseFrame(value, { kind: "union", unionId: fromId });
  const result = B.tmp();
  B.line(`${result} = load ptr, ptr ${slot}`);
  return result;
}

/** The identity union conversion (IR unionRetype). Two tagged unions
 * share the operand's box: its +1 becomes the result, so no box is built
 * and no payload is retained. The operand is a whole-value use in every
 * lifetime analysis, so it is never a stack box. A nullable-pointer union
 * on either side, or a source union whose boxes a checked-dynamic cast has
 * cached (and refreshes in place), rebuilds each listed arm instead. */
export function emitUnionRetype(
  host: LlvmEmitterContext,
  e: IrExpr & { kind: "unionRetype" },
): LlValue {
  const value = host.emitExpr(e.value);
  host.toFrame(value);
  const from = host.nullableUnions.get(e.fromId);
  const to = host.nullableUnions.get(e.unionId);
  if (from && to) {
    // Equal encodings make the pointer itself the target value. A shape
    // union derives its record arms from the record and a class union its
    // class arms from the class id, so only the unit encodings must agree.
    const same =
      from.repr === "single" && to.repr === "single"
        ? from.refTag === to.refTag && from.unitTag === to.unitTag && from.nullTag === to.nullTag
        : from.repr !== "single" &&
          from.repr === to.repr &&
          from.unitTag === to.unitTag &&
          from.nullTag === to.nullTag;
    if (same) return host.own({ name: value.name, type: e.type });
    return host.own({ name: rebuildRetype(host, value.name, e), type: e.type });
  }
  if (from || to) return host.own({ name: rebuildRetype(host, value.name, e), type: e.type });
  const B = host.B;
  const slot = B.slot();
  B.entryAllocas.push(`${slot} = alloca ptr`);
  const flag = B.tmp(),
    refreshed = B.tmp();
  B.line(`${flag} = load i8, ptr ${host.retypeGuardRef(e.fromId)}`);
  B.line(`${refreshed} = icmp ne i8 ${flag}, 0`);
  const share = B.newLabel("retype.share"),
    rebuild = B.newLabel("retype.rebuild"),
    join = B.newLabel("retype.join");
  B.condBr(refreshed, rebuild, share);
  B.startBlock(share);
  B.line(`store ptr ${value.name}, ptr ${slot}`);
  B.br(join);
  B.startBlock(rebuild);
  B.line(`store ptr ${rebuildRetype(host, value.name, e)}, ptr ${slot}`);
  B.br(join);
  B.startBlock(join);
  const result = B.tmp();
  B.line(`${result} = load ptr, ptr ${slot}`);
  return host.own({ name: result, type: e.type });
}

/** A fresh target value for each listed tag of an owned source, which this
 * consumes. Other tags cannot occur (the IR names every possible tag). */
function rebuildRetype(
  host: LlvmEmitterContext,
  value: string,
  e: IrExpr & { kind: "unionRetype" },
): string {
  const source = host.unionsById.get(e.fromId);
  if (!source)
    throw new InternalCompilerError(`llvm emitter bug: retype of unknown union ${e.fromId}`);
  const listed = new Set(e.tags);
  const B = host.B;
  const slot = B.slot();
  B.entryAllocas.push(`${slot} = alloca ptr`);
  const join = B.newLabel("retype.built");
  host.unionTagSwitch(value, source, (arm, tag) => {
    if (!listed.has(tag)) {
      B.line(`call void @sc_bad_tag()`);
      B.terminate(`unreachable`);
      return;
    }
    const result =
      arm.kind === "undefinedT" || arm.kind === "nullT"
        ? host.unitInstanceRef(e.unionId, tag)
        : host.unionNewOwned(e.unionId, tag, {
            name: host.unionExtract(value, e.fromId, arm),
            type: arm,
          });
    B.line(`store ptr ${result}, ptr ${slot}`);
    B.br(join);
  });
  B.startBlock(join);
  host.releaseFrame(value, { kind: "union", unionId: e.fromId });
  const result = B.tmp();
  B.line(`${result} = load ptr, ptr ${slot}`);
  return result;
}

/** The matching operations whose args[0] is the regex they consume. */
function directRegexOperandMethod(method: string): boolean {
  switch (method) {
    case "exec":
    case "execGroups":
    case "execSpans":
    case "matchGroups":
    case "match":
    case "search":
    case "matchAll":
    case "matchAllCaptures":
    case "matchAllInto":
    case "matchAllCapturesInto":
    case "replace":
    case "replaceAll":
    case "split":
      return true;
    default:
      return false;
  }
}

/** The build-time replacer of a substitution: a regex literal running on
 * its template, with a literal replacement the replacer can write as is.
 * Null when the substitution takes the runtime's loop. */
function literalReplacer(
  host: LlvmEmitterContext,
  literal: IrExpr | null,
  template: string | null,
  replacement: IrExpr,
): string | null {
  if (literal === null || template === null || literal.kind !== "regexLit") return null;
  if (replacement.kind !== "strLit") return null;
  if (!canReplaceWith(literal.pattern, literal.flags, replacement.value)) return null;
  if (!regexLiteralCompiles(literal.pattern, literal.flags)) return null;
  return regexLiteralReplacer(host, literal, replacement.value);
}

/** scr_regex_replace_with: the runtime runs `replacer` on an ASCII subject
 * and its own loop on any other. */
function emitReplaceWith(
  host: LlvmEmitterContext,
  e: IrExpr,
  r: LlValue,
  args: LlValue[],
  replacer: string,
): LlValue {
  host.declare(`declare ptr @scr_regex_replace_with(ptr, ptr, ptr, ptr)`);
  const t = host.B.tmp();
  host.B.line(
    `${t} = call ptr @scr_regex_replace_with(ptr ${r.name}, ptr ${args[0]!.name}, ptr ${args[1]!.name}, ptr ${replacer})`,
  );
  return host.own({ name: t, type: e.type });
}

/** Substitutions whose result owns its text: once the runtime call returns,
 * no operand is read again. */
function releasesInputsOnReturn(method: string): boolean {
  return method === "replace" || method === "replaceAll";
}

export function emitRegexIntrinsic(
  host: LlvmEmitterContext,
  e: IrExpr & { kind: "regexIntrinsic" },
): LlValue {
  if (!releasesInputsOnReturn(e.method)) return emitRegexOperation(host, e);
  // The operands' temps (the subject of a chained substitution, a computed
  // replacement) are released when the call returns rather than at the
  // end of the statement, so a chain of substitutions holds at most its
  // current subject and result.
  host.frames.push([]);
  const out = emitRegexOperation(host, e);
  host.toFrame(out);
  host.releaseTemps(host.frames.pop()!);
  return host.own(out);
}

function emitRegexOperation(
  host: LlvmEmitterContext,
  e: IrExpr & { kind: "regexIntrinsic" },
): LlValue {
  const B = host.B;
  const method = e.method;
  const inputs = [e.receiver, ...e.args];
  // A regex literal consumed directly by a matching operation cannot be
  // observed afterwards: nothing else holds the object, so its identity is
  // unobservable and its lastIndex is never read again. Such a site runs on
  // the literal's immortal template instead of a fresh copy, resetting a
  // global or sticky template's lastIndex to the fresh value right before
  // the call (after every other operand, which may evaluate the same site).
  const regexAt = method === "test" ? 0 : directRegexOperandMethod(method) ? 1 : -1;
  const literal = regexAt >= 0 ? inputs[regexAt]! : null;
  const template =
    literal !== null && literal.kind === "regexLit" ? regexLiteralTemplate(host, literal) : null;
  let values: LlValue[];
  if (template !== null) {
    const borrowed = borrowableInputs(host, inputs);
    values = inputs.map((a, index) =>
      index === regexAt
        ? { name: template, type: a.type }
        : borrowed[index]
          ? host.emitReadReceiver(a)
          : host.emitExpr(a),
    );
    if (/[gy]/.test((literal as IrExpr & { kind: "regexLit" }).flags)) {
      const field = B.tmp();
      B.line(`${field} = getelementptr inbounds %ScrRegex, ptr ${template}, i32 0, i32 4`);
      B.line(`store double 0.0, ptr ${field}`);
    }
  } else {
    values = preservesRegexInputs(method)
      ? emitBorrowedInputs(host, inputs)
      : method === "matchAllInto" || method === "matchAllCapturesInto"
        ? inputs.map((a) => emitBorrowedInput(host, a))
        : inputs.map((a) => host.emitExpr(a));
  }
  const r = values[0]!;
  const args = values.slice(1);
  const fallible = (sym: string, argText: string): LlValue => {
    host.declare(
      `declare ptr @${sym}(${argText
        .split(", ")
        .map(() => "ptr")
        .join(", ")})`,
    );
    const t = B.tmp();
    B.line(`${t} = call ptr @${sym}(${argText})`);
    const out = host.own({ name: t, type: e.type });
    host.emitPendingCheck();
    return out;
  };
  switch (method) {
    case "matchAll":
      // Every match drained eagerly into a fresh +1 string[][]; throws
      // Node's TypeError on a non-global regex (catchable).
      return fallible("scr_regex_match_all", `ptr ${r.name}, ptr ${args[0]!.name}`);
    case "matchAllCaptures":
      // matchAll whose rows carry no index, input or groups properties.
      return fallible("scr_regex_match_all_captures", `ptr ${r.name}, ptr ${args[0]!.name}`);
    case "matchAllInto":
      // matchAll's companion-index form: args[1] (a number[]) also
      // receives each match's UTF-16 start index.
      return fallible(
        "scr_regex_match_all_into",
        `ptr ${r.name}, ptr ${args[0]!.name}, ptr ${args[1]!.name}`,
      );
    case "matchAllCapturesInto":
      return fallible(
        "scr_regex_match_all_captures_into",
        `ptr ${r.name}, ptr ${args[0]!.name}, ptr ${args[1]!.name}`,
      );
    case "replaceAll": {
      // A global literal (the only kind a replacer is built for) never takes
      // replaceAll's non-global TypeError.
      const replacer = literalReplacer(host, literal, template, e.args[1]!);
      if (replacer !== null) return emitReplaceWith(host, e, r, args, replacer);
      return fallible(
        "scr_regex_replace_all",
        `ptr ${r.name}, ptr ${args[0]!.name}, ptr ${args[1]!.name}`,
      );
    }
    case "split":
      host.declare(`declare ptr @scr_regex_split_limit(ptr, ptr, double)`);
      {
        const t = B.tmp();
        B.line(
          `${t} = call ptr @scr_regex_split_limit(ptr ${r.name}, ptr ${args[0]!.name}, double ${args[1]!.name})`,
        );
        const out = host.own({ name: t, type: e.type });
        host.emitPendingCheck();
        return out;
      }
    case "test": {
      host.declare(`declare zeroext i1 @scr_regex_test(ptr, ptr)`);
      const t = B.tmp();
      B.line(`${t} = call zeroext i1 @scr_regex_test(ptr ${r.name}, ptr ${args[0]!.name})`);
      return { name: t, type: e.type };
    }
    case "match":
    case "exec":
    case "execGroups":
    case "execSpans":
    case "matchGroups": {
      // +1 string[] or NULL from the runtime; the `string[] | null`
      // union wraps type-directedly, the envGet convention.
      if (e.type.kind !== "union")
        throw new InternalCompilerError("llvm emitter bug: match result not a union");
      const def = host.unionsById.get(e.type.unionId);
      const arrTag = def ? def.arms.findIndex((a) => a.kind === "array") : -1;
      const nullTag = def ? def.arms.findIndex((a) => a.kind === "nullT") : -1;
      if (arrTag < 0 || nullTag < 0 || !def)
        throw new InternalCompilerError("llvm emitter bug: match union lacks its arms");
      const raw = B.tmp();
      if (e.method === "execGroups") {
        // args[1] is the constant mask of the captures the result's
        // readers use (see the IR method's contract).
        host.declare(`declare ptr @scr_regex_exec_groups(ptr, ptr, double)`);
        B.line(
          `${raw} = call ptr @scr_regex_exec_groups(ptr ${r.name}, ptr ${args[0]!.name}, double ${args[1]!.name})`,
        );
      } else if (e.method === "execSpans" || e.method === "matchGroups") {
        // args[1] selects the read captures, args[2] the lazily read ones.
        const symbol = e.method === "execSpans" ? "scr_regex_exec_spans" : "scr_regex_match_groups";
        host.declare(`declare ptr @${symbol}(ptr, ptr, double, double)`);
        B.line(
          `${raw} = call ptr @${symbol}(ptr ${r.name}, ptr ${args[0]!.name}, double ${args[1]!.name}, double ${args[2]!.name})`,
        );
      } else {
        const symbol = e.method === "exec" ? "scr_regex_exec" : "scr_regex_match";
        host.declare(`declare ptr @${symbol}(ptr, ptr)`);
        B.line(`${raw} = call ptr @${symbol}(ptr ${r.name}, ptr ${args[0]!.name})`);
      }
      return host.wrapNullable(raw, raw, def.arms[arrTag]!, arrTag, e.type, nullTag);
    }
    case "search": {
      host.declare(`declare double @scr_regex_search(ptr, ptr)`);
      const t = B.tmp();
      B.line(`${t} = call double @scr_regex_search(ptr ${r.name}, ptr ${args[0]!.name})`);
      return { name: t, type: e.type };
    }
    case "source": {
      host.declare(`declare ptr @scr_regex_source(ptr)`);
      const t = B.tmp();
      B.line(`${t} = call ptr @scr_regex_source(ptr ${r.name})`);
      return host.own({ name: t, type: e.type });
    }
    case "lastIndex": {
      host.declare("declare double @scr_regex_last_index(ptr)");
      const t = B.tmp();
      B.line(`${t} = call double @scr_regex_last_index(ptr ${r.name})`);
      return { name: t, type: e.type };
    }
    case "flags": {
      host.declare(`declare ptr @scr_regex_flags(ptr)`);
      const t = B.tmp();
      B.line(`${t} = call ptr @scr_regex_flags(ptr ${r.name})`);
      return host.own({ name: t, type: e.type });
    }
    case "toString": {
      host.declare(`declare ptr @scr_regex_to_string(ptr)`);
      const t = B.tmp();
      B.line(`${t} = call ptr @scr_regex_to_string(ptr ${r.name})`);
      return host.own({ name: t, type: e.type });
    }
    case "replace": {
      const replacer = literalReplacer(host, literal, template, e.args[1]!);
      if (replacer !== null) return emitReplaceWith(host, e, r, args, replacer);
      host.declare(`declare ptr @scr_regex_replace(ptr, ptr, ptr)`);
      const t = B.tmp();
      B.line(
        `${t} = call ptr @scr_regex_replace(ptr ${r.name}, ptr ${args[0]!.name}, ptr ${args[1]!.name})`,
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

/** `r[k] ?? d` in its pass-through shape: a missing key evaluates `d`
 * where the read would store undefined, so a hit costs nothing extra. */
export function emitRecordKeyGetOr(
  host: LlvmEmitterContext,
  e: IrExpr & { kind: "recordKeyGet" },
  fallback: IrExpr,
): LlValue {
  const B = host.B;
  const obj = host.emitExpr(e.obj);
  const k = host.emitExpr(e.key);
  const ty = host.llType(e.type);
  const slot = B.slot();
  B.entryAllocas.push(`${slot} = alloca ${ty}`);
  const join = B.newLabel("rkg.j");
  keyedRecordReadInto(
    host,
    slot,
    join,
    obj.name,
    k.name,
    e.shapeId,
    e.type,
    e.overflowOnly === true,
    e.loc,
    false,
    () => host.emitBranchInto(slot, fallback),
  );
  B.startBlock(join);
  const t = B.tmp();
  B.line(`${t} = load ${ty}, ptr ${slot}`);
  return host.own({ name: t, type: e.type });
}

export function emitRecordKeyGet(
  host: LlvmEmitterContext,
  e: IrExpr & { kind: "recordKeyGet" },
): LlValue {
  const B = host.B;
  // The read runs no user code: both inputs lend for its duration.
  const [obj, k] = emitBorrowedInputs(host, [e.obj, e.key]) as [LlValue, LlValue];
  const ty = host.llType(e.type);
  const slot = B.slot();
  B.entryAllocas.push(`${slot} = alloca ${ty}`);
  const join = B.newLabel("rkg.j");
  host.keyedRecordReadInto(
    slot,
    join,
    obj.name,
    k.name,
    e.shapeId,
    e.type,
    e.overflowOnly === true,
    e.loc,
    e.missNaN === true,
  );
  B.startBlock(join);
  const t = B.tmp();
  B.line(`${t} = load ${ty}, ptr ${slot}`);
  return host.own({ name: t, type: e.type });
}

/** A keyed read whose every hit is the result's own pointer: the result
 * is a nullable-pointer union (nullable-unions.ts) with an undefined arm,
 * and each declared field and the overflow value hold exactly the result
 * type or its reference arm in a plain (non-inline) slot. A miss is the
 * immortal undefined encoding. Such a read can lend the stored pointer:
 * borrowedRecordKeyGet reads it without a reference. */
export function pointerRecordKeyGet(host: LlvmEmitterContext, e: IrExpr): boolean {
  if (e.kind !== "recordKeyGet" || e.missNaN === true || e.type.kind !== "union") return false;
  const resultType = e.type;
  const nullable = host.nullableUnions.single(resultType.unionId);
  if (nullable === null || undefinedArmTag(resultType, host.unionsById) < 0) return false;
  const exact = (t: IrType): boolean => typeEquals(t, resultType) || typeEquals(t, nullable.arm);
  const shape = host.recordShape(e.shapeId);
  if (e.overflowOnly !== true) {
    for (const f of shape.fields)
      if (host.recordFieldInline(e.shapeId, f.name) || !exact(f.type)) return false;
  }
  return shape.indexValue === undefined || typeEquals(shape.indexValue, nullable.arm);
}

/** A pointerRecordKeyGet read without a reference: the declared field or
 * overflow entry the key names, or the undefined encoding for a miss. The
 * record (and through it the stored value) must stay unchanged and alive
 * until the consumer is done with the pointer (canBorrowReceiver). */
export function emitBorrowedRecordKeyGet(
  host: LlvmEmitterContext,
  e: IrExpr & { kind: "recordKeyGet" },
  fallback: IrExpr | null = null,
): LlValue {
  const B = host.B;
  if (e.type.kind !== "union")
    throw new InternalCompilerError("llvm emitter bug: borrowed keyed read of a non-union");
  const resultType = e.type;
  const obj = host.emitReadReceiver(e.obj);
  const key = host.canBorrowReceiver(e.key) ? host.emitReadReceiver(e.key) : host.emitExpr(e.key);
  const slot = B.slot();
  B.entryAllocas.push(`${slot} = alloca ptr`);
  // A default that needs an owner gets a frame slot, empty on every path
  // until a miss fills it.
  let owner: string | null = null;
  if (fallback !== null && !immortalDefault(host, fallback)) {
    owner = B.slot();
    B.entryAllocas.push(`${owner} = alloca ptr`);
    B.line(`store ptr null, ptr ${owner}`);
    host.ownSlot(owner, resultType, true);
  }
  const join = B.newLabel("rkb.j");
  const shape = host.recordShape(e.shapeId);
  for (const f of e.overflowOnly === true ? [] : shape.fields) {
    const hit = B.tmp();
    B.line(
      `${hit} = call zeroext i1 ${host.literalEquals(f.name)}(ptr ${key.name}) ; ${llvmCommentText(f.name)}`,
    );
    const lh = B.newLabel("rkb.h");
    const ln = B.newLabel("rkb.n");
    B.condBr(hit, lh, ln);
    B.startBlock(lh);
    const { ptr, type } = host.recordFieldPtr(obj.name, e.shapeId, f.name);
    B.line(`store ptr ${host.loadRecordField(ptr, type, false)}, ptr ${slot}`);
    B.br(join);
    B.startBlock(ln);
  }
  if (shape.indexValue) {
    const ovf = host.recordOvfPtr(obj.name, e.shapeId);
    const entry = emitStringMapEntry(host, ovf, key.name);
    const found = B.tmp();
    B.line(`${found} = icmp ne ptr ${entry}, null`);
    const lh = B.newLabel("rkb.h");
    const ln = B.newLabel("rkb.n");
    B.condBr(found, lh, ln);
    B.startBlock(lh);
    B.line(`store ptr ${emitNumberMapSlot(host, entry, "ptr")}, ptr ${slot}`);
    B.br(join);
    B.startBlock(ln);
  }
  if (fallback !== null && immortalDefault(host, fallback)) {
    // An immortal default (an interned function value or undefined) needs
    // no owner at all.
    const value = host.emitExpr(fallback);
    host.toHeap(value);
    B.line(`store ptr ${value.name}, ptr ${slot}`);
  } else if (fallback !== null && owner !== null) {
    // `r[k] ?? d` (borrowedRecordKeyGetOr): the default is owned by a
    // statement-frame slot, which the consumer may borrow like a hit.
    const value = host.emitExpr(fallback);
    host.toHeap(value);
    B.line(`store ptr ${value.name}, ptr ${owner}`);
    B.line(`store ptr ${value.name}, ptr ${slot}`);
  } else {
    const undefTag = undefinedArmTag(resultType, host.unionsById);
    B.line(`store ptr ${host.unitInstanceRef(resultType.unionId, undefTag)}, ptr ${slot}`);
  }
  B.br(join);
  B.startBlock(join);
  const t = B.tmp();
  B.line(`${t} = load ptr, ptr ${slot}`);
  return { name: t, type: e.type };
}

/** `r[k] ?? d` in its pass-through shape over a pointerRecordKeyGet whose
 * stored values are never unit (so only a miss evaluates `d`): the hit
 * lends the stored pointer and the default is frame-owned, so the result
 * borrows for the rest of the statement. */
export function borrowedRecordKeyGetOr(
  host: LlvmEmitterContext,
  e: IrExpr,
): (IrExpr & { kind: "recordKeyGet" }) | null {
  if (e.kind !== "nullish" || e.left.kind !== "recordKeyGet") return null;
  if (!typeEquals(e.type, e.left.type) || !pointerRecordKeyGet(host, e.left)) return null;
  const shape = host.recordShape(e.left.shapeId);
  const holdsUnit = (t: IrType): boolean =>
    isUnitType(t) ||
    t.kind === "dyn" ||
    (t.kind === "union" && (host.unionsById.get(t.unionId)?.arms ?? []).some(isUnitType));
  if (shape.indexValue !== undefined && holdsUnit(shape.indexValue)) return null;
  if (e.left.overflowOnly !== true && shape.fields.some((f) => holdsUnit(f.type))) return null;
  return e.left;
}

/** The default is a call to a helper whose every result is immortal: the
 * unit arm or a closure over no captures (an interned function value), as
 * the unbound inherited-method reads return. */
export function immortalDefault(host: LlvmEmitterContext, fallback: IrExpr): boolean {
  if (fallback.kind !== "call") return false;
  const fn = host.fnByName.get(fallback.callee);
  if (!fn || fn.async || fn.generator) return false;
  const immortal = (v: IrExpr | null): boolean => {
    if (v === null) return false;
    if (v.kind === "unitLit") return true;
    if (v.kind === "unionWrap") return immortal(v.value);
    if (v.kind === "closure") {
      const target = host.fnByName.get(v.fnName);
      return v.captures.length === 0 && target !== undefined && target.captures === undefined;
    }
    return false;
  };
  let ok = true;
  everyStmtList(fn.body, {
    stmt: (st) => {
      if (st.kind === "return" && !immortal(st.value)) ok = false;
      return ok;
    },
    expr: () => ok,
  });
  return ok;
}

/** A keyed read whose result is a scalar union (`r[k]` on a
 * `Record<string, number>`, at `number | undefined`) and whose every hit
 * is a number or boolean arm of it, or an inline field of the same union.
 * Projections (`??`, `!`, tag tests) read it as a private stack box, so
 * the read allocates nothing. */
export function scalarRecordKeyGet(host: LlvmEmitterContext, e: IrExpr): boolean {
  if (e.kind !== "recordKeyGet" || e.missNaN === true || e.type.kind !== "union") return false;
  const resultType = e.type;
  const def = host.unionsById.get(resultType.unionId);
  if (!isScalarUnionDef(def) || undefinedArmTag(resultType, host.unionsById) < 0) return false;
  const isArm = (t: IrType): boolean =>
    (t.kind === "f64" || t.kind === "bool") && def!.arms.some((a) => typeEquals(a, t));
  const shape = host.recordShape(e.shapeId);
  if (e.overflowOnly !== true) {
    for (const f of shape.fields) {
      const inline = host.recordFieldInline(e.shapeId, f.name);
      if (!isArm(f.type) && !(inline && typeEquals(f.type, resultType))) return false;
    }
  }
  return shape.indexValue === undefined || isArm(shape.indexValue);
}

/** A scalarRecordKeyGet read as a private stack box: the tag and bits of
 * the declared field or overflow entry the key names, or the undefined arm
 * for a miss. The box must never reach an RC entry point. */
export function emitStackRecordKeyGet(
  host: LlvmEmitterContext,
  e: IrExpr & { kind: "recordKeyGet" },
): string {
  const B = host.B;
  if (e.type.kind !== "union")
    throw new InternalCompilerError("llvm emitter bug: stack keyed read of a non-union");
  const resultType = e.type;
  const def = host.unionsById.get(resultType.unionId)!;
  const armTag = (t: IrType): number => def.arms.findIndex((a) => typeEquals(a, t));
  const obj = host.emitExpr(e.obj);
  const key = host.emitExpr(e.key);
  const box = B.slot();
  B.entryAllocas.push(`${box} = alloca %ScrUnion`);
  const tagPtr = B.tmp(),
    bitsPtr = B.tmp();
  B.line(`store ${host.sizeType} -1, ptr ${box}`);
  B.line(`${tagPtr} = getelementptr inbounds %ScrUnion, ptr ${box}, i64 0, i32 1`);
  B.line(`${bitsPtr} = getelementptr inbounds %ScrUnion, ptr ${box}, i64 0, i32 5`);
  const join = B.newLabel("rks.j");
  const storeScalar = (t: IrType, value: string): void => {
    const bits = B.tmp();
    if (t.kind === "f64") B.line(`${bits} = bitcast double ${value} to i64`);
    else B.line(`${bits} = zext i1 ${value} to i64`);
    B.line(`store i32 ${armTag(t)}, ptr ${tagPtr}`);
    B.line(`store i64 ${bits}, ptr ${bitsPtr}`);
  };
  const shape = host.recordShape(e.shapeId);
  for (const f of e.overflowOnly === true ? [] : shape.fields) {
    const hit = B.tmp();
    B.line(
      `${hit} = call zeroext i1 ${host.literalEquals(f.name)}(ptr ${key.name}) ; ${llvmCommentText(f.name)}`,
    );
    const lh = B.newLabel("rks.h");
    const ln = B.newLabel("rks.n");
    B.condBr(hit, lh, ln);
    B.startBlock(lh);
    const { ptr, type, inline } = host.recordFieldPtr(obj.name, e.shapeId, f.name);
    if (inline) {
      const { tag, bits } = loadInlineUnion(B, ptr);
      const present = presentBits(B, tag, bits, undefinedArmTag(type, host.unionsById));
      B.line(`store i32 ${tag}, ptr ${tagPtr}`);
      B.line(`store i64 ${present}, ptr ${bitsPtr}`);
    } else {
      storeScalar(type, host.loadRecordField(ptr, type, false));
    }
    B.br(join);
    B.startBlock(ln);
  }
  const iv = shape.indexValue;
  if (iv) {
    const ovf = host.recordOvfPtr(obj.name, e.shapeId);
    const outTy = iv.kind === "f64" ? "double" : "i8";
    const outSlot = B.slot();
    B.entryAllocas.push(`${outSlot} = alloca ${outTy}`);
    B.line(`store ${outTy} ${iv.kind === "f64" ? f64Lit(0) : "0"}, ptr ${outSlot}`);
    const getter = `scr_map_get_str_${iv.kind === "f64" ? "f64" : "bool"}`;
    host.declare(`declare zeroext i1 @${getter}(ptr, ptr, ptr)`);
    const found = B.tmp();
    B.line(`${found} = call zeroext i1 @${getter}(ptr ${ovf}, ptr ${key.name}, ptr ${outSlot})`);
    const lh = B.newLabel("rks.h");
    const ln = B.newLabel("rks.n");
    B.condBr(found, lh, ln);
    B.startBlock(lh);
    const raw = B.tmp();
    B.line(`${raw} = load ${outTy}, ptr ${outSlot}`);
    let value = raw;
    if (iv.kind === "bool") {
      value = B.tmp();
      B.line(`${value} = trunc i8 ${raw} to i1`);
    }
    storeScalar(iv, value);
    B.br(join);
    B.startBlock(ln);
  }
  // A miss is the undefined arm.
  B.line(`store i32 ${undefinedArmTag(resultType, host.unionsById)}, ptr ${tagPtr}`);
  B.line(`store i64 0, ptr ${bitsPtr}`);
  B.br(join);
  B.startBlock(join);
  return box;
}

export function keyedRecordReadInto(
  host: LlvmEmitterContext,
  slot: string,
  join: string,
  objName: string,
  keyName: string,
  shapeId: string,
  resultType: IrType,
  overflowOnly: boolean,
  loc?: SrcLoc,
  missNaN = false,
  missInto: (() => void) | null = null,
): void {
  const B = host.B;
  const shape = host.recordShape(shapeId);
  if (resultType.kind === "dyn") {
    // A dyn JOIN (the C helper's `surface` dyn arm): declared hits
    // convert through the per-type toDyn walker (borrowed read → fresh
    // +1 tree), a dyn-valued overflow hit passes through (+1 from the
    // map get), and a miss is JS's undefined — the dyn singleton.
    for (const f of overflowOnly ? [] : shape.fields) {
      const hit = B.tmp();
      B.line(
        `${hit} = call zeroext i1 ${host.literalEquals(f.name)}(ptr ${keyName}) ; ${llvmCommentText(f.name)}`,
      );
      const lh = B.newLabel("rkg.h");
      const ln = B.newLabel("rkg.n");
      B.condBr(hit, lh, ln);
      B.startBlock(lh);
      const { ptr, type, inline } = host.recordFieldPtr(objName, shapeId, f.name);
      const v = host.loadRecordField(ptr, type, inline);
      if (type.kind === "dyn") {
        host.declare(`declare ptr @scr_dyn_retain_v(ptr)`);
        const r = B.tmp();
        B.line(`${r} = call ptr @scr_dyn_retain_v(ptr ${v})`);
        B.line(`store ptr ${r}, ptr ${slot}`);
      } else {
        const conv = host.dyn.toDynHelper(type);
        const vTy = host.llType(type);
        const r = B.tmp();
        B.line(`${r} = call ptr @${conv}(${vTy} ${v})`);
        B.line(`store ptr ${r}, ptr ${slot}`);
      }
      B.br(join);
      B.startBlock(ln);
    }
    const iv = shape.indexValue;
    if (iv && (iv.kind === "f64" || iv.kind === "bool")) {
      // Scalar overflow under a dyn join: the hit converts through the
      // toDyn box (the C `surface(iv, hit, true)` with t dyn).
      const ovf = host.recordOvfPtr(objName, shapeId);
      const outTy = iv.kind === "f64" ? "double" : "i8";
      const outSlot = B.slot();
      B.entryAllocas.push(`${outSlot} = alloca ${outTy}`);
      B.line(`store ${outTy} ${iv.kind === "f64" ? f64Lit(0) : "0"}, ptr ${outSlot}`);
      host.declare(
        `declare zeroext i1 @scr_map_get_str_${iv.kind === "f64" ? "f64" : "bool"}(ptr, ptr, ptr)`,
      );
      const found = B.tmp();
      B.line(
        `${found} = call zeroext i1 @scr_map_get_str_${iv.kind === "f64" ? "f64" : "bool"}(ptr ${ovf}, ptr ${keyName}, ptr ${outSlot})`,
      );
      const lh = B.newLabel("rkg.h");
      const ln = B.newLabel("rkg.n");
      B.condBr(found, lh, ln);
      B.startBlock(lh);
      const rawOut = B.tmp();
      B.line(`${rawOut} = load ${outTy}, ptr ${outSlot}`);
      let hitVal = rawOut;
      if (iv.kind === "bool") {
        hitVal = B.tmp();
        B.line(`${hitVal} = trunc i8 ${rawOut} to i1`);
      }
      const conv = host.dyn.toDynHelper(iv);
      const r = B.tmp();
      B.line(`${r} = call ptr @${conv}(${iv.kind === "f64" ? "double" : "i1"} ${hitVal})`);
      B.line(`store ptr ${r}, ptr ${slot}`);
      B.br(join);
      B.startBlock(ln);
    } else if (iv) {
      if (iv.kind !== "dyn") {
        // The C helper's emitter-bug arm: a non-dyn REF overflow can
        // never join at dyn (the frontend fences it).
        throw new LlvmUnsupportedError(`recordKeyGet:narrow:${iv.kind}`, loc);
      }
      const ovf = host.recordOvfPtr(objName, shapeId);
      host.declare(`declare ptr @scr_map_get_str_ref(ptr, ptr)`);
      const raw = B.tmp();
      const isnull = B.tmp();
      B.line(`${raw} = call ptr @scr_map_get_str_ref(ptr ${ovf}, ptr ${keyName})`);
      B.line(`${isnull} = icmp eq ptr ${raw}, null`);
      const lh = B.newLabel("rkg.h");
      const ln = B.newLabel("rkg.n");
      B.condBr(isnull, ln, lh);
      B.startBlock(lh);
      B.line(`store ptr ${raw}, ptr ${slot} ; get returned +1`);
      B.br(join);
      B.startBlock(ln);
    }
    // The miss path: JS's undefined — the dyn singleton, retained.
    host.declare(`declare ptr @scr_dyn_undefined()`);
    host.declare(`declare ptr @scr_dyn_retain_v(ptr)`);
    const u = B.tmp();
    const r = B.tmp();
    B.line(`${u} = call ptr @scr_dyn_undefined()`);
    B.line(`${r} = call ptr @scr_dyn_retain_v(ptr ${u})`);
    B.line(`store ptr ${r}, ptr ${slot}`);
    B.br(join);
    return;
  }
  const undefTag = resultType.kind === "union" ? undefinedArmTag(resultType, host.unionsById) : -1;
  const def = resultType.kind === "union" ? host.unionsById.get(resultType.unionId)! : null;
  const ty = host.llType(resultType);
  // How a hit of type `vt` surfaces at the requested result type (the C
  // helper's `surface`). Direct results require an exact type and retain
  // borrowed references; union results pass an identical union through
  // or wrap the matching arm. Owned map reads always move into the result.
  const surface = (vt: IrType, expr: string, owned: boolean): string => {
    if (def === null) {
      if (!typeEquals(vt, resultType)) {
        throw new LlvmUnsupportedError(`recordKeyGet:narrow:${vt.kind}`, loc);
      }
      return owned || !isRefCounted(vt) ? expr : host.retainFrame(expr, vt);
    }
    if (typeEquals(vt, resultType)) {
      return owned ? expr : host.retainFrame(expr, vt);
    }
    if (vt.kind === "union" && resultType.kind === "union") {
      return emitUnionWiden(host, expr, vt.unionId, resultType.unionId, owned);
    }
    const tag = def.arms.findIndex((a) => typeEquals(a, vt));
    if (tag < 0)
      throw new InternalCompilerError(`llvm emitter bug: keyed read arm for ${vt.kind} missing`);
    if (vt.kind === "f64" || vt.kind === "bool") {
      return host.unionNewOwned(def.id, tag, { name: expr, type: vt });
    }
    const payload = owned ? expr : host.retainHeap(expr, vt);
    return host.unionNewOwned(def.id, tag, { name: payload, type: vt });
  };
  for (const f of overflowOnly ? [] : shape.fields) {
    const hit = B.tmp();
    B.line(
      `${hit} = call zeroext i1 ${host.literalEquals(f.name)}(ptr ${keyName}) ; ${llvmCommentText(f.name)}`,
    );
    const lh = B.newLabel("rkg.h");
    const ln = B.newLabel("rkg.n");
    B.condBr(hit, lh, ln);
    B.startBlock(lh);
    const { ptr, type, inline } = host.recordFieldPtr(objName, shapeId, f.name);
    // An inline union field surfaces through a fresh heap box.
    const value = inline
      ? surface(type, host.inlineFieldUnion(ptr, type), true)
      : surface(type, host.loadRecordField(ptr, type, false), false);
    B.line(`store ${ty} ${value}, ptr ${slot}`);
    B.br(join);
    B.startBlock(ln);
  }
  const iv = shape.indexValue;
  if (iv) {
    const ovf = host.recordOvfPtr(objName, shapeId);
    if (iv.kind === "f64" || iv.kind === "bool") {
      const outTy = iv.kind === "f64" ? "double" : "i8";
      const outSlot = B.slot();
      B.entryAllocas.push(`${outSlot} = alloca ${outTy}`);
      B.line(`store ${outTy} ${iv.kind === "f64" ? f64Lit(0) : "0"}, ptr ${outSlot}`);
      host.declare(
        `declare zeroext i1 @scr_map_get_str_${iv.kind === "f64" ? "f64" : "bool"}(ptr, ptr, ptr)`,
      );
      const found = B.tmp();
      B.line(
        `${found} = call zeroext i1 @scr_map_get_str_${iv.kind === "f64" ? "f64" : "bool"}(ptr ${ovf}, ptr ${keyName}, ptr ${outSlot})`,
      );
      const lh = B.newLabel("rkg.h");
      const ln = B.newLabel("rkg.n");
      B.condBr(found, lh, ln);
      B.startBlock(lh);
      const rawOut = B.tmp();
      B.line(`${rawOut} = load ${outTy}, ptr ${outSlot}`);
      let hitVal = rawOut;
      if (iv.kind === "bool") {
        hitVal = B.tmp();
        B.line(`${hitVal} = trunc i8 ${rawOut} to i1`);
      }
      B.line(`store ${ty} ${surface(iv, hitVal, true)}, ptr ${slot}`);
      B.br(join);
      B.startBlock(ln);
    } else {
      // The entry lookup filters absent keys inline; a hit retains the
      // stored value with its own type's retain (map-number-lookup.ts). A
      // nullable value's NULL is a stored unit arm: presence decides.
      const lh = B.newLabel("rkg.h");
      const ln = B.newLabel("rkg.n");
      const entry = emitStringMapEntry(host, ovf, keyName);
      const found = B.tmp();
      B.line(`${found} = icmp ne ptr ${entry}, null`);
      B.condBr(found, lh, ln);
      B.startBlock(lh);
      const raw = host.retainHeap(emitNumberMapSlot(host, entry, "ptr"), iv);
      B.line(`store ${ty} ${surface(iv, raw, true)}, ptr ${slot}`);
      B.br(join);
      B.startBlock(ln);
    }
  }
  if (def !== null && resultType.kind === "union" && undefTag >= 0) {
    // The miss path: the result union's undefined arm, or the caller's
    // own value for a miss (missInto stores it into the slot).
    if (missInto !== null) missInto();
    else B.line(`store ptr ${host.unitInstanceRef(resultType.unionId, undefTag)}, ptr ${slot}`);
    B.br(join);
    return;
  }
  if (missNaN && resultType.kind === "f64") {
    // A NaN-coded read: every consumer treats undefined like NaN.
    B.line(`store double ${f64Lit(NaN)}, ptr ${slot}`);
    B.br(join);
    return;
  }
  // A direct result cannot represent a miss. This is unreachable for
  // programs whose behavior matches Node, but preserve the missing-key trap.
  host.needsBadKey = true;
  B.line(`call void @sc_bad_key()`);
  B.terminate(`unreachable`);
}
