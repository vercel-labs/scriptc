/** Type-directed reference counting, tracing, boxes and record layouts.
 * Containers store erased adapters; shape helpers retain, release and trace
 * their fields. Every allocation has a size_t reference count at offset zero
 * and participates in the runtime allocation audit. */
import type { HeapCensus } from "./heap-census.js";
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
  DYN,
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
import {
  CYC_HDR,
  cycTypeDescriptor,
  emitObjectAlloc,
  emitObjectFree,
  emitSegmentFree,
  type FreeObservers,
  CYC_APPEND,
  cycleAppendDecls,
  cycleAppendHelper,
  inlineBufferingSupported,
} from "./alloc.js";
import type { BlockBuilder } from "./blocks.js";
import { SCR_ARR_FIELD, llvmCommentText } from "./common.js";
import {
  NULLABLE_NULL,
  SHAPE_WORD_INDEX,
  classReleaseFn,
  classRetainFn,
  classTraceFn,
  shapeReleaseFn,
  shapeTagFn,
  shapeTraceFn,
  shapeWordHeader,
  type ClassUnion,
  type NullableUnions,
  type ShapeUnion,
} from "./nullable-unions.js";
import {
  INLINE_UNION_FIELD,
  loadInlineUnion,
  stackUnionBox,
  type InlineUnionFields,
} from "./inline-unions.js";
import { JS_BITS, JS_TAGS } from "./jsval-encoding.js";
import {
  ARENA_RC,
  arenaDisposeLines,
  arenaDisposeSym,
  arenaNewLines,
  disposeFieldLines,
  plainRefType,
} from "./arenas.js";
import { recordViewTestLines, type RecordViews } from "./record-views.js";
import { recordMayKeepSource } from "./record-sources.js";
import { LlvmUnsupportedError } from "./unsupported.js";

/** SCR_CYC_MAX_TYPES (scr_rc.h): the registry's size, and the length of
 * the young-in nursery's per-id skip countdown. */
const CYC_MAX_TYPES = 32768;

/** What the tables need from the emitter: the extern-declaration ledger
 * and the module-wide cycle/shape indexes. */
export interface ShapeHost {
  /** The counters of a build instrumented for the heap census (heap-census.ts). */
  readonly heapCensus?: HeapCensus | null;
  /** Chunk emitters only (emit-journal.ts): EmitJournal's allocated, built,
   * opened, used and entry. */
  journalAllocated?: ((name: string, op: string, args: readonly unknown[]) => void) | undefined;
  journalBuilt?: (() => void) | undefined;
  journalOpened?: ((op: string) => void) | undefined;
  journalUsed?: ((name: string, op: string, args: readonly unknown[]) => void) | undefined;
  journalEntry?: ((table: string, key: string, value: unknown) => void) | undefined;
  /** The hierarchy root of a class (a program class or a runtime base),
   * or undefined for classes outside the class graph. */
  classRootOf?(className: string): string | undefined;
  /** Whether releasing a value of this type does nothing: instances of a
   * program-lifetime class without lifetime regions (classes.ts
   * programLifetimeClass). */
  releasesNothing?(t: IrType): boolean;
  /** Whether arrays of `elem` hold 32-bit references to compact class
   * instances (SCR_ELEM_CREF; LlEmitter.compactArrayElem). */
  compactArrayElem?(elem: IrType): boolean;
  /** Whether compact class instances live in the program-lifetime region
   * (LlEmitter.compactRegion). */
  compactRegion?(): boolean;
  /** Byte offset from an object pointer back to ScrCycHdr.buf. */
  readonly cycleBufOffset: number;
  declare(decl: string): void;
  /** Inline the small-object allocator's fast paths (llvm/alloc.ts). */
  readonly inlineAlloc?: boolean;
  /** Record and class fields that store a scalar union's tag and bits
   * inline (inline-unions.ts): they own nothing. */
  readonly inlineUnions: InlineUnionFields;
  /** The immutable ScrMapOps descriptor (scr_map.h) of a Map or Set type:
   * a module constant holding the LLVM operands { key retain, key release,
   * key trace, value retain, value release, value trace, union key kinds },
   * or `null` when every operand is null. */
  mapOps(operands: readonly string[]): string;
  /** Request the shared OOM abort helper (@sc_oom) — emitted once. */
  needOom(): void;
  /** The next collector statistics index for an emitted ScrCycType
   * descriptor (cycTypeDescriptor), counting from FIRST_EMITTED_CYC_KIND
   * in emission order.
   * Absent: every descriptor gets 0, which keeps no statistics. */
  nextCycKind?(): number;
  /** Unions represented as a nullable arm pointer (nullable-unions.ts):
   * their RC and trace entry points are the arm's NULL-tolerant ones. */
  readonly nullableUnions: NullableUnions;
  /** Emit the live-object audit notes (`scr_obj_alloc_note` /
   * `scr_obj_free_note`) in emitted new/free helpers. Only runtimes built
   * with SCR_RC_AUDIT (the sanitized lane) count them; release and dev
   * runtime packs define them empty, so plain builds omit the calls.
   * Absent means emit. */
  readonly objectAudit?: boolean;
  /** Inline RC fast-path helpers requested so far ("<family>:<op>"); the
   * emitter defines each once through {@link emitInlineRcHelpers}. Null
   * keeps every retain/release a runtime call. */
  readonly rcHelpers: Set<string> | null;
  /** Define the fast-path helpers `noinline` (see {@link inlineRcOption}). */
  readonly rcHelpersNoinline?: boolean;
  /** Which fast paths are inlined (see {@link InlineRcMode}). */
  readonly rcMode?: InlineRcMode;
  readonly recordCloneShapes: ReadonlySet<string>;
  readonly recordsById: Map<string, IrRecordShape>;
  /** The alias tag of a runtime word that lifetime-region code reads and
   * writes outside every field: the chunk count, the chunk owner, the class
   * cursors and scr_region_counting (", !tbaa !N", or "" in debug builds). */
  regionAliasTag?(word: "count" | "owner" | "cursor" | "counting"): string;
  /** The program constructs lifetime regions: the ProgramLifetime classes
   * allocate in regions and count references in their region chunk instead
   * of being empty (llvm/regions.ts). */
  regions?: RegionHooks | null;
  /** Record shapes and classes with an arena-aware constructor
   * (arenas.ts). */
  arenaShapes?: ReadonlySet<string>;
  /** Record view targets and their sources (record-views.ts). */
  recordViews?: RecordViews;
  arenaClasses?: ReadonlySet<string>;
  /** Every arena the program opens is closed (ArenaPlan.allClosed): the
   * arena-aware constructors take no dispose list. */
  arenasClosed?: boolean;
  /** The target C ABI's `size_t` / refcount integer type. */
  readonly sizeType: "i32" | "i64";
  /** Worker executables: the inline allocator state is thread-local. */
  readonly threadLocalAlloc?: boolean;
  readonly tracedShapes: Set<string>;
  readonly tracedUnions: Set<string>;
  /** The zeroed `%ScrUnion` an inline store reads for a NULL dummy. */
  unionNoneRef(): string;
  /** The young-in nursery (backend/young-nursery.ts): `new` hands each
   * traced program-owned instance to scr_yin_enter. Absent: off. */
  readonly youngNursery?: boolean;
}

/** The nursery entry of a new traced instance in `%o`, after its count is
 * stored; nothing when the nursery is off. Where the allocator is inlined
 * (64-bit, process-global state) the entry is inline too: a type that is
 * skipping the nursery (its scr_yin_skip countdown is nonzero) counts down
 * and stays out; otherwise, while the nursery has room (n < lim in ScrYin,
 * scr_rc.h), list the object at index n and mark its header young
 * (generation SCR_CYC_YOUNG, `buf` the buffered bit and the index), and
 * call scr_yin_enter_slow when it has none (it collects the nursery
 * first). Other targets call scr_yin_enter, which does all of it.
 * Labels use the `ye.` prefix; the lines end in an open block. */
export function youngEntryLines(host: ShapeHost): string[] {
  if (host.youngNursery !== true) return [];
  if (host.inlineAlloc !== true || host.threadLocalAlloc === true) {
    host.declare(`declare void @scr_yin_enter(ptr)`);
    return [`  call void @scr_yin_enter(ptr %o) ; the young-in nursery`];
  }
  host.declare(`@scr_yin = external global { ptr, i64, i64, i64 }`);
  host.declare(`@scr_yin_skip = external global [${CYC_MAX_TYPES} x i32]`);
  host.declare(`declare void @scr_yin_enter_slow(ptr)`);
  return [
    `  %ye.idp = getelementptr inbounds i8, ptr %o, i64 -${CYC_HDR} ; the young-in nursery`,
    `  %ye.id16 = load i16, ptr %ye.idp ; ScrCycHdr.id`,
    `  %ye.id = zext i16 %ye.id16 to i64`,
    `  %ye.sp = getelementptr inbounds [${CYC_MAX_TYPES} x i32], ptr @scr_yin_skip, i64 0, i64 %ye.id`,
    `  %ye.s = load i32, ptr %ye.sp`,
    `  %ye.skip = icmp ne i32 %ye.s, 0`,
    `  br i1 %ye.skip, label %ye.skipped, label %ye.enter`,
    `ye.skipped: ; a type that does not die young: counted down, stays out`,
    `  %ye.s1 = sub i32 %ye.s, 1`,
    `  store i32 %ye.s1, ptr %ye.sp`,
    `  br label %ye.done`,
    `ye.enter:`,
    `  %ye.v = load ptr, ptr @scr_yin`,
    `  %ye.np = getelementptr inbounds i8, ptr @scr_yin, i64 8`,
    `  %ye.n = load i64, ptr %ye.np`,
    `  %ye.lp = getelementptr inbounds i8, ptr @scr_yin, i64 16`,
    `  %ye.l = load i64, ptr %ye.lp`,
    `  %ye.room = icmp ult i64 %ye.n, %ye.l`,
    `  br i1 %ye.room, label %ye.fast, label %ye.slow`,
    `ye.fast:`,
    `  %ye.slot = getelementptr inbounds ptr, ptr %ye.v, i64 %ye.n`,
    `  store ptr %o, ptr %ye.slot`,
    `  %ye.n1 = add i64 %ye.n, 1`,
    `  store i64 %ye.n1, ptr %ye.np`,
    `  %ye.genp = getelementptr inbounds i8, ptr %o, i64 -5`,
    `  store i8 3, ptr %ye.genp ; ScrCycHdr.gen = SCR_CYC_YOUNG`,
    `  %ye.bufp = getelementptr inbounds i8, ptr %o, i64 -4`,
    `  %ye.i = trunc i64 %ye.n to i32`,
    `  %ye.buf = or i32 %ye.i, -2147483648`,
    `  store i32 %ye.buf, ptr %ye.bufp ; ScrCycHdr.buf = buffered bit | index`,
    `  br label %ye.done`,
    `ye.slow:`,
    `  call void @scr_yin_enter_slow(ptr %o)`,
    `  br label %ye.done`,
    `ye.done:`,
  ];
}

/** What class emission asks of lifetime regions (LifetimeRegions in
 * llvm/regions.ts): the retain and release bodies, the allocation lines of
 * `new` (the instance in `%o`), and a class's region definitions. */
export interface RegionHooks {
  rcBody(fnName: string, ret: "ptr" | "void", comment: string): string[];
  newAlloc(className: string, sizeOf: string): string[];
  classDefinitions(cls: IrClassDef, sizeOf: string): string[];
}

/** Every emitted function/helper carries attribute group #0: the build's
 * target CPU level, and `sanitize_address` in sanitized builds (see
 * emit-module.ts functionAttributes). */
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
  if (nullable?.repr === "shapes") return shapeUnionRc(host, nullable);
  if (nullable?.repr === "classes") return classUnionRc(host, nullable);
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
  if (t.kind === "jsval") return jsvalRcSym(host, "retain");
  const nullable = host.nullableUnions.of(t);
  if (nullable?.repr === "shapes") return shapeUnionRc(host, nullable).retain;
  if (nullable?.repr === "classes") return classUnionRc(host, nullable).retain;
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

/** A shape union's RC entry points: every record retain is the same
 * NULL- and immortal-skipping increment (the null sentinel is immortal),
 * so the first arm's serves; release dispatches on the arm. */
function shapeUnionRc(host: ShapeHost, union: ShapeUnion): { retain: string; release: string } {
  return {
    retain: `@${mangleRecordRetain(union.arms[0]!.shapeId)}`,
    release: shapeReleaseFn(host.nullableUnions.helperOwner(union.unionId)),
  };
}

/** A class union's RC entry points (class-unions.ts), shared by the unions
 * over the same classes. */
function classUnionRc(host: ShapeHost, union: ClassUnion): { retain: string; release: string } {
  const owner = host.nullableUnions.helperOwner(union.unionId);
  return { retain: classRetainFn(owner), release: classReleaseFn(owner) };
}

/** The widest span of shape numbers a union's arms may cover for its tag
 * helper to switch on the shape word (emitShapeUnionHelpers). */
const SHAPE_TAG_SWITCH_SPAN = 32;

/** The tag, release and trace helpers of every shape union
 * (nullable-unions.ts). The tag helper maps a value to its arm: NULL and
 * the null sentinel are the unit arms, anything else a tagged record whose
 * shape word names its arm.
 * - Arms within SHAPE_TAG_SWITCH_SPAN shape numbers: the helper switches on
 *   the shape word. Inlined, the switch folds into the caller's branch on
 *   the arm, one indirect jump with a jump table of at most that many
 *   entries per site.
 * - Wider unions: the shape word indexes the union's arm table, one entry
 *   per shape number from the arms' lowest to highest, and callers branch
 *   on the small arm tag. Folded switches would give every site of such a
 *   union a jump table spanning all of its arms' shape numbers. */
export function emitShapeUnionHelpers(host: ShapeHost): string[] {
  const out: string[] = [];
  const S = host.sizeType;
  for (const union of host.nullableUnions.allShapeUnions()) {
    const header = shapeWordHeader(S);
    const tagFn = shapeTagFn(union.unionId);
    const numbers = union.arms.map((arm) => host.nullableUnions.shapeNumber(arm.shapeId));
    const lo = Math.min(...numbers);
    const span = Math.max(...numbers) - lo + 1;
    const byTable = span > SHAPE_TAG_SWITCH_SPAN;
    // Entries are bytes, or 16-bit words for a union of 255 arms or more.
    // A shape number that names no arm maps to the all-ones entry, which is
    // above every arm tag, so callers take their path for no arm as they do
    // for the -1 of a shape number outside the table.
    const wide = union.arms.some((arm) => arm.tag >= 255);
    const entry = wide ? "i16" : "i8";
    const none = wide ? 65535 : 255;
    const table = new Array<number>(span).fill(none);
    union.arms.forEach((arm, i) => (table[numbers[i]! - lo] = arm.tag));
    const tableName = tagFn.replace("@sc_stag.", "@sc_stagtab.");
    if (byTable)
      out.push(
        `${tableName} = private unnamed_addr constant [${span} x ${entry}] [${table.map((t) => `${entry} ${t}`).join(", ")}]`,
      );
    out.push(
      `define internal i32 ${tagFn}(ptr %u) alwaysinline ${FN_ATTRS} { ; shape union tag`,
      `entry:`,
      `  %isnull = icmp eq ptr %u, null`,
      `  br i1 %isnull, label %unit, label %ref`,
      `unit:`,
      `  ret i32 ${union.unitTag}`,
      `ref:`,
    );
    if (union.nullTag >= 0)
      out.push(
        `  %isnullarm = icmp eq ptr %u, ${NULLABLE_NULL}`,
        `  br i1 %isnullarm, label %nullarm, label %rec`,
        `nullarm:`,
        `  ret i32 ${union.nullTag}`,
        `rec:`,
      );
    const cases = union.arms.map((arm, i) => `i32 ${numbers[i]}, label %a${arm.tag}`).join(" ");
    if (!byTable)
      out.push(
        `  %wp = getelementptr inbounds ${header}, ptr %u, i32 0, i32 ${SHAPE_WORD_INDEX}`,
        `  %w = load i32, ptr %wp`,
        `  switch i32 %w, label %bad [ ${cases} ]`,
        ...union.arms.flatMap((arm) => [`a${arm.tag}:`, `  ret i32 ${arm.tag}`]),
        `bad:`,
        `  ret i32 -1`,
        `}`,
        ``,
      );
    else
      out.push(
        `  %wp = getelementptr inbounds ${header}, ptr %u, i32 0, i32 ${SHAPE_WORD_INDEX}`,
        `  %w = load i32, ptr %wp`,
        `  %i = sub i32 %w, ${lo}`,
        `  %inrange = icmp ult i32 %i, ${span}`,
        `  br i1 %inrange, label %look, label %bad`,
        `look:`,
        `  %tp = getelementptr inbounds [${span} x ${entry}], ptr ${tableName}, i32 0, i32 %i`,
        `  %t8 = load ${entry}, ptr %tp`,
        `  %tag = zext ${entry} %t8 to i32`,
        `  ret i32 %tag`,
        `bad:`,
        `  ret i32 -1`,
        `}`,
        ``,
      );
    // Release and trace: one definition for the unions over the same
    // record arms (helperOwner). Unit encodings are NULL or the immortal
    // null sentinel; the shape word picks the arm.
    if (host.nullableUnions.helperOwner(union.unionId) !== union.unionId) continue;
    const units = [
      `  %isnull = icmp eq ptr %o, null`,
      `  br i1 %isnull, label %done, label %${host.nullableUnions.usesNullSentinel ? "notnull" : "rec"}`,
      ...(host.nullableUnions.usesNullSentinel
        ? [
            `notnull:`,
            `  %isnullarm = icmp eq ptr %o, ${NULLABLE_NULL}`,
            `  br i1 %isnullarm, label %done, label %rec`,
          ]
        : []),
      `rec:`,
    ];
    const armSwitch = (call: (shapeId: string) => string): string[] => [
      `  %wp = getelementptr inbounds ${header}, ptr %o, i32 0, i32 ${SHAPE_WORD_INDEX}`,
      `  %w = load i32, ptr %wp`,
      `  switch i32 %w, label %done [ ${union.arms.map((arm) => `i32 ${host.nullableUnions.shapeNumber(arm.shapeId)}, label %a${arm.tag}`).join(" ")} ]`,
      ...union.arms.flatMap((arm) => [`a${arm.tag}:`, call(arm.shapeId), `  br label %done`]),
      `done:`,
      `  ret void`,
      `}`,
      ``,
    ];
    // Every record arm shares the release fast path (the count at the same
    // offset, one collector header choice for the whole union), so only a
    // release that may free dispatches on the arm. The release stays a call:
    // inlined at every release site, it grows code more than it saves.
    const traced = union.arms.map((arm) => host.tracedShapes.has(`record:${arm.shapeId}`));
    // A freezable arm's count is the word without its frozen bit, as in
    // releaseFastPath: a frozen record's last reference takes the slow path.
    const frozen = union.arms.some(
      (arm) =>
        host.recordsById.get(arm.shapeId)?.freezable === true ||
        host.recordViews?.targets.has(arm.shapeId) === true,
    );
    const notFrozen = ~recordFrozenBit(S);
    const release = shapeReleaseFn(union.unionId);
    if (traced.every((t) => t === traced[0]))
      out.push(
        `define internal void ${release}(ptr %o) noinline ${FN_ATTRS} { ; shape union release`,
        `entry:`,
        ...units,
        `  %rc = load ${S}, ptr %o`,
        ...(frozen
          ? [
              `  %refs = and ${S} %rc, ${sizeLiteral(S, notFrozen)}`,
              `  %rcm2 = sub ${S} %refs, 2`,
              `  %shared = icmp ult ${S} %rcm2, ${sizeLiteral(S, notFrozen - 2n)}`,
            ]
          : [`  %rcm2 = sub ${S} %rc, 2`, `  %shared = icmp ult ${S} %rcm2, -3`]),
        `  br i1 %shared, label %dec, label %slow`,
        `dec:`,
        `  %n = sub ${S} %rc, 1`,
        `  store ${S} %n, ptr %o`,
        ...(traced[0] ? cycleRootLines(host, "done") : [`  br label %done`]),
        `slow:`,
        `  %imm = icmp eq ${S} %rc, -1`,
        `  br i1 %imm, label %done, label %free`,
        `free:`,
        ...armSwitch((shapeId) => `  call void @${mangleRecordRelease(shapeId)}_slow(ptr %o)`),
      );
    else
      out.push(
        `define internal void ${release}(ptr %o) ${FN_ATTRS} { ; shape union release`,
        `entry:`,
        ...units,
        ...armSwitch((shapeId) => `  call void @${mangleRecordRelease(shapeId)}(ptr %o)`),
      );
    if (shapeUnionTraced(host, union))
      out.push(
        `define internal void ${shapeTraceFn(union.unionId)}(ptr %o, ptr %visit, ptr %ctx) ${FN_ATTRS} { ; shape union trace`,
        `entry:`,
        ...units,
        ...armSwitch(
          (shapeId) => `  call void @${mangleRecordTrace(shapeId)}(ptr %o, ptr %visit, ptr %ctx)`,
        ),
      );
  }
  return out;
}

/** A shape union's arms carry collector headers (all or none: the emitter
 * traces every arm of a union with one traced arm). */
function shapeUnionTraced(host: ShapeHost, union: ShapeUnion): boolean {
  return union.arms.some((arm) => host.tracedShapes.has(`record:${arm.shapeId}`));
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
  host.journalEntry?.("retainWrapper", sym, host.nullableUnions.retainWrappers.get(sym));
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
  if (t.kind === "jsval") return jsvalRcSym(host, "release");
  const nullable = host.nullableUnions.of(t);
  if (nullable?.repr === "shapes") return shapeUnionRc(host, nullable).release;
  if (nullable?.repr === "classes") return classUnionRc(host, nullable).release;
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

/** jsval retain/release (llvm/jsval.ts). On 32-bit targets a jsval is a
 * dyn cell and uses dyn's entry points. Otherwise the inline helper skips
 * immediates and forwards a cell to dyn's own entry point (requested here,
 * so it is emitted with the other helpers) and a string or BigInt to the
 * runtime; without inline RC every retain/release is a runtime call. */
function jsvalRcSym(host: ShapeHost, op: RcOp): string {
  if (host.sizeType === "i32")
    return op === "retain" ? retainSym(host, DYN) : releaseSym(host, DYN);
  if (host.rcHelpers === null || mirroredFamily(host, "js", op) === null) {
    const sym = op === "retain" ? "@scr_js_retain" : "@scr_js_release";
    host.declare(op === "retain" ? `declare ptr ${sym}(ptr)` : `declare void ${sym}(ptr)`);
    return sym;
  }
  if (op === "retain") retainSym(host, DYN);
  else releaseSym(host, DYN);
  return requestRcHelper(host, "js", op);
}

/** The inline retain/release helpers of jsval (64-bit targets). A cell
 * goes through dyn's own retain/release entry point (inline or runtime);
 * a string or BigInt through the runtime; immediates do nothing. */
function jsvalRcHelper(host: ShapeHost, op: RcOp, attrs: string): string[] {
  const dynOp = op === "retain" ? retainSym(host, DYN) : releaseSym(host, DYN);
  const runtime = op === "retain" ? "@scr_js_retain" : "@scr_js_release";
  // Always inlined (the helper is a tag dispatch): LLVM would otherwise
  // weigh it together with the dyn helper it calls and keep both out of
  // line. dyn's release tolerates NULL; its retain does not.
  const inline = host.rcHelpersNoinline === true ? attrs : `alwaysinline ${attrs}`;
  return [
    `define internal ${op === "retain" ? "ptr" : "void"} @sc_rc_${op}_js(ptr %o) ${inline} { ; jsval ${op}: cells, strings and BigInts`,
    `entry:`,
    `  %b = ptrtoint ptr %o to i64`,
    `  %tag = lshr i64 %b, 48`,
    `  %cell = icmp eq i64 %tag, ${JS_TAGS.cell}`,
    `  br i1 %cell, label %c, label %other`,
    `c:`,
    `  %a = and i64 %b, ${JS_BITS.payloadMask}`,
    `  %p = inttoptr i64 %a to ptr`,
    ...(op === "retain"
      ? [
          `  %live = icmp ne ptr %p, null`,
          `  br i1 %live, label %rc, label %done`,
          `rc:`,
          `  %r = call ptr ${dynOp}(ptr %p)`,
        ]
      : [`  call void ${dynOp}(ptr %p)`]),
    `  br label %done`,
    `other:`,
    `  %h = sub i64 %tag, ${JS_TAGS.str}`,
    `  %heap = icmp ult i64 %h, 2`,
    `  br i1 %heap, label %slow, label %done`,
    `slow:`,
    op === "retain" ? `  %s = call ptr ${runtime}(ptr %o)` : `  call void ${runtime}(ptr %o)`,
    `  br label %done`,
    `done:`,
    `  ${op === "retain" ? "ret ptr %o" : "ret void"}`,
    `}`,
    ``,
  ];
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
 * the fast path skips scalars and values already in a candidate buffer or
 * never candidates, and calls scr_dyn_release_survivor for the rest, which
 * decides per value (intact documents, ScrDynRegion; capsules and handles
 * without edges).
 *
 * The array release inlines the decrement of an array that stays alive
 * and is not headered (`a->cyc`): those are most array releases in
 * type-checker workloads, where scr_arr_release's own prologue and checks
 * took about half of its time. */
export const INLINE_RC_FAMILIES: Readonly<Record<string, InlineRcFamily>> = {
  str: { cycle: "none", retainNull: false, release: "scr_str_release" },
  bytes: { cycle: "none", retainNull: false, release: "scr_bytes_release" },
  regex: { cycle: "none", retainNull: false, release: "scr_regex_release" },
  bigint: { cycle: "none", retainNull: true, release: "scr_bigint_release" },
  arr: { cycle: "arr", retainNull: false, release: "scr_arr_release" },
  map: { cycle: "map", retainNull: false, release: "scr_map_release" },
  union: { cycle: "always", retainNull: false, release: "scr_union_release" },
  closure: { cycle: "always", retainNull: false, release: "scr_closure_release" },
  promise: { cycle: "always", retainNull: true, release: "scr_promise_release" },
  classobj: { cycle: "always", retainNull: true, release: "scr_classobj_release" },
  box: { cycle: "always", retainNull: false, release: "scr_box_release" },
  dyn: { cycle: "always", retainNull: false, release: "scr_dyn_release" },
};

type RcOp = "retain" | "release";

/** The helper key (with the "family:op" keys) of the module's candidate
 * append helper (alloc.ts cycleAppendHelper). */
const CYC_APPEND_KEY = "cyc:append";

/** The mirrored family for an RC operation on a runtime stem (`scr_str`),
 * or null when it stays a call. */
export function inlineRcFamily(host: ShapeHost, stem: string, op: RcOp): InlineRcFamily | null {
  return mirroredFamily(host, stem.replace(/^scr_/, ""), op);
}

/** Which RC fast paths an emission inlines. `speed` mirrors every family
 * with a fast path. `release` mirrors only the string retain and release,
 * the Map retain and the dyn retain and release: the operations that
 * dominate dynamic-value, string and Map code (a Map read from an array or
 * another Map). String-heavy programs have many string release sites, so a
 * function with more than INLINE_STR_RELEASES_PER_FUNCTION of them calls the
 * runtime release at each (limitInlineReleases). */
export type InlineRcMode = "release" | "speed";

const RELEASE_RC_OPS = new Set([
  "str:retain",
  "str:release",
  "map:retain",
  "dyn:retain",
  "dyn:release",
  "js:retain",
  "js:release",
]);

/** The jsval helpers' row: their bodies are custom (jsvalRcHelper), and
 * they call the runtime themselves. */
const JS_RC_ROW: InlineRcFamily = { cycle: "none", retainNull: true, release: null };

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
  if (family === "js")
    return host.rcMode !== "speed" && !RELEASE_RC_OPS.has(`js:${op}`) ? null : JS_RC_ROW;
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
  const row = host.rcHelpers === null ? null : mirroredFamily(host, family, op);
  if (host.rcHelpers === null || row === null) {
    throw new LlvmUnsupportedError(`inline rc:${family}:${op}`);
  }
  host.rcHelpers.add(`${family}:${op}`);
  for (const decl of rcHelperDecls(family, op)) host.declare(decl);
  // Its body is written last (emitInlineRcHelpers), after the requests are
  // collected: a release that can buffer a candidate requests the append
  // helper now. The dyn release buffers through scr_dyn_release_survivor
  // instead. The jsval row (JS_RC_ROW) has no collector header; its cells
  // release through dyn's helper.
  if (op === "release" && row.cycle === "always" && family !== "dyn") requestCycleAppend(host);
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

/** Inlined string releases one function body keeps in `release` emission,
 * which inlines string releases (RELEASE_RC_OPS); the bodies with the most of them, such as
 * builders of string-heavy records and module initializers, would grow the
 * most for the least gain, so a body with more calls scr_str_release at
 * every site. */
export const INLINE_STR_RELEASES_PER_FUNCTION = 8;

/** Apply {@link INLINE_DYN_RELEASES_PER_FUNCTION}, and in `release` emission
 * {@link INLINE_STR_RELEASES_PER_FUNCTION}, to each function of an emitted
 * module, given as parts joined by newlines. A function can span parts
 * (main's lines) and a part can hold several functions. */
export function limitInlineReleases(
  parts: readonly string[],
  mode: InlineRcMode | undefined,
): string[] {
  const families: readonly ("dyn" | "str")[] = mode === "release" ? ["dyn", "str"] : ["dyn"];
  const limits = families.map((family) =>
    family === "dyn" ? INLINE_DYN_RELEASES_PER_FUNCTION : INLINE_STR_RELEASES_PER_FUNCTION,
  );
  const calls = families.map((family) => `${inlineRcName(family, "release")}(`);
  const runtimes = families.map((family) => `call void @${INLINE_RC_FAMILIES[family]!.release}(`);
  const head = "call void @";
  const prefix = `${head}${inlineRcName("", "release")}`;
  // The function each release site belongs to: the last `define` line
  // before it, counted over the joined text. One walk over each part finds
  // the sites of every family.
  const sites = (
    part: string,
    each: (offset: number, family: number, fn: number) => void,
    first: number,
  ): number => {
    let fn = first;
    let define = part.startsWith("define ") ? 0 : part.indexOf("\ndefine ");
    for (let at = part.indexOf(prefix); at >= 0; at = part.indexOf(prefix, at + prefix.length)) {
      const family = calls.findIndex((call) => part.startsWith(call, at + head.length));
      if (family < 0) continue;
      while (define >= 0 && define < at) {
        fn++;
        define = part.indexOf("\ndefine ", define + 1);
      }
      each(at, family, fn);
    }
    while (define >= 0) {
      fn++;
      define = part.indexOf("\ndefine ", define + 1);
    }
    return fn;
  };
  const counts = families.map(() => new Map<number, number>());
  // The functions each part's sites can belong to.
  const spans: number[] = [];
  let fn = 0;
  for (const part of parts) {
    spans.push(fn);
    fn = sites(
      part,
      (_, family, f) => counts[family]!.set(f, (counts[family]!.get(f) ?? 0) + 1),
      fn,
    );
    spans.push(fn);
  }
  const over = counts.map(
    (count, family) => new Set([...count].filter(([, n]) => n > limits[family]!).map(([f]) => f)),
  );
  if (over.every((set) => set.size === 0)) return [...parts];
  const anyOver = new Set(over.flatMap((set) => [...set]));
  const touches = (from: number, to: number): boolean => {
    for (let f = from; f <= to; f++) if (anyOver.has(f)) return true;
    return false;
  };
  return parts.map((part, index) => {
    const from = spans[2 * index]!;
    if (!touches(from, spans[2 * index + 1]!)) return part;
    const cuts: { at: number; family: number }[] = [];
    sites(
      part,
      (at, family, f) => {
        if (over[family]!.has(f)) cuts.push({ at, family });
      },
      from,
    );
    if (cuts.length === 0) return part;
    let out = "";
    let next = 0;
    for (const cut of cuts) {
      out += part.slice(next, cut.at) + runtimes[cut.family]!;
      next = cut.at + head.length + calls[cut.family]!.length;
    }
    return out + part.slice(next);
  });
}

function rcHelperDecls(family: string, op: RcOp): string[] {
  if (family === "js")
    return [
      op === "retain" ? `declare ptr @scr_js_retain(ptr)` : `declare void @scr_js_release(ptr)`,
    ];
  const row = INLINE_RC_FAMILIES[family]!;
  if (op === "retain" || row.release === null) return [];
  return [
    `declare void @${row.release}(ptr)`,
    ...(family === "dyn"
      ? [`declare void @scr_dyn_release_survivor(ptr)`]
      : row.cycle === "always"
        ? [`declare void @scr_cyc_on_release(ptr)`]
        : []),
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
    if (key === CYC_APPEND_KEY) {
      for (const decl of cycleAppendDecls()) decls.add(decl);
      continue;
    }
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
            // handles, never for scalars. Every kind that can be buffered
            // takes one path, which keeps each inlined site small: a value
            // already in a candidate buffer (or never one) stays inline, and
            // scr_dyn_release_survivor decides the rest.
            `  %kp = getelementptr i8, ptr %o, ${S} ${S === "i64" ? 8 : 4} ; ScrDyn.kind`,
            `  %kind = load i32, ptr %kp`,
            // SCR_DYN_ARR 4, OBJ 5, FUNC 8, HANDLE 9, TYPED_REF 12, PROXY 13.
            `  switch i32 %kind, label %done [ i32 4, label %candidate i32 5, label %candidate i32 8, label %candidate i32 9, label %candidate i32 12, label %candidate i32 13, label %candidate ]`,
            `candidate:`,
            `  %cbufp = getelementptr i8, ptr %o, ${S} -${host.cycleBufOffset}`,
            `  %cbuf = load i32, ptr %cbufp`,
            `  %cqueued = icmp slt i32 %cbuf, 0`,
            `  br i1 %cqueued, label %done, label %survivor`,
            `survivor:`,
            `  call void @scr_dyn_release_survivor(ptr %o)`,
          ]
        : family === "box"
          ? [
              // scr_box_release buffers a surviving box only when its trace
              // visits the payload (scr_box_traced): a closure (kind 4), or a
              // class instance whose obj_trace is set.
              `  %kp = getelementptr i8, ptr %o, ${S} ${S === "i64" ? 8 : 4} ; ScrBox.kind`,
              `  %kind = load i32, ptr %kp`,
              `  %func = icmp eq i32 %kind, 4`,
              `  br i1 %func, label %root, label %objbox`,
              `objbox:`,
              `  %otp = getelementptr i8, ptr %o, ${S} ${S === "i64" ? 32 : 16} ; ScrBox.obj_trace`,
              `  %ot = load ptr, ptr %otp`,
              `  %untraced = icmp eq ptr %ot, null`,
              `  br i1 %untraced, label %done, label %root`,
              `root:`,
            ]
          : []),
    ...(cycle === "always" && family !== "dyn"
      ? cycleRootLines(host, "done")
      : [`  br label %done`]),
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
    if (key === CYC_APPEND_KEY) {
      out.push(...cycleAppendHelper());
      continue;
    }
    const [family, op] = key.split(":") as [string, RcOp];
    if (family === "js") {
      out.push(...jsvalRcHelper(host, op, rcHelperAttrs(host)));
      continue;
    }
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
      if (nullable?.repr === "shapes")
        return shapeUnionTraced(host, nullable)
          ? shapeTraceFn(host.nullableUnions.helperOwner(nullable.unionId))
          : null;
      // Every arm of a class union carries a collector header when one does.
      if (nullable?.repr === "classes")
        return host.tracedShapes.has(`object:${nullable.arms[0]!.className}`)
          ? classTraceFn(host.nullableUnions.helperOwner(nullable.unionId))
          : null;
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
 * construct through scr_arr_new_ops with the element type's `_v` RC entry
 * points; every other element kind keeps the plain scr_arr_new call. */
export function arrNewCall(
  host: ShapeHost,
  elem: IrType,
  capText: string,
  /** An empty array expected to receive a few elements (its first slots
   * live in its own block): capText must be "0". */
  small = false,
  /** In the current group arena when one is open (arenas.ts). */
  arena = false,
): string {
  const r = arena ? "_r" : "";
  const useRef = arrUsesRef(host, elem);
  if (!useRef) {
    if (small) {
      host.declare(`declare ptr @scr_arr_new_small${r}(i32)`);
      return `call ptr @scr_arr_new_small${r}(i32 ${elemKindNum(elem)})`;
    }
    host.declare(`declare ptr @scr_arr_new${r}(i32, ${host.sizeType})`);
    return `call ptr @scr_arr_new${r}(i32 ${elemKindNum(elem)}, ${host.sizeType} ${capText})`;
  }
  if (small) {
    host.declare(`declare ptr @scr_arr_new_ops_small${r}(ptr)`);
    return `call ptr @scr_arr_new_ops_small${r}(ptr ${arrOps(host, elem)})`;
  }
  host.declare(`declare ptr @scr_arr_new_ops${r}(ptr, ${host.sizeType})`);
  return `call ptr @scr_arr_new_ops${r}(ptr ${arrOps(host, elem)}, ${host.sizeType} ${capText})`;
}

/** The ScrElemKind and ops descriptor (or `null`) an array of `elem`
 * starts with: the arrays arrNewCall constructs, for the instances of a
 * class that extends Array (scr_arr_subclass_init). */
export function arrElemInit(host: ShapeHost, elem: IrType): { kind: number; ops: string } {
  if (!arrUsesRef(host, elem)) return { kind: elemKindNum(elem), ops: "null" };
  return { kind: host.compactArrayElem?.(elem) === true ? 6 : 5, ops: arrOps(host, elem) };
}

function arrUsesRef(host: ShapeHost, elem: IrType): boolean {
  return (
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
    elem.kind === "stats" || // fs.Stats snapshots: scr_stats_* adapters, no trace
    elem.kind === "dyn" || // native collection seeds/drains: traced REF
    elem.kind === "regex" || // RegExp values: scr_regex_* adapters, no trace (no refs inside)
    elem.kind === "date" || // Date objects: scr_date_* adapters, no trace (no refs inside)
    (elem.kind === "array" && traceAdapter(host, elem) !== null)
  );
}

/** The %ScrArrOps descriptor (retain, release, trace, registry id) of a REF
 * element type, defined once per module and shared by all its arrays. It is
 * writable: the runtime stores its registry id on the first array. Its tail
 * padding is the runtime's flags word (0); arrays of compact class
 * references (ShapeHost.compactArrayElem) spell the word out as
 * SCR_ARR_OPS_COMPACT, and on 64-bit targets arrays whose element release
 * does nothing (ShapeHost.releasesNothing) as SCR_ARR_OPS_RELEASE_NOTHING,
 * so that destroying them only frees their storage. */
export function arrOps(host: ShapeHost, elem: IrType): string {
  const v = vAdapters(host, elem);
  const trace = traceArg(host, elem);
  const part = (sym: string): string => sym.replace(/^@/, "").replace(/[^A-Za-z0-9_.]/g, "_");
  const name = `@sc_arrops.${part(v.retain)}.${part(v.release)}.${part(trace)}`;
  if (host.compactArrayElem?.(elem) === true) {
    host.declare(
      `${name}.c = internal global { ptr, ptr, ptr, i32, i32 } { ptr ${v.retain}, ptr ${v.release}, ptr ${trace}, i32 0, i32 ${SCR_ARR_OPS_COMPACT} }`,
    );
    return `${name}.c`;
  }
  const nullable = host.nullableUnions.of(elem);
  const payload = nullable?.repr === "single" ? nullable.arm : elem;
  if (host.sizeType === "i64" && host.releasesNothing?.(payload) === true) {
    host.declare(
      `${name}.n = internal global { ptr, ptr, ptr, i32, i32 } { ptr ${v.retain}, ptr ${v.release}, ptr ${trace}, i32 0, i32 ${SCR_ARR_OPS_RELEASE_NOTHING} }`,
    );
    return `${name}.n`;
  }
  host.declare(
    `${name} = internal global %ScrArrOps { ptr ${v.retain}, ptr ${v.release}, ptr ${trace}, i32 0 }`,
  );
  return name;
}

/** scr_array.h SCR_ARR_OPS_COMPACT and SCR_ARR_OPS_RELEASE_NOTHING. */
const SCR_ARR_OPS_COMPACT = 1;
const SCR_ARR_OPS_RELEASE_NOTHING = 2;

/* ── capture boxes ────────────────────────────────────────────────────── */

/** Box construction call text (boxNewC's dispatch): plain-kind boxes for
 * the runtime-known payloads, obj-kind boxes (RC entry points + trace as
 * data) for per-shape payloads and cycle-capable arrays. SCR_BOX_* tags
 * from scr_runtime.h. */
export function boxNewCall(host: ShapeHost, t: IrType): string {
  const plain: Partial<Record<IrType["kind"], number>> = {
    f64: 0,
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
  return t.kind === "f64" || t.kind === "procStream" ? "f64" : t.kind === "bool" ? "bool" : "ref";
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
  /** The struct index of the first field (2 on tagged shapes). */
  base = 1,
): { index: number; type: IrType; name: string }[] {
  return [
    ...shape.fields.flatMap((f, i) =>
      inline.record(f.type) ? [] : [{ index: i + base, type: f.type, name: f.name }],
    ),
    ...(shape.indexValue
      ? [
          {
            index: shape.fields.length + base,
            type: mapOf(STRING, shape.indexValue),
            name: "[key: string] overflow",
          },
        ]
      : []),
  ];
}

/** The integer type a release or retain loads and stores the count as:
 * the rc word, or its low half (an i32 at offset 0) for class instances that
 * keep their class number in the high half (classes.ts LlClassMeta.idInRc). */
export type RcCount = "i32" | "i64";

/** The NULL- and immortal-skipping retain body shared by every shape. A
 * retain never touches the cycle header: a buffered candidate that is
 * retained again stays a candidate (scr_cycle.c, markRoots). */
export function retainBody(
  host: ShapeHost,
  fnName: string,
  comment = "",
  immortal = false,
  count: RcCount = host.sizeType,
): string[] {
  const S = count;
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
  /** The child's count type, when it is not the rc word (RcCount). */
  readonly count?: RcCount;
}

/** The release of child `value` (a loaded field, possibly NULL) inside a
 * teardown whose chain length is `%d`: the child's own release for a shared
 * or immortal reference, its teardown for the last one. Labels use `tag`;
 * the lines end in the open block `${tag}.next`.
 *
 * With `segment` (the child has the teardown's own type, in a segmented
 * teardown; segmentPrologueLines), the child's teardown appends its blocks
 * to the teardown's segment. */
export function directChildReleaseLines(
  host: ShapeHost,
  tag: string,
  value: string,
  target: DirectDestroy,
  comment: string,
  segment = false,
): string[] {
  const S = host.sizeType;
  const C = target.count ?? S;
  if (segment) host.declare(`declare ptr @scr_rc_destroy_seg(ptr, ptr, ptr, ptr)`);
  else host.declare(`declare void @scr_rc_destroy(ptr, ptr)`);
  const lines = [
    `  %${tag}.nn = icmp ne ptr ${value}, null`,
    `  br i1 %${tag}.nn, label %${tag}.chk, label %${tag}.next`,
    `${tag}.chk:`,
    `  %${tag}.rc = load ${C}, ptr ${value}`,
    `  %${tag}.last = icmp eq ${C} %${tag}.rc, 1`,
    `  br i1 %${tag}.last, label %${tag}.dead, label %${tag}.shared`,
    `${tag}.shared:`,
    `  call void ${target.release}(ptr ${value}) ; ${comment}`,
    `  br label %${tag}.next`,
    `${tag}.dead: ; ${comment}: the last reference`,
    `  store ${C} 0, ptr ${value}`,
  ];
  if (target.traced) {
    host.declare(`declare void @scr_cyc_on_dead(ptr)`);
    lines.push(
      `  %${tag}.bufp = getelementptr i8, ptr ${value}, ${S} -${host.cycleBufOffset}`,
      `  %${tag}.buf = load i32, ptr %${tag}.bufp`,
      `  %${tag}.queued = icmp slt i32 %${tag}.buf, -1 ; buffered, not SCR_CYC_ACYCLIC`,
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
  );
  if (!segment) {
    lines.push(
      `  call void @${target.destroy}_d(ptr ${value}, i32 %${tag}.d)`,
      `  br label %${tag}.next`,
      `${tag}.bounded:`,
      `  call void @scr_rc_destroy(ptr ${value}, ptr @${target.destroy})`,
      `  br label %${tag}.next`,
      `${tag}.next:`,
    );
    return lines;
  }
  lines.push(
    `  %${tag}.t = load ptr, ptr %sg.t`,
    `  %${tag}.dt = call ptr @${target.destroy}_s(ptr ${value}, i32 %${tag}.d, ptr %${tag}.t)`,
    `  store ptr %${tag}.dt, ptr %sg.t`,
    `  br label %${tag}.next`,
    `${tag}.bounded:`,
    `  %${tag}.bt = load ptr, ptr %sg.t`,
    `  %${tag}.rt = call ptr @scr_rc_destroy_seg(ptr ${value}, ptr @${target.destroy}_sc, ptr @${target.destroy}, ptr %${tag}.bt)`,
    `  store ptr %${tag}.rt, ptr %sg.t`,
    `  br label %${tag}.next`,
    `${tag}.next:`,
  );
  return lines;
}

/* Teardown segments. A typed teardown that frees each block onto its free
 * list as it goes frees a tree in walk order, and the free lists, which are
 * LIFO, hand the blocks to the next allocations in the reverse order: a tree
 * built again in the same order as the last (each generation of a structure
 * a loop rebuilds) is laid out mirrored, and every walk over it, the next
 * teardown included, runs through memory backwards, which defeats the
 * hardware prefetchers. The runtime frees large dead sets of the cycle
 * collector in address order for the same reason (scr_mem_order_for_free).
 *
 * So the teardown of a type with children of its own type (the `_s` form,
 * segmentedTeardown) keeps the blocks it frees in a segment, linked through
 * their first words, which it builds in order through a tail pointer: the
 * `_s` form takes the segment's last link (the first word of its last block,
 * or the head slot of an empty segment) and returns the new one. A node
 * first releases its own block (emitObjectFree, keeping it), then appends it
 * ahead of its children's blocks when its address is the lower, behind them
 * otherwise (segmentTeardownLines), and the children append theirs in field
 * order, so a structure
 * built parent first (object literals allocate before their fields) or
 * children first (constructor arguments) comes back in ascending order. The
 * chain's first teardown (`_d`) frees the whole segment onto the class's
 * free list in one step (emitSegmentFree), and the walks over the next
 * generation run forward. A teardown past DIRECT_DESTROY_CHAIN appends
 * through scr_rc_destroy_seg, under the same depth budget as
 * scr_rc_destroy. Blocks outside the calling thread's arena are freed as
 * before; one type's blocks are all of one class. */

/** Whether the teardown of a type whose reference fields have `fieldTypes`
 * (with direct targets `targets`) and whose own teardown is `destroy` keeps
 * a segment: a child field has its own type, and the inline allocation paths
 * are in use. */
export function segmentedTeardown(
  host: ShapeHost,
  destroy: string,
  fieldTypes: readonly IrType[],
  targets: ReadonlyMap<string, DirectDestroy>,
): boolean {
  if (host.inlineAlloc !== true) return false;
  return fieldTypes.some((t) => directDestroyTarget(host, t, targets)?.destroy === destroy);
}

/** The first lines of a segmented teardown, in its entry block: the
 * segment's last link (`%sg.t`, from the `%tail` argument) and the kept own
 * block (`%sg.own`, for emitObjectFree). */
export function segmentPrologueLines(): string[] {
  return [
    `  %sg.t = alloca ptr`,
    `  %sg.own = alloca ptr`,
    `  store ptr %tail, ptr %sg.t`,
    `  store ptr null, ptr %sg.own`,
  ];
}

/** The rest of a segmented teardown after emitObjectFree kept (or freed)
 * its own block: the block goes ahead of its children's when its address is
 * below the first non-NULL one of `children` (loaded fields of the
 * teardown's own type, which stand for their blocks) or there is none, and
 * behind them otherwise; then the children's releases (`releases`, given a
 * label prefix), and the segment's last link is returned. Each order has its
 * own copy of the releases, so neither keeps the decision, or the block once
 * it is appended, across the children's teardowns. */
export function segmentTeardownLines(
  children: readonly string[],
  releases: (prefix: string) => string[],
): string[] {
  const lines = [`  %sg.o = load ptr, ptr %sg.own`, `  %sg.kept = icmp ne ptr %sg.o, null`];
  let ref = "null";
  [...children].reverse().forEach((child, i) => {
    lines.push(
      `  %sg.nn${i} = icmp ne ptr ${child}, null`,
      `  %sg.r${i} = select i1 %sg.nn${i}, ptr ${child}, ptr ${ref}`,
    );
    ref = `%sg.r${i}`;
  });
  lines.push(
    `  %sg.leaf = icmp eq ptr ${ref}, null`,
    `  %sg.lower = icmp ult ptr %sg.o, ${ref}`,
    `  %sg.first = or i1 %sg.leaf, %sg.lower`,
    `  %sg.ahead = and i1 %sg.kept, %sg.first`,
    `  br i1 %sg.ahead, label %sg.front, label %sg.back`,
    `sg.front:`,
    ...segmentAppendLines("a"),
    ...releases("ta"),
    `  br label %sg.ret`,
    `sg.back:`,
    ...releases("tb"),
    `  %sg.keep = icmp ne ptr %sg.o, null`,
    `  br i1 %sg.keep, label %sg.last, label %sg.ret`,
    `sg.last:`,
    ...segmentAppendLines("l"),
    `  br label %sg.ret`,
    `sg.ret:`,
    `  %sg.tr = load ptr, ptr %sg.t`,
    `  ret ptr %sg.tr`,
  );
  return lines;
}

function segmentAppendLines(tag: string): string[] {
  return [
    `  %sg.t${tag} = load ptr, ptr %sg.t`,
    `  store ptr %sg.o, ptr %sg.t${tag}`,
    `  store ptr %sg.o, ptr %sg.t`,
  ];
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
  const nullable = host.nullableUnions.of(type);
  let t = type;
  if (nullable !== null) {
    if (nullable.repr !== "single") return null;
    t = nullable.arm;
  }
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
 * one-argument entry starts a chain. With `segment` (the host, for a
 * segmented teardown), the body is a segment teardown's
 * (segmentPrologueLines to segmentTeardownLines), defined as `_s`, with
 * `_sc` for scr_rc_destroy_seg, and `_d` starts a segment and frees it. */
export function destroyDefinitions(
  destroy: string,
  body: readonly string[],
  chained: boolean,
  segment: ShapeHost | null = null,
): string[] {
  if (segment !== null)
    return [
      `define internal ptr @${destroy}_s(ptr %o, i32 %d, ptr %tail) ${FN_ATTRS} {`,
      `entry:`,
      ...body,
      `}`,
      `define internal ptr @${destroy}_sc(ptr %o, ptr %tail) ${FN_ATTRS} {`,
      `entry:`,
      `  %t = call ptr @${destroy}_s(ptr %o, i32 0, ptr %tail)`,
      `  ret ptr %t`,
      `}`,
      `define internal void @${destroy}_d(ptr %o, i32 %d) ${FN_ATTRS} {`,
      `entry:`,
      `  %head = alloca ptr`,
      `  store ptr null, ptr %head`,
      `  %last = call ptr @${destroy}_s(ptr %o, i32 %d, ptr %head)`,
      `  %first = load ptr, ptr %head`,
      ...emitSegmentFree(segment, "sgf", "%first", "%last"),
      `  ret void`,
      `}`,
      `define internal void @${destroy}(ptr %o) ${FN_ATTRS} {`,
      `entry:`,
      `  call void @${destroy}_d(ptr %o, i32 0)`,
      `  ret void`,
      `}`,
    ];
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

/** The frozen bit of a freezable record's rc word (scr_rc.h SCR_RC_FROZEN):
 * bit 62 on 64-bit targets, bit 30 on 32-bit ones. */
function recordFrozenBit(sizeType: RcCount): bigint {
  return 1n << (sizeType === "i64" ? 62n : 30n);
}

/** `value` as a signed LLVM integer literal of `sizeType`. */
function sizeLiteral(sizeType: RcCount, value: bigint): string {
  return BigInt.asIntN(sizeType === "i64" ? 64 : 32, value).toString();
}

/** The teardown of a type whose reference fields all hold its own type
 * (`fields`: their struct indices; `release`: the type's inlinable release;
 * no collector header): one loop instead of a call per node. A child whose
 * last reference the dead node held joins a pending list linked through its
 * own count word, which it no longer needs; the loop takes the list's first
 * node next, so nodes are visited parent first, fields in order. Each node
 * releases its block as emitObjectFree does, keeping a block of the calling
 * thread's arena in a segment linked through its first word, and the segment
 * goes onto the free list in one step at the end (emitSegmentFree): the next
 * structure built parent first takes the blocks in the order it allocates
 * them, as segmentTeardownLines arranges for the recursive form. The loop
 * needs no depth budget. `_d` (the direct-chain entry other teardowns call)
 * and the plain entry both run it. A class that keeps its id in the count
 * word counts in the low half (`count`); a dead node's whole word is free. */
export function iterativeTeardownDefinitions(
  host: ShapeHost,
  destroy: string,
  struct: string,
  fields: readonly number[],
  release: string,
  observers: FreeObservers,
  count: RcCount = host.sizeType,
): string[] {
  const S = host.sizeType;
  const lines = [
    `define internal void @${destroy}_it(ptr %root) ${FN_ATTRS} {`,
    `entry:`,
    `  %sg.own = alloca ptr`,
    `  br label %it.node`,
    `it.node:`,
    `  %o = phi ptr [ %root, %entry ], [ %it.top, %it.next ]`,
    `  %it.pend = phi ptr [ null, %entry ], [ %it.rest, %it.next ]`,
    `  %it.first = phi ptr [ null, %entry ], [ %it.fa, %it.next ]`,
    `  %it.last = phi ptr [ null, %entry ], [ %it.la, %it.next ]`,
    ...fields.flatMap((index, i) => [
      `  %it.f${i} = getelementptr inbounds %${struct}, ptr %o, i64 0, i32 ${index}`,
      `  %it.v${i} = load ptr, ptr %it.f${i}`,
    ]),
    `  store ptr null, ptr %sg.own`,
    ...emitObjectFree(host, false, observers, "%sg.own"),
    `  br label %it.freed`,
    `it.freed:`,
    `  %it.k = load ptr, ptr %sg.own`,
    `  %it.kept = icmp ne ptr %it.k, null`,
    `  br i1 %it.kept, label %it.app, label %it.kids`,
    `it.app:`,
    `  %it.none = icmp eq ptr %it.first, null`,
    `  br i1 %it.none, label %it.appd, label %it.link`,
    `it.link:`,
    `  store ptr %it.k, ptr %it.last`,
    `  br label %it.appd`,
    `it.appd:`,
    `  %it.nf = select i1 %it.none, ptr %it.k, ptr %it.first`,
    `  br label %it.kids`,
    `it.kids:`,
    `  %it.fa = phi ptr [ %it.nf, %it.appd ], [ %it.first, %it.freed ]`,
    `  %it.la = phi ptr [ %it.k, %it.appd ], [ %it.last, %it.freed ]`,
  ];
  // The fields go onto the list last first, so the first field is next.
  let pend = "%it.pend";
  let from = "it.kids";
  for (let i = fields.length - 1; i >= 0; i--) {
    const v = `%it.v${i}`;
    lines.push(
      `  %it.nn${i} = icmp ne ptr ${v}, null`,
      `  br i1 %it.nn${i}, label %it.chk${i}, label %it.j${i}`,
      `it.chk${i}:`,
      `  %it.rc${i} = load ${count}, ptr ${v}`,
      `  %it.last${i} = icmp eq ${count} %it.rc${i}, 1`,
      `  br i1 %it.last${i}, label %it.push${i}, label %it.sh${i}`,
      `it.push${i}:`,
      `  %it.pl${i} = ptrtoint ptr ${pend} to ${S}`,
      `  store ${S} %it.pl${i}, ptr ${v}`,
      `  br label %it.j${i}`,
      `it.sh${i}:`,
      `  call void ${release}(ptr ${v}) ; a shared or immortal child`,
      `  br label %it.j${i}`,
      `it.j${i}:`,
      `  %it.p${i} = phi ptr [ ${pend}, %${from} ], [ ${v}, %it.push${i} ], [ ${pend}, %it.sh${i} ]`,
    );
    pend = `%it.p${i}`;
    from = `it.j${i}`;
  }
  lines.push(
    `  %it.empty = icmp eq ptr ${pend}, null`,
    `  br i1 %it.empty, label %it.done, label %it.next`,
    `it.next:`,
    `  %it.top = getelementptr i8, ptr ${pend}, i64 0`,
    `  %it.lw = load ${S}, ptr %it.top`,
    `  %it.rest = inttoptr ${S} %it.lw to ptr`,
    `  br label %it.node`,
    `it.done:`,
    ...emitSegmentFree(host, "sgf", "%it.fa", "%it.la"),
    `  ret void`,
    `}`,
    `define internal void @${destroy}_d(ptr %o, i32 %d) ${FN_ATTRS} {`,
    `entry:`,
    `  call void @${destroy}_it(ptr %o)`,
    `  ret void`,
    `}`,
    `define internal void @${destroy}(ptr %o) ${FN_ATTRS} {`,
    `entry:`,
    `  call void @${destroy}_it(ptr %o)`,
    `  ret void`,
    `}`,
  );
  return lines;
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
  segmented = false,
  frozen = false,
  destroyDefs: readonly string[] | null = null,
  count: RcCount = host.sizeType,
): string[] {
  const S = count;
  if (bounded) host.declare(`declare void @scr_rc_destroy(ptr, ptr)`);
  const destroy = `${fnName}_destroy`;
  // A freezable record's count is the word without its frozen bit.
  const notFrozen = sizeLiteral(S, ~recordFrozenBit(S));
  const lines = [
    ...(bounded
      ? (destroyDefs ?? destroyDefinitions(destroy, freeBody, chained, segmented ? host : null))
      : []),
    ...releaseFastPath(host, fnName, `${fnName}_slow`, traced, comment, immortal, S, frozen),
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
    ...(frozen
      ? [`  %refs = and ${S} %n, ${notFrozen}`, `  %dead = icmp eq ${S} %refs, 0`]
      : [`  %dead = icmp eq ${S} %n, 0`]),
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
  count: RcCount = host.sizeType,
  frozen = false,
): string[] {
  const S = count;
  if (immortal) return immortalRcBody(host, fnName, "void", comment);
  // A freezable record compares its count without the frozen bit: an
  // immortal word's count is then ~FROZEN, which the same compare sends to
  // `slow`.
  const notFrozen = ~recordFrozenBit(S);
  return [
    `define internal void @${fnName}(ptr %o) ${FN_ATTRS} {${comment ? ` ; ${comment} (fast path)` : ""}`,
    `entry:`,
    `  %isnull = icmp eq ptr %o, null`,
    `  br i1 %isnull, label %done, label %check`,
    `check:`,
    `  %rc = load ${S}, ptr %o`,
    ...(frozen
      ? [
          `  %refs = and ${S} %rc, ${sizeLiteral(S, notFrozen)}`,
          `  %rcm2 = sub ${S} %refs, 2`,
          `  %shared = icmp ult ${S} %rcm2, ${sizeLiteral(S, notFrozen - 2n)}`,
        ]
      : [`  %rcm2 = sub ${S} %rc, 2`, `  %shared = icmp ult ${S} %rcm2, -3`]),
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

/** Whether candidate buffering goes through the module's append helper
 * (alloc.ts cycleAppendHelper), requesting its definition if so: in
 * optimized builds (those with inline RC helpers) that support it. */
function requestCycleAppend(host: ShapeHost): boolean {
  if (host.rcHelpers === null || !inlineBufferingSupported(host)) return false;
  if (!host.rcHelpers.has(CYC_APPEND_KEY)) {
    host.rcHelpers.add(CYC_APPEND_KEY);
    for (const decl of cycleAppendDecls()) host.declare(decl);
  }
  return true;
}

/** The possible-cycle-root step of a release that left a headered object
 * alive: scr_cyc_on_release with its early return inlined. Test the sign
 * of `buf` (the i32 at obj-4; negative for a queued candidate, a young
 * object, or an object that is never a candidate, SCR_CYC_ACYCLIC), and
 * buffer a new candidate: through the module's
 * cycleAppendHelper in optimized builds that support it, through
 * scr_cyc_on_release otherwise. Every emitted release of a headered object
 * shares this sequence (scr_runtime.h asserts the offsets); it ends by
 * branching to `done`. */
export function cycleRootLines(host: ShapeHost, done: string): string[] {
  const S = host.sizeType;
  host.declare(`declare void @scr_cyc_on_release(ptr)`);
  const append = requestCycleAppend(host);
  return [
    `  %bufp = getelementptr i8, ptr %o, ${S} -${host.cycleBufOffset}`,
    `  %buf = load i32, ptr %bufp`,
    `  %queued = icmp slt i32 %buf, 0`,
    `  br i1 %queued, label %${done}, label %enqueue`,
    `enqueue:`,
    append
      ? `  call preserve_mostcc void @${CYC_APPEND}(ptr %o) ; buffer the candidate; may collect`
      : `  call void @scr_cyc_on_release(ptr %o) ; buffer the candidate; may collect`,
    `  br label %${done}`,
  ];
}

/** The death of a headered object: scr_cyc_on_dead with its early return
 * inlined. Only an object still in a candidate buffer (`buf` negative and
 * not SCR_CYC_ACYCLIC, which is -1) has an entry to remove; the sequence
 * continues at the new block `next`. */
export function cycleDeadLines(host: ShapeHost, next: string): string[] {
  const S = host.sizeType;
  host.declare(`declare void @scr_cyc_on_dead(ptr)`);
  return [
    `  %dbufp = getelementptr i8, ptr %o, ${S} -${host.cycleBufOffset}`,
    `  %dbuf = load i32, ptr %dbufp`,
    `  %dqueued = icmp slt i32 %dbuf, -1 ; buffered, not SCR_CYC_ACYCLIC`,
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
    const fieldTys: string[] = shape.fields.map((f) =>
      llFieldType(f.type, host.inlineUnions.record(f.type)),
    );
    if (shape.indexValue) fieldTys.push("ptr"); // the overflow ScrMap *
    // A tagged shape (an arm of a shape union) carries its shape number.
    if (host.nullableUnions.shapeNumber(shape.id) !== 0) fieldTys.unshift("i32");
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
    const members = rcMembers(shape, host.inlineUnions, host.nullableUnions.fieldBase(shape.id));
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
    const base = host.nullableUnions.fieldBase(shape.id);
    const shapeNumber = host.nullableUnions.shapeNumber(shape.id);
    const members = rcMembers(shape, host.inlineUnions, base);
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
    const destroy = `${mangleRecordRelease(shape.id)}_destroy`;
    const bounded = refMembers.some((member) => needsBoundedRelease(member.type));
    const segmented =
      bounded &&
      segmentedTeardown(
        host,
        destroy,
        refMembers.map((m) => m.type),
        directTargets,
      );
    // Closed layouts can carry a kept record source (record-sources.ts).
    const observers = recordMayKeepSource(shape) ? "weak-or-source" : "weak";
    // A segmented teardown loads its fields, releases its own block, and
    // then releases the fields (segmentTeardownLines).
    const loads: string[] = [];
    const ownType: string[] = [];
    const release = (prefix: string, m: (typeof refMembers)[number], i: number): string[] => {
      const direct = directDestroyTarget(host, m.type, directTargets);
      if (direct === null)
        return [`  call void ${releaseSym(host, m.type)}(ptr %v${i}) ; ${llvmCommentText(m.name)}`];
      const own = segmented && direct.destroy === destroy;
      return directChildReleaseLines(
        host,
        `${prefix}${i}`,
        `%v${i}`,
        direct,
        llvmCommentText(m.name),
        own,
      );
    };
    for (const m of refMembers) {
      const fieldLines = [
        `  %f${t} = getelementptr inbounds %${struct}, ptr %o, i64 0, i32 ${m.index}`,
        `  %v${t} = load ptr, ptr %f${t}`,
      ];
      if (segmented) {
        loads.push(...fieldLines);
        if (directDestroyTarget(host, m.type, directTargets)?.destroy === destroy)
          ownType.push(`%v${t}`);
      } else freeBody.push(...fieldLines, ...release("td", m, t));
      t++;
    }
    if (segmented)
      freeBody.push(
        ...segmentPrologueLines(),
        ...loads,
        ...emitObjectFree(host, traced, observers, "%sg.own"),
        ...segmentTeardownLines(ownType, (prefix) =>
          refMembers.flatMap((m, i) => release(prefix, m, i)),
        ),
      );
    else freeBody.push(...emitObjectFree(host, traced, observers));
    // A segmented shape whose every reference field holds its own type, with
    // no collector header and no frozen bit in its count, tears down in one
    // loop (iterativeTeardownDefinitions).
    const iterative =
      segmented && !traced && shape.freezable !== true && ownType.length === refMembers.length;
    defs.push(
      ...releaseBody(
        host,
        mangleRecordRelease(shape.id),
        traced,
        freeBody,
        "",
        bounded,
        false,
        chained,
        segmented,
        // A record view's word carries the frozen bit as its view mark
        // (record-views.ts), so view targets release like freezable shapes.
        shape.freezable === true || host.recordViews?.targets.has(shape.id) === true,
        iterative
          ? iterativeTeardownDefinitions(
              host,
              destroy,
              struct,
              refMembers.map((m) => m.index),
              `@${mangleRecordRelease(shape.id)}`,
              observers,
            )
          : null,
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
    if (shapeNumber !== 0)
      nw.push(
        `  %shp = getelementptr inbounds %${struct}, ptr %o, i64 0, i32 ${SHAPE_WORD_INDEX}`,
        `  store i32 ${shapeNumber}, ptr %shp ; shape number`,
      );
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
        `  %ovfp = getelementptr inbounds %${struct}, ptr %o, i64 0, i32 ${shape.fields.length + base}`,
        `  store ptr %ovf, ptr %ovfp`,
      );
    }
    if (traced) nw.push(...youngEntryLines(host));
    nw.push(`  ret ptr %o`, `}`, ``);
    defs.push(...nw);
    if (host.arenaShapes?.has(shape.id) === true && !shape.indexValue) {
      const newSym = mangleRecordNew(shape.id);
      const dispose =
        refMembers.length > 0 && host.arenasClosed !== true ? arenaDisposeSym(newSym) : null;
      const init = [`  store ${host.sizeType} ${ARENA_RC}, ptr %o`];
      if (shapeNumber !== 0)
        init.push(
          `  %shp = getelementptr inbounds %${struct}, ptr %o, i64 0, i32 ${SHAPE_WORD_INDEX}`,
          `  store i32 ${shapeNumber}, ptr %shp ; shape number`,
        );
      defs.push(
        ...arenaNewLines(host, newSym, sizeOf, traced ? cycType : null, dispose, init, "%o"),
      );
      if (dispose !== null)
        defs.push(
          ...arenaDisposeLines(
            newSym,
            refMembers.flatMap((m, i) =>
              disposeFieldLines(
                i,
                `getelementptr inbounds %${struct}, ptr %o, i64 0, i32 ${m.index}`,
                plainRefType(m.type),
                releaseSym(host, m.type),
                llvmCommentText(m.name),
              ),
            ),
          ),
        );
    }

    if (host.recordCloneShapes.has(shape.id)) {
      const attrs = shape.fields.length >= 16 ? "#2" : FN_ATTRS;
      const clone: string[] = [
        `define internal ptr @${mangleRecordClone(shape.id)}(ptr %src) ${attrs} {`,
        `entry:`,
        `  %o = call ptr @${mangleRecordNew(shape.id)}()`,
      ];
      let i = 0;
      for (const field of shape.fields) {
        const index = i + base;
        const inline = host.inlineUnions.record(field.type);
        const fieldTy = llFieldType(field.type, inline);
        if (host.recordViews?.targets.has(shape.id) === true) {
          // A view's fields live in the viewed record (record-views.ts).
          host.declare(`declare ptr @scr_record_view_slot(ptr, ${host.sizeType})`);
          clone.push(
            `  %so${i} = getelementptr inbounds %${struct}, ptr %src, i64 0, i32 ${index}`,
            ...recordViewTestLines(host.sizeType, "%src", `%sr${i}v`),
            `  br i1 %sr${i}v, label %sv${i}.view, label %sv${i}.join`,
            `sv${i}.view:`,
            `  %sw${i} = call ptr @scr_record_view_slot(ptr %src, ${host.sizeType} ${i})`,
            `  br label %sv${i}.join`,
            `sv${i}.join:`,
            `  %sp${i} = phi ptr [ %so${i}, %${i === 0 ? "entry" : `sv${i - 1}.join`} ], [ %sw${i}, %sv${i}.view ]`,
            `  %sv${i} = load ${fieldTy}, ptr %sp${i}`,
          );
        } else
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
      tracedMembers.forEach((m, i) => {
        tr.push(...traceFieldVisitLines(struct, m.index, i, llvmCommentText(m.name)));
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
      gf.push(...emitObjectFree(host, true, observers), `  ret void`, `}`, ``);
      defs.push(...gf);
    }
  }
  return { typeDefs, defs };
}
