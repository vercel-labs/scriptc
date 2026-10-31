/* Emitted object allocation and deallocation for records and class
 * instances.
 *
 * Every constructor allocates a constant-size block. The runtime's
 * small-object allocator (scr_alloc.c, contract in scr_runtime.h) serves it
 * from a per-size-class free list or bump pointer, but through an
 * out-of-line call the size class, the zeroing length, and the
 * collector-header setup are recomputed for every object. Here the fast
 * paths are inlined into the emitted `new`/release helpers instead, so they
 * fold to a constant class, a constant-length clear of only the bytes the
 * helper does not store itself, and a handful of loads and stores.
 *
 * Soundness does not depend on which runtime the program links against.
 * The runtime defines `scr_sa` and the chunk table `scr_sa_chunks` in every
 * build; where its allocator is compiled out (AddressSanitizer, the RC
 * audit) the state stays all-zero, so the inline paths find no free block,
 * no bump room and an empty span, and always take the slow path: the same
 * out-of-line calls as before (scr_rt_calloc / scr_cyc_alloc, scr_rt_free)
 * plus the RC-audit object notes. The fast paths skip those notes, which are
 * no-ops whenever the allocator is live (SCR_RC_AUDIT forces it off;
 * scr_runtime.h #errors otherwise). An inline free pushes a block onto the
 * calling thread's free list when the block's chunk carries the thread's
 * tag in the chunk table; other blocks (another arena's, system fallbacks)
 * go back through scr_rt_free.
 *
 * Inlining is limited to the targets where the allocator can be live: 64-bit,
 * not WASI, not Windows, and not thread-instanced libraries (whose
 * allocator is compiled out). Worker programs inline too, against the
 * thread-local allocator state, live count and dispose hook of the calling
 * script thread (each thread owns an arena; see scr_runtime.h). Elsewhere
 * the out-of-line calls remain. */

/** The emitter surface this module needs (a subset of ShapeHost). */
export interface AllocHost {
  declare(decl: string): void;
  needOom(): void;
  readonly sizeType: "i32" | "i64";
  /** Inline the allocator fast paths (see the target rule above). */
  readonly inlineAlloc?: boolean;
  /** Emit the RC-audit object notes on the out-of-line paths (ShapeHost
   * objectAudit: only --sanitize builds count them). Absent means emit. */
  readonly objectAudit?: boolean;
  /** The allocator state, live count and dispose hook are thread-local
   * (worker executables). */
  readonly threadLocalAlloc?: boolean;
  /** The runtime places its window below 32 GiB (Linux executables,
   * LlvmTargetOptions.lowRegion): inline frees of programs with workers find
   * a block's chunk entry in the chunk map from its address alone (scr_rc.h
   * scr_sa_chunk_map), and those of programs without workers find a block of
   * a class's slice from its offset in the window (sliceFreeLines).
   * Elsewhere they test the window's base and span first. */
  readonly windowMap?: boolean;
}

/** The state globals of the inline allocation paths and, in worker
 * executables, their byte offsets inside the runtime's one thread-local
 * ScrThreadHot block (layout asserted in scr_runtime.h). */
const STATE_GLOBALS: readonly [global: string, offset: number][] = [
  ["@scr_sa", 0],
  ["@scr_cyc_live", 984],
  ["@scr_cyc_old_freed", 992],
  ["@scr_weak_dispose_hook", 1000],
];
const THREAD_HOT_TYPE = "{ { i64, i64, i32, [40 x ptr], [40 x ptr], [40 x ptr] }, i64, i64, ptr }";

/** Worker executables: address the thread's ScrThreadHot block once through
 * llvm.threadlocal.address (which LLVM can share across a function; on
 * Darwin each distinct thread-local costs a call) and rewrite the lines to
 * address the state globals at their offsets in it. */
function threadLocalState(host: AllocHost, prefix: string, lines: string[]): string[] {
  if (host.threadLocalAlloc !== true) return lines;
  const hot = `%${prefix}.tl.hot`;
  const preamble: string[] = [];
  let text = lines.join("\n");
  for (const [global, offset] of STATE_GLOBALS) {
    // Whole names only: `@scr_sa` is not `@scr_sa_chunks`.
    const use = new RegExp(`ptr ${global.replace("$", "\\$")}(?![-$._A-Za-z0-9])`, "g");
    if (!use.test(text)) continue;
    if (preamble.length === 0) {
      host.declare(`@scr_thread_hot = external thread_local global ${THREAD_HOT_TYPE}`);
      host.declare(`declare nonnull ptr @llvm.threadlocal.address.p0(ptr nonnull)`);
      preamble.push(`  ${hot} = call ptr @llvm.threadlocal.address.p0(ptr @scr_thread_hot)`);
    }
    const local = `%${prefix}.tl.${global.slice(5)}`;
    preamble.push(`  ${local} = getelementptr inbounds i8, ptr ${hot}, i64 ${offset}`);
    text = text.replace(use, `ptr ${local}`);
  }
  return [...preamble, ...text.split("\n")];
}

/** Lines that load the runtime's dispose hook into `dest`, or null on
 * targets without the inline allocator, where the hook's storage is not
 * addressed from emitted code. The hook is NULL until a weak collection
 * or a kept record source installs it, and then never NULL again. */
export function disposeHookLoadLines(host: AllocHost, dest: string): string[] | null {
  if (host.inlineAlloc !== true) return null;
  declareGlobal(host, `@scr_weak_dispose_hook = external global ptr`);
  const prefix = dest.replace(/^%/, "").replace(/[^-$._A-Za-z0-9]/g, "_");
  return threadLocalState(host, prefix, [`  ${dest} = load ptr, ptr @scr_weak_dispose_hook`]);
}

/** Worker executables: the calling script thread's ScrThreadHot block into
 * `dest`. Its address also identifies the thread (the owner word of a
 * lifetime-region chunk; llvm/regions.ts). */
export function threadHotAddressLines(host: AllocHost, dest: string): string[] {
  host.declare(`@scr_thread_hot = external thread_local global ${THREAD_HOT_TYPE}`);
  host.declare(`declare nonnull ptr @llvm.threadlocal.address.p0(ptr nonnull)`);
  return [`  ${dest} = call ptr @llvm.threadlocal.address.p0(ptr @scr_thread_hot)`];
}

const ALLOC_NOTE = `  call void @scr_obj_alloc_note()`;
const FREE_NOTE = `  call void @scr_obj_free_note()`;

/** Whether a target can use the inline allocation paths. */
export function inlineAllocSupported(options: {
  pointerBits?: 32 | 64 | undefined;
  wasi?: boolean | undefined;
  targetTriple?: string | undefined;
  threadInstances?: boolean | undefined;
}): boolean {
  if (options.pointerBits === 32 || options.wasi === true || options.threadInstances === true) {
    return false;
  }
  // An omitted triple means the host ABI. That stays sound even on a host
  // whose runtime compiles the allocator out: scr_sa is defined there too
  // and stays zero, so only the slow paths run.
  const triple = (options.targetTriple ?? "").toLowerCase();
  return !/windows|mingw|msvc|cygwin|wasm/.test(triple);
}

/* ScrSaState layout on 64-bit targets (asserted in scr_runtime.h). */
const SA_TYPE = "{ i64, i64, i32, [40 x ptr], [40 x ptr], [40 x ptr] }";
const SA_SPAN = 8;
/** The arena's tag, (arena + 1) << 8: an entry of the arena's chunks xor
 * the tag is below 256, and is the entry's size class. */
const SA_TAG = 16;
const SA_FREE = 24;
/** The chunk table (scr_sa_chunks in scr_rc.h): an i16 per window chunk,
 * the owning arena's tag in the high byte and the size class in the low
 * one. */
const SA_CHUNKS = "@scr_sa_chunks";
const SA_CHUNKS_TYPE = "[7168 x i16]";
/** log2 of the chunk size (SCR_SA_CHUNK_SHIFT), the same for every arena. */
const SA_CHUNK_SHIFT = 22;
const SA_BUMP = 344;
const SA_LIM = 664;
/** Classes step by 8 bytes up to SA_FINE_MAX and by 16 above it, and the
 * class of 49 to 56-byte requests holds 64-byte blocks (scr_sa_class /
 * scr_sa_class_size in scr_runtime.h). */
const SA_FINE_MAX = 128;
const SA_WIDE = 6;
const SA_MAX = 512;
/** sizeof(ScrCycHdr): the descriptor's i16 registry id, i8 color and
 * generation, and an i32 `buf` whose sign bit marks a buffered candidate
 * (scr_runtime.h asserts the offsets). */
export const CYC_HDR = 8;
/** ScrCycHdr.gen, an i8 at this header offset. */
const CYC_GEN = 3;
/** ScrCycHdr.buf, an i32 at this header offset. */
export const CYC_BUF = 4;
/** The emitted descriptor `{ trace, free_fn, kind, id }` (ScrCycType). */
export const CYC_TYPE = "{ ptr, ptr, i32, i32 }";

function declareState(host: AllocHost): void {
  if (host.threadLocalAlloc !== true) host.declare(`@scr_sa = external global ${SA_TYPE}`);
  host.declare(`declare i1 @llvm.expect.i1(i1, i1)`);
}

function declareGlobal(host: AllocHost, decl: string): void {
  if (host.threadLocalAlloc !== true) host.declare(decl);
}

/** `scr_cyc_buffers` (scr_rc.h ScrCycBuffers): the three candidate buffers
 * `{ v, n, cap, used }`, the inline buffering window and the allocation
 * trigger. */
const CYC_BUFFERS_TYPE = "{ [3 x { ptr, i64, i64, i64 }], i64, i64 }";
/** Byte offsets in it (asserted in scr_rc.h). */
const CYC_NURSERY_COUNT = 8;
const CYC_WINDOW = 96;
const CYC_ALLOC_TRIGGER = 104;

/** Whether emitted release paths can append nursery candidates to the
 * collector's buffer themselves (through {@link cycleAppendHelper}): where
 * the runtime keeps that state in ordinary globals (executables without
 * workers and classic libraries, on the 64-bit targets with inline
 * allocation). */
export function inlineBufferingSupported(host: AllocHost): boolean {
  return host.inlineAlloc === true && host.threadLocalAlloc !== true && host.sizeType === "i64";
}

/** The emitted symbol of {@link cycleAppendHelper}. */
export const CYC_APPEND = "sc_cyc_append";

/** The runtime symbols {@link cycleAppendHelper} uses. The helper is
 * defined after the module's extern block, so its caller declares them. */
export function cycleAppendDecls(): string[] {
  return [
    `@scr_cyc_buffers = external global ${CYC_BUFFERS_TYPE}`,
    `@scr_cyc_live = external global i64`,
    `declare void @scr_cyc_on_release(ptr)`,
  ];
}

/** The candidate-buffering step of every emitted release that leaves a
 * headered object alive and unbuffered: scr_rc.h's scr_cyc_append, then
 * scr_cyc_on_release when it declines. A nursery object goes onto the
 * nursery buffer while the buffer holds fewer entries than the runtime's
 * window and the live count is below the allocation trigger.
 *
 * One out-of-line definition per module keeps the release fast paths, which
 * LLVM inlines into their callers, as small as the plain call they had. It
 * uses preserve_mostcc, so the call clobbers almost no caller registers:
 * the callers' code around a release stays what it was, and the append
 * itself saves only the few registers it uses. Its slow path enters the
 * runtime through a second preserve_mostcc function, which saves the rest. */
export function cycleAppendHelper(): string[] {
  return [
    `define internal preserve_mostcc void @${CYC_APPEND}(ptr %o) noinline #0 { ; scr_cyc_append, else scr_cyc_on_release`,
    `entry:`,
    `  %genp = getelementptr i8, ptr %o, i64 -${CYC_HDR - CYC_GEN}`,
    `  %gen = load i8, ptr %genp ; ScrCycHdr.gen`,
    `  %young = icmp eq i8 %gen, 0`,
    `  br i1 %young, label %window, label %call`,
    `window:`,
    `  %np = getelementptr inbounds i8, ptr @scr_cyc_buffers, i64 ${CYC_NURSERY_COUNT}`,
    `  %n = load i64, ptr %np ; nursery buffer entries`,
    `  %wp = getelementptr inbounds i8, ptr @scr_cyc_buffers, i64 ${CYC_WINDOW}`,
    `  %w = load i64, ptr %wp ; window`,
    `  %room = icmp ult i64 %n, %w`,
    `  br i1 %room, label %live, label %call`,
    `live:`,
    `  %lv = load i64, ptr @scr_cyc_live`,
    `  %tp = getelementptr inbounds i8, ptr @scr_cyc_buffers, i64 ${CYC_ALLOC_TRIGGER}`,
    `  %t = load i64, ptr %tp ; allocation trigger`,
    `  %due = icmp uge i64 %lv, %t`,
    `  br i1 %due, label %call, label %append`,
    `append:`,
    `  %v = load ptr, ptr @scr_cyc_buffers`,
    `  %slot = getelementptr inbounds ptr, ptr %v, i64 %n`,
    `  store ptr %o, ptr %slot`,
    `  %n1 = add i64 %n, 1`,
    `  store i64 %n1, ptr %np`,
    `  %i = trunc i64 %n to i32`,
    `  %b = or i32 %i, -2147483648 ; SCR_CYC_BUFFERED_BIT | position`,
    `  %bufp = getelementptr i8, ptr %o, i64 -${CYC_HDR - CYC_BUF}`,
    `  store i32 %b, ptr %bufp`,
    `  ret void`,
    `call:`,
    `  tail call preserve_mostcc void @${CYC_APPEND}_call(ptr %o)`,
    `  ret void`,
    `}`,
    // The runtime call clobbers every caller-saved register, which this
    // preserve_mostcc function must restore: saving them here keeps those
    // saves out of the append path above.
    `define internal preserve_mostcc void @${CYC_APPEND}_call(ptr %o) noinline #0 {`,
    `entry:`,
    `  call void @scr_cyc_on_release(ptr %o) ; buffer the candidate; may collect`,
    `  ret void`,
    `}`,
    ``,
  ];
}

/** A collector header to install: the object type's constant ScrCycType
 * descriptor (its trace and teardown; see cycTypeDescriptor). `acyclic`:
 * the descriptor's trace is scr_cyc_no_children, and `buf` starts out
 * SCR_CYC_ACYCLIC (scr_cyc_alloc does the same on its path). */
export interface CycHeader {
  type: string;
  acyclic?: boolean;
}

/** The first collector statistics index of an emitted ScrCycType
 * descriptor; the runtime's own families use the ones below
 * (SCR_CYC_KIND_EMITTED in scr_runtime.h). */
export const FIRST_EMITTED_CYC_KIND = 32;

/** The definition of a shape's ScrCycType descriptor `{ trace, free_fn,
 * kind, id }`, named by every header of that shape through its registry
 * id. `kind` indexes the collector's per-type statistics (scr_runtime.h);
 * emitted shapes number themselves from FIRST_EMITTED_CYC_KIND
 * (ShapeHost.nextCycKind) and 0 keeps none. The runtime assigns `id` on the
 * first allocation, so the descriptor is writable. */
export function cycTypeDescriptor(name: string, trace: string, free: string, kind = 0): string {
  return `${name} = internal global ${CYC_TYPE} { ptr ${trace}, ptr ${free}, i32 ${kind}, i32 0 }`;
}

/**
 * Lines that leave a zeroed object of `size` bytes (an integer constant
 * expression) in `%o`, aborting on OOM, with the RC-audit allocation note
 * on the out-of-line path. With `cyc`, the object carries a collector
 * header (scr_cyc_alloc's contract). `stored` is the number of leading
 * object bytes the caller stores unconditionally right after (the refcount
 * word, or the 4-byte header of a compact class instance), which a recycled
 * block need not clear; it is a multiple of 4 and at most `size`. Labels use the
 * `sa.` prefix; the lines end in an open block.
 */
export function emitObjectAlloc(
  host: AllocHost,
  size: string,
  cyc: CycHeader | null,
  stored = 8,
): string[] {
  const lines = threadLocalState(host, "sa", allocLines(host, size, cyc, stored));
  if (host.objectAudit === false) return lines.filter((line) => line !== ALLOC_NOTE);
  host.declare(`declare void @scr_obj_alloc_note()`);
  return lines;
}

function allocLines(
  host: AllocHost,
  size: string,
  cyc: CycHeader | null,
  stored: number,
): string[] {
  const S = host.sizeType;
  if (host.inlineAlloc !== true) {
    if (cyc) {
      host.declare(`declare ptr @scr_cyc_alloc(${S}, ptr)`);
      return [
        `  %o = call ptr @scr_cyc_alloc(${S} ${size}, ptr ${cyc.type})`,
        `  call void @scr_obj_alloc_note()`,
      ];
    }
    host.declare(`declare ptr @scr_rt_calloc(${S})`);
    host.needOom();
    return [
      `  %o = call ptr @scr_rt_calloc(${S} ${size})`,
      `  %isnull = icmp eq ptr %o, null`,
      `  br i1 %isnull, label %oom, label %ok`,
      `oom:`,
      `  call void @sc_oom()`,
      `  unreachable`,
      `ok:`,
      `  call void @scr_obj_alloc_note()`,
    ];
  }
  declareState(host);
  // Bytes of the block that the fast path itself stores after the clear:
  // the header, or the object's leading words.
  const keep = cyc ? CYC_HDR : stored;
  // A type's first object registers its descriptor on the slow path.
  const registered = cyc
    ? [
        `  %sa.tidp = getelementptr inbounds ${CYC_TYPE}, ptr ${cyc.type}, i32 0, i32 3`,
        `  %sa.tid = load atomic i32, ptr %sa.tidp acquire, align 4`,
        `  %sa.reg = icmp ne i32 %sa.tid, 0`,
        `  %sa.fits0 = icmp ule i64 %sa.n, ${SA_MAX}`,
        `  %sa.small = and i1 %sa.reg, %sa.fits0`,
      ]
    : [`  %sa.small = icmp ule i64 %sa.n, ${SA_MAX}`];
  const lines = [
    `  %sa.n = add i64 ${size}, ${cyc ? CYC_HDR : 0}`,
    ...registered,
    `  br i1 %sa.small, label %sa.class, label %sa.slow`,
    `sa.class:`,
    `  %sa.nm1 = sub i64 %sa.n, 1`,
    `  %sa.k = lshr i64 %sa.nm1, 3`,
    `  %sa.fine = icmp ule i64 %sa.n, ${SA_FINE_MAX}`,
    `  %sa.kc = add i64 %sa.k, ${SA_FINE_MAX / 8}`,
    `  %sa.cc = lshr i64 %sa.kc, 1`,
    `  %sa.c = select i1 %sa.fine, i64 %sa.k, i64 %sa.cc`,
    `  %sa.c8 = shl i64 %sa.c, 3`,
    `  %sa.fo = add i64 %sa.c8, ${SA_FREE}`,
    `  %sa.fp = getelementptr inbounds i8, ptr @scr_sa, i64 %sa.fo`,
    `  %sa.b = load ptr, ptr %sa.fp`,
    `  %sa.hit = icmp ne ptr %sa.b, null`,
    `  %sa.hitx = call i1 @llvm.expect.i1(i1 %sa.hit, i1 true)`,
    `  br i1 %sa.hitx, label %sa.pop, label %sa.bump`,
    `sa.pop: ; recycled blocks are dirty`,
    `  %sa.next = load ptr, ptr %sa.b`,
    `  store ptr %sa.next, ptr %sa.fp`,
    `  %sa.z = getelementptr inbounds i8, ptr %sa.b, i64 ${keep}`,
    `  %sa.zn = sub i64 %sa.n, ${keep}`,
    `  call void @llvm.memset.p0.i64(ptr align ${keep % 8 === 0 ? 8 : 4} %sa.z, i8 0, i64 %sa.zn, i1 false)`,
    `  br label %sa.fast`,
    `sa.bump: ; fresh reservation memory is already zero`,
    `  %sa.c1 = add i64 %sa.c, 1`,
    `  %sa.wide = icmp eq i64 %sa.c, ${SA_WIDE}`,
    `  %sa.widez = zext i1 %sa.wide to i64`,
    `  %sa.c1w = add i64 %sa.c1, %sa.widez`,
    `  %sa.szf = shl i64 %sa.c1w, 3`,
    `  %sa.cs = sub i64 %sa.c1, ${SA_FINE_MAX / 16}`,
    `  %sa.szc = shl i64 %sa.cs, 4`,
    `  %sa.sz = select i1 %sa.fine, i64 %sa.szf, i64 %sa.szc`,
    `  %sa.bo = add i64 %sa.c8, ${SA_BUMP}`,
    `  %sa.bp = getelementptr inbounds i8, ptr @scr_sa, i64 %sa.bo`,
    `  %sa.lo = add i64 %sa.c8, ${SA_LIM}`,
    `  %sa.lp = getelementptr inbounds i8, ptr @scr_sa, i64 %sa.lo`,
    `  %sa.p = load ptr, ptr %sa.bp`,
    `  %sa.l = load ptr, ptr %sa.lp`,
    `  %sa.pi = ptrtoint ptr %sa.p to i64`,
    `  %sa.li = ptrtoint ptr %sa.l to i64`,
    `  %sa.room = sub i64 %sa.li, %sa.pi`,
    `  %sa.fits = icmp uge i64 %sa.room, %sa.sz`,
    `  %sa.fitsx = call i1 @llvm.expect.i1(i1 %sa.fits, i1 true)`,
    `  br i1 %sa.fitsx, label %sa.carve, label %sa.slow`,
    `sa.carve:`,
    `  %sa.np = getelementptr inbounds i8, ptr %sa.p, i64 %sa.sz`,
    `  store ptr %sa.np, ptr %sa.bp`,
    `  br label %sa.fast`,
  ];
  host.declare(`declare void @llvm.memset.p0.i64(ptr, i8, i64, i1)`);
  if (cyc) {
    host.declare(`declare ptr @scr_cyc_alloc(${S}, ptr)`);
    declareGlobal(host, `@scr_cyc_live = external global i64`);
    lines.push(
      `sa.fast:`,
      `  %sa.blk = phi ptr [ %sa.b, %sa.pop ], [ %sa.p, %sa.carve ]`,
      `  %sa.id = trunc i32 %sa.tid to i16`,
      `  store i16 %sa.id, ptr %sa.blk ; ScrCycHdr.id`,
      `  %sa.cgp = getelementptr inbounds i8, ptr %sa.blk, i64 2`,
      `  store i16 0, ptr %sa.cgp ; ScrCycHdr.color, gen`,
      `  %sa.bufp = getelementptr inbounds i8, ptr %sa.blk, i64 ${CYC_BUF}`,
      cyc.acyclic === true
        ? `  store i32 -1, ptr %sa.bufp ; ScrCycHdr.buf = SCR_CYC_ACYCLIC`
        : `  store i32 0, ptr %sa.bufp ; ScrCycHdr.buf`,
      `  %sa.live = load i64, ptr @scr_cyc_live`,
      `  %sa.live1 = add i64 %sa.live, 1`,
      `  store i64 %sa.live1, ptr @scr_cyc_live`,
      `  %sa.obj = getelementptr inbounds i8, ptr %sa.blk, i64 ${CYC_HDR}`,
      `  br label %sa.done`,
      `sa.slow:`,
      `  %sa.s = call ptr @scr_cyc_alloc(i64 ${size}, ptr ${cyc.type})`,
      `  call void @scr_obj_alloc_note()`,
      `  br label %sa.done`,
      `sa.done:`,
      `  %o = phi ptr [ %sa.obj, %sa.fast ], [ %sa.s, %sa.slow ]`,
    );
  } else {
    host.declare(`declare ptr @scr_rt_calloc(${S})`);
    host.needOom();
    lines.push(
      `sa.fast:`,
      `  %sa.blk = phi ptr [ %sa.b, %sa.pop ], [ %sa.p, %sa.carve ]`,
      `  br label %sa.done`,
      `sa.slow:`,
      `  %sa.s = call ptr @scr_rt_calloc(i64 ${size})`,
      `  %sa.null = icmp eq ptr %sa.s, null`,
      `  br i1 %sa.null, label %oom, label %sa.noted`,
      `oom:`,
      `  call void @sc_oom()`,
      `  unreachable`,
      `sa.noted:`,
      `  call void @scr_obj_alloc_note()`,
      `  br label %sa.done`,
      `sa.done:`,
      `  %o = phi ptr [ %sa.blk, %sa.fast ], [ %sa.s, %sa.noted ]`,
    );
  }
  return lines;
}

/* ── dispose observers ────────────────────────────────────────────────
 * The runtime's dispose hook (scr_weak_dispose_hook) has three clients:
 * weak collections, whose keys can be any object, the kept sources of
 * checked records (scr_record_source_note and the JSON schema parser), and
 * the links of narrowed record copies to their sources (scr_record_link),
 * both keyed by closed records (RECORD_SOURCES_GATE covers both). A
 * program without any can never install
 * the hook, so its frees need not test it. Whether the program has them is
 * known only once every helper is emitted (dynCheck builders and JSON
 * schemas are requested lazily), so the emitted frees and record writers
 * test these module constants, which the emitter defines last
 * (LlvmEmitter.emitParts) and LLVM folds away. */

/** True when the program constructs a WeakMap or WeakSet. */
export const WEAK_KEYS_GATE = "@sc_weak_keys";
/** True when a checked conversion can keep a record's undeclared source,
 * or a narrowing conversion can link a record copy to its source: the
 * record frees test it. */
export const RECORD_SOURCES_GATE = "@sc_record_sources";
/** In a module with record links, true when a checked conversion can keep
 * a record's undeclared source: what the record-source lookups test there
 * (recordSourcesGate). */
export const RECORD_KEPT_GATE = "@sc_record_kept";

/** Which dispose observers an object type can have: weak-collection keys
 * only, or (closed record layouts) kept record sources too. */
export type FreeObservers = "weak" | "weak-or-source";

/**
 * Lines that free the object `%o` after its members were released: the
 * RC-audit free note, the dispose hook (when the program can observe this
 * type's disposals), and the block — `scr_cyc_free` for collector-headered
 * objects, `scr_rt_free` otherwise. Labels use the `sf.` prefix; the lines
 * end in an open block.
 *
 * With `keep` (an alloca of ptr holding NULL; inline allocation paths only),
 * a block that would go onto the calling thread's free list is stored there
 * instead, for a teardown segment (emitSegmentFree); a block the system or
 * another arena owns is still freed.
 */
export function emitObjectFree(
  host: AllocHost,
  cyc: boolean,
  observers: FreeObservers = "weak",
  keep: string | null = null,
  size: string | null = null,
): string[] {
  const lines = threadLocalState(host, "sf", freeLines(host, cyc, observers, keep, size));
  if (host.objectAudit === false) return lines.filter((line) => line !== FREE_NOTE);
  host.declare(`declare void @scr_obj_free_note()`);
  return lines;
}

/** Lines that leave in `%<prefix>.e` the chunk-table entry (i32) of the
 * block at window offset `off`, which is below the window's span. */
function chunkEntryLines(host: AllocHost, prefix: string, off: string): string[] {
  host.declare(`${SA_CHUNKS} = external global ${SA_CHUNKS_TYPE}`);
  return [
    `  %${prefix}.ci = lshr i64 ${off}, ${SA_CHUNK_SHIFT}`,
    `  %${prefix}.ep = getelementptr inbounds i16, ptr ${SA_CHUNKS}, i64 %${prefix}.ci`,
    `  %${prefix}.e16 = load i16, ptr %${prefix}.ep`,
    `  %${prefix}.e = zext i16 %${prefix}.e16 to i32`,
  ];
}

/** The chunk map (scr_sa_chunk_map in scr_rc.h): an i16 per 4 MiB of the
 * first 32 GiB of the address space, the window's chunk-table entries while
 * the window lies there. */
const SA_MAP = "@scr_sa_chunk_map";
const SA_MAP_CHUNKS = 8192;

/** log2 of a class's slice (scr_rc.h SCR_SA_SLICE_SHIFT). */
const SA_SLICE_SHIFT = 28;

/** Lines that free the block `blk` of a program without workers when it lies
 * in the classes' slices (scr_rc.h scr_sa_slice_span): onto the free list of
 * class (blk - base) >> SA_SLICE_SHIFT, or into `keep`. Any other block
 * branches to `%sf.sys`, so that the inline free stays as small as a
 * shift-indexed push. */
function sliceFreeLines(host: AllocHost, blk: string, keep: string | null): string[] {
  host.declare(`@scr_sa_slice_span = external global i64`);
  return [
    `  %sf.sb = load i64, ptr @scr_sa`,
    `  %sf.sp = ptrtoint ptr ${blk} to i64`,
    `  %sf.so = sub i64 %sf.sp, %sf.sb`,
    `  %sf.ss = load i64, ptr @scr_sa_slice_span`,
    `  %sf.sin = icmp ult i64 %sf.so, %sf.ss`,
    `  %sf.sinx = call i1 @llvm.expect.i1(i1 %sf.sin, i1 true)`,
    `  br i1 %sf.sinx, label %sf.slice, label %sf.sys`,
    `sf.slice:`,
    `  %sf.sc = lshr i64 %sf.so, ${SA_SLICE_SHIFT}`,
    ...(keep !== null
      ? [`  store ptr ${blk}, ptr ${keep}`]
      : freeListPushLines("sfs", blk, blk, "%sf.sc")),
    `  br label %sf.done`,
  ];
}

/** Lines that branch to `%<prefix>.chunk` with the chunk entry (i32) of the
 * block `blk` in `%<prefix>.e`, or to `%<prefix>.sys` for a block outside
 * the window. With the chunk map the address alone indexes it (an empty map
 * leaves every block to the slow path, as does a tag no entry carries);
 * otherwise the block's offset in the window does. */
function blockEntryLines(host: AllocHost, prefix: string, blk: string): string[] {
  const p = `%${prefix}`;
  if (host.windowMap === true) {
    host.declare(`${SA_MAP} = external global [${SA_MAP_CHUNKS} x i16]`);
    return [
      `  ${p}.bi = ptrtoint ptr ${blk} to i64`,
      `  ${p}.ci = lshr i64 ${p}.bi, ${SA_CHUNK_SHIFT}`,
      `  ${p}.in = icmp ult i64 ${p}.ci, ${SA_MAP_CHUNKS}`,
      `  ${p}.inx = call i1 @llvm.expect.i1(i1 ${p}.in, i1 true)`,
      `  br i1 ${p}.inx, label ${p}.chunk, label ${p}.sys`,
      `${prefix}.chunk:`,
      `  ${p}.ep = getelementptr inbounds i16, ptr ${SA_MAP}, i64 ${p}.ci`,
      `  ${p}.e16 = load i16, ptr ${p}.ep`,
      `  ${p}.e = zext i16 ${p}.e16 to i32`,
    ];
  }
  return [
    `  ${p}.base = load i64, ptr @scr_sa`,
    `  ${p}.spanp = getelementptr inbounds i8, ptr @scr_sa, i64 ${SA_SPAN}`,
    `  ${p}.span = load i64, ptr ${p}.spanp`,
    `  ${p}.bi = ptrtoint ptr ${blk} to i64`,
    `  ${p}.off = sub i64 ${p}.bi, ${p}.base`,
    `  ${p}.in = icmp ult i64 ${p}.off, ${p}.span`,
    `  ${p}.inx = call i1 @llvm.expect.i1(i1 ${p}.in, i1 true)`,
    `  br i1 ${p}.inx, label ${p}.chunk, label ${p}.sys`,
    `${prefix}.chunk:`,
    ...chunkEntryLines(host, prefix, `${p}.off`),
  ];
}

/** Lines that put the blocks `first` to `last` (linked through their first
 * words; one block when they are equal) of size class `cls` (i64), or by
 * default of the class in the low byte of the chunk-table entry
 * `%<prefix>.e`, on the calling thread's free list. */
function freeListPushLines(prefix: string, first: string, last: string, cls?: string): string[] {
  const classLines =
    cls === undefined
      ? [
          `  %${prefix}.c32 = and i32 %${prefix}.e, 255`,
          `  %${prefix}.c = zext i32 %${prefix}.c32 to i64`,
        ]
      : [];
  const c = cls ?? `%${prefix}.c`;
  return [
    ...classLines,
    `  %${prefix}.c8 = shl i64 ${c}, 3`,
    `  %${prefix}.fo = add i64 %${prefix}.c8, ${SA_FREE}`,
    `  %${prefix}.fp = getelementptr inbounds i8, ptr @scr_sa, i64 %${prefix}.fo`,
    `  %${prefix}.head = load ptr, ptr %${prefix}.fp`,
    `  store ptr %${prefix}.head, ptr ${last}`,
    `  store ptr ${first}, ptr %${prefix}.fp`,
  ];
}

/**
 * Lines that free a teardown segment: the blocks `first` to `last` (ptr
 * values, both NULL for an empty segment), linked through their first words,
 * which emitObjectFree kept. Every block of a segment is in the calling
 * thread's arena and of one size class, so the segment goes onto that
 * class's free list in one step, and the next allocations of the class take
 * its blocks in segment order. Labels use `prefix`; the lines end in the
 * open block `${prefix}.done`.
 */
export function emitSegmentFree(
  host: AllocHost,
  prefix: string,
  first: string,
  last: string,
): string[] {
  declareState(host);
  const lines = [
    `  %${prefix}.none = icmp eq ptr ${first}, null`,
    `  br i1 %${prefix}.none, label %${prefix}.done, label %${prefix}.push`,
    `${prefix}.push:`,
    `  %${prefix}.base = load i64, ptr @scr_sa`,
    `  %${prefix}.bi = ptrtoint ptr ${first} to i64`,
    `  %${prefix}.off = sub i64 %${prefix}.bi, %${prefix}.base`,
    ...chunkEntryLines(host, prefix, `%${prefix}.off`),
    ...freeListPushLines(prefix, first, last),
    `  br label %${prefix}.done`,
    `${prefix}.done:`,
  ];
  return threadLocalState(host, prefix, lines);
}

/** Lines that leave in `%<prefix>.obs` whether the program can observe a
 * disposal of this type (folds to a constant). */
function observedLines(prefix: string, observers: FreeObservers): string[] {
  if (observers === "weak") return [`  %${prefix}.obs = load i1, ptr ${WEAK_KEYS_GATE}`];
  return [
    `  %${prefix}.obsw = load i1, ptr ${WEAK_KEYS_GATE}`,
    `  %${prefix}.obss = load i1, ptr ${RECORD_SOURCES_GATE}`,
    `  %${prefix}.obs = or i1 %${prefix}.obsw, %${prefix}.obss`,
  ];
}

/** Lines that leave in `%<prefix>.cls` (i64) the size class of an object of
 * `size` bytes, with the collector header when `cyc` (scr_sa_class), and in
 * `%<prefix>.small` whether the allocator serves that size at all. Both fold
 * to constants for a constant size. */
function sizeClassLines(prefix: string, size: string, cyc: boolean): string[] {
  return [
    `  %${prefix}.n = add i64 ${size}, ${cyc ? CYC_HDR : 0}`,
    `  %${prefix}.small = icmp ule i64 %${prefix}.n, ${SA_MAX}`,
    `  %${prefix}.nm1 = sub i64 %${prefix}.n, 1`,
    `  %${prefix}.k = lshr i64 %${prefix}.nm1, 3`,
    `  %${prefix}.fine = icmp ule i64 %${prefix}.n, ${SA_FINE_MAX}`,
    `  %${prefix}.kc = add i64 %${prefix}.k, ${SA_FINE_MAX / 8}`,
    `  %${prefix}.cc = lshr i64 %${prefix}.kc, 1`,
    `  %${prefix}.cls = select i1 %${prefix}.fine, i64 %${prefix}.k, i64 %${prefix}.cc`,
  ];
}

function freeLines(
  host: AllocHost,
  cyc: boolean,
  observers: FreeObservers,
  keep: string | null,
  size: string | null,
): string[] {
  if (host.inlineAlloc !== true) {
    if (keep !== null) throw new Error("a kept block needs the inline allocation paths");
    if (cyc) {
      host.declare(`declare void @scr_cyc_free(ptr)`);
      return [`  call void @scr_obj_free_note()`, `  call void @scr_cyc_free(ptr %o)`];
    }
    host.declare(`declare void @scr_rt_free(ptr)`);
    host.declare(`declare void @scr_weak_dispose(ptr)`);
    return [
      `  call void @scr_obj_free_note()`,
      ...observedLines("sf", observers),
      `  br i1 %sf.obs, label %sf.observe, label %sf.block`,
      `sf.observe:`,
      `  call void @scr_weak_dispose(ptr %o)`,
      `  br label %sf.block`,
      `sf.block:`,
      `  call void @scr_rt_free(ptr %o)`,
    ];
  }
  declareState(host);
  host.declare(`declare void @scr_rt_free(ptr)`);
  declareGlobal(host, `@scr_weak_dispose_hook = external global ptr`);
  const lines = [
    ...observedLines("sf", observers),
    `  br i1 %sf.obs, label %sf.hooked, label %sf.block`,
    `sf.hooked:`,
    `  %sf.hook = load ptr, ptr @scr_weak_dispose_hook`,
    `  %sf.has = icmp ne ptr %sf.hook, null`,
    `  %sf.hasx = call i1 @llvm.expect.i1(i1 %sf.has, i1 false)`,
    `  br i1 %sf.hasx, label %sf.observe, label %sf.block`,
    `sf.observe: ; a weak collection or a kept record source observes the disposal`,
    `  call void %sf.hook(ptr %o)`,
    `  br label %sf.block`,
    `sf.block:`,
  ];
  if (cyc) {
    declareGlobal(host, `@scr_cyc_live = external global i64`);
    declareGlobal(host, `@scr_cyc_old_freed = external global i64`);
    lines.push(
      `  %sf.live = load i64, ptr @scr_cyc_live`,
      `  %sf.live1 = sub i64 %sf.live, 1`,
      `  store i64 %sf.live1, ptr @scr_cyc_live`,
      `  %sf.blk = getelementptr inbounds i8, ptr %o, i64 -${CYC_HDR}`,
      `  %sf.genp = getelementptr inbounds i8, ptr %sf.blk, i64 ${CYC_GEN}`,
      `  %sf.gen = load i8, ptr %sf.genp ; ScrCycHdr.gen`,
      `  %sf.old = icmp eq i8 %sf.gen, 2`,
      `  br i1 %sf.old, label %sf.oldcount, label %sf.accounted`,
      `sf.oldcount:`,
      `  %sf.freed = load i64, ptr @scr_cyc_old_freed`,
      `  %sf.freed1 = add i64 %sf.freed, 1`,
      `  store i64 %sf.freed1, ptr @scr_cyc_old_freed`,
      `  br label %sf.accounted`,
      `sf.accounted:`,
    );
  }
  const blk = cyc ? "%sf.blk" : "%o";
  if (host.windowMap === true && host.threadLocalAlloc !== true)
    // A program without workers frees a block of a class's slice inline;
    // any other block takes the out-of-line free.
    lines.push(...sliceFreeLines(host, blk, keep));
  else
    lines.push(
      // The block is the calling thread's when its chunk carries the thread's tag.
      ...blockEntryLines(host, "sf", blk),
      `  %sf.tagp = getelementptr inbounds i8, ptr @scr_sa, i64 ${SA_TAG}`,
      `  %sf.tag = load i32, ptr %sf.tagp`,
      `  %sf.x = xor i32 %sf.e, %sf.tag`,
      ...(size !== null
        ? [
            // The object's size gives its class, so the entry is only compared
            // with the one the thread's chunks of that class carry, and the push
            // does not wait for the table load.
            ...sizeClassLines("sf", size, cyc),
            `  %sf.cls32 = trunc i64 %sf.cls to i32`,
            `  %sf.entry = icmp eq i32 %sf.x, %sf.cls32`,
            `  %sf.mine = and i1 %sf.entry, %sf.small`,
          ]
        : [`  %sf.mine = icmp ult i32 %sf.x, 256`, `  %sf.xc = zext i32 %sf.x to i64`]),
      `  %sf.minex = call i1 @llvm.expect.i1(i1 %sf.mine, i1 true)`,
      `  br i1 %sf.minex, label %sf.push, label %sf.sys`,
      `sf.push:`,
      ...(keep !== null
        ? [`  store ptr ${blk}, ptr ${keep}`]
        : size !== null
          ? freeListPushLines("sf", blk, blk, "%sf.cls")
          : freeListPushLines("sf", blk, blk, "%sf.xc")),
      `  br label %sf.done`,
    );
  lines.push(
    `sf.sys: ; another arena's or the system's block, or the allocator is compiled out`,
    `  call void @scr_obj_free_note()`,
    `  call void @scr_rt_free(ptr ${blk})`,
    `  br label %sf.done`,
    `sf.done:`,
  );
  return lines;
}
