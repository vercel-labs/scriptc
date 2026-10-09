/** Type-directed reference counting, tracing, boxes and record layouts.
 * Containers store erased adapters; shape helpers retain, release and trace
 * their fields. Every allocation has a size_t reference count at offset zero
 * and participates in the runtime allocation audit. */
import type { IrModule, IrRecordShape, IrType } from "../../ir/ir.js";
import {
  isIdentityCollectionKey,
  isRefCounted,
  mapOf,
  POINTER_KINDS,
  runtimeRcStem,
  RUNTIME_EMITTER_CLASS,
  RUNTIME_ERROR_CLASSES,
  RUNTIME_STREAM_CLASSES,
  STRING,
} from "../../ir/ir.js";
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
import { emitObjectAlloc, emitObjectFree } from "./alloc.js";
import { llvmCommentText } from "./common.js";
import type { NullableUnions } from "./nullable-unions.js";
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
  /** Unions represented as a nullable arm pointer (nullable-unions.ts):
   * their RC and trace entry points are the arm's NULL-tolerant ones. */
  readonly nullableUnions: NullableUnions;
  readonly recordsById: Map<string, IrRecordShape>;
  readonly recordCloneShapes: ReadonlySet<string>;
  /** Emit the live-object audit notes (`scr_obj_alloc_note` /
   * `scr_obj_free_note`) in emitted new/free helpers. Only runtimes built
   * with SCR_RC_AUDIT (the sanitized lane) count them; release and dev
   * runtime packs define them empty, so plain builds omit the calls.
   * Absent means emit. */
  readonly objectAudit?: boolean;
  /** Inline the small-object allocator's fast paths (llvm/alloc.ts). */
  readonly inlineAlloc?: boolean;
  /** Inline RC fast-path helpers requested so far ("<family>:<op>"); the
   * emitter defines each once through {@link emitInlineRcHelpers}. Null
   * keeps every retain/release a runtime call: inline RC is a
   * size-for-speed optimization of the `speed` posture only. */
  readonly rcHelpers: Set<string> | null;
}

/** Every emitted function/helper carries #0 = { sanitize_address } — see
 * the emitter header. */
export const FN_ATTRS = "#0";

export { computeTraced } from "../cycle-analysis.js";

/* ── RC dispatch ──────────────────────────────────────────────────────── */

/** The runtime's `_v` (ptr → ptr / ptr → void) RC entry points for one
 * refcounted type — used both as the CALL targets of the LLVM tier's
 * retain/release (everything is `ptr` here, so the `_v` shape IS the
 * direct shape) and as the function-pointer arguments of every container
 * construction (unions, ref arrays, obj boxes, overflow maps). Records
 * use their emitted per-shape helpers, whose signatures are already
 * `_v`-shaped. */
export function vAdapters(host: ShapeHost, t: IrType): { retain: string; release: string } {
  const nullable = host.nullableUnions.of(t);
  if (nullable) {
    const arm = vAdapters(host, nullable.arm);
    return { retain: nullableRetainSym(host, nullable.arm), release: arm.release };
  }
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
      return {
        retain: `@${mangleRecordRetain(t.shapeId)}`,
        release: `@${mangleRecordRelease(t.shapeId)}`,
      };
    case "object":
      // Emitted per-class helpers are already `_v`-shaped (ptr → ptr /
      // ptr → void), so the same symbols serve as container entry points.
      return {
        retain: `@${mangleClassRetain(t.className)}`,
        release: `@${mangleClassRelease(t.className)}`,
      };
    default:
      throw new LlvmUnsupportedError(`rc:${t.kind}`);
  }
}

/** The retain call target (ptr → ptr, +1 unless immortal) — the `_v`
 * table above; the split exists so call sites read type-directedly.
 * Families with a mirrored fast path call the inline helper instead. */
export function retainSym(host: ShapeHost, t: IrType): string {
  const nullable = host.nullableUnions.of(t);
  if (nullable) return nullableRetainSym(host, nullable.arm);
  const stem = runtimeRcStem(t);
  if (host.rcHelpers !== null && stem !== null && inlineRcFamily(stem, "retain") !== null) {
    return inlineRcSym(host, stem, "retain");
  }
  return vAdapters(host, t).retain;
}

/** The retain entry point of a nullable union's value: the arm's own when
 * it tolerates NULL (emitted class and record helpers), otherwise a
 * NULL-skipping wrapper around it (the null sentinel and literals are
 * immortal, which every retain already skips). */
function nullableRetainSym(host: ShapeHost, arm: IrType): string {
  if (arm.kind === "object" || arm.kind === "record") return retainSym(host, arm);
  const sym = `@sc_nretain_${arm.kind}`;
  if (!host.nullableUnions.retainWrappers.has(sym))
    host.nullableUnions.retainWrappers.set(sym, retainSym(host, arm));
  return sym;
}

/** Definitions of the requested NULL-skipping retain wrappers. */
export function emitNullableRetainWrappers(host: ShapeHost): string[] {
  const out: string[] = [];
  for (const [sym, inner] of host.nullableUnions.retainWrappers)
    out.push(
      `define internal ptr ${sym}(ptr %o) ${FN_ATTRS} { ; NULL-tolerant retain`,
      `entry:`,
      `  %isnull = icmp eq ptr %o, null`,
      `  br i1 %isnull, label %done, label %live`,
      `live:`,
      `  %r = call ptr ${inner}(ptr %o)`,
      `  br label %done`,
      `done:`,
      `  ret ptr %o`,
      `}`,
      ``,
    );
  return out;
}

/** The release call target (ptr → void, NULL-tolerant). The runtime's
 * typed releases are external symbols, so the direct (non-`_v`) entry
 * points serve where one exists; records use their emitted helper.
 * Families with a mirrored fast path call the inline helper instead. */
export function releaseSym(host: ShapeHost, t: IrType): string {
  const nullable = host.nullableUnions.of(t);
  if (nullable) return releaseSym(host, nullable.arm);
  const stem = runtimeRcStem(t);
  if (host.rcHelpers !== null && stem !== null && inlineRcFamily(stem, "release") !== null) {
    return inlineRcSym(host, stem, "release");
  }
  if (stem !== null) {
    // Class objects share the container adapter at direct release sites.
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

/* ── inline RC fast paths ─────────────────────────────────────────────── */

/** How a runtime family decides whether an object carries a ScrCycHdr:
 * never, always, or per object through the trace slots its C release
 * tests (`a->elem_trace`, `m->key_trace || m->val_trace`). */
type RcCycle = "none" | "always" | "arr" | "map";

interface InlineRcFamily {
  readonly cycle: RcCycle;
  /** The C retain tolerates NULL (the others dereference unconditionally). */
  readonly retainNull: boolean;
  /** The out-of-line release behind the inline fast path: it owns the
   * rc == 1 → 0 transition and, for per-object (`arr`/`map`) families,
   * every release of a headered object. Null keeps the release a plain
   * runtime call. */
  readonly release: string | null;
}

/** Runtime RC families whose fast paths the backend mirrors in IR, keyed
 * by the family name without its `scr_` stem prefix. Each
 * row restates the C entry points in scr_runtime.h and the runtime TUs:
 * retain is `if (rc != SIZE_MAX) rc++`, and a release that leaves the
 * object alive is `rc--`, then scr_cyc_on_release when headered. Everything else (destruction, RC-audit accounting, the
 * collector's on_dead bookkeeping) stays in the runtime release, which
 * repeats its own checks, so the fast path never duplicates it.
 *
 * Releases stay plain calls for:
 * - dyn: scr_dyn_release buffers a surviving object only for some kinds.
 * - arr: array releases are the most numerous release sites and the
 *   least hot (at most 1% self time across the benchmark suite), and
 *   inlining them roughly doubled the code growth for no measured speedup.
 *   Array retains are inlined. */
export const INLINE_RC_FAMILIES: Readonly<Record<string, InlineRcFamily>> = {
  str: { cycle: "none", retainNull: false, release: "scr_str_release" },
  bytes: { cycle: "none", retainNull: false, release: "scr_bytes_release" },
  regex: { cycle: "none", retainNull: false, release: "scr_regex_release" },
  bigint: { cycle: "none", retainNull: true, release: "scr_bigint_release" },
  arr: { cycle: "arr", retainNull: false, release: null },
  map: { cycle: "map", retainNull: false, release: "scr_map_release" },
  union: { cycle: "always", retainNull: false, release: "scr_union_release" },
  closure: { cycle: "always", retainNull: false, release: "scr_closure_release" },
  promise: { cycle: "always", retainNull: true, release: "scr_promise_release" },
  classobj: { cycle: "always", retainNull: true, release: "scr_classobj_release" },
  box: { cycle: "always", retainNull: false, release: "scr_box_release" },
  dyn: { cycle: "always", retainNull: false, release: null },
};

type RcOp = "retain" | "release";

/** The mirrored family for an RC operation on a runtime stem (`scr_str`),
 * or null when it stays a call. */
export function inlineRcFamily(stem: string, op: RcOp): InlineRcFamily | null {
  return mirroredFamily(stem.replace(/^scr_/, ""), op);
}

function mirroredFamily(family: string, op: RcOp): InlineRcFamily | null {
  if (!Object.hasOwn(INLINE_RC_FAMILIES, family)) return null;
  const row = INLINE_RC_FAMILIES[family]!;
  return op === "retain" || row.release !== null ? row : null;
}

/** Request one inline RC helper for a runtime stem (`scr_str`) and return
 * its symbol. */
function inlineRcSym(host: ShapeHost, stem: string, op: RcOp): string {
  return requestRcHelper(host, stem.replace(/^scr_/, ""), op);
}

/** The release call target for a capture box: scr_box_release's fast path,
 * or scr_box_release itself without inline RC. */
export function boxReleaseSym(host: ShapeHost): string {
  if (host.rcHelpers === null) {
    host.declare(`declare void @scr_box_release(ptr)`);
    return "@scr_box_release";
  }
  return requestRcHelper(host, "box", "release");
}

/** Record the helper and declare the runtime symbols it calls now, so they
 * land in the extern block. */
function requestRcHelper(host: ShapeHost, family: string, op: RcOp): string {
  if (host.rcHelpers === null || mirroredFamily(family, op) === null) {
    throw new LlvmUnsupportedError(`inline rc:${family}:${op}`);
  }
  host.rcHelpers.add(`${family}:${op}`);
  for (const decl of rcHelperDecls(family, op)) host.declare(decl);
  return `@${inlineRcName(family, op)}`;
}

function inlineRcName(family: string, op: RcOp): string {
  return `sc_rc_${op}_${family}`;
}

function rcHelperDecls(family: string, op: RcOp): string[] {
  const row = INLINE_RC_FAMILIES[family]!;
  if (op === "retain" || row.release === null) return [];
  return [
    `declare void @${row.release}(ptr)`,
    ...(row.cycle === "always" ? [`declare void @scr_cyc_on_release(ptr)`] : []),
  ];
}

/** The runtime declarations the requested helpers call (deduplicated). */
/** The inline retain/release helper keys ("family:op") the program used, in
 * insertion order; empty when inline RC is off. Copied into a plain array so
 * callers stay inside the self-hosted subset (no `Set | []` unions). */
function rcHelperKeys(host: ShapeHost): string[] {
  const keys: string[] = [];
  if (host.rcHelpers) for (const key of host.rcHelpers) keys.push(key);
  return keys;
}

export function inlineRcDecls(host: ShapeHost): string[] {
  const decls = new Set<string>();
  for (const key of rcHelperKeys(host)) {
    const [family, op] = key.split(":") as [string, RcOp];
    for (const decl of rcHelperDecls(family, op)) decls.add(decl);
  }
  return [...decls];
}

/** Branch to `yes` when a per-object family's object carries a cycle
 * header (its C retain/release trace-slot test), else to `no`. */
function rcHeaderTest(cycle: "arr" | "map", yes: string, no: string): string[] {
  if (cycle === "arr") {
    return [
      `  %tracep = getelementptr inbounds %ScrArr, ptr %o, i32 0, i32 6 ; elem_trace`,
      `  %trace = load ptr, ptr %tracep`,
      `  %headered = icmp ne ptr %trace, null`,
      `  br i1 %headered, label %${yes}, label %${no}`,
    ];
  }
  return [
    `  %vtracep = getelementptr inbounds %ScrMapRc, ptr %o, i32 0, i32 5 ; val_trace`,
    `  %vtrace = load ptr, ptr %vtracep`,
    `  %ktracep = getelementptr inbounds %ScrMapRc, ptr %o, i32 0, i32 8 ; key_trace`,
    `  %ktrace = load ptr, ptr %ktracep`,
    `  %vheadered = icmp ne ptr %vtrace, null`,
    `  %kheadered = icmp ne ptr %ktrace, null`,
    `  %headered = or i1 %vheadered, %kheadered`,
    `  br i1 %headered, label %${yes}, label %${no}`,
  ];
}

function retainHelper(host: ShapeHost, family: string, row: InlineRcFamily): string[] {
  const S = host.sizeType;
  return [
    `define internal ptr @${inlineRcName(family, "retain")}(ptr %o) ${FN_ATTRS} { ; scr_${family}_retain fast path`,
    `entry:`,
    ...(row.retainNull
      ? [`  %isnull = icmp eq ptr %o, null`, `  br i1 %isnull, label %done, label %check`, `check:`]
      : []),
    `  %rc = load ${S}, ptr %o`,
    `  %imm = icmp eq ${S} %rc, -1`,
    `  br i1 %imm, label %done, label %inc`,
    `inc:`,
    `  %n = add ${S} %rc, 1`,
    `  store ${S} %n, ptr %o`,
    `  br label %done`,
    `done:`,
    `  ret ptr %o`,
    `}`,
    ``,
  ];
}

function releaseHelper(host: ShapeHost, family: string, row: InlineRcFamily): string[] {
  const S = host.sizeType;
  const cycle = row.cycle;
  return [
    `define internal void @${inlineRcName(family, "release")}(ptr %o) ${FN_ATTRS} { ; ${row.release} fast path`,
    `entry:`,
    `  %isnull = icmp eq ptr %o, null`,
    `  br i1 %isnull, label %done, label %check`,
    `check:`,
    `  %rc = load ${S}, ptr %o`,
    `  %imm = icmp eq ${S} %rc, -1`,
    `  br i1 %imm, label %done, label %owned`,
    `owned:`,
    `  %last = icmp eq ${S} %rc, 1`,
    ...(cycle === "arr" || cycle === "map"
      ? [
          `  br i1 %last, label %slow, label %probe`,
          `probe:`,
          ...rcHeaderTest(cycle, "slow", "dec"),
        ]
      : [`  br i1 %last, label %slow, label %dec`]),
    `slow:`,
    `  call void @${row.release}(ptr %o) cold ; the runtime release owns this case`,
    `  br label %done`,
    `dec:`,
    `  %n = sub ${S} %rc, 1`,
    `  store ${S} %n, ptr %o`,
    ...(family === "union"
      ? [
          // scr_union_release buffers a surviving box only when its arm can
          // reach a cycle: a box whose arm_trace is NULL visits nothing.
          `  %atp = getelementptr i8, ptr %o, ${S} ${S === "i64" ? 32 : 16} ; ScrUnion.arm_trace`,
          `  %at = load ptr, ptr %atp`,
          `  %untraced = icmp eq ptr %at, null`,
          `  br i1 %untraced, label %done, label %root`,
          `root:`,
        ]
      : []),
    ...(cycle === "always" ? cycleRootLines(host, "done") : [`  br label %done`]),
    `done:`,
    `  ret void`,
    `}`,
    ``,
  ];
}

/** Definitions for every requested inline RC helper, in a stable order.
 *
 * retain: a NULL skip where the C retain tolerates NULL, the immortal skip
 * and the increment; retains never touch the cycle header.
 *
 * release: NULL and immortal skips. rc == 1 (and any headered object of a
 * per-object family) calls the runtime release, marked cold so destruction
 * stays out of line. Otherwise decrement; always-headered families then
 * inline scr_cyc_on_release's already-buffered case (`buffered` is the i16
 * four bytes after color), calling the runtime only
 * to enqueue a new candidate. scr_runtime.h asserts both header offsets and
 * the trace-slot offsets. */
export function emitInlineRcHelpers(host: ShapeHost): string[] {
  const out: string[] = [];
  for (const key of rcHelperKeys(host).sort()) {
    const [family, op] = key.split(":") as [string, RcOp];
    const row = INLINE_RC_FAMILIES[family]!;
    out.push(
      ...(op === "retain" ? retainHelper(host, family, row) : releaseHelper(host, family, row)),
    );
  }
  return out;
}

/** The trace entry point for a payload/field type, or null when the type
 * cannot participate in a cycle. */
export function traceAdapter(host: ShapeHost, t: IrType): string | null {
  switch (t.kind) {
    case "caught":
      host.declare(`declare void @scr_caught_trace_v(ptr, ptr, ptr)`);
      return "@scr_caught_trace_v";
    case "dyn":
      host.declare(`declare void @scr_dyn_trace_v(ptr, ptr, ptr)`);
      return "@scr_dyn_trace_v";
    case "classval":
      host.declare(`declare void @scr_classobj_trace_v(ptr, ptr, ptr)`);
      return "@scr_classobj_trace_v";
    case "func":
      host.declare(`declare void @scr_closure_trace_v(ptr, ptr, ptr)`);
      return "@scr_closure_trace_v";
    case "promise":
      // Promises are unconditionally cycle-capable (a rejection payload
      // is an arbitrary thrown value) — shapes.ts's row.
      host.declare(`declare void @scr_promise_trace_v(ptr, ptr, ptr)`);
      return "@scr_promise_trace_v";
    case "union": {
      const nullable = host.nullableUnions.get(t.unionId);
      if (nullable) return traceAdapter(host, nullable.arm);
      if (!host.tracedUnions.has(t.unionId)) return null;
      host.declare(`declare void @scr_union_trace_v(ptr, ptr, ptr)`);
      return "@scr_union_trace_v";
    }
    case "record":
      return host.tracedShapes.has(`record:${t.shapeId}`)
        ? `@${mangleRecordTrace(t.shapeId)}`
        : null;
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
      if (traceAdapter(host, t.key) === null && traceAdapter(host, t.value) === null) return null;
      host.declare(`declare void @scr_map_trace_v(ptr, ptr, ptr)`);
      return "@scr_map_trace_v";
    case "set":
      if (traceAdapter(host, t.elem) === null) return null;
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

/** Keep native capsule edges visible when the referent is cycle-capable. */
export function typedRefConstructor(host: ShapeHost, t: IrType): string {
  const observed =
    t.kind === "record" ||
    t.kind === "array" ||
    t.kind === "map" ||
    t.kind === "set" ||
    (t.kind === "object" &&
      !RUNTIME_ERROR_CLASSES.has(t.className) &&
      t.className !== RUNTIME_EMITTER_CLASS &&
      !RUNTIME_STREAM_CLASSES.has(t.className));
  const name =
    traceAdapter(host, t) !== null
      ? "scr_dyn_new_typed_ref_traced"
      : observed
        ? "scr_dyn_new_typed_ref_observed"
        : "scr_dyn_new_typed_ref";
  host.declare(`declare ptr @${name}(ptr, ptr, ptr, ptr, ${host.sizeType}, ptr, ptr)`);
  return `@${name}`;
}

/* ── arrays ───────────────────────────────────────────────────────────── */

/** Runtime accessor suffix for an element type (matches types.ts:
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

/** Array construction call text: ref elements
 * (records, unions, closures — and cycle-capable inner arrays, whose
 * SCR_ELEM_ARR spelling would hide them from the outer array's trace)
 * construct through scr_arr_new_ref with the element type's `_v` RC entry
 * points; every other element kind keeps the plain scr_arr_new call. */
export function arrNewCall(host: ShapeHost, elem: IrType, capText: string): string {
  const useRef =
    elem.kind === "record" ||
    elem.kind === "object" ||
    elem.kind === "union" ||
    elem.kind === "func" ||
    elem.kind === "map" ||
    elem.kind === "set" || // scr_map_* adapters and typed key/value tracing
    elem.kind === "symbol" || // symbol identities: scr_sym_* adapters, no trace
    elem.kind === "bigint" || // immutable numeric values: scr_bigint_* adapters
    elem.kind === "classval" || // local class objects own traced capture boxes
    elem.kind === "promise" || // promise entries (Promise.all inputs): full REF story
    elem.kind === "child" || // spawned child handles: scr_child_* adapters, no trace
    elem.kind === "netServer" || // server handles ([...set] drains): REF, no trace
    elem.kind === "jsval" || // island handles (`any[]` under --dynamic): REF, no trace
    elem.kind === "dyn" || // native collection seeds/drains: traced REF
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
  const plain: Partial<Record<IrType["kind"], number>> = {
    f64: 0,
    date: 0,
    procStream: 0,
    bool: 1,
    string: 2,
    func: 4,
  };
  const kind = plain[t.kind];
  if (kind !== undefined) {
    host.declare(`declare ptr @scr_box_new(i32)`);
    return `call ptr @scr_box_new(i32 ${kind})`;
  }
  if (t.kind === "array" && traceAdapter(host, t) === null) {
    host.declare(`declare ptr @scr_box_new(i32)`);
    return `call ptr @scr_box_new(i32 3)`; // SCR_BOX_ARR
  }
  if (isRefCounted(t)) {
    const v = vAdapters(host, t);
    host.declare(`declare ptr @scr_box_new_obj(ptr, ptr, ptr)`);
    return `call ptr @scr_box_new_obj(ptr ${v.retain}, ptr ${v.release}, ptr ${traceArg(host, t)})`;
  }
  throw new LlvmUnsupportedError(`box:${t.kind}`);
}

/** Box accessor suffix (boxAccess): scalars unboxed, ref kinds pointers. */
export function boxAccess(t: IrType): "f64" | "bool" | "ref" {
  return t.kind === "f64" || t.kind === "date" || t.kind === "procStream"
    ? "f64"
    : t.kind === "bool"
      ? "bool"
      : "ref";
}

/* ── record shapes ────────────────────────────────────────────────────── */

/** A record field's in-struct LLVM type. bool fields store as i8 (the C
 * _Bool layout); loads/stores convert at the access site. */
export function llFieldType(t: IrType): "double" | "i8" | "ptr" {
  if (POINTER_KINDS.has(t.kind)) return "ptr";
  switch (t.kind) {
    case "f64":
    case "date":
    case "procStream":
      return "double";
    case "bool":
      return "i8";
    default:
      throw new LlvmUnsupportedError(`type:${t.kind}`);
  }
}

/* ── maps and sets ────────────────────────────────────────────────────── */

export type MapKeyAccess = "f64" | "bool" | "str" | "ref";

/** The key's calling convention is independent of equality: bigint and
 * union payloads travel by reference but compare by JavaScript value. */
export function mapKeyAccess(key: IrType): MapKeyAccess {
  if (key.kind === "f64") return "f64";
  if (key.kind === "bool") return "bool";
  if (key.kind === "string") return "str";
  if (
    isIdentityCollectionKey(key) ||
    key.kind === "bigint" ||
    key.kind === "union" ||
    key.kind === "dyn"
  )
    return "ref";
  throw new LlvmUnsupportedError(`mapKey:${key.kind}`);
}

export function mapKeyLlType(access: MapKeyAccess): "double" | "i1" | "ptr" {
  return access === "f64" ? "double" : access === "bool" ? "i1" : "ptr";
}

export function mapKeyParamType(access: MapKeyAccess): string {
  return access === "bool" ? "i1 zeroext" : mapKeyLlType(access);
}

/** The ScrMapKeyKind / ScrMapValKind constants for scr_map_new. */
export function mapKeyKindNum(key: IrType, unionArms?: IrType[]): number {
  if (key.kind === "dyn") return 4;
  if (key.kind === "bigint") return 5;
  if (key.kind === "bool") return 6;
  if (key.kind === "nullT") return 8;
  if (key.kind === "undefinedT") return 9;
  if (key.kind === "union") return unionArms?.every(isIdentityCollectionKey) ? 3 : 7;
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
      ? [
          {
            index: shape.fields.length + 1,
            type: mapOf(STRING, shape.indexValue),
            name: "[key: string] overflow",
          },
        ]
      : []),
  ];
}

/** The NULL- and immortal-skipping retain body shared by every shape. A
 * retain never touches the cycle header: a buffered candidate that is
 * retained again stays a candidate (scr_cycle.c, markRoots). */
export function retainBody(host: ShapeHost, fnName: string, comment = ""): string[] {
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
    `  br label %done`,
    `done:`,
    `  ret ptr %o`,
    `}`,
  ];
}

/** Scalar fields and native strings cannot form recursive ownership chains.
 * Other reference kinds conservatively share the runtime destruction budget. */
export function needsBoundedRelease(type: IrType): boolean {
  return isRefCounted(type) && type.kind !== "string";
}

/** Common NULL/immortal/decrement skeleton for ordinary object releases.
 * `freeBody` owns the zero-ref teardown and must leave the current block at
 * its end; traced objects also get the possible-cycle-root branch.
 *
 * `fnName` is only the inlinable fast path (releaseFastPath); the complete
 * release is `${fnName}_slow`, kept out of line so callers that inline the
 * release do not also inline its teardown. */
export function releaseBody(
  host: ShapeHost,
  fnName: string,
  traced: boolean,
  freeBody: string[],
  comment = "",
  bounded = true,
): string[] {
  const S = host.sizeType;
  if (bounded) host.declare(`declare void @scr_rc_destroy(ptr, ptr)`);
  const destroy = `${fnName}_destroy`;
  const lines = [
    ...(bounded
      ? [
          `define internal void @${destroy}(ptr %o) ${FN_ATTRS} {`,
          `entry:`,
          ...freeBody,
          `  ret void`,
          `}`,
        ]
      : []),
    ...releaseFastPath(host, fnName, `${fnName}_slow`, traced, comment),
    `define internal void @${fnName}_slow(ptr %o) noinline ${FN_ATTRS} {${comment ? ` ; ${comment}` : ""}`,
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
    ...(traced ? [`  call void @scr_cyc_on_dead(ptr %o)`] : []),
    ...(bounded ? [`  call void @scr_rc_destroy(ptr %o, ptr @${destroy})`] : freeBody),
    `  br label %done`,
  ];
  if (traced) {
    host.declare(`declare void @scr_cyc_on_dead(ptr)`);
    lines.push(`root:`, ...cycleRootLines(host, "done"));
  }
  lines.push(`done:`, `  ret void`, `}`);
  return lines;
}

/** The inlinable half of an object release. A reference that is neither the
 * last one nor immortal (rc - 2 < SIZE_MAX - 2 rules out 0, 1 and SIZE_MAX
 * in one compare) only decrements and, for headered objects, takes the
 * possible-root step. NULL, immortal and last references call `slow`, which
 * holds the complete release: inlining it everywhere would copy teardowns
 * (and their destroy calls) into every caller. */
export function releaseFastPath(
  host: ShapeHost,
  fnName: string,
  slow: string,
  traced: boolean,
  comment = "",
): string[] {
  const S = host.sizeType;
  return [
    `define internal void @${fnName}(ptr %o) ${FN_ATTRS} {${comment ? ` ; ${comment} (fast path)` : ""}`,
    `entry:`,
    `  %isnull = icmp eq ptr %o, null`,
    `  br i1 %isnull, label %done, label %check`,
    `check:`,
    `  %rc = load ${S}, ptr %o`,
    `  %rcm2 = sub ${S} %rc, 2`,
    `  %shared = icmp ult ${S} %rcm2, -3`,
    `  br i1 %shared, label %dec, label %slow`,
    `dec:`,
    `  %n = sub ${S} %rc, 1`,
    `  store ${S} %n, ptr %o`,
    ...(traced ? cycleRootLines(host, "done") : [`  br label %done`]),
    `slow:`,
    `  call void @${slow}(ptr %o)`,
    `  br label %done`,
    `done:`,
    `  ret void`,
    `}`,
  ];
}

/** The possible-cycle-root step of a release that left a headered object
 * alive: scr_cyc_on_release with its early return inlined. Read `buffered`
 * (the i16 four bytes after color; nonzero for a queued candidate or a
 * tenured object) and call the runtime only to enqueue a new candidate.
 * Every emitted release of a headered object shares this sequence
 * (scr_runtime.h asserts the offset); it ends by branching to `done`. */
export function cycleRootLines(host: ShapeHost, done: string): string[] {
  const S = host.sizeType;
  host.declare(`declare void @scr_cyc_on_release(ptr)`);
  return [
    `  %bufp = getelementptr i8, ptr %o, ${S} -${host.cycleColorOffset - 4}`,
    `  %buf = load i16, ptr %bufp`,
    `  %queued = icmp ne i16 %buf, 0`,
    `  br i1 %queued, label %${done}, label %enqueue`,
    `enqueue:`,
    `  call void @scr_cyc_on_release(ptr %o) ; buffer the candidate; may collect`,
    `  br label %${done}`,
  ];
}

/** Per-record-shape LLVM emission: the named struct types (returned as
 * `typeDefs`) and the new/retain/release (+trace/gcFree for cycle-capable
 * shapes) function definitions (`defs`). Layout follows the runtime ABI:
 * `{ i64 rc, fields..., [ptr overflow] }`; the retain/release signatures
 * are already `_v`-shaped, so the same symbols serve as container RC
 * entry points. */
export function emitRecordShapes(
  host: ShapeHost,
  mod: IrModule,
): { typeDefs: string[]; defs: string[] } {
  const typeDefs: string[] = [];
  const defs: string[] = [];
  const records = mod.records ?? [];
  if (records.length === 0) return { typeDefs, defs };
  const audit = host.objectAudit !== false;
  if (audit) {
    host.declare(`declare void @scr_obj_alloc_note()`);
    host.declare(`declare void @scr_obj_free_note()`);
  }

  for (const shape of records) {
    const struct = mangleRecordStruct(shape.id);
    const fieldTys = shape.fields.map((f) => llFieldType(f.type));
    if (shape.indexValue) fieldTys.push("ptr"); // the overflow ScrMap *
    typeDefs.push(
      `%${struct} = type { ${host.sizeType}${fieldTys.length ? ", " + fieldTys.join(", ") : ""} } ` +
        `; record ${shape.id} { ${shape.fields.map((f) => llvmCommentText(f.name)).join("; ")}${shape.indexValue ? "; [key: string]" : ""} }`,
    );
  }

  for (const shape of records) {
    const struct = mangleRecordStruct(shape.id);
    const traced = host.tracedShapes.has(`record:${shape.id}`);
    const members = rcMembers(shape);
    const refMembers = members.filter((m) => isRefCounted(m.type));
    const sizeOf = `ptrtoint (ptr getelementptr (%${struct}, ptr null, i32 1) to ${host.sizeType})`;

    defs.push(...retainBody(host, mangleRecordRetain(shape.id)), ``);

    // release: NULL-tolerant, immortal-skip; at rc == 0 release every
    // refcounted member (runtime releases are NULL-tolerant) and free —
    // traced shapes route through the collector (on_dead/on_release,
    // scr_cyc_free) exactly like shapes.ts.
    const freeBody: string[] = [];
    let t = 0;
    for (const m of refMembers) {
      freeBody.push(
        `  %f${t} = getelementptr inbounds %${struct}, ptr %o, i64 0, i32 ${m.index}`,
        `  %v${t} = load ptr, ptr %f${t}`,
        `  call void ${releaseSym(host, m.type)}(ptr %v${t}) ; ${llvmCommentText(m.name)}`,
      );
      t++;
    }
    freeBody.push(...emitObjectFree(host, traced));
    defs.push(
      ...releaseBody(
        host,
        mangleRecordRelease(shape.id),
        traced,
        freeBody,
        "",
        refMembers.some((member) => needsBoundedRelease(member.type)),
      ),
      ``,
    );

    // new: zeroed allocation (+ the overflow map on index-signature
    // shapes), rc = 1. Traced shapes allocate with the collector header;
    // alloc.ts inlines the allocator fast paths and the alloc note.
    const nw: string[] = [
      `define internal ptr @${mangleRecordNew(shape.id)}() ${FN_ATTRS} {`,
      `entry:`,
    ];
    nw.push(
      ...emitObjectAlloc(
        host,
        sizeOf,
        traced
          ? {
              trace: `@${mangleRecordTrace(shape.id)}`,
              free: `@${mangleRecordGcFree(shape.id)}`,
            }
          : null,
      ),
    );
    nw.push(`  store ${host.sizeType} 1, ptr %o`);
    if (shape.indexValue) {
      // The overflow map (string-keyed): value handling is type-directed
      // exactly like shapes.ts's overflowNewC.
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
    nw.push(`  ret ptr %o`, `}`, ``);
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
        const stored = isRefCounted(field.type) ? `%sr${i}` : `%sv${i}`;
        if (isRefCounted(field.type)) {
          clone.push(`  ${stored} = call ptr ${retainSym(host, field.type)}(ptr %sv${i})`);
        }
        clone.push(
          `  %dp${i} = getelementptr inbounds %${struct}, ptr %o, i64 0, i32 ${index}`,
          `  store ${fieldTy} ${stored}, ptr %dp${i} ; ${llvmCommentText(field.name)}`,
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
          `  call void %visit(ptr %v${i}, ptr %ctx) ; ${llvmCommentText(m.name)}`,
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
          `  call void ${releaseSym(host, m.type)}(ptr %v${i}) ; ${llvmCommentText(m.name)} (acyclic)`,
        );
      });
      gf.push(...emitObjectFree(host, true), `  ret void`, `}`, ``);
      defs.push(...gf);
    }
  }
  return { typeDefs, defs };
}
