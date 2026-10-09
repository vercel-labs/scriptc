import {
  isRefCounted,
  type IrExpr,
  type IrFunction,
  type IrType,
  type IrUnionDef,
} from "../../ir/ir.js";
import { everyStmtList } from "../../ir/traverse.js";
import type { CallLifetimes } from "./call-lifetimes.js";
import type { LlvmEmitterContext } from "./expr-context.js";
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

function supportedSource(
  expr: IrExpr,
  type: IrType,
  unions: ReadonlyMap<string, IrUnionDef>,
  nullableField: CopiedUnionSource,
): boolean {
  if (expr.kind === "ternary")
    return (
      supportedSource(expr.then, type, unions, nullableField) &&
      supportedSource(expr.else_, type, unions, nullableField)
    );
  return (
    canStackUnion(expr, unions) ||
    matchMapRead(expr, unions) !== null ||
    nullableField(expr) ||
    isUnionCopy(expr, type)
  );
}

/** A local box may change tags without escaping. Reject a binding as a
 * whole if any write cannot produce a fresh, independently owned snapshot.
 * Assignment expressions and captured or externally visible boxes are
 * excluded by the projection-use proof. */
export function findLocalUnionStorage(
  fn: IrFunction,
  lifetimes: CallLifetimes,
  unions: ReadonlyMap<string, IrUnionDef>,
  nullableField: CopiedUnionSource = () => false,
): Map<string, LocalUnionStorageProof> {
  const types = new Map(fn.locals.map((local) => [local.id, local.type]));
  const result = new Map<string, LocalUnionStorageProof>();
  const safe = lifetimes.projectedLocals.get(fn.name);
  if (!safe?.size) return result;
  for (const local of fn.locals) {
    if (local.type.kind !== "union" || !safe.has(local.id)) continue;
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
        if (!value || !type || !supportedSource(value, type, unions, nullableField))
          result.delete(stmt.localId);
      }
      return true;
    },
  });
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
  if (expr.kind === "ternary") {
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
      host.releaseFrame(host.frames.pop()!);
      B.br(join);
    }
    B.startBlock(join);
    return;
  }
  let source: string;
  let owner = "null";
  if (host.nullableFieldGet(expr) !== null) {
    const copied = host.emitOwnedNullableStack(expr);
    source = copied.box;
    owner = copied.owner.name;
    host.moveTemp(copied.owner);
  } else if (expr.kind === "varRef" && !canStackUnion(expr, host.unionsById)) {
    // A copy of another binding: snapshot the tag and bits, and retain the
    // reference payload (scalar and unit arms own nothing).
    source = host.emitReadReceiver(expr).name;
    if (storage.ownerType) {
      const def = host.unionsById.get(expr.type.kind === "union" ? expr.type.unionId : "")!;
      const refTag = def.arms.findIndex(isRefCounted);
      // Not every retain entry point is NULL-tolerant: branch on the tag.
      const tag = host.unionTag(source);
      const isRef = B.tmp(),
        held = B.slot();
      B.entryAllocas.push(`${held} = alloca ptr`);
      const yes = B.newLabel("union.copy.ref"),
        join = B.newLabel("union.copy.join");
      B.line(`store ptr null, ptr ${held}`);
      B.line(`${isRef} = icmp eq i32 ${tag}, ${refTag}`);
      B.condBr(isRef, yes, join);
      B.startBlock(yes);
      const retained = host.retainValue(host.unionPeek(source), storage.ownerType);
      B.line(`store ptr ${retained}, ptr ${held}`);
      B.br(join);
      B.startBlock(join);
      owner = B.tmp();
      B.line(`${owner} = load ptr, ptr ${held}`);
    }
  } else if (canStackUnion(expr, host.unionsById)) {
    const wrapped = emitStackUnion(host, expr);
    source = wrapped.value.name;
    if (wrapped.payload) {
      owner = wrapped.payload.name;
      host.moveTemp(wrapped.payload);
    }
  } else {
    const read = matchMapRead(expr, host.unionsById)!;
    const lookup = emitStackMapRead(host, read);
    source = lookup.value.name;
    if (lookup.owner) {
      owner = B.tmp();
      B.line(`${owner} = load ptr, ptr ${lookup.owner.slot}`);
    }
  }
  const tag = host.unionTag(source);
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
    host.releaseValue(old, storage.ownerType);
  }
}
