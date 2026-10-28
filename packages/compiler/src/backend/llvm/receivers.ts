/* LlEmitter's receivers: receiver reads, and the analyses that decide when calls, receivers and returns borrow. */
import type { LlEmitter } from "./emitter.js";
import {
  type IrExpr,
  type IrFunction,
  type IrLocal,
  type IrType,
  isRefCounted,
} from "../../ir/ir.js";
import type { LlValue } from "./expr-context.js";
import { guardedValue } from "./borrowed-receivers.js";
import { InternalCompilerError } from "../../errors.js";
import { emitBorrowedArrayRead, emitProjectedArrayRead } from "./local-array-reads.js";
import {
  emitBorrowedMapGet,
  emitStackMapRead,
  matchMapRead,
  pointerMapGet,
} from "./map-read-lifetimes.js";
import { emitBorrowedResultCall, emitCallExpr } from "./expr-calls.js";
import { borrowsCheckedNarrow, emitCheckedNarrowReceiver } from "./checked-narrows.js";
import { canStackUnion, emitStackUnion } from "./stack-unions.js";
import { emitDowncastGuard, emitUnionNarrowGuard } from "./narrow-guards.js";
import { emitScalarOptional, isScalarOptionalSource } from "./local-union-storage.js";
import { borrowableInputs } from "./borrowed-inputs.js";
import {
  borrowedRecordKeyGetOr,
  emitBorrowedRecordKeyGet,
  emitStackRecordKeyGet,
  pointerRecordKeyGet,
  scalarRecordKeyGet,
} from "./expr-records.js";
import { type WalkBorrowHost, analyzeWalks } from "./walk-borrows.js";

/** Read a receiver whose value is consumed immediately by a field or tag
 * load. No user code may run between this read and its consumer. Locals
 * and their projections already have an owner; other expressions keep
 * their ordinary statement-frame ownership. The caller must retain any
 * reference result before evaluating another expression. */
export function emitReadReceiver(emitter: LlEmitter, e: IrExpr): LlValue {
  if (!isRefCounted(e.type)) return emitter.emitExpr(e);
  if (e.kind === "strLit") return { name: emitter.internLiteral(e.value), type: e.type };
  const guarded = guardedValue(e);
  if (guarded !== null) {
    // Throwing guards run in place, exactly as the sequence emits them.
    for (const s of (e as IrExpr & { kind: "seqExpr" }).stmts) emitter.emitStmt(s);
    return emitter.emitReadReceiver(guarded);
  }
  if (e.kind === "varRef") {
    emitter.materializeSplitLocal(e.localId);
    const binding = emitter.binding(e.localId);
    if (binding.kind === "boxed") {
      // A projection consumes this pointer before any user code runs.
      // Keep TDZ checks and caught-value conversion on the owned path.
      if (!emitter.canBorrowReceiver(e)) return emitter.emitExpr(e);
      const box = emitter.loadBox(binding.slot);
      const payload = emitter.B.tmp();
      const value = emitter.B.tmp();
      emitter.B.line(`${payload} = getelementptr inbounds %ScrBox, ptr ${box}, i32 0, i32 5`);
      emitter.B.line(`${value} = load ptr, ptr ${payload}`);
      return { name: value, type: e.type };
    }
    if (binding.kind === "global") emitter.checkGlobalTdz(e.localId);
    const value = emitter.B.tmp();
    emitter.B.line(`${value} = load ptr, ptr ${binding.slot}${emitter.slotAlias(e.localId)}`);
    return { name: value, type: e.type };
  }
  if (e.kind === "dynCheck" && e.exact) return emitter.emitExactCapsuleObject(e.value, e.type);
  if (e.kind === "chainRecv") {
    // The chain's bind slot holds its receiver unchanged until the body
    // finishes, owned by the slot itself or by the chain's receiver.
    const bound = emitter.chainSlots.get(e.id);
    if (!bound)
      throw new InternalCompilerError(`llvm emitter bug: chainRecv "${e.id}" outside its chain`);
    const value = emitter.B.tmp();
    emitter.B.line(`${value} = load ${emitter.llType(bound.type)}, ptr ${bound.name}`);
    return { name: value, type: e.type };
  }
  if (e.kind === "arrayGet" && emitter.canBorrowReceiver(e)) {
    // The array keeps the element alive until the consumer; a missing
    // element still traps exactly like the owned read.
    const slot = emitter.B.slot();
    emitter.B.entryAllocas.push(`${slot} = alloca ptr`);
    emitBorrowedArrayRead(emitter, e, slot);
    const value = emitter.B.tmp();
    emitter.B.line(`${value} = load ptr, ptr ${slot}`);
    return { name: value, type: e.type };
  }
  const wrap = emitter.borrowableNullableWrap(e);
  if (wrap === "unit" && e.kind === "unionWrap")
    return { name: emitter.unitInstanceRef(e.unionId, e.tag), type: e.type };
  if (wrap === "ref" && e.kind === "unionWrap")
    return { name: emitter.emitReadReceiver(e.value).name, type: e.type };
  const read = matchMapRead(e, emitter.boxedUnionsById);
  if (read) {
    const result = emitStackMapRead(emitter, read);
    if (result.owner) emitter.ownSlot(result.owner.slot, result.owner.type);
    return result.value;
  }
  // A borrowed-return helper (such as an optional element read) lends its
  // result like any borrowed-return call.
  if (e.kind === "call" && emitter.borrowedReturns.has(e.callee) && emitter.canBorrowReceiver(e))
    return emitBorrowedResultCall(emitter, e);
  const arrayRead = emitter.optionalArrayReads.get(e);
  if (arrayRead) return emitProjectedArrayRead(emitter, arrayRead);
  if (e.kind === "recordKeyGet" && emitter.canBorrowReceiver(e))
    return emitBorrowedRecordKeyGet(emitter, e);
  if (e.kind === "nullish" && emitter.canBorrowReceiver(e)) {
    const read = borrowedRecordKeyGetOr(emitter, e);
    if (read) return emitBorrowedRecordKeyGet(emitter, read, e.right);
  }
  if (e.kind === "mapIntrinsic" && emitter.canBorrowReceiver(e))
    return emitBorrowedMapGet(emitter, e);
  const narrow = emitter.checkedNarrows.get(e);
  const narrowed = narrow ? emitCheckedNarrowReceiver(emitter, narrow) : null;
  if (narrowed) return narrowed;
  if (canStackUnion(e, emitter.boxedUnionsById)) return emitStackUnion(emitter, e).value;
  if (e.kind === "recordKeyGet" && scalarRecordKeyGet(emitter, e))
    return { name: emitStackRecordKeyGet(emitter, e), type: e.type };
  if (e.kind === "unionNarrow") {
    const union = emitter.emitUnionProjection(e.value);
    emitUnionNarrowGuard(emitter, union.name, e.unionId, e.tag);
    return { name: emitter.unionPeek(union.name, e.unionId), type: e.type };
  }
  if ((e.kind === "downcast" || e.kind === "upcast") && e.value.type.kind === "object") {
    // Prefix layouts: a class cast reads the operand's own pointer; a
    // downcast verifies its target class (narrow-guards.ts).
    const receiver = emitter.emitReadReceiver(e.value);
    if (e.kind === "downcast" && e.type.kind === "object")
      emitDowncastGuard(emitter, receiver.name, e.value.type.className, e.type.className);
    return { name: receiver.name, type: e.type };
  }
  // A nullable-pointer field has no box to borrow. Projections use
  // emitUnionProjection; other borrowers get an owned heap box.
  if (emitter.nullableFieldGet(e)) return emitter.emitExpr(e);
  if (e.kind === "recordGet" || e.kind === "fieldGet") {
    const receiver = emitter.emitReadReceiver(e.obj);
    if (e.kind === "recordGet") {
      // An inline union field answers a private stack box.
      const { ptr, type, inline } = emitter.recordFieldPtr(receiver.name, e.shapeId, e.field);
      return { name: emitter.loadRecordField(ptr, type, inline), type: e.type };
    }
    const { ptr, type, inline } = emitter.classFieldPtr(
      receiver.name,
      e.className,
      e.field,
      "compressed",
    );
    if (emitter.int32Slots.isField(e.className, e.field))
      return emitter.loadInt32Field(ptr, e.type);
    return { name: emitter.loadField(ptr, type, inline), type: e.type };
  }
  if (
    e.kind === "ternary" &&
    emitter.canBorrowReceiver(e.then) &&
    emitter.canBorrowReceiver(e.else_)
  ) {
    // Checked projections lower to a ternary with an always-throwing
    // arm. Keep that check at the use, but borrow the successful arm.
    const B = emitter.B;
    const cond = emitter.emitExpr(e.cond);
    const slot = B.slot();
    B.entryAllocas.push(`${slot} = alloca ptr`);
    const yes = B.newLabel("read.then"),
      no = B.newLabel("read.else"),
      join = B.newLabel("read.join");
    B.condBr(cond.name, yes, no);
    // Slots an arm's borrowed read fills (the owner of a `r[k] ?? d`
    // default) may hold what the result points to: the enclosing frame
    // releases them after the use, and the other arm's path leaves them
    // empty so that release skips them.
    const armSlots: LlValue[][] = [];
    const ends: string[] = [];
    for (const [label, value] of [
      [yes, e.then],
      [no, e.else_],
    ] as const) {
      B.startBlock(label);
      emitter.frames.push([]);
      const result = emitter.emitReadReceiver(value);
      B.line(`store ptr ${result.name}, ptr ${slot}`);
      const frame = emitter.frames.pop()!;
      armSlots.push(frame.filter((entry) => entry.slot === true && entry.boxed !== true));
      emitter.releaseTemps(frame.filter((entry) => entry.slot !== true || entry.boxed === true));
      const end = B.newLabel("read.end");
      ends.push(end);
      B.br(end);
    }
    for (const [i, end] of ends.entries()) {
      B.startBlock(end);
      for (const entry of armSlots[1 - i]!) B.line(`store ptr null, ptr ${entry.name}`);
      B.br(join);
    }
    for (const entries of armSlots)
      for (const entry of entries)
        emitter.ownSlot(entry.name, entry.type, entry.rarelyFilled === true);
    B.startBlock(join);
    const value = B.tmp();
    B.line(`${value} = load ptr, ptr ${slot}`);
    return { name: value, type: e.type };
  }
  // Scalar optional values and register results answer a private stack
  // box. A ternary of borrowable arms above keeps lending its arm.
  if (
    (e.kind === "optChain" ||
      e.kind === "nullish" ||
      e.kind === "ternary" ||
      e.kind === "arrIntrinsic") &&
    isScalarOptionalSource(e, emitter.unionSources)
  )
    return emitScalarOptional(emitter, e);
  if (e.kind === "call" && emitter.scalarResultCall(e))
    return emitCallExpr(emitter, e, false, true);
  if (e.kind === "call" && emitter.canBorrowReceiver(e)) return emitBorrowedResultCall(emitter, e);
  return emitter.emitExpr(e);
}

/** A local stable binding keeps its value alive while later arguments
 * and the callee execute. A proven local union box cannot escape or be
 * rebound during a call; its independent payload owner keeps it alive.
 * Other writable bindings need an owned snapshot. */
export function canBorrowCallArgument(emitter: LlEmitter, value: IrExpr): boolean {
  if (value.kind === "strLit") return true;
  // An exact capsule owns its instance while the capsule's binding holds it.
  if (value.kind === "dynCheck" && value.exact)
    return value.value.kind === "varRef" && emitter.canBorrowCallArgument(value.value);
  // An inline union field has no box to lend.
  if (emitter.inlineFieldGet(value)) return false;
  // Class casts reinterpret the same pointer (prefix layouts).
  if ((value.kind === "upcast" || value.kind === "downcast") && value.value.type.kind === "object")
    return emitter.canBorrowCallArgument(value.value);
  if (value.kind === "seqExpr") {
    const guarded = guardedValue(value);
    return guarded !== null && emitter.canBorrowCallArgument(guarded);
  }
  // A nullable-union wrap reinterprets its payload pointer; an immortal
  // unit constant needs no owner at all.
  const wrap = emitter.borrowableNullableWrap(value);
  if (wrap === "unit") return true;
  if (wrap === "ref" && value.kind === "unionWrap")
    return emitter.canBorrowCallArgument(value.value);
  // Checked casts (`x as C`, `x!` on a nullable) lower to a ternary whose
  // failing arm always throws; the successful arm projects the same
  // stable owner. The throwing arm's typed dummy owns nothing.
  if (value.kind === "unionNarrow") return emitter.canBorrowCallArgument(value.value);
  if (value.kind === "libCall") return value.fn === "error.nodeThrow";
  // A final field never changes outside constructors: while its object is
  // borrowable, so is the field's value. Nullable-pointer fields have no
  // box to lend and keep their owning path.
  if (
    value.kind === "fieldGet" &&
    emitter.finalFieldBorrows &&
    isRefCounted(value.type) &&
    emitter.finalFields.isFinal(value.className, value.field) &&
    !emitter.nullableFieldGet(value)
  )
    return emitter.canBorrowReceiver(value.obj) && emitter.canBorrowCallArgument(value.obj);
  if (value.kind === "ternary")
    return (
      emitter.canBorrowReceiver(value.then) &&
      emitter.canBorrowReceiver(value.else_) &&
      emitter.canBorrowCallArgument(value.then) &&
      emitter.canBorrowCallArgument(value.else_)
    );
  // A construction-only field of a stable owner keeps its value until the
  // owner dies: no later operand or callee can replace and release it.
  if ((value.kind === "fieldGet" || value.kind === "recordGet") && emitter.immutableRead(value))
    return emitter.canBorrowCallArgument(value.obj);
  // An optional chain's bound receiver stays unchanged until its body
  // finishes (see emitReadReceiver).
  if (value.kind === "chainRecv") return emitter.chainSlots.has(value.id);
  if (value.kind !== "varRef") return false;
  const binding = emitter.binding(value.localId);
  // A module constant owns its value for the rest of the program.
  if (binding.kind === "global") return emitter.stableGlobals.has(value.localId);
  // So does the environment for a capture nothing ever rebinds.
  if (binding.kind === "boxed")
    return emitter.stableCaptureIds.has(value.localId) && emitter.canBorrowReceiver(value);
  return (
    binding.kind === "local" &&
    binding.local !== undefined &&
    (!binding.local.mutable ||
      emitter.stableCallBindings.has(value.localId) ||
      emitter.borrowedParameters.has(value.localId) ||
      emitter.localUnionStorage.has(value.localId)) &&
    !binding.local.boxed &&
    !binding.local.tdz
  );
}

export function canBorrowReceiver(emitter: LlEmitter, e: IrExpr): boolean {
  switch (e.kind) {
    case "chainRecv":
      return emitter.chainSlots.has(e.id);
    case "varRef": {
      const binding = emitter.binding(e.localId);
      return (
        binding.kind !== "boxed" ||
        (!binding.local!.tdz &&
          binding.type.kind === e.type.kind &&
          e.type.kind !== "caught" &&
          isRefCounted(e.type))
      );
    }
    case "unionNarrow":
    // Class casts reinterpret the same pointer (prefix layouts).
    case "downcast":
    case "upcast":
      return emitter.canBorrowReceiver(e.value);
    // An inline union field has no box to lend: projections read it
    // through emitReadReceiver's private stack box.
    case "fieldGet":
    case "recordGet":
      return !emitter.inlineFieldGet(e) && emitter.canBorrowReceiver(e.obj);
    case "ternary":
      return emitter.canBorrowReceiver(e.then) && emitter.canBorrowReceiver(e.else_);
    case "seqExpr": {
      const guarded = guardedValue(e);
      return guarded !== null && emitter.canBorrowReceiver(guarded);
    }
    // The runtime always sets a pending exception; its unreachable
    // typed dummy is null and owns no receiver.
    case "libCall":
      return e.fn === "error.nodeThrow";
    case "unionWrap": {
      const wrap = emitter.borrowableNullableWrap(e);
      return wrap === "unit" || (wrap === "ref" && emitter.canBorrowReceiver(e.value));
    }
    // A borrowed-return result stays reachable from its borrowed
    // arguments until the consumer runs. Each argument is lent without a
    // snapshot, so neither the callee nor a later argument may replace
    // what it was read from: a callee that preserves every edge cannot,
    // and any other one must leave the argument's locations unwritten.
    // A keyed read lends the stored pointer while the record keeps it.
    case "recordKeyGet":
      return (
        pointerRecordKeyGet(emitter, e) &&
        emitter.canBorrowReceiver(e.obj) &&
        emitter.referenceEffects.preserves(e.key)
      );
    // `r[k] ?? inherited(r, k)` lends a hit the same way; its default is
    // owned by the statement frame (so never by a longer-lived alias).
    case "nullish": {
      const read = borrowedRecordKeyGetOr(emitter, e);
      return read !== null && emitter.canBorrowReceiver(read);
    }
    // So does a Map.get while the map keeps it.
    case "mapIntrinsic":
      return (
        pointerMapGet(emitter, e) &&
        emitter.canBorrowReceiver(e.receiver) &&
        emitter.referenceEffects.preserves(e.args[0]!)
      );
    case "call": {
      // A checked extraction lends the payload of the union it narrows
      // (emitCheckedNarrowReceiver).
      if (borrowsCheckedNarrow(emitter, e)) {
        const narrow = emitter.checkedNarrows.get(e)!;
        return emitter.canBorrowReceiver(narrow.value);
      }
      if (!emitter.borrowedReturns.has(e.callee)) return false;
      if (!e.args.every((arg) => emitter.referenceEffects.preserves(arg))) return false;
      const preserving = emitter.referenceEffects.functions.has(e.callee);
      if (preserving)
        return e.args.every((arg) => !isRefCounted(arg.type) || emitter.canBorrowReceiver(arg));
      if (emitter.referenceWrites === null) return false;
      const lent = borrowableInputs(
        emitter,
        e.args,
        false,
        emitter.referenceWrites.summary(e.callee),
      );
      return e.args.every((arg, i) => !isRefCounted(arg.type) || lent[i] === true);
    }
    // A required element read: the (borrowed) array owns the element
    // while an edge-preserving index computes.
    case "arrayGet":
      return (
        e.arr.type.kind === "array" &&
        isRefCounted(e.arr.type.elem) &&
        emitter.canBorrowReceiver(e.arr) &&
        emitter.referenceEffects.preserves(e.index)
      );
    default:
      return false;
  }
}

/** Functions returning a walk of their borrowed parameters return it
 * without a reference (+0) from their borrowing body; direct callers
 * either consume it as a receiver/walk or retain it at once, and the owned
 * adapter retains before releasing its parameters. Candidates preserve
 * every heap edge (so the result stays reachable from the arguments),
 * borrow every reference parameter and return plain pointers. The set
 * grows to a fixpoint because a call to a borrowed-return function with
 * walk arguments is itself a walk; walk facts are then recomputed with
 * the final set, admitting only parameters whose convention borrows. */
export function analyzeBorrowedReturns(emitter: LlEmitter): void {
  const pointer = (type: IrType): boolean => emitter.plainReference(type);
  const borrowedIds = (fn: IrFunction): Set<string> => {
    const indexes = emitter.callLifetimes.borrowed.get(fn.name);
    return new Set(fn.params.filter((_, i) => indexes?.has(i)).map((p) => p.localId));
  };
  const hostFor = (fn: IrFunction): WalkBorrowHost => {
    const allowed = borrowedIds(fn);
    const host = {
      pointerLocal: (local: IrLocal) => pointer(local.type),
      borrowsWithoutOwning: (e: IrExpr) => emitter.borrowsWithoutOwning(e),
      borrowedReturn: (callee: string) => emitter.borrowedReturns.has(callee),
      parameterAllowed: (id: string) => allowed.has(id),
      nodes: emitter.nodeIndex,
    };
    return emitter.referenceEffects.functions.has(fn.name)
      ? host
      : emitter.unwrittenWalkHost(fn, host);
  };
  // With ReferenceWrites, a body that writes none of its walks' locations
  // qualifies like one that preserves every edge.
  const preserving = [...emitter.fnByName.values()].filter(
    (fn) => emitter.referenceEffects.functions.has(fn.name) || emitter.referenceWrites !== null,
  );
  const candidates = preserving.filter((fn) => {
    if (!pointer(fn.returnType) || fn.async || fn.generator || fn.captures) return false;
    // A borrowing vtable slot dispatches to the borrowing body (or its
    // virtual adapter) directly, and virtual callers own the result.
    if (emitter.implSlotBorrowed(fn.name).size > 0) return false;
    const indexes = emitter.callLifetimes.borrowed.get(fn.name);
    return (
      indexes !== undefined &&
      indexes.size > 0 &&
      fn.params.every((p, i) => !isRefCounted(p.type) || indexes.has(i))
    );
  });
  for (let changed = true; changed;) {
    changed = false;
    for (const fn of candidates) {
      if (emitter.borrowedReturns.has(fn.name)) continue;
      if (!analyzeWalks(fn, hostFor(fn)).returnsWalk) continue;
      emitter.borrowedReturns.add(fn.name);
      // Nested borrowed returns extend the locations a caller depends on.
      emitter.borrowedReturnKeyCache.clear();
      changed = true;
    }
  }
  if (emitter.borrowedReturns.size === 0) return;
  for (const fn of preserving) {
    const walks = analyzeWalks(fn, hostFor(fn)).locals;
    if (walks.size > 0) emitter.walkBorrowsByFunction.set(fn.name, walks);
  }
}

export function fieldAliasMetadata(emitter: LlEmitter): string[] {
  if (emitter.fieldAliasTags.size === 0) return [];
  const lines = ['!0 = !{!"scriptc native fields"}'];
  for (const tag of emitter.fieldAliasTags.values()) {
    lines.push(
      `!${tag - 1} = !{!"field.${tag}", !0, i64 0}`,
      `!${tag} = !{!${tag - 1}, !${tag - 1}, i64 0}`,
    );
  }
  return lines;
}

/** A private stack union source with an independently owned payload. */
export function canStackReceiver(emitter: LlEmitter, e: IrExpr): boolean {
  return emitter.isStackUnionSource(e);
}

/** True for union sources that emitReadReceiver can produce as a private
 * stack box with an independently owned payload (no heap union). */
export function isStackUnionSource(emitter: LlEmitter, e: IrExpr): boolean {
  if (e.type.kind !== "union") return false;
  return (
    canStackUnion(e, emitter.boxedUnionsById) ||
    matchMapRead(e, emitter.boxedUnionsById) !== null ||
    emitter.optionalArrayReads.get(e) !== null ||
    isScalarOptionalSource(e, emitter.unionSources) ||
    emitter.scalarResultCall(e) ||
    emitter.inlineFieldGet(e) ||
    scalarRecordKeyGet(emitter, e)
  );
}
