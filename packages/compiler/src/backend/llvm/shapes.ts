/* Type-directed RC/trace/box dispatch tables of the LLVM backend, the
 * cycle-capability fixpoint, and per-record-shape emission — the .ll
 * mirror of the C emitter's emit-types.ts + emit-shapes.ts slice that the
 * phase-2 tier needs. Everything here follows the SAME contracts the C
 * backend compiled into the runtime: `_v` adapters where a container
 * stores RC entry points as data, per-shape retain/release/new (and
 * trace/teardown for cycle-capable shapes) with `size_t rc` at offset 0,
 * scr_obj_alloc_note/scr_obj_free_note bracketing every shape allocation
 * so the sanitized lane's RC audit stays exact.
 *
 * Anything outside the tier refuses loudly (LlvmUnsupportedError naming
 * the type kind) — the tables never guess. */
import type { IrModule, IrRecordShape, IrType } from "../../ir/nodes.js";
import { funcOf, isRefCounted, mapOf, POINTER_KINDS, runtimeRcStem, RUNTIME_EMITTER_CLASS, RUNTIME_ERROR_CLASSES, RUNTIME_STREAM_CLASSES, STRING, VOID } from "../../ir/nodes.js";
import {
  mangleClassRelease,
  mangleClassRetain,
  mangleClassTrace,
  mangleRecordGcFree,
  mangleRecordClone,
  mangleRecordNew,
  mangleRecordRelease,
  mangleRecordRetain,
  mangleRecordStruct,
  mangleRecordTrace,
} from "../mangle.js";
import { LlvmUnsupportedError } from "./unsupported.js";

/** What the tables need from the emitter: the extern-declaration ledger
 * and the module-wide cycle/shape indexes. */
export interface ShapeHost {
  declare(decl: string): void;
  /** Request the shared OOM abort helper (@sc_oom) — emitted once. */
  needOom(): void;
  /** The target C ABI's `size_t` / refcount integer type. */
  readonly sizeType: "i32" | "i64";
  /** Byte offset from an object pointer back to ScrCycHdr.color. */
  readonly cycleColorOffset: number;
  readonly tracedShapes: Set<string>;
  readonly tracedUnions: Set<string>;
  readonly recordsById: Map<string, IrRecordShape>;
  readonly recordCloneShapes: ReadonlySet<string>;
}

/** Every emitted function/helper carries #0 = { sanitize_address } — see
 * the emitter header. */
export const FN_ATTRS = "#0";

/* ── cycle capability (the CEmitter constructor's fixpoint, ported) ────
 * Greatest fixpoint over shapes and unions: start optimistic (everything
 * cycle-capable), repeatedly drop shapes with no cycle-capable field and
 * unions with no cycle-capable arm until stable. Closures and promises
 * are always cycle-capable; strings never are; arrays/maps inherit their
 * element/value type's capability. A HIERARCHY is one unit of capability
 * (a base-typed slot can hold any subclass and retain touches the cycle
 * header, so header presence must be uniform across an extends tree): a
 * unit is cycle-capable iff ANY member is — CEmitter's unit grouping,
 * ported. */
export function computeTraced(mod: IrModule): { shapes: Set<string>; unions: Set<string> } {
  const tracedShapes = new Set<string>();
  const tracedUnions = new Set<string>();
  const classes = mod.classes ?? [];
  const shapeDefs = [
    ...classes.map((c) => ({
      key: `object:${c.name}`,
      fields: c.name === RUNTIME_EMITTER_CLASS
        ? [...c.fields, { name: "<listeners>", type: funcOf([], VOID) }]
        : c.fields,
    })),
    ...(mod.records ?? []).map((r) => ({
      key: `record:${r.id}`,
      fields: r.indexValue
        ? [...r.fields, { name: "<overflow>", type: mapOf(STRING, r.indexValue) }]
        : r.fields,
    })),
  ];
  for (const s of shapeDefs) tracedShapes.add(s.key);
  for (const u of mod.unions ?? []) tracedUnions.add(u.id);
  // Hierarchy units: root lookup over the base links (classes with a base
  // or a subclass — and the runtime emitter class — form units under their
  // root; standalone classes and records stay singleton units).
  const baseOf = new Map(classes.map((c) => [c.name, c.base ?? null] as const));
  const hasChildren = new Set(classes.map((c) => c.base).filter((b): b is string => b !== undefined));
  const rootOf = (name: string): string => {
    let cur = name;
    for (let b = baseOf.get(cur); b !== null && b !== undefined; b = baseOf.get(cur)) cur = b;
    return cur;
  };
  const unitKeyOf = (key: string): string => {
    if (!key.startsWith("object:")) return key;
    const name = key.slice("object:".length);
    const inHierarchy =
      typeof baseOf.get(name) === "string" || hasChildren.has(name) || name === RUNTIME_EMITTER_CLASS;
    return inHierarchy ? `object:${rootOf(name)}` : key;
  };
  const units = new Map<string, typeof shapeDefs>();
  for (const s of shapeDefs) {
    const unit = unitKeyOf(s.key);
    let members = units.get(unit);
    if (!members) units.set(unit, (members = []));
    members.push(s);
  }
  const cycleCapable = (t: IrType): boolean => {
    switch (t.kind) {
      case "func":
      case "promise":
        return true;
      case "object":
        return tracedShapes.has(`object:${t.className}`);
      case "record":
        return tracedShapes.has(`record:${t.shapeId}`);
      case "union":
        return tracedUnions.has(t.unionId);
      case "map":
        return cycleCapable(t.value);
      case "array":
        return cycleCapable(t.elem);
      default:
        return false;
    }
  };
  let shrunk = true;
  while (shrunk) {
    shrunk = false;
    for (const members of units.values()) {
      if (
        tracedShapes.has(members[0]!.key) &&
        !members.some((s) => s.fields.some((f) => cycleCapable(f.type)))
      ) {
        for (const s of members) tracedShapes.delete(s.key);
        shrunk = true;
      }
    }
    for (const u of mod.unions ?? []) {
      if (tracedUnions.has(u.id) && !u.arms.some(cycleCapable)) {
        tracedUnions.delete(u.id);
        shrunk = true;
      }
    }
  }
  return { shapes: tracedShapes, unions: tracedUnions };
}


/* ── RC dispatch ──────────────────────────────────────────────────────── */

/** The runtime's `_v` (ptr → ptr / ptr → void) RC entry points for one
 * refcounted type — used both as the CALL targets of the LLVM tier's
 * retain/release (everything is `ptr` here, so the `_v` shape IS the
 * direct shape) and as the function-pointer arguments of every container
 * construction (unions, ref arrays, obj boxes, overflow maps). Records
 * use their emitted per-shape helpers, whose signatures are already
 * `_v`-shaped. */
export function vAdapters(host: ShapeHost, t: IrType): { retain: string; release: string } {
  const stem = runtimeRcStem(t);
  if (stem !== null) {
    // Catch-binding snapshots have typed ptr-shaped entry points but no
    // separate `_v` wrappers; every other runtime family is uniform.
    const suffix = t.kind === "caught" ? "" : "_v";
    const retain = `@${stem}_retain${suffix}`;
    const release = `@${stem}_release${suffix}`;
    host.declare(`declare ptr ${retain}(ptr)`);
    host.declare(`declare void ${release}(ptr)`);
    return { retain, release };
  }
  switch (t.kind) {
    case "record":
      return { retain: `@${mangleRecordRetain(t.shapeId)}`, release: `@${mangleRecordRelease(t.shapeId)}` };
    case "object":
      // Emitted per-class helpers are already `_v`-shaped (ptr → ptr /
      // ptr → void), so the same symbols serve as container entry points.
      return { retain: `@${mangleClassRetain(t.className)}`, release: `@${mangleClassRelease(t.className)}` };
    default:
      throw new LlvmUnsupportedError(`rc:${t.kind}`);
  }
}

/** The retain call target (ptr → ptr, +1 unless immortal) — the `_v`
 * table above; the split exists so call sites read type-directedly. */
export function retainSym(host: ShapeHost, t: IrType): string {
  return vAdapters(host, t).retain;
}

/** The release call target (ptr → void, NULL-tolerant). The runtime's
 * typed releases are external symbols, so the direct (non-`_v`) entry
 * points serve where one exists; records use their emitted helper. */
export function releaseSym(host: ShapeHost, t: IrType): string {
  const stem = runtimeRcStem(t);
  if (stem !== null) {
    // scr_classobj_release is header-inline only; LLVM calls its exported
    // `_v` wrapper. Every other runtime family exports the typed release.
    const suffix = t.kind === "classval" ? "_release_v" : "_release";
    const release = `@${stem}${suffix}`;
    host.declare(`declare void ${release}(ptr)`);
    return release;
  }
  switch (t.kind) {
    case "record":
      return `@${mangleRecordRelease(t.shapeId)}`;
    case "object":
      return `@${mangleClassRelease(t.className)}`;
    default:
      throw new LlvmUnsupportedError(`rc:${t.kind}`);
  }
}

/** The trace entry point for a payload/field type, or null when the type
 * cannot participate in a cycle — traceAdapterC's table over the LLVM
 * tier's kinds (promise/object rows are out of tier and unreachable:
 * their RC rows refuse first). */
export function traceAdapter(host: ShapeHost, t: IrType): string | null {
  switch (t.kind) {
    case "func":
      host.declare(`declare void @scr_closure_trace_v(ptr, ptr, ptr)`);
      return "@scr_closure_trace_v";
    case "promise":
      // Promises are unconditionally cycle-capable (a rejection payload
      // is an arbitrary thrown value) — emit-shapes.ts's row.
      host.declare(`declare void @scr_promise_trace_v(ptr, ptr, ptr)`);
      return "@scr_promise_trace_v";
    case "union":
      if (!host.tracedUnions.has(t.unionId)) return null;
      host.declare(`declare void @scr_union_trace_v(ptr, ptr, ptr)`);
      return "@scr_union_trace_v";
    case "record":
      return host.tracedShapes.has(`record:${t.shapeId}`) ? `@${mangleRecordTrace(t.shapeId)}` : null;
    case "object":
      if (!host.tracedShapes.has(`object:${t.className}`)) return null;
      if (RUNTIME_ERROR_CLASSES.has(t.className)) {
        host.declare(`declare void @scr_error_trace(ptr, ptr, ptr)`);
        return "@scr_error_trace";
      }
      if (t.className === RUNTIME_EMITTER_CLASS) {
        // Unconditionally cycle-capable (the registry owns listener
        // closures) — the fixpoint's <listeners> field keeps the whole
        // emitter hierarchy in the traced set.
        host.declare(`declare void @scr_emitter_trace(ptr, ptr, ptr)`);
        return "@scr_emitter_trace";
      }
      if (RUNTIME_STREAM_CLASSES.has(t.className)) {
        host.declare(`declare void @scr_stream_trace(ptr, ptr, ptr)`);
        return "@scr_stream_trace";
      }
      return `@${mangleClassTrace(t.className)}`;
    case "map":
      if (traceAdapter(host, t.value) === null) return null;
      host.declare(`declare void @scr_map_trace_v(ptr, ptr, ptr)`);
      return "@scr_map_trace_v";
    case "array":
      if (traceAdapter(host, t.elem) === null) return null;
      host.declare(`declare void @scr_arr_trace_v(ptr, ptr, ptr)`);
      return "@scr_arr_trace_v";
    default:
      return null;
  }
}

/** `@trace` or `null` — the trace argument at a container call site. */
export function traceArg(host: ShapeHost, t: IrType): string {
  return traceAdapter(host, t) ?? "null";
}

/* ── arrays ───────────────────────────────────────────────────────────── */

/** Runtime accessor suffix for an element type (matches emit-types.ts:
 * f64 and bool unboxed, everything refcounted through the `_ref` family). */
export function elemAccess(elem: IrType): "f64" | "bool" | "ref" {
  return elem.kind === "f64" ? "f64" : elem.kind === "bool" ? "bool" : "ref";
}

/** The ScrElemKind constant for the plain (non-REF) construction path. */
function elemKindNum(elem: IrType): number {
  switch (elem.kind) {
    case "f64":
      return 0; // SCR_ELEM_F64
    case "bool":
      return 1; // SCR_ELEM_BOOL
    case "string":
      return 2; // SCR_ELEM_STR
    case "array":
      return 3; // SCR_ELEM_ARR
    case "bytes":
      return 4; // SCR_ELEM_BYTES
    default:
      throw new LlvmUnsupportedError(`arrayElem:${elem.kind}`);
  }
}

/** Array construction call text (arrNewC's dispatch): ref elements
 * (records, unions, closures — and cycle-capable inner arrays, whose
 * SCR_ELEM_ARR spelling would hide them from the outer array's trace)
 * construct through scr_arr_new_ref with the element type's `_v` RC entry
 * points; every other element kind keeps the plain scr_arr_new call. */
export function arrNewCall(host: ShapeHost, elem: IrType, capText: string): string {
  const useRef =
    elem.kind === "record" || elem.kind === "object" || elem.kind === "union" || elem.kind === "func" ||
    elem.kind === "symbol" || // symbol identities: scr_sym_* adapters, no trace
    elem.kind === "classval" || // class objects: no-op adapters, no trace (immortal statics)
    elem.kind === "promise" || // promise entries (Promise.all inputs): full REF story
    elem.kind === "child" || // spawned child handles: scr_child_* adapters, no trace
    elem.kind === "netServer" || // server handles ([...set] drains): REF, no trace
    elem.kind === "jsval" || // island handles (`any[]` under --dynamic): REF, no trace
    elem.kind === "regex" || // RegExp values: scr_regex_* adapters, no trace (no refs inside)
    (elem.kind === "array" && traceAdapter(host, elem) !== null);
  if (!useRef) {
    host.declare(`declare ptr @scr_arr_new(i32, ${host.sizeType})`);
    return `call ptr @scr_arr_new(i32 ${elemKindNum(elem)}, ${host.sizeType} ${capText})`;
  }
  const v = vAdapters(host, elem);
  host.declare(`declare ptr @scr_arr_new_ref(ptr, ptr, ptr, ${host.sizeType})`);
  return `call ptr @scr_arr_new_ref(ptr ${v.retain}, ptr ${v.release}, ptr ${traceArg(host, elem)}, ${host.sizeType} ${capText})`;
}

/* ── capture boxes ────────────────────────────────────────────────────── */

/** Box construction call text (boxNewC's dispatch): plain-kind boxes for
 * the runtime-known payloads, obj-kind boxes (RC entry points + trace as
 * data) for per-shape payloads and cycle-capable arrays. SCR_BOX_* tags
 * from scr_runtime.h. */
export function boxNewCall(host: ShapeHost, t: IrType): string {
  const plain: Partial<Record<IrType["kind"], number>> = { f64: 0, date: 0, bool: 1, string: 2, func: 4 };
  const kind = plain[t.kind];
  if (kind !== undefined) {
    host.declare(`declare ptr @scr_box_new(i32)`);
    return `call ptr @scr_box_new(i32 ${kind})`;
  }
  if (t.kind === "array" && traceAdapter(host, t) === null) {
    host.declare(`declare ptr @scr_box_new(i32)`);
    return `call ptr @scr_box_new(i32 3)`; // SCR_BOX_ARR
  }
  if (
    t.kind === "record" || t.kind === "object" || t.kind === "classval" || t.kind === "union" ||
    t.kind === "array" || t.kind === "map" || t.kind === "set" || t.kind === "symbol" || t.kind === "regex" ||
    t.kind === "promise" || t.kind === "bytes" || t.kind === "url" || t.kind === "searchParams" ||
    t.kind === "stats" || t.kind === "fileHandle" || t.kind === "spawnRes" || t.kind === "child" || t.kind === "childStream" ||
    t.kind === "generator" ||
    t.kind === "netServer" || t.kind === "netSocket" || t.kind === "dgramSocket" ||
    t.kind === "httpReq" || t.kind === "httpRes" || t.kind === "httpClientReq" ||
    t.kind === "secureCtx" || t.kind === "testCtx" ||
    // Island handles: the box carries scr_jsval_retain_v/release_v and
    // no trace — the same stance as jsval array elements.
    t.kind === "jsval" ||
    // Checked-dynamic captures (the mustCall wrapper closing over its
    // implicit-any `fn` param): the box carries scr_dyn_retain_v/release_v
    // and NO trace — cycles through dyn never collect (SEMANTICS.md).
    t.kind === "dyn" ||
    t.kind === "fsWatcher"
  ) {
    const v = vAdapters(host, t);
    host.declare(`declare ptr @scr_box_new_obj(ptr, ptr, ptr)`);
    return `call ptr @scr_box_new_obj(ptr ${v.retain}, ptr ${v.release}, ptr ${traceArg(host, t)})`;
  }
  throw new LlvmUnsupportedError(`box:${t.kind}`);
}

/** Box accessor suffix (boxAccess): scalars unboxed, ref kinds pointers. */
export function boxAccess(t: IrType): "f64" | "bool" | "ref" {
  return t.kind === "f64" || t.kind === "date" ? "f64" : t.kind === "bool" ? "bool" : "ref";
}

/* ── record shapes ────────────────────────────────────────────────────── */

/** A record field's in-struct LLVM type. bool fields store as i8 (the C
 * _Bool layout); loads/stores convert at the access site. */
export function llFieldType(t: IrType): "double" | "i8" | "ptr" {
  if (POINTER_KINDS.has(t.kind) && t.kind !== "http2Session" && t.kind !== "http2Stream") return "ptr";
  switch (t.kind) {
    case "f64":
    case "date":
      return "double";
    case "bool":
      return "i8";
    default:
      throw new LlvmUnsupportedError(`type:${t.kind}`);
  }
}

/* ── maps and sets ────────────────────────────────────────────────────── */

/** Runtime suffix for a map's KEY kind (mapKeyAccess's table): f64 with
 * SameValueZero, string content, or handle-identity REF (symbols). */
export function mapKeyAccess(key: IrType): "f64" | "str" | "ref" {
  if (key.kind === "f64") return "f64";
  if (key.kind === "string") return "str";
  if (key.kind === "symbol") return "ref";
  if (key.kind === "netServer") return "ref"; // handle identity (Set<Server>)
  throw new LlvmUnsupportedError(`mapKey:${key.kind}`);
}

/** The ScrMapKeyKind / ScrMapValKind constants for scr_map_new. */
export function mapKeyKindNum(key: IrType): number {
  const acc = mapKeyAccess(key);
  return acc === "f64" ? 0 : acc === "str" ? 1 : 2;
}

export function mapValKindNum(value: IrType): number {
  return value.kind === "f64" ? 0 : value.kind === "bool" ? 1 : 2;
}

/** The RC-relevant members of a shape: every field, plus the overflow map
 * on index-signature shapes (one more map-typed member). `index` is the
 * member's field position in the emitted struct type (rc header at 0). */
function rcMembers(shape: IrRecordShape): { index: number; type: IrType; name: string }[] {
  return [
    ...shape.fields.map((f, i) => ({ index: i + 1, type: f.type, name: f.name })),
    ...(shape.indexValue
      ? [{ index: shape.fields.length + 1, type: mapOf(STRING, shape.indexValue), name: "[key: string] overflow" }]
      : []),
  ];
}

/** The immortal-skip + mark-live retain body shared by every shape. The
 * cycle header sits before the object; `color` is at obj-16 on 64-bit
 * targets and obj-12 on wasm32,
 * so mark-live is one i32 store at obj-16 (scr_cyc_mark_live inlined —
 * the runtime's is a static inline with no external symbol). */
export function retainBody(host: ShapeHost, fnName: string, traced: boolean, comment = ""): string[] {
  const S = host.sizeType;
  return [
    `define internal ptr @${fnName}(ptr %o) ${FN_ATTRS} {${comment ? ` ; ${comment}` : ""}`,
    `entry:`,
    `  %isnull = icmp eq ptr %o, null`,
    `  br i1 %isnull, label %done, label %check`,
    `check:`,
    `  %rc = load ${S}, ptr %o`,
    `  %imm = icmp eq ${S} %rc, -1`,
    `  br i1 %imm, label %done, label %inc`,
    `inc:`,
    `  %n = add ${S} %rc, 1`,
    `  store ${S} %n, ptr %o`,
    ...(traced
      ? [`  %colorp = getelementptr i8, ptr %o, ${S} -${host.cycleColorOffset}`, `  store i32 0, ptr %colorp ; mark live`]
      : []),
    `  br label %done`,
    `done:`,
    `  ret ptr %o`,
    `}`,
  ];
}

/** Common NULL/immortal/decrement skeleton for ordinary object releases.
 * `freeBody` owns the zero-ref teardown and must leave the current block at
 * its end; traced objects also get the possible-cycle-root branch. */
export function releaseBody(
  host: ShapeHost,
  fnName: string,
  traced: boolean,
  freeBody: string[],
  comment = "",
): string[] {
  const S = host.sizeType;
  const lines = [
    `define internal void @${fnName}(ptr %o) ${FN_ATTRS} {${comment ? ` ; ${comment}` : ""}`,
    `entry:`,
    `  %isnull = icmp eq ptr %o, null`,
    `  br i1 %isnull, label %done, label %check`,
    `check:`,
    `  %rc = load ${S}, ptr %o`,
    `  %imm = icmp eq ${S} %rc, -1`,
    `  br i1 %imm, label %done, label %dec`,
    `dec:`,
    `  %n = sub ${S} %rc, 1`,
    `  store ${S} %n, ptr %o`,
    `  %dead = icmp eq ${S} %n, 0`,
    `  br i1 %dead, label %free, label %${traced ? "root" : "done"}`,
    `free:`,
    ...freeBody,
    `  br label %done`,
  ];
  if (traced) {
    host.declare(`declare void @scr_cyc_on_release(ptr)`);
    lines.push(
      `root:`,
      `  call void @scr_cyc_on_release(ptr %o) ; possible cycle root; may collect`,
      `  br label %done`,
    );
  }
  lines.push(`done:`, `  ret void`, `}`);
  return lines;
}

/** Per-record-shape LLVM emission: the named struct types (returned as
 * `typeDefs`) and the new/retain/release (+trace/gcFree for cycle-capable
 * shapes) function definitions (`defs`). Layout mirrors the C emitter:
 * `{ i64 rc, fields..., [ptr overflow] }`; the retain/release signatures
 * are already `_v`-shaped, so the same symbols serve as container RC
 * entry points. */
export function emitRecordShapes(host: ShapeHost, mod: IrModule): { typeDefs: string[]; defs: string[] } {
  const typeDefs: string[] = [];
  const defs: string[] = [];
  const records = mod.records ?? [];
  if (records.length === 0) return { typeDefs, defs };
  host.declare(`declare void @scr_obj_alloc_note()`);
  host.declare(`declare void @scr_obj_free_note()`);

  for (const shape of records) {
    const struct = mangleRecordStruct(shape.id);
    const fieldTys = shape.fields.map((f) => llFieldType(f.type));
    if (shape.indexValue) fieldTys.push("ptr"); // the overflow ScrMap *
    typeDefs.push(
      `%${struct} = type { ${host.sizeType}${fieldTys.length ? ", " + fieldTys.join(", ") : ""} } ` +
        `; record ${shape.id} { ${shape.fields.map((f) => f.name).join("; ")}${shape.indexValue ? "; [key: string]" : ""} }`,
    );
  }

  for (const shape of records) {
    const struct = mangleRecordStruct(shape.id);
    const traced = host.tracedShapes.has(`record:${shape.id}`);
    const members = rcMembers(shape);
    const refMembers = members.filter((m) => isRefCounted(m.type));
    const sizeOf = `ptrtoint (ptr getelementptr (%${struct}, ptr null, i32 1) to ${host.sizeType})`;

    defs.push(...retainBody(host, mangleRecordRetain(shape.id), traced), ``);

    // release: NULL-tolerant, immortal-skip; at rc == 0 release every
    // refcounted member (runtime releases are NULL-tolerant) and free —
    // traced shapes route through the collector (on_dead/on_release,
    // scr_cyc_free) exactly like emit-shapes.ts.
    const freeBody: string[] = [];
    if (traced) {
      host.declare(`declare void @scr_cyc_on_dead(ptr)`);
      freeBody.push(`  call void @scr_cyc_on_dead(ptr %o)`);
    }
    let t = 0;
    for (const m of refMembers) {
      freeBody.push(
        `  %f${t} = getelementptr inbounds %${struct}, ptr %o, i64 0, i32 ${m.index}`,
        `  %v${t} = load ptr, ptr %f${t}`,
        `  call void ${releaseSym(host, m.type)}(ptr %v${t}) ; ${m.name}`,
      );
      t++;
    }
    freeBody.push(`  call void @scr_obj_free_note()`);
    if (traced) {
      host.declare(`declare void @scr_cyc_free(ptr)`);
      freeBody.push(`  call void @scr_cyc_free(ptr %o)`);
    } else {
      host.declare(`declare void @free(ptr)`);
      freeBody.push(`  call void @free(ptr %o)`);
    }
    defs.push(...releaseBody(host, mangleRecordRelease(shape.id), traced, freeBody), ``);

    // new: zeroed allocation (+ the overflow map on index-signature
    // shapes), rc = 1, alloc note. Traced shapes allocate with the
    // collector header (scr_cyc_alloc zeroes and aborts on OOM itself).
    const nw: string[] = [
      `define internal ptr @${mangleRecordNew(shape.id)}() ${FN_ATTRS} {`,
      `entry:`,
    ];
    if (traced) {
      host.declare(`declare ptr @scr_cyc_alloc(${host.sizeType}, ptr, ptr)`);
      nw.push(
        `  %o = call ptr @scr_cyc_alloc(${host.sizeType} ${sizeOf}, ptr @${mangleRecordTrace(shape.id)}, ptr @${mangleRecordGcFree(shape.id)})`,
      );
    } else {
      host.declare(`declare ptr @calloc(${host.sizeType}, ${host.sizeType})`);
      host.needOom();
      nw.push(
        `  %o = call ptr @calloc(${host.sizeType} 1, ${host.sizeType} ${sizeOf})`,
        `  %isnull = icmp eq ptr %o, null`,
        `  br i1 %isnull, label %oom, label %ok`,
        `oom:`,
        `  call void @sc_oom()`,
        `  unreachable`,
        `ok:`,
      );
    }
    nw.push(`  store ${host.sizeType} 1, ptr %o`);
    if (shape.indexValue) {
      // The overflow map (string-keyed): value handling is type-directed
      // exactly like emit-shapes.ts's overflowNewC.
      host.declare(`declare ptr @scr_map_new(i32, i32, ptr, ptr, ptr)`);
      const v = shape.indexValue;
      const valKind = v.kind === "f64" ? 0 : v.kind === "bool" ? 1 : 2;
      const rc = valKind === 2 ? vAdapters(host, v) : { retain: "null", release: "null" };
      const trace = valKind === 2 ? traceArg(host, v) : "null";
      nw.push(
        `  %ovf = call ptr @scr_map_new(i32 1, i32 ${valKind}, ptr ${rc.retain}, ptr ${rc.release}, ptr ${trace})`,
        `  %ovfp = getelementptr inbounds %${struct}, ptr %o, i64 0, i32 ${shape.fields.length + 1}`,
        `  store ptr %ovf, ptr %ovfp`,
      );
    }
    nw.push(`  call void @scr_obj_alloc_note()`, `  ret ptr %o`, `}`, ``);
    defs.push(...nw);

    if (host.recordCloneShapes.has(shape.id)) {
      const attrs = shape.fields.length >= 16 ? "#2" : FN_ATTRS;
      const clone: string[] = [
        `define internal ptr @${mangleRecordClone(shape.id)}(ptr %src) ${attrs} {`,
        `entry:`,
        `  %o = call ptr @${mangleRecordNew(shape.id)}()`,
      ];
      let i = 0;
      for (const field of shape.fields) {
        const index = i + 1;
        const fieldTy = llFieldType(field.type);
        clone.push(
          `  %sp${i} = getelementptr inbounds %${struct}, ptr %src, i64 0, i32 ${index}`,
          `  %sv${i} = load ${fieldTy}, ptr %sp${i}`,
        );
        const stored = isRefCounted(field.type)
          ? `%sr${i}`
          : `%sv${i}`;
        if (isRefCounted(field.type)) {
          clone.push(`  ${stored} = call ptr ${retainSym(host, field.type)}(ptr %sv${i})`);
        }
        clone.push(
          `  %dp${i} = getelementptr inbounds %${struct}, ptr %o, i64 0, i32 ${index}`,
          `  store ${fieldTy} ${stored}, ptr %dp${i} ; ${field.name}`,
        );
        i++;
      }
      clone.push(`  ret ptr %o`, `}`, ``);
      defs.push(...clone);
    }

    if (traced) {
      // trace: visit exactly the cycle-capable members; gcFree: release
      // exactly the complement, then free (the trace/teardown complement
      // contract in scr_runtime.h).
      const tracedMembers = members.filter((m) => traceAdapter(host, m.type) !== null);
      const untracedRefMembers = refMembers.filter((m) => traceAdapter(host, m.type) === null);
      const tr: string[] = [
        `define internal void @${mangleRecordTrace(shape.id)}(ptr %o, ptr %visit, ptr %ctx) ${FN_ATTRS} {`,
        `entry:`,
      ];
      tracedMembers.forEach((m, i) => {
        tr.push(
          `  %f${i} = getelementptr inbounds %${struct}, ptr %o, i64 0, i32 ${m.index}`,
          `  %v${i} = load ptr, ptr %f${i}`,
          `  call void %visit(ptr %v${i}, ptr %ctx) ; ${m.name}`,
        );
      });
      tr.push(`  ret void`, `}`, ``);
      defs.push(...tr);

      const gf: string[] = [
        `define internal void @${mangleRecordGcFree(shape.id)}(ptr %o) ${FN_ATTRS} {`,
        `entry:`,
      ];
      untracedRefMembers.forEach((m, i) => {
        gf.push(
          `  %f${i} = getelementptr inbounds %${struct}, ptr %o, i64 0, i32 ${m.index}`,
          `  %v${i} = load ptr, ptr %f${i}`,
          `  call void ${releaseSym(host, m.type)}(ptr %v${i}) ; ${m.name} (acyclic)`,
        );
      });
      gf.push(`  call void @scr_obj_free_note()`, `  call void @scr_cyc_free(ptr %o)`, `  ret void`, `}`, ``);
      defs.push(...gf);
    }
  }
  return { typeDefs, defs };
}
