/* Inline number-key Map/Set reads.
 *
 * Number-keyed collections whose keys are small non-negative integers keep a
 * direct index in the runtime (scr_map.c). Reads go through the internal
 * sc_map_entry_f64 helper (emitter.ts helperDefs), which LLVM inlines: it
 * resolves directly indexed maps without a call and other maps through
 * the internal sc_map_entry_f64_hashed probe, which hashes the key as the
 * runtime does and defers to scr_map_entry_f64 only for wide bucket
 * tables. Both only read memory. The generated code then reads the entry's
 * value slot itself and retains a reference value with the value type's own
 * retain, which is the adapter the collection was constructed with.
 * String-keyed reads use the same entry contract through the internal
 * sc_map_entry_str helper, which rejects keys outside the map's absent-key
 * filter inline and defers to scr_map_entry_str otherwise: reference reads
 * retain inline rather than through the runtime's indirect adapter call,
 * and scalar reads and has() share the one lookup.
 *
 * A string-key map whose values are compact class instances
 * (SCR_MAP_VAL_CREF, LlEmitter.compactArrayElem of the value type) keeps
 * 16-byte { key, hash, val } entries with the value as an address over 8:
 * its reads go through sc_map_entry_str_c and sc_map_iter_entry_c, and
 * decode the 4-byte value.
 *
 * The iteration steps behind for-of, forEach and the other entry walks read
 * the entries array through the internal sc_map_iter_entry and
 * sc_map_iter_count helpers: a live entry's key or value loads in place,
 * and the runtime accessor runs only for an index the walk's liveness
 * guard excludes. for-of starts at scr_map_iter_start, past a deleted
 * prefix.
 */
import type { IrType } from "../../ir/ir.js";
import type { LlvmEmitterContext } from "./expr-context.js";
import { mapKeyAccess } from "./shapes.js";

export const NUMBER_MAP_ENTRY_DECL = "declare ptr @scr_map_entry_f64(ptr, double)";

/** The entry for `key`, or null when absent. Valid until the next mutation. */
export function emitNumberMapEntry(host: LlvmEmitterContext, map: string, key: string): string {
  host.declare(NUMBER_MAP_ENTRY_DECL);
  const entry = host.B.tmp();
  host.B.line(`${entry} = call ptr @sc_map_entry_f64(ptr ${map}, double ${key})`);
  return entry;
}

/** Load a found entry's value slot as `type` (double, i64 or ptr). The value
 * is at byte 8 in both entry layouts (%ScrMapEntry, %ScrMapNumEntry). */
export function emitNumberMapSlot(host: LlvmEmitterContext, entry: string, type: string): string {
  const B = host.B;
  const slot = B.tmp(),
    value = B.tmp();
  B.line(`${slot} = getelementptr inbounds %ScrMapEntry, ptr ${entry}, i32 0, i32 1`);
  B.line(`${value} = load ${type}, ptr ${slot}`);
  return value;
}

export const STRING_MAP_ENTRY_DECL = "declare ptr @scr_map_entry_str(ptr, ptr)";
/** Declared by reads of a compact-value map; its presence makes the emitter
 * define sc_map_entry_str_c and sc_map_iter_entry_c (emit-module.ts). */
export const STRING_MAP_ENTRY_C_DECL = "declare ptr @scr_map_entry_str_c(ptr, ptr)";

/** Whether a Map with key type `key` and value type `value` keeps compact
 * values (SCR_MAP_VAL_CREF): string keys and a value type whose instances
 * are compact (LlEmitter.compactArrayElem). */
export function compactMapValues(host: LlvmEmitterContext, key: IrType, value: IrType): boolean {
  // SCR_MAP_KEY_STR (shapes.ts mapKeyKindNum 1): string access, not a union.
  return key.kind !== "union" && mapKeyAccess(key) === "str" && host.compactArrayElem(value);
}

/** The entry for a string `key`, or null when absent. Valid until the next
 * mutation. `compact`: the map keeps compact values (a %ScrMapCEntry). */
export function emitStringMapEntry(
  host: LlvmEmitterContext,
  map: string,
  key: string,
  compact = false,
): string {
  host.declare(compact ? STRING_MAP_ENTRY_C_DECL : STRING_MAP_ENTRY_DECL);
  const entry = host.B.tmp();
  host.B.line(
    `${entry} = call ptr @${compact ? "sc_map_entry_str_c" : "sc_map_entry_str"}(ptr ${map}, ptr ${key})`,
  );
  return entry;
}

/** A found compact-value entry's value as a pointer: its 4-byte form, an
 * address over 8 (scr_map.h ScrMapCEntry). */
export function emitCompactMapSlot(host: LlvmEmitterContext, entry: string): string {
  const B = host.B;
  const slot = B.tmp(),
    ref = B.tmp(),
    wide = B.tmp(),
    addr = B.tmp(),
    value = B.tmp();
  B.line(`${slot} = getelementptr inbounds %ScrMapCEntry, ptr ${entry}, i32 0, i32 2`);
  B.line(`${ref} = load i32, ptr ${slot}`);
  B.line(`${wide} = zext i32 ${ref} to i64`);
  B.line(`${addr} = shl nuw nsw i64 ${wide}, 3`);
  B.line(`${value} = inttoptr i64 ${addr} to ptr`);
  return value;
}

/** Map.has / Set.has under a string key. */
export function emitStringMapHas(
  host: LlvmEmitterContext,
  map: string,
  key: string,
  compact = false,
): string {
  const entry = emitStringMapEntry(host, map, key, compact);
  const found = host.B.tmp();
  host.B.line(`${found} = icmp ne ptr ${entry}, null`);
  return found;
}

/** Map.get of a scalar value under a string key; see emitNumberMapGetScalar. */
export function emitStringMapGetScalar(
  host: LlvmEmitterContext,
  map: string,
  key: string,
): { found: string; bits: string; entry: string } {
  return emitMapEntryGetScalar(host, emitStringMapEntry(host, map, key));
}

/** Map.get of a reference value: a +1 value, or null when absent — the
 * contract of scr_map_get_f64_ref. `borrow`: the entry's own reference,
 * without a retain, for a reader that finishes before the map can change. */
export function emitNumberMapGetRef(
  host: LlvmEmitterContext,
  map: string,
  key: string,
  value: IrType,
  borrow = false,
): string {
  return emitMapEntryGetRef(host, emitNumberMapEntry(host, map, key), value, false, borrow);
}

/** Map.get of a reference value under a string key, with scr_map_get_str_ref's
 * contract. The value type's own retain replaces the collection's adapter, so
 * the retain is inline instead of an indirect call in the runtime. */
export function emitStringMapGetRef(
  host: LlvmEmitterContext,
  map: string,
  key: string,
  value: IrType,
  compact = false,
  borrow = false,
): string {
  return emitMapEntryGetRef(
    host,
    emitStringMapEntry(host, map, key, compact),
    value,
    compact,
    borrow,
  );
}

/** The +1 value of a found entry (its own reference when `borrow`), or
 * null for a missing (null) entry. */
function emitMapEntryGetRef(
  host: LlvmEmitterContext,
  entry: string,
  value: IrType,
  compact = false,
  borrow = false,
): string {
  const B = host.B;
  const found = B.tmp();
  B.line(`${found} = icmp ne ptr ${entry}, null`);
  const hit = B.newLabel("mapn.hit"),
    miss = B.newLabel("mapn.miss"),
    join = B.newLabel("mapn.join");
  B.condBr(found, hit, miss);
  B.startBlock(hit);
  const loaded = compact ? emitCompactMapSlot(host, entry) : emitNumberMapSlot(host, entry, "ptr");
  const retained = borrow ? loaded : host.retainFrame(loaded, value);
  B.br(join);
  B.startBlock(miss);
  B.br(join);
  B.startBlock(join);
  const result = B.tmp();
  B.line(`${result} = phi ptr [ ${retained}, %${hit} ], [ null, %${miss} ]`);
  return result;
}

/** Map.get of a scalar value: the found flag, and the raw 64-bit slot
 * (zero when absent). Booleans are stored as 0/1. */
export function emitNumberMapGetScalar(
  host: LlvmEmitterContext,
  map: string,
  key: string,
): { found: string; bits: string; entry: string } {
  return emitMapEntryGetScalar(host, emitNumberMapEntry(host, map, key));
}

/** The found flag and raw 64-bit slot (zero when absent) of an entry. */
function emitMapEntryGetScalar(
  host: LlvmEmitterContext,
  entry: string,
): { found: string; bits: string; entry: string } {
  const B = host.B;
  const found = B.tmp();
  B.line(`${found} = icmp ne ptr ${entry}, null`);
  const hit = B.newLabel("mapn.hit"),
    miss = B.newLabel("mapn.miss"),
    join = B.newLabel("mapn.join");
  B.condBr(found, hit, miss);
  B.startBlock(hit);
  const loaded = emitNumberMapSlot(host, entry, "i64");
  B.br(join);
  B.startBlock(miss);
  B.br(join);
  B.startBlock(join);
  const bits = B.tmp();
  B.line(`${bits} = phi i64 [ ${loaded}, %${hit} ], [ 0, %${miss} ]`);
  return { found, bits, entry };
}

/** Map.has / Set.has. */
export function emitNumberMapHas(host: LlvmEmitterContext, map: string, key: string): string {
  const entry = emitNumberMapEntry(host, map, key);
  const found = host.B.tmp();
  host.B.line(`${found} = icmp ne ptr ${entry}, null`);
  return found;
}

/** Map.set / Set.add of a scalar value under a number key: a found entry
 * takes the value in its slot (a Set entry's unit value is already there);
 * a new key appends through `append`, the runtime set. */
export function emitNumberMapSetScalar(
  host: LlvmEmitterContext,
  map: string,
  key: string,
  bits: string | null,
  append: () => void,
): void {
  const B = host.B;
  const entry = emitNumberMapEntry(host, map, key);
  const found = B.tmp();
  B.line(`${found} = icmp ne ptr ${entry}, null`);
  const hit = B.newLabel("mapn.set.hit"),
    miss = B.newLabel("mapn.set.miss"),
    join = B.newLabel("mapn.set.join");
  B.condBr(found, hit, miss);
  B.startBlock(hit);
  if (bits !== null) {
    const slot = B.tmp();
    B.line(`${slot} = getelementptr inbounds %ScrMapEntry, ptr ${entry}, i32 0, i32 1`);
    B.line(`store i64 ${bits}, ptr ${slot}`);
  }
  B.br(join);
  B.startBlock(miss);
  append();
  B.br(join);
  B.startBlock(join);
}

/** Declared by the inline Map/Set iteration steps; its presence makes the
 * emitter define sc_map_iter_entry and sc_map_iter_count (emitter.ts). */
export const MAP_ITER_DECL = "declare zeroext i1 @scr_map_iter_live(ptr, double)";
/** Declared by the iteration steps over a number-key Map/Set; its presence
 * makes the emitter define sc_map_iter_entry_num and sc_map_iter_count. */
export const MAP_ITER_NUM_DECL = "declare double @scr_map_iter_count(ptr)";
/** scr_map.h SCR_MAP_NUM_DEAD: a dead number-key entry's key word. */
export const SCR_MAP_NUM_DEAD = "9218868437227405313";

/** The entry layout a Map or Set of key type `key` stores:
 * - "num": number keys, whose entries are { key, val } (scr_map.h ScrMapNumEntry);
 * - "centry": string keys with compact values (compactMapValues), whose
 *   entries are { key, hash, val } (ScrMapCEntry);
 * - "entry": every other typed key, whose entries are { key, val, hash };
 * - "either": checked (`unknown`) keys. A `Map<unknown, unknown>` or
 *   `Set<unknown>` cast from a checked value keeps the collection's own
 *   storage (scr_dyn_native_collection_check), which can have number keys
 *   or compact values. */
export type MapEntryLayout = "num" | "centry" | "entry" | "either";

export function mapEntryLayout(key: IrType, compact = false): MapEntryLayout {
  if (compact) return "centry";
  return key.kind === "f64" ? "num" : key.kind === "dyn" ? "either" : "entry";
}

/** The entry at an iteration index, or null for a tombstone or an index at
 * or past the entry count (the scr_map_iter_live test). With the "either"
 * layout, the map's key kind (%ScrMapIx field 1, SCR_MAP_KEY_F64 = 0) picks
 * the step at run time; in a program with compact class instances, so does
 * its value kind (field 2, SCR_MAP_VAL_CREF = 3). */
export function emitMapIterEntry(
  host: LlvmEmitterContext,
  map: string,
  index: string,
  layout: MapEntryLayout,
): string {
  const B = host.B;
  const step = (kind: "num" | "centry" | "entry"): string => {
    host.declare(kind === "num" ? MAP_ITER_NUM_DECL : MAP_ITER_DECL);
    if (kind === "centry") host.declare(STRING_MAP_ENTRY_C_DECL);
    const entry = B.tmp();
    const helper =
      kind === "num"
        ? "sc_map_iter_entry_num"
        : kind === "centry"
          ? "sc_map_iter_entry_c"
          : "sc_map_iter_entry";
    B.line(`${entry} = call ptr @${helper}(ptr ${map}, double ${index})`);
    return entry;
  };
  if (layout !== "either") return step(layout);
  host.declare(MAP_ITER_DECL);
  const kindPtr = B.tmp(),
    kind = B.tmp(),
    isNum = B.tmp();
  B.line(`${kindPtr} = getelementptr inbounds %ScrMapIx, ptr ${map}, i32 0, i32 1`);
  B.line(`${kind} = load i8, ptr ${kindPtr}`);
  B.line(`${isNum} = icmp eq i8 ${kind}, 0`);
  const numLabel = B.newLabel("mapit.num"),
    entryLabel = B.newLabel("mapit.entry"),
    join = B.newLabel("mapit.layout");
  B.condBr(isNum, numLabel, entryLabel);
  B.startBlock(numLabel);
  const numEntry = step("num");
  const numEnd = B.currentLabel();
  B.br(join);
  B.startBlock(entryLabel);
  const arms: { value: string; label: string }[] = [{ value: numEntry, label: numEnd }];
  if (host.shapeHost.compactRegion?.() === true) {
    const valPtr = B.tmp(),
      valKind = B.tmp(),
      isCompact = B.tmp();
    B.line(`${valPtr} = getelementptr inbounds %ScrMapIx, ptr ${map}, i32 0, i32 2`);
    B.line(`${valKind} = load i8, ptr ${valPtr}`);
    B.line(`${isCompact} = icmp eq i8 ${valKind}, 3`);
    const compactLabel = B.newLabel("mapit.centry"),
      wideLabel = B.newLabel("mapit.wide");
    B.condBr(isCompact, compactLabel, wideLabel);
    B.startBlock(compactLabel);
    arms.push({ value: step("centry"), label: B.currentLabel() });
    B.br(join);
    B.startBlock(wideLabel);
  }
  arms.push({ value: step("entry"), label: B.currentLabel() });
  B.br(join);
  B.startBlock(join);
  const entry = B.tmp();
  B.line(`${entry} = phi ptr ${arms.map((a) => `[ ${a.value}, %${a.label} ]`).join(", ")}`);
  return entry;
}

/** The first live index (scr_map_iter_start), where for-of starts: the
 * runtime walks the deleted prefix once and remembers where it ends. */
export function emitMapIterStart(host: LlvmEmitterContext, map: string): string {
  host.declare("declare double @scr_map_iter_start(ptr)");
  const start = host.B.tmp();
  host.B.line(`${start} = call double @scr_map_iter_start(ptr ${map})`);
  return start;
}

/** The entry count, tombstones included (scr_map_iter_count). */
export function emitMapIterCount(host: LlvmEmitterContext, map: string): string {
  host.declare(MAP_ITER_DECL);
  const count = host.B.tmp();
  host.B.line(`${count} = call double @sc_map_iter_count(ptr ${map})`);
  return count;
}

export const MAP_SIZE_DECL = "declare double @scr_map_size(ptr)";

/** Map.size / Set.size: the live entry count, read inline (sc_map_size). */
export function emitMapSize(host: LlvmEmitterContext, map: string): string {
  host.declare(MAP_SIZE_DECL);
  const size = host.B.tmp();
  host.B.line(`${size} = call double @sc_map_size(ptr ${map})`);
  return size;
}

/** The key (field 0) or value (field 1) of the live entry at an iteration
 * index, read inline: a number as double, a boolean as i1, and a string or
 * reference retained with `type`'s retain (+1), the adapter the collection
 * stores it with. An index that is not live calls `runtime`, the runtime
 * accessor, which reports the internal error the iteration guard rules out. */
export function emitMapIterSlot(
  host: LlvmEmitterContext,
  map: string,
  index: string,
  field: 0 | 1,
  access: "f64" | "bool" | "ref",
  type: IrType,
  runtime: { decl: string; symbol: string },
  layout: MapEntryLayout,
): string {
  const B = host.B;
  const entry = emitMapIterEntry(host, map, index, layout);
  const found = B.tmp();
  B.line(`${found} = icmp ne ptr ${entry}, null`);
  const hit = B.newLabel("mapit.hit"),
    miss = B.newLabel("mapit.miss"),
    join = B.newLabel("mapit.join");
  B.condBr(found, hit, miss);
  B.startBlock(hit);
  const llTy = access === "f64" ? "double" : access === "bool" ? "i1" : "ptr";
  let loaded: string;
  if (layout === "centry" && field === 1) {
    // A compact value; its type's retain emits no counting.
    loaded = host.retainFrame(emitCompactMapSlot(host, entry), type);
  } else {
    const slot = B.tmp();
    B.line(`${slot} = getelementptr inbounds %ScrMapEntry, ptr ${entry}, i32 0, i32 ${field}`);
    loaded = B.tmp();
    if (access === "bool") {
      const bits = loaded;
      B.line(`${bits} = load i64, ptr ${slot}`);
      loaded = B.tmp();
      B.line(`${loaded} = icmp ne i64 ${bits}, 0`);
    } else {
      B.line(`${loaded} = load ${llTy}, ptr ${slot}`);
      if (access === "ref") loaded = host.retainFrame(loaded, type);
    }
  }
  const hitEnd = B.currentLabel();
  B.br(join);
  B.startBlock(miss);
  host.declare(runtime.decl);
  const fallback = B.tmp();
  B.line(`${fallback} = call ${llTy} @${runtime.symbol}(ptr ${map}, double ${index})`);
  B.br(join);
  B.startBlock(join);
  const result = B.tmp();
  B.line(`${result} = phi ${llTy} [ ${loaded}, %${hitEnd} ], [ ${fallback}, %${miss} ]`);
  return result;
}
