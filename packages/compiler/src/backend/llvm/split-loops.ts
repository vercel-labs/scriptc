import { STRING, type IrExpr, type IrFunction, type IrLocal, type IrStmt } from "../../ir/ir.js";
import { everyStmtList } from "../../ir/traverse.js";
import type { LlvmEmitterContext } from "./expr-context.js";

export type StringSplit = IrExpr & { kind: "strIntrinsic" };

export function stringSplit(value: IrExpr): StringSplit | null {
  return value.kind === "strIntrinsic" && value.method === "split" ? value : null;
}

/** Stored arrays can disappear only when one loop is their entire use.
 * Count every executable reference and explicit write; captured, TDZ and
 * suspended bindings retain their ordinary representation. Frontend
 * density proofs alone are not an escape or lifetime proof. */
export function findPrivateSplitLocals(fn: IrFunction): Map<string, StringSplit> {
  const splits = new Map<string, StringSplit>();
  if (fn.async || fn.generator) return splits;
  everyStmtList(fn.body, {
    expr: () => true,
    stmt: (stmt) => {
      if (stmt.kind !== "varDecl" || !stmt.init) return true;
      const split = stringSplit(stmt.init);
      if (!split) return true;
      const local = fn.locals.find((local) => local.id === stmt.localId);
      if (local && !local.mutable && !local.boxed && !local.tdz) splits.set(stmt.localId, split);
      return true;
    },
  });
  if (splits.size === 0) return splits;
  const definitions = new Map<string, number>();
  const references = new Map<string, number>();
  const consumers = new Set<string>();
  const writes = new Set<string>();
  everyStmtList(fn.body, {
    expr: (value) => {
      if (value.kind === "varRef" && splits.has(value.localId))
        references.set(value.localId, (references.get(value.localId) ?? 0) + 1);
      if (value.kind === "closure" || value.kind === "classRef")
        for (const id of value.captures ?? []) if (splits.has(id)) writes.add(id);
      return true;
    },
    stmt: (stmt) => {
      if (stmt.kind === "varDecl" && splits.has(stmt.localId)) {
        definitions.set(stmt.localId, (definitions.get(stmt.localId) ?? 0) + 1);
      }
      if (stmt.kind === "assign" && splits.has(stmt.localId)) writes.add(stmt.localId);
      if (stmt.kind === "forOf" && stmt.iterable.kind === "varRef")
        consumers.add(stmt.iterable.localId);
      return true;
    },
  });
  for (const id of splits.keys())
    if (
      definitions.get(id) !== 1 ||
      references.get(id) !== 1 ||
      !consumers.has(id) ||
      writes.has(id)
    )
      splits.delete(id);
  return splits;
}

export interface SplitSnapshot {
  source: string;
  separator: string;
  limit: string;
}

/** Evaluate in source order, retaining even stable bindings: body updates
 * and unique-string concatenation must not alter either snapshot. Pending
 * exceptions still see frame-owned inputs until every argument succeeds. */
export function emitSplitSnapshot(host: LlvmEmitterContext, split: StringSplit): SplitSnapshot {
  const source = host.emitExpr(split.receiver);
  const separator = host.emitExpr(split.args[0]!);
  const limit = host.emitExpr(split.args[1]!);
  host.declare("declare i32 @scr_to_uint32(double)");
  const converted = host.B.tmp();
  host.B.line(`${converted} = call i32 @scr_to_uint32(double ${limit.name})`);
  return { source: source.name, separator: separator.name, limit: converted };
}

export interface StoredSplitSnapshot {
  sourceSlot: string;
  separatorSlot: string;
  limitSlot: string;
}

/** Move snapshots into the declaration's lexical scope. Their ownership
 * then participates in normal, jumping and exceptional scope cleanup. */
export function storeSplitSnapshot(
  host: LlvmEmitterContext,
  snapshot: SplitSnapshot,
): StoredSplitSnapshot {
  const sourceSlot = host.B.slot(),
    separatorSlot = host.B.slot(),
    limitSlot = host.B.slot();
  host.B.entryAllocas.push(
    `${sourceSlot} = alloca ptr`,
    `${separatorSlot} = alloca ptr`,
    `${limitSlot} = alloca i32`,
  );
  host.B.line(`store ptr ${snapshot.source}, ptr ${sourceSlot}`);
  host.B.line(`store ptr ${snapshot.separator}, ptr ${separatorSlot}`);
  host.B.line(`store i32 ${snapshot.limit}, ptr ${limitSlot}`);
  host.moveTemp({ name: snapshot.source, type: STRING });
  host.moveTemp({ name: snapshot.separator, type: STRING });
  return { sourceSlot, separatorSlot, limitSlot };
}

export function loadSplitSnapshot(
  host: LlvmEmitterContext,
  snapshot: StoredSplitSnapshot,
): SplitSnapshot {
  const source = host.B.tmp(),
    separator = host.B.tmp(),
    limit = host.B.tmp();
  host.B.line(`${source} = load ptr, ptr ${snapshot.sourceSlot}`);
  host.B.line(`${separator} = load ptr, ptr ${snapshot.separatorSlot}`);
  host.B.line(`${limit} = load i32, ptr ${snapshot.limitSlot}`);
  return { source, separator, limit };
}

/** Each loop entry restarts a split result, including repeated execution
 * of the single syntactic consumer. No cursor owns heap memory. */
export function emitSplitCursor(host: LlvmEmitterContext, snapshot: SplitSnapshot): string {
  const cursor = host.B.slot();
  host.B.entryAllocas.push(`${cursor} = alloca { ${host.sizeType}, i32, i32 }`);
  host.declare("declare void @scr_str_split_cursor_init(ptr, i32)");
  host.B.line(`call void @scr_str_split_cursor_init(ptr ${cursor}, i32 ${snapshot.limit})`);
  return cursor;
}

export function emitSplitNext(
  host: LlvmEmitterContext,
  snapshot: SplitSnapshot,
  cursor: string,
  scratch: string,
): string {
  const piece = host.B.tmp();
  host.declare("declare ptr @scr_str_split_cursor_next(ptr, ptr, ptr, ptr)");
  host.B.line(
    `${piece} = call ptr @scr_str_split_cursor_next(ptr ${snapshot.source}, ptr ${snapshot.separator}, ptr ${cursor}, ptr ${scratch})`,
  );
  return piece;
}

export function emitSplitScratch(host: LlvmEmitterContext): string {
  const scratch = host.B.slot();
  host.B.entryAllocas.push(`${scratch} = alloca ptr`);
  host.B.line(`store ptr null, ptr ${scratch}`);
  host.ownSlot(scratch, STRING);
  return scratch;
}

export interface SplitSpan {
  bytes: string;
  length: string;
  scratch: string;
}

/** A private immutable key can stay as input bytes until a string consumer
 * needs it. Captures and writes retain the ordinary eager piece binding. */
export function canDeferSplitPiece(
  loop: IrStmt & { kind: "forOf" },
  local: IrLocal | undefined,
): boolean {
  if (!local || local.mutable || local.boxed || local.tdz) return false;
  let lookup = false;
  let safe = true;
  let remaining = 320;
  everyStmtList(loop.body, {
    expr: (value) => {
      if (--remaining < 0) {
        safe = false;
        return false;
      }
      if (
        (value.kind === "closure" || value.kind === "classRef") &&
        value.captures?.includes(loop.localId)
      )
        safe = false;
      if (
        (value.kind === "assignExpr" || value.kind === "incDec") &&
        value.localId === loop.localId
      )
        safe = false;
      if (
        value.kind === "mapIntrinsic" &&
        value.method === "get" &&
        value.receiver.type.kind === "map" &&
        value.receiver.type.key.kind === "string" &&
        value.receiver.type.value.kind !== "dyn" &&
        value.args[0]?.kind === "varRef" &&
        value.args[0].localId === loop.localId
      )
        lookup = true;
      return true;
    },
    stmt: (stmt) => {
      if (--remaining < 0) {
        safe = false;
        return false;
      }
      if (
        (stmt.kind === "assign" || stmt.kind === "varDecl" || stmt.kind === "forOf") &&
        stmt.localId === loop.localId
      )
        safe = false;
      return true;
    },
  });
  return safe && lookup;
}

export function emitSplitSpanNext(
  host: LlvmEmitterContext,
  snapshot: SplitSnapshot,
  cursor: string,
  lengthSlot: string,
): string {
  const bytes = host.B.tmp();
  host.declare("declare ptr @scr_str_split_cursor_span(ptr, ptr, ptr, ptr)");
  host.B.line(
    `${bytes} = call ptr @scr_str_split_cursor_span(ptr ${snapshot.source}, ptr ${snapshot.separator}, ptr ${cursor}, ptr ${lengthSlot})`,
  );
  return bytes;
}

/** The loop slot owns exactly one materialization, on whichever control-flow
 * path first requests it. Repeated and escaping reads retain that owner. */
export function materializeSplitPiece(
  host: LlvmEmitterContext,
  localId: string,
  span: SplitSpan,
): void {
  const B = host.B;
  const slot = host.binding(localId).slot;
  const current = B.tmp(),
    absent = B.tmp();
  B.line(`${current} = load ptr, ptr ${slot}`);
  B.line(`${absent} = icmp eq ptr ${current}, null`);
  const create = B.newLabel("split.materialize"),
    ready = B.newLabel("split.ready");
  B.condBr(absent, create, ready);
  B.startBlock(create);
  const piece = B.tmp();
  host.declare(`declare ptr @scr_str_split_materialize(ptr, ${host.sizeType}, ptr)`);
  B.line(
    `${piece} = call ptr @scr_str_split_materialize(ptr ${span.bytes}, ${host.sizeType} ${span.length}, ptr ${span.scratch})`,
  );
  B.line(`store ptr ${piece}, ptr ${slot}`);
  B.br(ready);
  B.startBlock(ready);
}
