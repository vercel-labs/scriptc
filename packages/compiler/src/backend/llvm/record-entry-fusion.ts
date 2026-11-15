/* Record get-then-set fusion.
 *
 * `counts[k] = (counts[k] ?? 0) + 1` probes the overflow map twice for one
 * key: the read resolves the entry (scr_map_get_str_f64) and the write
 * resolves it again (scr_map_set_str_f64), and because the object and the
 * key are each evaluated by their own statement, the pair takes a
 * retain/release round on both. A typed Map<string, number> with the same
 * update is fused (map-entry-fusion.ts) and keeps a single probe.
 *
 * When the write's value contains exactly one fusable read and that read
 * names the very same object and key bindings, the read parks the overflow
 * map, the key and the entry in function-local slots, and the write
 * overwrites the entry's value slot in place. Every other shape — a miss,
 * a shape with declared fields, an unfused read — takes the ordinary set.
 * An existing key's overwrite keeps its position, so insertion order is
 * unchanged; a miss inserts at the end, exactly like the set.
 *
 * The entry is valid until the next mutation of its map, so the value
 * expression between the read and the write must be inert: it runs no user
 * code (no getters, no calls) and mutates no collection. Shapes whose reads
 * can run accessors (accessorOrder), that can be frozen (freezable, or
 * published), that declare any field (those dispatch before the overflow
 * map), or whose index value is not a scalar number/boolean are left
 * ordinary. The parked object and key need no identity check the way a Map
 * write does: the write names the same bindings, and an inert value
 * expression cannot rebind them or mutate the record.
 */
import { type IrExpr, type IrFunction, type IrStmt, type IrType, typeEquals } from "../../ir/ir.js";
import { everyExprChild, everyStmtChild } from "../../ir/traverse.js";
import type { LlvmEmitterContext } from "./expr-context.js";
import { alwaysEvaluates, inert } from "./map-entry-fusion.js";
import { emitNumberMapSlot } from "./map-number-lookup.js";

type RecordGet = Extract<IrExpr, { kind: "recordKeyGet" }>;
type RecordSet = Extract<IrStmt, { kind: "recordKeySet" }>;

/** One fused read/write pair. The slots exist once the read emits through
 * the entry path; a write whose read took another path stays ordinary. */
export interface RecordEntryPair {
  slots: { map: string; key: string; entry: string } | null;
}

export interface RecordEntryFusion {
  reads: Map<IrExpr, RecordEntryPair>;
  writes: Map<IrStmt, RecordEntryPair>;
}

/** Whether `type` can surface a hit of type `iv` (the C helper's
 * `surface`): the same type, or a union with a matching arm. */
function surfaceable(host: LlvmEmitterContext, type: IrType, iv: IrType): boolean {
  if (typeEquals(type, iv)) return true;
  if (type.kind !== "union") return false;
  const def = host.unionsById.get(type.unionId);
  return def !== undefined && def.arms.some((arm) => typeEquals(arm, iv));
}

/** A record read this pass can fuse: a pure dictionary shape (no declared
 * fields, a scalar index signature, no accessors, not freezable), read
 * through variable bindings for the object and the key. */
function fusableRead(host: LlvmEmitterContext, e: IrExpr): e is RecordGet {
  if (e.kind !== "recordKeyGet") return false;
  if (e.obj.kind !== "varRef" || e.key.kind !== "varRef") return false;
  const shape = host.recordShape(e.shapeId);
  if (shape.fields.length > 0) return false;
  if (shape.accessorOrder !== undefined || shape.freezable === true) return false;
  if (host.publishedTypes?.recordGuarded(e.shapeId) === true) return false;
  const iv = shape.indexValue;
  if (!iv || (iv.kind !== "f64" && iv.kind !== "bool")) return false;
  return surfaceable(host, e.type, iv);
}

/** The single record read of `e`, if exactly one. */
function soleRead(host: LlvmEmitterContext, e: IrExpr): RecordGet | null {
  let found: RecordGet | null = null;
  let count = 0;
  const visit = (node: IrExpr): boolean => {
    if (node.kind === "recordKeyGet") {
      count++;
      if (fusableRead(host, node)) found = node;
    }
    return everyExprChild(node, visit, () => true);
  };
  visit(e);
  return count === 1 ? found : null;
}

/** Same object and key bindings on both sides, and the same shape. */
function sameBindings(read: RecordGet, write: RecordSet): boolean {
  return (
    read.shapeId === write.shapeId &&
    read.obj.kind === "varRef" &&
    write.obj.kind === "varRef" &&
    read.key.kind === "varRef" &&
    write.key.kind === "varRef" &&
    read.obj.localId === write.obj.localId &&
    read.key.localId === write.key.localId
  );
}

/** Find the fusable read/write pairs of one function. Coroutines keep their
 * frames in their own storage and are left alone. */
export function findRecordEntryFusions(
  host: LlvmEmitterContext,
  fn: IrFunction,
): RecordEntryFusion {
  const out: RecordEntryFusion = { reads: new Map(), writes: new Map() };
  if (fn.async || fn.generator) return out;
  const pair = (read: RecordGet, write: RecordSet): void => {
    if (out.reads.has(read) || out.writes.has(write)) return;
    const iv = host.recordShape(read.shapeId).indexValue!;
    // The value moves into the index slot with the very same scalar type.
    if (!typeEquals(write.value.type, iv)) return;
    const entry: RecordEntryPair = { slots: null };
    out.reads.set(read, entry);
    out.writes.set(write, entry);
  };
  const visitList = (list: readonly IrStmt[]): void => {
    for (const s of list) {
      // counts[k] = ...counts[k]...: the read is the only one and runs
      // unconditionally; nothing between it and the write mutates.
      if (s.kind === "recordKeySet") {
        const read = soleRead(host, s.value);
        if (read && sameBindings(read, s) && alwaysEvaluates(s.value, read) && inert(s.value, read))
          pair(read, s);
      }
    }
    for (const s of list) visitStmt(s);
  };
  const visitStmt = (s: IrStmt): void => {
    switch (s.kind) {
      case "if":
        visitList(s.then);
        if (s.else_) visitList(s.else_);
        return;
      case "while":
      case "doWhile":
      case "forOf":
      case "block":
        visitList(s.body);
        return;
      case "for":
        visitList(s.body);
        return;
      case "switch":
        for (const c of s.cases) visitList(c.body);
        return;
      case "tryCatch":
        visitList(s.tryBody);
        if (s.catchBody) visitList(s.catchBody);
        if (s.finallyBody) visitList(s.finallyBody);
        return;
      default:
        everyStmtChild(
          s,
          () => true,
          (child) => (visitStmt(child), true),
        );
    }
  };
  visitList(fn.body);
  return out;
}

/** After a fused read resolved `entry` for `key` in the record's overflow
 * `map`: park all three for the paired write. */
export function rememberRecordEntry(
  host: LlvmEmitterContext,
  read: IrExpr,
  map: string,
  key: string,
  entry: string,
): void {
  const pair = host.recordEntryFusion?.reads.get(read);
  if (!pair) return;
  const B = host.B;
  if (pair.slots === null) {
    const slots = { map: B.slot(), key: B.slot(), entry: B.slot() };
    B.entryAllocas.push(
      `${slots.map} = alloca ptr ; fused record read: overflow map`,
      `${slots.key} = alloca ptr ; fused record read: key`,
      `${slots.entry} = alloca ptr ; fused record read: entry`,
      `store ptr null, ptr ${slots.entry}`,
    );
    pair.slots = slots;
  }
  const slots = pair.slots;
  B.line(`store ptr ${map}, ptr ${slots.map}`);
  B.line(`store ptr ${key}, ptr ${slots.key}`);
  B.line(`store ptr ${entry}, ptr ${slots.entry}`);
}

/** Emit a fused write: overwrite the parked entry's value in place when the
 * read found it, else run `ordinary` with the parked map and key. False
 * when `write` is not fused or its read never parked an entry (emit the
 * ordinary set). */
export function emitFusedRecordSet(
  host: LlvmEmitterContext,
  write: IrStmt,
  value: { name: string; access: "f64" | "bool" },
  ordinary: (map: string, key: string) => void,
): boolean {
  const slots = host.recordEntryFusion?.writes.get(write)?.slots;
  if (!slots) return false;
  const B = host.B;
  const entry = B.tmp();
  B.line(`${entry} = load ptr, ptr ${slots.entry}`);
  // The entry is valid only between its read and this write.
  B.line(`store ptr null, ptr ${slots.entry}`);
  const found = B.tmp();
  B.line(`${found} = icmp ne ptr ${entry}, null`);
  const hit = B.newLabel("recfuse.hit"),
    miss = B.newLabel("recfuse.miss"),
    done = B.newLabel("recfuse.done");
  B.condBr(found, hit, miss);
  B.startBlock(hit);
  const slot = B.tmp(),
    bits = B.tmp();
  B.line(`${slot} = getelementptr inbounds %ScrMapEntry, ptr ${entry}, i32 0, i32 1`);
  if (value.access === "f64") B.line(`${bits} = bitcast double ${value.name} to i64`);
  else B.line(`${bits} = zext i1 ${value.name} to i64`);
  B.line(`store i64 ${bits}, ptr ${slot}`);
  B.br(done);
  B.startBlock(miss);
  const map = B.tmp(),
    key = B.tmp();
  B.line(`${map} = load ptr, ptr ${slots.map}`);
  B.line(`${key} = load ptr, ptr ${slots.key}`);
  ordinary(map, key);
  B.br(done);
  B.startBlock(done);
  return true;
}

/** A fused read's value from the parked entry: the entry's value word, as
 * the index type's own LLVM type. */
export function fusedRecordValue(
  host: LlvmEmitterContext,
  entry: string,
  kind: "f64" | "bool",
): string {
  const B = host.B;
  const bits = emitNumberMapSlot(host, entry, "i64");
  if (kind === "f64") {
    const raw = B.tmp();
    B.line(`${raw} = bitcast i64 ${bits} to double`);
    return raw;
  }
  const raw = B.tmp();
  B.line(`${raw} = trunc i64 ${bits} to i1`);
  return raw;
}
