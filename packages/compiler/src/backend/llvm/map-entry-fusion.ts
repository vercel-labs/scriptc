/* Map get-then-set fusion.
 *
 * `const cur = m.get(k); m.set(k, f(cur))` and `m.set(k, (m.get(k) ?? 0) + 1)`
 * probe the hash index twice for one key. The read already resolves the
 * entry (sc_map_entry_str, map-number-lookup.ts), and an entry stays valid
 * until the next mutation of its map. When nothing that
 * runs between the read and the write can mutate any collection or run user
 * code, the write reuses that entry: the read parks the map, the key and the
 * entry in function-local slots, and the write overwrites the entry's value
 * slot in place when the map and key are the very same (identical
 * pointers) and the entry was found. Every other case, a miss
 * included, takes the ordinary set, which inserts at the end. An existing
 * key's overwrite keeps its position, so insertion order is unchanged, and a
 * key match by identity implies the SameValueZero match the set would find.
 *
 * Only scalar values (number, boolean) fuse: overwriting them releases
 * nothing, exactly like the runtime's own overwrite. String-keyed and
 * number-keyed typed maps fuse. A number key matches when its bits are the
 * read's: such keys are SameValueZero-equal, and a key that is equal with
 * other bits (-0 for 0) takes the ordinary set.
 */
import type { IrExpr, IrFunction, IrStmt } from "../../ir/ir.js";
import { everyExprChild, everyStmtChild } from "../../ir/traverse.js";
import type { LlvmEmitterContext } from "./expr-context.js";
import { borrowsMapReadInputs, borrowsMapMutationReceiver } from "./map-read-lifetimes.js";
import { mapKeyAccess } from "./shapes.js";

type MapOp = Extract<IrExpr, { kind: "mapIntrinsic" }>;

/** One fused read/write pair. The slots exist once the read emits through
 * an entry path; a write whose read took another path stays ordinary. */
export interface MapEntryPair {
  slots: { map: string; key: string; entry: string; keyType: "ptr" | "double" } | null;
}

export interface MapEntryFusion {
  reads: Map<IrExpr, MapEntryPair>;
  writes: Map<IrExpr, MapEntryPair>;
}

/** A typed string- or number-keyed Map read/write with a scalar value. */
function fusableOp(e: IrExpr, method: "get" | "set"): e is MapOp {
  if (e.kind !== "mapIntrinsic" || e.method !== method) return false;
  const receiver = e.receiver.type;
  if (receiver.kind !== "map" || receiver.key.kind === "union") return false;
  if (receiver.value.kind !== "f64" && receiver.value.kind !== "bool") return false;
  const access = mapKeyAccess(receiver.key);
  if (access !== "str" && access !== "f64") return false;
  return method === "get" ? borrowsMapReadInputs(e) : borrowsMapMutationReceiver(e);
}

/** Expression kinds that run no user code and mutate no collection or
 * reference (reads, scalar arithmetic, control within the expression, and
 * compiler-resolved throws, which leave the statement). */
const INERT_KINDS: ReadonlySet<string> = new Set([
  "numLit",
  "strLit",
  "boolLit",
  "unitLit",
  "varRef",
  "bin",
  "unary",
  "toBool",
  "logical",
  "ternary",
  "nullish",
  "orDefault",
  "strEq",
  "unionIsTag",
  "unionNarrow",
  "recordGet",
  "fieldGet",
]);

function inert(e: IrExpr, allowed: IrExpr | null): boolean {
  if (e === allowed) return true;
  if (e.kind === "mapIntrinsic") {
    if (!borrowsMapReadInputs(e) || (e.method !== "get" && e.method !== "has")) return false;
  } else if (e.kind === "libCall") {
    if (e.fn !== "error.nodeThrow") return false;
  } else if (!INERT_KINDS.has(e.kind)) return false;
  return everyExprChild(
    e,
    (child) => inert(child, allowed),
    () => false,
  );
}

/** Whether evaluating `e` always evaluates `target` (it is not behind a
 * short-circuit or a conditional arm). */
function alwaysEvaluates(e: IrExpr, target: IrExpr): boolean {
  if (e === target) return true;
  switch (e.kind) {
    case "bin":
      return alwaysEvaluates(e.left, target) || alwaysEvaluates(e.right, target);
    case "unary":
    case "toBool":
      return alwaysEvaluates(e.operand, target);
    case "logical":
    case "nullish":
    case "orDefault":
      return alwaysEvaluates(e.left, target);
    case "ternary":
      return alwaysEvaluates(e.cond, target);
    case "unionIsTag":
    case "unionNarrow":
      return alwaysEvaluates(e.value, target);
    default:
      return false;
  }
}

/** The single fusable read of `key`'s map inside `e`, if exactly one. */
function soleRead(e: IrExpr): MapOp | null {
  let found: MapOp | null = null;
  let count = 0;
  const visit = (node: IrExpr): boolean => {
    if (node.kind === "mapIntrinsic" && node.method === "get") {
      count++;
      if (fusableOp(node, "get")) found = node;
    }
    return everyExprChild(node, visit, () => true);
  };
  visit(e);
  return count === 1 ? found : null;
}

/** Same scalar value kind and key access on both sides. */
function compatible(read: MapOp, write: MapOp): boolean {
  const r = read.receiver.type,
    w = write.receiver.type;
  return (
    r.kind === "map" &&
    w.kind === "map" &&
    r.value.kind === w.value.kind &&
    mapKeyAccess(r.key) === mapKeyAccess(w.key)
  );
}

/** Find the fusable read/write pairs of one function. Coroutines keep their
 * frames in their own storage and are left alone. */
export function findMapEntryFusions(fn: IrFunction): MapEntryFusion {
  const out: MapEntryFusion = { reads: new Map(), writes: new Map() };
  if (fn.async || fn.generator) return out;
  const pair = (read: MapOp, write: MapOp): void => {
    if (!compatible(read, write) || out.reads.has(read) || out.writes.has(write)) return;
    const entry: MapEntryPair = { slots: null };
    out.reads.set(read, entry);
    out.writes.set(write, entry);
  };
  const writeOf = (s: IrStmt | undefined): MapOp | null =>
    s?.kind === "exprStmt" && fusableOp(s.expr, "set") ? s.expr : null;
  const visitList = (list: readonly IrStmt[]): void => {
    for (let i = 0; i < list.length; i++) {
      const s = list[i]!;
      // m.set(k, ...m.get(k)...): the read is the only one and runs
      // unconditionally after the receiver and key.
      const single = writeOf(s);
      if (single) {
        const read = soleRead(single.args[1]!);
        if (
          read &&
          alwaysEvaluates(single.args[1]!, read) &&
          inert(single.receiver, null) &&
          inert(single.args[0]!, null) &&
          inert(single.args[1]!, read)
        )
          pair(read, single);
      }
      // const cur = m.get(k); m.set(k, ...): the read is the declaration's
      // whole initializer, and the write follows directly.
      const value =
        s.kind === "varDecl" ? s.init : s.kind === "assign" && !s.initializes ? s.value : null;
      const next = writeOf(list[i + 1]);
      if (
        value &&
        next &&
        fusableOp(value, "get") &&
        inert(value.receiver, null) &&
        inert(value.args[0]!, null) &&
        inert(next.receiver, null) &&
        next.args.every((arg) => inert(arg, null))
      )
        pair(value, next);
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

/** After a fused read resolved `entry` for `key` in `map`: park all three
 * for the paired write. `keyType` is the key's LLVM type: a string's ptr or
 * a number's double. */
export function rememberMapEntry(
  host: LlvmEmitterContext,
  read: IrExpr,
  map: string,
  key: string,
  entry: string,
  keyType: "ptr" | "double" = "ptr",
): void {
  const pair = host.mapEntryFusion?.reads.get(read);
  if (!pair) return;
  const B = host.B;
  if (pair.slots === null) {
    const slots = { map: B.slot(), key: B.slot(), entry: B.slot(), keyType };
    B.entryAllocas.push(
      `${slots.map} = alloca ptr ; fused map read: map`,
      `${slots.key} = alloca ${keyType} ; fused map read: key`,
      `${slots.entry} = alloca ptr ; fused map read: entry`,
      `store ptr null, ptr ${slots.entry}`,
    );
    pair.slots = slots;
  }
  const slots = pair.slots;
  B.line(`store ptr ${map}, ptr ${slots.map}`);
  B.line(`store ${slots.keyType} ${key}, ptr ${slots.key}`);
  B.line(`store ptr ${entry}, ptr ${slots.entry}`);
}

/** Emit a fused write: overwrite the parked entry's value in place when it
 * belongs to this map and key, else run `ordinary`. False when `write` is
 * not fused or its read never parked an entry (emit the ordinary set). */
export function emitFusedMapSet(
  host: LlvmEmitterContext,
  write: IrExpr,
  map: string,
  key: string,
  value: { name: string; access: "f64" | "bool" },
  ordinary: () => void,
): boolean {
  const slots = host.mapEntryFusion?.writes.get(write)?.slots;
  if (!slots) return false;
  const B = host.B;
  const parkedMap = B.tmp(),
    parkedKey = B.tmp(),
    entry = B.tmp(),
    sameMap = B.tmp(),
    sameKey = B.tmp(),
    found = B.tmp(),
    both = B.tmp(),
    reuse = B.tmp();
  B.line(`${parkedMap} = load ptr, ptr ${slots.map}`);
  B.line(`${parkedKey} = load ${slots.keyType}, ptr ${slots.key}`);
  B.line(`${entry} = load ptr, ptr ${slots.entry}`);
  // The entry is valid only between its read and this write.
  B.line(`store ptr null, ptr ${slots.entry}`);
  B.line(`${found} = icmp ne ptr ${entry}, null`);
  B.line(`${sameMap} = icmp eq ptr ${parkedMap}, ${map}`);
  if (slots.keyType === "ptr") B.line(`${sameKey} = icmp eq ptr ${parkedKey}, ${key}`);
  else {
    const parkedBits = B.tmp(),
      keyBits = B.tmp();
    B.line(`${parkedBits} = bitcast double ${parkedKey} to i64`);
    B.line(`${keyBits} = bitcast double ${key} to i64`);
    B.line(`${sameKey} = icmp eq i64 ${parkedBits}, ${keyBits}`);
  }
  B.line(`${both} = and i1 ${sameMap}, ${sameKey}`);
  B.line(`${reuse} = select i1 ${found}, i1 ${both}, i1 false`);
  const hit = B.newLabel("mapfuse.hit"),
    miss = B.newLabel("mapfuse.miss"),
    done = B.newLabel("mapfuse.done");
  B.condBr(reuse, hit, miss);
  B.startBlock(hit);
  const slot = B.tmp(),
    bits = B.tmp();
  B.line(`${slot} = getelementptr inbounds %ScrMapEntry, ptr ${entry}, i32 0, i32 1`);
  if (value.access === "f64") B.line(`${bits} = bitcast double ${value.name} to i64`);
  else B.line(`${bits} = zext i1 ${value.name} to i64`);
  B.line(`store i64 ${bits}, ptr ${slot}`);
  B.br(done);
  B.startBlock(miss);
  ordinary();
  B.br(done);
  B.startBlock(done);
  return true;
}
