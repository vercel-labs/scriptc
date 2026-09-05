import { InternalCompilerError } from "../../errors.js";
/* IR → LLVM IR text (.ll). The LLVM backend consumes the SAME in-memory
 * IrModule the C backend does (never the JSON dump — see the -0 lesson in
 * the survey). Its textual module is either lowered by scriptc's native
 * helper and linked with a runtime pack or occupies the legacy compiler
 * driver's program-TU seat. Both paths use the same scr_* C ABI.
 *
 * Phase 1 was the TRIVIAL TIER: f64/bool/string locals and params, the
 * scalar operator set, structured control flow, direct calls, interned
 * string literals, and the console protocol. Phase 2 adds the VOLUME
 * TIER: module globals and locals of every in-tier ref kind (arrays,
 * record shapes, unions, function values/closures), the full array and
 * string intrinsic surfaces, per-record-shape RC helpers (cycle headers
 * included — the C emitter's fixpoint, ported in shapes.ts), tagged-union
 * construction/narrowing/equality with interned immortal unit instances,
 * capture boxes and the closure calling convention, switch/for-of
 * lowering, and the non-throwing slice of the libCall table. EVERYTHING
 * ELSE REFUSES loudly at the first unhandled node (LlvmUnsupportedError
 * naming the kind) — this backend never guesses and never emits wrong
 * code for a construct it does not model. compile() surfaces the refusal
 * as diagnostic SC3001.
 *
 * RC ownership discipline: the frame/scope release-point machinery is
 * ported from CEmitter (docs/ir.md) — every refcounted temp holds an owned
 * +1 reference; varDecl/assign/return/call-argument MOVE that ownership;
 * each statement releases its remaining refcounted temps when it ends;
 * each scope releases the refcounted locals declared in it when it exits;
 * callees own their params; return/break/continue release everything the
 * jump bypasses (releaseForJump). Releases are type-directed through
 * shapes.ts (the releaseCallC table's LLVM twin); frame entries can be
 * SLOT-based (the entry names a pointer whose CURRENT value releases —
 * conditional results like optional chains need that indirection).
 *
 * Exceptions (phase 4): the pending-flag unwind protocol, ported from the
 * C emitter. `throw` moves its payload into the runtime's exception cell
 * (scr_throw_*) and unwinds; after every call that can raise (per the
 * SAME computeMayThrow analysis the C backend runs) a pending check tests
 * scr_exc_pending() and unwinds — releasing frames/scopes down to the
 * innermost try handler's depths and branching to its label, or releasing
 * everything and returning a dummy value (never read: callers of a
 * may-throw function test the flag before using the result). No
 * setjmp/longjmp: longjmp would skip the emitted RC releases. try/catch
 * follows stmts.ts's shape exactly — a compile-time tryStack entry
 * per region, the catch block taking the exception (scr_exc_take into the
 * binding's snapshot box, or scr_exc_clear for the bindingless form), the
 * finally body emitted once per path (normal, exception-with-stash,
 * pending-return) with fresh temps each time. Catch bindings ride
 * ScrCaught snapshot boxes (caughtTest/caughtNarrow/caughtCheck read
 * them); TDZ reads test the box's payload slot and throw Node's
 * ReferenceError. main() gains the uncaught epilogue when the entry
 * function may throw.
 *
 * The dyn surface (phase 5): ScrDyn dyn values are in the tier — dyn.ts
 * ports walkers.ts's dyn slice (match/check/toDyn walkers, the
 * String(unknown)/caught→dyn/keyed-read singletons, the checked-dynamic
 * function boundary's thunk/box/adapter triple) and the emitter lowers
 * the dyn expression kinds (dynFrom/dynCall/dynInvoke/dynTest/dynKeyGet/
 * dynCheck/destructuring), the JSON.parse family, dyn record fields and
 * overflow maps, dyn capture boxes, and generator unknown channels.
 * The island surface (jsval/jsExit and embedded npm tables) is in the
 * tier too; the module text and resolution tables use the same compressed,
 * lazy-inflate representation as the C debugging backend.
 */
import { deflateRawSync } from "node:zlib";
import { endsWithJump, matchStringSelfConcat } from "../../ir/analysis.js";
import { emitLibraryIdentityLines } from "../library-identity-markers.js";
import type {
  IrBytesElem,
  IrExpr,
  IrFfiCallbackParam,
  IrFfiImport,
  IrFunction,
  IrGlobal,
  IrLocal,
  IrModule,
  IrRecordShape,
  IrStmt,
  IrType,
  IrUnionDef,
  SrcLoc,
} from "../../ir/ir.js";
import { CAUGHT, ffiCallbackType, isFfiContextParam, isRefCounted, isUnitType, moduleEmbedsBuiltin, moduleEmbedsCompressedNpm, moduleUsesDynInvoke, moduleUsesFetch, moduleUsesFsWatch, moduleUsesHttpServer, moduleUsesNet, moduleUsesNodeTest, moduleUsesProcessEvents, moduleUsesStream, moduleUsesTls, moduleUsesTlsCa, NPM_COMPRESS_MIN, POINTER_KINDS, RUNTIME_EMITTER_CLASS, RUNTIME_ERROR_CLASSES, RUNTIME_STREAM_CLASSES, VOID } from "../../ir/ir.js";
import { matchIntegerBytesForLoop } from "../../ir/integer-loops.js";
import { allocateFfiCallbackAdapters, hasForeignFfiCallback, hasRetainedFfiCallback, type FfiCallbackAdapter } from "../ffi-callbacks.js";
import { RUNTIME_ABI_MARKER } from "../runtime-abi.js";
import { computeMayThrow } from "../c/may-throw.js";
import { mangleArgPack, mangleAsyncSpawn, mangleClassObj, mangleFnClosure, mangleFunction, mangleGenDrop, mangleGenSpawn, mangleGlobal, mangleLocal, mangleRecordStruct, mangleTrampoline, mangleWrapper } from "../mangle.js";
import { BlockBuilder } from "./blocks.js";
import { f64Lit, ffiNativeTypeLl } from "./common.js";
import { emitLiteralExpr, emitOperatorExpr, emitStringExpr, emitContainerExpr, emitRecordExpr } from "./expr-primitives.js";
import { emitControlExpr } from "./expr-control.js";
import { emitCallExpr } from "./expr-calls.js";
import { emitDynamicExpr } from "./expr-dynamic.js";
import { emitIntrinsicExpr, emitSerializationExpr, emitAsyncExpr } from "./expr-async.js";
import { emitJsInteropExpr, emitExpr } from "./expr-dispatch.js";
import { emitJsMarshal, emitJsOp, emitJsExit, islandAdapter, islandTypedAdapter } from "./expr-island.js";
import { dynKind, raceAdapterFor, genResultThunkFor, childExitThunkFor, childExitSignalThunkFor, childDataThunkFor, emitterFixedAdapter, wrapEmitterListener, unwrapNullableClosure, closeBindThunkFor, closeOverrideWrapFor } from "./expr-callbacks.js";
import { streamDataAdapter, streamDoneFnFor, fsRenameThunkFor, streamCbThunkFor } from "./expr-stream-callbacks.js";
import { resolveThunkFor, tagInSet, arrPush, emitArrayCopyLoop, emitStrIntrinsic, emitArrIntrinsic, wrapNullable, emitMapNew, mapSet, emitMapLikeIntrinsic, emitSetNew } from "./expr-containers.js";
import { emitBytesReceiver, emitIntegerLoopIndex, emitBytesIndex, emitBytesData, emitBytesLength, emitBytesGet, emitBytesU32, emitBytesSet, emitBytesIntrinsic } from "./expr-bytes.js";
import { emitRegexIntrinsic, emitRecordKeyGet, keyedRecordReadInto } from "./expr-records.js";
import { dynPromiseAdapter, streamTypedRefCommitAdapter, liveDynUnionRefAdapter, streamTypedRefBoxValue, streamTypedRefMaterializeAdapter, streamFromArrayAdapter } from "./expr-stream-bridges.js";
import { emitWebLibCall, emitDynamicLibCall, emitFilesystemLibCall, emitPathUrlLibCall, emitPrimitiveLibCall } from "./lib-filesystem.js";
import { emitChildProcessLibCall, emitAsyncContextLibCall, emitProcessLibCall, emitErrorsEventsLibCall } from "./lib-process.js";
import { emitStreamLibCall } from "./lib-stream.js";
import { emitNetworkHttpLibCall } from "./lib-network.js";
import { emitAssertInspectLibCall, emitIoLibCall, emitGenericLibCall, emitLibCall } from "./lib-dispatch.js";
import {
  buildClassGraph,
  classFieldIndex,
  classStructSym,
  emitClassObjDefs,
  emitClassShapes,
  type LlClassMeta,
} from "./classes.js";
import { LlDyn } from "./dyn.js";
import { LlvmUnsupportedError } from "./unsupported.js";
import { LlWalkers } from "./walkers.js";
import {
  arrNewCall,
  boxAccess,
  boxNewCall,
  computeTraced,
  elemAccess,
  emitRecordShapes,
  FN_ATTRS,
  llFieldType,
  releaseSym,
  retainSym,
  traceArg,
  vAdapters,
} from "./shapes.js";
import type { ExprOf, LibCallExpr, LlStreamTypedRefAdapter, LlStreamTypedRefContext, LlValue, LlvmEmitterContext } from "./expr-context.js";

export { LlvmUnsupportedError } from "./unsupported.js";

interface LlArgPackAndTrampolinePrologue {
  definitions: string[];
  pack: string;
  lifted: boolean;
  fieldTys: string[];
  ret: IrType;
  tr: string[];
  spawnParams: string[];
  argPackLines: string[];
}

function ffiCallbackDummyLl(callback: IrFfiCallbackParam["callback"]): string {
  switch (callback.returns) {
    case "void":
      return "void";
    case "f64":
      return "double 0.0";
    case "bool":
    case "u8":
      return "i8 0";
    case "u32":
    case "i32":
      return "i32 0";
  }
}

interface LlScopeEntry {
  slot: string;
  type: IrType;
  boxed?: boolean;
}

export interface LlvmTargetOptions {
  /** Pointer width of the target C ABI. Native targets are 64-bit today. */
  pointerBits?: 32 | 64;
  /** Select the WASI libc entry-point convention. */
  wasi?: boolean;
  /** Library archive assembly may move the volatile identity getters into a
   * separate translation unit. Public/direct emission keeps them by default. */
  emitLibraryIdentity?: boolean;
  /** Program objects carry a strong reference to the matching runtime ABI
   * marker so manual links against an incompatible runtime fail loudly. */
  runtimeAbiMarker?: boolean;
}

export function emitLlvmModule(mod: IrModule, options: LlvmTargetOptions = {}): string {
  return new LlEmitter(mod, options).emit();
}

/** LLVM c"..." payload for a UTF-8 literal, NUL-terminated like the C
 * emitter's flexible-array-member initializer. */
function llBytes(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) {
    s +=
      b >= 0x20 && b < 0x7f && b !== 0x22 && b !== 0x5c
        ? String.fromCharCode(b)
        : `\\${b.toString(16).padStart(2, "0").toUpperCase()}`;
  }
  return `${s}\\00`;
}

function llStrBytes(text: string): string {
  return llBytes(Buffer.from(text, "utf8"));
}

class LlEmitter {
  readonly sizeType: "i32" | "i64";
  readonly cycleColorOffset: number;
  private readonly wasi: boolean;
  private readonly emitLibraryIdentity: boolean;
  private readonly runtimeAbiMarker: boolean;
  /** Interned string literals: UTF-8 text → { symbol, byte length } —
   * first-use order, the C emitter's determinism discipline. */
  private readonly literals = new Map<string, { sym: string; len: number }>();
  /** Interned unit-armed union instances: "unionId:tag" → symbol — one
   * immortal (rc == SIZE_MAX) static per (union, unit tag), exactly the
   * C emitter's table. RC entry points and the collector skip immortals. */
  private readonly unitInstances = new Map<string, string>();
  /** Interned regex literals: "<flags>/<pattern>" → { symbol, interned
   * source/flags literal refs } — one immortal ScrRegex per distinct
   * (pattern, flags) pair; the bytecode slot starts null and the runtime
   * compiles it lazily on first use. The source/flags strings intern at
   * REGISTRATION (bodies emit before the literal table flushes). */
  private readonly regexInstances = new Map<string, { sym: string; src: string; fl: string }>();
  /** Interned tagged-template strings objects: per-site key → { symbol,
   * interned cooked-literal refs }. One immortal ScrArr of string slots
   * per template SITE (the spec's per-occurrence identity — the C
   * emitter's templateStringsInstances discipline). */
  private readonly templateStringsInstances = new Map<string, { sym: string; slots: string[] }>();
  /** Interned NUL-terminated C-string constants (scr_jb_puts labels, the
   * stringify indent text): UTF-8 text → { symbol, byte length }. */
  private readonly cstrs = new Map<string, { sym: string; len: number }>();
  /** Type-directed walker functions (JSON serializers, the indent
   * rewriter, union ToString/join) — interned per typeKey/unionId, defs
   * flushed with the shape helpers. */
  private readonly walkers = new LlWalkers(this);
  /** The dyn (ScrDyn dyn) helper registry — dyn.ts's interned ports of
   * walkers.ts's dyn slice. */
  private readonly dyn = new LlDyn(this);
  /** External declarations, in first-use order. */
  private readonly decls = new Set<string>();
  /** Declared functions referenced as values: each needs an env-signature
   * wrapper + an interned immortal closure (so `f === f` holds). */
  private readonly fnValues = new Set<string>();
  private needsOom = false;
  private needsBadTag = false;
  private needsBadKey = false;
  private needsRetainBox = false;

  private readonly fnByName = new Map<string, IrFunction>();
  /** Manifest-bound native imports, used by ffiCall emission. */
  private readonly ffiByName = new Map<string, IrFfiImport>();
  /** C-ABI callback trampolines and (for raw/no-userdata callbacks) their
   * distinct call-scoped TLS closure slots. */
  private readonly ffiCallbackAdapters: Map<string, FfiCallbackAdapter>;
  /** Module-level constant consulted per ffiCall: with a retained
   * descriptor anywhere in the manifest, every native call is a
   * pending-exception checkpoint (may-throw derives the same fact from
   * the same helper). */
  private readonly ffiHasRetainedCallback: boolean;
  private readonly ffiHasForeignCallback: boolean;
  private readonly globalTypes = new Map<string, IrType>();
  /** May-throw analysis (the C emitter's computeMayThrow, shared): pending
   * checks are emitted only after calls that can actually raise. */
  private readonly mayThrow: Set<string>;
  private readonly indirectMayThrow: boolean;
  /** Method names with at least one may-throw implementation — the
   * virtualCall pending check's key (CEmitter.mayThrowMethods). */
  private readonly mayThrowMethods = new Set<string>();
  /** setTimeout and friends appeared somewhere: main must run the event
   * loop even in programs with no async functions (CEmitter.usesTimers). */
  private usesTimers = false;
  /** Emitted ref-kind resolve thunks for new Promise, interned per inner
   * typeKey → thunk symbol (CEmitter.resolveThunks). */
  private readonly resolveThunks = new Map<string, string>();
  private readonly resolveThunkDefs: string[] = [];
  /** ReadableStream.from adapters keep typed arrays by reference and box
   * one current element per pull. */
  private readonly streamFromArrayAdapters = new Map<string, string>();
  /** Identity-preserving static→dyn capsules used by Web APIs whose values
   * remain directly observable (stream chunks and AbortSignal reasons). */
  private readonly liveDynRefAdapters = new Map<
    string,
    LlStreamTypedRefAdapter
  >();
  /** Runtime-arm dispatchers for live union values. */
  private readonly liveDynUnionRefAdapters = new Map<string, string>();
  private readonly dynPromiseAdapters = new Map<string, string>();
  readonly unionsById = new Map<string, IrUnionDef>();
  readonly recordsById = new Map<string, IrRecordShape>();
  readonly recordCloneShapes = new Set<string>();
  readonly tracedShapes: Set<string>;
  readonly tracedUnions: Set<string>;
  /** The class graph (buildClassGraph): preorder numbering, hierarchy
   * membership, virtual slot lists — the CEmitter classMeta, ported. */
  private readonly classMeta: Map<string, LlClassMeta>;
  /** Class objects (classes as first-class values): className → the
   * interned .name literal ref — registered during body emission, the
   * statics and construct thunks assemble around the bodies. */
  private readonly classObjs = new Map<string, { nameSym: string }>();
  /** Preorder intervals of the runtime error classes under THIS module's
   * class-forest numbering (main() stamps scr_error_vts with them, exactly
   * like the C emitter's errorVtStampLines). */
  private readonly errorIntervals: { kind: number; pre: number; post: number; lib: string }[] = [];
  /** The runtime emitter vtable's preorder interval, when the program
   * touches node:events (the class def rides the module exactly then) —
   * main() stamps scr_emitter_vt with it (emitterVtStampLines, ported). */
  private emitterInterval: { pre: number; post: number } | null = null;
  /** The runtime stream vtables' preorder intervals (streamVtStampLines,
   * ported): the defs ride every emitter-touching module (the frontend
   * collects the whole emitter-rooted tree), and scr_stream.c links on
   * the same predicate, so the stamps always have their globals. */
  private readonly streamIntervals: { vt: string; pre: number; post: number; lib: string }[] = [];

  // ── per-function state (reset in emitFunction) ─────────────────────────
  private B = new BlockBuilder();
  private frames: LlValue[][] = [];
  private scopes: LlScopeEntry[][] = [];
  /** Enclosing break/continue targets. `kind` separates loops from
   * switches and labeled blocks: an unlabeled break binds to the innermost
   * NON-BLOCK entry (loop or switch — blocks only enter the stack when
   * labeled, and only a labeled break can target one); an unlabeled
   * continue binds to the innermost LOOP; a labeled jump binds to the
   * entry whose `labels` contains its label. `contLabel` is null exactly
   * for blocks and switches. */
  private jumpTargets: {
    kind: "loop" | "block" | "switch";
    brkLabel: string;
    contLabel: string | null;
    labels?: string[];
    frameDepth: number;
    scopeDepth: number;
  }[] = [];
  private currentLocals = new Map<string, IrLocal>();
  private captureIds = new Set<string>();
  /** Active canonical byte-loop induction bindings: local id → size_t slot. */
  private integerLoopBindings = new Map<string, string>();
  /** Enclosing try-with-FINALLY regions, innermost last: a `return`
   * inside one runs every crossed finally (innermost first) before the
   * actual ret — the C emitter's pending-return path, with the finally
   * bodies emitted inline at the return site instead of behind a goto.
   * `tryDepth` snapshots tryStack.length at region entry: a throw inside
   * a pending-return finally copy propagates OUT of the completing try
   * (past its own catch), so the copies emit under the truncated stack.
   * break/continue never cross a finally (frontend fence + validator
   * backstop), so return and the two tryCatch paths are the only copies. */
  private finallyStack: { frameDepth: number; scopeDepth: number; tryDepth: number; body: IrStmt[] }[] = [];
  /** Enclosing try contexts, innermost last — the compile-time unwind
   * targets (CEmitter.tryStack): a pending check or `throw` inside a try
   * releases frames/scopes down to the recorded depths and branches to
   * `label` (the catch, or the exception-path finally) instead of
   * returning out of the function. Entering a try emits no code. */
  private tryStack: { label: string; used: boolean; frameDepth: number; scopeDepth: number }[] = [];
  /** Return type of the function being emitted — the unwind path returns
   * a dummy of this type (never read: callers check the flag first). */
  private currentReturnType: IrType = VOID;
  /** Active only while emitting a wasm32 async body lowered with LLVM's
   * switched-coroutine intrinsics. */
  private currentWasiCoro: {
    kind: "async" | "generator";
    id: string;
    handle: string;
    self: string;
    finalLabel: string;
    cleanupLabel: string;
    suspendLabel: string;
  } | null = null;
  /** The generator channels of the function being emitted (null outside
   * generator bodies): yieldExpr emission reads them, and emitTryCatch's
   * catch prologue emits the GENRET sentinel re-unwind exactly here. */
  private currentGenerator: { yieldT: IrType; nextT: IrType } | null = null;
  /** Active optional-chain bind slots, by chain id (chainRecv reads). */
  private readonly chainSlots = new Map<string, LlValue>();
  private logArgSlots = 0;

  constructor(private readonly mod: IrModule, options: LlvmTargetOptions) {
    this.sizeType = options.pointerBits === 32 ? "i32" : "i64";
    this.wasi = options.wasi === true;
    this.emitLibraryIdentity = options.emitLibraryIdentity !== false;
    this.runtimeAbiMarker = options.runtimeAbiMarker === true;
    // ScrCycHdr is { ptr trace; ptr free; i32 color; i16 buffered;
    // i16 gen; size_t buf_index }. The object follows it, so color is 12
    // bytes behind a wasm32 object and 16 bytes behind a 64-bit object.
    this.cycleColorOffset = options.pointerBits === 32 ? 12 : 16;
    this.ffiCallbackAdapters = allocateFfiCallbackAdapters(mod.ffiImports ?? []);
    this.ffiHasRetainedCallback = hasRetainedFfiCallback(mod.ffiImports ?? []);
    this.ffiHasForeignCallback = hasForeignFfiCallback(mod.ffiImports ?? []);
    for (const fn of mod.functions) this.fnByName.set(fn.name, fn);
    for (const entry of mod.ffiImports ?? []) {
      this.ffiByName.set(entry.name, entry);
    }
    const mt = computeMayThrow(mod);
    this.mayThrow = mt.fns;
    this.indirectMayThrow = mt.indirect;
    for (const cls of mod.classes ?? []) {
      for (const m of cls.methods ?? []) {
        if (this.mayThrow.has(`%${cls.name}.${m}`)) this.mayThrowMethods.add(m);
      }
    }
    for (const u of mod.unions ?? []) this.unionsById.set(u.id, u);
    for (const r of mod.records ?? []) this.recordsById.set(r.id, r);
    const traced = computeTraced(mod);
    this.tracedShapes = traced.shapes;
    this.tracedUnions = traced.unions;
    for (const g of mod.globals ?? []) {
      // Module globals: scalar (f64/bool) storage is a zero-initialized
      // LLVM global, ref-kind storage a null-initialized ptr — load/store
      // like a local, assigned by the %init functions. Refcounted globals
      // are released at the end of main (the C emitter's
      // sc_release_globals), before the RC audit would run.
      try {
        this.llType(g.type); // refuses out-of-tier kinds
      } catch (err) {
        if (err instanceof LlvmUnsupportedError) throw new LlvmUnsupportedError(`global:${g.type.kind}`);
        throw err;
      }
      this.globalTypes.set(g.id, g.type);
    }
    // User classes are IN the tier (phase 3), and so are the runtime
    // error classes and the runtime EventEmitter/stream classes (phase 6
    // — subclasses embed the ScrEmitter/ScrStream prefixes, classes.ts).
    // Anything else runtime-flagged refuses by name, exactly the
    // classDef:* histogram key.
    const classes = mod.classes ?? [];
    for (const cls of classes) {
      if (
        cls.runtime &&
        !RUNTIME_ERROR_CLASSES.has(cls.name) &&
        cls.name !== RUNTIME_EMITTER_CLASS &&
        !RUNTIME_STREAM_CLASSES.has(cls.name)
      ) {
        throw new LlvmUnsupportedError(`classDef:${cls.name}`, cls.loc);
      }
    }
    // The class graph: base/children links, hierarchy membership, the
    // whole-program preorder numbering (identical to CEmitter's, so
    // runtime-made and compiled error objects agree on instanceof through
    // either backend), and the per-hierarchy virtual slot lists.
    this.classMeta = buildClassGraph(mod, this.fnByName);
    for (const [name, rec] of RUNTIME_ERROR_CLASSES) {
      const meta = this.classMeta.get(name);
      if (!meta) break; // hand-written IR without the builtin defs: no stamps
      this.errorIntervals.push({ kind: rec.kind, pre: meta.pre, post: meta.post, lib: rec.lib });
    }
    const emMeta = this.classMeta.get(RUNTIME_EMITTER_CLASS);
    if (emMeta) this.emitterInterval = { pre: emMeta.pre, post: emMeta.post };
    for (const [name, rec] of RUNTIME_STREAM_CLASSES) {
      const meta = this.classMeta.get(name);
      if (!meta) continue;
      this.streamIntervals.push({
        vt: `scr_${rec.lib.toLowerCase()}_vt`,
        pre: meta.pre,
        post: meta.post,
        lib: rec.lib,
      });
    }
  }

  private abiOffset(native64: number, wasm32: number): number {
    return this.sizeType === "i32" ? wasm32 : native64;
  }

  // ── types ───────────────────────────────────────────────────────────────

  private llType(t: IrType): string {
    if (POINTER_KINDS.has(t.kind) && t.kind !== "http2Session" && t.kind !== "http2Stream") return "ptr";
    switch (t.kind) {
      case "f64":
      case "date":
        return "double";
      case "bool":
        return "i1";
      case "procStream":
        // A SCALAR kind: the stream value IS its fd (1 = stdout, 2 =
        // stderr) — no heap, no refcount.
        return "double";
      case "void":
        return "void";
      default:
        throw new LlvmUnsupportedError(`type:${t.kind}`);
    }
  }

  // ── module assembly ─────────────────────────────────────────────────────

  private ffiCallbackAdapter(binding: string, id: string): FfiCallbackAdapter {
    const adapter = this.ffiCallbackAdapters.get(`${binding}:${id}`);
    if (!adapter) throw new InternalCompilerError(`llvm emitter bug: no callback adapter for ${binding}:${id}`);
    return adapter;
  }

  /** C-callable scalar callback trampolines. A callback with an explicit
   * context entry receives the closure at that exact ABI position. A raw
   * callback loads it from a call-scoped TLS slot installed around the
   * outer native call. */
  private emitFfiCallbackDefs(): { globals: string[]; defs: string[] } {
    const globals: string[] = [];
    const defs: string[] = [];
    if (this.ffiCallbackAdapters.size === 0) return { globals, defs };
    this.declare(`declare zeroext i1 @scr_exc_pending()`);
    this.declare(`declare void @scr_trap(ptr)`);
    const expired = this.cstr("scriptc: native callback invoked outside its call-scoped lifetime\n");
    const released = this.cstr("scriptc: native callback invoked outside its retained lifetime\n");
    for (const adapter of this.ffiCallbackAdapters.values()) {
      const cb = adapter.callback;
      if (adapter.tls !== null) globals.push(`@${adapter.tls} = internal thread_local global ptr null`);
      if (adapter.global !== null) globals.push(`@${adapter.global} = internal global ptr null`);
      if (adapter.table !== null) {
        globals.push(`@${adapter.table} = internal global %ScrFfiTable zeroinitializer`);
      }
      const params = cb.params.flatMap((param, i): string[] => {
        if (isFfiContextParam(param)) return [`ptr %ctx`];
        if (param === "string" || param === "bytes") {
          return [`ptr %a${i}`, `${this.sizeType} %a${i}_len`];
        }
        return [`${ffiNativeTypeLl(param)} %a${i}`];
      });
      const ret = ffiNativeTypeLl(cb.returns);
      if (cb.invoke === "foreign") {
        if (adapter.table === null || !cb.params.some(isFfiContextParam) || cb.returns !== "void") {
          throw new InternalCompilerError("llvm emitter bug: invalid foreign FFI callback descriptor");
        }
        const dispatch = `${adapter.symbol}_dispatch`;
        const scriptArgs: string[] = [];
        const dispatchBody: string[] = [
          `define internal void @${dispatch}(ptr %cb, ptr %call) ${FN_ATTRS} {`,
          `entry:`,
          `  %fnp = getelementptr inbounds %ScrClosure, ptr %cb, i64 0, i32 1`,
          `  %fn = load ptr, ptr %fnp`,
        ];
        for (let i = 0; i < cb.params.length; i++) {
          const param = cb.params[i]!;
          if (isFfiContextParam(param)) continue;
          switch (param) {
            case "f64":
              this.declare(`declare double @scr_ffi_call_get_f64(ptr, ${this.sizeType})`);
              dispatchBody.push(`  %s${i} = call double @scr_ffi_call_get_f64(ptr %call, ${this.sizeType} ${i})`);
              scriptArgs.push(`double %s${i}`);
              break;
            case "bool":
              this.declare(`declare zeroext i1 @scr_ffi_call_get_bool(ptr, ${this.sizeType})`);
              dispatchBody.push(`  %s${i} = call zeroext i1 @scr_ffi_call_get_bool(ptr %call, ${this.sizeType} ${i})`);
              scriptArgs.push(`i1 %s${i}`);
              break;
            case "u8":
            case "u32":
            case "i32":
              this.declare(`declare double @scr_ffi_call_get_${param}(ptr, ${this.sizeType})`);
              dispatchBody.push(`  %s${i} = call double @scr_ffi_call_get_${param}(ptr %call, ${this.sizeType} ${i})`);
              scriptArgs.push(`double %s${i}`);
              break;
            case "cstring":
            case "string":
            case "bytes": {
              this.declare(`declare ptr @scr_ffi_call_get_data(ptr, ${this.sizeType})`);
              this.declare(`declare ${this.sizeType} @scr_ffi_call_get_len(ptr, ${this.sizeType})`);
              dispatchBody.push(
                `  %data${i} = call ptr @scr_ffi_call_get_data(ptr %call, ${this.sizeType} ${i})`,
                `  %len${i} = call ${this.sizeType} @scr_ffi_call_get_len(ptr %call, ${this.sizeType} ${i})`,
              );
              if (param === "bytes") {
                this.declare(`declare ptr @scr_bytes_from_data(ptr, ${this.sizeType})`);
                dispatchBody.push(`  %s${i} = call ptr @scr_bytes_from_data(ptr %data${i}, ${this.sizeType} %len${i})`);
              } else {
                this.declare(`declare ptr @scr_str_from_utf8_lossy(ptr, ${this.sizeType})`);
                dispatchBody.push(`  %s${i} = call ptr @scr_str_from_utf8_lossy(ptr %data${i}, ${this.sizeType} %len${i})`);
              }
              scriptArgs.push(`ptr %s${i}`);
              break;
            }
          }
        }
        dispatchBody.push(
          `  call void %fn(${[`ptr %cb`, ...scriptArgs].join(", ")})`,
          `  ret void`,
          `}`,
          ``,
        );
        defs.push(...dispatchBody);

        this.declare(`declare ptr @scr_ffi_call_new(ptr, ptr, ptr, ${this.sizeType})`);
        this.declare(`declare void @scr_ffi_post(ptr)`);
        defs.push(
          `define internal void @${adapter.symbol}(${params.join(", ")}) ${FN_ATTRS} {`,
          `entry:`,
          `  %cb = getelementptr inbounds i8, ptr %ctx, i64 0`,
          `  %call = call ptr @scr_ffi_call_new(ptr @${adapter.table}, ptr %cb, ptr @${dispatch}, ${this.sizeType} ${cb.params.length})`,
        );
        for (let i = 0; i < cb.params.length; i++) {
          const param = cb.params[i]!;
          if (isFfiContextParam(param)) continue;
          if (param === "cstring") {
            this.declare(`declare void @scr_ffi_call_copy_cstring(ptr, ${this.sizeType}, ptr)`);
            defs.push(`  call void @scr_ffi_call_copy_cstring(ptr %call, ${this.sizeType} ${i}, ptr %a${i})`);
          } else if (param === "string" || param === "bytes") {
            this.declare(`declare void @scr_ffi_call_copy_${param}(ptr, ${this.sizeType}, ptr, ${this.sizeType})`);
            defs.push(`  call void @scr_ffi_call_copy_${param}(ptr %call, ${this.sizeType} ${i}, ptr %a${i}, ${this.sizeType} %a${i}_len)`);
          } else {
            const nativeTy = ffiNativeTypeLl(param);
            this.declare(`declare void @scr_ffi_call_set_${param}(ptr, ${this.sizeType}, ${nativeTy})`);
            defs.push(`  call void @scr_ffi_call_set_${param}(ptr %call, ${this.sizeType} ${i}, ${nativeTy} %a${i})`);
          }
        }
        defs.push(`  call void @scr_ffi_post(ptr %call)`, `  ret void`, `}`, ``);
        continue;
      }
      defs.push(
        `define internal ${ret} @${adapter.symbol}(${params.join(", ")}) ${FN_ATTRS} {`,
        `entry:`,
        adapter.tls !== null
          ? `  %cb = load ptr, ptr @${adapter.tls}`
          : adapter.global !== null
            ? `  %cb = load ptr, ptr @${adapter.global}`
            : `  %cb = getelementptr inbounds i8, ptr %ctx, i64 0`,
        `  %missing = icmp eq ptr %cb, null`,
        `  br i1 %missing, label %expired, label %ready`,
        `expired:`,
        `  call void @scr_trap(ptr ${adapter.callback.lifetime === "call" ? expired : released})`,
        `  unreachable`,
        `ready:`,
        `  %pending = call zeroext i1 @scr_exc_pending()`,
        `  br i1 %pending, label %skip, label %invoke`,
        `skip:`,
        `  ret ${ffiCallbackDummyLl(cb)}`,
        `invoke:`,
      );
      // Validate every native pointer before allocating any copy-in value.
      // A later bad slot therefore cannot leak an earlier materialization.
      for (let i = 0; i < cb.params.length; i++) {
        const param = cb.params[i]!;
        if (param !== "cstring" && param !== "string" && param !== "bytes") continue;
        const invalid = `%invalid${i}`;
        defs.push(`  %null${i} = icmp eq ptr %a${i}, null`);
        if (param === "cstring") {
          defs.push(`  ${invalid} = or i1 %null${i}, false`);
        } else {
          defs.push(
            `  %nonempty${i} = icmp ne ${this.sizeType} %a${i}_len, 0`,
            `  ${invalid} = and i1 %null${i}, %nonempty${i}`,
          );
        }
        const message = param === "cstring"
          ? "scriptc: native callback passed a NULL cstring\n"
          : `scriptc: native callback passed a NULL ${param} span with nonzero length\n`;
        defs.push(
          `  br i1 ${invalid}, label %invalid_param${i}, label %param_ok${i}`,
          `invalid_param${i}:`,
          `  call void @scr_trap(ptr ${this.cstr(message)})`,
          `  unreachable`,
          `param_ok${i}:`,
        );
      }
      defs.push(
        `  %fnp = getelementptr inbounds %ScrClosure, ptr %cb, i64 0, i32 1`,
        `  %fn = load ptr, ptr %fnp`,
      );
      const scriptArgs: string[] = [];
      for (let i = 0; i < cb.params.length; i++) {
        const param = cb.params[i]!;
        if (isFfiContextParam(param)) continue;
        switch (param) {
          case "f64":
            scriptArgs.push(`double %a${i}`);
            break;
          case "bool":
            defs.push(`  %s${i} = icmp ne i8 %a${i}, 0`);
            scriptArgs.push(`i1 %s${i}`);
            break;
          case "u8":
            defs.push(`  %s${i} = uitofp i8 %a${i} to double`);
            scriptArgs.push(`double %s${i}`);
            break;
          case "u32":
            defs.push(`  %s${i} = uitofp i32 %a${i} to double`);
            scriptArgs.push(`double %s${i}`);
            break;
          case "i32":
            defs.push(`  %s${i} = sitofp i32 %a${i} to double`);
            scriptArgs.push(`double %s${i}`);
            break;
          case "cstring":
            this.declare(`declare ${this.sizeType} @strlen(ptr)`);
            this.declare(`declare ptr @scr_str_from_utf8_lossy(ptr, ${this.sizeType})`);
            defs.push(
              `  %len${i} = call ${this.sizeType} @strlen(ptr %a${i})`,
              `  %s${i} = call ptr @scr_str_from_utf8_lossy(ptr %a${i}, ${this.sizeType} %len${i})`,
            );
            scriptArgs.push(`ptr %s${i}`);
            break;
          case "string":
            this.declare(`declare ptr @scr_str_from_utf8_lossy(ptr, ${this.sizeType})`);
            defs.push(
              `  %s${i} = call ptr @scr_str_from_utf8_lossy(ptr %a${i}, ${this.sizeType} %a${i}_len)`,
            );
            scriptArgs.push(`ptr %s${i}`);
            break;
          case "bytes":
            this.declare(`declare ptr @scr_bytes_from_data(ptr, ${this.sizeType})`);
            defs.push(
              `  %s${i} = call ptr @scr_bytes_from_data(ptr %a${i}, ${this.sizeType} %a${i}_len)`,
            );
            scriptArgs.push(`ptr %s${i}`);
            break;
        }
      }
      const ft = ffiCallbackType(cb);
      const internalRet = this.llType(ft.ret);
      const callArgs = [`ptr %cb`, ...scriptArgs].join(", ");
      if (cb.lifetime === "retained") {
        this.declare(`declare ptr @scr_closure_retain_v(ptr)`);
        this.declare(`declare void @scr_closure_release_v(ptr)`);
        defs.push(`  %invoke_pin = call ptr @scr_closure_retain_v(ptr %cb)`);
      }
      if (cb.returns === "void") {
        defs.push(
          `  call void %fn(${callArgs})`,
          ...(cb.lifetime === "retained" ? [`  call void @scr_closure_release_v(ptr %invoke_pin)`] : []),
          `  ret void`,
          `}`,
          ``,
        );
        continue;
      }
      defs.push(`  %result = call ${internalRet} %fn(${callArgs})`);
      if (cb.lifetime === "retained") {
        defs.push(`  call void @scr_closure_release_v(ptr %invoke_pin)`);
      }
      switch (cb.returns) {
        case "f64":
          defs.push(`  ret double %result`);
          break;
        case "bool":
          defs.push(`  %out = zext i1 %result to i8`, `  ret i8 %out`);
          break;
        case "u8":
        case "u32":
          this.declare(`declare double @scr_bit_ushr(double, double)`);
          defs.push(
            `  %coerced = call double @scr_bit_ushr(double %result, double ${f64Lit(0)})`,
            `  %wide = fptoui double %coerced to i32`,
          );
          if (cb.returns === "u8") {
            defs.push(`  %out = trunc i32 %wide to i8`, `  ret i8 %out`);
          } else {
            defs.push(`  ret i32 %wide`);
          }
          break;
        case "i32":
          this.declare(`declare double @scr_bit_or(double, double)`);
          defs.push(
            `  %coerced = call double @scr_bit_or(double %result, double ${f64Lit(0)})`,
            `  %out = fptosi double %coerced to i32`,
            `  ret i32 %out`,
          );
          break;
      }
      defs.push(`}`, ``);
    }
    return { globals, defs };
  }

  emit(): string {
    // Function bodies first (the literal/unit/fn-value tables fill as they
    // emit), then the file assembles around them — the C emitter's order.
    const fnDefs: string[] = [];
    for (const fn of this.mod.functions) fnDefs.push(this.emitFunction(fn));
    const shapes = emitRecordShapes(this, this.mod);
    const classShapes = emitClassShapes(this, this.mod, this.classMeta);
    const classObjDefs = emitClassObjDefs(this, this.classMeta, this.classObjs, this.fnByName, (t) => this.llType(t));
    const wrappers = this.emitFnValueDefs();
    const asyncDefs = this.emitAsyncScaffolding();
    const ffiCallbacks = this.emitFfiCallbackDefs();
    const hasNoInlineRecordClone = [...this.recordCloneShapes].some(
      (shapeId) => (this.recordsById.get(shapeId)?.fields.length ?? 0) >= 16,
    );
    const embedded = this.mod.embedded;
    const usesIsland = embedded !== undefined && embedded.modules.length > 0;
    const storeNpmText = (text: string): { bytes: Buffer; raw: number } => {
      const plain = Buffer.from(text, "utf8");
      if (text.length < NPM_COMPRESS_MIN) return { bytes: plain, raw: 0 };
      const deflated = deflateRawSync(plain, { level: 9 });
      return deflated.length < plain.length
        ? { bytes: deflated, raw: plain.length }
        : { bytes: plain, raw: 0 };
    };
    const npmStored = usesIsland
      ? embedded.modules.map((m) => ({
          src: storeNpmText(m.source),
          esm: m.esm === undefined ? null : storeNpmText(m.esm),
        }))
      : [];

    // Module globals, FIRST OCCURRENCE per id: a class-expression static
    // instantiated through several mixin applications registers one global
    // id several times (2041-mixin-values) — C's tentative definitions
    // absorb the duplicates silently, LLVM rejects redefinition, so the
    // storage AND the release emit once per id here.
    const seenGlobalIds = new Set<string>();
    const globals = (this.mod.globals ?? []).filter((g) => {
      if (seenGlobalIds.has(g.id)) return false;
      seenGlobalIds.add(g.id);
      return true;
    });
    // Refcounted globals release before main returns — the C emitter's
    // sc_release_globals, keeping the RC audit's live count exact. Built
    // before the declaration table flushes (it adds the release symbols).
    // Two spellings with distinct temp names: the normal exit and the
    // uncaught-exception exit are separate blocks of the same function.
    // Interned function-value closures are IMMORTAL (rc == SIZE_MAX), so
    // an own-property table Object.defineProperties hung on one would
    // outlive the RC audit — release it with the globals (the C emitter's
    // sc_release_globals tail). Only when the dispatch unit is even
    // linked (defineProps is the only writer).
    const fnValueProps = moduleUsesDynInvoke(this.mod) ? [...this.fnValues] : [];
    if (fnValueProps.length > 0) this.declare(`declare void @scr_box_release(ptr)`);
    const globalReleaseLines = (prefix: string): string[] => {
      const lines: string[] = [];
      globals.forEach((g, i) => {
        if (!isRefCounted(g.type)) return;
        lines.push(
          `  %${prefix}${i} = load ptr, ptr @${mangleGlobal(g.id)}`,
          `  call void ${releaseSym(this, g.type)}(ptr %${prefix}${i}) ; ${g.name}`,
        );
      });
      fnValueProps.forEach((name, i) => {
        // props sits at %ScrClosure field 3; release is NULL-tolerant —
        // cleared so a second release path stays idempotent.
        lines.push(
          `  %${prefix}fp${i} = load ptr, ptr getelementptr inbounds (%ScrClosure, ptr @${mangleFnClosure(name)}, i64 0, i32 3)`,
          `  call void @scr_box_release(ptr %${prefix}fp${i}) ; ${name}.props`,
          `  store ptr null, ptr getelementptr inbounds (%ScrClosure, ptr @${mangleFnClosure(name)}, i64 0, i32 3)`,
        );
      });
      return lines;
    };
    // Exit listeners can read MODULE GLOBALS directly, so they must run
    // BEFORE the global releases (the C emitter's runExitListeners
    // ordering — the atexit half becomes an idempotent no-op).
    const usesEvents = moduleUsesProcessEvents(this.mod);
    const usesFsWatch = moduleUsesFsWatch(this.mod);
    // Stream-surface programs fill the loop's stream hook (the deferred
    // next-tick emissions) and the emitter's post-registration flow kick
    // before %main — scr_stream.c links only when the line is emitted
    // (native-toolchain.ts gates on the same predicate).
    const usesStream = moduleUsesStream(this.mod);
    // Net-surface programs fill the loop's net hooks (and the netSocket
    // handle-dispatch ops for the checked-dynamic boundary); http-surface
    // programs additionally stamp the httpReq/httpRes ops — the C main's
    // install lines, gated on the same predicates native-toolchain.ts links by.
    const usesNet = moduleUsesNet(this.mod);
    const usesHttp = moduleUsesHttpServer(this.mod);
    // Fetch-referencing programs register the native fetch bridge before
    // any island entry (the engine's lazy boot consults it) — native-toolchain.ts
    // compiles scr_fetch.c on the same predicate.
    const usesFetch = moduleUsesFetch(this.mod);
    const embedsZlib = moduleEmbedsBuiltin(this.mod, "node:zlib");
    const embedsNet =
      moduleEmbedsBuiltin(this.mod, "node:http") ||
      moduleEmbedsBuiltin(this.mod, "node:https") ||
      moduleEmbedsBuiltin(this.mod, "node:net") ||
      moduleEmbedsBuiltin(this.mod, "node:tls");
    const snapshotsTlsCa =
      moduleUsesTls(this.mod) || moduleUsesTlsCa(this.mod) ||
      moduleEmbedsBuiltin(this.mod, "node:https") ||
      moduleEmbedsBuiltin(this.mod, "node:tls");
    // The process verdict has the same precedence as the C reference
    // emitter: node:test owns the final status when present; otherwise an
    // embedded process.exitCode owns it; ordinary programs return zero.
    const usesNodeTest = moduleUsesNodeTest(this.mod);
    const programExitUsesIsland = !usesNodeTest && usesIsland;
    // Declared NOW — the extern block flushes before main assembles.
    if (usesEvents) this.declare(`declare void @scr_events_install()`);
    if (usesFsWatch) this.declare(`declare void @scr_watch_install()`);
    if (this.ffiHasForeignCallback) this.declare(`declare void @scr_ffi_install()`);
    if (usesStream) this.declare(`declare void @scr_stream_install()`);
    if (usesNet) {
      this.declare(`declare void @scr_net_install()`);
      this.declare(`declare void @scr_net_dyn_install()`);
    }
    if (usesHttp) this.declare(`declare void @scr_http_dyn_install()`);
    if (usesFetch) this.declare(`declare void @scr_fetch_install()`);
    if (embedsZlib) this.declare(`declare void @scr_zlib_island_install()`);
    if (embedsNet) this.declare(`declare void @scr_net_island_install()`);
    if (usesIsland) {
      this.declare(`declare void @scr_island_modules(ptr, ${this.sizeType}, ptr, ${this.sizeType})`);
      this.declare(`declare i32 @scr_island_exit_code()`);
      if (moduleEmbedsCompressedNpm(this.mod)) {
        this.declare(`declare void @scr_island_set_inflate(ptr)`);
        this.declare(`declare zeroext i1 @scr_zlib_inflate_exact(ptr, ${this.sizeType}, ptr, ${this.sizeType})`);
      }
    }
    if (usesNodeTest) this.declare(`declare i32 @scr_test_exit_code()`);
    if (snapshotsTlsCa) {
      this.declare(`declare void @scr_tls_ca_install()`);
    }
    // Inline exit listeners run when something they must beat exists:
    // the refcounted-global releases, or the retained-FFI atexit ledger
    // sweep (a listener may legitimately release or pump a registration,
    // and only the inline call orders ahead of every atexit handler —
    // the C emitter's runExitListeners stance). Plain event programs
    // with neither keep the atexit path, so their listener timing is
    // unchanged.
    const hasRefGlobals = globals.some((g) => isRefCounted(g.type)) || fnValueProps.length > 0;
    const inlineExitListeners = usesEvents && (hasRefGlobals || this.ffiHasRetainedCallback);
    if (inlineExitListeners) {
      this.declare(`declare void @scr_run_exit_listeners(double)`);
      this.declare(`declare i32 @scr_exit_code_hint_get()`);
    }
    const exitListenerLines = (prefix: string): string[] => {
      if (!inlineExitListeners) return [];
      return [
        `  %${prefix}h = call i32 @scr_exit_code_hint_get()`,
        `  %${prefix}hd = sitofp i32 %${prefix}h to double`,
        `  call void @scr_run_exit_listeners(double %${prefix}hd)`,
      ];
    };
    const globalReleases = globalReleaseLines("g");
    const asyncEntry = this.fnByName.get(this.mod.entry)?.async === true;
    const entryMayThrow = this.mayThrow.has(this.mod.entry);
    // The event loop runs when timers appeared OR any async/generator
    // function exists (the C main's hasAsync || hasGenerators ||
    // usesTimers gate). Generator programs run
    // the loop too: its exit accounting notes still-suspended generator
    // fibers as abandoned, so the RC audit downgrades exactly like the
    // async loop-exhaustion story.
    const runsLoop =
      this.usesTimers ||
      usesIsland ||
      this.ffiHasForeignCallback ||
      this.mod.functions.some((f) => f.async === true || f.generator !== undefined);
    const uncaughtReleases = entryMayThrow && !asyncEntry ? globalReleaseLines("gu") : [];
    const loopReleasesU = runsLoop ? globalReleaseLines("gl") : [];
    const loopReleasesR = runsLoop ? globalReleaseLines("gr") : [];
    const topRejectReleases = asyncEntry ? globalReleaseLines("gt") : [];
    const topPendingReleases = asyncEntry ? globalReleaseLines("gp") : [];
    const loopReportedReleases = runsLoop ? globalReleaseLines("gq") : [];
    // main's epilogues read the flag / the loop entry points — declared
    // HERE, before the extern block flushes (a pending check usually
    // declared the flag already; the Set dedupes).
    if (entryMayThrow || runsLoop) this.declare(`declare zeroext i1 @scr_exc_pending()`);
    if (runsLoop) {
      this.declare(`declare zeroext i1 @scr_loop_run(ptr)`);
      this.declare(`declare zeroext i1 @scr_report_unhandled_rejections()`);
      this.declare(`declare void @scr_discard_unhandled_rejections()`);
    }
    if (asyncEntry) {
      this.declare(`declare i32 @scr_promise_finish_top_level(ptr)`);
      this.declare(`declare void @scr_promise_rethrow_top_level(ptr)`);
      this.declare(`declare void @scr_promise_release(ptr)`);
      this.declare(`declare void @scr_exit_code_note(i32)`);
      if (programExitUsesIsland && inlineExitListeners) {
        this.declare(`declare ${this.sizeType} @scr_island_exit_code_version()`);
      }
    }
    const topPendingExitLines = (): string[] => {
      if (!asyncEntry) return [];
      const lines: string[] = [];
      if (usesNodeTest) {
        lines.push(`  %tla_program_exit = call i32 @scr_test_exit_code()`);
      } else if (usesIsland) {
        lines.push(`  %tla_program_exit = call i32 @scr_island_exit_code()`);
      }
      if (usesNodeTest || usesIsland) {
        lines.push(
          `  %tla_program_exit_zero = icmp eq i32 %tla_program_exit, 0`,
          `  %tla_exit_status = select i1 %tla_program_exit_zero, i32 %tla_status, i32 %tla_program_exit`,
        );
      }
      const exitStatus = usesNodeTest || usesIsland ? "%tla_exit_status" : "%tla_status";
      const tracksIslandExit = programExitUsesIsland && inlineExitListeners;
      if (tracksIslandExit) {
        lines.push(`  %tla_exit_version = call ${this.sizeType} @scr_island_exit_code_version()`);
      }
      // finish_top_level initially notes 13. Replace that hint before exit
      // listeners run when a higher-priority verdict was already selected.
      lines.push(`  call void @scr_exit_code_note(i32 ${exitStatus})`);
      lines.push(...exitListenerLines("xp"));
      if (tracksIslandExit) {
        lines.push(
          `  %tla_exit_version_after = call ${this.sizeType} @scr_island_exit_code_version()`,
          `  %tla_exit_changed = icmp ne ${this.sizeType} %tla_exit_version_after, %tla_exit_version`,
          `  br i1 %tla_exit_changed, label %tla_exit_updated, label %tla_exit_unchanged`,
          `tla_exit_updated:`,
          `  %tla_listener_exit = call i32 @scr_island_exit_code()`,
          `  call void @scr_exit_code_note(i32 %tla_listener_exit)`,
          `  br label %tla_exit_done`,
          `tla_exit_unchanged:`,
          `  br label %tla_exit_done`,
          `tla_exit_done:`,
          `  %tla_final_exit = phi i32 [ %tla_listener_exit, %tla_exit_updated ], [ ${exitStatus}, %tla_exit_unchanged ]`,
        );
      }
      lines.push(...topPendingReleases);
      lines.push(`  ret i32 ${tracksIslandExit ? "%tla_final_exit" : exitStatus}`);
      return lines;
    };
    // LIBRARY mode: the runtime entry points the generated library
    // symbols delegate to — declared before the extern block flushes.
    if (this.mod.lib !== undefined) {
      this.declare(`declare void @scr_library_entry(i1 zeroext, ptr)`);
      this.declare(`declare void @scr_library_reset()`);
      this.declare(`declare void @scr_library_check_exc()`);
      this.declare(`declare void @scr_library_set_sink(ptr, ptr)`);
      this.declare(`declare void @scr_library_callback_entry_guard(ptr)`);
      this.declare(`declare void @scr_library_arena_reset()`);
      this.declare(`declare void @scr_library_collect()`);
      if (this.mod.lib.drainSymbol !== null) {
        this.declare(`declare i1 @scr_drain_jobs()`);
      }
      if ((this.mod.lib.callbacks?.length ?? 0) > 0) {
        // Host-callback channels: the registration define's dispatch
        // (strcmp over the declared names + the runtime slot store).
        // The call-site fetch pair (scr_library_cb_require/_ctx) is
        // declared at ffiCall emission like every body-driven runtime
        // symbol.
        this.declare(`declare void @scr_library_cb_set(${this.sizeType}, ptr, ptr)`);
        this.declare(`declare i32 @strcmp(ptr, ptr)`);
      }
      if (this.mod.lib.exports.some((e) => e.params.includes("string"))) {
        this.declare(`declare ptr @scr_library_str_in(ptr, ${this.sizeType})`);
      }
      if (this.mod.lib.exports.some((e) => e.params.includes("bytes"))) {
        this.declare(`declare ptr @scr_library_bytes_in(ptr, ${this.sizeType}, ptr)`);
      }
      if (this.mod.lib.exports.some((e) => e.params.includes("i64"))) {
        this.declare(`declare double @scr_library_i64_in(i64, ptr)`);
      }
      if (this.mod.lib.exports.some((e) => e.params.includes("u64"))) {
        this.declare(`declare double @scr_library_u64_in(i64, ptr)`);
      }
      if (this.mod.lib.exports.some((e) => e.returns === "string")) {
        this.declare(`declare void @scr_library_str_out(ptr, ptr, ptr)`);
      }
      if (this.mod.lib.exports.some((e) => e.returns === "bytes")) {
        this.declare(`declare void @scr_library_bytes_out(ptr, ptr, ptr)`);
      }
    }
    // Helpers assemble BEFORE the declaration table flushes (they add
    // write/abort declarations).
    const helpers = this.helperDefs();

    const out: string[] = [
      `; Generated by scriptc (LLVM backend) from ${this.mod.sourceFile}. Do not edit.`,
      ``,
      // Type shapes shared with the runtime's C ABI. ScrStr is the header
      // prefix only (the flexible-array tail is concrete per literal);
      // ScrLogArg is { i32 tag; 8-byte union } — i64 at offset 8 matches
      // the C layout (4 bytes padding after the tag). ScrUnion/ScrClosure
      // mirror scr_runtime.h field-for-field (tag reads, slot peeks, the
      // fn pointer, and the caps[] tail all address through them).
      `%ScrStr = type { ${this.sizeType}, ${this.sizeType}, ${this.sizeType} }`,
      `%ScrLogArg = type { i32, i64 }`,
      `%ScrVt = type { ${this.sizeType}, ${this.sizeType}, ptr }`,
      `%ScrUnion = type { ${this.sizeType}, i32, ptr, ptr, ptr, i64 }`,
      `%ScrClosure = type { ${this.sizeType}, ptr, ${this.sizeType}, ptr }`,
      `%ScrFfiTable = type { ptr, ${this.sizeType}, ${this.sizeType}, ptr, i8, ptr, ptr, ${this.sizeType}, ${this.sizeType}, ${this.sizeType}, ptr, ptr }`,
      `%ScrRegex = type { ${this.sizeType}, ptr, ptr, ptr }`,
      // ScrArr mirror { rc, len, cap, elem(i32+pad), elem_retain,
      // elem_release, elem_trace, data } — the immortal tagged-template
      // strings objects lay out through it (nothing GEPs into live heap
      // arrays; those stay behind the runtime's own entry points).
      `%ScrArr = type { ${this.sizeType}, ${this.sizeType}, ${this.sizeType}, i32, ptr, ptr, ptr, ptr }`,
      // The runtime error prefix { rc, vt, name, message, code } and the
      // class-object shape { rc, pre, post, ctor, name } — field reads on
      // builtin errors and classval loads GEP through these.
      `%ScrError = type { ${this.sizeType}, ptr, ptr, ptr, ptr }`,
      `%ScrClassObj = type { ${this.sizeType}, ${this.sizeType}, ${this.sizeType}, ptr, ptr }`,
      // The runtime emitter prefix { rc, vt, reg, cls } — user subclasses
      // embed it (classes.ts), and bare-emitter GEPs address through it.
      `%ScrEmitter = type { ${this.sizeType}, ptr, ptr, ptr }`,
      // The runtime stream layout { rc, vt, reg, cls, st } — one struct
      // for all five stream classes; stream subclasses embed it.
      `%ScrStream = type { ${this.sizeType}, ptr, ptr, ptr, ptr }`,
      // The catch-binding snapshot box { rc, kind, f64, b, payload,
      // retain_fn, release_fn, trace_fn } — caughtTest kind reads and
      // caughtNarrow payload extraction GEP through it (offsets match
      // scr_runtime.h's natural alignment: kind at 8, f64 at 16, b at 24,
      // payload at 32).
      `%ScrCaught = type { ${this.sizeType}, i32, double, i8, ptr, ptr, ptr, ptr }`,
      // ScrBytes { rc, len, elem(i32+pad), data, backing }. Indexed
      // typed-array access GEPs through this directly: the IR type already
      // fixes elem, so the hot path needs neither a runtime kind load nor
      // the generic scr_bytes_get/set call.
      `%ScrBytes = type { ${this.sizeType}, ${this.sizeType}, i32, ptr, ptr }`,
      // The capture box { rc, kind, obj_retain, obj_release, obj_trace,
      // slot } — TDZ reads peek the payload slot (offset 40) directly.
      `%ScrBox = type { ${this.sizeType}, i32, ptr, ptr, ptr, i64 }`,
      // The stack buffer of the emitted JSON serializers { data, len, cap }.
      `%ScrJsonBuf = type { ptr, ${this.sizeType}, ${this.sizeType}, ptr, ${this.sizeType}, ${this.sizeType} }`,
      // The dynCheck error-path spine { parent, key, index } — the emitted
      // builders stack-allocate one per recursion level (dyn.ts).
      `%ScrDynPath = type { ptr, ptr, ${this.sizeType} }`,
      `%ScrIslandModule = type { ptr, ptr, ${this.sizeType}, ${this.sizeType}, i32, ptr, ${this.sizeType}, ${this.sizeType} }`,
      `%ScrIslandEdge = type { ptr, ptr, ptr, i32 }`,
    ];
    out.push(...shapes.typeDefs);
    out.push(...classShapes.typeDefs);
    // Thread-instanced library state (abi.instance_per_thread): the
    // program TU's mutable globals — module globals, run-once guards, the
    // lazily-compiled regex literal caches — and the runtime globals its
    // init stamps live in thread-local storage, matching the runtime
    // objects compiled with -DSCR_THREAD_INSTANCES. Immutable interned
    // data (string literals, unit arms, template arrays, vtables) stays
    // shared.
    const tl = this.mod.lib?.threadInstances === true ? "thread_local " : "";
    out.push(
      ``,
      `@scr_error_vts = external ${tl}global [5 x %ScrVt]`,
      `declare void @scr_init()`,
      `declare void @scr_lib_init(i32, ptr)`,
      ...(this.runtimeAbiMarker && this.mod.lib === undefined
        ? [`declare void @${RUNTIME_ABI_MARKER}()`]
        : []),
    );
    for (const d of this.decls) out.push(d);
    out.push(``);
    for (const [text, lit] of this.literals) {
      // Immortal interned ScrStr: { rc = SIZE_MAX, len, cap = len, bytes\0 } —
      // the C emitter's static table, retain/release skip rc == SIZE_MAX.
      out.push(
        `@${lit.sym} = internal global { ${this.sizeType}, ${this.sizeType}, ${this.sizeType}, [${lit.len + 1} x i8] } ` +
          `{ ${this.sizeType} -1, ${this.sizeType} ${lit.len}, ${this.sizeType} ${lit.len}, [${lit.len + 1} x i8] c"${llStrBytes(text)}" }`,
      );
    }
    if (this.literals.size > 0) out.push(``);
    for (const [key, sym] of this.unitInstances) {
      // One immortal instance per unit-armed (union, tag): tag set, payload
      // slot and RC entry points zero — retain/release/collector all skip
      // rc == SIZE_MAX, so these never join the RC audit or a trace walk.
      const [unionId, tag] = key.split(":");
      out.push(
        `@${sym} = internal global %ScrUnion { ${this.sizeType} -1, i32 ${tag}, ptr null, ptr null, ptr null, i64 0 } ; ${unionId} unit arm`,
      );
    }
    if (this.unitInstances.size > 0) out.push(``);
    for (const [key, re] of this.regexInstances) {
      // One immortal ScrRegex per (pattern, flags) literal, pointing at
      // the interned source/flags strings. The bc slot starts null (lazy
      // compile, cached by the runtime) — a mutable global, not constant.
      out.push(
        `@${re.sym} = internal ${tl}global %ScrRegex { ${this.sizeType} -1, ptr ${re.src}, ptr ${re.fl}, ptr null } ; ${key.replace(/\n/g, "\\n")}`,
      );
    }
    if (this.regexInstances.size > 0) out.push(``);
    for (const [, inst] of this.templateStringsInstances) {
      // One immortal ScrArr per tagged-template site: a [N x ptr] data
      // global of interned cooked-string literals, and the ScrArr header
      // over it (rc == SIZE_MAX, len == cap, SCR_ELEM_STR = 2, no REF
      // entry points). Reads retain immortal strings — a no-op.
      const n = inst.slots.length;
      out.push(
        `@${inst.sym}_data = internal constant [${n} x ptr] [ ${inst.slots.map((s) => `ptr ${s}`).join(", ")} ]`,
        `@${inst.sym} = internal global %ScrArr { ${this.sizeType} -1, ${this.sizeType} ${n}, ${this.sizeType} ${n}, i32 2, ptr null, ptr null, ptr null, ptr @${inst.sym}_data }`,
      );
    }
    if (this.templateStringsInstances.size > 0) out.push(``);
    for (const [text, c] of this.cstrs) {
      // NUL-terminated byte-array constants: the scr_jb_puts / indent-text
      // currency (the C emitter passes string literals; these are theirs).
      out.push(
        `@${c.sym} = internal constant [${c.len + 1} x i8] c"${llStrBytes(text)}"`,
      );
    }
    if (this.cstrs.size > 0) out.push(``);
    if (usesIsland) {
      const fmt = { esm: 0, cjs: 1, json: 2 } as const;
      const edgeKind = { any: 0, import: 1, require: 2 } as const;
      embedded.modules.forEach((m, i) => {
        const stored = npmStored[i]!;
        const key = Buffer.from(m.key, "utf8");
        out.push(
          `@sc_npm_key_${i} = internal constant [${key.length + 1} x i8] c"${llBytes(key)}"`,
          `@sc_npm_src_${i} = internal constant [${stored.src.bytes.length + 1} x i8] c"${llBytes(stored.src.bytes)}"`,
        );
        if (stored.esm !== null) {
          out.push(
            `@sc_npm_esm_${i} = internal constant [${stored.esm.bytes.length + 1} x i8] c"${llBytes(stored.esm.bytes)}"`,
          );
        }
      });
      const moduleRows = embedded.modules.map((m, i) => {
        const stored = npmStored[i]!;
        const esm = stored.esm === null
          ? `ptr null, ${this.sizeType} 0, ${this.sizeType} 0`
          : `ptr @sc_npm_esm_${i}, ${this.sizeType} ${stored.esm.bytes.length}, ${this.sizeType} ${stored.esm.raw}`;
        return `%ScrIslandModule { ptr @sc_npm_key_${i}, ptr @sc_npm_src_${i}, ` +
          `${this.sizeType} ${stored.src.bytes.length}, ${this.sizeType} ${stored.src.raw}, ` +
          `i32 ${fmt[m.format]}, ${esm} }`;
      });
      out.push(
        `@sc_npm_modules = internal constant [${moduleRows.length} x %ScrIslandModule] [ ${moduleRows.join(", ")} ]`,
      );
      embedded.edges.forEach((edge, i) => {
        for (const [part, text] of [["from", edge.from], ["spec", edge.specifier], ["to", edge.to]] as const) {
          const bytes = Buffer.from(text, "utf8");
          out.push(`@sc_npm_edge_${i}_${part} = internal constant [${bytes.length + 1} x i8] c"${llBytes(bytes)}"`);
        }
      });
      if (embedded.edges.length > 0) {
        const edgeRows = embedded.edges.map((edge, i) =>
          `%ScrIslandEdge { ptr @sc_npm_edge_${i}_from, ptr @sc_npm_edge_${i}_spec, ` +
          `ptr @sc_npm_edge_${i}_to, i32 ${edgeKind[edge.kind]} }`,
        );
        out.push(`@sc_npm_edges = internal constant [${edgeRows.length} x %ScrIslandEdge] [ ${edgeRows.join(", ")} ]`);
      }
      out.push(``);
    }
    out.push(...ffiCallbacks.globals);
    if (ffiCallbacks.globals.length > 0) out.push(``);
    for (const g of globals) {
      const ty = this.llType(g.type);
      const zero = ty === "double" ? f64Lit(0) : ty === "ptr" ? "null" : "false";
      out.push(`@${mangleGlobal(g.id)} = internal ${tl}global ${ty} ${zero} ; ${g.name}`);
    }
    if (globals.length > 0) out.push(``);
    out.push(...helpers);
    out.push(...ffiCallbacks.defs);
    out.push(...shapes.defs);
    out.push(...classShapes.defs);
    out.push(...classObjDefs);
    out.push(...this.walkers.defs);
    out.push(...this.dyn.defs);
    out.push(...wrappers);
    out.push(...asyncDefs);
    out.push(...this.resolveThunkDefs);
    out.push(fnDefs.join("\n\n"), ``);

    // main(): scr_init, the program-dependent error-vt interval stamps,
    // scr_lib_init(argc, argv), then the entry function. An uncaught
    // exception escaping top-level code prints and exits 1 (Node) — the
    // C emitter's epilogue, emitted exactly when the entry may throw.
    // No event loop yet: timers/async still refuse (phase 5).
    const stamps: string[] = [];
    for (const iv of this.errorIntervals) {
      for (const [field, value] of [[0, iv.pre], [1, iv.post]] as const) {
        stamps.push(
          `  store ${this.sizeType} ${value}, ptr getelementptr inbounds ([5 x %ScrVt], ptr @scr_error_vts, i64 0, i64 ${iv.kind}, i32 ${field})${field === 1 ? ` ; ${iv.lib}` : ""}`,
        );
      }
    }
    if (this.emitterInterval !== null) {
      // The runtime emitter vtable's interval (emitterVtStampLines): bare
      // EventEmitter instances answer instanceof and dispatch dynamic
      // teardown under THIS module's preorder numbering.
      out.push(`@scr_emitter_vt = external ${tl}global %ScrVt`, ``);
      stamps.push(
        `  store ${this.sizeType} ${this.emitterInterval.pre}, ptr getelementptr inbounds (%ScrVt, ptr @scr_emitter_vt, i64 0, i32 0)`,
        `  store ${this.sizeType} ${this.emitterInterval.post}, ptr getelementptr inbounds (%ScrVt, ptr @scr_emitter_vt, i64 0, i32 1) ; EventEmitter`,
      );
    }
    for (const iv of this.streamIntervals) {
      // The runtime stream vtables' intervals (streamVtStampLines) — the
      // emitter story: instanceof and dynamic teardown dispatch through
      // them.
      out.push(`@${iv.vt} = external global %ScrVt`);
      stamps.push(
        `  store ${this.sizeType} ${iv.pre}, ptr getelementptr inbounds (%ScrVt, ptr @${iv.vt}, i64 0, i32 0)`,
        `  store ${this.sizeType} ${iv.post}, ptr getelementptr inbounds (%ScrVt, ptr @${iv.vt}, i64 0, i32 1) ; ${iv.lib}`,
      );
    }
    if (this.streamIntervals.length > 0) out.push(``);
    if (this.errorIntervals.length > 0 && this.tracedShapes.has("object:%Error")) {
      // The cycle fixpoint marked the Error hierarchy (a user subclass
      // holds cycle-capable fields — capability is hierarchy-uniform), so
      // the runtime's own error allocations need collector headers too.
      // Declared inline: the extern block already flushed (LLVM is
      // order-free, the helper-defs precedent).
      out.push(`declare void @scr_error_set_traced()`, ``);
      stamps.push(`  call void @scr_error_set_traced()`);
    }
    if ((entryMayThrow || runsLoop) && this.mod.lib === undefined) {
      // Declared inline: the extern block already flushed (LLVM is
      // order-free — the scr_error_set_traced precedent). Only the
      // printer emits here (nothing else declares it); scr_exc_pending
      // and the loop entry points rode the Set before the flush.
      out.push(`declare void @scr_exc_print_uncaught()`, ``);
    }
    if (this.mod.lib !== undefined) {
      // LIBRARY mode: no @main — the profile-declared external
      // symbols instead, from the same IR facts the C emission consumes.
      out.push(...this.emitLibDefs(globals, globalReleaseLines, stamps));
      out.push(`attributes #0 = { sanitize_address }`);
      if (this.wasi) out.push(`attributes #1 = { sanitize_address presplitcoroutine }`);
      if (hasNoInlineRecordClone) out.push(`attributes #2 = { noinline sanitize_address }`);
      out.push(``);
      return out.join("\n");
    }
    out.push(
      `define i32 @${this.wasi ? "__main_argc_argv" : "main"}(i32 %argc, ptr %argv) ${FN_ATTRS} {`,
      `entry:`,
      ...(this.runtimeAbiMarker ? [`  call void @${RUNTIME_ABI_MARKER}()`] : []),
      `  call void @scr_init()`,
      ...stamps,
      // Event-surface programs (signal/exit listeners) fill the loop's
      // nullable event hooks before %main — scr_events.c links only when
      // this line is emitted (native-toolchain.ts gates on the same predicate).
      ...(usesEvents ? [`  call void @scr_events_install()`] : []),
      // fs.watch programs fill the loop's watch hooks the same way —
      // scr_watch.c links only when this line is emitted.
      ...(usesFsWatch ? [`  call void @scr_watch_install()`] : []),
      ...(this.ffiHasForeignCallback ? [`  call void @scr_ffi_install()`] : []),
      ...(snapshotsTlsCa ? [`  call void @scr_tls_ca_install()`] : []),
      ...(usesFetch ? [`  call void @scr_fetch_install()`] : []),
      ...(embedsZlib ? [`  call void @scr_zlib_island_install()`] : []),
      ...(embedsNet ? [`  call void @scr_net_island_install()`] : []),
      ...(usesNet ? [`  call void @scr_net_install()`, `  call void @scr_net_dyn_install()`] : []),
      ...(usesHttp ? [`  call void @scr_http_dyn_install()`] : []),
      ...(usesStream ? [`  call void @scr_stream_install()`] : []),
      `  call void @scr_lib_init(i32 %argc, ptr %argv)`,
      ...(usesIsland
        ? [
            ...(moduleEmbedsCompressedNpm(this.mod)
              ? [`  call void @scr_island_set_inflate(ptr @scr_zlib_inflate_exact)`]
              : []),
            `  call void @scr_island_modules(ptr @sc_npm_modules, ${this.sizeType} ${embedded.modules.length}, ` +
              `ptr ${embedded.edges.length > 0 ? "@sc_npm_edges" : "null"}, ${this.sizeType} ${embedded.edges.length})`,
          ]
        : []),
      ...(asyncEntry
        ? [`  %top = call ptr @${mangleAsyncSpawn(this.mod.entry)}()`]
        : [`  call void @${mangleFunction(this.mod.entry)}()`]),
      // Uncaught exception from top-level code: Node exits 1.
      ...(entryMayThrow && !asyncEntry
        ? [
            `  %exc = call zeroext i1 @scr_exc_pending()`,
            `  br i1 %exc, label %uncaught, label %ok`,
            `uncaught:`,
            `  call void @scr_exc_print_uncaught()`,
            ...exitListenerLines("xu"),
            ...uncaughtReleases,
            `  ret i32 1`,
            `ok:`,
          ]
        : []),
      // The event loop runs to exhaustion (microtasks before timers). A
      // throw escaping a timer callback and unhandled promise rejections
      // both exit 1, like Node — the C main's loop block exactly.
      ...(runsLoop
        ? [
            `  %loop_rejection = call zeroext i1 @scr_loop_run(ptr ${asyncEntry ? "%top" : "null"})`,
            `  %lexc = call zeroext i1 @scr_exc_pending()`,
            `  br i1 %lexc, label %luncaught, label %lok`,
            `luncaught:`,
            `  call void @scr_exc_print_uncaught()`,
            ...(asyncEntry ? [`  call void @scr_promise_release(ptr %top)`] : []),
            ...exitListenerLines("xl"),
            ...loopReleasesU,
            `  ret i32 1`,
            `lok:`,
            `  br i1 %loop_rejection, label %lreported, label %lclean`,
            `lreported:`,
            `  call void @scr_discard_unhandled_rejections()`,
            ...(asyncEntry ? [`  call void @scr_promise_release(ptr %top)`] : []),
            ...exitListenerLines("xq"),
            ...loopReportedReleases,
            `  ret i32 1`,
            `lclean:`,
            ...(asyncEntry
              ? [
                  `  %tla_status = call i32 @scr_promise_finish_top_level(ptr %top)`,
                  `  %tla_rejected = icmp eq i32 %tla_status, 1`,
                  `  br i1 %tla_rejected, label %tla_fail, label %tla_not_rejected`,
                  `tla_fail:`,
                  // The loop already delivered every earlier-checkpoint
                  // rejection. Drop same-checkpoint competitors before
                  // surfacing the fatal module verdict.
                  `  call void @scr_discard_unhandled_rejections()`,
                  `  call void @scr_promise_rethrow_top_level(ptr %top)`,
                  `  call void @scr_promise_release(ptr %top)`,
                  `  call void @scr_exc_print_uncaught()`,
                  ...exitListenerLines("xt"),
                  ...topRejectReleases,
                  `  ret i32 1`,
                  `tla_not_rejected:`,
                  `  call void @scr_promise_release(ptr %top)`,
                ]
              : []),
            `  %rej = call zeroext i1 @scr_report_unhandled_rejections()`,
            `  br i1 %rej, label %lrej, label %lrok`,
            `lrej:`,
            ...exitListenerLines("xr"),
            ...loopReleasesR,
            `  ret i32 1`,
            `lrok:`,
            ...(asyncEntry
              ? [
                  `  %tla_pending = icmp eq i32 %tla_status, 13`,
                  `  br i1 %tla_pending, label %tla_stuck, label %tla_ok`,
                  `tla_stuck:`,
                  ...topPendingExitLines(),
                  `tla_ok:`,
                ]
              : []),
          ]
        : []),
      ...exitListenerLines("xn"),
      ...globalReleases,
      ...(usesNodeTest
        ? [`  %test_exit = call i32 @scr_test_exit_code()`, `  ret i32 %test_exit`]
        : usesIsland
        ? [`  %island_exit = call i32 @scr_island_exit_code()`, `  ret i32 %island_exit`]
        : [`  ret i32 0`]),
      `}`,
      ``,
      // sanitize_address is inert under the plain pipeline; the sanitized
      // lane's -fsanitize=address link activates instrumentation over the
      // emitted functions too (the runtime TUs get theirs from clang).
      `attributes #0 = { sanitize_address }`,
      ...(this.wasi ? [`attributes #1 = { sanitize_address presplitcoroutine }`] : []),
      ...(hasNoInlineRecordClone ? [`attributes #2 = { noinline sanitize_address }`] : []),
      ``,
    );
    return out.join("\n");
  }

  /** LIBRARY mode: the profile-declared external definitions — the
   * export-map wrappers plus init / sink-registration / reset / collect.
   * Plain `define` (not `define internal`) — the exact linkage distinction
   * that separates the executable lane's @main from everything else. The
   * bodies delegate every runtime half to scr_library.c, mirroring the C
   * emission line for line, so the two lanes are identical by
   * construction. */
  private emitLibDefs(
    globals: IrGlobal[],
    globalReleaseLines: (prefix: string) => string[],
    stamps: string[],
  ): string[] {
    const lib = this.mod.lib!;
    const autoReset = lib.resultResetSymbol === null;
    const out: string[] = [``, `; ── library-mode entries (profile: ${lib.profileName}) ──`, ``];
    // Every entry's prologue records its external symbol in the funnel's
    // current-entry slot (structured trap-teaching field 2); the symbols
    // live as internal constants, one per entry.
    const symConst = (sym: string): string => `@sc_lib_sym_${sym}`;
    const emitSymConst = (sym: string): void => {
      out.push(`${symConst(sym)} = internal constant [${Buffer.byteLength(sym, "utf8") + 1} x i8] c"${llStrBytes(sym)}"`);
    };
    emitSymConst(lib.initSymbol);
    emitSymConst(lib.sinkRegisterSymbol);
    if (lib.callbackRegisterSymbol !== null && lib.callbackRegisterSymbol !== undefined) emitSymConst(lib.callbackRegisterSymbol);
    if (lib.resultResetSymbol !== null) emitSymConst(lib.resultResetSymbol);
    if (lib.collectSymbol !== null) emitSymConst(lib.collectSymbol);
    if (lib.drainSymbol !== null) emitSymConst(lib.drainSymbol);
    for (const e of lib.exports) emitSymConst(e.symbol);
    out.push(``);
    // The runtime detected-trap overlay table (scr_runtime.h declares it,
    // the library trap funnel consults it): flat code/teaching/remediation
    // triples, one per runtime trap code (SC4013–SC4019) the profile
    // declares text for — the same data the C emission defines, so the
    // funnel-assembled sink message is emission-invariant by construction.
    // The empty table still defines the symbols the funnel links against.
    const ovlCells: string[] = [];
    lib.trapOverlays.forEach((o, i) => {
      const cell = (name: string, text: string | undefined): void => {
        if (text === undefined) {
          ovlCells.push("ptr null");
          return;
        }
        const sym = `@sc_lib_ovl_${i}_${name}`;
        out.push(`${sym} = internal constant [${Buffer.byteLength(text, "utf8") + 1} x i8] c"${llStrBytes(text)}"`);
        ovlCells.push(`ptr ${sym}`);
      };
      cell("code", o.code);
      cell("teach", o.teaching);
      cell("rem", o.remediation);
    });
    out.push(
      ovlCells.length === 0
        ? `@scr_library_trap_overlays = constant [1 x ptr] zeroinitializer`
        : `@scr_library_trap_overlays = constant [${ovlCells.length} x ptr] [${ovlCells.join(", ")}]`,
      `@scr_library_trap_overlays_len = constant ${this.sizeType} ${lib.trapOverlays.length}`,
      ``,
    );
    // The init entry: full deterministic reset-and-reevaluate. Program
    // globals release and zero first (run-once guards included), then the
    // runtime session reset, the error-vt interval stamps verbatim from
    // the executable main, %main itself, and the escaped-exception check.
    const zeroStores = globals.map((g) => {
      const ty = this.llType(g.type);
      const zero = ty === "double" ? f64Lit(0) : ty === "ptr" ? "null" : "false";
      return `  store ${ty} ${zero}, ptr @${mangleGlobal(g.id)} ; ${g.name}`;
    });
    out.push(
      `define void @${lib.initSymbol}() ${FN_ATTRS} {`,
      `entry:`,
      `  call void @scr_library_entry(i1 zeroext true, ptr ${symConst(lib.initSymbol)}) ; init always resets the result arena`,
      ...globalReleaseLines("ci"),
      ...zeroStores,
      `  call void @scr_library_reset()`,
      ...stamps,
      `  call void @${mangleFunction(this.mod.entry)}()`,
      `  call void @scr_library_check_exc()`,
      `  ret void`,
      `}`,
      ``,
      `define void @${lib.sinkRegisterSymbol}(ptr %fn, ptr %ctx) ${FN_ATTRS} {`,
      `entry:`,
      `  call void @scr_library_callback_entry_guard(ptr ${symConst(lib.sinkRegisterSymbol)})`,
      `  call void @scr_library_set_sink(ptr %fn, ptr %ctx)`,
      `  ret void`,
      `}`,
      ``,
    );
    if (lib.callbacks !== undefined && lib.callbacks.length > 0) {
      // Host-callback channels: the per-channel name constants (the
      // registration dispatch's strcmp operands), the per-channel
      // unregistered-call trap constants (the ffiCall sites'
      // scr_library_cb_require operands — same bytes as the C emission by
      // construction), and the registration define: a pure store dispatch
      // (the sink registration's rule — no entry prologue, no poison
      // guard) whose first operation rejects callback-time re-entry
      // (SC4026). An unknown or NULL name is a defined -1, never a store.
      for (const cb of lib.callbacks) {
        out.push(
          `@sc_lib_cb_name_${cb.slot} = internal constant [${Buffer.byteLength(cb.name, "utf8") + 1} x i8] c"${llStrBytes(cb.name)}"`,
          `@sc_lib_cb_trap_${cb.slot} = internal constant [${Buffer.byteLength(cb.unregisteredTrap, "utf8") + 1} x i8] c"${llStrBytes(cb.unregisteredTrap)}"`,
        );
      }
      out.push(
        ``,
        `define i32 @${lib.callbackRegisterSymbol}(ptr %name, ptr %fn, ptr %ctx) ${FN_ATTRS} {`,
        `entry:`,
        `  call void @scr_library_callback_entry_guard(ptr ${symConst(lib.callbackRegisterSymbol!)})`,
        `  %isnull = icmp eq ptr %name, null`,
        `  br i1 %isnull, label %miss, label %try0`,
      );
      lib.callbacks.forEach((cb, i) => {
        const next = i + 1 < lib.callbacks!.length ? `try${i + 1}` : "miss";
        out.push(
          `try${i}: ; channel '${cb.name}'`,
          `  %cmp${i} = call i32 @strcmp(ptr %name, ptr @sc_lib_cb_name_${cb.slot})`,
          `  %eq${i} = icmp eq i32 %cmp${i}, 0`,
          `  br i1 %eq${i}, label %set${i}, label %${next}`,
          `set${i}:`,
          `  call void @scr_library_cb_set(${this.sizeType} ${cb.slot}, ptr %fn, ptr %ctx)`,
          `  ret i32 0`,
        );
      });
      out.push(`miss:`, `  ret i32 -1`, `}`, ``);
    }
    if (lib.identity !== undefined && this.emitLibraryIdentity) {
      // Profile-declared identity getters (the ask-2 sidecar's boot-time
      // pairing fence): pure data returns with NO entry prologue — exempt
      // from the poisoned guard and every runtime touch (ratified), so a
      // host can read them before init and after a trap. The u64 rides
      // i64 two's-complement (LLVM integer constants are signed).
      out.push(...emitLibraryIdentityLines("llvm", lib.identity, FN_ATTRS));
    }
    if (lib.resultResetSymbol !== null) {
      out.push(
        `define void @${lib.resultResetSymbol}() ${FN_ATTRS} {`,
        `entry:`,
        `  call void @scr_library_entry(i1 zeroext false, ptr ${symConst(lib.resultResetSymbol)})`,
        `  call void @scr_library_arena_reset()`,
        `  ret void`,
        `}`,
        ``,
      );
    }
    if (lib.collectSymbol !== null) {
      out.push(
        `define void @${lib.collectSymbol}() ${FN_ATTRS} {`,
        `entry:`,
        `  call void @scr_library_entry(i1 zeroext false, ptr ${symConst(lib.collectSymbol)})`,
        `  call void @scr_library_collect() ; arena reset + a full cycle collection`,
        `  ret void`,
        `}`,
        ``,
      );
    }
    if (lib.drainSymbol !== null) {
      // The job checkpoint, line for line with the C emission (see there
      // for why it does not reset the arena).
      out.push(
        `define void @${lib.drainSymbol}() ${FN_ATTRS} {`,
        `entry:`,
        `  call void @scr_library_entry(i1 zeroext false, ptr ${symConst(lib.drainSymbol)})`,
        `  %drained = call i1 @scr_drain_jobs() ; nextTick + promise jobs; no turn`,
        `  call void @scr_library_check_exc()`,
        `  ret void`,
        `}`,
        ``,
      );
    }
    for (const e of lib.exports) {
      const params: string[] = [];
      const body: string[] = [`  call void @scr_library_entry(i1 zeroext ${autoReset ? "true" : "false"}, ptr ${symConst(e.symbol)})`];
      const args: string[] = [];
      if (e.inboundBytesTrap !== undefined) {
        // The bytes-in helper's trap message: the compiler-assembled
        // structured trap-teaching form (0x01 text 0x1F SC4012 0x1F symbol
        // [0x1F remediation]) — the same bytes the C emission passes, so
        // the sink message is emission-invariant by construction.
        const trapBytes = Buffer.byteLength(e.inboundBytesTrap, "utf8");
        out.push(`@sc_lib_bytes_trap_${e.symbol} = internal constant [${trapBytes + 1} x i8] c"${llStrBytes(e.inboundBytesTrap)}"`, ``);
      }
      if (e.inboundIntTrap !== undefined) {
        // The i64/u64-in helpers' host-contract trap message (ask 4): an
        // inbound integer past ±(2^53−1) cannot ride f64 exactly. Same
        // assembled structured form, same SC4012 code, same
        // emission-invariance argument as the bytes trap.
        const trapBytes = Buffer.byteLength(e.inboundIntTrap, "utf8");
        out.push(`@sc_lib_int_trap_${e.symbol} = internal constant [${trapBytes + 1} x i8] c"${llStrBytes(e.inboundIntTrap)}"`, ``);
      }
      e.params.forEach((cls, i) => {
        switch (cls) {
          case "f64":
            params.push(`double %a${i}`);
            args.push(`double %a${i}`);
            break;
          case "bool":
            params.push(`i8 %a${i}`);
            body.push(`  %c${i} = icmp ne i8 %a${i}, 0`);
            args.push(`i1 %c${i}`);
            break;
          case "u8":
            params.push(`i8 %a${i}`);
            body.push(`  %c${i} = uitofp i8 %a${i} to double`);
            args.push(`double %c${i}`);
            break;
          case "u32":
            params.push(`i32 %a${i}`);
            body.push(`  %c${i} = uitofp i32 %a${i} to double`);
            args.push(`double %c${i}`);
            break;
          case "i32":
            params.push(`i32 %a${i}`);
            body.push(`  %c${i} = sitofp i32 %a${i} to double`);
            args.push(`double %c${i}`);
            break;
          case "i64":
            // Inbound declared-integer edge (ask 4): the helper converts
            // exactly or delivers the host-contract trap (past ±(2^53−1)
            // the value cannot ride f64 without silent rounding).
            params.push(`i64 %a${i}`);
            body.push(`  %c${i} = call double @scr_library_i64_in(i64 %a${i}, ptr @sc_lib_int_trap_${e.symbol})`);
            args.push(`double %c${i}`);
            break;
          case "u64":
            params.push(`i64 %a${i}`);
            body.push(`  %c${i} = call double @scr_library_u64_in(i64 %a${i}, ptr @sc_lib_int_trap_${e.symbol})`);
            args.push(`double %c${i}`);
            break;
          case "string":
            params.push(`ptr %a${i}_ptr`, `${this.sizeType} %a${i}_len`);
            body.push(`  %c${i} = call ptr @scr_library_str_in(ptr %a${i}_ptr, ${this.sizeType} %a${i}_len)`);
            args.push(`ptr %c${i}`);
            break;
          case "bytes":
            params.push(`ptr %a${i}_ptr`, `${this.sizeType} %a${i}_len`);
            body.push(`  %c${i} = call ptr @scr_library_bytes_in(ptr %a${i}_ptr, ${this.sizeType} %a${i}_len, ptr @sc_lib_bytes_trap_${e.symbol})`);
            args.push(`ptr %c${i}`);
            break;
        }
      });
      if (e.returns === "string" || e.returns === "bytes") {
        params.push(`ptr %out`, `ptr %out_len`);
      }
      const target = `@${mangleFunction(e.fnName)}`;
      const callArgs = args.join(", ");
      let retType = "void";
      switch (e.returns) {
        case "void":
          body.push(`  call void ${target}(${callArgs})`, `  call void @scr_library_check_exc()`, `  ret void`);
          break;
        case "f64":
          retType = "double";
          body.push(
            `  %r = call double ${target}(${callArgs})`,
            `  call void @scr_library_check_exc()`,
            `  ret double %r`,
          );
          break;
        case "i64":
        case "u64":
          // The outbound declared-integer edge (ask 4): every value
          // reaching this return was PROVEN whole and inside the class's
          // range at compile time, so the fp-to-int conversion is exact
          // by construction — the crossing carries the mathematically
          // exact integer the f64 held.
          retType = "i64";
          body.push(
            `  %r = call double ${target}(${callArgs})`,
            `  call void @scr_library_check_exc()`,
            `  %z = ${e.returns === "i64" ? "fptosi" : "fptoui"} double %r to i64`,
            `  ret i64 %z`,
          );
          break;
        case "bool":
          retType = "i8";
          body.push(
            `  %r = call i1 ${target}(${callArgs})`,
            `  call void @scr_library_check_exc()`,
            `  %z = zext i1 %r to i8`,
            `  ret i8 %z`,
          );
          break;
        case "string":
          body.push(
            `  %r = call ptr ${target}(${callArgs})`,
            `  call void @scr_library_check_exc()`,
            `  call void @scr_library_str_out(ptr %r, ptr %out, ptr %out_len)`,
            `  ret void`,
          );
          break;
        case "bytes":
          body.push(
            `  %r = call ptr ${target}(${callArgs})`,
            `  call void @scr_library_check_exc()`,
            `  call void @scr_library_bytes_out(ptr %r, ptr %out, ptr %out_len)`,
            `  ret void`,
          );
          break;
      }
      out.push(
        `define ${retType} @${e.symbol}(${params.join(", ")}) ${FN_ATTRS} { ; library export ${e.fnName}`,
        `entry:`,
        ...body,
        `}`,
        ``,
      );
    }
    return out;
  }

  /** The shared abort helpers (emitted only when referenced): the OOM
   * abort of untraced shape allocation and the invalid-union-tag abort —
   * both print the C emitter's exact message on fd 2 and abort. */
  private helperDefs(): string[] {
    const defs: string[] = [];
    const msgHelper = (fnName: string, msgSym: string, msg: string): void => {
      // The message routes through the runtime's trap funnel: executable
      // builds expand to the historical bytes-on-stderr + abort; library
      // builds route to the registered panic sink (scr_runtime.h).
      const bytes = Buffer.byteLength(msg, "utf8");
      this.declare(`declare void @scr_trap(ptr)`);
      defs.push(
        `@${msgSym} = internal constant [${bytes + 1} x i8] c"${llStrBytes(msg)}"`,
        `define internal void @${fnName}() ${FN_ATTRS} {`,
        `entry:`,
        `  call void @scr_trap(ptr @${msgSym})`,
        `  unreachable`,
        `}`,
        ``,
      );
    };
    if (this.needsOom) msgHelper("sc_oom", "sc_oom_msg", "scriptc: out of memory\n");
    if (this.needsBadTag) {
      msgHelper("sc_bad_tag", "sc_bad_tag_msg", "scriptc: internal error: invalid union tag\n");
    }
    if (this.needsBadKey) {
      // The keyed-read miss on a result type that cannot say `undefined`:
      // trap like an array OOB read instead of corrupting a typed slot
      // (SEMANTICS.md; the C helper's message additionally interpolates
      // the runtime key — a trap-path debugging nicety, never reachable
      // by a program whose behavior matches Node).
      msgHelper(
        "sc_bad_key",
        "sc_bad_key_msg",
        "scriptc: TypeError: record has no key (typed slot — no undefined is representable)\n",
      );
    }
    if (this.needsRetainBox) {
      // scr_box_retain is a static inline (increment-unless-immortal, then
      // mark the cycle header live — every box is collector-headered);
      // emitted once with internal linkage, like the record retains.
      defs.push(
        `define internal ptr @sc_retain_box(ptr %b) ${FN_ATTRS} {`,
        `entry:`,
        `  %rc = load ${this.sizeType}, ptr %b`,
        `  %imm = icmp eq ${this.sizeType} %rc, -1`,
        `  br i1 %imm, label %done, label %inc`,
        `inc:`,
        `  %n = add ${this.sizeType} %rc, 1`,
        `  store ${this.sizeType} %n, ptr %b`,
        `  %colorp = getelementptr i8, ptr %b, ${this.sizeType} -${this.cycleColorOffset}`,
        `  store i32 0, ptr %colorp ; mark live`,
        `  br label %done`,
        `done:`,
        `  ret ptr %b`,
        `}`,
        ``,
      );
    }
    // The declarations these helpers added must land in the extern block,
    // which already flushed — append here instead (LLVM is order-free).
    return defs.length > 0 ? [...defs] : defs;
  }

  /** Env-signature wrappers + interned immortal closures for declared
   * functions used as values (the C emitter's sc_w_/sc_fc_ pair): every
   * mention of `f` yields the same pointer, so `f === f` holds. */
  private emitFnValueDefs(): string[] {
    const out: string[] = [];
    for (const name of this.fnValues) {
      const fn = this.fnByName.get(name)!;
      const params = fn.params.map((p, i) => `${this.llType(p.type)} %a${i}`);
      const args = fn.params.map((p, i) => `${this.llType(p.type)} %a${i}`).join(", ");
      // Async/generator functions as values enter through their spawn
      // wrapper: the call answers the promise / generator object (+1),
      // never the inner return type.
      const ret = fn.async === true || fn.generator !== undefined ? "ptr" : this.llType(fn.returnType);
      const call = `call ${ret} @${this.callTarget(name)}(${args})`;
      out.push(
        `define internal ${ret} @${mangleWrapper(name)}(ptr %env${params.length ? ", " + params.join(", ") : ""}) ${FN_ATTRS} { ; ${name} as a value`,
        `entry:`,
        ret === "void" ? `  ${call}` : `  %r = ${call}`,
        ret === "void" ? `  ret void` : `  ret ${ret} %r`,
        `}`,
        `@${mangleFnClosure(name)} = internal global %ScrClosure { ${this.sizeType} -1, ptr @${mangleWrapper(name)}, ${this.sizeType} 0, ptr null }`,
        ``,
      );
    }
    return out;
  }

  /** The argument-pack ABI and trampoline prefix shared by async functions
   * and generators. Their promise/generator completion and spawn tails stay
   * with the callers below. */
  private emitArgPackAndTrampolinePrologue(fn: IrFunction): LlArgPackAndTrampolinePrologue {
    const pack = mangleArgPack(fn.name);
    const lifted = fn.captures !== undefined;
    const fieldTys = [...(lifted ? ["ptr"] : []), ...fn.params.map((p) => this.llType(p.type))];
    const definitions = [`%${pack} = type { ${fieldTys.join(", ") || "i8"} } ; ${fn.name} args`];
    const sizeOf = `ptrtoint (ptr getelementptr (%${pack}, ptr null, i32 1) to ${this.sizeType})`;

    this.declare(`declare void @free(ptr)`);
    this.declare(`declare ptr @malloc(${this.sizeType})`);
    this.declare(`declare zeroext i1 @scr_exc_pending()`);

    const tr: string[] = [
      `define internal void @${mangleTrampoline(fn.name)}(ptr %self, ptr %ap) ${FN_ATTRS} {`,
      `entry:`,
    ];
    const loads: string[] = [];
    fieldTys.forEach((ty, i) => {
      tr.push(
        `  %fp${i} = getelementptr inbounds %${pack}, ptr %ap, i64 0, i32 ${i}`,
        `  %a${i} = load ${ty}, ptr %fp${i}`,
      );
      loads.push(`${ty} %a${i}`);
    });
    tr.push(`  call void @free(ptr %ap)`);
    const ret = fn.returnType;
    const retTy = this.llType(ret);
    const bodyCall = `call ${retTy} @${mangleFunction(fn.name)}(${loads.join(", ")})`;
    tr.push(retTy === "void" ? `  ${bodyCall}` : `  %r = ${bodyCall}`);
    if (lifted && !this.wasi) {
      tr.push(`  call void @scr_closure_release(ptr %a0)`);
    }

    const spawnParams = fieldTys.map((ty, i) => `${ty} %a${i}`);
    const argPackLines = [
      `  %ap = call ptr @malloc(${this.sizeType} ${sizeOf})`,
      `  %isnull = icmp eq ptr %ap, null`,
      `  br i1 %isnull, label %oom, label %ok`,
      `oom:`,
      `  call void @sc_oom()`,
      `  unreachable`,
      `ok:`,
    ];
    if (lifted) {
      // scr_closure_retain is a header static inline — the `_v` twin is
      // the exported symbol.
      argPackLines.push(`  %env = call ptr @scr_closure_retain_v(ptr %a0)`);
    }
    fieldTys.forEach((ty, i) => {
      const src = lifted && i === 0 ? "%env" : `%a${i}`;
      argPackLines.push(
        `  %sp${i} = getelementptr inbounds %${pack}, ptr %ap, i64 0, i32 ${i}`,
        `  store ${ty} ${src}, ptr %sp${i}`,
      );
    });
    return { definitions, pack, lifted, fieldTys, ret, tr, spawnParams, argPackLines };
  }

  /** Per-async-function machinery — async.ts's scaffolding, .ll
   * flavored: an argument-pack struct type, a fiber trampoline (unpacks,
   * frees the pack, runs the ordinary compiled body, settles the
   * promise — fulfilling on clean return, leaving a pending exception
   * for the runtime to reject with), and a spawn wrapper call sites and
   * closures enter through (packs the args +1, scr_async_spawn runs the
   * fiber eagerly to its first suspension and returns the promise). */
  private emitAsyncScaffolding(): string[] {
    const out: string[] = [];
    if (this.wasi) {
      this.declare(`declare void @llvm.coro.resume(ptr)`);
      this.declare(`declare void @llvm.coro.destroy(ptr)`);
      out.push(
        `define void @scr_wasi_coro_resume(ptr %handle) ${FN_ATTRS} {`,
        `entry:`,
        `  call void @llvm.coro.resume(ptr %handle)`,
        `  ret void`,
        `}`,
        `define void @scr_wasi_coro_destroy(ptr %handle) ${FN_ATTRS} {`,
        `entry:`,
        `  call void @llvm.coro.destroy(ptr %handle)`,
        `  ret void`,
        `}`,
        ``,
      );
    }
    for (const fn of this.mod.functions) {
      if (fn.async !== true) continue;
      const { definitions, ret, tr, spawnParams, argPackLines } =
        this.emitArgPackAndTrampolinePrologue(fn);
      out.push(...definitions);
      this.declare(`declare ptr @scr_fiber_promise(ptr)`);
      this.declare(`declare ptr @scr_async_spawn(ptr, ptr)`);
      this.needOom();
      if (this.wasi) {
        // The coroutine body settles its own promise and owns the retained
        // lifted environment until final suspension. Its initial call
        // returns here at the first suspend (or final suspend).
        tr.push(`  ret void`, `}`, ``);
      } else {
        if (fn.captures !== undefined) {
          this.declare(`declare void @scr_closure_release(ptr)`);
        }
        tr.push(
          `  %pend = call zeroext i1 @scr_exc_pending()`,
          `  br i1 %pend, label %thrown, label %clean`,
          `clean:`,
          `  %pr = call ptr @scr_fiber_promise(ptr %self)`,
        );
        switch (ret.kind) {
          case "void":
            this.declare(`declare void @scr_promise_fulfill_void(ptr)`);
            tr.push(`  call void @scr_promise_fulfill_void(ptr %pr)`);
            break;
          case "f64":
          case "date":
            this.declare(`declare void @scr_promise_fulfill_f64(ptr, double)`);
            tr.push(`  call void @scr_promise_fulfill_f64(ptr %pr, double %r)`);
            break;
          case "bool":
            this.declare(`declare void @scr_promise_fulfill_bool(ptr, i1 zeroext)`);
            tr.push(`  call void @scr_promise_fulfill_bool(ptr %pr, i1 %r)`);
            break;
          case "string":
            this.declare(`declare void @scr_promise_fulfill_str(ptr, ptr)`);
            tr.push(`  call void @scr_promise_fulfill_str(ptr %pr, ptr %r) ; moves in`);
            break;
          default: {
            const v = vAdapters(this, ret);
            this.declare(`declare void @scr_promise_fulfill_ref(ptr, ptr, ptr, ptr, ptr)`);
            tr.push(
              `  call void @scr_promise_fulfill_ref(ptr %pr, ptr %r, ptr ${v.retain}, ptr ${v.release}, ptr ${traceArg(this, ret)})`,
            );
          }
        }
        tr.push(`  ret void`, `thrown:`);
        if (ret.kind !== "void" && isRefCounted(ret)) {
          // An escaping throw means %r is the never-read dummy (NULL).
          tr.push(`  call void ${releaseSym(this, ret)}(ptr %r)`);
        }
        tr.push(`  ret void`, `}`, ``);
      }
      out.push(...tr);

      // Spawn wrapper: pack the args (+1 moves in), spawn the fiber.
      const cache = fn.asyncCacheGlobal !== undefined ? mangleGlobal(fn.asyncCacheGlobal) : null;
      const cycleCache =
        fn.asyncCycleCacheGlobal !== undefined ? mangleGlobal(fn.asyncCycleCacheGlobal) : null;
      if (cache !== null || cycleCache !== null) {
        this.declare(`declare ptr @scr_promise_retain_v(ptr)`);
        this.declare(`declare void @scr_promise_release(ptr)`);
      }
      if (cache !== null) {
        this.declare(`declare void @scr_promise_mark_handled(ptr)`);
      }
      if (fn.captures !== undefined) {
        this.declare(`declare ptr @scr_closure_retain_v(ptr)`);
      }
      const sp: string[] = [
        `define internal ptr @${mangleAsyncSpawn(fn.name)}(${spawnParams.join(", ")}) ${FN_ATTRS} { ; spawn ${fn.name}`,
        `entry:`,
        ...(cache !== null
          ? [
              `  %cached = load ptr, ptr @${cache}`,
              `  %cache_hit = icmp ne ptr %cached, null`,
              `  br i1 %cache_hit, label %cached_return, label %cache_miss`,
              `cached_return:`,
              `  %cached_owned = call ptr @scr_promise_retain_v(ptr %cached)`,
              `  ret ptr %cached_owned`,
              `cache_miss:`,
            ]
          : []),
        ...argPackLines,
      ];
      sp.push(
        `  %p = call ptr @scr_async_spawn(ptr @${mangleTrampoline(fn.name)}, ptr %ap)`,
        ...(cache !== null
          ? [
              // The module loader owns this evaluation promise
              // immediately. A later sibling can throw before the
              // aggregate dependency wait is built, but this rejection
              // must never become an unrelated unhandled rejection.
              `  call void @scr_promise_mark_handled(ptr %p)`,
            ]
          : []),
        ...(cache !== null
          ? [
              `  %cache_owned = call ptr @scr_promise_retain_v(ptr %p)`,
              // The eager spawn may have re-entered this guarded module
              // through an admitted async cycle and installed a temporary
              // cache entry. Drop that owned slot before replacing it
              // with the outer evaluation promise.
              `  %replaced_cache = load ptr, ptr @${cache}`,
              `  call void @scr_promise_release(ptr %replaced_cache)`,
              `  store ptr %cache_owned, ptr @${cache}`,
            ]
          : []),
        ...(cycleCache !== null
          ? [
              // Eager recursive spawns publish from the inside out. The
              // runtime-requested outermost member writes last and is the
              // SCC's actual evaluation root.
              `  %cycle_cache_owned = call ptr @scr_promise_retain_v(ptr %p)`,
              `  %replaced_cycle_cache = load ptr, ptr @${cycleCache}`,
              `  call void @scr_promise_release(ptr %replaced_cycle_cache)`,
              `  store ptr %cycle_cache_owned, ptr @${cycleCache}`,
            ]
          : []),
        `  ret ptr %p`,
        `}`,
        ``,
      );
      out.push(...sp);
    }
    out.push(...this.emitGenScaffolding());
    return out;
  }

  /** Per-generator-function machinery — the async scaffolding's lazy
   * sibling (async.ts's emitGenScaffolding): the same argument pack,
   * a fiber trampoline whose epilogue stores the COMPLETION value (or
   * consumes the GENRET sentinel, promoting the parked .return value), a
   * spawn wrapper that only ALLOCATES the suspended fiber, and the
   * never-started teardown that drops the packed (+1) arguments. */
  private emitGenScaffolding(): string[] {
    const out: string[] = [];
    for (const fn of this.mod.functions) {
      if (fn.generator === undefined) continue;
      const {
        definitions,
        pack,
        lifted,
        fieldTys,
        ret,
        tr,
        spawnParams,
        argPackLines,
      } = this.emitArgPackAndTrampolinePrologue(fn);
      out.push(...definitions);
      this.declare(`declare zeroext i1 @scr_exc_genret_pending()`);
      this.declare(`declare void @scr_exc_clear()`);
      this.declare(`declare ptr @scr_gen_of_fiber(ptr)`);
      this.declare(`declare void @scr_gen_ret_to_out(ptr)`);
      this.declare(`declare ptr @scr_gen_new(ptr, ptr, ptr)`);
      this.needOom();
      if (lifted && !this.wasi) {
        this.declare(`declare void @scr_closure_release(ptr)`);
      }
      // Normal completion stores the (typed) return value; void completes
      // with the NONE slot — JS's undefined done-value. A GENRET unwind
      // consumes the sentinel and promotes the parked .return value; a
      // real exception stays pending (the consumer-side resume moves it).
      if (this.wasi) {
        tr.push(`  ret void`, `}`, ``);
      } else {
      tr.push(
        `  %g = call ptr @scr_gen_of_fiber(ptr %self)`,
        `  %pend = call zeroext i1 @scr_exc_pending()`,
        `  br i1 %pend, label %thrown, label %clean`,
        `clean:`,
      );
      switch (ret.kind) {
        case "void":
          tr.push(`  br label %done ; void body: the done value is undefined (NONE)`);
          break;
        case "f64":
        case "date":
          this.declare(`declare void @scr_gen_out_f64(ptr, double)`);
          tr.push(`  call void @scr_gen_out_f64(ptr %g, double %r)`, `  br label %done`);
          break;
        case "bool":
          this.declare(`declare void @scr_gen_out_bool(ptr, i1 zeroext)`);
          tr.push(`  call void @scr_gen_out_bool(ptr %g, i1 %r)`, `  br label %done`);
          break;
        default: {
          const v = vAdapters(this, ret);
          this.declare(`declare void @scr_gen_out_ref(ptr, ptr, ptr)`);
          tr.push(`  call void @scr_gen_out_ref(ptr %g, ptr %r, ptr ${v.release})`, `  br label %done`);
        }
      }
      tr.push(
        `thrown:`,
        `  %genret = call zeroext i1 @scr_exc_genret_pending()`,
        `  br i1 %genret, label %promote, label %dropdummy`,
        `promote:`,
        `  call void @scr_exc_clear()`,
        `  call void @scr_gen_ret_to_out(ptr %g)`,
        `  br label %dropdummy`,
        `dropdummy:`,
      );
      if (ret.kind !== "void" && isRefCounted(ret)) {
        tr.push(`  call void ${releaseSym(this, ret)}(ptr %r) ; unwound: the never-read dummy`);
      }
      tr.push(`  br label %done`, `done:`, `  ret void`, `}`, ``);
      }
      out.push(...tr);

      // The never-started teardown: drop the packed (+1) arguments.
      const dr: string[] = [
        `define internal void @${mangleGenDrop(fn.name)}(ptr %ap) ${FN_ATTRS} {`,
        `entry:`,
      ];
      fieldTys.forEach((ty, i) => {
        const pType = lifted && i === 0 ? null : fn.params[lifted ? i - 1 : i]!.type;
        const refcounted = pType === null || isRefCounted(pType);
        if (!refcounted) return;
        dr.push(
          `  %dp${i} = getelementptr inbounds %${pack}, ptr %ap, i64 0, i32 ${i}`,
          `  %dv${i} = load ptr, ptr %dp${i}`,
        );
        if (pType === null) {
          this.declare(`declare void @scr_closure_release(ptr)`);
          dr.push(`  call void @scr_closure_release(ptr %dv${i})`);
        } else {
          dr.push(`  call void ${releaseSym(this, pType)}(ptr %dv${i})`);
        }
      });
      dr.push(`  call void @free(ptr %ap)`, `  ret void`, `}`, ``);
      out.push(...dr);

      // Spawn wrapper: pack the args (+1 moves in), allocate the
      // SUSPENDED fiber — nothing runs until the first .next().
      if (lifted) {
        this.declare(`declare ptr @scr_closure_retain_v(ptr)`);
      }
      const sp: string[] = [
        `define internal ptr @${mangleGenSpawn(fn.name)}(${spawnParams.join(", ")}) ${FN_ATTRS} { ; gen spawn ${fn.name}`,
        `entry:`,
        ...argPackLines,
      ];
      sp.push(
        `  %gg = call ptr @scr_gen_new(ptr @${mangleTrampoline(fn.name)}, ptr %ap, ptr @${mangleGenDrop(fn.name)})`,
        `  ret ptr %gg`,
        `}`,
        ``,
      );
      out.push(...sp);
    }
    return out;
  }

  // ── plumbing (the CEmitter frame/scope machinery, alloca-flavored) ──────

  internLiteral(text: string): string {
    let lit = this.literals.get(text);
    if (!lit) {
      lit = { sym: `sc_lit_${this.literals.size}`, len: Buffer.byteLength(text, "utf8") };
      this.literals.set(text, lit);
    }
    return `@${lit.sym}`;
  }

  /** Interned NUL-terminated C-string constant (the scr_jb_puts /
   * stringify-indent currency) — `@`-ref, first-use order. */
  cstr(text: string): string {
    let c = this.cstrs.get(text);
    if (!c) {
      c = { sym: `sc_cs_${this.cstrs.size}`, len: Buffer.byteLength(text, "utf8") };
      this.cstrs.set(text, c);
    }
    return `@${c.sym}`;
  }

  needBadTag(): void {
    this.needsBadTag = true;
  }

  /** The interned immortal instance for a UNIT arm of a union — asserts
   * the arm really is payload-less (undefined/null). Public: class
   * emission initializes undefined-admitting fields through it
   * (ClassHost). */
  unitInstanceRef(unionId: string, tag: number): string {
    const arm = this.unionsById.get(unionId)?.arms[tag];
    if (!arm || !isUnitType(arm)) {
      throw new InternalCompilerError(`llvm emitter bug: unit instance for non-unit arm ${tag} of ${unionId}`);
    }
    const key = `${unionId}:${tag}`;
    let sym = this.unitInstances.get(key);
    if (!sym) {
      sym = `sc_unit_${this.unitInstances.size}`;
      this.unitInstances.set(key, sym);
    }
    return `@${sym}`;
  }

  declare(decl: string): void {
    this.decls.add(decl);
  }

  needOom(): void {
    this.needsOom = true;
  }

  private currentFrame(): LlValue[] {
    const frame = this.frames[this.frames.length - 1];
    if (!frame) throw new InternalCompilerError("llvm emitter bug: no active statement frame");
    return frame;
  }

  /** Registers an owned refcounted value on the current statement frame. */
  private own(v: LlValue): LlValue {
    if (isRefCounted(v.type)) this.currentFrame().push(v);
    return v;
  }

  /** Registers a SLOT whose current contents the frame owns (conditional
   * results: optional chains, branch joins that park ownership). */
  private ownSlot(slot: string, type: IrType): void {
    if (isRefCounted(type)) this.currentFrame().push({ name: slot, type, slot: true });
  }

  /** Strike a refcounted temp from its frame: ownership is being moved. */
  private moveTemp(v: LlValue): void {
    if (!isRefCounted(v.type)) return;
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const idx = this.frames[i]!.findIndex((e) => e.name === v.name);
      if (idx >= 0) {
        this.frames[i]!.splice(idx, 1);
        return;
      }
    }
    throw new InternalCompilerError(`llvm emitter bug: moved temp ${v.name} not found in any frame`);
  }

  /** The retained (+1) read of a refcounted value — type-directed through
   * the `_v` table (immortals skip, exactly the C retain calls). */
  private retainValue(name: string, type: IrType): string {
    const t = this.B.tmp();
    this.B.line(`${t} = call ptr ${retainSym(this, type)}(ptr ${name})`);
    return t;
  }

  /** The release call for one owned refcounted value — type-directed like
   * releaseCallC (all runtime releases are NULL-tolerant). */
  private releaseValue(name: string, type: IrType): void {
    this.B.line(`call void ${releaseSym(this, type)}(ptr ${name})`);
  }

  private releaseFrame(frame: LlValue[]): void {
    for (const v of frame) {
      if (v.slot) {
        const t = this.B.tmp();
        this.B.line(`${t} = load ptr, ptr ${v.name}`);
        this.releaseValue(t, v.type);
      } else {
        this.releaseValue(v.name, v.type);
      }
    }
  }

  private releaseScope(scope: LlScopeEntry[]): void {
    for (const e of scope) {
      const t = this.B.tmp();
      this.B.line(`${t} = load ptr, ptr ${e.slot}`);
      if (e.boxed) {
        this.declare(`declare void @scr_box_release(ptr)`);
        this.B.line(`call void @scr_box_release(ptr ${t})`);
      } else {
        this.releaseValue(t, e.type); // runtime releases are NULL-tolerant
      }
    }
  }

  /** THE release-on-jump path (break/continue/return): pending statement
   * frames and entered scopes down to the given depths, innermost first —
   * everything whose normal fall-through releases the jump bypasses.
   * Ported verbatim from CEmitter.releaseForJump. */
  private releaseForJump(frameDepth: number, scopeDepth: number): void {
    for (let i = this.frames.length - 1; i >= frameDepth; i--) this.releaseFrame(this.frames[i]!);
    for (let i = this.scopes.length - 1; i >= scopeDepth; i--) this.releaseScope(this.scopes[i]!);
  }

  /** THE unwind path at a point where an exception is pending: release
   * everything between here and the innermost try handler — or the whole
   * function — and branch to the handler / return a dummy value (never
   * read: callers of a may-throw function test the pending flag before
   * using the result). Callers own the surrounding pending branch; a
   * `throw` unwinds unconditionally. CEmitter.emitUnwind, block-flavored. */
  private emitUnwind(): void {
    const target = this.tryStack[this.tryStack.length - 1];
    if (target) {
      this.releaseForJump(target.frameDepth, target.scopeDepth);
      target.used = true;
      this.B.terminate(`br label %${target.label}`);
      return;
    }
    this.releaseForJump(0, 0);
    if (this.currentWasiCoro !== null) {
      this.B.terminate(`br label %${this.currentWasiCoro.finalLabel}`);
      return;
    }
    const t = this.currentReturnType;
    if (t.kind === "void") this.B.terminate("ret void");
    else if (t.kind === "f64" || t.kind === "date") this.B.terminate(`ret double ${f64Lit(0)}`);
    else if (t.kind === "bool") this.B.terminate("ret i1 false");
    else this.B.terminate("ret ptr null");
  }

  /** The emitter contract for exceptions: after EVERY call that can throw
   * (per the may-throw analysis), test the pending flag and unwind. The
   * call's result temp must join its frame BEFORE this runs so the unwind
   * releases the dummy (NULL for refcounted kinds) harmlessly. */
  private emitPendingCheck(): void {
    const B = this.B;
    if (B.isTerminated()) return;
    this.declare(`declare zeroext i1 @scr_exc_pending()`);
    const p = B.tmp();
    B.line(`${p} = call zeroext i1 @scr_exc_pending()`);
    const lu = B.newLabel("exc.u");
    const lk = B.newLabel("exc.k");
    B.condBr(p, lu, lk);
    B.startBlock(lu);
    this.emitUnwind();
    B.startBlock(lk);
  }

  /** Moves an already-evaluated value into the runtime's exception cell —
   * the `throw` statement's kind dispatch (stmts.ts's), shared with
   * every synthetic thrower. Ownership of a refcounted payload must have
   * been moved off its frame by the caller. */
  private emitThrowValue(v: LlValue): void {
    const B = this.B;
    const t = v.type;
    if (t.kind === "date") {
      throw new InternalCompilerError("LLVM emitter bug: Date throw reached backend");
    } else if (t.kind === "f64") {
      this.declare(`declare void @scr_throw_f64(double)`);
      B.line(`call void @scr_throw_f64(double ${v.name})`);
    } else if (t.kind === "bool") {
      this.declare(`declare void @scr_throw_bool(i1 zeroext)`);
      B.line(`call void @scr_throw_bool(i1 ${v.name})`);
    } else if (t.kind === "string") {
      this.declare(`declare void @scr_throw_str(ptr)`);
      B.line(`call void @scr_throw_str(ptr ${v.name})`);
    } else if (t.kind === "object" && this.classMeta.get(t.className)?.hierarchy === true) {
      // Hierarchy instances carry a vtable word: the OBJ kind keeps the
      // dynamic class inspectable (catch-binding instanceof, the uncaught
      // printer's "name: message" for Error instances).
      const rc = vAdapters(this, t);
      this.declare(`declare void @scr_throw_obj(ptr, ptr, ptr, ptr)`);
      B.line(`call void @scr_throw_obj(ptr ${v.name}, ptr ${rc.retain}, ptr ${rc.release}, ptr ${traceArg(this, t)})`);
    } else {
      const rc = vAdapters(this, t);
      this.declare(`declare void @scr_throw_ref(ptr, ptr, ptr, ptr)`);
      B.line(`call void @scr_throw_ref(ptr ${v.name}, ptr ${rc.retain}, ptr ${rc.release}, ptr ${traceArg(this, t)})`);
    }
  }

  /** JS truthiness of a value (falsy: false, 0, -0, NaN, "", nullish
   * union arms): one fcmp for f64 (NaN and both zeros compare !one), a
   * length load for strings, an inline tag switch for unions, `!= null`
   * for the always-truthy object kinds (JS: [] and {} are truthy). */
  private truthy(v: LlValue): string {
    const B = this.B;
    if (v.type.kind === "union") {
      // The ARM value's ToBoolean: an inline tag switch (the C emitter's
      // per-union interned helper, emitted at the use site instead).
      const def = this.unionsById.get(v.type.unionId);
      if (!def) throw new InternalCompilerError(`llvm emitter bug: truthiness of unknown union ${v.type.unionId}`);
      const slot = B.slot();
      B.entryAllocas.push(`${slot} = alloca i1`);
      const join = B.newLabel("ut.j");
      this.unionTagSwitch(v.name, def, (arm) => {
        let valueName = "false";
        if (arm.kind === "f64") {
          valueName = B.tmp();
          this.declare(`declare double @scr_union_get_f64(ptr)`);
          B.line(`${valueName} = call double @scr_union_get_f64(ptr ${v.name})`);
        } else if (arm.kind === "bool") {
          valueName = B.tmp();
          this.declare(`declare zeroext i1 @scr_union_get_bool(ptr)`);
          B.line(`${valueName} = call zeroext i1 @scr_union_get_bool(ptr ${v.name})`);
        } else if (arm.kind === "string") {
          valueName = this.unionPeek(v.name);
        }
        const truthy = this.truthyOf(arm.kind, valueName, true);
        B.line(`store i1 ${truthy}, ptr ${slot}`);
        B.br(join);
      });
      B.startBlock(join);
      const t = B.tmp();
      B.line(`${t} = load i1, ptr ${slot}`);
      return t;
    }
    return this.truthyOf(v.type.kind, v.name, false);
  }

  /** Emit truthiness for one non-union kind. Union arms are known-present,
   * so object kinds become the constant true instead of a pointer test. */
  private truthyOf(kind: IrType["kind"], valueName: string, unionArm: boolean): string {
    const B = this.B;
    switch (kind) {
      case "undefinedT":
      case "nullT":
        if (!unionArm) throw new LlvmUnsupportedError(`truthy:${kind}`);
        return "false";
      case "bool":
        return valueName;
      case "f64":
      case "procStream": {
        if (unionArm && kind === "procStream") throw new LlvmUnsupportedError(`truthy:union:${kind}`);
        const truthy = B.tmp();
        B.line(`${truthy} = fcmp one double ${valueName}, ${f64Lit(0)}`);
        return truthy;
      }
      case "string": {
        const lenp = B.tmp();
        const len = B.tmp();
        const truthy = B.tmp();
        B.line(`${lenp} = getelementptr inbounds %ScrStr, ptr ${valueName}, i64 0, i32 1`);
        B.line(`${len} = load ${this.sizeType}, ptr ${lenp}`);
        B.line(`${truthy} = icmp ne ${this.sizeType} ${len}, 0`);
        return truthy;
      }
      case "date":
        return "true";
      case "array": case "record": case "object": case "classval": case "func":
      case "map": case "set": case "symbol": case "regex": case "promise": case "bytes":
      case "url": case "searchParams": case "stats": case "fileHandle": case "spawnRes":
      case "child": case "childStream": case "generator": case "fsWatcher": {
        if (unionArm) return "true";
        const truthy = B.tmp();
        B.line(`${truthy} = icmp ne ptr ${valueName}, null`);
        return truthy;
      }
      case "dyn": {
        if (unionArm) throw new LlvmUnsupportedError(`truthy:union:${kind}`);
        this.declare(`declare zeroext i1 @scr_dyn_truthy(ptr)`);
        const truthy = B.tmp();
        B.line(`${truthy} = call zeroext i1 @scr_dyn_truthy(ptr ${valueName})`);
        return truthy;
      }
      case "jsval": {
        if (unionArm) throw new LlvmUnsupportedError(`truthy:union:${kind}`);
        this.declare(`declare i32 @scr_jsval_truthy(ptr)`);
        const raw = B.tmp();
        const truthy = B.tmp();
        B.line(`${raw} = call i32 @scr_jsval_truthy(ptr ${valueName})`);
        B.line(`${truthy} = icmp ne i32 ${raw}, 0`);
        return truthy;
      }
      default:
        throw new LlvmUnsupportedError(`truthy:${unionArm ? "union:" : ""}${kind}`);
    }
  }

  // ── union plumbing ──────────────────────────────────────────────────────

  /** Loads a union box's tag (i32). */
  private unionTag(uName: string): string {
    const p = this.B.tmp();
    const t = this.B.tmp();
    this.B.line(`${p} = getelementptr inbounds %ScrUnion, ptr ${uName}, i64 0, i32 1`);
    this.B.line(`${t} = load i32, ptr ${p}`);
    return t;
  }

  /** The BORROWED payload pointer of a ref arm (scr_union_peek inlined —
   * the runtime's is a static inline). */
  private unionPeek(uName: string): string {
    const p = this.B.tmp();
    const t = this.B.tmp();
    this.B.line(`${p} = getelementptr inbounds %ScrUnion, ptr ${uName}, i64 0, i32 5`);
    this.B.line(`${t} = load ptr, ptr ${p}`);
    return t;
  }

  /** Emits `switch` over a union's tag with one block per arm; each arm
   * body must TERMINATE its block (the callers branch to a join). The
   * default block is the C emitter's invalid-tag abort. */
  private unionTagSwitch(uName: string, def: IrUnionDef, arm: (armType: IrType, tag: number) => void): void {
    const B = this.B;
    const tag = this.unionTag(uName);
    const bad = B.newLabel("u.bad");
    const labels = def.arms.map(() => B.newLabel("u.a"));
    B.terminate(
      `switch i32 ${tag}, label %${bad} [ ${def.arms.map((_, i) => `i32 ${i}, label %${labels[i]}`).join(" ")} ]`,
    );
    def.arms.forEach((a, i) => {
      B.startBlock(labels[i]!);
      arm(a, i);
    });
    B.startBlock(bad);
    this.needsBadTag = true;
    B.line(`call void @sc_bad_tag()`);
    B.terminate(`unreachable`);
  }

  /** The +1 extraction of a union's single narrowed arm (unionNarrow /
   * the nullish-family reads): scalars via the runtime getters, ref arms
   * a retained peek. */
  private unionExtract(uName: string, arm: IrType): string {
    const B = this.B;
    if (arm.kind === "f64") {
      const t = B.tmp();
      this.declare(`declare double @scr_union_get_f64(ptr)`);
      B.line(`${t} = call double @scr_union_get_f64(ptr ${uName})`);
      return t;
    }
    if (arm.kind === "bool") {
      const t = B.tmp();
      this.declare(`declare zeroext i1 @scr_union_get_bool(ptr)`);
      B.line(`${t} = call zeroext i1 @scr_union_get_bool(ptr ${uName})`);
      return t;
    }
    return this.retainValue(this.unionPeek(uName), arm);
  }

  /** Constructs a union box around an OWNED (+1, already moved) value —
   * the scr_union_new_* dispatch of unionWrap and the wrap-into-join
   * sites (shift). */
  private unionNewOwned(tag: number, v: LlValue): string {
    const B = this.B;
    const t = B.tmp();
    if (v.type.kind === "f64") {
      this.declare(`declare ptr @scr_union_new_f64(i32, double)`);
      B.line(`${t} = call ptr @scr_union_new_f64(i32 ${tag}, double ${v.name})`);
      return t;
    }
    if (v.type.kind === "bool") {
      this.declare(`declare ptr @scr_union_new_bool(i32, i1 zeroext)`);
      B.line(`${t} = call ptr @scr_union_new_bool(i32 ${tag}, i1 ${v.name})`);
      return t;
    }
    const rc = vAdapters(this, v.type);
    this.declare(`declare ptr @scr_union_new_ref(i32, ptr, ptr, ptr, ptr)`);
    B.line(
      `${t} = call ptr @scr_union_new_ref(i32 ${tag}, ptr ${v.name}, ptr ${rc.retain}, ptr ${rc.release}, ptr ${traceArg(this, v.type)})`,
    );
    return t;
  }

  // ── class plumbing ──────────────────────────────────────────────────────

  private classMetaOf(className: string): LlClassMeta {
    const meta = this.classMeta.get(className);
    if (!meta) throw new InternalCompilerError(`llvm emitter bug: unknown class ${className}`);
    return meta;
  }

  /** The field-slot pointer of a class member: rc at 0, the vtable word at
   * 1 on hierarchy members, then the flattened field list. Runtime error
   * classes GEP through %ScrError (their structs live in the runtime; the
   * def's [name, message, %code] order matches the layout). */
  private classFieldPtr(objName: string, className: string, field: string): { ptr: string; type: IrType } {
    const meta = this.classMetaOf(className);
    const { index, type } = classFieldIndex(meta, field);
    const p = this.B.tmp();
    this.B.line(
      `${p} = getelementptr inbounds %${classStructSym(className)}, ptr ${objName}, i64 0, i32 ${index}`,
    );
    return { ptr: p, type };
  }

  /** `o->vt->pre` — the dynamic class's preorder number (borrowed object;
   * the static class names which struct spelling carries the vt word). */
  private loadVtPre(objName: string, staticClassName: string): string {
    const B = this.B;
    const vtp = B.tmp();
    const vt = B.tmp();
    const prep = B.tmp();
    const pre = B.tmp();
    B.line(`${vtp} = getelementptr inbounds %${classStructSym(staticClassName)}, ptr ${objName}, i64 0, i32 1`);
    B.line(`${vt} = load ptr, ptr ${vtp}`);
    B.line(`${prep} = getelementptr inbounds %ScrVt, ptr ${vt}, i64 0, i32 0`);
    B.line(`${pre} = load ${this.sizeType}, ptr ${prep}`);
    return pre;
  }

  /** The class object's static symbol (classes as values), registering it
   * for assembly on first use and interning the .name literal while the
   * table is still open (the regex-literal discipline). */
  private classObjSym(className: string): string {
    if (!this.classObjs.has(className)) {
      const meta = this.classMetaOf(className);
      this.classObjs.set(className, { nameSym: this.internLiteral(meta.def.jsName ?? "") });
    }
    return mangleClassObj(className);
  }

  // ── record plumbing ─────────────────────────────────────────────────────

  private recordShape(shapeId: string): IrRecordShape {
    const shape = this.recordsById.get(shapeId);
    if (!shape) throw new InternalCompilerError(`llvm emitter bug: unknown record shape ${shapeId}`);
    return shape;
  }

  /** The field-slot pointer of a record member (rc header at index 0). */
  private recordFieldPtr(objName: string, shapeId: string, field: string): { ptr: string; type: IrType } {
    const shape = this.recordShape(shapeId);
    const idx = shape.fields.findIndex((f) => f.name === field);
    if (idx < 0) throw new InternalCompilerError(`llvm emitter bug: unknown field ${field} on shape ${shapeId}`);
    const p = this.B.tmp();
    this.B.line(
      `${p} = getelementptr inbounds %${mangleRecordStruct(shapeId)}, ptr ${objName}, i64 0, i32 ${idx + 1}`,
    );
    return { ptr: p, type: shape.fields[idx]!.type };
  }

  /** The overflow map's slot pointer on an index-signature shape. */
  private recordOvfPtr(objName: string, shapeId: string): string {
    const shape = this.recordShape(shapeId);
    if (!shape.indexValue) throw new InternalCompilerError(`llvm emitter bug: shape ${shapeId} has no overflow map`);
    const p = this.B.tmp();
    const v = this.B.tmp();
    this.B.line(
      `${p} = getelementptr inbounds %${mangleRecordStruct(shapeId)}, ptr ${objName}, i64 0, i32 ${shape.fields.length + 1}`,
    );
    this.B.line(`${v} = load ptr, ptr ${p}`);
    return v;
  }

  /** Loads a record field (i8-stored bools trunc to i1). */
  private loadField(ptr: string, t: IrType): string {
    const B = this.B;
    const fieldTy = llFieldType(t);
    const raw = B.tmp();
    B.line(`${raw} = load ${fieldTy}, ptr ${ptr}`);
    if (fieldTy !== "i8") return raw;
    const b = B.tmp();
    B.line(`${b} = trunc i8 ${raw} to i1`);
    return b;
  }

  /** Stores a record field (i1 zext to the i8 storage). */
  private storeField(ptr: string, t: IrType, value: string): void {
    const B = this.B;
    const fieldTy = llFieldType(t);
    if (fieldTy !== "i8") {
      B.line(`store ${fieldTy} ${value}, ptr ${ptr}`);
      return;
    }
    const z = B.tmp();
    B.line(`${z} = zext i1 ${value} to i8`);
    B.line(`store i8 ${z}, ptr ${ptr}`);
  }

  // ── bindings ────────────────────────────────────────────────────────────

  /** A binding's storage: a module global, a plain local slot, or a boxed
   * local (the slot holds the capture BOX; access goes through it). */
  private binding(id: string): { kind: "global" | "local" | "boxed"; slot: string; type: IrType; local?: IrLocal } {
    const local = this.currentLocals.get(id);
    if (local) {
      return {
        kind: local.boxed ? "boxed" : "local",
        slot: `%${mangleLocal(id)}`,
        type: local.type,
        local,
      };
    }
    const g = this.globalTypes.get(id);
    if (!g) throw new InternalCompilerError(`llvm emitter bug: unknown binding ${id}`);
    return { kind: "global", slot: `@${mangleGlobal(id)}`, type: g };
  }

  /** Loads a boxed binding's box pointer out of its slot. */
  private loadBox(slot: string): string {
    const b = this.B.tmp();
    this.B.line(`${b} = load ptr, ptr ${slot}`);
    return b;
  }

  private boxGet(box: string, t: IrType): string {
    const B = this.B;
    const acc = boxAccess(t);
    const r = B.tmp();
    if (acc === "f64") {
      this.declare(`declare double @scr_box_get_f64(ptr)`);
      B.line(`${r} = call double @scr_box_get_f64(ptr ${box})`);
    } else if (acc === "bool") {
      this.declare(`declare zeroext i1 @scr_box_get_bool(ptr)`);
      B.line(`${r} = call zeroext i1 @scr_box_get_bool(ptr ${box})`);
    } else {
      this.declare(`declare ptr @scr_box_get_ref(ptr)`);
      B.line(`${r} = call ptr @scr_box_get_ref(ptr ${box})`); // returns +1
    }
    return r;
  }

  /** scr_box_set_* — the ref form takes ownership of the passed value. */
  private boxSet(box: string, t: IrType, value: string): void {
    const B = this.B;
    const acc = boxAccess(t);
    if (acc === "f64") {
      this.declare(`declare void @scr_box_set_f64(ptr, double)`);
      B.line(`call void @scr_box_set_f64(ptr ${box}, double ${value})`);
    } else if (acc === "bool") {
      this.declare(`declare void @scr_box_set_bool(ptr, i1 zeroext)`);
      B.line(`call void @scr_box_set_bool(ptr ${box}, i1 ${value})`);
    } else {
      this.declare(`declare void @scr_box_set_ref(ptr, ptr)`);
      B.line(`call void @scr_box_set_ref(ptr ${box}, ptr ${value})`);
    }
  }

  private retainBox(box: string): string {
    this.needsRetainBox = true;
    const t = this.B.tmp();
    this.B.line(`${t} = call ptr @sc_retain_box(ptr ${box})`);
    return t;
  }

  /** The initializing write of a scalar TDZ box: mint the one-element
   * array cell holding the value and move it into the ARR-kind box
   * (set_ref releases nothing — the slot was the empty sentinel). */
  private tdzScalarInit(box: string, t: IrType, value: string): void {
    const B = this.B;
    const acc = boxAccess(t);
    const cell = B.tmp();
    B.line(`${cell} = ${arrNewCall(this, t, "1")} ; TDZ cell`);
    this.arrPush(cell, acc === "bool" ? "bool" : "f64", value);
    this.declare(`declare void @scr_box_set_ref(ptr, ptr)`);
    B.line(`call void @scr_box_set_ref(ptr ${box}, ptr ${cell})`);
  }

  /** The TDZ-guarded read of a boxed binding: an empty payload slot is
   * the temporal dead zone — throw Node's exact catchable ReferenceError
   * (exprs.ts's varRef guard). Scalars then peek the one-element
   * array cell; ref kinds read the box normally (+1). */
  private tdzBoxRead(box: string, t: IrType, name: string): string {
    const B = this.B;
    const slotp = B.tmp();
    const slotv = B.tmp();
    const empty = B.tmp();
    B.line(`${slotp} = getelementptr inbounds %ScrBox, ptr ${box}, i64 0, i32 5`);
    B.line(`${slotv} = load i64, ptr ${slotp}`);
    B.line(`${empty} = icmp eq i64 ${slotv}, 0`);
    const lt = B.newLabel("tdz.t");
    const lk = B.newLabel("tdz.k");
    B.condBr(empty, lt, lk);
    B.startBlock(lt);
    // Interned literals are immortal (rc SIZE_MAX), so handing them to
    // the ownership-taking thrower is safe.
    const errName = this.internLiteral("ReferenceError");
    const msg = this.internLiteral(`Cannot access '${name}' before initialization`);
    this.declare(`declare void @scr_throw_error_named(ptr, ptr)`);
    B.line(`call void @scr_throw_error_named(ptr ${errName}, ptr ${msg})`);
    this.emitUnwind();
    B.startBlock(lk);
    const acc = boxAccess(t);
    if (acc === "ref") return this.boxGet(box, t);
    // The scalar cell peek: the box keeps the array alive, so no
    // retain/release pair is needed for the copied-out scalar.
    const cell = B.tmp();
    B.line(`${cell} = inttoptr i64 ${slotv} to ptr`);
    const accTy = acc === "bool" ? "i1" : "double";
    this.declare(`declare ${acc === "bool" ? "zeroext i1" : accTy} @scr_arr_get_${acc}(ptr, double)`);
    const v = B.tmp();
    B.line(`${v} = call ${accTy} @scr_arr_get_${acc}(ptr ${cell}, double ${f64Lit(0)})`);
    return v;
  }

  // ── functions ───────────────────────────────────────────────────────────

  /** The LLVM symbol a direct call or closure enters a function through:
   * async bodies are entered via their emitted spawn wrapper (which runs
   * the fiber eagerly to its first suspension and returns the promise);
   * generator bodies via theirs (which only ALLOCATES the suspended
   * fiber and returns the generator object) — CEmitter.callTargetC. */
  private callTarget(fnName: string): string {
    const fn = this.fnByName.get(fnName);
    if (fn?.async === true) return mangleAsyncSpawn(fnName);
    if (fn?.generator !== undefined) return mangleGenSpawn(fnName);
    return mangleFunction(fnName);
  }

  /** Queue the current wasm coroutine and suspend it. The runtime decides
   * whether the promise waiter list or the ready FIFO owns the continuation;
   * LLVM keeps all live locals in the coroutine frame. */
  private emitWasiSuspend(promise: string | null): void {
    const coro = this.currentWasiCoro;
    if (coro === null) throw new InternalCompilerError("llvm emitter bug: wasm suspension outside async body");
    if (promise === null) {
      this.declare(`declare void @scr_wasi_await_hop_prepare(ptr)`);
      this.B.line(`call void @scr_wasi_await_hop_prepare(ptr ${coro.self})`);
    } else {
      this.declare(`declare void @scr_wasi_await_prepare(ptr, ptr)`);
      this.B.line(`call void @scr_wasi_await_prepare(ptr ${coro.self}, ptr ${promise})`);
    }
    this.emitWasiSuspendPrepared();
  }

  /** Suspend after a target-specific runtime helper already queued the
   * continuation (used by module awaits, which skip the hop when settled). */
  private emitWasiSuspendPrepared(): void {
    const coro = this.currentWasiCoro;
    if (coro === null) throw new InternalCompilerError("llvm emitter bug: wasm suspension outside async body");
    const save = this.B.tmp();
    const state = this.B.tmp();
    const resume = this.B.newLabel("coro.resume");
    this.B.line(`${save} = call token @llvm.coro.save(ptr ${coro.handle})`);
    this.B.line(`${state} = call i8 @llvm.coro.suspend(token ${save}, i1 false)`);
    this.B.terminate(
      `switch i8 ${state}, label %${coro.suspendLabel} [ i8 0, label %${resume} i8 1, label %${coro.cleanupLabel} ]`,
    );
    this.B.startBlock(resume);
  }

  /** Move a clean async return value into the current fiber's promise. */
  private emitWasiFulfill(v: LlValue | null): void {
    const coro = this.currentWasiCoro;
    if (coro === null) throw new InternalCompilerError("llvm emitter bug: wasm fulfillment outside async body");
    const ret = this.currentReturnType;
    if (coro.kind === "generator") {
      this.declare(`declare ptr @scr_gen_of_fiber(ptr)`);
      const gen = this.B.tmp();
      this.B.line(`${gen} = call ptr @scr_gen_of_fiber(ptr ${coro.self})`);
      switch (ret.kind) {
        case "void":
          return;
        case "f64":
        case "date":
          this.declare(`declare void @scr_gen_out_f64(ptr, double)`);
          this.B.line(`call void @scr_gen_out_f64(ptr ${gen}, double ${v!.name})`);
          return;
        case "bool":
          this.declare(`declare void @scr_gen_out_bool(ptr, i1 zeroext)`);
          this.B.line(`call void @scr_gen_out_bool(ptr ${gen}, i1 ${v!.name})`);
          return;
        default:
          this.declare(`declare void @scr_gen_out_ref(ptr, ptr, ptr)`);
          this.B.line(`call void @scr_gen_out_ref(ptr ${gen}, ptr ${v!.name}, ptr ${vAdapters(this, ret).release})`);
          return;
      }
    }
    this.declare(`declare ptr @scr_fiber_promise(ptr)`);
    const pr = this.B.tmp();
    this.B.line(`${pr} = call ptr @scr_fiber_promise(ptr ${coro.self})`);
    switch (ret.kind) {
      case "void":
        this.declare(`declare void @scr_promise_fulfill_void(ptr)`);
        this.B.line(`call void @scr_promise_fulfill_void(ptr ${pr})`);
        break;
      case "f64":
      case "date":
        this.declare(`declare void @scr_promise_fulfill_f64(ptr, double)`);
        this.B.line(`call void @scr_promise_fulfill_f64(ptr ${pr}, double ${v!.name})`);
        break;
      case "bool":
        this.declare(`declare void @scr_promise_fulfill_bool(ptr, i1 zeroext)`);
        this.B.line(`call void @scr_promise_fulfill_bool(ptr ${pr}, i1 ${v!.name})`);
        break;
      case "string":
        this.declare(`declare void @scr_promise_fulfill_str(ptr, ptr)`);
        this.B.line(`call void @scr_promise_fulfill_str(ptr ${pr}, ptr ${v!.name}) ; moves in`);
        break;
      default: {
        const rc = vAdapters(this, ret);
        this.declare(`declare void @scr_promise_fulfill_ref(ptr, ptr, ptr, ptr, ptr)`);
        this.B.line(
          `call void @scr_promise_fulfill_ref(ptr ${pr}, ptr ${v!.name}, ptr ${rc.retain}, ptr ${rc.release}, ptr ${traceArg(this, ret)})`,
        );
      }
    }
  }

  private emitFunction(fn: IrFunction): string {
    const B = new BlockBuilder();
    this.B = B;
    this.frames = [];
    this.scopes = [];
    this.jumpTargets = [];
    this.currentLocals = new Map(fn.locals.map((l) => [l.id, l]));
    this.captureIds = new Set((fn.captures ?? []).map((c) => c.localId));
    this.integerLoopBindings.clear();
    this.chainSlots.clear();
    this.finallyStack = [];
    this.tryStack = [];
    this.currentReturnType = fn.returnType;
    this.currentGenerator = fn.generator ?? null;
    this.currentWasiCoro = null;
    this.logArgSlots = 0;

    if (this.wasi && (fn.async === true || fn.generator !== undefined)) {
      this.declare(`declare token @llvm.coro.id(i32, ptr, ptr, ptr)`);
      this.declare(`declare ${this.sizeType} @llvm.coro.size.${this.sizeType}()`);
      this.declare(`declare ptr @llvm.coro.begin(token, ptr)`);
      this.declare(`declare token @llvm.coro.save(ptr)`);
      this.declare(`declare i8 @llvm.coro.suspend(token, i1)`);
      this.declare(`declare ptr @llvm.coro.free(token, ptr)`);
      this.declare(`declare i1 @llvm.coro.end(ptr, i1, token)`);
      this.declare(`declare ptr @malloc(${this.sizeType})`);
      this.declare(`declare void @free(ptr)`);
      this.declare(`declare void @scr_wasi_coro_started(ptr)`);
      this.declare(`declare ptr @scr_fiber_self()`);
      const id = B.tmp();
      const size = B.tmp();
      const mem = B.tmp();
      const handle = B.tmp();
      const self = B.tmp();
      B.line(`${id} = call token @llvm.coro.id(i32 0, ptr null, ptr null, ptr null)`);
      B.line(`${size} = call ${this.sizeType} @llvm.coro.size.${this.sizeType}()`);
      B.line(`${mem} = call ptr @malloc(${this.sizeType} ${size})`);
      B.line(`${handle} = call ptr @llvm.coro.begin(token ${id}, ptr ${mem})`);
      B.line(`call void @scr_wasi_coro_started(ptr ${handle})`);
      B.line(`${self} = call ptr @scr_fiber_self()`);
      this.currentWasiCoro = {
        kind: fn.async === true ? "async" : "generator",
        id,
        handle,
        self,
        finalLabel: B.newLabel("coro.final"),
        cleanupLabel: B.newLabel("coro.cleanup"),
        suspendLabel: B.newLabel("coro.suspend"),
      };
    }

    const paramIds = new Set(fn.params.map((p) => p.localId));
    for (const local of fn.locals) {
      // Boxed locals' slots hold their capture BOX (a ptr); captured
      // (env-borrowed) locals bind the incoming box below. A caught-typed
      // local is a catch binding: its slot holds the ScrCaught snapshot
      // box the catch prologue takes (scr_exc_take).
      const slotTy =
        local.boxed || this.captureIds.has(local.id) || local.type.kind === "caught"
          ? "ptr"
          : this.llType(local.type);
      B.entryAllocas.push(`%${mangleLocal(local.id)} = alloca ${slotTy} ; ${local.name}`);
      // Refcounted/boxed locals start NULL (the C prologue's `= NULL`):
      // scope-exit releases run whether or not an assign ever did.
      if (paramIds.has(local.id) || this.captureIds.has(local.id)) continue;
      if (local.boxed || isRefCounted(local.type)) {
        B.line(`store ptr null, ptr %${mangleLocal(local.id)}`);
      }
    }
    // Captured bindings come in through the environment — borrowed for the
    // whole call (the closure owns them): bound here, never released here.
    (fn.captures ?? []).forEach((c, i) => {
      const caps = B.tmp();
      const p = B.tmp();
      const box = B.tmp();
      B.line(`${caps} = getelementptr inbounds %ScrClosure, ptr %sc_env, i64 1 ; caps`);
      B.line(`${p} = getelementptr inbounds ptr, ptr ${caps}, ${this.sizeType} ${i} ; caps[${i}]`);
      B.line(`${box} = load ptr, ptr ${p}`);
      B.line(`store ptr ${box}, ptr %${mangleLocal(c.localId)} ; captured ${c.name}`);
    });
    // Params spill into their slots; the function scope owns refcounted
    // params (callees own their params — callers passed +1). Boxed params
    // allocate the shared binding and move the raw value in.
    const fnScope: LlScopeEntry[] = [];
    for (const p of fn.params) {
      const local = this.currentLocals.get(p.localId)!;
      const slot = `%${mangleLocal(p.localId)}`;
      if (local.boxed) {
        const box = B.tmp();
        B.line(`${box} = ${boxNewCall(this, p.type)} ; ${p.name} (boxed param)`);
        this.boxSet(box, p.type, `%p_${mangleLocal(p.localId)}`);
        B.line(`store ptr ${box}, ptr ${slot}`);
        fnScope.push({ slot, type: p.type, boxed: true });
        continue;
      }
      B.line(`store ${this.llType(p.type)} %p_${mangleLocal(p.localId)}, ptr ${slot}`);
      if (isRefCounted(p.type)) fnScope.push({ slot, type: p.type });
    }
    this.scopes.push(fnScope);
    this.emitStmts(fn.body);
    // Implicit exit of a void function: release the function scope unless
    // the body already terminated its final block (return, or a throw
    // whose unwind released everything down to depth 0).
    if (fn.returnType.kind === "void" && !B.isTerminated()) {
      this.releaseScope(this.scopes[0]!);
      if (this.currentWasiCoro !== null) {
        this.emitWasiFulfill(null);
        B.terminate(`br label %${this.currentWasiCoro.finalLabel}`);
      } else {
        B.terminate("ret void");
      }
    }
    this.scopes.pop();

    const coro = this.currentWasiCoro;
    if (coro !== null) {
      B.startBlock(coro.finalLabel);
      if (fn.captures !== undefined) {
        this.declare(`declare void @scr_closure_release(ptr)`);
        B.line(`call void @scr_closure_release(ptr %sc_env)`);
      }
      if (coro.kind === "generator") {
        this.declare(`declare void @scr_wasi_gen_finish(ptr)`);
        B.line(`call void @scr_wasi_gen_finish(ptr ${coro.self})`);
      } else {
        this.declare(`declare void @scr_wasi_async_finish(ptr)`);
        B.line(`call void @scr_wasi_async_finish(ptr ${coro.self})`);
      }
      const finalState = B.tmp();
      B.line(`${finalState} = call i8 @llvm.coro.suspend(token none, i1 true)`);
      B.terminate(
        `switch i8 ${finalState}, label %${coro.suspendLabel} [ i8 1, label %${coro.cleanupLabel} ]`,
      );
      B.startBlock(coro.cleanupLabel);
      const frame = B.tmp();
      B.line(`${frame} = call ptr @llvm.coro.free(token ${coro.id}, ptr ${coro.handle})`);
      B.line(`call void @free(ptr ${frame})`);
      B.br(coro.suspendLabel);
      B.startBlock(coro.suspendLabel);
      const ended = B.tmp();
      B.line(`${ended} = call i1 @llvm.coro.end(ptr ${coro.handle}, i1 false, token none)`);
      const ret = this.llType(fn.returnType);
      if (ret === "void") B.terminate(`ret void`);
      else if (ret === "double") B.terminate(`ret double ${f64Lit(0)}`);
      else if (ret === "i1") B.terminate(`ret i1 false`);
      else B.terminate(`ret ptr null`);
    }

    if (this.logArgSlots > 0) {
      B.entryAllocas.push(`%logargs = alloca [${this.logArgSlots} x %ScrLogArg]`);
    }
    const params = fn.params.map((p) => `${this.llType(p.type)} %p_${mangleLocal(p.localId)}`);
    // Lifted functions receive their closure first (the callValue ABI).
    if (fn.captures !== undefined) params.unshift("ptr %sc_env");
    const ret = this.llType(fn.returnType);
    const attrs = coro !== null ? "#1" : FN_ATTRS;
    return `define internal ${ret} @${mangleFunction(fn.name)}(${params.join(", ")}) ${attrs} { ; ${fn.name}\n${B.render()}\n}`;
  }

  // ── statements ──────────────────────────────────────────────────────────

  private emitStmts(stmts: IrStmt[]): void {
    for (const s of stmts) {
      // Statements after a terminator are unreachable (dead code after
      // return/break/continue) — the C emitter emits them as dead C; here
      // they are skipped so no dropped SSA definition can leak forward.
      if (this.B.isTerminated()) return;
      this.emitStmt(s);
    }
  }

  /** Emits a block in its own lexical scope (refcounted locals released at
   * end) — CEmitter.emitBlock without the braces. `setup` runs after the
   * scope opens, before the statements — the catch-binding hook: it may
   * emit prelude lines and register entries the scope owns (released on
   * every exit, jumps and unwinds included). */
  private emitBlock(stmts: IrStmt[], setup?: (scope: LlScopeEntry[]) => void): void {
    const scope: LlScopeEntry[] = [];
    this.scopes.push(scope);
    setup?.(scope);
    this.emitStmts(stmts);
    const ended = endsWithJump(stmts);
    this.scopes.pop();
    if (!ended) this.releaseScope(scope);
  }

  private emitStmt(s: IrStmt): void {
    const B = this.B;
    this.frames.push([]);
    switch (s.kind) {
      case "varDecl": {
        const b = this.binding(s.localId);
        if (b.kind === "boxed") {
          // Box FIRST, then evaluate the initializer: a named function
          // expression's closure captures this box during init evaluation.
          // A SCALAR TDZ box rides an ARR-kind box: the value lives in a
          // one-element array cell, so the empty (NULL) slot stays the
          // not-yet-initialized sentinel — a raw scalar slot has no spare
          // bit pattern to spend on it (stmts.ts's varDecl).
          const boxNew =
            b.local!.tdz === true && boxAccess(b.type) !== "ref"
              ? (this.declare(`declare ptr @scr_box_new(i32)`), `call ptr @scr_box_new(i32 3)`)
              : boxNewCall(this, b.type);
          const box = B.tmp();
          B.line(`${box} = ${boxNew} ; let ${b.local!.name} (boxed)`);
          B.line(`store ptr ${box}, ptr ${b.slot}`);
          this.scopes[this.scopes.length - 1]!.push({ slot: b.slot, type: b.type, boxed: true });
          if (s.init === null) break;
          const v = this.emitExpr(s.init);
          if (isRefCounted(v.type)) this.moveTemp(v); // the box takes ownership
          if (b.local!.tdz === true && boxAccess(b.type) !== "ref") {
            this.tdzScalarInit(box, b.type, v.name);
          } else {
            this.boxSet(box, b.type, v.name);
          }
          break;
        }
        if (s.init === null) {
          // Declared, uninitialized (`let x: number;`): reset the slot —
          // inside a loop the previous iteration's scope exit released the
          // old value and left a stale pointer (NULL-tolerant releases).
          if (isRefCounted(b.type)) {
            B.line(`store ptr null, ptr ${b.slot}`);
            this.scopes[this.scopes.length - 1]!.push({ slot: b.slot, type: b.type });
          }
          break;
        }
        const v = this.emitExpr(s.init);
        this.moveTemp(v);
        B.line(`store ${this.llType(b.type)} ${v.name}, ptr ${b.slot}`);
        if (isRefCounted(b.type)) {
          this.scopes[this.scopes.length - 1]!.push({ slot: b.slot, type: b.type });
        }
        break;
      }
      case "assign": {
        const concat = s.value;
        const suffix = matchStringSelfConcat(s.localId, concat);
        if (suffix && concat.kind === "strConcat") {
          this.emitStringSelfConcatAssign(s.localId, concat.left, suffix, false);
          break;
        }
        const b = this.binding(s.localId);
        const v = this.emitExpr(s.value);
        if (b.kind === "boxed") {
          if (isRefCounted(v.type)) this.moveTemp(v); // set_ref releases the old value
          // A scalar TDZ box (forward-captured const): the initializing
          // write mints the one-element array cell — set_ref moves it in
          // (and the empty-slot sentinel ends here).
          if (b.local!.tdz === true && boxAccess(b.type) !== "ref") {
            this.tdzScalarInit(this.loadBox(b.slot), b.type, v.name);
            break;
          }
          this.boxSet(this.loadBox(b.slot), b.type, v.name);
          break;
        }
        this.moveTemp(v);
        if (isRefCounted(b.type)) {
          const old = B.tmp();
          B.line(`${old} = load ptr, ptr ${b.slot}`);
          this.releaseValue(old, b.type);
        }
        B.line(`store ${this.llType(b.type)} ${v.name}, ptr ${b.slot}`);
        break;
      }
      case "exprStmt":
        this.emitExpr(s.expr);
        break;
      case "arraySet": {
        // Evaluation order matches JS: array, index, then value. Ownership
        // of a refcounted value moves into the array (the runtime releases
        // the replaced element itself).
        const arr = this.emitExpr(s.arr);
        const idx = this.emitExpr(s.index);
        const v = this.emitExpr(s.value);
        if (s.arr.type.kind !== "array") throw new InternalCompilerError("llvm emitter bug: arraySet on non-array");
        const acc = elemAccess(s.arr.type.elem);
        if (acc === "ref") this.moveTemp(v);
        const argTy = acc === "f64" ? "double" : acc === "bool" ? "i1" : "ptr";
        this.declare(`declare void @scr_arr_set_${acc}(ptr, double, ${argTy === "i1" ? "i1 zeroext" : argTy})`);
        B.line(`call void @scr_arr_set_${acc}(ptr ${arr.name}, double ${idx.name}, ${argTy} ${v.name})`);
        break;
      }
      case "bytesSet": {
        // Typed-array element write: same evaluation order as arraySet;
        // the value is a scalar (the kind-specific inline path coerces
        // JS-exactly), so no ownership moves. Any invalid index traps — no
        // append. IrBytesElem is static, so never rediscover it through the
        // generic runtime switch in a hot loop.
        const arr = this.emitBytesReceiver(s.arr, [s.index, s.value]);
        const integerIndex = this.emitIntegerLoopIndex(s.index);
        const idx = integerIndex ?? this.emitExpr(s.index).name;
        const v = this.emitExpr(s.value);
        if (s.arr.type.kind !== "bytes") throw new InternalCompilerError("llvm emitter bug: bytesSet on non-bytes");
        this.emitBytesSet(s.arr.type.elem, arr.name, idx, v.name, integerIndex !== null);
        break;
      }
      case "fieldSet":
      case "recordSet": {
        // Evaluation order: obj, then value. New value moved in; the old
        // value is released AFTER the field is overwritten (unlink-then-
        // release — a release can trigger a cycle collection, which must
        // never see a heap edge whose count was already given up).
        // Classes and records share the struct layout, so one emission.
        const obj = this.emitExpr(s.obj);
        const v = this.emitExpr(s.value);
        const { ptr, type } =
          s.kind === "fieldSet"
            ? this.classFieldPtr(obj.name, s.className, s.field)
            : this.recordFieldPtr(obj.name, s.shapeId, s.field);
        if (isRefCounted(type)) {
          this.moveTemp(v);
          const old = B.tmp();
          B.line(`${old} = load ptr, ptr ${ptr}`);
          this.storeField(ptr, type, v.name);
          this.releaseValue(old, type);
        } else {
          this.storeField(ptr, type, v.name);
        }
        break;
      }
      case "recordKeyDelete": {
        // `delete obj[k]` on a pure index-signature shape: a Map delete on
        // the overflow (key and value released; absent keys no-op).
        const obj = this.emitExpr(s.obj);
        const key = this.emitExpr(s.key);
        const ovf = this.recordOvfPtr(obj.name, s.shapeId);
        this.declare(`declare zeroext i1 @scr_map_delete_str(ptr, ptr)`);
        const t = B.tmp();
        B.line(`${t} = call zeroext i1 @scr_map_delete_str(ptr ${ovf}, ptr ${key.name})`);
        break;
      }
      case "recordKeySet": {
        // Dynamic-keyed record write (the C per-shape helper, inline):
        // declared keys write through (same-typed — dyn-valued shapes,
        // whose writes validate and can throw, stay refused), undeclared
        // keys insert/replace in the overflow map. Evaluation order: obj,
        // key, value; the write OWNS the value (+1 moves in).
        const obj = this.emitExpr(s.obj);
        const key = this.emitExpr(s.key);
        const v = this.emitExpr(s.value);
        if (isRefCounted(v.type)) this.moveTemp(v);
        const shape = this.recordShape(s.shapeId);
        // Signature-free shapes dispatch over their (one-typed) declared
        // fields and TRAP on a miss (scr_record_key_miss — JS would add
        // the property, which a monomorphic struct cannot); overflow
        // shapes keep the map insert tail.
        const iv = shape.indexValue ?? shape.fields[0]?.type;
        if (!iv) throw new InternalCompilerError(`llvm emitter bug: keyed write on field-free non-overflow shape ${s.shapeId}`);
        const vAcc = iv.kind === "f64" ? "f64" : iv.kind === "bool" ? "bool" : "ref";
        if (s.overflowOnly === true) {
          // A LITERAL key naming no declared field: a plain overflow
          // insert — no field chain.
          const ovf = this.recordOvfPtr(obj.name, s.shapeId);
          this.mapSet(ovf, "str", vAcc, key.name, v.name);
          break;
        }
        const join = B.newLabel("rks.j");
        this.declare(`declare zeroext i1 @scr_str_eq(ptr, ptr)`);
        if (iv.kind === "dyn" && shape.indexValue) {
          // A dyn-valued shape (the C recordKeySetHelper's dyn arm,
          // inline): declared keys VALIDATE the dyn value against the
          // field's type first (dynCheck — a mismatched write throws the
          // catchable TypeError and leaves the field untouched; JS would
          // store anything, the documented divergence); undeclared keys
          // insert the dyn value into the overflow map as-is.
          this.declare(`declare void @scr_dyn_release(ptr)`);
          for (const f of shape.fields) {
            const lit = this.internLiteral(f.name);
            const hit = B.tmp();
            B.line(`${hit} = call zeroext i1 @scr_str_eq(ptr ${key.name}, ptr ${lit}) ; ${f.name}`);
            const lh = B.newLabel("rks.h");
            const ln = B.newLabel("rks.n");
            B.condBr(hit, lh, ln);
            B.startBlock(lh);
            const pathSlot = B.slot();
            B.entryAllocas.push(`${pathSlot} = alloca %ScrDynPath`);
            const pp = B.tmp();
            const kp = B.tmp();
            const ip = B.tmp();
            B.line(`${pp} = getelementptr inbounds %ScrDynPath, ptr ${pathSlot}, i64 0, i32 0`);
            B.line(`store ptr null, ptr ${pp}`);
            B.line(`${kp} = getelementptr inbounds %ScrDynPath, ptr ${pathSlot}, i64 0, i32 1`);
            B.line(`store ptr ${this.cstr(f.name)}, ptr ${kp}`);
            B.line(`${ip} = getelementptr inbounds %ScrDynPath, ptr ${pathSlot}, i64 0, i32 2`);
            B.line(`store ${this.sizeType} 0, ptr ${ip}`);
            const helper = this.dyn.dynCheckHelper(f.type);
            const fty = this.llType(f.type);
            const nv = B.tmp();
            B.line(`${nv} = call ${fty === "i1" ? "zeroext i1" : fty} @${helper}(ptr ${v.name}, ptr ${pathSlot})`);
            B.line(`call void @scr_dyn_release(ptr ${v.name})`);
            // Mismatched write: TypeError pending, field untouched — the
            // statement-level check below unwinds.
            this.declare(`declare zeroext i1 @scr_exc_pending()`);
            const pend = B.tmp();
            B.line(`${pend} = call zeroext i1 @scr_exc_pending()`);
            const lw = B.newLabel("rks.w");
            B.condBr(pend, join, lw);
            B.startBlock(lw);
            const { ptr, type } = this.recordFieldPtr(obj.name, s.shapeId, f.name);
            if (isRefCounted(type)) {
              const old = B.tmp();
              B.line(`${old} = load ptr, ptr ${ptr}`);
              this.storeField(ptr, type, nv);
              this.releaseValue(old, type);
            } else {
              this.storeField(ptr, type, nv);
            }
            B.br(join);
            B.startBlock(ln);
          }
          const ovf = this.recordOvfPtr(obj.name, s.shapeId);
          this.mapSet(ovf, "str", vAcc, key.name, v.name);
          B.br(join);
          B.startBlock(join);
          // MAY THROW exactly when a dyn value can validate against a
          // declared field (stmts.ts's condition).
          if (shape.fields.length > 0) this.emitPendingCheck();
          break;
        }
        for (const f of shape.fields) {
          // typeEquals(f.type, iv) — the frontend fences everything else.
          const lit = this.internLiteral(f.name);
          const hit = B.tmp();
          B.line(`${hit} = call zeroext i1 @scr_str_eq(ptr ${key.name}, ptr ${lit}) ; ${f.name}`);
          const lh = B.newLabel("rks.h");
          const ln = B.newLabel("rks.n");
          B.condBr(hit, lh, ln);
          B.startBlock(lh);
          const { ptr, type } = this.recordFieldPtr(obj.name, s.shapeId, f.name);
          if (isRefCounted(type)) {
            const old = B.tmp();
            B.line(`${old} = load ptr, ptr ${ptr}`);
            this.storeField(ptr, type, v.name);
            this.releaseValue(old, type);
          } else {
            this.storeField(ptr, type, v.name);
          }
          B.br(join);
          B.startBlock(ln);
        }
        if (!shape.indexValue) {
          // The MISS on a fixed shape: release the moved-in value, throw
          // the catchable TypeError naming the key (scr_record_key_miss —
          // JS would add the property, the documented divergence).
          if (isRefCounted(iv)) this.releaseValue(v.name, iv);
          this.declare(`declare void @scr_record_key_miss(ptr)`);
          B.line(`call void @scr_record_key_miss(ptr ${key.name})`);
          B.br(join);
          B.startBlock(join);
          this.emitPendingCheck();
          break;
        }
        const ovf = this.recordOvfPtr(obj.name, s.shapeId);
        this.mapSet(ovf, "str", vAcc, key.name, v.name);
        B.br(join);
        B.startBlock(join);
        break;
      }
      case "block": {
        if (s.labels === undefined) {
          this.emitBlock(s.body);
          break;
        }
        // A labeled block: `break lbl` inside branches to the end label.
        const le = B.newLabel("blk.e");
        this.jumpTargets.push({
          kind: "block",
          brkLabel: le,
          contLabel: null,
          labels: s.labels,
          frameDepth: this.frames.length,
          scopeDepth: this.scopes.length,
        });
        this.emitBlock(s.body);
        this.jumpTargets.pop();
        B.br(le);
        B.startBlock(le);
        break;
      }
      case "if": {
        const cond = this.emitCondition(s.cond);
        const trueLabel = B.newLabel("if.t");
        const joinLabel = B.newLabel("if.j");
        const falseLabel = s.else_ ? B.newLabel("if.f") : joinLabel;
        B.condBr(cond, trueLabel, falseLabel);
        B.startBlock(trueLabel);
        this.emitBlock(s.then);
        B.br(joinLabel);
        if (s.else_) {
          B.startBlock(falseLabel);
          this.emitBlock(s.else_);
          B.br(joinLabel);
        }
        B.startBlock(joinLabel);
        break;
      }
      case "while": {
        const lc = B.newLabel("loop.c");
        const lb = B.newLabel("loop.b");
        const le = B.newLabel("loop.e");
        B.br(lc);
        B.startBlock(lc);
        B.condBr(this.emitCondition(s.cond), lb, le);
        B.startBlock(lb);
        this.jumpTargets.push({
          kind: "loop",
          brkLabel: le,
          contLabel: lc,
          ...(s.labels !== undefined && { labels: s.labels }),
          frameDepth: this.frames.length,
          scopeDepth: this.scopes.length,
        });
        this.emitBlock(s.body);
        this.jumpTargets.pop();
        B.br(lc);
        B.startBlock(le);
        break;
      }
      case "doWhile": {
        // Body first (runs at least once); continue jumps to the CONDITION.
        const lb = B.newLabel("loop.b");
        const lc = B.newLabel("loop.c");
        const le = B.newLabel("loop.e");
        B.br(lb);
        B.startBlock(lb);
        this.jumpTargets.push({
          kind: "loop",
          brkLabel: le,
          contLabel: lc,
          ...(s.labels !== undefined && { labels: s.labels }),
          frameDepth: this.frames.length,
          scopeDepth: this.scopes.length,
        });
        this.emitBlock(s.body);
        this.jumpTargets.pop();
        B.br(lc);
        B.startBlock(lc);
        B.condBr(this.emitCondition(s.cond), lb, le);
        B.startBlock(le);
        break;
      }
      case "for": {
        // The init's scope wraps the whole loop (break/continue must NOT
        // release it — scopeDepth captured after the push, C parity).
        const integerLoop = matchIntegerBytesForLoop(s, this.currentLocals);
        this.scopes.push([]);
        let integerSlot: string | null = null;
        if (integerLoop) {
          integerSlot = B.slot();
          B.entryAllocas.push(`${integerSlot} = alloca ${this.sizeType} ; integer induction ${this.currentLocals.get(integerLoop.localId)!.name}`);
          B.line(`store ${this.sizeType} 0, ptr ${integerSlot}`);
          this.integerLoopBindings.set(integerLoop.localId, integerSlot);
        } else if (s.init) {
          this.emitStmt(s.init);
        }
        const lc = B.newLabel("loop.c");
        const lb = B.newLabel("loop.b");
        const le = B.newLabel("loop.e");
        // JS `for (let i ...)`: each iteration gets a FRESH binding holding
        // a copy of the previous one (closures made in iteration k keep
        // seeing iteration k's value) — only observable, and only emitted,
        // when the init variable is captured (boxed). The freshening (and
        // the update) live in the continue-target block.
        const initLocal = s.init?.kind === "varDecl" ? this.currentLocals.get(s.init.localId) : undefined;
        const freshens = initLocal?.boxed === true;
        const lu = s.update || freshens ? B.newLabel("loop.u") : lc;
        B.br(lc);
        B.startBlock(lc);
        if (integerLoop && integerSlot) {
          const receiver = this.emitBytesReceiver(integerLoop.limitReceiver, []);
          const lenPtr = B.tmp();
          const len = B.tmp();
          const index = B.tmp();
          const inBounds = B.tmp();
          B.line(`${lenPtr} = getelementptr inbounds %ScrBytes, ptr ${receiver.name}, i64 0, i32 1`);
          B.line(`${len} = load ${this.sizeType}, ptr ${lenPtr}`);
          B.line(`${index} = load ${this.sizeType}, ptr ${integerSlot}`);
          B.line(`${inBounds} = icmp ult ${this.sizeType} ${index}, ${len}`);
          B.condBr(inBounds, lb, le);
        } else if (s.cond) B.condBr(this.emitCondition(s.cond), lb, le);
        else B.br(lb);
        B.startBlock(lb);
        this.jumpTargets.push({
          kind: "loop",
          brkLabel: le,
          contLabel: lu,
          ...(s.labels !== undefined && { labels: s.labels }),
          frameDepth: this.frames.length,
          scopeDepth: this.scopes.length,
        });
        this.emitBlock(s.body);
        this.jumpTargets.pop();
        B.br(lu);
        if (lu !== lc) {
          B.startBlock(lu);
          if (freshens && initLocal) {
            const slot = `%${mangleLocal(initLocal.id)}`;
            const fresh = B.tmp();
            const old = B.tmp();
            B.line(`${fresh} = ${boxNewCall(this, initLocal.type)} ; per-iteration ${initLocal.name}`);
            B.line(`${old} = load ptr, ptr ${slot}`);
            const val = this.boxGet(old, initLocal.type); // ref: +1 out
            this.boxSet(fresh, initLocal.type, val); // takes ownership
            this.declare(`declare void @scr_box_release(ptr)`);
            B.line(`call void @scr_box_release(ptr ${old})`);
            B.line(`store ptr ${fresh}, ptr ${slot}`);
            // The wrapper scope's entry releases whatever the slot points
            // to at loop exit — now the freshest binding. Nothing to fix.
          }
          if (integerLoop && integerSlot) {
            const old = B.tmp();
            const next = B.tmp();
            B.line(`${old} = load ${this.sizeType}, ptr ${integerSlot}`);
            B.line(`${next} = add nuw ${this.sizeType} ${old}, 1`);
            B.line(`store ${this.sizeType} ${next}, ptr ${integerSlot}`);
          } else if (s.update) this.emitStmt(s.update);
          B.br(lc);
        }
        B.startBlock(le);
        this.releaseScope(this.scopes.pop()!);
        if (integerLoop) this.integerLoopBindings.delete(integerLoop.localId);
        break;
      }
      case "forOf": {
        // Ascending index loop; the length is re-read every iteration
        // (JS-exact — pushes inside the body extend the iteration). The
        // iterable temp lives in this statement's frame, so it is released
        // when the whole loop ends (and by `return`'s frame sweep).
        if (s.iterable.type.kind !== "array") throw new LlvmUnsupportedError(`forOf:${s.iterable.type.kind}`, s.loc);
        const elem = s.iterable.type.elem;
        const arr = this.emitExpr(s.iterable);
        const idxSlot = B.slot();
        B.entryAllocas.push(`${idxSlot} = alloca double`);
        B.line(`store double ${f64Lit(0)}, ptr ${idxSlot}`);
        const lc = B.newLabel("fof.c");
        const lb = B.newLabel("fof.b");
        const lu = B.newLabel("fof.u");
        const le = B.newLabel("fof.e");
        B.br(lc);
        B.startBlock(lc);
        const i = B.tmp();
        const len = B.tmp();
        const inBounds = B.tmp();
        this.declare(`declare double @scr_arr_len(ptr)`);
        B.line(`${i} = load double, ptr ${idxSlot}`);
        B.line(`${len} = call double @scr_arr_len(ptr ${arr.name})`);
        B.line(`${inBounds} = fcmp olt double ${i}, ${len}`);
        B.condBr(inBounds, lb, le);
        B.startBlock(lb);
        this.jumpTargets.push({
          kind: "loop",
          brkLabel: le,
          contLabel: lu,
          ...(s.labels !== undefined && { labels: s.labels }),
          frameDepth: this.frames.length,
          scopeDepth: this.scopes.length,
        });
        // The loop variable is a fresh const per iteration: its scope opens
        // here, holds the (for ref elements: owned +1) current element, and
        // releases it at the end of each iteration.
        this.scopes.push([]);
        const localInfo = this.currentLocals.get(s.localId);
        const slot = `%${mangleLocal(s.localId)}`;
        const acc = elemAccess(elem);
        const accTy = acc === "f64" ? "double" : acc === "bool" ? "i1" : "ptr";
        this.declare(
          `declare ${acc === "bool" ? "zeroext i1" : accTy} @scr_arr_get_${acc}(ptr, double)`,
        );
        const cur = B.tmp();
        B.line(`${cur} = call ${accTy} @scr_arr_get_${acc}(ptr ${arr.name}, double ${i})`);
        if (localInfo?.boxed) {
          // Captured loop variable: a fresh box per iteration, matching the
          // fresh const binding. The box takes ownership of a ref element's
          // +1 and is released with the iteration's scope.
          const box = B.tmp();
          B.line(`${box} = ${boxNewCall(this, elem)} ; per-iteration ${localInfo.name}`);
          this.boxSet(box, elem, cur);
          B.line(`store ptr ${box}, ptr ${slot}`);
          this.scopes[this.scopes.length - 1]!.push({ slot, type: elem, boxed: true });
        } else {
          B.line(`store ${this.llType(elem)} ${cur}, ptr ${slot}`);
          if (isRefCounted(elem)) this.scopes[this.scopes.length - 1]!.push({ slot, type: elem });
        }
        this.emitStmts(s.body);
        const endedWithJump = endsWithJump(s.body);
        const scope = this.scopes.pop()!;
        if (!endedWithJump) this.releaseScope(scope);
        this.jumpTargets.pop();
        B.br(lu);
        B.startBlock(lu);
        const i2 = B.tmp();
        const i3 = B.tmp();
        B.line(`${i2} = load double, ptr ${idxSlot}`);
        B.line(`${i3} = fadd double ${i2}, ${f64Lit(1)}`);
        B.line(`store double ${i3}, ptr ${idxSlot}`);
        B.br(lc);
        B.startBlock(le);
        break;
      }
      case "switch":
        this.emitSwitch(s);
        break;
      case "break": {
        // Unlabeled: the innermost loop OR switch (labeled blocks are
        // skipped); labeled: the entry carrying the label.
        let target: (typeof this.jumpTargets)[number] | undefined;
        for (let i = this.jumpTargets.length - 1; i >= 0; i--) {
          const t = this.jumpTargets[i]!;
          if (s.label !== undefined ? t.labels?.includes(s.label) : t.kind !== "block") {
            target = t;
            break;
          }
        }
        if (!target) throw new InternalCompilerError("llvm emitter bug: break target not found");
        this.releaseForJump(target.frameDepth, target.scopeDepth);
        B.terminate(`br label %${target.brkLabel}`);
        break;
      }
      case "continue": {
        // Unlabeled: the innermost loop; labeled: the loop carrying the
        // label (tsc + the validator guarantee it IS a loop).
        let target: (typeof this.jumpTargets)[number] | undefined;
        for (let i = this.jumpTargets.length - 1; i >= 0; i--) {
          const t = this.jumpTargets[i]!;
          if (t.kind === "loop" && (s.label === undefined || t.labels?.includes(s.label))) {
            target = t;
            break;
          }
        }
        if (!target || target.contLabel === null) throw new InternalCompilerError("llvm emitter bug: continue target not found");
        this.releaseForJump(target.frameDepth, target.scopeDepth);
        B.terminate(`br label %${target.contLabel}`);
        break;
      }
      case "return": {
        // The value computes FIRST (an SSA temp — finally mutations of
        // returned locals cannot change it, Node-exact), then every
        // crossed finally runs innermost-first with the frames/scopes/
        // tryStack it sees truncated to its region (its releases already
        // ran; a throw inside a copy propagates OUT of the completing
        // try, past its own catch), then the function-level releases and
        // the actual ret. The C emitter routes this through per-region
        // finally copies behind gotos with the value parked in sc_pret;
        // the inline copies here are the same code at the same depths,
        // with the parked value's ownership riding a synthetic slot-based
        // scope entry during each copy so a throwing finally releases it.
        let v: LlValue | null = null;
        if (s.value !== null) {
          v = this.emitExpr(s.value);
          this.moveTemp(v);
        }
        if (this.finallyStack.length > 0) {
          let pretSlot: string | null = null;
          if (v !== null && isRefCounted(v.type)) {
            pretSlot = B.slot();
            B.entryAllocas.push(`${pretSlot} = alloca ptr ; pending return (through finally)`);
            B.line(`store ptr ${v.name}, ptr ${pretSlot}`);
          }
          const savedFrames = this.frames;
          const savedScopes = this.scopes;
          const savedFinally = this.finallyStack;
          const savedTry = this.tryStack;
          for (let i = savedFinally.length - 1; i >= 0 && !B.isTerminated(); i--) {
            const fin = savedFinally[i]!;
            this.releaseForJump(fin.frameDepth, fin.scopeDepth);
            this.frames = this.frames.slice(0, fin.frameDepth);
            this.scopes = this.scopes.slice(0, fin.scopeDepth);
            this.finallyStack = savedFinally.slice(0, i);
            this.tryStack = savedTry.slice(0, fin.tryDepth);
            if (pretSlot !== null) this.scopes.push([{ slot: pretSlot, type: v!.type }]);
            this.emitBlock(fin.body);
            if (pretSlot !== null) this.scopes.pop();
          }
          if (!B.isTerminated()) this.releaseForJump(0, 0);
          this.frames = savedFrames;
          this.scopes = savedScopes;
          this.finallyStack = savedFinally;
          this.tryStack = savedTry;
        } else {
          this.releaseForJump(0, 0);
        }
        if (!B.isTerminated()) {
          if (this.currentWasiCoro !== null) {
            this.emitWasiFulfill(v);
            B.terminate(`br label %${this.currentWasiCoro.finalLabel}`);
          } else if (v === null) B.terminate("ret void");
          else B.terminate(`ret ${this.llType(s.value!.type)} ${v.name}`);
        }
        break;
      }
      case "throw": {
        // Evaluate, move ownership into the runtime's exception cell, then
        // unwind unconditionally (the innermost try handler, or out of the
        // function) — the same release path as return/break/continue.
        const v = this.emitExpr(s.value);
        if (isRefCounted(s.value.type)) this.moveTemp(v); // the cell takes ownership
        this.emitThrowValue({ name: v.name, type: s.value.type });
        this.emitUnwind();
        break;
      }
      case "rethrow": {
        // Re-raise the saved snapshot (payload retained — the binding
        // local releases with its scope) and unwind like `throw`.
        const c = B.tmp();
        B.line(`${c} = load ptr, ptr %${mangleLocal(s.localId)}`);
        this.declare(`declare void @scr_rethrow(ptr)`);
        B.line(`call void @scr_rethrow(ptr ${c})`);
        this.emitUnwind();
        break;
      }
      case "runtimeFence": {
        // The deferred JS compile fence: throw a catchable Error naming
        // the construct (message) with the SC code stamped on `code`,
        // then unwind exactly like `throw`. SCR_ERR_ERROR = 0.
        const bytes = Buffer.byteLength(s.message, "utf8");
        this.declare(`declare void @scr_throw_error_msg_code(i32, ptr, ${this.sizeType}, ptr)`);
        B.line(
          `call void @scr_throw_error_msg_code(i32 0, ptr ${this.cstr(s.message)}, ${this.sizeType} ${bytes}, ptr ${this.cstr(s.code)})`,
        );
        this.emitUnwind();
        break;
      }
      case "tryCatch":
        this.emitTryCatch(s);
        break;
      default: {
        // Statement coverage is now total (bytesSet closed the set) —
        // keep the loud refusal for any future IR statement kind.
        const rest: never = s;
        const k = (rest as IrStmt).kind;
        throw new LlvmUnsupportedError(`stmt:${k}`, (rest as IrStmt).loc);
      }
    }
    const frame = this.frames.pop()!;
    // return/throw already released their frames on the jump path; the
    // fall-through releases after them would be dead double-release code.
    if (s.kind !== "return" && s.kind !== "throw" && s.kind !== "rethrow" && s.kind !== "runtimeFence") {
      this.releaseFrame(frame);
    }
  }

  /** try/catch/finally via pending-flag unwinding — stmts.ts's
   * emitTryCatch, block-flavored. Entering a try emits NO code: the try
   * context is compile-time state (tryStack) redirecting unwinds inside
   * the region to a label here. Shape:
   *
   *   { try body }           unwinds inside release frames/scopes down to
   *                          this statement's depths, then br the handler
   *   br after               (normal completion skips the handler)
   *   try.c:                 (emitted only when some unwind targets it)
   *     binding = scr_exc_take()   (or scr_exc_clear() when bindingless)
   *     { catch body }
   *   after: { finally body }      normal path
   *   br try.e
   *   try.fx:                exception path: the pending exception is
   *     stash = scr_exc_take()     STASHED across the finally body so the
   *     { finally body }           body's own pending checks answer for
   *     scr_rethrow(stash)         themselves; a throw inside REPLACES the
   *     <unwind>                   stash (it unwinds through the synthetic
   *   try.e:                       scope entry) — JS's semantics exactly
   *
   * Returns inside tryBody/catchBody ride the finallyStack (inline copies
   * at the return site — see `return`); break/continue never cross a
   * finally and no jump leaves a finally body (frontend fence + validator
   * backstop). */
  private emitTryCatch(s: IrStmt & { kind: "tryCatch" }): void {
    const B = this.B;
    const hasCatch = s.catchBody !== null;
    const hasFinally = s.finallyBody !== null;
    const catchLabel = B.newLabel("try.c");
    const finExcLabel = B.newLabel("try.fx");
    const endLabel = B.newLabel("try.e");
    const afterTryLabel = hasFinally ? B.newLabel("try.f") : endLabel;

    const handler = {
      label: hasCatch ? catchLabel : finExcLabel,
      used: false,
      frameDepth: this.frames.length,
      scopeDepth: this.scopes.length,
    };
    if (hasFinally) {
      this.finallyStack.push({
        frameDepth: this.frames.length,
        scopeDepth: this.scopes.length,
        tryDepth: this.tryStack.length,
        body: s.finallyBody!,
      });
    }
    this.tryStack.push(handler);
    this.emitBlock(s.tryBody);
    this.tryStack.pop();
    B.br(afterTryLabel); // no-op when the try body already terminated

    // Exceptions raised in the CATCH body unwind to the exception-path
    // finally (pending stays set through it) when one exists.
    const excHandler = {
      label: finExcLabel,
      used: !hasCatch && handler.used,
      frameDepth: this.frames.length,
      scopeDepth: this.scopes.length,
    };

    if (hasCatch && handler.used) {
      B.startBlock(catchLabel);
      if (hasFinally) this.tryStack.push(excHandler);
      if (this.currentGenerator !== null) {
        // Generator bodies: a pending GENRET sentinel (.return(v)
        // injected at a yield) is a RETURN completion, not a throw —
        // catch must not take it. Re-unwind past this handler (finally
        // still runs — the unwind targets the exception-path finally or
        // the enclosing context; the depths here equal the handler's).
        this.declare(`declare zeroext i1 @scr_exc_genret_pending()`);
        const gr = B.tmp();
        B.line(`${gr} = call zeroext i1 @scr_exc_genret_pending()`);
        const lg = B.newLabel("try.gr");
        const lk = B.newLabel("try.gk");
        B.condBr(gr, lg, lk);
        B.startBlock(lg);
        this.emitUnwind();
        B.startBlock(lk);
      }
      if (s.catchLocalId !== null) {
        // catch (e): the exception MOVES into the binding's snapshot box,
        // owned by the catch body's scope (released on every exit —
        // normal fall-through, jumps out, and unwinds from the body).
        const slot = `%${mangleLocal(s.catchLocalId)}`;
        this.declare(`declare ptr @scr_exc_take()`);
        this.emitBlock(s.catchBody!, (scope) => {
          const c = B.tmp();
          B.line(`${c} = call ptr @scr_exc_take() ; catch binding`);
          B.line(`store ptr ${c}, ptr ${slot}`);
          scope.push({ slot, type: CAUGHT });
        });
      } else {
        this.declare(`declare void @scr_exc_clear()`);
        B.line(`call void @scr_exc_clear() ; catch takes the exception`);
        this.emitBlock(s.catchBody!);
      }
      if (hasFinally) this.tryStack.pop();
      B.br(afterTryLabel); // the catch's normal completion
    }
    if (hasFinally) this.finallyStack.pop();

    if (hasFinally) {
      B.startBlock(afterTryLabel);
      this.emitBlock(s.finallyBody!); // normal path
      B.br(endLabel);
      if (excHandler.used) {
        // The pending exception is STASHED across the finally body (a
        // ScrCaught snapshot, re-raised after) so the body runs with a
        // CLEAN cell — see stmts.ts's exception-path copy. The
        // stash rides an alloca slot so a throw inside the body unwinds
        // through the synthetic scope entry (replace semantics).
        B.startBlock(finExcLabel);
        this.declare(`declare ptr @scr_exc_take()`);
        this.declare(`declare void @scr_rethrow(ptr)`);
        this.declare(`declare void @scr_caught_release(ptr)`);
        const stash = B.tmp();
        const stashSlot = B.slot();
        B.entryAllocas.push(`${stashSlot} = alloca ptr ; finally exception stash`);
        B.line(`${stash} = call ptr @scr_exc_take() ; stash across finally`);
        B.line(`store ptr ${stash}, ptr ${stashSlot}`);
        this.scopes.push([{ slot: stashSlot, type: CAUGHT }]);
        this.emitBlock(s.finallyBody!);
        this.scopes.pop(); // normal completion keeps the stash for the re-raise
        B.line(`call void @scr_rethrow(ptr ${stash})`);
        B.line(`call void @scr_caught_release(ptr ${stash})`);
        this.emitUnwind();
      }
      B.startBlock(endLabel);
    } else {
      B.startBlock(endLabel);
    }
  }

  /** JS-exact switch: lazily evaluated, arbitrary-expression case tests in
   * source order, bodies falling through in source order until a break —
   * CEmitter.emitSwitch's goto chain, block-flavored. All case bodies
   * share ONE scope; because dispatch can jump PAST a varDecl into a later
   * case, refcounted/boxed case-body locals are NULL-reset up front and
   * the scope-exit releases rely on NULL tolerance. */
  private emitSwitch(s: IrStmt & { kind: "switch" }): void {
    const B = this.B;
    const discKind = s.disc.type.kind;
    if (discKind !== "f64" && discKind !== "string" && discKind !== "bool") {
      throw new LlvmUnsupportedError(`switch:${discKind}`, s.loc);
    }
    // The disc temp lives in the whole statement's frame: for a string
    // discriminant it stays alive across every test and body, released
    // when the switch statement ends (break lands past this statement's
    // frame release — releaseForJump keeps the target's own frame).
    const disc = this.emitExpr(s.disc);
    for (const c of s.cases) {
      for (const stmt of c.body) {
        if (stmt.kind !== "varDecl") continue;
        const local = this.currentLocals.get(stmt.localId)!;
        if (local.boxed || isRefCounted(local.type)) {
          B.line(`store ptr null, ptr %${mangleLocal(local.id)} ; case-scoped ${local.name}`);
        }
      }
    }
    const end = B.newLabel("sw.e");
    const caseLabels = s.cases.map(() => B.newLabel("sw.c"));
    let defaultIdx = -1;
    s.cases.forEach((c, i) => {
      if (c.test === null) {
        defaultIdx = i;
        return;
      }
      // Lazy source-order test evaluation (a test after the match never
      // runs). Each test's temps release right after its comparison.
      this.frames.push([]);
      const t = this.emitExpr(c.test);
      const hit = B.tmp();
      if (c.test.type.kind === "string") {
        this.declare(`declare zeroext i1 @scr_str_eq(ptr, ptr)`);
        B.line(`${hit} = call zeroext i1 @scr_str_eq(ptr ${disc.name}, ptr ${t.name})`);
      } else if (c.test.type.kind === "bool") {
        B.line(`${hit} = icmp eq i1 ${disc.name}, ${t.name}`);
      } else {
        B.line(`${hit} = fcmp oeq double ${disc.name}, ${t.name}`);
      }
      this.releaseFrame(this.frames.pop()!);
      const next = B.newLabel("sw.t");
      B.condBr(hit, caseLabels[i]!, next);
      B.startBlock(next);
    });
    B.br(defaultIdx >= 0 ? caseLabels[defaultIdx]! : end);

    this.jumpTargets.push({
      kind: "switch",
      brkLabel: end,
      contLabel: null,
      ...(s.labels !== undefined && { labels: s.labels }),
      frameDepth: this.frames.length,
      scopeDepth: this.scopes.length,
    });
    const scope: LlScopeEntry[] = [];
    this.scopes.push(scope);
    s.cases.forEach((c, i) => {
      B.br(caseLabels[i]!); // the previous body's natural fall-through
      B.startBlock(caseLabels[i]!);
      this.emitStmts(c.body);
    });
    this.jumpTargets.pop();
    this.scopes.pop();
    // Natural fall-off of the last body releases the shared scope; a jump
    // already released it before jumping.
    const lastBody = s.cases[s.cases.length - 1]?.body;
    if (!lastBody || !endsWithJump(lastBody)) this.releaseScope(scope);
    B.br(end);
    B.startBlock(end);
  }

  /** Evaluates a condition (IR conds are bool-typed) and releases its
   * temps BEFORE the branch — safe because the result is a scalar i1, and
   * required in loop-condition blocks (their temps must not survive into
   * later blocks across the back edge). CEmitter.emitCondition. */
  private emitCondition(cond: IrExpr): string {
    const v = this.emitExpr(cond);
    const frame = this.currentFrame();
    this.releaseFrame(frame);
    frame.length = 0;
    return v.name;
  }

  /** Evaluates `expr` in its own statement frame inside an already-open
   * branch and moves the result into `slot`: the chosen value's ownership
   * transfers, every other temp the arm allocated releases inside the
   * branch. The shared core of ternary/logical. CEmitter.emitBranchInto. */
  private emitBranchInto(slot: string, expr: IrExpr): void {
    this.frames.push([]);
    const v = this.emitExpr(expr);
    this.moveTemp(v);
    this.B.line(`store ${this.llType(expr.type)} ${v.name}, ptr ${slot}`);
    this.releaseFrame(this.frames.pop()!);
  }

  // ── expressions ─────────────────────────────────────────────────────────

  /** One audited escape hatch for the type-only boundary used by the
   * extracted expression modules. LlEmitter remains the sole owner of the
   * mutable emission state; the context exposes only the operations those
   * modules require. */
  private expressionContext(): LlvmEmitterContext {
    return this as unknown as LlvmEmitterContext;
  }

  private emitLiteralExpr(e: ExprOf<"numLit" | "boolLit" | "strLit" | "unitLit" | "varRef">): LlValue {
    return emitLiteralExpr(this.expressionContext(), e);
  }

  private emitOperatorExpr(e: ExprOf<"bin" | "unary" | "incDec" | "fieldIncDec" | "assignExpr" | "seqExpr">): LlValue {
    return emitOperatorExpr(this.expressionContext(), e);
  }

  private emitControlExpr(e: ExprOf<"dynDestrCheck" | "dynIterN" | "toBool" | "logical" | "ternary" | "optChain" | "chainRecv" | "orDefault" | "nullish">): LlValue {
    return emitControlExpr(this.expressionContext(), e);
  }

  private emitStringExpr(e: ExprOf<"strConcat" | "strEq" | "strCmp" | "toString" | "strIntrinsic" | "regexLit" | "templateStrings" | "regexIntrinsic">): LlValue {
    return emitStringExpr(this.expressionContext(), e);
  }

  /**
   * Lower canonical `target = target + suffix` after evaluating the old
   * left side and suffix in JavaScript order.  The snapshot stays owned by
   * the statement frame while the destination relinquishes its CURRENT
   * value, making the snapshot unique unless a real observable alias exists.
   */
  private emitStringSelfConcatAssign(
    localId: string,
    left: IrExpr,
    suffix: IrExpr,
    retainForYield: boolean,
  ): LlValue {
    const snapshot = this.emitExpr(left);
    const right = this.emitExpr(suffix);
    const b = this.binding(localId);
    const B = this.B;
    if (b.kind === "boxed") {
      // set_ref(NULL) unlinks then releases the binding's post-suffix value.
      this.boxSet(this.loadBox(b.slot), b.type, "null");
    } else {
      const old = B.tmp();
      B.line(`${old} = load ptr, ptr ${b.slot}`);
      B.line(`store ptr null, ptr ${b.slot}`);
      this.releaseValue(old, b.type);
    }
    this.declare(`declare ptr @scr_str_concat(ptr, ptr)`);
    const raw = B.tmp();
    B.line(`${raw} = call ptr @scr_str_concat(ptr ${snapshot.name}, ptr ${right.name})`);
    const result = this.own({ name: raw, type: left.type });
    if (retainForYield) {
      const stored = this.retainValue(result.name, result.type);
      if (b.kind === "boxed") this.boxSet(this.loadBox(b.slot), b.type, stored);
      else B.line(`store ptr ${stored}, ptr ${b.slot}`);
    } else {
      this.moveTemp(result);
      if (b.kind === "boxed") this.boxSet(this.loadBox(b.slot), b.type, result.name);
      else B.line(`store ptr ${result.name}, ptr ${b.slot}`);
    }
    return result;
  }

  private emitContainerExpr(e: ExprOf<"arrayLit" | "arrayNewLen" | "arrayGet" | "arrIntrinsic" | "bytesNew" | "bytesIntrinsic" | "mapNew" | "mapIntrinsic" | "setIntrinsic" | "setNew">): LlValue {
    return emitContainerExpr(this.expressionContext(), e);
  }

  private emitCallExpr(e: ExprOf<"call" | "ffiCall" | "closure" | "callValue" | "selfRef" | "new" | "classRef" | "newValue" | "instanceOfValue" | "promiseVoidWiden" | "upcast" | "downcast" | "instanceOf" | "virtualCall">): LlValue {
    return emitCallExpr(this.expressionContext(), e);
  }

  private emitRecordExpr(e: ExprOf<"fieldGet" | "recordGet" | "recordLit" | "recordClone" | "recordKeyGet" | "recordOvfKeys">): LlValue {
    return emitRecordExpr(this.expressionContext(), e);
  }

  private emitDynamicExpr(e: ExprOf<"dynFrom" | "dynFromJsval" | "dynCall" | "dynInvoke" | "dynArrLit" | "dynObjLit" | "unionWrap" | "unionNarrow" | "unionDisc" | "unionKeyGet" | "unionIsTag" | "dynKeyGet" | "dynHasKey" | "dynScalarEq" | "dynTest" | "unionEq" | "unionFuncEq" | "caughtTest" | "caughtCheck" | "caughtNarrow" | "caughtToDyn">): LlValue {
    return emitDynamicExpr(this.expressionContext(), e);
  }

  private emitIntrinsicExpr(e: ExprOf<"intrinsic">): LlValue {
    return emitIntrinsicExpr(this.expressionContext(), e);
  }

  private emitSerializationExpr(e: ExprOf<"jsonStringify" | "dynCheck">): LlValue {
    return emitSerializationExpr(this.expressionContext(), e);
  }

  private emitAsyncExpr(e: ExprOf<"yieldExpr" | "genResume" | "awaitExpr" | "awaitUnionExpr" | "newPromise" | "promiseWithResolvers">): LlValue {
    return emitAsyncExpr(this.expressionContext(), e);
  }

  private emitJsInteropExpr(e: ExprOf<"jsMarshal" | "jsOp" | "jsExit" | "jsBridgePromise">): LlValue {
    return emitJsInteropExpr(this.expressionContext(), e);
  }

  private emitExpr(e: IrExpr): LlValue {
    return emitExpr(this.expressionContext(), e);
  }

  private emitJsMarshal(e: IrExpr & { kind: "jsMarshal" }): LlValue {
    return emitJsMarshal(this.expressionContext(), e);
  }

  private emitJsOp(e: IrExpr & { kind: "jsOp" }): LlValue {
    return emitJsOp(this.expressionContext(), e);
  }

  private emitJsExit(e: IrExpr & { kind: "jsExit" }): LlValue {
    return emitJsExit(this.expressionContext(), e);
  }

  private islandAdapter(arity: number, retKind: "void" | "jsval" | "f64" | "bool" | "string"): string {
    return islandAdapter(this.expressionContext(), arity, retKind);
  }

  private islandTypedAdapter(fn: IrType & { kind: "func" }): string {
    return islandTypedAdapter(this.expressionContext(), fn);
  }

  private dynKind(d: string): string {
    return dynKind(this.expressionContext(), d);
  }

  private raceAdapterFor(from: IrType, to: IrType): string {
    return raceAdapterFor(this.expressionContext(), from, to);
  }

  private genResultThunkFor(genT: IrType & { kind: "generator" }, recT: IrType & { kind: "record" }): string {
    return genResultThunkFor(this.expressionContext(), genT, recT);
  }

  private childExitThunkFor(param: IrType): string {
    return childExitThunkFor(this.expressionContext(), param);
  }

  private childExitSignalThunkFor(codeParam: IrType, sigParam: IrType): string {
    return childExitSignalThunkFor(this.expressionContext(), codeParam, sigParam);
  }

  private childDataThunkFor(param: IrType): string {
    return childDataThunkFor(this.expressionContext(), param);
  }

  private emitterFixedAdapter(cbT: IrType & { kind: "func" }): { fn: string; shim: string } {
    return emitterFixedAdapter(this.expressionContext(), cbT);
  }

  private wrapEmitterListener(target: string, adapterFn: string): string {
    return wrapEmitterListener(this.expressionContext(), target, adapterFn);
  }

  private unwrapNullableClosure(u: string, funcTag: number): string {
    return unwrapNullableClosure(this.expressionContext(), u, funcTag);
  }

  private closeBindThunkFor(cbUnion: IrType, retServer: boolean): string {
    return closeBindThunkFor(this.expressionContext(), cbUnion, retServer);
  }

  private closeOverrideWrapFor(cbUnion: IrType, retServer: boolean): string {
    return closeOverrideWrapFor(this.expressionContext(), cbUnion, retServer);
  }

  private streamDataAdapter(cbT: IrType & { kind: "func" }): string {
    return streamDataAdapter(this.expressionContext(), cbT);
  }

  private streamDoneFnFor(kind: "w" | "f" | "d" | "t" | "l", doneT: IrType & { kind: "func" }): string {
    return streamDoneFnFor(this.expressionContext(), kind, doneT);
  }

  private fsRenameThunkFor(cbT: IrType & { kind: "func" }): string {
    return fsRenameThunkFor(this.expressionContext(), cbT);
  }

  private streamCbThunkFor(kind: "r" | "w" | "f" | "d" | "t" | "l" | "e", cbT: IrType): string {
    return streamCbThunkFor(this.expressionContext(), kind, cbT);
  }

  private resolveThunkFor(inner: IrType): string {
    return resolveThunkFor(this.expressionContext(), inner);
  }

  private tagInSet(uName: string, tags: number[]): string {
    return tagInSet(this.expressionContext(), uName, tags);
  }

  private arrPush(arr: string, acc: "f64" | "bool" | "ref", value: string): string {
    return arrPush(this.expressionContext(), arr, acc, value);
  }

  private emitArrayCopyLoop(dst: string, src: string, acc: "f64" | "bool" | "ref"): void {
    return emitArrayCopyLoop(this.expressionContext(), dst, src, acc);
  }

  private emitStrIntrinsic(e: IrExpr & { kind: "strIntrinsic" }): LlValue {
    return emitStrIntrinsic(this.expressionContext(), e);
  }

  private emitArrIntrinsic(e: IrExpr & { kind: "arrIntrinsic" }): LlValue {
    return emitArrIntrinsic(this.expressionContext(), e);
  }

  private wrapNullable(raw: string, present: string, valueType: IrType, valueTag: number, resultType: IrType & { kind: "union" }, absentTag: number): LlValue {
    return wrapNullable(this.expressionContext(), raw, present, valueType, valueTag, resultType, absentTag);
  }

  private emitMapNew(e: IrExpr & { kind: "mapNew" }): LlValue {
    return emitMapNew(this.expressionContext(), e);
  }

  private mapSet(m: string, kAcc: "f64" | "str" | "ref", vAcc: "f64" | "bool" | "ref", key: string, value: string): void {
    return mapSet(this.expressionContext(), m, kAcc, vAcc, key, value);
  }

  private emitMapLikeIntrinsic(
    e: Extract<IrExpr, { kind: "mapIntrinsic" | "setIntrinsic" }>,
  ): LlValue {
    return emitMapLikeIntrinsic(this.expressionContext(), e);
  }

  private emitSetNew(e: IrExpr & { kind: "setNew" }): LlValue {
    return emitSetNew(this.expressionContext(), e);
  }

  private emitBytesReceiver(receiver: IrExpr, following: IrExpr[]): LlValue {
    return emitBytesReceiver(this.expressionContext(), receiver, following);
  }

  private emitIntegerLoopIndex(expr: IrExpr): string | null {
    return emitIntegerLoopIndex(this.expressionContext(), expr);
  }

  private emitBytesIndex(receiver: string, index: string, integerIndex = false): string {
    return emitBytesIndex(this.expressionContext(), receiver, index, integerIndex);
  }

  private emitBytesData(receiver: string): string {
    return emitBytesData(this.expressionContext(), receiver);
  }

  private emitBytesLength(elem: IrBytesElem, receiver: string, bytes: boolean): LlValue {
    return emitBytesLength(this.expressionContext(), elem, receiver, bytes);
  }

  private emitBytesGet(elem: IrBytesElem, receiver: string, index: string, integerIndex = false): LlValue {
    return emitBytesGet(this.expressionContext(), elem, receiver, index, integerIndex);
  }

  private emitBytesU32(value: string): string {
    return emitBytesU32(this.expressionContext(), value);
  }

  private emitBytesSet(elem: IrBytesElem, receiver: string, index: string, value: string, integerIndex = false): void {
    return emitBytesSet(this.expressionContext(), elem, receiver, index, value, integerIndex);
  }

  private emitBytesIntrinsic(e: IrExpr & { kind: "bytesIntrinsic" }): LlValue {
    return emitBytesIntrinsic(this.expressionContext(), e);
  }

  private emitRegexIntrinsic(e: IrExpr & { kind: "regexIntrinsic" }): LlValue {
    return emitRegexIntrinsic(this.expressionContext(), e);
  }

  private emitRecordKeyGet(e: IrExpr & { kind: "recordKeyGet" }): LlValue {
    return emitRecordKeyGet(this.expressionContext(), e);
  }

  private keyedRecordReadInto(
    slot: string,
    join: string,
    objName: string,
    keyName: string,
    shapeId: string,
    resultType: IrType,
    overflowOnly: boolean,
    loc?: SrcLoc,
  ): void {
    return keyedRecordReadInto(this.expressionContext(), slot, join, objName, keyName, shapeId, resultType, overflowOnly, loc);
  }

  private dynPromiseAdapter(inner: IrType): string {
    return dynPromiseAdapter(this.expressionContext(), inner);
  }

  private streamTypedRefCommitAdapter(
    t: IrType,
    snapshot: string,
  ): string {
    return streamTypedRefCommitAdapter(this.expressionContext(), t, snapshot);
  }

  private liveDynUnionRefAdapter(
    t: IrType & { kind: "union" },
  ): string {
    return liveDynUnionRefAdapter(this.expressionContext(), t);
  }

  private streamTypedRefBoxValue(
    B: BlockBuilder,
    t: IrType,
    value: string,
    ctx: LlStreamTypedRefContext,
  ): string {
    return streamTypedRefBoxValue(this.expressionContext(), B, t, value, ctx);
  }

  private streamTypedRefMaterializeAdapter(
    t: IrType,
    ctx: LlStreamTypedRefContext,
    preferredSnapshot?: string,
  ): LlStreamTypedRefAdapter {
    return streamTypedRefMaterializeAdapter(this.expressionContext(), t, ctx, preferredSnapshot);
  }

  private streamFromArrayAdapter(
    t: IrType & { kind: "array" },
  ): string {
    return streamFromArrayAdapter(this.expressionContext(), t);
  }

  private emitWebLibCall(e: LibCallExpr): LlValue {
    return emitWebLibCall(this.expressionContext(), e);
  }

  private emitDynamicLibCall(e: LibCallExpr): LlValue {
    return emitDynamicLibCall(this.expressionContext(), e);
  }

  private emitFilesystemLibCall(e: LibCallExpr): LlValue {
    return emitFilesystemLibCall(this.expressionContext(), e);
  }

  private emitPathUrlLibCall(e: LibCallExpr): LlValue {
    return emitPathUrlLibCall(this.expressionContext(), e);
  }

  private emitPrimitiveLibCall(e: LibCallExpr): LlValue {
    return emitPrimitiveLibCall(this.expressionContext(), e);
  }

  private emitChildProcessLibCall(e: LibCallExpr): LlValue {
    return emitChildProcessLibCall(this.expressionContext(), e);
  }

  private emitAsyncContextLibCall(e: LibCallExpr): LlValue {
    return emitAsyncContextLibCall(this.expressionContext(), e);
  }

  private emitProcessLibCall(e: LibCallExpr): LlValue {
    return emitProcessLibCall(this.expressionContext(), e);
  }

  private emitErrorsEventsLibCall(e: LibCallExpr): LlValue {
    return emitErrorsEventsLibCall(this.expressionContext(), e);
  }

  private emitStreamLibCall(e: LibCallExpr): LlValue {
    return emitStreamLibCall(this.expressionContext(), e);
  }

  private emitNetworkHttpLibCall(e: LibCallExpr): LlValue {
    return emitNetworkHttpLibCall(this.expressionContext(), e);
  }

  private emitAssertInspectLibCall(e: LibCallExpr): LlValue {
    return emitAssertInspectLibCall(this.expressionContext(), e);
  }

  private emitIoLibCall(e: LibCallExpr): LlValue {
    return emitIoLibCall(this.expressionContext(), e);
  }

  private emitGenericLibCall(e: LibCallExpr): LlValue {
    return emitGenericLibCall(this.expressionContext(), e);
  }

  private emitLibCall(e: LibCallExpr): LlValue {
    return emitLibCall(this.expressionContext(), e);
  }
}
