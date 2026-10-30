/** Type-directed reference counting, tracing, boxes and record layouts.
 * Containers store erased adapters; shape helpers retain, release and trace
 * their fields. Every allocation has a size_t reference count at offset zero
 * and participates in the runtime allocation audit. */
import type { IrClassDef, IrModule, IrRecordShape, IrType } from "../../ir/ir.js";
import {
  isIdentityCollectionKey,
  isRefCounted,
  mapOf,
  POINTER_KINDS,
  runtimeRcStem,
  RUNTIME_EMITTER_CLASS,
  RUNTIME_EVENT_CLASS,
  RUNTIME_EVENT_TARGET_CLASS,
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
import { cycTypeDescriptor, emitObjectAlloc, emitObjectFree } from "./alloc.js";
import type { BlockBuilder } from "./blocks.js";
import { SCR_ARR_FIELD, llvmCommentText } from "./common.js";
import type { NullableUnions } from "./nullable-unions.js";
import {
  INLINE_UNION_FIELD,
  loadInlineUnion,
  stackUnionBox,
  type InlineUnionFields,
} from "./inline-unions.js";
import { LlvmUnsupportedError } from "./unsupported.js";

/** What the tables need from the emitter: the extern-declaration ledger
 * and the module-wide cycle/shape indexes. */
export interface ShapeHost {
  declare(decl: string): void;
  /** The hierarchy root of a class (a program class or a runtime base),
   * or undefined for classes outside the class graph. */
  classRootOf?(className: string): string | undefined;
  /** Request the shared OOM abort helper (@sc_oom) — emitted once. */
  needOom(): void;
  /** The immutable ScrMapOps descriptor (scr_map.h) of a Map or Set type:
   * a module constant holding the LLVM operands { key retain, key release,
   * key trace, value retain, value release, value trace, union key kinds },
   * or `null` when every operand is null. */
  mapOps(operands: readonly string[]): string;
  /** The target C ABI's `size_t` / refcount integer type. */
  readonly sizeType: "i32" | "i64";
  /** Byte offset from an object pointer back to ScrCycHdr.buf. */
  readonly cycleBufOffset: number;
  readonly tracedShapes: Set<string>;
  /** Exposed records can own an out-of-line dynamic metadata bag. */
  readonly recordMetadataShapes?: ReadonlySet<string>;
  readonly tracedUnions: Set<string>;
  /** Unions represented as a nullable arm pointer (nullable-unions.ts):
   * their RC and trace entry points are the arm's NULL-tolerant ones. */
  readonly nullableUnions: NullableUnions;
  /** Record and class fields that store a scalar union's tag and bits
   * inline (inline-unions.ts): they own nothing. */
  readonly inlineUnions: InlineUnionFields;
  /** The zeroed `%ScrUnion` an inline store reads for a NULL dummy. */
  unionNoneRef(): string;
  readonly recordsById: Map<string, IrRecordShape>;
  readonly recordCloneShapes: ReadonlySet<string>;
  /** The program constructs lifetime regions: the ProgramLifetime classes
   * allocate in regions and count references in their region chunk instead
   * of being empty (llvm/regions.ts). */
  regions?: RegionHooks | null;
  /** The alias tag of a runtime word that lifetime-region code reads and
   * writes outside every field: the chunk count, the chunk owner, the class
   * cursors and scr_region_counting (", !tbaa !N", or "" in debug builds). */
  regionAliasTag?(word: "count" | "owner" | "cursor" | "counting"): string;
  /** Emit the live-object audit notes (`scr_obj_alloc_note` /
   * `scr_obj_free_note`) in emitted new/free helpers. Only runtimes built
   * with SCR_RC_AUDIT (the sanitized lane) count them; release and dev
   * runtime packs define them empty, so plain builds omit the calls.
   * Absent means emit. */
  readonly objectAudit?: boolean;
  /** Inline the small-object allocator's fast paths (llvm/alloc.ts). */
  readonly inlineAlloc?: boolean;
  /** Worker executables: the inline allocator state is thread-local. */
  readonly threadLocalAlloc?: boolean;
  /** Inline RC fast-path helpers requested so far ("<family>:<op>"); the
   * emitter defines each once through {@link emitInlineRcHelpers}. Null
   * keeps every retain/release a runtime call. */
  readonly rcHelpers: Set<string> | null;
  /** Which fast paths are inlined (see {@link InlineRcMode}). */
  readonly rcMode?: InlineRcMode;
  /** Define the fast-path helpers `noinline` (see {@link inlineRcOption}). */
  readonly rcHelpersNoinline?: boolean;
  /** The next collector statistics index for an emitted ScrCycType
   * descriptor (cycTypeDescriptor), counting from FIRST_EMITTED_CYC_KIND
   * in emission order.
   * Absent: every descriptor gets 0, which keeps no statistics. */
  nextCycKind?(): number;
}

/** What class emission asks of lifetime regions (LifetimeRegions in
 * llvm/regions.ts): the retain and release bodies, the allocation lines of
 * `new` (the instance in `%o`), and a class's region definitions. */
export interface RegionHooks {
  rcBody(fnName: string, ret: "ptr" | "void", comment: string): string[];
  newAlloc(className: string, sizeOf: string): string[];
  classDefinitions(cls: IrClassDef, sizeOf: string): string[];
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
    case "object": {
      // Subclasses of the runtime EventTarget and Event bases share the
      // runtime's adapters (the same rc word and vtable dispatch as the
      // emitted helpers): the engine recognizes their checked-dynamic
      // capsules by the release adapter.
      const root = host.classRootOf?.(t.className);
      const runtime =
        root === RUNTIME_EVENT_TARGET_CLASS
          ? { retain: "scr_event_target_obj_retain_v", release: "scr_event_target_obj_release_v" }
          : root === RUNTIME_EVENT_CLASS
            ? { retain: "scr_event_obj_retain_v", release: "scr_event_obj_release_v" }
            : null;
      if (runtime !== null) {
        host.declare(`declare ptr @${runtime.retain}(ptr)`);
        host.declare(`declare void @${runtime.release}(ptr)`);
        return { retain: `@${runtime.retain}`, release: `@${runtime.release}` };
      }
      // Emitted per-class helpers are already `_v`-shaped (ptr → ptr /
      // ptr → void), so the same symbols serve as container entry points.
      return {
        retain: `@${mangleClassRetain(t.className)}`,
        release: `@${mangleClassRelease(t.className)}`,
      };
    }
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
  if (host.rcHelpers !== null && stem !== null && inlineRcFamily(host, stem, "retain") !== null) {
    return inlineRcSym(host, stem, "retain");
  }
  // Direct retains keep the emitted helper (vAdapters' runtime adapters
  // are for capsule and container entry points).
  if (t.kind === "object" && stem === null) return `@${mangleClassRetain(t.className)}`;
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
  if (host.rcHelpers !== null && stem !== null && inlineRcFamily(host, stem, "release") !== null) {
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
 * never, always, or per object through the header flag its C release
 * tests (`a->cyc`, `m->traced`). */
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
 * The dyn release buffers a surviving value by kind (scr_dyn_release):
 * the fast path decides the always and never cases and calls
 * scr_dyn_release_survivor for kinds whose candidacy is per value,
 * including arrays and objects of intact documents (ScrDynRegion).
 *
 * Releases stay plain calls for:
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
  dyn: { cycle: "always", retainNull: false, release: "scr_dyn_release" },
};

type RcOp = "retain" | "release";

/** The mirrored family for an RC operation on a runtime stem (`scr_str`),
 * or null when it stays a call. */
export function inlineRcFamily(host: ShapeHost, stem: string, op: RcOp): InlineRcFamily | null {
  return mirroredFamily(host, stem.replace(/^scr_/, ""), op);
}

/** Which RC fast paths an emission inlines. `speed` mirrors every family
 * with a fast path. `release` mirrors only the string retain and the dyn
 * retain and release: the operations that dominate dynamic-value and string
 * code, at almost no size cost. String releases stay calls in `release`
 * because string-heavy programs have many release sites. */
export type InlineRcMode = "release" | "speed";

const RELEASE_RC_OPS = new Set(["str:retain", "dyn:retain", "dyn:release"]);

/** The emitter's inline RC option for a native optimization posture: none
 * at `dev`, the `release` subset by default. Sanitized builds compile the
 * whole program in one AddressSanitizer pass, whose time grows with every
 * inlined fast path, so they call the same helpers out of line. */
export function inlineRcOption(
  optimization: string | undefined,
  sanitize = false,
): { inlineRc?: InlineRcMode; rcHelpersNoinline?: true } {
  if (optimization === "dev") return {};
  return {
    inlineRc: optimization === "speed" ? "speed" : "release",
    ...(sanitize ? { rcHelpersNoinline: true as const } : {}),
  };
}

function mirroredFamily(host: ShapeHost, family: string, op: RcOp): InlineRcFamily | null {
  if (!Object.hasOwn(INLINE_RC_FAMILIES, family)) return null;
  if (host.rcMode !== "speed" && !RELEASE_RC_OPS.has(`${family}:${op}`)) return null;
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
  if (host.rcHelpers === null || mirroredFamily(host, "box", "release") === null) {
    host.declare(`declare void @scr_box_release(ptr)`);
    return "@scr_box_release";
  }
  return requestRcHelper(host, "box", "release");
}

/** Record the helper and declare the runtime symbols it calls now, so they
 * land in the extern block. */
function requestRcHelper(host: ShapeHost, family: string, op: RcOp): string {
  if (host.rcHelpers === null || mirroredFamily(host, family, op) === null) {
    throw new LlvmUnsupportedError(`inline rc:${family}:${op}`);
  }
  host.rcHelpers.add(`${family}:${op}`);
  for (const decl of rcHelperDecls(family, op)) host.declare(decl);
  return `@${inlineRcName(family, op)}`;
}

function rcHelperAttrs(host: ShapeHost): string {
  return host.rcHelpersNoinline === true ? `noinline ${FN_ATTRS}` : FN_ATTRS;
}

function inlineRcName(family: string, op: RcOp): string {
  return `sc_rc_${op}_${family}`;
}

/** Inlined dyn releases one function body keeps. LLVM's optimization time
 * grows faster than the number of inlined releases in one function, and
 * generated dispatch tables and module initializers of large packages have
 * thousands of release sites; a body with more calls scr_dyn_release, which
 * the inline helper mirrors, at every site. */
export const INLINE_DYN_RELEASES_PER_FUNCTION = 256;

/** Apply {@link INLINE_DYN_RELEASES_PER_FUNCTION} to each function of an
 * emitted module, given as parts joined by newlines. A function can span
 * parts (main's lines) and a part can hold several functions. */
export function limitInlineDynReleases(parts: readonly string[]): string[] {
  const call = `call void @${inlineRcName("dyn", "release")}(`;
  const runtime = `call void @${INLINE_RC_FAMILIES["dyn"]!.release}(`;
  // The function each release site belongs to: the last `define` line
  // before it, counted over the joined text.
  const sites = (
    part: string,
    each: (offset: number, fn: number) => void,
    first: number,
  ): number => {
    let fn = first;
    let define = part.startsWith("define ") ? 0 : part.indexOf("\ndefine ");
    for (let at = part.indexOf(call); at >= 0; at = part.indexOf(call, at + call.length)) {
      while (define >= 0 && define < at) {
        fn++;
        define = part.indexOf("\ndefine ", define + 1);
      }
      each(at, fn);
    }
    while (define >= 0) {
      fn++;
      define = part.indexOf("\ndefine ", define + 1);
    }
    return fn;
  };
  const counts = new Map<number, number>();
  let fn = 0;
  for (const part of parts) fn = sites(part, (_, f) => counts.set(f, (counts.get(f) ?? 0) + 1), fn);
  const over = new Set(
    [...counts].filter(([, n]) => n > INLINE_DYN_RELEASES_PER_FUNCTION).map(([f]) => f),
  );
  if (over.size === 0) return [...parts];
  fn = 0;
  return parts.map((part) => {
    const cuts: number[] = [];
    fn = sites(
      part,
      (at, f) => {
        if (over.has(f)) cuts.push(at);
      },
      fn,
    );
    if (cuts.length === 0) return part;
    let out = "";
    let from = 0;
    for (const at of cuts) {
      out += part.slice(from, at) + runtime;
      from = at + call.length;
    }
    return out + part.slice(from);
  });
}

function rcHelperDecls(family: string, op: RcOp): string[] {
  const row = INLINE_RC_FAMILIES[family]!;
  if (op === "retain" || row.release === null) return [];
  return [
    `declare void @${row.release}(ptr)`,
    ...(row.cycle === "always" ? [`declare void @scr_cyc_on_release(ptr)`] : []),
    ...(family === "dyn" ? [`declare void @scr_dyn_release_survivor(ptr)`] : []),
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
 * header (the C retain/release header test), else to `no`. */
function rcHeaderTest(cycle: "arr" | "map", yes: string, no: string): string[] {
  if (cycle === "arr") {
    return [
      `  %cycp = getelementptr inbounds %ScrArr, ptr %o, i32 0, i32 ${SCR_ARR_FIELD.cyc} ; cyc`,
      `  %cyc = load i8, ptr %cycp`,
      `  %headered = icmp ne i8 %cyc, 0`,
      `  br i1 %headered, label %${yes}, label %${no}`,
    ];
  }
  return [
    `  %tracedp = getelementptr inbounds %ScrMapRc, ptr %o, i32 0, i32 3 ; traced`,
    `  %traced = load i8, ptr %tracedp`,
    `  %headered = icmp ne i8 %traced, 0`,
    `  br i1 %headered, label %${yes}, label %${no}`,
  ];
}

function retainHelper(host: ShapeHost, family: string, row: InlineRcFamily): string[] {
  const S = host.sizeType;
  return [
    `define internal ptr @${inlineRcName(family, "retain")}(ptr %o) ${rcHelperAttrs(host)} { ; scr_${family}_retain fast path`,
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
    `define internal void @${inlineRcName(family, "release")}(ptr %o) ${rcHelperAttrs(host)} { ; ${row.release} fast path`,
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
      : family === "dyn"
        ? [
            // scr_dyn_release buffers a surviving value by kind: always for
            // functions and proxies, per value for arrays and objects (not
            // while their document is intact, ScrDynRegion), capsules and
            // handles (scr_dyn_release_survivor), never for scalars. An
            // array or object already in a candidate buffer stays inline.
            `  %kp = getelementptr i8, ptr %o, ${S} ${S === "i64" ? 8 : 4} ; ScrDyn.kind`,
            `  %kind = load i32, ptr %kp`,
            // SCR_DYN_ARR 4, OBJ 5, FUNC 8, PROXY 13; HANDLE 9, TYPED_REF 12.
            `  switch i32 %kind, label %done [ i32 4, label %container i32 5, label %container i32 8, label %root i32 13, label %root i32 9, label %survivor i32 12, label %survivor ]`,
            `container:`,
            `  %cbufp = getelementptr i8, ptr %o, ${S} -${host.cycleBufOffset}`,
            `  %cbuf = load i32, ptr %cbufp`,
            `  %cqueued = icmp slt i32 %cbuf, 0`,
            `  br i1 %cqueued, label %done, label %survivor`,
            `survivor:`,
            `  call void @scr_dyn_release_survivor(ptr %o)`,
            `  br label %done`,
            `root:`,
          ]
        : family === "box"
          ? [
              // scr_box_release buffers a surviving box only when its trace
              // visits the payload (scr_box_traced): an array (3), closure (4), or a
              // class instance whose obj_trace is set.
              `  %kp = getelementptr i8, ptr %o, ${S} ${S === "i64" ? 8 : 4} ; ScrBox.kind`,
              `  %kind = load i32, ptr %kp`,
              `  %array = icmp eq i32 %kind, 3`,
              `  %func = icmp eq i32 %kind, 4`,
              `  %known = or i1 %array, %func`,
              `  br i1 %known, label %root, label %objbox`,
              `objbox:`,
              `  %otp = getelementptr i8, ptr %o, ${S} ${S === "i64" ? 32 : 16} ; ScrBox.obj_trace`,
              `  %ot = load ptr, ptr %otp`,
              `  %untraced = icmp eq ptr %ot, null`,
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
      // The EventTarget and Event bases have no instances of their own:
      // values of subclasses trace through their own classes' entries.
      if (t.className === RUNTIME_EVENT_TARGET_CLASS || t.className === RUNTIME_EVENT_CLASS)
        return null;
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
      // Named properties can close cycles even when indexed slots are scalars.
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
 * construct through scr_arr_new_ops with the element type's `_v` RC entry
 * points; every other element kind keeps the plain scr_arr_new call. */
export function arrNewCall(
  host: ShapeHost,
  elem: IrType,
  capText: string,
  /** An empty array expected to receive a few elements (its first slots
   * live in its own block): capText must be "0". */
  small = false,
): string {
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
    elem.kind === "netServer" ||
    elem.kind === "dyn" || // native collection seeds/drains: traced REF
    elem.kind === "regex" || // RegExp values: scr_regex_* adapters, no trace (no refs inside)
    (elem.kind === "array" && traceAdapter(host, elem) !== null);
  if (!useRef) {
    if (small) {
      host.declare(`declare ptr @scr_arr_new_small(i32)`);
      return `call ptr @scr_arr_new_small(i32 ${elemKindNum(elem)})`;
    }
    host.declare(`declare ptr @scr_arr_new(i32, ${host.sizeType})`);
    return `call ptr @scr_arr_new(i32 ${elemKindNum(elem)}, ${host.sizeType} ${capText})`;
  }
  if (small) {
    host.declare(`declare ptr @scr_arr_new_ops_small(ptr)`);
    return `call ptr @scr_arr_new_ops_small(ptr ${arrOps(host, elem)})`;
  }
  host.declare(`declare ptr @scr_arr_new_ops(ptr, ${host.sizeType})`);
  return `call ptr @scr_arr_new_ops(ptr ${arrOps(host, elem)}, ${host.sizeType} ${capText})`;
}

/** The constant %ScrArrOps descriptor (retain, release, trace) of a REF
 * element type, defined once per module and shared by all its arrays. */
export function arrOps(host: ShapeHost, elem: IrType): string {
  const v = vAdapters(host, elem);
  const trace = traceArg(host, elem);
  const part = (sym: string): string => sym.replace(/^@/, "").replace(/[^A-Za-z0-9_.]/g, "_");
  const name = `@sc_arrops.${part(v.retain)}.${part(v.release)}.${part(trace)}`;
  host.declare(
    `${name} = internal constant %ScrArrOps { ptr ${v.retain}, ptr ${v.release}, ptr ${trace} }`,
  );
  return name;
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
 * _Bool layout); loads/stores convert at the access site. An `inline`
 * scalar-union field stores its tag and bits (inline-unions.ts). */
export function llFieldType(
  t: IrType,
  inline: boolean,
): "double" | "i8" | "ptr" | typeof INLINE_UNION_FIELD {
  if (inline) return INLINE_UNION_FIELD;
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

/** Loads a struct field slot for helper code: i8 bools truncate to i1, and
 * an inline union field lends a private stack box with the slot's own
 * bits (ABSENT included). */
export function loadStructField(
  B: BlockBuilder,
  sizeType: "i32" | "i64",
  ptr: string,
  t: IrType,
  inline: boolean,
): string {
  if (inline) {
    const { tag, bits } = loadInlineUnion(B, ptr);
    return stackUnionBox(B, sizeType, tag, bits);
  }
  const fieldTy = llFieldType(t, false);
  const raw = B.tmp();
  B.line(`${raw} = load ${fieldTy}, ptr ${ptr}`);
  if (fieldTy !== "i8") return raw;
  const b = B.tmp();
  B.line(`${b} = trunc i8 ${raw} to i1`);
  return b;
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

/** The byte offset of ScrMap.flags (scr_map.h), whose SCR_MAP_NULL_PROTO
 * bit marks a null-prototype record's overflow map. */
export function mapFlagsOffset(sizeType: "i32" | "i64"): number {
  return (sizeType === "i64" ? 8 : 4) + 3;
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

/** The RC-relevant members of a shape: every field except inline scalar
 * unions, plus the overflow map on index-signature shapes (one more
 * map-typed member). `index` is the member's field position in the
 * emitted struct type (rc header at 0). */
export function rcMembers(
  shape: IrRecordShape,
  inline: InlineUnionFields,
): { index: number; type: IrType; name: string }[] {
  return [
    ...shape.fields.flatMap((f, i) =>
      inline.record(f.type) ? [] : [{ index: i + 1, type: f.type, name: f.name }],
    ),
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
export function retainBody(
  host: ShapeHost,
  fnName: string,
  comment = "",
  immortal = false,
): string[] {
  const S = host.sizeType;
  if (immortal) return immortalRcBody(host, fnName, "ptr", comment);
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

/** The retain or release entry point of a class whose every instance lives
 * until the process exits (no collector header; see classes.ts
 * programLifetimeClass and programLifetimeRc): nothing to count, so every
 * inlined call site folds away. Programs with lifetime regions count the
 * references in the instance's region chunk instead (llvm/regions.ts). */
function immortalRcBody(
  host: ShapeHost,
  fnName: string,
  ret: "ptr" | "void",
  comment: string,
): string[] {
  const regions: RegionHooks | null = host.regions ?? null;
  if (regions !== null) return regions.rcBody(fnName, ret, comment);
  return [
    `define internal ${ret} @${fnName}(ptr %o) ${FN_ATTRS} {${comment ? ` ; ${comment} (immortal)` : ""}`,
    `entry:`,
    ret === "ptr" ? `  ret ptr %o` : `  ret void`,
    `}`,
  ];
}

/** Scalar fields and native strings cannot form recursive ownership chains.
 * Other reference kinds conservatively share the runtime destruction budget. */
export function needsBoundedRelease(type: IrType): boolean {
  return isRefCounted(type) && type.kind !== "string";
}

/** Typed teardown. A teardown that drops the last reference to a child of a
 * statically known emitted type calls that type's teardown directly instead
 * of going through its out-of-line release and the runtime's generic
 * scr_rc_destroy, so tearing down a tree of one type is one direct call per
 * node. Such teardowns take the length of the direct chain they are in
 * (`_destroy_d(ptr, i32)`; `_destroy(ptr)` starts one at 0 for the runtime),
 * and a chain DIRECT_DESTROY_CHAIN deep hands the next child to
 * scr_rc_destroy, whose depth budget then bounds the stack exactly as
 * before: each of its levels holds at most one direct chain. */
export const DIRECT_DESTROY_CHAIN = 16;

/** A child type whose teardown a parent teardown can call directly. */
export interface DirectDestroy {
  /** The child's inlinable release (every reference but the last). */
  readonly release: string;
  /** The child's teardown symbol; `${destroy}_d` takes the chain length. */
  readonly destroy: string;
  /** The child carries a collector header. */
  readonly traced: boolean;
}

/** The release of child `value` (a loaded field, possibly NULL) inside a
 * teardown whose chain length is `%d`: the child's own release for a shared
 * or immortal reference, its teardown for the last one. Labels use `tag`;
 * the lines end in the open block `${tag}.next`. */
export function directChildReleaseLines(
  host: ShapeHost,
  tag: string,
  value: string,
  target: DirectDestroy,
  comment: string,
): string[] {
  const S = host.sizeType;
  host.declare(`declare void @scr_rc_destroy(ptr, ptr)`);
  const lines = [
    `  %${tag}.nn = icmp ne ptr ${value}, null`,
    `  br i1 %${tag}.nn, label %${tag}.chk, label %${tag}.next`,
    `${tag}.chk:`,
    `  %${tag}.rc = load ${S}, ptr ${value}`,
    `  %${tag}.last = icmp eq ${S} %${tag}.rc, 1`,
    `  br i1 %${tag}.last, label %${tag}.dead, label %${tag}.shared`,
    `${tag}.shared:`,
    `  call void ${target.release}(ptr ${value}) ; ${comment}`,
    `  br label %${tag}.next`,
    `${tag}.dead: ; ${comment}: the last reference`,
    `  store ${S} 0, ptr ${value}`,
  ];
  if (target.traced) {
    host.declare(`declare void @scr_cyc_on_dead(ptr)`);
    lines.push(
      `  %${tag}.bufp = getelementptr i8, ptr ${value}, ${S} -${host.cycleBufOffset}`,
      `  %${tag}.buf = load i32, ptr %${tag}.bufp`,
      `  %${tag}.queued = icmp slt i32 %${tag}.buf, 0`,
      `  br i1 %${tag}.queued, label %${tag}.unbuffer, label %${tag}.teardown`,
      `${tag}.unbuffer:`,
      `  call void @scr_cyc_on_dead(ptr ${value})`,
      `  br label %${tag}.teardown`,
      `${tag}.teardown:`,
    );
  }
  lines.push(
    `  %${tag}.short = icmp ult i32 %d, ${DIRECT_DESTROY_CHAIN}`,
    `  br i1 %${tag}.short, label %${tag}.direct, label %${tag}.bounded`,
    `${tag}.direct:`,
    `  %${tag}.d = add i32 %d, 1`,
    `  call void @${target.destroy}_d(ptr ${value}, i32 %${tag}.d)`,
    `  br label %${tag}.next`,
    `${tag}.bounded:`,
    `  call void @scr_rc_destroy(ptr ${value}, ptr @${target.destroy})`,
    `  br label %${tag}.next`,
    `${tag}.next:`,
  );
  return lines;
}

/** The direct-teardown target of a reference of `type`, if `targets` (keyed
 * `record:<id>` / `object:<class>`) has one. Nullable unions hold the arm's
 * pointer, NULL or an immortal sentinel, which the child release handles. */
export function directDestroyTarget(
  host: ShapeHost,
  type: IrType,
  targets: ReadonlyMap<string, DirectDestroy>,
): DirectDestroy | null {
  const key = directDestroyKey(host, type);
  return key === null ? null : (targets.get(key) ?? null);
}

function directDestroyKey(host: ShapeHost, type: IrType): string | null {
  const t = host.nullableUnions.of(type)?.arm ?? type;
  if (t.kind === "record") return `record:${t.shapeId}`;
  return t.kind === "object" ? `object:${t.className}` : null;
}

/** The direct targets among `candidates` that a field of one of `fieldTypes`
 * refers to: a teardown no parent calls directly keeps its plain form. */
export function usedDirectTargets(
  host: ShapeHost,
  candidates: readonly (readonly [string, DirectDestroy])[],
  fieldTypes: readonly IrType[],
): Map<string, DirectDestroy> {
  const all = new Map(candidates);
  const used = new Map<string, DirectDestroy>();
  for (const type of fieldTypes) {
    const key = directDestroyKey(host, type);
    const target = key === null ? undefined : all.get(key);
    if (key !== null && target !== undefined) used.set(key, target);
  }
  return used;
}

/** The teardown definitions for `destroy`: with `chained`, the body takes
 * the chain length `%d` (directChildReleaseLines) and the runtime's
 * one-argument entry starts a chain. */
export function destroyDefinitions(
  destroy: string,
  body: readonly string[],
  chained: boolean,
): string[] {
  if (!chained)
    return [
      `define internal void @${destroy}(ptr %o) ${FN_ATTRS} {`,
      `entry:`,
      ...body,
      `  ret void`,
      `}`,
    ];
  return [
    `define internal void @${destroy}_d(ptr %o, i32 %d) ${FN_ATTRS} {`,
    `entry:`,
    ...body,
    `  ret void`,
    `}`,
    `define internal void @${destroy}(ptr %o) ${FN_ATTRS} {`,
    `entry:`,
    `  call void @${destroy}_d(ptr %o, i32 0)`,
    `  ret void`,
    `}`,
  ];
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
  immortal = false,
  chained = false,
): string[] {
  const S = host.sizeType;
  if (bounded) host.declare(`declare void @scr_rc_destroy(ptr, ptr)`);
  const destroy = `${fnName}_destroy`;
  const lines = [
    ...(bounded ? destroyDefinitions(destroy, freeBody, chained) : []),
    ...releaseFastPath(host, fnName, `${fnName}_slow`, traced, comment, immortal),
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
    ...(traced ? cycleDeadLines(host, "teardown") : []),
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
 * possible-root step. Immortal references return; NULL and last references
 * call `slow`, which
 * holds the complete release: inlining it everywhere would copy teardowns
 * (and their destroy calls) into every caller. */
export function releaseFastPath(
  host: ShapeHost,
  fnName: string,
  slow: string,
  traced: boolean,
  comment = "",
  immortal = false,
): string[] {
  const S = host.sizeType;
  if (immortal) return immortalRcBody(host, fnName, "void", comment);
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
    // Immortal objects (static literals, published graphs) return here
    // rather than through the out-of-line call: releases of a published
    // graph's objects are as frequent as ordinary ones.
    `slow:`,
    `  %imm = icmp eq ${S} %rc, -1`,
    `  br i1 %imm, label %done, label %slowcall`,
    `slowcall:`,
    `  call void @${slow}(ptr %o)`,
    `  br label %done`,
    `done:`,
    `  ret void`,
    `}`,
  ];
}

/** The possible-cycle-root step of a release that left a headered object
 * alive: scr_cyc_on_release with its early return inlined. Test the sign
 * of `buf` (the i32 at obj-4; negative for a queued candidate or a tenured
 * object) and call the runtime only to enqueue a new candidate.
 * Every emitted release of a headered object shares this sequence
 * (scr_runtime.h asserts the offset); it ends by branching to `done`. */
/** One traced field of an emitted trace function: load the slot and visit
 * it unless it is null. Every collector visitor ignores null children, and
 * most traced slots of a typical heap are empty (optional links, unset
 * caches), so testing here saves an indirect call per empty slot on every
 * collector walk. The sequence ends in the new block `tv<i>.next`. */
export function traceFieldVisitLines(
  struct: string,
  index: number,
  i: number,
  comment: string,
): string[] {
  return [
    `  %f${i} = getelementptr inbounds %${struct}, ptr %o, i64 0, i32 ${index}`,
    `  %v${i} = load ptr, ptr %f${i}`,
    `  %z${i} = icmp eq ptr %v${i}, null`,
    `  br i1 %z${i}, label %tv${i}.next, label %tv${i}.visit`,
    `tv${i}.visit:`,
    `  call void %visit(ptr %v${i}, ptr %ctx) ; ${comment}`,
    `  br label %tv${i}.next`,
    `tv${i}.next:`,
  ];
}

export function cycleRootLines(host: ShapeHost, done: string): string[] {
  const S = host.sizeType;
  host.declare(`declare void @scr_cyc_on_release(ptr)`);
  return [
    `  %bufp = getelementptr i8, ptr %o, ${S} -${host.cycleBufOffset}`,
    `  %buf = load i32, ptr %bufp`,
    `  %queued = icmp slt i32 %buf, 0`,
    `  br i1 %queued, label %${done}, label %enqueue`,
    `enqueue:`,
    `  call void @scr_cyc_on_release(ptr %o) ; buffer the candidate; may collect`,
    `  br label %${done}`,
  ];
}

/** The death of a headered object: scr_cyc_on_dead with its early return
 * inlined. Only an object still in a candidate buffer
 * (`buffered` nonzero) has an entry to remove; the sequence continues at
 * the new block `next`. */
export function cycleDeadLines(host: ShapeHost, next: string): string[] {
  const S = host.sizeType;
  host.declare(`declare void @scr_cyc_on_dead(ptr)`);
  return [
    `  %dbufp = getelementptr i8, ptr %o, ${S} -${host.cycleBufOffset}`,
    `  %dbuf = load i32, ptr %dbufp`,
    `  %dqueued = icmp slt i32 %dbuf, 0`,
    `  br i1 %dqueued, label %unbuffer, label %${next}`,
    `unbuffer:`,
    `  call void @scr_cyc_on_dead(ptr %o)`,
    `  br label %${next}`,
    `${next}:`,
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
    const fieldTys = shape.fields.map((f) => llFieldType(f.type, host.inlineUnions.record(f.type)));
    if (shape.indexValue) fieldTys.push("ptr"); // the overflow ScrMap *
    typeDefs.push(
      `%${struct} = type { ${host.sizeType}${fieldTys.length ? ", " + fieldTys.join(", ") : ""} } ` +
        `; record ${shape.id} { ${shape.fields.map((f) => llvmCommentText(f.name)).join("; ")}${shape.indexValue ? "; [key: string]" : ""} }`,
    );
  }

  // Record shapes whose teardown is out of line (a bounded release) can be
  // torn down directly by a parent record's teardown; only shapes that some
  // record holds are.
  const candidates: [string, DirectDestroy][] = [];
  const memberTypes: IrType[] = [];
  for (const shape of records) {
    const members = rcMembers(shape, host.inlineUnions);
    for (const m of members) memberTypes.push(m.type);
    if (!members.some((m) => isRefCounted(m.type) && needsBoundedRelease(m.type))) continue;
    const release = mangleRecordRelease(shape.id);
    candidates.push([
      `record:${shape.id}`,
      {
        release: `@${release}`,
        destroy: `${release}_destroy`,
        traced: host.tracedShapes.has(`record:${shape.id}`),
      },
    ]);
  }
  const directTargets = usedDirectTargets(host, candidates, memberTypes);

  for (const shape of records) {
    const struct = mangleRecordStruct(shape.id);
    const traced = host.tracedShapes.has(`record:${shape.id}`);
    const members = rcMembers(shape, host.inlineUnions);
    const refMembers = members.filter((m) => isRefCounted(m.type));
    const sizeOf = `ptrtoint (ptr getelementptr (%${struct}, ptr null, i32 1) to ${host.sizeType})`;

    defs.push(...retainBody(host, mangleRecordRetain(shape.id)), ``);

    // release: NULL-tolerant, immortal-skip; at rc == 0 release every
    // refcounted member (runtime releases are NULL-tolerant) and free —
    // traced shapes route through the collector (on_dead/on_release,
    // scr_cyc_free) exactly like shapes.ts.
    const freeBody: string[] = [];
    let t = 0;
    // A teardown takes the chain length when it is a direct target or has
    // direct children.
    const chained =
      directTargets.has(`record:${shape.id}`) ||
      refMembers.some((m) => directDestroyTarget(host, m.type, directTargets) !== null);
    for (const m of refMembers) {
      freeBody.push(
        `  %f${t} = getelementptr inbounds %${struct}, ptr %o, i64 0, i32 ${m.index}`,
        `  %v${t} = load ptr, ptr %f${t}`,
      );
      const direct = directDestroyTarget(host, m.type, directTargets);
      if (direct) {
        freeBody.push(
          ...directChildReleaseLines(host, `td${t}`, `%v${t}`, direct, llvmCommentText(m.name)),
        );
      } else {
        freeBody.push(
          `  call void ${releaseSym(host, m.type)}(ptr %v${t}) ; ${llvmCommentText(m.name)}`,
        );
      }
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
        false,
        chained,
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
    const cycType = `@${mangleRecordTrace(shape.id)}.cyctype`;
    if (traced)
      defs.push(
        cycTypeDescriptor(
          cycType,
          `@${mangleRecordTrace(shape.id)}`,
          `@${mangleRecordGcFree(shape.id)}`,
          host.nextCycKind?.() ?? 0,
        ),
        ``,
      );
    nw.push(...emitObjectAlloc(host, sizeOf, traced ? { type: cycType } : null));
    nw.push(`  store ${host.sizeType} 1, ptr %o`);
    if (shape.indexValue) {
      // The overflow map (string-keyed): value handling is type-directed
      // exactly like shapes.ts's overflowNewC.
      host.declare(`declare ptr @scr_map_new(i32, i32, ptr)`);
      const v = shape.indexValue;
      const valKind = v.kind === "f64" ? 0 : v.kind === "bool" ? 1 : 2;
      const rc = valKind === 2 ? vAdapters(host, v) : { retain: "null", release: "null" };
      const trace = valKind === 2 ? traceArg(host, v) : "null";
      nw.push(
        `  %ovf = call ptr @scr_map_new(i32 1, i32 ${valKind}, ptr ${host.mapOps(["null", "null", "null", rc.retain, rc.release, trace, "null"])})`,
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
        const inline = host.inlineUnions.record(field.type);
        const fieldTy = llFieldType(field.type, inline);
        clone.push(
          `  %sp${i} = getelementptr inbounds %${struct}, ptr %src, i64 0, i32 ${index}`,
          `  %sv${i} = load ${fieldTy}, ptr %sp${i}`,
        );
        const owned = isRefCounted(field.type) && !inline;
        const stored = owned ? `%sr${i}` : `%sv${i}`;
        if (owned) {
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
      const metadata = host.recordMetadataShapes?.has(shape.id) === true;
      if (metadata) {
        host.declare(`declare void @scr_record_source_trace(ptr, ptr, ptr)`);
        tr.push(`  call void @scr_record_source_trace(ptr %o, ptr %visit, ptr %ctx)`);
      }
      tracedMembers.forEach((m, i) => {
        tr.push(...traceFieldVisitLines(struct, m.index, i, llvmCommentText(m.name)));
      });
      tr.push(`  ret void`, `}`, ``);
      defs.push(...tr);

      const gf: string[] = [
        `define internal void @${mangleRecordGcFree(shape.id)}(ptr %o) ${FN_ATTRS} {`,
        `entry:`,
      ];
      if (metadata) {
        // The collector accounted for this edge. Unlink before any child
        // release can re-enter disposal, without releasing the edge twice.
        host.declare(`declare void @scr_record_source_collected(ptr)`);
        gf.push(`  call void @scr_record_source_collected(ptr %o)`);
      }
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
