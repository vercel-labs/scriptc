/* Record views: one object across record layouts (decision D3).
 *
 * A checked conversion of a capsule of a native record A into another
 * record type B whose fields A also has (same names and types, any
 * offsets) answers a view: a B object, its rc word marked with the frozen
 * bit, whose record-source entry names A and A's byte offsets for B's
 * fields (scr_dyn_record_view). Every field address of a B value tests
 * the mark (recordViewFieldPtr) and takes A's slot for a view, so reads
 * and writes through either name reach the same storage, and boxing a
 * view answers A's capsule, so identity holds too. B's storage itself is
 * unchanged.
 *
 * Only the target types of such conversions carry the test. They are
 * found from the IR, before any code is emitted: B is a record type a
 * checked conversion can produce (the closure of dynCheck targets), and
 * some other record type whose values reach untyped code as live capsules
 * (the closure of live dynFrom types) has all of B's fields. A program
 * without checked conversions has none, so its code is unchanged. */
import {
  isDirentShape,
  KEY_ORDER_FIELD,
  shapeHasAccessorSlots,
  shapeKeyOrders,
  typeKey,
  type IrModule,
  type IrRecordShape,
  type IrType,
} from "../../ir/ir.js";
import { everyStmtList } from "../../ir/traverse.js";
import type { BlockBuilder } from "./blocks.js";

export interface RecordViews {
  /** Shape ids whose values may be views. */
  readonly targets: ReadonlySet<string>;
  /** The record shapes whose capsules convert to a view of `target`. */
  sources(target: string): readonly string[];
}

export const NO_RECORD_VIEWS: RecordViews = { targets: new Set(), sources: () => [] };

interface ViewOptions {
  readonly traced: (shapeId: string) => boolean;
  readonly excluded: (shapeId: string) => boolean;
}

/** Value kinds that hold no reference to a record. */
const LEAF_KINDS: ReadonlySet<IrType["kind"]> = new Set([
  "f64",
  "bool",
  "string",
  "bigint",
  "date",
  "regex",
  "bytes",
  "symbol",
  "url",
  "searchParams",
  "stats",
  "undefinedT",
  "nullT",
  "void",
]);

function plainShape(shape: IrRecordShape): boolean {
  return (
    !shape.tuple &&
    !shape.indexValue &&
    shape.fields.length > 0 &&
    !isDirentShape(shape) &&
    !shapeHasAccessorSlots(shape) &&
    shapeKeyOrders(shape).length === 1 &&
    !shape.fields.some((field) => field.name === KEY_ORDER_FIELD || field.name.startsWith("%"))
  );
}

/** Whether every field of `target` is a field of `source` with the same
 * type (the view reads A's field with B's representation). */
function covers(source: IrRecordShape, target: IrRecordShape): boolean {
  const fields = new Map(source.fields.map((field) => [field.name, typeKey(field.type)]));
  return target.fields.every((field) => fields.get(field.name) === typeKey(field.type));
}

export function planRecordViews(mod: IrModule, options: ViewOptions): RecordViews {
  const shapes = new Map((mod.records ?? []).map((shape) => [shape.id, shape]));
  const unions = new Map((mod.unions ?? []).map((union) => [union.id, union]));
  // Targets: record types a checked conversion produces. Sources: record
  // types whose values reach untyped code as live capsules. A view arises
  // only where the two meet; elsewhere a conversion keeps its copy.
  const closure = (roots: IrType[]): Set<string> => {
    const out = new Set<string>();
    const seen = new Set<string>();
    const visit = (t: IrType): void => {
      const key = typeKey(t);
      if (seen.has(key)) return;
      seen.add(key);
      switch (t.kind) {
        case "record": {
          out.add(t.shapeId);
          for (const field of shapes.get(t.shapeId)?.fields ?? []) visit(field.type);
          return;
        }
        case "array":
          visit(t.elem);
          return;
        case "union":
          for (const arm of unions.get(t.unionId)?.arms ?? []) visit(arm);
          return;
        default:
          return;
      }
    };
    for (const root of roots) visit(root);
    return out;
  };
  // The views planned so far: target shape → the sources it may view.
  const sources = new Map<string, string[]>();
  // Whether a value of a record can hold a value of another record type:
  // through its fields, elements, map entries, union arms and overflow
  // properties, and through the record a view of it names. Class instances,
  // functions, untyped values, promises and the other kinds that can
  // reference arbitrary objects count as holding every type.
  const held = new Map<string, Set<string> | "any">();
  const holds = (shapeId: string): Set<string> | "any" => {
    const known = held.get(shapeId);
    if (known) return known;
    const out = new Set<string>();
    const seen = new Set<string>();
    const visit = (t: IrType): boolean => {
      const key = typeKey(t);
      if (seen.has(key)) return true;
      seen.add(key);
      switch (t.kind) {
        case "record": {
          out.add(t.shapeId);
          const shape = shapes.get(t.shapeId);
          if (shape?.indexValue !== undefined && !visit(shape.indexValue)) return false;
          if (!(sources.get(t.shapeId) ?? []).every((id) => visit({ kind: "record", shapeId: id })))
            return false;
          return (shape?.fields ?? []).every((field) => visit(field.type));
        }
        case "array":
        case "set":
          return visit(t.elem);
        case "map":
          return visit(t.key) && visit(t.value);
        case "union":
          return (unions.get(t.unionId)?.arms ?? []).every(visit);
        default:
          return LEAF_KINDS.has(t.kind);
      }
    };
    const result = visit({ kind: "record", shapeId }) ? out : "any";
    held.set(shapeId, result);
    return result;
  };
  const checked: IrType[] = [];
  const boxed: IrType[] = [];
  for (const fn of mod.functions)
    everyStmtList(fn.body, {
      stmt: () => true,
      expr: (e) => {
        if (e.kind === "dynCheck") checked.push(e.type);
        else if (e.kind === "dynFrom" && e.liveRef === true) boxed.push(e.value.type);
        return true;
      },
    });
  if (checked.length === 0 || boxed.length === 0) return NO_RECORD_VIEWS;
  const reachable = closure(checked);
  const live = closure(boxed);
  if (reachable.size === 0) return NO_RECORD_VIEWS;
  for (const id of reachable) {
    const target = shapes.get(id);
    if (!target || !plainShape(target) || target.freezable === true) continue;
    if (options.traced(id) || options.excluded(id)) continue;
    const found: string[] = [];
    for (const source of shapes.values()) {
      if (source.id === id || !live.has(source.id) || !plainShape(source)) continue;
      // A view writes the source's slots through the target type, which has
      // no frozen-write guard, so a source that may be frozen keeps the copy.
      if (source.freezable === true) continue;
      if (covers(source, target)) found.push(source.id);
    }
    if (found.length > 0) sources.set(id, found);
  }
  // A view's record-source entry owns the source's capsule, an edge the
  // cycle analysis does not see. A view stays off every cycle only when its
  // source cannot hold a value of the target type, such as the view itself,
  // including through other views. Dropping a pair removes edges, so the
  // check repeats until no pair is dropped.
  for (let changed = true; changed;) {
    changed = false;
    held.clear();
    for (const [id, list] of sources) {
      const kept = list.filter((source) => {
        const sourceHolds = holds(source);
        return sourceHolds !== "any" && !sourceHolds.has(id);
      });
      if (kept.length === list.length) continue;
      changed = true;
      if (kept.length > 0) sources.set(id, kept);
      else sources.delete(id);
    }
  }
  if (sources.size === 0) return NO_RECORD_VIEWS;
  const targets = new Set(sources.keys());
  return { targets, sources: (target) => sources.get(target) ?? [] };
}

/** Lines setting `dest` (i1) to whether the record `obj` of a view target
 * type is a view. A view's rc word carries the frozen bit (scr_rc.h
 * SCR_RC_FROZEN), which no other value of such a type has: view targets
 * are never freezable, and a word with the program-lifetime bit (an
 * immortal one included) is no view, so a view's word is the frozen bit
 * plus a count. The
 */
export function recordViewTestLines(sizeType: "i32" | "i64", obj: string, dest: string): string[] {
  // The frozen bit with a count and no program-lifetime bit: one range.
  const [bit, span] =
    sizeType === "i64" ? ["4611686018427387904", "4294967296"] : ["1073741824", "1073741824"];
  return [
    `  ${dest}.w = load ${sizeType}, ptr ${obj}`,
    `  ${dest}.d = sub ${sizeType} ${dest}.w, ${bit}`,
    `  ${dest} = icmp ult ${sizeType} ${dest}.d, ${span}`,
  ];
}

/** The address of field `position` (declaration index) of the record
 * `obj` of view-target shape `struct`: the slot itself, or the viewed
 * record's slot when `obj` is a view. Optimized builds test the mark
 * inline and look the slot up out of line; unoptimized builds, which give
 * every value a frame slot, make the address one call. */
export function recordViewFieldPtr(
  B: BlockBuilder,
  sizeType: "i32" | "i64",
  struct: string,
  obj: string,
  slotIndex: number,
  position: number,
  declare: (decl: string) => void,
  outOfLine: boolean,
): string {
  if (outOfLine) {
    declare(`declare ptr @scr_record_view_field(ptr, ${sizeType}, ${sizeType})`);
    const ptr = B.tmp();
    B.line(
      `${ptr} = call ptr @scr_record_view_field(ptr ${obj}, ${sizeType} ptrtoint (ptr getelementptr (%${struct}, ptr null, i32 0, i32 ${slotIndex}) to ${sizeType}), ${sizeType} ${position})`,
    );
    return ptr;
  }
  const own = B.tmp();
  B.line(`${own} = getelementptr inbounds %${struct}, ptr ${obj}, i64 0, i32 ${slotIndex}`);
  const isView = B.tmp();
  for (const line of recordViewTestLines(sizeType, obj, isView)) B.line(line.trimStart());
  const from = B.currentLabel();
  const view = B.newLabel("rv.view");
  const join = B.newLabel("rv.join");
  // Views are rare: the slot lookup stays out of line.
  B.condBr(isView, view, join, `, !prof !{!"branch_weights", i32 1, i32 1000}`);
  B.startBlock(view);
  declare(`declare ptr @scr_record_view_slot(ptr, ${sizeType})`);
  const viewed = B.tmp();
  B.line(`${viewed} = call ptr @scr_record_view_slot(ptr ${obj}, ${sizeType} ${position})`);
  B.br(join);
  B.startBlock(join);
  const ptr = B.tmp();
  B.line(`${ptr} = phi ptr [ ${own}, %${from} ], [ ${viewed}, %${view} ]`);
  return ptr;
}
