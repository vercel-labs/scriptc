import { undefinedArmTag } from "../../ir/analysis.js";
import {
  isRefCounted,
  isUnitType,
  type IrExpr,
  type IrFunction,
  type IrType,
  type IrUnionDef,
} from "../../ir/ir.js";
import { everyStmtList } from "../../ir/traverse.js";
import type { CallLifetimes } from "./call-lifetimes.js";
import { emitArrIntrinsic } from "./expr-containers.js";
import { emitOptionalChainReceiver } from "./expr-control.js";
import type { ExprOf, LlValue, LlvmEmitterContext } from "./expr-context.js";
import { emitLocalArrayRead } from "./local-array-reads.js";
import { emitStackMapRead, matchMapRead } from "./map-read-lifetimes.js";
import { canStackUnion, emitStackUnion } from "./stack-unions.js";

export interface LocalUnionStorageProof {
  /** At most one reference arm gives the local one nullable payload owner.
   * Scalars and unit arms clear that owner independently of the data bits. */
  ownerType: IrType | null;
}

/** A union source the local can snapshot with its own payload owner:
 * wraps and map reads (existing owners), nullable-pointer field reads, and
 * copies of another binding of the same union (both retain the payload). */
export type CopiedUnionSource = (expr: IrExpr) => boolean;

function isUnionCopy(expr: IrExpr, type: IrType): boolean {
  return (
    expr.kind === "varRef" &&
    expr.type.kind === "union" &&
    type.kind === "union" &&
    expr.type.unionId === type.unionId
  );
}

/** The union sources a binding or projection can snapshot. */
export interface UnionSources {
  /** The tagged-box unions a stack box can hold. */
  unions: ReadonlyMap<string, IrUnionDef>;
  /** Every union, including nullable-pointer receivers of `a?.b`. */
  receiverUnions: ReadonlyMap<string, IrUnionDef>;
  /** Nullable-pointer field reads (copied with their own owner). */
  nullableField: CopiedUnionSource;
  /** Inline scalar-union field reads (copied bits, nothing owned). */
  inlineField: CopiedUnionSource;
  /** Optional array element reads (OptionalArrayReads). */
  arrayRead: CopiedUnionSource;
  /** Direct calls returning a scalar union in registers (Int32Abi.union). */
  scalarCall: CopiedUnionSource;
}

/** Every arm is a number, a boolean or a unit value: the box owns nothing,
 * so its tag and payload bits are the whole value. */
function isScalarUnion(type: IrType, unions: ReadonlyMap<string, IrUnionDef>): boolean {
  if (type.kind !== "union") return false;
  const arms = unions.get(type.unionId)?.arms;
  return (
    arms !== undefined &&
    arms.every((arm) => arm.kind === "f64" || arm.kind === "bool" || isUnitType(arm))
  );
}

function sameUnion(expr: IrExpr, type: IrType): boolean {
  return expr.type.kind === "union" && type.kind === "union" && expr.type.unionId === type.unionId;
}

/** `a?.b`, pass-through `a ?? b`, `c ? a : b` and `pop()`/`shift()` of
 * number or boolean elements, as a scalar union built from other sources
 * in a private stack box. Ownerless payloads make every snapshot a copy of
 * bits, so no heap box is needed while consumers only project. */
export function isScalarOptionalSource(expr: IrExpr, sources: UnionSources): boolean {
  if (!isScalarUnion(expr.type, sources.unions)) return false;
  if (expr.kind === "arrIntrinsic")
    return (
      (expr.method === "pop" || expr.method === "shift") &&
      expr.receiver.type.kind === "array" &&
      (expr.receiver.type.elem.kind === "f64" || expr.receiver.type.elem.kind === "bool")
    );
  if (expr.kind === "optChain") {
    if (expr.receiver.type.kind !== "union") return false;
    const arms = sources.receiverUnions.get(expr.receiver.type.unionId)?.arms;
    return (
      arms !== undefined &&
      arms.filter((arm) => !isUnitType(arm)).length === 1 &&
      undefinedArmTag(expr.type, sources.unions) >= 0 &&
      supportedSource(expr.body, expr.type, sources)
    );
  }
  if (expr.kind === "ternary")
    return (
      supportedSource(expr.then, expr.type, sources) &&
      supportedSource(expr.else_, expr.type, sources)
    );
  return (
    expr.kind === "nullish" &&
    supportedSource(expr.left, expr.type, sources) &&
    supportedSource(expr.right, expr.type, sources)
  );
}

function supportedSource(expr: IrExpr, type: IrType, sources: UnionSources): boolean {
  if (!sameUnion(expr, type)) return false;
  if (sources.arrayRead(expr)) return true;
  if (expr.kind === "ternary")
    return supportedSource(expr.then, type, sources) && supportedSource(expr.else_, type, sources);
  return (
    canStackUnion(expr, sources.unions) ||
    matchMapRead(expr, sources.unions) !== null ||
    sources.nullableField(expr) ||
    sources.inlineField(expr) ||
    isUnionCopy(expr, type) ||
    isScalarOptionalSource(expr, sources) ||
    sources.scalarCall(expr)
  );
}

/** A local box may change tags without escaping. Reject a binding as a
 * whole if any write cannot produce a fresh, independently owned snapshot.
 * Assignment expressions and captured or externally visible boxes are
 * excluded by the projection-use proof. */
export function findLocalUnionStorage(
  fn: IrFunction,
  lifetimes: CallLifetimes,
  sources: UnionSources,
): Map<string, LocalUnionStorageProof> {
  const unions = sources.unions;
  const types = new Map(fn.locals.map((local) => [local.id, local.type]));
  const result = new Map<string, LocalUnionStorageProof>();
  const safe = lifetimes.projectedLocals.get(fn.name);
  const copied = lifetimes.copiedLocals.get(fn.name);
  if (!safe?.size && !copied?.size) return result;
  for (const local of fn.locals) {
    if (local.type.kind !== "union" || !(safe?.has(local.id) || copied?.has(local.id))) continue;
    const arms = unions.get(local.type.unionId)?.arms;
    if (!arms) continue;
    const refs = arms.filter(isRefCounted);
    if (refs.length <= 1) result.set(local.id, { ownerType: refs[0] ?? null });
  }
  everyStmtList(fn.body, {
    expr: () => true,
    stmt: (stmt) => {
      if (stmt.kind === "varDecl" || stmt.kind === "assign") {
        const value = stmt.kind === "varDecl" ? stmt.init : stmt.value;
        const type = types.get(stmt.localId);
        if (!value || !type || !supportedSource(value, type, sources)) result.delete(stmt.localId);
      }
      return true;
    },
  });
  // A copied local's box stays private only while every local it is copied
  // to snapshots the copy's tag and bits: one that keeps the box pointer
  // makes the source a heap box again, which can cascade along the copies.
  for (let changed = copied !== undefined; changed;) {
    changed = false;
    for (const [id, targets] of copied!) {
      if (result.has(id) && !targets.every((target) => result.has(target))) {
        result.delete(id);
        changed = true;
      }
    }
  }
  return result;
}

export interface LocalUnionStorage {
  box: string;
  tag: string;
  payload: string;
  owner: string | null;
  ownerType: IrType | null;
}

export function allocateLocalUnion(
  host: LlvmEmitterContext,
  proof: LocalUnionStorageProof,
): LocalUnionStorage {
  const B = host.B;
  const box = B.slot(),
    tag = B.slot(),
    payload = B.slot();
  B.entryAllocas.push(`${box} = alloca %ScrUnion`);
  B.entryAllocas.push(`${tag} = getelementptr inbounds %ScrUnion, ptr ${box}, i32 0, i32 1`);
  B.entryAllocas.push(`${payload} = getelementptr inbounds %ScrUnion, ptr ${box}, i32 0, i32 5`);
  const owner = proof.ownerType ? B.slot() : null;
  if (owner) {
    B.entryAllocas.push(`${owner} = alloca ptr`);
    B.line(`store ptr null, ptr ${owner}`);
  }
  return { box, tag, payload, owner, ownerType: proof.ownerType };
}

/** Evaluate the new snapshot before touching the previous owner, so a
 * throwing initializer or lookup leaves the old value available to cleanup.
 * Publish before releasing the old payload; no heap edge points at the box. */
export function storeLocalUnion(
  host: LlvmEmitterContext,
  storage: LocalUnionStorage,
  expr: IrExpr,
): void {
  const B = host.B;
  const read = host.optionalArrayReads.get(expr);
  if (expr.kind === "ternary" && read === null) {
    const cond = host.emitExpr(expr.cond);
    const yes = B.newLabel("union.then"),
      no = B.newLabel("union.else"),
      join = B.newLabel("union.join");
    B.condBr(cond.name, yes, no);
    for (const [label, value] of [
      [yes, expr.then],
      [no, expr.else_],
    ] as const) {
      B.startBlock(label);
      host.frames.push([]);
      storeLocalUnion(host, storage, value);
      host.releaseTemps(host.frames.pop()!);
      B.br(join);
    }
    B.startBlock(join);
    return;
  }
  let source: string;
  let owner = "null";
  // Local union storage holds tagged boxes only (the analysis runs over the
  // boxed union table), and every source has the binding's own union.
  const unionId = expr.type.kind === "union" ? expr.type.unionId : "";
  host.requireBoxedUnion(unionId);
  if (read) {
    // The snapshot owns its reference element, if any; a missing element
    // leaves a NULL owner.
    const slot = B.slot();
    B.entryAllocas.push(`${slot} = alloca ptr`);
    const owned = emitLocalArrayRead(host, { ...read, borrow: false }, slot);
    source = B.tmp();
    B.line(`${source} = load ptr, ptr ${slot}`);
    if (owned) {
      owner = B.tmp();
      B.line(`${owner} = load ptr, ptr ${owned.slot}`);
    }
  } else if (
    expr.kind === "optChain" ||
    expr.kind === "nullish" ||
    expr.kind === "call" ||
    expr.kind === "arrIntrinsic"
  ) {
    // Scalar optional sources and register results: a private stack box.
    source = host.emitReadReceiver(expr).name;
  } else if (host.inlineFieldGet(expr)) {
    // A private stack copy of the slot's tag and bits; nothing is owned.
    source = host.emitReadReceiver(expr).name;
  } else if (host.nullableFieldGet(expr) !== null) {
    const copied = host.emitOwnedNullableStack(expr);
    source = copied.box;
    owner = copied.owner.name;
    host.toFrame(copied.owner);
  } else if (expr.kind === "varRef" && !canStackUnion(expr, host.boxedUnionsById)) {
    // A copy of another binding: snapshot the tag and bits, and retain the
    // reference payload (scalar and unit arms own nothing).
    source = host.emitReadReceiver(expr).name;
    if (storage.ownerType) {
      const def = host.unionsById.get(expr.type.kind === "union" ? expr.type.unionId : "")!;
      const refTag = def.arms.findIndex(isRefCounted);
      // Not every retain entry point is NULL-tolerant: branch on the tag.
      const tag = host.unionTag(source, unionId);
      const isRef = B.tmp(),
        held = B.slot();
      B.entryAllocas.push(`${held} = alloca ptr`);
      const yes = B.newLabel("union.copy.ref"),
        join = B.newLabel("union.copy.join");
      B.line(`store ptr null, ptr ${held}`);
      B.line(`${isRef} = icmp eq i32 ${tag}, ${refTag}`);
      B.condBr(isRef, yes, join);
      B.startBlock(yes);
      const retained = host.retainFrame(host.unionPeek(source, unionId), storage.ownerType);
      B.line(`store ptr ${retained}, ptr ${held}`);
      B.br(join);
      B.startBlock(join);
      owner = B.tmp();
      B.line(`${owner} = load ptr, ptr ${held}`);
    }
  } else if (canStackUnion(expr, host.boxedUnionsById)) {
    const wrapped = emitStackUnion(host, expr);
    source = wrapped.value.name;
    if (wrapped.payload) {
      owner = wrapped.payload.name;
      host.toFrame(wrapped.payload);
    }
  } else {
    const read = matchMapRead(expr, host.boxedUnionsById)!;
    const lookup = emitStackMapRead(host, read);
    source = lookup.value.name;
    if (lookup.owner) {
      owner = B.tmp();
      B.line(`${owner} = load ptr, ptr ${lookup.owner.slot}`);
    }
  }
  const tag = host.unionTag(source, unionId);
  const slot = B.tmp(),
    bits = B.tmp();
  B.line(`${slot} = getelementptr inbounds %ScrUnion, ptr ${source}, i32 0, i32 5`);
  B.line(`${bits} = load i64, ptr ${slot}`);
  B.line(`store i32 ${tag}, ptr ${storage.tag}`);
  B.line(`store i64 ${bits}, ptr ${storage.payload}`);
  if (storage.owner && storage.ownerType) {
    const old = B.tmp();
    B.line(`${old} = load ptr, ptr ${storage.owner}`);
    B.line(`store ptr ${owner}, ptr ${storage.owner}`);
    host.releaseFrame(old, storage.ownerType);
  }
}

/** Build a scalar optional source (isScalarOptionalSource) in a fresh
 * stack box. Operands evaluate in source order; a binding being assigned
 * is only overwritten after the whole value is known. */
export function emitScalarOptional(
  host: LlvmEmitterContext,
  expr: ExprOf<"optChain" | "nullish" | "ternary" | "arrIntrinsic">,
): LlValue {
  const B = host.B;
  const storage = allocateLocalUnion(host, { ownerType: null });
  if (expr.kind === "arrIntrinsic") return emitArrIntrinsic(host, expr, storage);
  if (expr.kind === "ternary") {
    storeLocalUnion(host, storage, expr);
    return { name: storage.box, type: expr.type };
  }
  const join = B.newLabel("optional.join");
  if (expr.kind === "optChain") {
    const { isUnit, bindPresent } = emitOptionalChainReceiver(host, expr);
    const missing = B.newLabel("optional.missing"),
      present = B.newLabel("optional.present");
    B.condBr(isUnit, missing, present);
    B.startBlock(missing);
    B.line(`store i32 ${undefinedArmTag(expr.type, host.unionsById)}, ptr ${storage.tag}`);
    B.line(`store i64 0, ptr ${storage.payload}`);
    B.br(join);
    B.startBlock(present);
    bindPresent();
    host.frames.push([]);
    storeLocalUnion(host, storage, expr.body);
    host.releaseTemps(host.frames.pop()!);
    host.chainSlots.delete(expr.id);
    B.br(join);
  } else {
    storeLocalUnion(host, storage, expr.left);
    const unionId = expr.type.kind === "union" ? expr.type.unionId : "";
    const arms = host.unionsById.get(unionId)!.arms;
    const unitTags = arms.flatMap((arm, tag) => (isUnitType(arm) ? [tag] : []));
    const fallback = B.newLabel("optional.default");
    B.condBr(host.tagInSet(storage.box, unionId, unitTags), fallback, join);
    B.startBlock(fallback);
    host.frames.push([]);
    storeLocalUnion(host, storage, expr.right);
    host.releaseTemps(host.frames.pop()!);
    B.br(join);
  }
  B.startBlock(join);
  return { name: storage.box, type: expr.type };
}
