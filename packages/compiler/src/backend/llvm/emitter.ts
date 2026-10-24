import type { TargetCpu } from "../target-cpu.js";
import { relieveHeapPressure } from "../../heap-pressure.js";
import { wasmBoundsChecks } from "./wasm-modules.js";
import { jsTruthy } from "./jsval.js";
import { JsIcSites } from "../../ir/js-ic.js";
import { type ArraySearchKind } from "./array-search.js";
import { emitStringInputs } from "./string-lifetimes.js";
import { emitThreadSlotsIntrinsic } from "./thread-slots.js";
import {
  CYC_BUF,
  CYC_HDR,
  FIRST_EMITTED_CYC_KIND,
  inlineAllocSupported,
  RECORD_SOURCES_GATE,
  WEAK_KEYS_GATE,
} from "./alloc.js";
import { youngNurseryRequested } from "../young-nursery.js";
import { llvmBytes as llBytes, wtf8Bytes } from "../literals.js";
import { InternalCompilerError } from "../../errors.js";
import { createHash } from "node:crypto";
import {
  endsWithJump,
  matchFieldSelfConcat,
  readsArraySlot,
  streamTypedRefEligible,
  undefinedArmTag,
} from "../../ir/analysis.js";
import { loopTestsEveryIteration } from "../loop-polls.js";
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
import {
  isDynTypedRefType,
  isRefCounted,
  isUnitType,
  POINTER_KINDS,
  RUNTIME_EMITTER_CLASS,
  RUNTIME_EVENT_CLASS,
  RUNTIME_EVENT_TARGET_CLASS,
  RUNTIME_ERROR_CLASSES,
  RUNTIME_STREAM_CLASSES,
  typeEquals,
  typeKey,
  VOID,
  classJsName,
} from "../../ir/ir.js";
import { moduleRuntimeFeatures, type RuntimeFeatures } from "../../ir/runtime-features.js";
import { captureFreeFunctions, observesStacks } from "../stack-observations.js";
import { findInitializedByteLoopBindings } from "./byte-windows.js";
import { matchBytesLoopVersion } from "./bytes-loop-versions.js";
import { globalSlotAlias } from "./bytes-alias.js";
import type { IntegerCountedForLoop, IntegerPairedForLoop } from "../../ir/integer-loops.js";
import {
  materializeSplitPiece,
  type SplitSpan,
  type StoredSplitSnapshot,
  type StringSplit,
} from "./split-loops.js";
import { scalarizeNumericRecords } from "../../ir/scalar-records.js";
import { addRecordResultEntries, resultEntryName } from "./record-results.js";
import { specializeCallbackCalls } from "../../ir/callback-specialization.js";
import {
  type ChunkResult,
  EmitJournal,
  registerReplay,
  renameChunk,
  replayJournal,
} from "./emit-journal.js";
import { specializeNumericCalls } from "../../ir/numeric-call-specialization.js";
import { versionLoopBoundParameters } from "../../ir/parameter-versions.js";
import {
  allocatedLiteral,
  fillAllocationLength,
  int32ArrayKey,
  selectInt32Arrays,
} from "../../ir/int32-arrays.js";
import { everyExpr, everyExprChild, everyStmtChild, everyStmtList } from "../../ir/traverse.js";
import {
  INT32_RANGE,
  withinInt32,
  type IntegerRange,
  type IntegerRanges,
} from "../../ir/integer-ranges.js";
import { unshareNodes } from "../../ir/unshare.js";
import { runPairedWhileLoopsAsFor } from "../../ir/paired-while-loops.js";
import { copyStableCaptures } from "../../ir/capture-values.js";
import { resolveSelfCaptures } from "../../ir/self-captures.js";
import { analyzeInt32Slots, dynamicFieldStores, type Int32Slots } from "../../ir/int32-slots.js";
import { analyzeFinalFields, type FinalFields } from "../../ir/final-fields.js";
import { foldConstantGlobals } from "../../ir/constant-globals.js";
import { dropUnwrittenPropertyBags } from "../../ir/property-bags.js";
import { freezeInitOnlyGlobals } from "../../ir/init-only-globals.js";
import { hoistFinalFieldReads } from "../../ir/field-values.js";
import { holdCharLocalsAsUnits } from "../../ir/char-unit-locals.js";
import {
  findInt32Abis,
  INT32_ABI_SUFFIX,
  SCALAR_UNION_DUMMY,
  SCALAR_UNION_RESULT,
  type Int32Abi,
} from "./int32-abi.js";
import { type Int32Local } from "./int32-locals.js";
import { findIntegerClones, NO_INTEGER_CLONES, type IntegerClones } from "./integer-clones.js";
import { exactInteger, narrowInteger, widenInteger } from "./integer-values.js";
import { findInitializerBindings } from "../../ir/initializer-bindings.js";
import { findConstantNumericTables, type ConstantNumericTable } from "../../ir/constant-tables.js";
import {
  allocateFfiCallbackAdapters,
  hasForeignFfiCallback,
  hasRetainedFfiCallback,
  type FfiCallbackAdapter,
} from "../ffi-callbacks.js";
import { computeMayThrow } from "../may-throw.js";
import {
  mangleAsyncInlineAwaitCall,
  mangleAsyncSpawn,
  mangleBorrowedFunction,
  mangleClassObj,
  mangleFnClosure,
  mangleFunction,
  mangleGenSpawn,
  mangleGlobal,
  mangleLocal,
  mangleRecordStruct,
  mangleWrapper,
  mangleBorrowingWrapper,
} from "../mangle.js";
import { analyzeCallLifetimes, type CallLifetimes } from "./call-lifetimes.js";
import {
  stackObjectStruct,
  type StackObjectField,
  type StackObjectSource,
} from "./stack-objects.js";
import {
  type LocalUnionStorageProof,
  type LocalUnionStorage,
  type UnionSources,
} from "./local-union-storage.js";
import { BlockBuilder } from "./blocks.js";
import { NullableRefFields, type NullableRefField } from "./nullable-fields.js";
import {
  InlineUnionFields,
  loadInlineUnion,
  presentBits,
  stackUnionBox,
  storeInlineUnion,
  unionBoxBits,
} from "./inline-unions.js";
import { OptionalArrayReads, type LocalArrayRead } from "./local-array-reads.js";
import { CheckedNarrows } from "./checked-narrows.js";
import {
  emitDenseArraySet,
  emitDenseSlotUnlink,
  SCR_ELEM_I32,
  type ArrayAccess,
} from "./dense-array-access.js";
import { matchMapRead, type MapReadLifetimes } from "./map-read-lifetimes.js";
import { type MapEntryFusion } from "./map-entry-fusion.js";
import { emitBorrowedFieldSequence, guardedValue } from "./borrowed-receivers.js";
import { emitBorrowedInputs } from "./borrowed-inputs.js";
import { findWalkBorrows, type WalkBorrowHost } from "./walk-borrows.js";
import { IrNodeIndex } from "../../ir/node-index.js";
import { lastUseRead } from "./local-extents.js";
import { findReboundParameters } from "./rebound-parameters.js";
import { ReferenceEffects } from "./reference-effects.js";
import { ReferenceWrites, type Writes } from "./reference-writes.js";
import { LlvmDebugInfo } from "./debug-info.js";
import { StackCallbacks } from "./stack-callbacks.js";
import { findAppendedArrayLiterals, reservedArrayLength } from "./appended-array-literals.js";
import { AmbientReceiverReaders, findConstantCallbacks } from "./constant-callbacks.js";
import {
  findLentStringParameters,
  type LentStringParameters,
  type StringSliceSnapshot,
} from "./string-slices.js";
import { LazyCaptures } from "./lazy-captures.js";
import { StackCaptures } from "./stack-captures.js";
import { emitFieldAbsentTest, f64Lit, SCR_ARR_FIELD, SCR_ARR_FROZEN } from "./common.js";
import { ffiExtendsNarrowIntegers } from "../targets.js";
import {
  emitLiteralExpr,
  emitOperatorExpr,
  emitStringExpr,
  emitContainerExpr,
  emitRecordExpr,
} from "./expr-primitives.js";
import { emitControlExpr } from "./expr-control.js";
import { emitCallExpr } from "./expr-calls.js";
import { emitDynamicExpr } from "./expr-dynamic.js";
import { emitIntrinsicExpr, emitSerializationExpr, emitAsyncExpr } from "./expr-async.js";
import { PublishWalkers } from "./publish.js";
import { computeImmutableFields, stableGlobals, type ImmutableFields } from "../immutability.js";
import { computeCycleMutability, hierarchyUnitOfClass } from "../cycle-mutability.js";
import { computePublishedTypes, type PublishedTypes } from "../publication.js";
import { emitExpr } from "./expr-dispatch.js";
import { LOOPS } from "./loop-state.js";

import {
  dynKind,
  raceAdapterFor,
  genResultThunkFor,
  childExitThunkFor,
  childExitSignalThunkFor,
  childDataDynThunkFor,
  childDataThunkFor,
  execFileThunkFor,
  ipcMessageThunkFor,
  ipcSendThunkFor,
  emitterFixedAdapter,
  emitterOnceAdapter,
  wrapEmitterListener,
  unwrapNullableClosure,
  closeBindThunkFor,
  closeOverrideWrapFor,
} from "./expr-callbacks.js";
import {
  streamDataAdapter,
  streamDoneFnFor,
  cryptoBytesThunkFor,
  cryptoIntThunkFor,
  type BytesThunkValue,
  fsRenameThunkFor,
  streamCbThunkFor,
  zlibBytesThunkFor,
} from "./expr-stream-callbacks.js";
import {
  emitStableReceiver,
  resolveThunkFor,
  tagInSet,
  arrPush,
  emitArrayCopyLoop,
  emitStrIntrinsic,
  emitArrIntrinsic,
  wrapNullable,
  emitMapNew,
  mapSet,
  emitMapLikeIntrinsic,
  emitSetNew,
} from "./expr-containers.js";
import {
  emitIntegerLoopIndex,
  emitBytesIndex,
  emitBytesData,
  emitBytesLength,
  emitBytesGet,
  emitToUint32,
  emitBytesSet,
  emitBytesIntrinsic,
} from "./expr-bytes.js";
import { emitRegexIntrinsic, emitRecordKeyGet, keyedRecordReadInto } from "./expr-records.js";
import {
  dynPromiseAdapter,
  streamTypedRefCommitAdapter,
  liveDynUnionRefAdapter,
  streamTypedRefBoxValue,
  streamTypedRefMaterializeAdapter,
  streamFromArrayAdapter,
} from "./expr-stream-bridges.js";
import {
  emitWebLibCall,
  emitDynamicLibCall,
  emitFilesystemLibCall,
  emitPathUrlLibCall,
  emitPrimitiveLibCall,
} from "./lib-filesystem.js";
import {
  emitChildProcessLibCall,
  emitAsyncContextLibCall,
  emitProcessLibCall,
  emitErrorsEventsLibCall,
} from "./lib-process.js";
import { emitStreamLibCall } from "./lib-stream.js";
import { emitNetworkHttpLibCall } from "./lib-network.js";
import {
  emitAssertInspectLibCall,
  emitIoLibCall,
  emitGenericLibCall,
  emitLibCall,
} from "./lib-dispatch.js";
import {
  assignCompactLayouts,
  buildClassGraph,
  classFieldTypes,
  classMembershipIntervals,
  classFieldIndex,
  compactRefLoadLines,
  compactRefStoreLines,
  classPreLines,
  classStructSym,
  programLifetimeClass,
  type LlClassMeta,
} from "./classes.js";
import { LifetimeRegions, REGION_TYPES } from "./regions.js";
import { LlDyn, recordDynKeepsIdentity, type DynHost } from "./dyn.js";
import { VirtualBorrows } from "./virtual-borrows.js";
import { LlvmUnsupportedError } from "./unsupported.js";
import { LlWalkers } from "./walkers.js";
import { isObjectArm, NULLABLE_ABSENT, NULLABLE_NULL, NullableUnions } from "./nullable-unions.js";
import { emitNullablePresent, emitUnionPeek, emitUnionTag } from "./union-repr.js";
import {
  emitConcatInputs,
  emitMixedConcat,
  numberPart,
  stringParts,
} from "./string-construction.js";
import {
  arrNewCall,
  boxAccess,
  elemAccess,
  boxNewCall,
  boxReleaseSym,
  computeTraced,
  emitInlineRcHelpers,
  emitNullableRetainWrappers,
  emitShapeUnionHelpers,
  FN_ATTRS,
  inlineRcDecls,
  type InlineRcMode,
  llFieldType,
  mapFlagsOffset,
  type MapKeyAccess,
  releaseSym,
  retainSym,
  traceArg,
  vAdapters,
} from "./shapes.js";
import type { ExprOf, LibCallExpr, LlStreamTypedRefAdapter, LlValue } from "./expr-context.js";
import { INLINE_LITERAL_BYTES } from "./string-literal-equality.js";
import {
  emitFfiCallbackDefs,
  emitLibDefs,
  emitModuleParts,
  emitParts,
  helperDefs,
} from "./emit-module.js";
import {
  emitLoopCopies,
  emitSpeculativeWrite,
  emitStmtBody,
  emitStringSelfConcatAssign,
  emitSwitch,
  emitTryCatch,
} from "./emit-statements.js";
import {
  emitArgPackAndTrampolinePrologue,
  emitAsyncAwaitCall,
  emitAsyncScaffolding,
  emitFunction,
  emitGenScaffolding,
  emitWasiFulfill,
  fiberlessAsyncFunctions,
  parkingFunctions,
} from "./emit-function.js";
import {
  analyzeBorrowedReturns,
  canBorrowCallArgument,
  canBorrowReceiver,
  canStackReceiver,
  emitReadReceiver,
  fieldAliasMetadata,
  isStackUnionSource,
} from "./receivers.js";

export { LlvmUnsupportedError } from "./unsupported.js";

export interface LlArgPackAndTrampolinePrologue {
  definitions: string[];
  pack: string;
  lifted: boolean;
  fieldTys: string[];
  ret: IrType;
  tr: string[];
  spawnParams: string[];
  argPackLines: string[];
}

export function ffiCallbackDummyLl(callback: IrFfiCallbackParam["callback"]): string {
  switch (callback.returns) {
    case "i64":
    case "u64":
      return "i64 0";
    case "pointer":
      return "ptr null";
    case "void":
      return "void";
    case "f64":
      return "double 0.0";
    case "f32":
      return "float 0.0";
    case "bool":
    case "u8":
    case "i8":
      return "i8 0";
    case "u16":
    case "i16":
      return "i16 0";
    case "u32":
    case "i32":
      return "i32 0";
  }
}

export interface LlScopeEntry {
  slot: string;
  type: IrType;
  boxed?: boolean;
  /** A lazily created box: the slot stays null on paths that build no
   * environment, which skip the release call. */
  lazy?: boolean;
}

/** Process primitives for forked emission workers. */
export interface ForkPrimitives {
  /** 0 in the worker, the worker's pid in the parent, -1 on failure. */
  fork(): number;
  /** Ends the worker without running exit handlers. */
  exit(code: number): void;
  /** The worker's exit status, 128 plus a signal number, or -1. */
  wait(pid: number): number;
}

export interface LlvmTargetOptions {
  /** C ABI target; omitted direct emission uses the host ABI. */
  targetTriple?: string;
  /** Emit the function bodies in this many contiguous ranges, each by its
   * own emitter, and merge them in function order (emit-journal.ts). The
   * output is the same as one emitter's. Debug builds (`debugSources`)
   * emit in one emitter. */
  functionChunks?: number;
  /** Emit the function bodies of a large module on this many forked worker
   * processes at a time (emit-module.ts), forked with `forkPrimitives`. The
   * output is the same as one emitter's. Debug builds (`debugSources`)
   * emit in one emitter. */
  functionWorkers?: number;
  /** The host's process primitives, where it can fork (the native
   * compiler's). */
  forkPrimitives?: ForkPrimitives | undefined;
  /** Exact frontend sources for dev-build locations and variable metadata. */
  debugSources?: ReadonlyMap<string, string>;
  /** Pointer width of the target C ABI. Native targets are 64-bit today. */
  pointerBits?: 32 | 64;
  /** Select the WASI libc entry-point convention. */
  wasi?: boolean;
  /** Library archive assembly may move the volatile identity getters into a
   * separate translation unit. Public/direct emission keeps them by default. */
  emitLibraryIdentity?: boolean;
  /** Program objects carry a strong reference to the matching runtime ABI
   * marker so a manual link against an incompatible runtime fails. */
  runtimeAbiMarker?: boolean;
  /** Emit live-object audit notes in emitted new/free helpers. Only the
   * sanitized lane's SCR_RC_AUDIT runtime counts them; production plain
   * builds pass false so release/dev objects carry no empty calls.
   * Defaults to true for direct emission. */
  objectAudit?: boolean;
  /** Emit retain/release fast paths inline: `speed` for every family with a
   * fast path, `release` for the string retain and the dyn retain and
   * release (shapes.ts InlineRcMode). Off, every retain and release is a
   * runtime call. */
  inlineRc?: InlineRcMode;
  /** Define the inline RC fast-path helpers `noinline` (sanitized builds). */
  rcHelpersNoinline?: boolean;
  /** Define `scr_detached_exit` so the Linux runtime hands the address-space
   * teardown after `process.exit` to a helper process (`--detached-exit`).
   * Executables only; the runtime's weak default keeps it off. */
  detachedExit?: boolean;
  /** Translated WebAssembly memories check bounds explicitly instead of
   * relying on guard pages (wasm-modules.ts wasmBoundsChecks). */
  wasmBoundsChecks?: boolean;
  /** The executable can reserve its program-lifetime region below 32 GiB
   * (lowRegionTarget): fields that refer to compact class instances then
   * store the instance's address over 8 in 32 bits (classes.ts
   * compactRefLoadLines). Elsewhere they keep 8-byte pointers. */
  lowRegion?: boolean;
  /** The x86-64 level the program's code may require (`--target-cpu`):
   * every emitted function carries it as its `target-cpu`. Unset, code
   * runs on any x86-64 CPU. */
  targetCpu?: TargetCpu;
}

/** LlvmTargetOptions.lowRegion for an executable: Linux targets without
 * sanitizers, whose address space below 32 GiB is free (ASan keeps its
 * shadow memory there; other systems map their own images and libraries
 * there). `platform` is a target platform (`linux`, `darwin`, `win32`,
 * `wasi`). */
export function lowRegionTarget(platform: string, sanitize: boolean): boolean {
  return platform === "linux" && !sanitize;
}

/** Function versions on loop-bounding number parameters
 * (ir/parameter-versions.ts). Library builds have no int32 entries, and a
 * module that observes call stacks could see the version's frame. */
function versionParameters(mod: IrModule): IrModule {
  if (mod.lib !== undefined || observesStacks(mod)) return mod;
  return versionLoopBoundParameters(mod, mangleFunction);
}

/** The int32 arrays the int32 slot analysis keeps in `mod` (proven and
 * checked), under the inputs LlEmitter gives it (selectInt32Arrays). */
function provenInt32Arrays(mod: IrModule): ReadonlySet<string> {
  const slots = analyzeInt32Slots(mod, {
    dynamicStores: dynamicFieldStores(mod),
    initializerBindings: findInitializerBindings(mod),
  });
  return new Set([...slots.int32Arrays, ...slots.checkedInt32Arrays]);
}

/** The functions whose calls the backend may emit as calls of their
 * result-slot entries (record-results.ts). */
function resultEntryTargets(mod: IrModule): ReadonlySet<string> {
  const names = new Set(mod.functions.map((fn) => fn.name));
  const targets = new Set<string>();
  for (const name of names) if (names.has(resultEntryName(name))) targets.add(name);
  return targets;
}

/** The emitter for `input` after the module passes every emission runs. */
function moduleEmitter(input: IrModule, options: LlvmTargetOptions): LlEmitter {
  // Facts are keyed by node identity: emit the same module whether it was
  // lowered in memory or read back from its serialized form.
  const mod = unshareNodes(input);
  // Keep source storage intact for debugger inspection in dev builds.
  return new LlEmitter(
    options.debugSources === undefined
      ? selectInt32Arrays(
          versionParameters(
            addRecordResultEntries(
              scalarizeNumericRecords(
                specializeCallbackCalls(
                  specializeNumericCalls(
                    foldConstantGlobals(
                      copyStableCaptures(
                        resolveSelfCaptures(
                          hoistFinalFieldReads(
                            freezeInitOnlyGlobals(
                              holdCharLocalsAsUnits(
                                dropUnwrittenPropertyBags(runPairedWhileLoopsAsFor(mod)),
                              ),
                            ),
                          ),
                        ),
                      ),
                    ),
                    mangleFunction,
                  ),
                  mangleFunction,
                ),
              ),
            ),
          ),
          provenInt32Arrays,
          resultEntryTargets,
        )
      : mod,
    options,
  );
}

export function emitLlvmModule(input: IrModule, options: LlvmTargetOptions = {}): string {
  return moduleEmitter(input, options).emit();
}

/** emitLlvmModule's text as parts that concatenate to it, without the copy
 * that joining them makes: a large program's text is 150 MB. */
export function emitLlvmModuleParts(input: IrModule, options: LlvmTargetOptions = {}): string[] {
  return moduleEmitter(input, options)
    .emitParts()
    .flatMap((part, index) => (index === 0 ? [part] : ["\n", part]));
}

/** Keep large translation units below the host's single-string limit. */
export function emitLlvmModuleSource(
  input: IrModule,
  options: LlvmTargetOptions = {},
): string | readonly string[] {
  // IR validation, contracts and the frontend's disposal run after lowering without checks.
  relieveHeapPressure(true);
  const parts = moduleEmitter(input, options).emitParts();
  const length = parts.reduce((total, part) => total + part.length, Math.max(0, parts.length - 1));
  if (length <= 256 * 1024 * 1024) return parts.join("\n");
  return parts.flatMap((part, index) => (index === 0 ? [part] : ["\n", part]));
}

export function llStrBytes(text: string): string {
  return llBytes(wtf8Bytes(text));
}

const NO_BORROWED: ReadonlySet<number> = new Set();

/** Runtime entry points (and await-call entries) that may park the running
 * execution context, as they appear in emitted function text. */
export const SUSPENDS =
  /@(?:scr_(?:await_|module_await\b|promise_await_settled\b|test_sub\b|gen_yield_|async_gen_|fiber_)|sc_a[wd]_)/;
/** The suspensions of a fiber body's own awaits, which its stackless
 * coroutine form suspends itself at instead. */
const AWAIT_SUSPENSIONS = /@(?:scr_await_(?:void|f64|bool|str|ref|hop)\b|sc_a[wd]_[A-Za-z0-9_]+)/g;
/** SUSPENDS in a stackless coroutine body, whose frame bookkeeping reads its
 * own fiber and promise. */
const COROUTINE_SUSPENDS =
  /@(?:scr_(?:await_|module_await\b|promise_await_settled\b|test_sub\b|gen_yield_|async_gen_|fiber_(?!self\b|promise\b))|sc_a[wd]_)/;
/** Captured bindings (boxes a body declares or receives) from which a
 * function compiles without LLVM optimization (see boxSlotCount). */
export const UNOPTIMIZED_BOX_SLOTS = 512;
/** ScrExcKind tags of a generator slot holding a number or a boolean. */
const SCR_EXC_F64 = 1;
const SCR_EXC_BOOL = 2;

/** The capture boxes `fn` holds: its boxed bindings and the bindings its
 * environment brings in. Each box pointer is a value from its binding (or
 * function entry) to its last use, and every one of them crosses the calls
 * in between. With thousands of them in one body, as in a factory whose
 * returned methods share a large environment, LLVM's inliner, instruction
 * selection and register allocation grow quadratically and take minutes.
 * Past UNOPTIMIZED_BOX_SLOTS, which ordinary functions stay far below, the
 * body is compiled `optnone` (nothing inlines into it and code generation
 * takes its fast paths) and its box slots are accessed volatile, so no
 * pass promotes them to values even where a pipeline runs IR passes over
 * optnone bodies, as the native helper's does. Each use reloads its box
 * pointer and code generation stays linear. Semantics, boxes and
 * environments are unchanged; only that body's machine code is slower. */
export function boxSlotCount(fn: IrFunction): number {
  const captured = new Set<string>();
  for (const capture of fn.captures ?? []) captured.add(capture.localId);
  for (const capture of fn.classCaptures ?? []) captured.add(capture.localId);
  let count = 0;
  for (const local of fn.locals) if (local.boxed === true || captured.has(local.id)) count++;
  return count;
}

/** Whether any node of `e` names the local (reads, writes, declarations,
 * captures). */
/** Typed-array loop versions nest at most this deep (each doubles a body). */
export const MAX_BYTES_LOOP_VERSION_DEPTH = 3;

function mentionsLocal(e: IrExpr, localId: string): boolean {
  const exprNames = (node: IrExpr): boolean => {
    if (node.kind === "varRef" || node.kind === "incDec" || node.kind === "assignExpr")
      return node.localId === localId;
    if (node.kind === "closure") return node.captures.includes(localId);
    if (node.kind === "classRef") return node.captures?.includes(localId) === true;
    return false;
  };
  const stmtNames = (node: IrStmt): boolean => {
    if (
      node.kind === "varDecl" ||
      node.kind === "assign" ||
      node.kind === "forOf" ||
      node.kind === "rethrow"
    )
      return node.localId === localId;
    return false;
  };
  let found = false;
  const expr = (node: IrExpr): boolean => {
    if (found || exprNames(node)) return !(found = true);
    return everyExprChild(node, expr, stmt);
  };
  const stmt = (node: IrStmt): boolean => {
    if (found || stmtNames(node)) return !(found = true);
    return everyStmtChild(node, expr, stmt);
  };
  expr(e);
  return found;
}

/** The IR nodes in `body` that name local `id`: its declaration, reads,
 * writes and closure captures. */
function countLocalMentions(body: readonly IrStmt[], id: string): number {
  let count = 0;
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const record = node as Record<string, unknown>;
    if (record["localId"] === id) count++;
    const captures = record["captures"];
    if (Array.isArray(captures))
      for (const c of captures)
        if (
          c === id ||
          (typeof c === "object" && c !== null && (c as { localId?: unknown }).localId === id)
        )
          count++;
    for (const [key, value] of Object.entries(record))
      if (key !== "type" && key !== "loc" && key !== "captures") visit(value);
  };
  visit(body);
  return count;
}

export class LlEmitter {
  /** Per-feature state (emitter-state.ts), indexed by each key's slot. */
  readonly moduleStates: unknown[] = [];
  localArrayReads = new Map<string, LocalArrayRead>();
  loopArrayBorrows: ReadonlySet<IrStmt> = new Set();
  scalarStringSlices = new Map<string, IrExpr & { kind: "strIntrinsic" }>();
  readonly stringSlices = new Map<string, StringSliceSnapshot>();
  /** Slices written into stack buffers (findScratchStringSlices). */
  scratchStringSlices: ReadonlySet<IrExpr> = new Set();
  /** String parameters a caller may lend scratch slices to. */
  lentStringParameters: LentStringParameters = new Map();
  localStackUnions = new Map<string, IrExpr & { kind: "unionWrap" }>();
  localStackObjects = new Map<string, StackObjectSource>();
  reassignedStackObjects = new Set<string>();
  /** The binding slot of each reassigned stack-object local. */
  stackObjectSlots = new Map<string, string>();
  /** Entry-block pointers to the reference fields of each frame object
   * slot (stack-objects.ts stackObjectFields). */
  stackObjectFieldPtrs = new Map<string, readonly StackObjectField[]>();
  localUnionStorageProofs = new Map<string, LocalUnionStorageProof>();
  localUnionStorage = new Map<string, LocalUnionStorage>();
  integerArrayBindings = new Set<string>();
  readonly fieldAliasTags = new Map<string, number>();
  readonly fieldPointerTags = new Map<string, number>();
  /** The field pointers (classFieldPtr) of this function whose fields hold
   * 32-bit references to compact class instances (LlClassMeta.compressed):
   * loadField/loadRef decode them and storeField/storeRef encode them. */
  readonly compressedFieldPtrs = new Set<string>();
  /** Compact class instances live in the program-lifetime region below
   * 32 GiB (LlvmTargetOptions.lowRegion, and the program has compact
   * classes): main reserves it before compiled code runs (scr_plr_init), and
   * fields and arrays of compactRefType hold 32-bit references. */
  compactRegion = false;

  /** Native class fields with different property names cannot occupy the
   * same slot of one object. Inherited views of the same property share a
   * tag. Array storage has its own disjoint categories; untagged runtime
   * operations and record views conservatively alias all of them. */
  private markFieldPointer(ptr: string, field: string): void {
    this.markMemoryPointer(ptr, `field:${field}`);
  }

  markMemoryPointer(ptr: string, field: string): void {
    if (this.debug !== null) return;
    let tag = this.fieldAliasTags.get(field);
    if (tag === undefined) {
      tag = 2 + this.fieldAliasTags.size * 2;
      this.fieldAliasTags.set(field, tag);
    }
    this.journal?.entry("tag", field, tag);
    this.fieldPointerTags.set(ptr, tag);
  }

  /** The alias tag of a runtime word that emitted code reads and writes
   * outside every field (the lifetime-region count, owner and cursors). */
  memoryAliasAttachment(category: string): string {
    if (this.debug !== null) return "";
    let tag = this.fieldAliasTags.get(category);
    if (tag === undefined) {
      tag = 2 + this.fieldAliasTags.size * 2;
      this.fieldAliasTags.set(category, tag);
    }
    this.journal?.entry("tag", category, tag);
    return `, !tbaa !${tag}`;
  }

  /** The current function's int32 array allocations: the array literals
   * its int32 arrays are written with. They construct SCR_ELEM_I32 arrays. */
  int32Allocations = new Set<IrExpr>();
  /** The fill temporaries (`new Array(n).fill(v)`) of those allocations:
   * the same arrays, so int32 too. */
  int32ArrayTemps = new Set<string>();
  /** The same for the current function's int32 arrays with checked stores,
   * which are only allocated by fills (ir/int32-arrays.ts
   * checkableInt32Allocations): their temporaries' literals, with the fill's
   * length (a literal constructs SCR_ELEM_I32 storage when that length is at
   * least CHECKED_INT32_MIN_LENGTH, SCR_ELEM_F64 otherwise), and their
   * temporaries. */
  checkedAllocations = new Map<IrExpr, IrExpr>();
  checkedArrayTemps = new Set<string>();
  /** The fill calls (`.fill(v)`) of those allocations: a value that is not
   * an int32 widens the new array first. */
  checkedFills = new Set<IrExpr>();

  /** Collect the int32 allocations of `fn`, about to be emitted. */
  findInt32Allocations(fn: IrFunction): void {
    this.int32Allocations.clear();
    this.int32ArrayTemps.clear();
    this.checkedAllocations.clear();
    this.checkedArrayTemps.clear();
    this.checkedFills.clear();
    const { int32Arrays, checkedInt32Arrays } = this.int32Slots;
    if (int32Arrays.size === 0 && checkedInt32Arrays.size === 0) return;
    everyStmtList(fn.body, {
      stmt: (s) => {
        if (s.kind !== "varDecl" && s.kind !== "assign") return true;
        const key = int32ArrayKey(fn.name, s.localId);
        const checked = checkedInt32Arrays.has(key);
        if (!checked && !int32Arrays.has(key)) return true;
        const value = s.kind === "varDecl" ? s.init : s.value;
        const allocation = value && allocatedLiteral(value);
        if (!allocation) return true;
        const length = checked ? fillAllocationLength(value) : null;
        if (length !== null) this.checkedAllocations.set(allocation.literal, length);
        else if (!checked) this.int32Allocations.add(allocation.literal);
        if (allocation.temporary !== null)
          (checked ? this.checkedArrayTemps : this.int32ArrayTemps).add(allocation.temporary);
        if (checked && value !== allocation.literal) this.checkedFills.add(value!);
        return true;
      },
      expr: () => true,
    });
  }

  /** Whether `arr` reads one of the int32 arrays (ir/int32-arrays.ts, kept
   * by the int32 slot analysis): a local or parameter of the current
   * function, or a module global. */
  int32Array(arr: IrExpr): boolean {
    if (arr.kind !== "varRef") return false;
    if (this.int32KindArray(arr)) return true;
    if (this.int32Slots.int32Arrays.size === 0) return false;
    return (
      this.int32ArrayTemps.has(arr.localId) ||
      this.int32Slots.int32Arrays.has(int32ArrayKey(this.currentFunctionName, arr.localId))
    );
  }

  /** Whether `arr` is one of the current function's int32 arrays with
   * checked stores: int32 slots until a store widens it to doubles. Every
   * access tests its kind (emitByElementKind), except in the fast copy of
   * an int32 kind loop, which reads and writes it as an int32 array. */
  checkedInt32Array(arr: IrExpr): boolean {
    if (arr.kind !== "varRef" || this.int32KindArray(arr)) return false;
    if (this.int32Kinds?.wide.has(`${this.currentFunctionName}\0${arr.localId}`)) return false;
    return this.checkedInt32Local(arr.localId);
  }

  /** Whether the local `localId` holds one of the current function's int32
   * arrays with checked stores. */
  checkedInt32Local(localId: string): boolean {
    if (this.int32Slots.checkedInt32Arrays.size === 0) return false;
    return (
      this.checkedArrayTemps.has(localId) ||
      this.int32Slots.checkedInt32Arrays.has(`${this.currentFunctionName}\0${localId}`)
    );
  }

  /** Whether `arr` is an int32 array with checked stores that the fast copy
   * of the int32 kind loop being emitted holds as an int32 array. */
  int32KindArray(arr: IrExpr): boolean {
    return (
      this.int32Kinds !== null &&
      arr.kind === "varRef" &&
      this.int32Kinds.int32.has(`${this.currentFunctionName}\0${arr.localId}`)
    );
  }

  /** Before a store of `value` (of `expr`) into `arr`, in the fast copy of
   * an int32 kind loop: continue when it is an int32 that is not -0, and
   * otherwise leave for the statement's resume point, where it re-executes
   * with kind tests. Returns the value as an i32 when it is at hand as an
   * integer, or null when the store converts the double itself. */
  emitInt32KindStoreCheck(arr: IrExpr, value: LlValue, expr: IrExpr): string | null {
    if (!this.int32KindArray(arr) || withinInt32(this.integerRanges.get(expr))) return null;
    const integer = exactInteger(this, value, expr);
    if (integer !== null && withinInt32(integer.range)) return narrowInteger(this, integer);
    const resume = this.int32KindResume;
    if (resume === null)
      throw new InternalCompilerError("llvm emitter bug: an int32 kind store without a resume");
    const B = this.B;
    const ok = B.tmp(),
      int = B.tmp();
    if (integer !== null) {
      // An exact integer: a range test on its 64-bit form.
      const wide = widenInteger(this, integer),
        low = B.tmp(),
        high = B.tmp();
      B.line(`${low} = icmp sge i64 ${wide}, -2147483648`);
      B.line(`${high} = icmp sle i64 ${wide}, 2147483647`);
      B.line(`${ok} = and i1 ${low}, ${high}`);
      const store = B.newLabel("arr.store.i32");
      B.condBr(ok, store, resume);
      B.startBlock(store);
      B.line(`${int} = trunc i64 ${wide} to i32`);
      return int;
    }
    this.declare("declare i32 @llvm.fptosi.sat.i32.f64(double)");
    const back = B.tmp(),
      exact = B.tmp(),
      bits = B.tmp(),
      notNegativeZero = B.tmp();
    B.line(`${int} = call i32 @llvm.fptosi.sat.i32.f64(double ${value.name})`);
    B.line(`${back} = sitofp i32 ${int} to double`);
    B.line(`${exact} = fcmp oeq double ${back}, ${value.name}`);
    B.line(`${bits} = bitcast double ${value.name} to i64`);
    B.line(`${notNegativeZero} = icmp ne i64 ${bits}, -9223372036854775808`);
    B.line(`${ok} = and i1 ${exact}, ${notNegativeZero}`);
    const store = B.newLabel("arr.store.i32");
    B.condBr(ok, store, resume);
    B.startBlock(store);
    return int;
  }

  /** Emit an access to the checked int32 array `array` once per element
   * kind: `arm("i32", widened)` while it holds int32 slots and
   * `arm("f64", widened)` after it widened, joined after both. `widened` is
   * the label of the double arm, where an int32 arm's store of a value that
   * is not an int32 continues after widening the array. Returns the phi of
   * the arms' results (of LLVM type `ty`), or null when `ty` is null. */
  emitByElementKind(
    array: string,
    ty: string | null,
    arm: (acc: "i32" | "f64", widened: string) => string | null,
  ): string | null {
    const B = this.B;
    const narrow = B.newLabel("arr.kind.i32"),
      wide = B.newLabel("arr.kind.f64"),
      join = B.newLabel("arr.kind.join");
    const kindPtr = B.tmp(),
      kind = B.tmp(),
      isInt32 = B.tmp();
    B.line(
      `${kindPtr} = getelementptr inbounds %ScrArr, ptr ${array}, i32 0, i32 ${SCR_ARR_FIELD.elem}`,
    );
    this.markMemoryPointer(kindPtr, "array:header");
    B.line(`${kind} = load i8, ptr ${kindPtr}${this.fieldAliasAttachment(kindPtr)}`);
    B.line(`${isInt32} = icmp eq i8 ${kind}, ${SCR_ELEM_I32}`);
    B.condBr(isInt32, narrow, wide);
    B.startBlock(narrow);
    const narrowValue = arm("i32", wide);
    const narrowEnd = B.isTerminated() ? null : B.currentLabel();
    if (narrowEnd !== null) B.br(join);
    B.startBlock(wide);
    const wideValue = arm("f64", wide);
    const wideEnd = B.isTerminated() ? null : B.currentLabel();
    if (wideEnd !== null) B.br(join);
    B.startBlock(join);
    // Arms that end in their own branches (a read's shared join) leave this
    // join without predecessors.
    if (narrowEnd === null && wideEnd === null) B.terminate("unreachable");
    if (ty === null) return null;
    const arms: string[] = [];
    if (narrowEnd !== null) arms.push(`[ ${narrowValue}, %${narrowEnd} ]`);
    if (wideEnd !== null) arms.push(`[ ${wideValue}, %${wideEnd} ]`);
    const result = B.tmp();
    B.line(`${result} = phi ${ty} ${arms.join(", ")}`);
    return result;
  }

  /** Before storing the double `value` (of `expr`) into an int32 arm
   * (emitByElementKind) of the checked int32 array `array`: continue in this
   * arm when it is an int32 that is not -0, or widen the array and continue
   * at `widened`. A value proven an int32 needs no test. */
  emitCheckedInt32Store(array: string, value: string, expr: IrExpr, widened: string): void {
    if (withinInt32(this.integerRanges.get(expr))) return;
    const B = this.B;
    this.declare("declare i32 @llvm.fptosi.sat.i32.f64(double)");
    this.declare("declare void @scr_arr_widen_i32(ptr)");
    const int = B.tmp(),
      back = B.tmp(),
      exact = B.tmp(),
      bits = B.tmp(),
      notNegativeZero = B.tmp(),
      ok = B.tmp();
    B.line(`${int} = call i32 @llvm.fptosi.sat.i32.f64(double ${value})`);
    B.line(`${back} = sitofp i32 ${int} to double`);
    B.line(`${exact} = fcmp oeq double ${back}, ${value}`);
    B.line(`${bits} = bitcast double ${value} to i64`);
    B.line(`${notNegativeZero} = icmp ne i64 ${bits}, -9223372036854775808`);
    B.line(`${ok} = and i1 ${exact}, ${notNegativeZero}`);
    const store = B.newLabel("arr.store.i32"),
      widen = B.newLabel("arr.widen");
    B.condBr(ok, store, widen);
    B.startBlock(widen);
    B.line(`call void @scr_arr_widen_i32(ptr ${array})`);
    B.br(widened);
    B.startBlock(store);
  }

  /** The access an element operation on `arr` (of element type `elem`)
   * takes: int32 arrays read and write their 4-byte slots. */
  arrayAccess(arr: IrExpr, elem: IrType): ArrayAccess {
    if (this.checkedInt32Array(arr))
      throw new InternalCompilerError(
        "llvm emitter bug: a checked int32 array without its kind test",
      );
    return this.int32Array(arr) ? "i32" : elemAccess(elem);
  }

  /** Whether an element access at `index` of `arr` lies in the hole-free
   * prefix: a counter of a dense array loop's fast copy indexing one of the
   * arrays its entry test covered. */
  provenDenseIndex(arr: IrExpr, index: IrExpr): boolean {
    const loop = LOOPS.of(this).denseLoop;
    return (
      loop !== null &&
      arr.kind === "varRef" &&
      loop.arrays.has(arr.localId) &&
      index.kind === "varRef" &&
      (index.localId === loop.counter || index.localId === loop.pair?.high) &&
      this.integerLoopBindings.has(index.localId)
    );
  }

  fieldAliasAttachment(ptr: string): string {
    const tag = this.fieldPointerTags.get(ptr);
    return tag === undefined ? "" : `, !tbaa !${tag}`;
  }
  fieldAliasMetadata(): string[] {
    return fieldAliasMetadata(this);
  }
  readonly debug: LlvmDebugInfo | null;
  /** Projection-only scalar objects may live in frame storage (stack-objects.ts). */
  readonly stackObjects: boolean;
  debugScope: string | null = null;
  readonly sizeType: "i32" | "i64";
  readonly ffiExtendNarrowIntegers: boolean;
  readonly cycleBufOffset: number;
  /** Emitted ScrCycType descriptors so far (their collector statistics
   * indices; see ShapeHost.nextCycKind). */
  private cycKinds = 0;
  readonly wasi: boolean;
  /** Synchronous generator bodies compile to LLVM switched coroutines (a
   * heap frame resumed by an ordinary call) instead of running on a fiber
   * stack. Worker programs keep fibers (context shutdown unwinds suspended
   * generator stacks) and so do debug builds (the debugger reads locals
   * from the native frame). */
  private stacklessGenerators = false;
  /** Async bodies that suspend only at their own awaits compile to the same
   * switched coroutines on native targets (selectStacklessAsync), under the
   * generators' conditions; library and Windows builds keep fibers. */
  private stacklessAsyncAllowed = false;
  /** The async functions selectStacklessAsync lowered as coroutines. */
  readonly stacklessAsync = new Set<string>();
  /** Some function in the module is lowered as a coroutine. */
  usesCoroutines = false;
  /** The target lacks a rounding instruction at its baseline CPU (x86-64
   * before SSE4.1), so `llvm.trunc` would lower to a libm call: emit
   * truncation inline through an integer round trip instead. */
  readonly inlineTrunc: boolean;
  /** ELF worker executables give thread-locals the executable TLS models. */
  readonly executableTls: boolean;
  /** Source loops enclosing the statement being emitted in the current
   * function body. */
  loopDepth = 0;
  /** Darwin worker executables read the stack guard from a pthread
   * thread-specific-data slot off the thread pointer (scr_runtime.h's
   * SCR_STACK_GUARD_TSD): the architecture names the access sequence. */
  private readonly stackGuardTsd: "aarch64" | "x86_64" | null;
  readonly emitLibraryIdentity: boolean;
  readonly runtimeAbiMarker: boolean;
  readonly detachedExit: boolean;
  readonly targetCpu: TargetCpu | undefined;
  readonly wasmBoundsChecks: boolean;
  /** Interned string literals: UTF-8 text → { symbol, byte length } —
   * first-use order, the runtime ABI’s determinism discipline. */
  readonly literals = new Map<string, { sym: string; len: number }>();
  /** Literal equality helpers: literal text → helper symbol (literalEquals). */
  readonly literalEqualities = new Map<string, string>();
  /** Interned bigint literals: hex magnitude with sign → { symbol, value }. */
  readonly bigintLiterals = new Map<string, { sym: string; value: bigint }>();
  /** Symbols of interned constant data, named by content (contentSymbol). */
  private readonly contentSymbols = new Set<string>();
  /** Interned unit-armed union instances: "unionId:tag" → symbol — one
   * immortal (rc == SIZE_MAX) static per (union, unit tag).
   * RC entry points and the collector skip immortals. */
  readonly unitInstances = new Map<string, string>();
  /** unionId → symbol of the union's immortal ABSENT field-slot instance. */
  readonly absentInstances = new Map<string, string>();
  /** The zeroed box an inline store reads for a NULL union dummy. */
  needsUnionNone = false;
  /** unionId → symbol of a flag set once a checked-dynamic cast caches one
   * of the union's boxes. A cached box is refreshed in place, possibly with
   * a tag that another union numbers apart, so it is never shared. */
  readonly retypeGuards = new Map<string, string>();
  /** The nullable-union ABSENT sentinel was referenced (absentInstanceRef). */
  needsNullableAbsent = false;
  private readonly immortalValues = new Set<string>();
  /** Regex literal templates: "<flags>/<pattern>" → { symbol, interned
   * source/flags literal refs } — one immortal ScrRegex template per distinct
   * (pattern, flags) pair; the bytecode slot starts null and the runtime
   * compiles it lazily on first use. The source/flags strings intern at
   * REGISTRATION (bodies emit before the literal table flushes). */
  readonly regexInstances = new Map<
    string,
    { sym: string; src: string; fl: string; pattern: string; flags: string }
  >();
  /** Interned tagged-template strings objects: per-site key → { symbol,
   * interned cooked-literal refs }. One immortal ScrArr of string slots
   * per template SITE (the spec's per-occurrence identity — the C
   * emitter's templateStringsInstances discipline). */
  readonly templateStringsInstances = new Map<string, { sym: string; slots: string[] }>();
  /** Interned NUL-terminated C-string constants (scr_jb_puts labels, the
   * stringify indent text): UTF-8 text → { symbol, byte length }. */
  readonly cstrs = new Map<string, { sym: string; len: number }>();
  /** Interned ScrMapOps descriptors (scr_map.h): initializer → symbol. */
  readonly mapOpsConsts = new Map<string, string>();
  /** Method-id slots of checked-dynamic method calls
   * (scr_dyn_invoke_prepared_id): method name → symbol of an i32 the
   * runtime fills with the name's id on the first call. */
  readonly methodIdSlots = new Map<string, string>();
  /** Type-directed walker functions (JSON serializers, the indent
   * rewriter, union ToString/join) — interned per typeKey/unionId, defs
   * flushed with the shape helpers. */
  readonly walkers: LlWalkers;
  /** The dyn (ScrDyn dyn) helper registry — dyn.ts's interned ports of
   * walkers.ts's dyn slice. */
  readonly dyn: LlDyn;
  /** Explicit callback boundary for standalone layout and walker stages. */
  readonly shapeHost: DynHost;
  /** External declarations, in first-use order. */
  readonly decls = new Set<string>();
  /** Declared functions referenced as values: each needs an env-signature
   * wrapper + an interned immortal closure (so `f === f` holds). */
  readonly fnValues = new Set<string>();
  needsOom = false;
  needsBadTag = false;
  needsBadKey = false;
  needsRetainBox = false;
  /** Inline RC fast-path helpers requested by call sites (shapes.ts); null
   * when inline RC is off. */
  readonly rcHelpers: Set<string> | null;
  private readonly rcMode: InlineRcMode | undefined;
  private readonly rcHelpersNoinline: boolean;

  readonly fnByName = new Map<string, IrFunction>();
  /** Empty literals that construct with inline slots (appended-array-literals.ts). */
  appendedArrayLiterals: ReadonlySet<IrExpr> = new Set();
  /** Emitted LLVM text of every IR function body, by function name: the
   * fiberless-async analysis scans it for suspension entry points. */
  readonly fnDefText = new Map<string, string>();
  readonly referenceEffects: ReferenceEffects;
  /** Field-sensitive reference writes (null in debug builds). */
  referenceWrites: ReferenceWrites | null = null;
  readonly borrowedReturnKeyCache = new Map<string, string[]>();
  /** The statement list being emitted and the current index, for blocks
   * whose bindings end with the list (emitBlock and function bodies). */
  private stmtCursor: { stmts: IrStmt[]; index: number } | null = null;
  readonly optionalArrayReads: OptionalArrayReads;
  /** Union sources a binding or projection can hold in a stack box. */
  readonly unionSources: UnionSources;
  readonly checkedNarrows: CheckedNarrows;
  callArrayReads = new Map<IrExpr, LocalArrayRead>();
  mapReadLifetimes: MapReadLifetimes = { locals: new Map(), arguments: new Map() };
  readNumberMapWrites: ReadonlySet<IrExpr> = new Set();
  /** The current function's fused string-key Map get-then-set pairs (map-entry-fusion.ts). */
  mapEntryFusion: MapEntryFusion | null = null;
  readonly callLifetimes: CallLifetimes;
  readonly constantCallbacks: Map<string, Map<string, string>>;
  currentConstantCallbacks: ReadonlyMap<string, string> = new Map();
  /** The current function's running maximum and minimum updates, whose
   * branches are weighted as rarely taken (running-extrema.ts). */
  runningExtrema: ReadonlySet<IrStmt> = new Set();
  /** Callback bindings whose closures an enclosing callback loop version
   * proved to hold their known function: calls take the direct entry with
   * no fallback (emitCallbackVersionedLoop). */
  knownCallbacks = new Set<string>();
  readonly callbackVersioning = new Set<IrStmt>();
  callbackVersionsEnabled = false;
  readonly stackCallbacks: StackCallbacks;
  readonly receiverReaders: AmbientReceiverReaders;
  readonly stackCaptures: StackCaptures;
  readonly lazyCaptures: LazyCaptures;
  /** Unchanged captured parameters of the current function: each maps to
   * the slot caching its box, NULL until the first closure needs it. */
  readonly lazyCaptureBoxes = new Map<string, string>();
  readonly lazyStackBoxes = new Map<string, string>();
  borrowedParameters = new Set<string>();
  /** Captures of the current closure body that its environment holds
   * unchanged for the closure's whole life (LazyCaptures.stableCaptures). */
  stableCaptureIds: ReadonlySet<string> = new Set<string>();
  /** Parameters proven projection-only: callers may pass stack boxes. */
  projectedParameters = new Set<string>();
  stableCallBindings: ReadonlySet<string> = new Set();
  /** Locals and rebound parameters holding borrowed pointers for their
   * whole lifetime (walk-borrows.ts), per function and for the current one. */
  readonly walkBorrowsByFunction = new Map<string, ReadonlySet<string>>();
  walkBorrows: ReadonlySet<string> = new Set();
  /** Functions whose borrowing body returns its result without a reference
   * (analyzeBorrowedReturns), and whether the current body is one. */
  readonly borrowedReturns = new Set<string>();
  /** Rebound parameters that keep the borrowed convention with an owner
   * slot (rebound-parameters.ts), per function, and the current owner slots. */
  readonly reboundByFunction = new Map<string, ReadonlySet<string>>();
  readonly reboundOwnerSlots = new Map<string, string>();
  currentBorrowedReturn = false;
  /** Manifest-bound native imports, used by ffiCall emission. */
  readonly ffiByName = new Map<string, IrFfiImport>();
  /** C-ABI callback trampolines and (for raw/no-userdata callbacks) their
   * distinct call-scoped TLS closure slots. */
  readonly ffiCallbackAdapters: Map<string, FfiCallbackAdapter>;
  /** Module-level constant consulted per ffiCall: with a retained
   * descriptor anywhere in the manifest, every native call is a
   * pending-exception checkpoint (may-throw derives the same fact from
   * the same helper). */
  readonly ffiHasRetainedCallback: boolean;
  readonly ffiHasForeignCallback: boolean;
  private readonly globalTypes = new Map<string, IrType>();
  /** Module constants that keep one value once initialized
   * (immutability.ts stableGlobals). */
  stableGlobals: ReadonlySet<string> = new Set();
  /** Every function body's nodes in walk order (ir/node-index.ts), for the
   * constructor's analyses. */
  readonly nodeIndex: IrNodeIndex;
  private readonly tdzGlobals = new Map<string, string>();
  readonly constantNumericTables: ReadonlyMap<string, ConstantNumericTable>;
  /** Constant-key reads on checked-dynamic objects, each with its own
   * zero-initialized ScrDynReadIc (scr_runtime.h). */
  dynReadIcSites = 0;
  /** ThreadSlots blocks by family name (thread-slots.ts). */
  readonly threadSlotsBlocks = new Map<string, string>();
  /** May-throw analysis (computeMayThrow): pending
   * checks are emitted only after calls that can actually raise. */
  readonly mayThrow: Set<string>;
  readonly indirectMayThrow: boolean;
  /** Worker programs: the functions that poll for termination on entry
   * (workerTerminationPolls); null outside worker programs. */
  readonly workerEntryPolls: ReadonlySet<string> | null;
  /** Functions that check the native stack guard on entry
   * (stackCheckedFunctions); null where the runtime has no guard. */
  readonly stackChecks: ReadonlySet<string> | null;
  /** Static types whose values can be published (@scriptc/threads): their
   * stores carry the frozen-object guard. Null without publish calls. */
  readonly publishedTypes: PublishedTypes | null;
  /** Construction-only class and record fields (immutability.ts); null
   * where the facts are disabled. */
  private readonly immutableFields: ImmutableFields | null;
  /** Constructor function names: their bodies may still write their own
   * `this`'s construction-only fields. */
  readonly constructorFunctions: ReadonlySet<string>;
  inConstructor = false;
  /** Method names with at least one may-throw implementation — the
   * virtualCall pending check's key. */
  readonly mayThrowMethods = new Set<string>();
  /** Async functions awaited directly at some `await f(...)` site; each
   * gets an await-call entry (emitAsyncAwaitCall). */
  readonly awaitCallees = new Set<string>();
  /** Async functions returned directly at some `return f(...)` site of an
   * async function; each gets an adopting entry (emitAsyncAwaitCall). */
  readonly adoptCallees = new Set<string>();
  /** Fiberless async functions a stackless coroutine body awaits directly;
   * each gets an inline await entry (emitCoroInlineAwait). */
  readonly inlineAwaitCallees = new Set<string>();
  /** Stackless async functions some coroutine body awaits directly: each
   * gets a direct spawn entry (emitCoroDirectAwait). */
  readonly directAwaitCallees = new Set<string>();
  /** The async functions whose bodies never suspend and that a direct
   * await may enter in place (selectStacklessAsync). */
  private inlineAwaitable = new Set<string>();
  /** Locals whose array literal emitStmts left for the `await Promise.all`
   * that reads them (deferredPromiseAllLocal). */
  private readonly deferredPromiseAllEntries = new Map<string, ExprOf<"arrayLit">>();
  /** Empty array literals that a capacity hint follows directly
   * (reservedArrayLength), with that hint. Constructing the literal with
   * the hinted capacity consumes the hint, which then emits nothing. */
  readonly reservedArrayLengths = new Map<IrExpr, IrStmt & { kind: "arraySetLength" }>();
  readonly consumedReserves = new Set<IrStmt>();
  /** The promise a `return` emitted past its finally regions already
   * produced for its adopting await (borrowed from the return's parked
   * slot); that await takes it instead of evaluating its operand. */
  private adoptedOperand: LlValue | null = null;

  takeAdoptedOperand(): LlValue | null {
    const value = this.adoptedOperand;
    this.adoptedOperand = null;
    return value;
  }
  /** setTimeout and friends appeared somewhere: main must run the event
   * loop even in programs with no async functions. */
  usesTimers = false;
  /** The program calls mock.timers members (moduleUsesMockTimers): timer
   * calls emit scr_test.c's mock-aware entry points. */
  readonly mockTimers: boolean;
  private runtimeFeaturesValue: RuntimeFeatures | undefined;
  /** The module's runtime features (moduleRuntimeFeatures), found with one
   * walk of the module the first time any of them is read. */
  get runtimeFeatures(): RuntimeFeatures {
    return (this.runtimeFeaturesValue ??= moduleRuntimeFeatures(this.mod, this.nodeIndex));
  }
  /** Whether timer and tick scheduling goes through the *_als entry
   * points (RuntimeFeatures asyncContext). */
  get schedulesInContext(): boolean {
    return this.runtimeFeatures.asyncContext;
  }
  /** Emitted ref-kind resolve thunks for new Promise, interned per inner
   * typeKey → thunk symbol. */
  readonly resolveThunks = new Map<string, string>();
  readonly resolveThunkDefs: string[] = [];
  /** Inline array searches used by the module (array-search.ts). */
  readonly arraySearchKinds = new Set<ArraySearchKind>();
  /** Typed-ref recipe constants by type key (lazy receivers). */
  readonly typedRefRecipes = new Map<string, string>();
  /** ReadableStream.from adapters keep typed arrays by reference and box
   * one current element per pull. */
  readonly streamFromArrayAdapters = new Map<string, string>();
  /** Identity-preserving static→dyn capsules for program classes and Web
   * APIs whose values remain directly observable. */
  readonly liveDynRefAdapters = new Map<string, LlStreamTypedRefAdapter>();
  /** See moduleUsesDynBuiltinStream. */
  get usesDynBuiltinStream(): boolean {
    return this.runtimeFeatures.dynBuiltinStream;
  }
  /** A checked-dynamic for-await may hold a native stream: the program
   * links the stream unit (and the dyn-async one the loop needs). */
  get dynForAwaitStreams(): boolean {
    return this.runtimeFeatures.stream && this.runtimeFeatures.dynAsync;
  }
  /** Runtime-arm dispatchers for live union values. */
  readonly liveDynUnionRefAdapters = new Map<string, string>();
  readonly dynPromiseAdapters = new Map<string, string>();
  readonly unionsById = new Map<string, IrUnionDef>();
  readonly nullableFields: NullableRefFields;
  readonly inlineUnions: InlineUnionFields;
  /** Unions whose values are nullable arm pointers (nullable-unions.ts). */
  readonly nullableUnions: NullableUnions;
  /** The union table without nullable unions: the stack-box analyses. */
  readonly boxedUnionsById: Map<string, IrUnionDef>;
  readonly recordsById = new Map<string, IrRecordShape>();
  readonly recordCloneShapes = new Set<string>();
  readonly tracedShapes: Set<string>;
  readonly tracedUnions: Set<string>;
  /** Inline-cache sites of dynamic-tier functions (js-ic.ts): one
   * zero-initialized ScrJsIc per site (scr_js.h). */
  jsIcSiteCount = 0;
  private jsIcSitesMemo: JsIcSites | undefined;
  /** The tier of the function being emitted. */
  currentTier: IrFunction["tier"] = undefined;
  /** The class graph (buildClassGraph): preorder numbering, hierarchy
   * membership, virtual slot lists. */
  readonly classMeta: Map<string, LlClassMeta>;
  /** Which vtable slots borrow which parameters (virtual-borrows.ts). */
  private virtualBorrows!: VirtualBorrows;
  /** Class objects (classes as first-class values): className → the
   * interned .name literal ref — registered during body emission, the
   * statics and construct thunks assemble around the bodies. */
  readonly classObjs = new Map<string, { nameSym: string; baseNameSym: string | null }>();
  private readonly unionFieldReadGroups = new Map<string, number[][]>();
  /** Preorder intervals of the runtime error classes under THIS module's
   * class-forest numbering (main() stamps scr_error_vts with them, exactly
   * like the runtime ABI’s errorVtStampLines). */
  readonly errorIntervals: { kind: number; pre: number; post: number; lib: string }[] = [];
  /** The runtime emitter vtable's preorder interval, when the program
   * touches node:events (the class def rides the module exactly then) —
   * main() stamps scr_emitter_vt with it (emitterVtStampLines, ported). */
  emitterInterval: { pre: number; post: number } | null = null;
  /** The runtime stream vtables' preorder intervals (streamVtStampLines,
   * ported): the defs ride every emitter-touching module (the frontend
   * collects the whole emitter-rooted tree), and scr_stream.c links on
   * the same predicate, so the stamps always have their globals. */
  readonly streamIntervals: { vt: string; pre: number; post: number; lib: string }[] = [];

  // ── per-function state (reset in emitFunction) ─────────────────────────
  B = new BlockBuilder();
  frames: LlValue[][] = [];
  scopes: LlScopeEntry[][] = [];
  /** Scope slots dominate every throw site. Share their exceptional cleanup
   * for identical live bindings and handlers; statement temporaries stay at
   * their own throw sites because their SSA values are path-dependent. */
  readonly unwindCleanups = new Map<
    string,
    { label: string; entries: LlScopeEntry[]; terminator: string }
  >();
  /** Enclosing break/continue targets. `kind` separates loops from
   * switches and labeled blocks: an unlabeled break binds to the innermost
   * NON-BLOCK entry (loop or switch — blocks only enter the stack when
   * labeled, and only a labeled break can target one); an unlabeled
   * continue binds to the innermost LOOP; a labeled jump binds to the
   * entry whose `labels` contains its label. `contLabel` is null exactly
   * for blocks and switches. */
  jumpTargets: {
    kind: "loop" | "block" | "switch";
    brkLabel: string;
    contLabel: string | null;
    labels?: string[] | undefined;
    frameDepth: number;
    scopeDepth: number;
    finallyDepth: number;
  }[] = [];
  currentLocals = new Map<string, IrLocal>();
  privateSplitLocals = new Map<string, StringSplit>();
  readonly splitSpans = new Map<string, SplitSpan>();
  storedSplits = new Map<string, StoredSplitSnapshot>();
  streamingSplitsEnabled = false;
  readonly initializerBindings: ReturnType<typeof findInitializerBindings>;
  /** Whole-program int32 storage and parameter/result facts. */
  readonly int32Slots: Int32Slots;
  /** The program has no runtime store into a checked-dynamic value
   * (dynamicFieldStores), so live views of classes and records never
   * commit back into their objects. Library builds keep their commits:
   * their values cross a native boundary. */
  readonly liveViewsReadOnly: boolean;
  /** Functions whose direct calls use i32 parameters or results. */
  readonly int32Abis: ReadonlyMap<string, Int32Abi>;
  /** Pure number functions with speculative integer clones. */
  readonly integerClones: IntegerClones;
  /** The IR function being emitted. */
  currentFunctionName = "";

  integerParamRange(fnName: string, localId: string): IntegerRange | null {
    return this.int32Slots.facts(fnName).params?.get(localId) ?? null;
  }
  /** Immutable module constants (contract types) whose graphs become
   * immortal once initialized: their reads need no reference counting. */
  readonly immortalGlobals: ReadonlySet<string>;
  /** ProgramLifetime hierarchy roots (contract types): their instances are
   * immortal from construction (classes.ts programLifetimeClass). */
  readonly programLifetime: ReadonlySet<string>;
  numericLocals = new Map<string, IrLocal>();
  captureIds = new Set<string>();
  /** Active induction bindings retain their width independently of size_t. */
  integerLoopBindings = new Map<
    string,
    { slot: string; type: "i32" | "i64"; signed?: boolean; range?: { min: number; max: number } }
  >();
  /** Constant number locals whose latest emitted declaration stored an
   * exact integer beside the double, such as `const j = i * 4` in a
   * typed-array loop version: an i64 slot and the integer's range. */
  integerTemps = new Map<
    string,
    { slot: string; type: "i64"; signed: true; range: IntegerRange }
  >();
  /** Integer temps are kept only in optimized synchronous functions: an
   * async or generator body resumes with its locals in its frame, which
   * an entry alloca is not part of. */
  integerTempsEnabled = false;
  /** Speculative integer loops (speculative-integers.ts) run in this function. */
  speculativeLoopsEnabled = false;
  /** The fast copy of a speculative integer loop being emitted: its
   * integer-computed writes and where each resumes in the ordinary copy. */
  speculation: {
    writes: Set<IrStmt>;
    resume: Map<IrStmt, string>;
    /** Globals whose double is written back only when the copy is left. */
    deferred: Set<string>;
    /** The loop site's count of bailing entries in a row (a global), and
     * whether this entry completed a speculated write (a slot). A proven
     * integer loop has neither. */
    bails?: string;
    ran?: string;
  } | null = null;
  /** Speculative loop sites numbered so far in the module. */
  speculativeLoopSites = 0;
  /** The ordinary copy being emitted: resume labels still to place. */
  speculationResume: Map<IrStmt, { label: string; placed: boolean }> | null = null;
  /** Run once at the top of the next loop copy's header
   * (`enterLoopHeader`): records the ordinary copy's header, or sends the
   * third copy's header there. */
  speculationHeader: ((header: string) => void) | null = null;
  /** A copy of an int32 kind loop (int32-kind-loops.ts) being emitted: the
   * int32 arrays with checked stores it reads and writes as int32 arrays
   * (the fast copy) or as double arrays (an ordinary copy entered only
   * after they widened), as `function\0local` keys, and where each of the
   * fast copy's writes resumes in the third copy. */
  int32Kinds: { int32: Set<string>; wide: Set<string>; resume: Map<IrStmt, string> } | null = null;
  /** The resume label of the fast-copy write being emitted. */
  int32KindResume: string | null = null;
  /** The function being emitted, for speculative globals. */
  speculativeFunction = "";
  /** Every function that writes each number global (computed on demand). */
  private globalWriters: Map<string, Set<string>> | null = null;
  /** Whole-program final reference fields (ir/final-fields.ts). */
  finalFields!: FinalFields;
  /** The current function may borrow final fields of borrowable objects:
   * not a constructor (where they change), not async or a generator. */
  finalFieldBorrows = false;
  integerRanges: IntegerRanges = new Map();
  /** The current function's bounded for-loop cursors (integer-ranges.ts). */
  integerLoopRanges: ReadonlyMap<IrStmt, ReadonlyMap<string, IntegerRange>> = new Map();
  /** Number arrays of the current function whose every present element is
   * an int32 (Int32[] contracts), or null when the module has none. */
  int32Elements: ((arr: IrExpr) => boolean) | null = null;
  /** Sums whose result only feeds 32-bit conversions (wrapping-sums.ts). */
  wrappingSums = new Set<IrExpr>();
  /** Number locals of the current function that hold exact integers or NaN
   * (findIntegerOrNaNLocals in wrapping-sums.ts). */
  integerOrNaNLocals: ReadonlyMap<string, IntegerRange> = new Map();
  bytesBounds: ReadonlySet<IrExpr | IrStmt> = new Set();
  /** The charCodeAt reads standing for charAt reads the emitter rewrote
   * (one-unit tests and switches, charAtUnitRead), with the charAt each
   * stands for: a loop version's proof for the charAt covers its read. */
  readonly charAtUnitReads = new Map<IrExpr, IrExpr>();
  /** Worker programs: typed-array accesses whose views an enclosing version
   * guard proved thread-owned. */
  bytesOwned: ReadonlySet<IrExpr | IrStmt> = new Set();
  integerViews = new Map<string, string>();
  /** Module globals the current function owns outright (initializer
   * bindings): their function-local slot, which stands in for the global. */
  privateGlobalSlots = new Map<string, string>();
  /** Number locals of the current function stored only as an i32
   * (int32-locals.ts); their slots are `alloca i32`. */
  int32Locals = new Map<string, Int32Local>();
  /** The written values (and `++`/`--` nodes) the int32 proof covers. */
  int32LocalWrites: ReadonlySet<IrExpr> = new Set();
  /** Enclosing try-with-FINALLY regions, innermost last: a `return`
   * inside one runs every crossed finally (innermost first) before the
   * actual ret — the runtime ABI’s pending-return path, with the finally
   * bodies emitted inline at the return site instead of behind a goto.
   * `tryDepth` snapshots tryStack.length at region entry: a throw inside
   * a pending-return finally copy propagates OUT of the completing try
   * (past its own catch), so the copies emit under the truncated stack.
   * break/continue use the same region snapshots through
   * emitFinallysForJump. */
  finallyStack: {
    frameDepth: number;
    scopeDepth: number;
    tryDepth: number;
    body: IrStmt[];
  }[] = [];
  /** Enclosing try contexts, innermost last — the compile-time unwind
   * targets: a pending check or `throw` inside a try
   * releases frames/scopes down to the recorded depths and branches to
   * `label` (the catch, or the exception-path finally) instead of
   * returning out of the function. Entering a try emits no code. */
  tryStack: { label: string; used: boolean; frameDepth: number; scopeDepth: number }[] = [];
  /** Return type of the function being emitted — the unwind path returns
   * a dummy of this type (never read: callers check the flag first). */
  currentReturnType: IrType = VOID;
  /** The current body returns its number result as i32. */
  currentInt32Result = false;
  /** The function's i32 entry returns its scalar union result as tag and
   * payload bits (Int32Abi.union). */
  currentUnionResult = false;
  /** Active only while emitting a body lowered with LLVM's
   * switched-coroutine intrinsics (wasm32 async bodies and generators,
   * native synchronous generators; see coroLowered). */
  currentCoro: {
    kind: "async" | "generator";
    id: string;
    handle: string;
    self: string;
    finalLabel: string;
    cleanupLabel: string;
    suspendLabel: string;
    /** The generator's OUT slot (%ScrGenSlot) for a native body whose
     * yield channel is a number or boolean, which its yields store into
     * inline (see emitGenSlotStore); null otherwise. */
    out: string | null;
  } | null = null;
  /** Inline generator slot accesses need the %ScrGenHead/%ScrGenSlot
   * mirrors in the module header. */
  usesGenSlots = false;
  /** The generator channels of the function being emitted (null outside
   * generator bodies): yieldExpr emission reads them, and emitTryCatch's
   * catch prologue emits the GENRET sentinel re-unwind exactly here. */
  currentGenerator: { yieldT: IrType; nextT: IrType } | null = null;
  /** The function being emitted is an async generator body. */
  currentAsyncGenerator = false;
  /** Active optional-chain bind slots, by chain id (chainRecv reads). */
  readonly chainSlots = new Map<string, LlValue>();
  logArgSlots = 0;
  readonly stackTraces: boolean;
  /** The options this emitter was built with (chunk emitters reuse them). */
  readonly targetOptions: LlvmTargetOptions;
  /** Records the module-level effects of emitting a range of functions,
   * which the emitter that merges the range replays (emit-journal.ts). Null
   * when this emitter emits the whole module itself. */
  journal: EmitJournal | null;
  /** The emitter's hosts forward to `journal` (journal set, or workers). */
  private readonly journaled: boolean;
  /** Stack-trace mode: functions no capture can include (no frame push). */
  readonly unframedFunctions: ReadonlySet<string>;

  constructor(
    readonly mod: IrModule,
    options: LlvmTargetOptions,
    journal: EmitJournal | null = null,
  ) {
    this.targetOptions = options;
    this.journal = journal;
    this.journaled =
      journal !== null ||
      ((options.functionWorkers ?? 1) > 1 &&
        options.forkPrimitives !== undefined &&
        options.debugSources === undefined);
    // One walk of every body, which the analyses below read instead of
    // walking the bodies themselves.
    this.nodeIndex = new IrNodeIndex(mod);
    this.stackTraces = observesStacks(mod, this.nodeIndex);
    this.nullableUnions = new NullableUnions(
      mod,
      options.debugSources === undefined,
      this.nodeIndex,
    );
    this.mockTimers = this.runtimeFeatures.mockTimers;
    this.debug =
      options.debugSources === undefined
        ? null
        : new LlvmDebugInfo(
            mod.sourceFile,
            options.debugSources,
            options.pointerBits,
            mod.unions,
            this.nullableUnions.armTypes(),
          );
    this.constantNumericTables = findConstantNumericTables(mod);
    this.initializerBindings = findInitializerBindings(mod, this.nodeIndex);
    // One walk finds the dynamic field stores every analysis below consults.
    const dynamicStores = dynamicFieldStores(mod, undefined, undefined, this.nodeIndex);
    this.int32Slots = analyzeInt32Slots(mod, {
      dynamicStores,
      initializerBindings: this.initializerBindings,
      nodes: this.nodeIndex,
    });
    this.liveViewsReadOnly =
      mod.lib === undefined && !dynamicStores.all && dynamicStores.names.size === 0;
    this.int32Abis = this.debug === null ? findInt32Abis(mod, this.int32Slots) : new Map();
    this.immortalGlobals = new Set(mod.contracts?.immortalGlobals ?? []);
    this.programLifetime = new Set(mod.contracts?.programLifetime ?? []);
    this.finalFields = analyzeFinalFields(mod, false, dynamicStores, this.nodeIndex);
    this.sizeType = options.pointerBits === 32 ? "i32" : "i64";
    this.ffiExtendNarrowIntegers =
      options.wasi === true || ffiExtendsNarrowIntegers(options.targetTriple);
    this.wasi = options.wasi === true;
    this.stacklessGenerators = !this.wasi && mod.workers !== true && this.debug === null;
    this.stackObjects = this.debug === null;
    // An empty triple targets the host, as for executableTls below: the
    // Node-hosted CLI passes none, the native CLI passes its toolchain's, and
    // both must emit the same module for the same target.
    this.inlineTrunc =
      !this.wasi &&
      (options.targetTriple
        ? /^(x86_64|amd64)\b/i.test(options.targetTriple)
        : process.arch === "x64");
    this.executableTls =
      mod.workers === true &&
      mod.lib === undefined &&
      !this.wasi &&
      !/apple|darwin|windows|mingw|cygwin|win32/.test(options.targetTriple || process.platform);
    const host = options.targetTriple || `${process.arch}-${process.platform}`;
    this.stackGuardTsd =
      mod.workers === true && mod.lib === undefined && !this.wasi && /apple|darwin/.test(host)
        ? /^(arm64|aarch64)/.test(host)
          ? "aarch64"
          : /^(x86_64|amd64|x64)/.test(host)
            ? "x86_64"
            : null
        : null;
    this.emitLibraryIdentity = options.emitLibraryIdentity !== false;
    this.runtimeAbiMarker = options.runtimeAbiMarker === true;
    this.detachedExit = options.detachedExit === true;
    this.targetCpu = options.targetCpu;
    this.wasmBoundsChecks =
      options.wasmBoundsChecks === true ||
      wasmBoundsChecks({
        sanitize: false,
        pointerBits: options.pointerBits ?? 64,
        targetTriple: options.targetTriple ?? "",
      });
    this.rcHelpers = options.inlineRc !== undefined ? new Set() : null;
    this.rcMode = options.inlineRc;
    this.rcHelpersNoinline = options.rcHelpersNoinline === true;
    // ScrCycHdr.buf sits 4 bytes behind every object on every target.
    this.cycleBufOffset = CYC_HDR - CYC_BUF;
    this.ffiCallbackAdapters = allocateFfiCallbackAdapters(mod.ffiImports ?? []);
    this.ffiHasRetainedCallback = hasRetainedFfiCallback(mod.ffiImports ?? []);
    this.ffiHasForeignCallback = hasForeignFfiCallback(mod.ffiImports ?? []);
    for (const fn of mod.functions) this.fnByName.set(fn.name, fn);
    this.appendedArrayLiterals = findAppendedArrayLiterals(mod, this.nodeIndex);
    for (const entry of mod.ffiImports ?? []) {
      this.ffiByName.set(entry.name, entry);
    }
    // Executables on Linux and macOS install a native stack guard per thread
    // and per async fiber; WASI, Windows and library builds have none.
    const triple = (options.targetTriple ?? "").toLowerCase();
    const windows = triple === "" ? process.platform === "win32" : triple.includes("windows");
    this.publishedTypes = computePublishedTypes(mod, this.nodeIndex);
    const mt = computeMayThrow(mod, {
      stackChecks: !this.wasi && mod.lib === undefined && !windows,
      published: this.publishedTypes,
      nodes: this.nodeIndex,
    });
    this.mayThrow = mt.fns;
    this.workerEntryPolls = mt.workerEntryPolls ?? null;
    this.stackChecks = mt.stackChecks ?? null;
    // A stackless call's eager prefix borrows its caller's stack; the
    // runtime moves deep prefix nests to a fresh stack using the guard,
    // which Windows lacks.
    this.stacklessAsyncAllowed = this.stacklessGenerators && mod.lib === undefined && !windows;
    this.unframedFunctions = this.stackTraces
      ? captureFreeFunctions(mod, this.stackChecks, this.publishedTypes)
      : new Set();
    // One field-mutability answer serves immutable fields and traced shapes.
    const cycleMutability = computeCycleMutability(mod, hierarchyUnitOfClass(mod), dynamicStores);
    this.immutableFields = computeImmutableFields(mod, dynamicStores, cycleMutability);
    this.constructorFunctions = new Set((mod.classes ?? []).map((c) => `%${c.name}.constructor`));
    this.indirectMayThrow = mt.indirect || mod.workers === true;
    for (const cls of mod.classes ?? []) {
      for (const m of cls.methods ?? []) {
        if (this.mayThrow.has(`%${cls.name}.${m}`)) this.mayThrowMethods.add(m);
      }
    }
    for (const u of mod.unions ?? []) this.unionsById.set(u.id, u);
    this.boxedUnionsById = this.nullableUnions.boxedUnions(this.unionsById);
    this.immortalValues.add("null");
    this.immortalValues.add(NULLABLE_NULL);
    this.nullableFields = new NullableRefFields(mod.classes ?? [], this.boxedUnionsById);
    this.inlineUnions = new InlineUnionFields(this.boxedUnionsById, mod.classes ?? []);
    for (const r of mod.records ?? []) this.recordsById.set(r.id, r);
    // Optional array reads also cover nullable unions: emitLocalArrayRead
    // then yields the (borrowed or owned) element pointer, not a stack box.
    // Arrays of such a union are read the same way.
    this.optionalArrayReads = new OptionalArrayReads(
      this.fnByName,
      this.unionsById,
      (id) => this.nullableUnions.single(id) !== null,
    );
    this.unionSources = {
      unions: this.boxedUnionsById,
      receiverUnions: this.unionsById,
      nullableField: (e) => this.nullableFieldGet(e) !== null,
      inlineField: (e) => this.inlineFieldGet(e),
      arrayRead: (e) => this.optionalArrayReads.get(e) !== null,
      scalarCall: (e) => this.scalarResultCall(e),
    };
    this.checkedNarrows = new CheckedNarrows(this.fnByName);
    this.referenceEffects = new ReferenceEffects(
      this.fnByName,
      (call) => this.optionalArrayReads.get(call) !== null,
      mod.classes ?? [],
    );
    if (this.debug === null)
      this.referenceWrites = new ReferenceWrites(
        this.fnByName,
        mod.classes ?? [],
        (call) => this.optionalArrayReads.get(call) !== null,
        new Set((mod.globals ?? []).map((g) => g.id)),
        { unions: mod.unions, records: mod.records },
        this.immutableFields,
        this.nodeIndex,
      );
    const walkParameters = new Map<string, Set<number>>();
    if (this.debug === null) {
      const host = {
        pointerLocal: (local: IrLocal) => this.plainReference(local.type),
        borrowsWithoutOwning: (e: IrExpr) => this.borrowsWithoutOwning(e),
        nodes: this.nodeIndex,
      };
      for (const fn of this.fnByName.values()) {
        const preserving = this.referenceEffects.functions.has(fn.name);
        if (!preserving && this.referenceWrites === null) continue;
        const walks = findWalkBorrows(fn, preserving ? host : this.unwrittenWalkHost(fn, host));
        if (walks.size === 0) continue;
        this.walkBorrowsByFunction.set(fn.name, walks);
        const indexes = new Set<number>();
        fn.params.forEach((param, index) => {
          if (walks.has(param.localId)) indexes.add(index);
        });
        if (indexes.size > 0) walkParameters.set(fn.name, indexes);
      }
    }
    if (this.debug === null) {
      for (const fn of this.fnByName.values()) {
        // Strings keep the owned parameter: their in-place append
        // (`s = s + x`) needs a uniquely owned binding.
        const rebound = findReboundParameters(
          fn,
          (type) =>
            this.plainReference(type) &&
            type.kind !== "string" &&
            (type.kind !== "union" ||
              this.nullableUnions.single(type.unionId)?.arm.kind !== "string"),
          this.walkBorrowsByFunction.get(fn.name) ?? new Set(),
        );
        if (rebound.size === 0) continue;
        this.reboundByFunction.set(fn.name, rebound);
        const indexes = walkParameters.get(fn.name) ?? new Set<number>();
        fn.params.forEach((param, index) => {
          if (rebound.has(param.localId)) indexes.add(index);
        });
        walkParameters.set(fn.name, indexes);
      }
    }
    this.callLifetimes = analyzeCallLifetimes(
      this.fnByName,
      (className, field) => this.nullableFields.get(className, field) !== null,
      walkParameters,
      new Set([...this.int32Abis].filter(([, abi]) => abi.union).map(([name]) => name)),
      {
        record: (shapeId, field) => this.recordFieldInline(shapeId, field),
        classField: (className, field) => this.inlineUnions.classField(className, field),
      },
      (shapeId) => {
        const shape = this.recordsById.get(shapeId);
        return shape !== undefined && !recordDynKeepsIdentity(shape);
      },
      (wrap) => this.borrowableNullableWrap(wrap) === "ref",
    );
    this.lentStringParameters =
      this.debug === null ? findLentStringParameters(this.fnByName, this.callLifetimes) : new Map();
    this.constantCallbacks = findConstantCallbacks(mod, this.callLifetimes, this.nodeIndex);
    // Integer clones signal a stack overflow through their result, which
    // needs the single-threaded guard; worker programs also poll for
    // termination, and debug builds and stack traces keep every frame.
    // Clones read number arrays their function borrows (64-bit layouts).
    this.integerClones =
      this.debug === null &&
      this.stackChecks !== null &&
      mod.workers !== true &&
      mod.lib === undefined &&
      !this.stackTraces
        ? findIntegerClones(
            mod,
            this.sizeType === "i64"
              ? (fn, index) => this.callLifetimes.borrowed.get(fn)?.has(index) === true
              : undefined,
          )
        : NO_INTEGER_CLONES;
    this.stackCallbacks = new StackCallbacks(this.fnByName);
    this.receiverReaders = new AmbientReceiverReaders(this.fnByName);
    this.stackCaptures = new StackCaptures(this.fnByName, this.callLifetimes, this.stackCallbacks);
    this.lazyCaptures = new LazyCaptures(this.fnByName);
    const traced = computeTraced(mod, dynamicStores, cycleMutability);
    this.tracedShapes = traced.shapes;
    this.tracedUnions = traced.unions;
    // A shape union's value is whichever record it holds, and the collector
    // visits it as that record: when one arm carries a collector header,
    // every arm must (nullable-unions.ts). Unions that share an arm pass a
    // header on to each other's arms, so repeat until no union adds one.
    const shapeUnions = this.nullableUnions.allShapeUnions();
    for (let changed = true; changed;) {
      changed = false;
      for (const union of shapeUnions) {
        if (
          !this.tracedUnions.has(union.unionId) &&
          !union.arms.some((arm) => this.tracedShapes.has(`record:${arm.shapeId}`))
        )
          continue;
        for (const arm of union.arms) {
          const key = `record:${arm.shapeId}`;
          if (this.tracedShapes.has(key)) continue;
          this.tracedShapes.add(key);
          changed = true;
        }
      }
    }
    this.shapeHost = {
      // Journal hooks only on emitters that can emit ranges (chunk
      // emitters, and emitters whose workers take a journal after the
      // fork), so the host's optional calls cost nothing otherwise.
      journalAllocated: !this.journaled
        ? undefined
        : (name, op, args) => this.journal?.allocated(name, op, args),
      journalBuilt: !this.journaled ? undefined : () => this.journal?.built(),
      journalOpened: !this.journaled ? undefined : (op) => this.journal?.opened(op),
      journalUsed: !this.journaled
        ? undefined
        : (name, op, args) => this.journal?.used(name, op, args),
      journalEntry: !this.journaled
        ? undefined
        : (table, key, value) => this.journal?.entry(table, key, value),
      compactArrayElem: (elem) => this.compactArrayElem(elem),
      compactRegion: () => this.compactRegion,
      sizeType: this.sizeType,
      cycleBufOffset: this.cycleBufOffset,
      tracedShapes: this.tracedShapes,
      tracedUnions: this.tracedUnions,
      nullableUnions: this.nullableUnions,
      inlineUnions: this.inlineUnions,
      unionNoneRef: () => this.unionNoneRef(),
      recordsById: this.recordsById,
      recordCloneShapes: this.recordCloneShapes,
      objectAudit: options.objectAudit !== false,
      inlineAlloc: inlineAllocSupported({
        pointerBits: options.pointerBits,
        wasi: options.wasi,
        targetTriple: options.targetTriple,
        threadInstances: mod.lib?.threadInstances === true,
      }),
      // Worker programs keep one allocator per script thread: the inline
      // paths address its thread-local state.
      threadLocalAlloc: mod.workers === true,
      rcHelpers: this.rcHelpers,
      ...(this.rcMode !== undefined ? { rcMode: this.rcMode } : {}),
      ...(this.rcHelpersNoinline ? { rcHelpersNoinline: true } : {}),
      nextCycKind: () => FIRST_EMITTED_CYC_KIND + this.cycKinds++,
      ...(youngNurseryRequested() && mod.lib === undefined ? { youngNursery: true } : {}),
      unionsById: this.unionsById,
      declare: (decl) => this.declare(decl),
      needOom: () => this.needOom(),
      needBadTag: () => this.needBadTag(),
      internLiteral: (text) => this.internLiteral(text),
      cstr: (text) => this.cstr(text),
      mapOps: (operands) => this.mapOps(operands),
      unitInstanceRef: (unionId, tag) => this.unitInstanceRef(unionId, tag),
      retypeGuardRef: (unionId) => this.retypeGuardRef(unionId),
      fieldAbsentTestIn: (B, value, unionId) => this.fieldAbsentTestIn(B, value, unionId),
      absentInstanceRef: (unionId) => this.absentInstanceRef(unionId),
      liveDynRefAdapter: (type) => this.liveDynRefAdapter(type),
      usesDynBuiltinStream: () => this.usesDynBuiltinStream,
      liveDynUnionRefAdapter: (type) => this.liveDynUnionRefAdapter(type),
      declBoundary: () => this.mod.declBoundary === true,
      dynPromiseAdapter: (type) => this.dynPromiseAdapter(type),
      isErrorClass: (name) => this.classMeta.get(name)?.root.def.name === "%Error",
      classRootOf: (name) => this.classMeta.get(name)?.root.def.name,
      releasesNothing: (t) => {
        if (t.kind !== "object" || (this.shapeHost.regions ?? null) !== null) return false;
        const meta = this.classMeta.get(t.className);
        return meta !== undefined && programLifetimeClass(this.shapeHost, meta);
      },
      classSubtypes: (name) => {
        const target = this.classMetaOf(name);
        const intervals = classMembershipIntervals(this.classMeta, target.def.name);
        return [...this.classMeta.values()]
          .filter((meta) =>
            intervals.some((range) => range.pre <= meta.pre && meta.pre <= range.post),
          )
          .map((meta) => meta.def.name);
      },
      pendingTestLines: (dest) => this.pendingTestLines(dest),
      virtualEntry: (implFn) => this.virtualEntry(implFn),
      programLifetime: this.programLifetime,
      regionAliasTag: (word) => this.memoryAliasAttachment(`region.${word}`),
    };
    this.walkers = new LlWalkers(this.shapeHost);
    this.dyn = new LlDyn(this.shapeHost);
    for (const g of mod.globals ?? []) {
      // Module globals: scalar (f64/bool) storage is a zero-initialized
      // LLVM global, ref-kind storage a null-initialized ptr — load/store
      // like a local, assigned by the %init functions. Refcounted globals
      // are released at the end of main (the runtime ABI’s
      // sc_release_globals), before the RC audit would run.
      try {
        this.llType(g.type); // refuses out-of-tier kinds
      } catch (err) {
        if (err instanceof LlvmUnsupportedError)
          throw new LlvmUnsupportedError(`global:${g.type.kind}`);
        throw err;
      }
      this.globalTypes.set(g.id, g.type);
      if (g.tdz) this.tdzGlobals.set(g.id, g.name);
    }
    this.stableGlobals = stableGlobals(mod, this.nodeIndex);
    // Runtime error, EventEmitter, stream, EventTarget and Event classes
    // have known layouts. Subclasses embed the runtime prefixes from
    // classes.ts.
    const classes = mod.classes ?? [];
    for (const cls of classes) {
      if (
        cls.runtime &&
        !RUNTIME_ERROR_CLASSES.has(cls.name) &&
        cls.name !== RUNTIME_EMITTER_CLASS &&
        cls.name !== RUNTIME_EVENT_TARGET_CLASS &&
        cls.name !== RUNTIME_EVENT_CLASS &&
        !RUNTIME_STREAM_CLASSES.has(cls.name)
      ) {
        throw new LlvmUnsupportedError(`classDef:${cls.name}`, cls.loc);
      }
    }
    // The class graph: base/children links, hierarchy membership, the
    // whole-program preorder numbering for instanceof over runtime and
    // compiled error objects, and the per-hierarchy virtual slot lists.
    this.classMeta = buildClassGraph(mod, this.fnByName, this.sizeType);
    if (mod.lifetimeRegions === true) {
      this.regions = new LifetimeRegions(
        this.shapeHost,
        mod,
        this.classMeta,
        (meta) => programLifetimeClass(this.shapeHost, meta),
        this.nullableFields,
      );
      const regions = this.regions;
      // Member names differ from LifetimeRegions' own, which keeps the
      // record from reading as that class's protocol.
      this.shapeHost.regions = {
        rcBody: (fnName, ret, comment) => regions.countBody(fnName, ret, comment),
        newAlloc: (className, sizeOf) => regions.allocLines(className, sizeOf),
        classDefinitions: (cls, sizeOf) => regions.classDefs(cls, sizeOf),
      };
    }
    // ProgramLifetime hierarchies count nothing: their instances get the
    // 32-bit header and packed fields (classes.ts LlClassMeta.compact),
    // except where regions count them or a slot word follows the header.
    if (this.sizeType === "i64" && mod.lifetimeRegions !== true)
      assignCompactLayouts(
        this.classMeta,
        (root) => programLifetimeClass(this.shapeHost, root) && !root.threadSlot,
        (cls) => classFieldTypes(this.shapeHost, cls, this.int32Slots),
        // Executables whose region lies below 32 GiB hold compact class
        // instances there (scr_plr_alloc), so fields referring to one store
        // a 32-bit reference: the field's type, the class of a
        // `C | undefined` or `C | null` pointer, or the reference arm of a
        // nullable pointer field, is a compact class. `C | null | undefined`
        // keeps the pointer: its null is a sentinel outside the region.
        mod.lib === undefined && options.lowRegion === true
          ? (cls, i, isCompact) => {
              const f = cls.fields[i]!;
              if (this.inlineUnions.classField(cls.name, f.name)) return false;
              if (this.compactRefType(f.type, isCompact)) return true;
              const nullable =
                f.type.kind === "union" && this.nullableUnions.single(f.type.unionId) === null
                  ? this.nullableFields.get(cls.name, f.name)
                  : null;
              return nullable !== null && isCompact(nullable.arm.className);
            }
          : undefined,
      );
    this.compactRegion =
      mod.lib === undefined &&
      options.lowRegion === true &&
      [...this.classMeta.values()].some((m) => m.compact);
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
    this.virtualBorrows = new VirtualBorrows(
      mod,
      this.classMeta,
      this.fnByName,
      this.callLifetimes.borrowed,
    );
    // After the vtable slots: borrowing slots exclude their implementations.
    if (this.debug === null) this.analyzeBorrowedReturns();
  }

  /** The borrowed parameters of a hierarchy's vtable slot (empty: owned). */
  virtualSlotBorrowed(rootName: string, slotIndex: number): ReadonlySet<number> {
    return this.virtualBorrows.slot(rootName, slotIndex);
  }

  /** Optimized emission: no debug-info (dev) posture. */
  get optimizing(): boolean {
    return this.debug === null;
  }

  /** The vtable entry for one implementation (VirtualBorrows.entry). */
  virtualEntry(implFn: string): string {
    return this.virtualBorrows.entry(implFn);
  }

  implSlotBorrowed(implFn: string): ReadonlySet<number> {
    return this.virtualBorrows.implSlotBorrowed(implFn);
  }

  abiOffset(native64: number, wasm32: number): number {
    return this.sizeType === "i32" ? wasm32 : native64;
  }

  // ── types ───────────────────────────────────────────────────────────────

  llType(t: IrType): string {
    if (POINTER_KINDS.has(t.kind)) return "ptr";
    switch (t.kind) {
      case "f64":
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

  ffiCallbackAdapter(binding: string, id: string): FfiCallbackAdapter {
    const adapter = this.ffiCallbackAdapters.get(`${binding}:${id}`);
    if (!adapter)
      throw new InternalCompilerError(`llvm emitter bug: no callback adapter for ${binding}:${id}`);
    return adapter;
  }
  emitFfiCallbackDefs(): { globals: string[]; defs: string[] } {
    return emitFfiCallbackDefs(this);
  }

  emit(): string {
    return this.emitParts().join("\n");
  }
  emitParts(): string[] {
    return emitParts(this);
  }

  /** The dispose-observer gates the emitted frees and record writers test
   * (alloc.ts): defined after every helper is emitted, because dynCheck
   * builders, JSON schemas and weak collection constructors are requested
   * lazily. */
  disposeObserverGates(): string[] {
    const weak = [...this.decls].some(
      (d) => d.includes("@scr_weak_map_new(") || d.includes("@scr_weak_set_new("),
    );
    return [
      `${WEAK_KEYS_GATE} = internal constant i1 ${weak}`,
      `${RECORD_SOURCES_GATE} = internal constant i1 ${this.dyn.keepsRecordSources}`,
      ``,
    ];
  }
  emitModuleParts(): string[] {
    return emitModuleParts(this);
  }
  emitLibDefs(
    globals: IrGlobal[],
    globalReleaseLines: (prefix: string) => string[],
    stamps: string[],
  ): string[] {
    return emitLibDefs(this, globals, globalReleaseLines, stamps);
  }
  helperDefs(): string[] {
    return helperDefs(this);
  }

  /** The inline RC helpers every call site requested, emitted last so
   * requests from main/library epilogues are included. Slow-path
   * declarations a late request added after the extern block flushed land
   * here too. */
  inlineRcTail(flushedDecls: ReadonlySet<string>): string[] {
    const late = inlineRcDecls(this.shapeHost).filter((d) => !flushedDecls.has(d));
    // NULL-skipping retain wrappers of nullable unions; a runtime inner
    // retain requested after the extern block flushed is declared here.
    for (const inner of this.nullableUnions.retainWrappers.values()) {
      const decl = `declare ptr ${inner}(ptr)`;
      if (inner.startsWith("@scr_") && !flushedDecls.has(decl) && !late.includes(decl))
        late.push(decl);
    }
    return [
      ...late,
      ...emitNullableRetainWrappers(this.shapeHost),
      ...emitShapeUnionHelpers(this.shapeHost),
      ...emitInlineRcHelpers(this.shapeHost),
    ];
  }

  /** Env-signature wrappers + interned immortal closures for declared
   * functions used as values (the runtime ABI’s sc_w_/sc_fc_ pair): every
   * mention of `f` yields the same pointer, so `f === f` holds. */
  emitFnValueDefs(): string[] {
    const out: string[] = [];
    for (const name of this.fnValues) {
      const fn = this.fnByName.get(name)!;
      const params = fn.params.map((p, i) => `${this.llType(p.type)} %a${i}`);
      const args = fn.params.map((p, i) => `${this.llType(p.type)} %a${i}`).join(", ");
      // Async/generator functions as values enter through their spawn
      // wrapper: the call answers the promise / generator object (+1),
      // never the inner return type.
      const ret =
        fn.async === true || fn.generator !== undefined ? "ptr" : this.llType(fn.returnType);
      const call = `call ${ret} @${this.callTarget(name)}(${args})`;
      const lending = this.lendsEveryArgument(name);
      out.push(
        `define internal ${ret} @${mangleWrapper(name)}(ptr %env${params.length ? ", " + params.join(", ") : ""}) ${FN_ATTRS} { ; ${name} as a value`,
        `entry:`,
        ret === "void" ? `  ${call}` : `  %r = ${call}`,
        ret === "void" ? `  ret void` : `  ret ${ret} %r`,
        `}`,
        `@${mangleFnClosure(name)} = internal ${this.mod.workers === true || this.mod.lib?.threadInstances === true ? "thread_local " : ""}global %ScrClosure { ${this.sizeType} -1, ptr @${mangleWrapper(name)}, ${this.sizeType} 0, ptr null, i32 ${(fn.generator ? 1 : 0) + (fn.async ? 2 : 0) + (fn.ownsPrototype ? 4 : 0)}, i32 0, ptr null, ptr ${lending ? `@${mangleBorrowingWrapper(name)}` : "null"} }`,
        ``,
      );
      if (lending)
        out.push(
          `define internal ${ret} @${mangleBorrowingWrapper(name)}(ptr %env${params.length ? ", " + params.join(", ") : ""}) ${FN_ATTRS} { ; ${name} as a value, lending its arguments`,
          `entry:`,
          ret === "void"
            ? `  call void @${mangleBorrowedFunction(name)}(${args})`
            : `  %r = call ${ret} @${mangleBorrowedFunction(name)}(${args})`,
          ret === "void" ? `  ret void` : `  ret ${ret} %r`,
          `}`,
          ``,
        );
    }
    return out;
  }
  emitArgPackAndTrampolinePrologue(fn: IrFunction): LlArgPackAndTrampolinePrologue {
    return emitArgPackAndTrampolinePrologue(this, fn);
  }

  /** Settles `promise` from a clean async body result `%r` (moved in). */
  asyncFulfillLines(ret: IrType, promise: string): string[] {
    switch (ret.kind) {
      case "void":
        this.declare(`declare void @scr_promise_fulfill_void(ptr)`);
        return [`  call void @scr_promise_fulfill_void(ptr ${promise})`];
      case "f64":
        this.declare(`declare void @scr_promise_fulfill_f64(ptr, double)`);
        return [`  call void @scr_promise_fulfill_f64(ptr ${promise}, double %r)`];
      case "bool":
        this.declare(`declare void @scr_promise_fulfill_bool(ptr, i1 zeroext)`);
        return [`  call void @scr_promise_fulfill_bool(ptr ${promise}, i1 %r)`];
      case "string":
        this.declare(`declare void @scr_promise_fulfill_str(ptr, ptr)`);
        return [`  call void @scr_promise_fulfill_str(ptr ${promise}, ptr %r) ; moves in`];
      case "dyn":
        this.declare(`declare void @scr_promise_resolve_dyn(ptr, ptr)`);
        return [`  call void @scr_promise_resolve_dyn(ptr ${promise}, ptr %r) ; moves in`];
      default: {
        const v = vAdapters(this.shapeHost, ret);
        this.declare(`declare void @scr_promise_fulfill_ref(ptr, ptr, ptr, ptr, ptr)`);
        return [
          `  call void @scr_promise_fulfill_ref(ptr ${promise}, ptr %r, ptr ${v.retain}, ptr ${v.release}, ptr ${traceArg(this.shapeHost, ret)})`,
        ];
      }
    }
  }
  fiberlessAsyncFunctions(): Set<string> {
    return fiberlessAsyncFunctions(this);
  }

  /** The async functions `parks` leaves fiberless (fiberlessAsyncFunctions). */
  neverParkingAsync(parks: ReadonlySet<string>): Set<string> {
    const eligible = new Set<string>();
    for (const fn of this.mod.functions) {
      if (fn.async !== true || fn.generator !== undefined) continue;
      if (fn.asyncCacheGlobal !== undefined || fn.asyncCycleCacheGlobal !== undefined) continue;
      if (fn.returnType.kind === "dyn" || parks.has(fn.name)) continue;
      if (!this.fnDefText.has(fn.name) || this.stacklessAsync.has(fn.name)) continue;
      eligible.add(fn.name);
    }
    return eligible;
  }
  parkingFunctions(): Set<string> | null {
    return parkingFunctions(this);
  }

  private mangledFunctions: Map<string, string> | null = null;

  /** The module functions whose ordinary or borrowed body `text` mentions. */
  *mentionedFunctions(text: string): Generator<string> {
    if (this.mangledFunctions === null) {
      this.mangledFunctions = new Map();
      for (const fn of this.mod.functions) {
        this.mangledFunctions.set(mangleFunction(fn.name), fn.name);
        this.mangledFunctions.set(mangleBorrowedFunction(fn.name), fn.name);
      }
    }
    for (const match of text.matchAll(/@(sc_b?f_[A-Za-z0-9_]+)/g)) {
      const callee = this.mangledFunctions.get(match[1]!);
      if (callee !== undefined) yield callee;
    }
  }

  /** Chooses the native async functions whose bodies compile to switched
   * coroutines instead of running on a fiber: a suspended call then keeps a
   * heap frame of the values live across its awaits rather than a fiber and
   * its stack. A body qualifies when its only suspension points are its own
   * awaits, which the coroutine form suspends itself at (emitCoroAwait), so
   * nothing it runs can park the stack it borrows. It is first emitted as
   * usual: that text may suspend only through await runtime calls and
   * await-call entries, which the coroutine form replaces, and may call no
   * function that parks. The coroutine form is then emitted and must pass
   * the same test with no exceptions (its frame bookkeeping excepted);
   * otherwise the fiber form stays. Bodies that never suspend stay
   * fiberless, and module evaluation bodies and `dyn` results keep fibers
   * as they do there. The runtime traps if a stackless body ever parks. */
  selectStacklessAsync(fnDefs: string[]): void {
    if (!this.stacklessAsyncAllowed) return;
    const parks = this.parkingFunctions();
    if (parks === null) return;
    // Coroutine bodies emitted below are the only inline-await callers, and
    // replacing their text changes no other function's parking.
    this.inlineAwaitable = this.neverParkingAsync(parks);
    const qualifies = (fn: IrFunction, text: string, suspends: RegExp): boolean => {
      if (suspends.test(text)) return false;
      for (const callee of this.mentionedFunctions(text))
        if (callee !== fn.name && parks.has(callee)) return false;
      return true;
    };
    this.mod.functions.forEach((fn, index) => {
      if (fn.async !== true || fn.generator !== undefined) return;
      if (fn.asyncCacheGlobal !== undefined || fn.asyncCycleCacheGlobal !== undefined) return;
      if (fn.returnType.kind === "dyn" || !parks.has(fn.name)) return;
      const fiberText = fnDefs[index]!;
      if (!qualifies(fn, fiberText.replace(AWAIT_SUSPENSIONS, ""), SUSPENDS)) return;
      this.stacklessAsync.add(fn.name);
      const coroText = this.emitFunction(fn);
      if (!qualifies(fn, coroText, COROUTINE_SUSPENDS)) {
        this.stacklessAsync.delete(fn.name);
        return;
      }
      fnDefs[index] = coroText;
      this.fnDefText.set(fn.name, coroText);
    });
  }

  /** Whether a fiberless body running on its caller's stack needs the
   * frame scr_async_inline_enter/exit keep: it isolates the Error.stack
   * frame chain, which only stack-observing programs push, as a fresh fiber
   * would. Other programs run the body with a plain call. The body runs in
   * its caller's AsyncLocalStorage context either way, as Node runs an async
   * body up to its first await. The frame also counts the bodies running on
   * a fiber's stack for the runtime's trap on a fiberless body that
   * suspends. */
  get fiberlessFrames(): boolean {
    return this.stackTraces;
  }

  /** The spawn wrapper of a fiberless async function: runs the body on the
   * caller's stack (between scr_async_inline_enter/leave when
   * fiberlessFrames) and settles a fresh promise from its outcome — the
   * fiber trampoline's epilogue, without the fiber. */
  emitFiberlessAsyncSpawn(fn: IrFunction, spawnParams: string[]): string[] {
    const ret = fn.returnType;
    const retTy = this.llType(ret);
    const lifted = fn.captures !== undefined;
    const framed = this.fiberlessFrames;
    if (framed) {
      this.declare(`declare void @scr_async_inline_enter(ptr)`);
      this.declare(`declare ptr @scr_async_inline_leave(ptr)`);
    } else {
      this.declare(`declare ptr @scr_promise_new()`);
    }
    this.declare(`declare void @scr_promise_reject_pending(ptr)`);
    if (lifted) {
      this.declare(`declare ptr @scr_closure_retain_v(ptr)`);
      this.declare(`declare void @scr_closure_release(ptr)`);
    }
    const bodyCall = `call ${retTy} @${mangleFunction(fn.name)}(${spawnParams.join(", ")})`;
    const out = [
      `define internal ptr @${mangleAsyncSpawn(fn.name)}(${spawnParams.join(", ")}) ${FN_ATTRS} { ; fiberless ${fn.name}`,
      `entry:`,
      ...(framed ? [`  %frame = alloca { ptr, ptr }`] : []),
      // The fiber path holds +1 on a lifted environment for the body's
      // duration (packed, released by the trampoline); keep that lifetime.
      ...(lifted ? [`  %env = call ptr @scr_closure_retain_v(ptr %a0)`] : []),
      ...(framed ? [`  call void @scr_async_inline_enter(ptr %frame)`] : []),
      retTy === "void" ? `  ${bodyCall}` : `  %r = ${bodyCall}`,
      ...(lifted ? [`  call void @scr_closure_release(ptr %a0)`] : []),
      ...this.pendingTestLines("%pend"),
      framed
        ? `  %p = call ptr @scr_async_inline_leave(ptr %frame)`
        : `  %p = call ptr @scr_promise_new()`,
      `  br i1 %pend, label %thrown, label %clean`,
      `clean:`,
      ...this.asyncFulfillLines(ret, "%p"),
      `  ret ptr %p`,
      `thrown:`,
    ];
    if (ret.kind !== "void" && isRefCounted(ret)) {
      // An escaping throw means %r is the never-read dummy (NULL).
      out.push(`  call void ${releaseSym(this.shapeHost, ret)}(ptr %r)`);
    }
    out.push(`  call void @scr_promise_reject_pending(ptr %p)`, `  ret ptr %p`, `}`, ``);
    return out;
  }

  /** Whether `await f(...)` may enter f through its await-call entry. The
   * entry's result is the awaited value of f's own body type; direct calls
   * never carry a lifted environment. */
  awaitCallEligible(fnName: string): boolean {
    // A coroutine body suspends itself at the await; the entry would park
    // the stack it runs on.
    if (this.wasi || this.mod.workers === true || this.currentCoro !== null) return false;
    const fn = this.fnByName.get(fnName);
    if (fn === undefined || fn.async !== true || fn.generator !== undefined) return false;
    if (fn.captures !== undefined || fn.returnType.kind === "dyn") return false;
    return fn.asyncCacheGlobal === undefined && fn.asyncCycleCacheGlobal === undefined;
  }

  /** Whether a stackless coroutine body's `await f(...)` may run f's body in
   * place (emitCoroInlineAwait): f never suspends, and its direct call is
   * one an await-call entry could take. */
  inlineAwaitEligible(fnName: string): boolean {
    if (this.wasi || this.currentCoro?.kind !== "async") return false;
    const fn = this.fnByName.get(fnName);
    if (fn === undefined || !this.inlineAwaitable.has(fnName)) return false;
    return fn.captures === undefined;
  }

  /** Whether a stackless coroutine body's `await f(...)` may await f's
   * fiber record instead of its promise (emitCoroDirectAwait): f is a
   * stackless async function whose direct call an await-call entry could
   * take. The await consumes the promise, so nothing else can observe it.
   * Worker programs keep the promise for their stop checkpoint. */
  directAwaitEligible(fnName: string): boolean {
    if (this.wasi || this.mod.workers === true || this.currentCoro?.kind !== "async") return false;
    const fn = this.fnByName.get(fnName);
    if (fn === undefined || fn.async !== true || fn.generator !== undefined) return false;
    if (!this.stacklessAsync.has(fnName) || fn.captures !== undefined) return false;
    if (fn.returnType.kind === "dyn") return false;
    return fn.asyncCacheGlobal === undefined && fn.asyncCycleCacheGlobal === undefined;
  }

  /** A stackless coroutine body's `await f(...)` of a stackless f, without
   * f's promise object: f's prefix runs as the spawn of a fiber record that
   * keeps the promise inside. A body still running wakes this coroutine
   * when it finishes, where its promise's settlement would wake its one
   * waiter; a finished one takes the settled await's turn. The result (or
   * the rejection, re-thrown) comes out of the record, which goes. */
  emitCoroDirectAwait(call: ExprOf<"call">, type: IrType): LlValue {
    const coro = this.currentCoro;
    if (coro === null)
      throw new InternalCompilerError("llvm emitter bug: direct await outside a coroutine");
    const B = this.B;
    const record = emitCallExpr(this, call, "direct").name;
    this.declare(`declare zeroext i1 @scr_coro_direct_prepare(ptr, ptr)`);
    const suspend = B.tmp();
    B.line(
      `${suspend} = call zeroext i1 @scr_coro_direct_prepare(ptr ${coro.self}, ptr ${record})`,
    );
    const park = B.newLabel("await.suspend");
    const ready = B.newLabel("await.ready");
    B.condBr(suspend, park, ready);
    B.startBlock(park);
    this.emitCoroSuspendPrepared();
    B.br(ready);
    B.startBlock(ready);
    if (type.kind === "void") {
      this.declare(`declare void @scr_coro_direct_void(ptr)`);
      B.line(`call void @scr_coro_direct_void(ptr ${record})`);
      this.emitPendingCheck();
      return { name: "", type };
    }
    const t = B.tmp();
    if (type.kind === "f64") {
      this.declare(`declare double @scr_coro_direct_f64(ptr)`);
      B.line(`${t} = call double @scr_coro_direct_f64(ptr ${record})`);
    } else if (type.kind === "bool") {
      this.declare(`declare zeroext i1 @scr_coro_direct_bool(ptr)`);
      B.line(`${t} = call zeroext i1 @scr_coro_direct_bool(ptr ${record})`);
    } else if (type.kind === "string") {
      this.declare(`declare ptr @scr_coro_direct_str(ptr)`);
      B.line(`${t} = call ptr @scr_coro_direct_str(ptr ${record})`);
    } else {
      this.declare(`declare ptr @scr_coro_direct_ref(ptr)`);
      B.line(`${t} = call ptr @scr_coro_direct_ref(ptr ${record})`);
    }
    const out = this.own({ name: this.adoptHeap(t, type), type });
    this.emitPendingCheck();
    return out;
  }

  /** The inline await entry of a fiberless async function (`sc_ai_*`): its
   * body on the caller's stack (between scr_async_inline_enter/exit when
   * fiberlessFrames), as in its spawn wrapper, returning the result and
   * leaving a throw pending for the awaiting coroutine (emitCoroInlineAwait). */
  emitAsyncInlineAwaitCall(fn: IrFunction): string[] {
    const retTy = this.llType(fn.returnType);
    const params = fn.params.map((p, i) => `${this.llType(p.type)} %a${i}`);
    const args = params.join(", ");
    const framed = this.fiberlessFrames;
    if (framed) {
      this.declare(`declare void @scr_async_inline_enter(ptr)`);
      this.declare(`declare void @scr_async_inline_exit(ptr)`);
    }
    const bodyCall = `call ${retTy} @${mangleFunction(fn.name)}(${args})`;
    return [
      `define internal ${retTy} @${mangleAsyncInlineAwaitCall(fn.name)}(${args}) ${FN_ATTRS} { ; inline await ${fn.name}`,
      `entry:`,
      ...(framed
        ? [`  %frame = alloca { ptr, ptr }`, `  call void @scr_async_inline_enter(ptr %frame)`]
        : []),
      retTy === "void" ? `  ${bodyCall}` : `  %r = ${bodyCall}`,
      ...(framed ? [`  call void @scr_async_inline_exit(ptr %frame)`] : []),
      retTy === "void" ? `  ret void` : `  ret ${retTy} %r`,
      `}`,
      ``,
    ];
  }

  /** A stackless coroutine body's `await f(...)` of a fiberless f, the
   * await-call entry's turns without its promise: the body runs in place,
   * then a clean result takes the await's turn, and a throw becomes the
   * rejected promise the await takes its turn on and re-throws, exactly as
   * the spawn wrapper's promise would. An adopting await (`return f(...)`)
   * first takes the adoption's then-job turn either way. */
  emitCoroInlineAwait(call: ExprOf<"call">, adopt: boolean): LlValue {
    const B = this.B;
    const value = emitCallExpr(this, call, "inline");
    const thrown = B.tmp();
    for (const line of this.pendingTestLines(thrown)) B.line(line.trim());
    if (adopt) this.emitCoroAwait(null);
    const clean = B.newLabel("ai.clean");
    const rejected = B.newLabel("ai.rejected");
    const join = B.newLabel("ai.join");
    B.condBr(thrown, rejected, clean);
    B.startBlock(clean);
    this.emitCoroAwait(null);
    B.br(join);
    B.startBlock(rejected);
    this.declare(`declare ptr @scr_promise_new()`);
    this.declare(`declare void @scr_promise_reject_pending(ptr)`);
    this.declare(`declare void @scr_coro_await_void(ptr)`);
    this.declare(`declare void @scr_promise_release(ptr)`);
    const promise = B.tmp();
    B.line(`${promise} = call ptr @scr_promise_new()`);
    B.line(`call void @scr_promise_reject_pending(ptr ${promise})`);
    this.emitCoroAwait(promise);
    B.line(`call void @scr_coro_await_void(ptr ${promise})`);
    B.line(`call void @scr_promise_release(ptr ${promise})`);
    B.br(join);
    B.startBlock(join);
    this.emitPendingCheck();
    return value;
  }
  /** The entries of `Promise.all(arg)` that a stackless coroutine body's
   * await may run in place (emitCoroInlinePromiseAll): `arg` is a non-empty
   * array literal, or the local whose declaration emitStmts deferred to this
   * await (deferredPromiseAllEntries), whose every entry is a call to a
   * never-suspending async function, and the result is an array. Null
   * otherwise. Consumes a deferred local's entries. */
  inlinePromiseAllEntries(all: ExprOf<"intrinsic">): ExprOf<"arrayLit"> | null {
    if (all.name !== "promise.all" || all.type.kind !== "promise") return null;
    if (all.type.inner.kind !== "array") return null;
    const arg = all.args[0];
    if (arg?.kind === "varRef") {
      const deferred = this.deferredPromiseAllEntries.get(arg.localId);
      if (deferred === undefined) return null;
      this.deferredPromiseAllEntries.delete(arg.localId);
      return deferred;
    }
    return arg?.kind === "arrayLit" && this.promiseAllInlineable(arg) ? arg : null;
  }

  /** Whether every entry of `entries` is a call an await could run in place
   * (inlineAwaitEligible) that yields its promise's inner type. */
  private promiseAllInlineable(entries: ExprOf<"arrayLit">): boolean {
    if (entries.elems.length === 0 || (entries.spreads?.length ?? 0) > 0) return false;
    if (entries.type.kind !== "array" || entries.type.elem.kind !== "promise") return false;
    const inner = entries.type.elem.inner;
    return entries.elems.every((el) => {
      if (el.kind !== "call" || !this.inlineAwaitEligible(el.callee)) return false;
      const callee = this.fnByName.get(el.callee)!;
      return typeEquals(callee.returnType, inner) && !this.callLifetimes.borrowed.has(el.callee);
    });
  }

  /** Whether `stmts[i]` declares a local holding an array literal that only
   * `stmts[i + 1]` reads, as the operand of `await Promise.all(local)` that
   * runs first in that statement and may run its entries in place. Nothing
   * runs between the literal and the await, so the await evaluates the
   * literal itself (inlinePromiseAllEntries). Debug builds keep the local. */
  deferredPromiseAllLocal(stmts: readonly IrStmt[], i: number): ExprOf<"arrayLit"> | null {
    const decl = stmts[i];
    const next = stmts[i + 1];
    if (this.debug !== null || decl?.kind !== "varDecl" || decl.init?.kind !== "arrayLit")
      return null;
    if (this.currentCoro?.kind !== "async" || next === undefined) return null;
    const operand =
      next.kind === "varDecl"
        ? next.init
        : next.kind === "exprStmt"
          ? next.expr
          : next.kind === "assign"
            ? next.value
            : null;
    if (operand?.kind !== "awaitExpr" || operand.adopt === true) return null;
    const all = operand.value;
    if (all.kind !== "intrinsic" || all.name !== "promise.all" || all.type.kind !== "promise")
      return null;
    if (all.type.inner.kind !== "array") return null;
    const arg = all.args[0];
    if (arg?.kind !== "varRef" || arg.localId !== decl.localId) return null;
    if (!this.promiseAllInlineable(decl.init)) return null;
    if (this.currentLocals.get(decl.localId)?.boxed) return null;
    // The declaration and this read are the local's only mentions.
    return countLocalMentions(this.currentFunctionBody, decl.localId) === 2 ? decl.init : null;
  }

  /** A stackless coroutine body's `await Promise.all([f(...), ...])` of
   * never-suspending calls, with Promise.all's turns and without its
   * promises: the entries run in place in order and their values fill the
   * result array. Promise.all queues one reaction job per entry, back to
   * back, and the last of them settles the result, whose await then takes a
   * turn: here one turn stands for the entries' jobs and a second for the
   * await. A throwing entry becomes the rejection the await re-throws from
   * its turn; the remaining entries still run, and later throws are handled
   * rejections, as Promise.all's subscriptions make them. */
  emitCoroInlinePromiseAll(entries: ExprOf<"arrayLit">, type: IrType): LlValue {
    if (type.kind !== "array")
      throw new InternalCompilerError("llvm emitter bug: inline Promise.all result");
    const B = this.B;
    const elem = type.elem;
    const acc = elemAccess(elem);
    const values = B.tmp();
    // Up to three values fit in the array's own block (scr_arr_new_*_small).
    const small = entries.elems.length <= 3;
    B.line(
      `${values} = ${arrNewCall(this.shapeHost, elem, small ? "0" : String(entries.elems.length), small)}`,
    );
    const out = this.own({ name: values, type });
    this.declare(`declare ptr @scr_promise_new()`);
    this.declare(`declare void @scr_promise_reject_pending(ptr)`);
    this.declare(`declare void @scr_promise_mark_handled(ptr)`);
    const promiseType = entries.type.kind === "array" ? entries.type.elem : type;
    // Each entry's rejection, owned by the frame: unobserved until the
    // entries have all run, as Promise.all subscribes only then, so an
    // entry argument's synchronous throw leaves them unhandled.
    const rejections: string[] = [];
    for (const entry of entries.elems) {
      if (entry.kind !== "call")
        throw new InternalCompilerError("llvm emitter bug: inline Promise.all entry");
      const slot = B.tmp();
      B.entryAllocas.push(`${slot} = alloca ptr`);
      B.line(`store ptr null, ptr ${slot}`);
      this.ownSlot(slot, promiseType);
      rejections.push(slot);
      const value = emitCallExpr(this, entry, "inline");
      const thrown = B.tmp();
      for (const line of this.pendingTestLines(thrown)) B.line(line.trim());
      const clean = B.newLabel("pa.clean");
      const rejected = B.newLabel("pa.rejected");
      const next = B.newLabel("pa.next");
      B.condBr(thrown, rejected, clean);
      B.startBlock(clean);
      if (acc === "ref") this.toHeap(value);
      this.arrPush(values, acc, value.name, elem);
      B.br(next);
      B.startBlock(rejected);
      const promise = B.tmp();
      B.line(`${promise} = call ptr @scr_promise_new()`);
      B.line(`call void @scr_promise_reject_pending(ptr ${promise})`);
      B.line(`store ptr ${promise}, ptr ${slot}`);
      B.br(next);
      B.startBlock(next);
    }
    // Promise.all's subscriptions handle every rejection, and the first
    // (in entry order) rejects the result.
    let first = "null";
    for (let k = rejections.length - 1; k >= 0; k--) {
      const slot = rejections[k]!;
      const rejection = B.tmp();
      const present = B.tmp();
      B.line(`${rejection} = load ptr, ptr ${slot}`);
      B.line(`${present} = icmp ne ptr ${rejection}, null`);
      const mark = B.newLabel("pa.handled");
      const after = B.newLabel("pa.unrejected");
      B.condBr(present, mark, after);
      B.startBlock(mark);
      B.line(`call void @scr_promise_mark_handled(ptr ${rejection})`);
      B.br(after);
      B.startBlock(after);
      const chosen = B.tmp();
      B.line(`${chosen} = select i1 ${present}, ptr ${rejection}, ptr ${first}`);
      first = chosen;
    }
    // The entries' reaction jobs.
    this.emitCoroAwait(null);
    const failed = B.tmp();
    B.line(`${failed} = icmp ne ptr ${first}, null`);
    const fulfilled = B.newLabel("pa.fulfilled");
    const rejected = B.newLabel("pa.reject");
    const join = B.newLabel("pa.join");
    B.condBr(failed, rejected, fulfilled);
    B.startBlock(fulfilled);
    this.emitCoroAwait(null);
    B.br(join);
    B.startBlock(rejected);
    this.declare(`declare void @scr_coro_await_void(ptr)`);
    this.emitCoroAwait(first);
    B.line(`call void @scr_coro_await_void(ptr ${first})`);
    B.br(join);
    B.startBlock(join);
    // The rejections are released here, only where an entry threw, rather
    // than by the frame, which releases each slot whether or not it holds a
    // promise.
    this.declare(`declare void @scr_promise_release(ptr)`);
    for (const slot of rejections) {
      const rejection = B.tmp();
      const present = B.tmp();
      B.line(`${rejection} = load ptr, ptr ${slot}`);
      B.line(`${present} = icmp ne ptr ${rejection}, null`);
      const release = B.newLabel("pa.release");
      const after = B.newLabel("pa.released");
      B.condBr(present, release, after);
      B.startBlock(release);
      B.line(`call void @scr_promise_release(ptr ${rejection})`);
      B.br(after);
      B.startBlock(after);
    }
    this.disownSlots(rejections.map((ptr) => ({ ptr })));
    this.emitPendingCheck();
    return out;
  }
  emitAsyncAwaitCall(fn: IrFunction, argPackLines: string[] | null, adopt = false): string[] {
    return emitAsyncAwaitCall(this, fn, argPackLines, adopt);
  }
  emitAsyncScaffolding(): string[] {
    return emitAsyncScaffolding(this);
  }

  /** Whether `fn`'s body is emitted as an LLVM switched coroutine: every
   * wasm32 async or generator body, native synchronous generators, and the
   * native async bodies selectStacklessAsync chose. */
  coroLowered(fn: IrFunction): boolean {
    if (this.wasi) return fn.async === true || fn.generator !== undefined;
    if (fn.async === true) return fn.generator === undefined && this.stacklessAsync.has(fn.name);
    return this.stacklessGenerators && fn.generator !== undefined;
  }
  emitGenScaffolding(): string[] {
    return emitGenScaffolding(this);
  }

  // ── plumbing (frame and scope ownership) ──────

  /** A symbol derived from the constant's text rather than its first-use
   * index, so an edit that interns one more string leaves every other
   * constant's symbol, and the code referencing it, unchanged. This lets
   * native builds reuse the compiled partitions an edit does not touch. A
   * collision retries with a counter, still in first-use order. */
  private contentSymbol(prefix: string, text: string): string {
    for (let attempt = 0; ; attempt++) {
      const digest = createHash("sha256")
        .update(attempt === 0 ? text : `${attempt}\0${text}`)
        .digest("hex");
      const symbol = `${prefix}${parseInt(digest.slice(0, 13), 16)}`;
      if (!this.contentSymbols.has(symbol)) {
        this.contentSymbols.add(symbol);
        return symbol;
      }
    }
  }

  internLiteral(text: string): string {
    let lit = this.literals.get(text);
    if (!lit) {
      lit = {
        sym: this.contentSymbol("sc_lit_", text),
        len: Buffer.byteLength(text, "utf8"),
      };
      this.literals.set(text, lit);
    }
    this.journal?.entry("literal", text, lit);
    const name = `@${lit.sym}`;
    this.immortalValues.add(name);
    return name;
  }

  /** The inline equality test against one string literal (an
   * `i1 (ptr)` helper LLVM inlines at each site), by literal symbol. */
  literalEquals(text: string): string {
    const literal = this.internLiteral(text);
    const name = `@sc_streq_${literal.slice("@sc_lit_".length)}`;
    this.journal?.entry("literalEquality", text, name);
    if (!this.literalEqualities.has(text)) {
      this.literalEqualities.set(text, name);
      if (Buffer.byteLength(text, "utf8") > INLINE_LITERAL_BYTES) {
        this.declare(`declare zeroext i1 @scr_str_eq(ptr, ptr)`);
      }
    }
    return name;
  }

  /** `@`-ref of an immortal ScrBigInt holding `value`, or null when the
   * text is not a valid StringToBigInt input (the runtime parse then
   * throws as usual). BigInt here is the same StringToBigInt as the
   * program's, so every accepted spelling folds to the value Node gives. */
  internBigIntLiteral(text: string): string | null {
    let value: bigint;
    try {
      value = BigInt(text);
    } catch {
      return null;
    }
    const key = value.toString(16);
    let lit = this.bigintLiterals.get(key);
    if (!lit) {
      lit = { sym: this.contentSymbol("sc_bigint_", key), value };
      this.bigintLiterals.set(key, lit);
    }
    this.journal?.entry("bigint", key, { sym: lit.sym, value: lit.value.toString() });
    const name = `@${lit.sym}`;
    this.immortalValues.add(name);
    return name;
  }

  /** Interned NUL-terminated C-string constant (the scr_jb_puts /
   * stringify-indent currency) — `@`-ref, first-use order. */
  cstr(text: string): string {
    let c = this.cstrs.get(text);
    if (!c) {
      c = { sym: this.contentSymbol("sc_cs_", text), len: Buffer.byteLength(text, "utf8") };
      this.cstrs.set(text, c);
    }
    this.journal?.entry("cstr", text, c);
    return `@${c.sym}`;
  }

  /** The method-id slot for a constant method name (methodIdSlots). */
  methodIdSlot(name: string): string {
    let sym = this.methodIdSlots.get(name);
    if (!sym) {
      sym = this.contentSymbol("sc_mid_", name);
      this.methodIdSlots.set(name, sym);
    }
    this.journal?.entry("methodIdSlot", name, sym);
    return `@${sym}`;
  }

  needBadTag(): void {
    this.needsBadTag = true;
  }

  /** The ScrMapOps descriptor holding these operands (ShapeHost.mapOps). */
  mapOps(operands: readonly string[]): string {
    if (operands.every((op) => op === "null")) return "null";
    const body = operands.map((op) => `ptr ${op}`).join(", ");
    let sym = this.mapOpsConsts.get(body);
    if (!sym) {
      sym = this.contentSymbol("sc_map_ops_", body);
      this.mapOpsConsts.set(body, sym);
    }
    this.journal?.entry("mapOps", body, sym);
    return `@${sym}`;
  }

  /** The interned immortal instance for a UNIT arm of a union — asserts
   * the arm really is payload-less (undefined/null). Public: class
   * emission initializes undefined-admitting fields through it
   * (ClassHost). */
  unitInstanceRef(unionId: string, tag: number): string {
    const arm = this.unionsById.get(unionId)?.arms[tag];
    if (!arm || !isUnitType(arm)) {
      throw new InternalCompilerError(
        `llvm emitter bug: unit instance for non-unit arm ${tag} of ${unionId}`,
      );
    }
    const nullable = this.nullableUnions.get(unionId);
    if (nullable) {
      // NULL is the unit arm of a nullable union (`undefined` when it has
      // both); the `null` sentinel is immortal. Neither owns anything.
      return tag === nullable.nullTag ? NULLABLE_NULL : "null";
    }
    const key = `${unionId}:${tag}`;
    let sym = this.unitInstances.get(key);
    if (!sym) {
      sym = `sc_unit_${this.unitInstances.size}`;
      this.unitInstances.set(key, sym);
    }
    this.journal?.entry("unit", key, sym);
    const name = `@${sym}`;
    this.immortalValues.add(name);
    return name;
  }

  /** The i8 flag that a checked-dynamic cast sets before caching one of
   * this tagged union's boxes (unionRetype rebuilds once it is set). */
  retypeGuardRef(unionId: string): string {
    let sym = this.retypeGuards.get(unionId);
    if (!sym) {
      sym = `sc_retype_guard_${this.retypeGuards.size}`;
      this.retypeGuards.set(unionId, sym);
    }
    this.journal?.entry("retype", unionId, sym);
    return `@${sym}`;
  }

  /** The immortal ABSENT state of an undefined-armed record field slot
   * (IR fieldAbsent). */
  absentInstanceRef(unionId: string): string {
    if (undefinedArmTag({ kind: "union", unionId }, this.unionsById) < 0) {
      throw new InternalCompilerError(
        `llvm emitter bug: absent state of ${unionId} without undefined`,
      );
    }
    if (this.nullableUnions.has(unionId)) {
      this.needsNullableAbsent = true;
      this.immortalValues.add(NULLABLE_ABSENT);
      return NULLABLE_ABSENT;
    }
    let sym = this.absentInstances.get(unionId);
    if (!sym) {
      sym = `sc_absent_${this.absentInstances.size}`;
      this.absentInstances.set(unionId, sym);
    }
    this.journal?.entry("absent", unionId, sym);
    const name = `@${sym}`;
    this.immortalValues.add(name);
    return name;
  }

  /** i1: a union value loaded from a field slot is the ABSENT state — the
   * undefined arm's tag with the absent payload marker. */
  fieldAbsentTest(value: string, unionId: string): string {
    return this.fieldAbsentTestIn(this.B, value, unionId);
  }

  /** fieldAbsentTest in another block builder (helper generators). A
   * nullable union's ABSENT state is the module's immortal sentinel. */
  fieldAbsentTestIn(B: BlockBuilder, value: string, unionId: string): string {
    if (this.nullableUnions.has(unionId)) {
      this.needsNullableAbsent = true;
      const t = B.tmp();
      B.line(`${t} = icmp eq ptr ${value}, ${NULLABLE_ABSENT}`);
      return t;
    }
    return emitFieldAbsentTest(
      B,
      value,
      undefinedArmTag({ kind: "union", unionId }, this.unionsById),
    );
  }

  /** Loads a record field slot as a VALUE: an undefined-armed union slot
   * holding the ABSENT state surfaces as the ordinary undefined arm, so
   * absence never travels beyond its slot (a later `{ f: r.f }` is an
   * explicit, present property). */
  loadRecordField(ptr: string, t: IrType, inline: boolean): string {
    if (inline) {
      const { tag, bits } = loadInlineUnion(this.B, ptr);
      const present = presentBits(this.B, tag, bits, undefinedArmTag(t, this.unionsById));
      return stackUnionBox(this.B, this.sizeType, tag, present);
    }
    const v = this.loadField(ptr, t, false);
    if (t.kind !== "union" || undefinedArmTag(t, this.unionsById) < 0) return v;
    const absent = this.fieldAbsentTest(v, t.unionId);
    const unit = this.unitInstanceRef(t.unionId, undefinedArmTag(t, this.unionsById));
    const out = this.B.tmp();
    this.B.line(`${out} = select i1 ${absent}, ptr ${unit}, ptr ${v}`);
    return out;
  }

  declare(decl: string): void {
    this.journal?.entry("decl", decl, null);
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

  /** Whether a value is immortal: an interned constant, or a temp marked by
   * markImmortal. */
  private isImmortal(name: string): boolean {
    return this.immortalValues.has(name) || this.B.immortalTemps.has(name);
  }

  /** Record that a temp holds an immortal value (a choice between interned
   * literals): nothing owns it, and retains, releases and moves skip it. */
  markImmortal(v: LlValue): LlValue {
    this.B.immortalTemps.add(v.name);
    return v;
  }

  /** Registers an owned refcounted value on the current statement frame. */
  own(v: LlValue): LlValue {
    if (isRefCounted(v.type) && !this.isImmortal(v.name)) this.currentFrame().push(v);
    return v;
  }

  /** Registers a SLOT whose current contents the frame owns (conditional
   * results: optional chains, branch joins that park ownership). */
  ownSlot(slot: string, type: IrType): void {
    if (isRefCounted(type)) this.currentFrame().push({ name: slot, type, slot: true });
  }

  /** The innermost lexical scope releases a frame object's reference
   * fields when it exits, as it releases its bindings. */
  ownScopeFields(fields: readonly StackObjectField[]): void {
    const scope = this.scopes[this.scopes.length - 1]!;
    for (const field of fields) scope.push({ slot: field.ptr, type: field.type });
  }

  /** Strike frame-owned slots (ownSlot) from their statement frames: their
   * contents are moving to another owner. */
  disownSlots(slots: readonly { ptr: string }[]): void {
    for (const { ptr } of slots) {
      let found = false;
      for (let i = this.frames.length - 1; i >= 0 && !found; i--) {
        const idx = this.frames[i]!.findIndex((e) => e.slot === true && e.name === ptr);
        if (idx >= 0) {
          this.frames[i]!.splice(idx, 1);
          found = true;
        }
      }
      if (!found)
        throw new InternalCompilerError(`llvm emitter bug: disowned slot ${ptr} not in a frame`);
    }
  }

  /** Strike a refcounted temp from its frame. */
  private disownTemp(v: LlValue): void {
    if (!isRefCounted(v.type) || this.isImmortal(v.name)) return;
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const idx = this.frames[i]!.findIndex((e) => e.name === v.name);
      if (idx >= 0) {
        this.frames[i]!.splice(idx, 1);
        return;
      }
    }
    throw new InternalCompilerError(
      `llvm emitter bug: moved temp ${v.name} not found in any frame`,
    );
  }

  /* Ownership transfers name their destination. A heap reference is one
   * that heap memory holds: a field, an array or map element, a capture
   * box, a union box, a module global, a promise or generator slot, the
   * exception cell, or any other runtime structure. A frame reference is
   * one that a local, a parameter, a return value, a stack object or a
   * temporary holds. Both forms of each operation emit the same code. */

  /** Ends a temp's frame ownership: its reference moves into heap memory. */
  toHeap(v: LlValue): void {
    this.disownTemp(v);
  }

  /** Ends a temp's frame ownership: its reference moves to another frame
   * owner (a local or parameter slot, a callee's parameter, a return
   * value, a stack object, another temp). */
  toFrame(v: LlValue): void {
    this.disownTemp(v);
  }

  /** The retained (+1) read of a refcounted value — type-directed through
   * the `_v` table (immortals skip, exactly the C retain calls). */
  private retainCall(name: string, type: IrType): string {
    if (this.isImmortal(name)) return name;
    const t = this.B.tmp();
    this.B.line(`${t} = call ptr ${retainSym(this.shapeHost, type)}(ptr ${name})`);
    return t;
  }

  /** A +1 of `name` that heap memory keeps. */
  retainHeap(name: string, type: IrType): string {
    return this.retainCall(name, type);
  }

  /** A +1 of `name` that a frame owns. */
  retainFrame(name: string, type: IrType): string {
    return this.retainCall(name, type);
  }

  /** The release call for one owned refcounted value — type-directed like
   * releaseCallC (all runtime releases are NULL-tolerant). */
  private releaseCall(name: string, type: IrType): void {
    if (this.isImmortal(name)) return;
    this.B.line(`call void ${releaseSym(this.shapeHost, type)}(ptr ${name})`);
  }

  /** Releases a reference that heap memory held. */
  releaseHeap(name: string, type: IrType): void {
    this.releaseCall(name, type);
  }

  /** Releases a reference that a frame owned. */
  releaseFrame(name: string, type: IrType): void {
    this.releaseCall(name, type);
  }

  /** A +1 that the runtime made with the heap retain (a box, generator or
   * await read) becomes a frame value. Emits nothing; answers `name`. */
  adoptHeap(name: string, _type: IrType): string {
    return name;
  }

  /** Releases a statement frame's temps and owned slots. */
  releaseTemps(frame: LlValue[]): void {
    for (const v of frame) {
      if (v.slot) {
        const t = this.B.tmp();
        this.B.line(`${t} = load ptr, ptr ${v.name}`);
        if (v.boxed) {
          this.B.line(`call void ${boxReleaseSym(this.shapeHost)}(ptr ${t})`);
        } else {
          this.releaseFrame(t, v.type);
        }
      } else {
        this.releaseFrame(v.name, v.type);
      }
    }
  }

  releaseScope(scope: LlScopeEntry[]): void {
    for (const e of scope) {
      const t = this.B.tmp();
      this.B.line(`${t} = load ptr, ptr ${e.slot}`);
      if (e.boxed && e.lazy) {
        // Unreachable code after a terminator emits nothing; a new block
        // here would revive it.
        if (this.B.isTerminated()) continue;
        const created = this.B.tmp();
        this.B.line(`${created} = icmp ne ptr ${t}, null`);
        const release = this.B.newLabel("lazy.release"),
          join = this.B.newLabel("lazy.release.j");
        this.B.condBr(created, release, join);
        this.B.startBlock(release);
        this.B.line(`call void ${boxReleaseSym(this.shapeHost)}(ptr ${t})`);
        this.B.br(join);
        this.B.startBlock(join);
      } else if (e.boxed) {
        this.B.line(`call void ${boxReleaseSym(this.shapeHost)}(ptr ${t})`);
      } else {
        this.releaseFrame(t, e.type); // runtime releases are NULL-tolerant
      }
    }
  }

  /** THE release-on-jump path (break/continue/return): pending statement
   * frames and entered scopes down to the given depths, innermost first —
   * everything whose normal fall-through releases the jump bypasses.
   * Release every scope crossed by the control-flow edge. */
  releaseForJump(frameDepth: number, scopeDepth: number): void {
    for (let i = this.frames.length - 1; i >= frameDepth; i--) this.releaseTemps(this.frames[i]!);
    for (let i = this.scopes.length - 1; i >= scopeDepth; i--) this.releaseScope(this.scopes[i]!);
  }

  /** Run the finally regions an abrupt loop/block jump crosses, then
   * release to the already-resolved target. This is the return path's
   * completion walk without a parked result value. */
  emitFinallysForJump(finallyDepth: number, frameDepth: number, scopeDepth: number): void {
    if (this.finallyStack.length <= finallyDepth) {
      this.releaseForJump(frameDepth, scopeDepth);
      return;
    }
    const savedFrames = this.frames;
    const savedScopes = this.scopes;
    const savedFinally = this.finallyStack;
    const savedTry = this.tryStack;
    for (let i = savedFinally.length - 1; i >= finallyDepth && !this.B.isTerminated(); i--) {
      const fin = savedFinally[i]!;
      this.releaseForJump(fin.frameDepth, fin.scopeDepth);
      this.frames = this.frames.slice(0, fin.frameDepth);
      this.scopes = this.scopes.slice(0, fin.scopeDepth);
      this.finallyStack = savedFinally.slice(0, i);
      this.tryStack = savedTry.slice(0, fin.tryDepth);
      this.emitBlock(fin.body);
    }
    if (!this.B.isTerminated()) this.releaseForJump(frameDepth, scopeDepth);
    this.frames = savedFrames;
    this.scopes = savedScopes;
    this.finallyStack = savedFinally;
    this.tryStack = savedTry;
  }

  /** THE unwind path at a point where an exception is pending: release
   * everything between here and the innermost try handler — or the whole
   * function — and branch to the handler / return a dummy value (never
   * read: callers of a may-throw function test the pending flag before
   * using the result). Callers own the surrounding pending branch; a
   * `throw` unwinds unconditionally. `passThrough` names a scalar call
   * result of the function's own return type: with nothing to release, the
   * unwind returns it as the dummy, so a call in tail position keeps a single
   * return and stays eligible for tail-call and recursion elimination. */
  emitUnwind(passThrough?: string): void {
    if (this.mod.workers && this.tryStack.length > 0) {
      const stop = this.B.newLabel("context.stop");
      const ordinary = this.B.newLabel("context.throw");
      if (this.executableTls) {
        // A set stop bit unwinds while the active cell may still be clear:
        // install the termination sentinel before skipping the handlers.
        const word = this.loadExcFlag();
        const bit = this.B.tmp();
        const stopped = this.B.tmp();
        this.B.line(`${bit} = and i32 ${word}, 2`);
        this.B.line(`${stopped} = icmp ne i32 ${bit}, 0`);
        this.B.condBr(stopped, stop, ordinary);
        this.B.startBlock(stop);
        this.declare(`declare zeroext i1 @scr_context_checkpoint()`);
        this.B.line(`call zeroext i1 @scr_context_checkpoint()`);
      } else {
        this.declare(`declare zeroext i1 @scr_context_stopping()`);
        const stopped = this.B.tmp();
        this.B.line(`${stopped} = call zeroext i1 @scr_context_stopping()`);
        this.B.condBr(stopped, stop, ordinary);
        this.B.startBlock(stop);
      }
      const handlers = this.tryStack;
      this.tryStack = [];
      this.emitUnwind();
      this.tryStack = handlers;
      this.B.startBlock(ordinary);
    }
    const target = this.tryStack[this.tryStack.length - 1];
    const frameDepth = target?.frameDepth ?? 0;
    const scopeDepth = target?.scopeDepth ?? 0;
    for (let i = this.frames.length - 1; i >= frameDepth; i--) this.releaseTemps(this.frames[i]!);
    let terminator: string;
    if (target) {
      target.used = true;
      terminator = `br label %${target.label}`;
    } else if (this.currentCoro !== null) {
      terminator = `br label %${this.currentCoro.finalLabel}`;
    } else {
      const t = this.llType(this.currentReturnType);
      terminator =
        t === "void"
          ? "ret void"
          : this.currentInt32Result
            ? "ret i32 0"
            : this.currentUnionResult
              ? `ret ${SCALAR_UNION_DUMMY}`
              : t === "double"
                ? `ret double ${f64Lit(0)}`
                : t === "i1"
                  ? "ret i1 false"
                  : "ret ptr null";
    }
    // Copy the entries now: later declarations extend these lexical scopes.
    // Release order and the handler are part of the shared block's identity.
    const entries: LlScopeEntry[] = [];
    let key = terminator;
    for (let i = this.scopes.length - 1; i >= scopeDepth; i--) {
      for (const entry of this.scopes[i]!) {
        entries.push(entry);
        key += `\0${entry.slot}\0${entry.boxed ? "@scr_box_release" : releaseSym(this.shapeHost, entry.type)}`;
      }
    }
    if (entries.length === 0) {
      if (
        passThrough !== undefined &&
        !target &&
        this.currentCoro === null &&
        !this.currentInt32Result
      ) {
        const t = this.llType(this.currentReturnType);
        if (t === "double" || t === "i1") terminator = `ret ${t} ${passThrough}`;
      }
      this.B.terminate(terminator);
      return;
    }
    let cleanup = this.unwindCleanups.get(key);
    if (!cleanup) {
      cleanup = { label: this.B.newLabel("exc.cleanup"), entries, terminator };
      this.unwindCleanups.set(key, cleanup);
    }
    this.B.br(cleanup.label);
  }

  /** Loads the running thread's exact pending word (ELF worker
   * executables, scr_exception.c): bit 0 mirrors the active cell, bit 1
   * requests the context's stop. It lives in the executable's static TLS
   * block, so the access is one thread-pointer-relative load. Monotonic by
   * default: a loop must not hoist the load out and miss a cross-thread
   * stop (see emitPendingCheck for the unordered tests). */
  private loadExcFlag(unordered = false): string {
    this.declare(`@scr_exc_flag = external thread_local(localexec) global i32, align 4`);
    const word = this.B.tmp();
    this.B.line(
      `${word} = load atomic i32, ptr @scr_exc_flag ${unordered ? "unordered" : "monotonic"}, align 4`,
    );
    return word;
  }

  /** Instructions (two-space indented) that set the i1 `dest` to "an
   * exception is pending in the active context" — scr_exc_pending()'s
   * meaning — for the helper and adapter bodies that test it outside
   * emitPendingCheck. Executables read the runtime's exported active-cell
   * pointer and compare its i32 kind (offset 0) against SCR_EXC_NONE inline,
   * as emitPendingCheck does; the out-of-line call would be opaque to LLVM
   * because the runtime links as prebuilt objects. Libraries and worker
   * programs keep the runtime call, which is emitPendingCheck's path there
   * too (workers also observe cross-thread termination in it). */
  pendingTestLines(dest: string): string[] {
    if (this.mod.lib !== undefined || this.mod.workers === true) {
      this.declare(`declare zeroext i1 @scr_exc_pending()`);
      return [`  ${dest} = call zeroext i1 @scr_exc_pending()`];
    }
    this.declare(`@scr_exc_active = external global ptr`);
    return [
      `  ${dest}.cell = load ptr, ptr @scr_exc_active`,
      `  ${dest}.kind = load i32, ptr ${dest}.cell`,
      `  ${dest} = icmp ne i32 ${dest}.kind, 0`,
    ];
  }

  /** The emitter contract for exceptions: after EVERY call that can throw
   * (per the may-throw analysis), test the pending flag and unwind. The
   * call's result temp must join its frame BEFORE this runs so the unwind
   * releases the dummy (NULL for refcounted kinds) harmlessly. A scalar
   * call result of the function's return type may be passed as the unwind's
   * dummy value (see emitUnwind). `poll` marks a worker termination poll
   * (function entry or loop budget), whose test must stay ordered. A
   * `guard` (an i1) limits the test to the paths where it is true: false
   * where the joined call could not have left anything pending. */
  emitPendingCheck(
    passThrough?: { name: string; type: IrType },
    poll = false,
    guard?: string,
  ): void {
    const through =
      passThrough !== undefined &&
      this.llType(passThrough.type) === this.llType(this.currentReturnType) &&
      (passThrough.type.kind === "f64" || passThrough.type.kind === "bool")
        ? passThrough.name
        : undefined;
    const B = this.B;
    if (B.isTerminated()) return;
    let skip: string | undefined;
    if (guard !== undefined) {
      const test = B.newLabel("exc.t");
      skip = B.newLabel("exc.n");
      B.condBr(guard, test, skip);
      B.startBlock(test);
    }
    if (this.mod.lib !== undefined) {
      this.declare(`declare zeroext i1 @scr_exc_pending()`);
      const p = B.tmp();
      B.line(`${p} = call zeroext i1 @scr_exc_pending()`);
      const lu = B.newLabel("exc.u");
      const lk = B.newLabel("exc.k");
      B.condBr(p, lu, lk);
      B.startBlock(lu);
      this.emitUnwind(through);
      B.startBlock(lk);
      if (skip !== undefined) {
        B.br(skip);
        B.startBlock(skip);
      }
      return;
    }
    // Executables test the active exception cell's kind inline (its first
    // field). ELF worker executables test the thread's exact pending word,
    // which is also nonzero once the context must stop, and unwind directly:
    // no site carries an out-of-line call, so LLVM's inliner sees the check
    // as two instructions. Other worker programs test the process-wide
    // alert word: it is nonzero while any script thread may have an
    // exception pending in its active cell or has been asked to stop, so
    // the common case is one ordinary global load (a thread-local access is
    // a call on Darwin) and the out-of-line scr_exc_pending answers for this
    // thread, observing cancellation and reinstalling the termination
    // sentinel.
    this.declare(`declare i1 @llvm.expect.i1(i1, i1)`);
    let word: string;
    const exact = this.mod.workers !== true || this.executableTls;
    if (this.executableTls) {
      // Termination stays observable where the polls were dropped for it:
      // polls, tests inside source loops (exc's loop-poll rule relies on
      // them every iteration) and tail-position tests (a dead ordered load
      // keeps recursion from becoming a loop without stack growth) use an
      // ordered load, which LLVM never deletes, hoists or merges. Every
      // other test is an unordered load: it reads the same word, but LLVM's
      // memory analyses no longer treat it as a write, so loads around it
      // stay forwardable after inlining. Same-thread changes only happen in
      // runtime calls, which clobber memory.
      word = this.loadExcFlag(!poll && through === undefined && this.loopDepth === 0);
    } else if (this.mod.workers === true) {
      // dso_local: executables link the runtime statically, so the word is
      // addressed directly instead of through the GOT.
      this.declare(`@scr_exc_alert = external dso_local global i32, align 64`);
      word = B.tmp();
      B.line(`${word} = load atomic i32, ptr @scr_exc_alert monotonic, align 64`);
    } else {
      this.declare(`@scr_exc_active = external global ptr`);
      let cell: string;
      if (B.excCellInvariant) {
        // Fiber switches restore the active cell before control returns to a
        // synchronous frame, so its pointer is one value for the whole call:
        // load it once in the entry block and test only the kind here.
        if (B.excCell === null) {
          B.excCell = "%exc.cell";
          B.entryAllocas.push(`${B.excCell} = load ptr, ptr @scr_exc_active`);
        }
        cell = B.excCell;
      } else {
        cell = B.tmp();
        B.line(`${cell} = load ptr, ptr @scr_exc_active`);
      }
      word = B.tmp();
      B.line(`${word} = load i32, ptr ${cell}`);
    }
    const hit = B.tmp();
    const cold = B.tmp();
    B.line(`${hit} = icmp ne i32 ${word}, 0`);
    B.line(`${cold} = call i1 @llvm.expect.i1(i1 ${hit}, i1 false)`);
    const lu = B.newLabel("exc.u");
    const lk = B.newLabel("exc.k");
    if (!exact) {
      this.declare(`declare zeroext i1 @scr_exc_pending()`);
      const slow = B.newLabel("exc.s");
      B.condBr(cold, slow, lk);
      B.startBlock(slow);
      const p = B.tmp();
      B.line(`${p} = call zeroext i1 @scr_exc_pending()`);
      B.condBr(p, lu, lk);
    } else {
      B.condBr(cold, lu, lk);
    }
    B.startBlock(lu);
    this.emitUnwind(through);
    B.startBlock(lk);
    if (skip !== undefined) {
      B.br(skip);
      B.startBlock(skip);
    }
  }

  /** After a runtime call that ALWAYS leaves an exception pending (the
   * compiler-resolved Node throws): the pending test would always answer
   * true, so unwind unconditionally. Emission continues in a block with no
   * predecessors so the caller's remaining instructions stay well-formed;
   * LLVM deletes it. */
  emitAlwaysPendingUnwind(): void {
    const B = this.B;
    if (B.isTerminated()) return;
    this.emitUnwind();
    B.startBlock(B.newLabel("exc.dead"));
  }

  /** A recursive function's entry check: below the running stack's guard,
   * throw Node's RangeError and unwind like any other pending exception. */
  emitStackCheck(): void {
    const B = this.B;
    this.declare(`declare ptr @llvm.stacksave.p0()`);
    this.declare(`declare i1 @llvm.expect.i1(i1, i1)`);
    this.declare(`declare void @scr_stack_overflow()`);
    const over = B.newLabel("stack.over");
    const ok = B.newLabel("stack.ok");
    const sp = B.tmp();
    B.line(`${sp} = call ptr @llvm.stacksave.p0()`);
    const test = (guard: string): void => {
      const low = B.tmp();
      const cold = B.tmp();
      B.line(`${low} = icmp ult ptr ${sp}, ${guard}`);
      B.line(`${cold} = call i1 @llvm.expect.i1(i1 ${low}, i1 false)`);
      B.condBr(cold, over, ok);
    };
    if (this.stackGuardTsd !== null) {
      // A Darwin thread-local access is a call to its TLV thunk: read the
      // guard from its thread-specific-data slot at the runtime-validated
      // offset instead, and call out only when the runtime found no slot.
      this.declare(`@scr_stack_guard_tsd = external dso_local global i64`);
      this.declare(`declare i64 @scr_stack_guard_get()`);
      const offset = B.tmp();
      const direct = B.tmp();
      const likely = B.tmp();
      B.line(`${offset} = load i64, ptr @scr_stack_guard_tsd`);
      B.line(`${direct} = icmp ne i64 ${offset}, 0`);
      B.line(`${likely} = call i1 @llvm.expect.i1(i1 ${direct}, i1 true)`);
      const fast = B.newLabel("stack.tsd");
      const slow = B.newLabel("stack.tlv");
      B.condBr(likely, fast, slow);
      B.startBlock(fast);
      const guard = B.tmp();
      if (this.stackGuardTsd === "aarch64") {
        this.declare(`declare i64 @llvm.read_register.i64(metadata)`);
        const thread = B.tmp();
        const base = B.tmp();
        const slot = B.tmp();
        const address = B.tmp();
        B.line(`${thread} = call i64 @llvm.read_register.i64(metadata !{!"tpidrro_el0"})`);
        B.line(`${base} = and i64 ${thread}, -8`);
        B.line(`${slot} = add i64 ${base}, ${offset}`);
        B.line(`${address} = inttoptr i64 ${slot} to ptr`);
        B.line(`${guard} = load ptr, ptr ${address}`);
      } else {
        const address = B.tmp();
        B.line(`${address} = inttoptr i64 ${offset} to ptr addrspace(256)`);
        B.line(`${guard} = load ptr, ptr addrspace(256) ${address}`);
      }
      test(guard);
      B.startBlock(slow);
      // uintptr_t scr_stack_guard_get(void): an i64 in the C ABI.
      const raw = B.tmp();
      const fallback = B.tmp();
      B.line(`${raw} = call i64 @scr_stack_guard_get()`);
      B.line(`${fallback} = inttoptr i64 ${raw} to ptr`);
      test(fallback);
    } else {
      const tl = this.mod.workers === true ? "thread_local " : "";
      this.declare(`@scr_stack_guard = external ${tl}global ptr`);
      const guard = B.tmp();
      B.line(`${guard} = load ptr, ptr @scr_stack_guard`);
      test(guard);
    }
    B.startBlock(over);
    B.line(`call void @scr_stack_overflow()`);
    this.emitUnwind();
    B.startBlock(ok);
  }

  /** Whether the emitter follows this call with a pending test (the
   * conditions in expr-calls.ts). */
  private callTestsPending(e: IrExpr): boolean {
    switch (e.kind) {
      case "call":
        return this.mayThrow.has(e.callee);
      case "new":
        return this.mayThrow.has(`%${e.className}.constructor`);
      case "virtualCall":
        return this.mayThrowMethods.has(e.method);
      case "callValue":
        return this.indirectMayThrow;
      default:
        return false;
    }
  }

  workerLoopBudget(
    loop: Extract<IrStmt, { kind: "while" | "doWhile" | "for" | "forOf" }>,
  ): string | null {
    if (!this.mod.workers) return null;
    // A loop that runs a pending test on every iteration observes a
    // terminate request through it; a separate poll would only add work.
    if (loopTestsEveryIteration(loop, (e) => this.callTestsPending(e))) return null;
    const slot = this.B.slot();
    this.B.entryAllocas.push(`${slot} = alloca i32 ; worker cancellation budget`);
    this.B.line(`store i32 0, ptr ${slot}`);
    return slot;
  }
  emitLoopCopies(
    loop: Extract<IrStmt, { kind: "while" | "doWhile" | "for" }>,
    allowed: boolean,
    exit: string,
    emitCopy: (exit: string) => void,
  ): void {
    return emitLoopCopies(this, loop, allowed, exit, emitCopy);
  }

  /** Store the double of each deferred shadow back to its binding. */
  writeBackDeferred(deferred: Set<string>): void {
    const B = this.B;
    for (const id of deferred) {
      const integer = B.tmp(),
        number = B.tmp();
      B.line(`${integer} = load i64, ptr ${this.integerLoopBindings.get(id)!.slot}`);
      B.line(`${number} = sitofp i64 ${integer} to double`);
      B.line(`store double ${number}, ptr ${this.binding(id).slot}`);
    }
  }

  /** A number local whose only storage is its own double slot, so an i64
   * shadow beside it can stand for it within one loop. */
  speculativeLocal(id: string): boolean {
    const local = this.currentLocals.get(id);
    if (!local) return this.speculativeGlobal(id);
    if (local.type.kind !== "f64" || local.boxed || local.tdz) return false;
    return !(
      this.captureIds.has(id) ||
      this.int32Locals.has(id) ||
      this.integerLoopBindings.has(id) ||
      this.integerViews.has(id) ||
      this.localUnionStorage.has(id) ||
      this.reboundOwnerSlots.has(id) ||
      this.lazyCaptureBoxes.has(id) ||
      this.privateSplitLocals.has(id)
    );
  }

  /** A module-level number written only by the file's top-level code that
   * is emitting this loop. Calls may still read it: the fast copy keeps its
   * double current. An init function runs once and is never re-entered, so
   * no call from the loop can write the global behind the shadow. */
  private speculativeGlobal(id: string): boolean {
    if (!this.speculativeFunction.startsWith("%init.")) return false;
    const writers = this.numberGlobalWriters(id);
    return (
      writers !== null &&
      (writers.size === 0 || (writers.size === 1 && writers.has(this.speculativeFunction)))
    );
  }

  /** A module-level number a loop of any function only reads, written by
   * nothing but top-level code: an init function never runs during a loop
   * of another function, so the entry value stays its value. */
  speculativeInvariantGlobal(id: string): boolean {
    const writers = this.numberGlobalWriters(id);
    return writers !== null && [...writers].every((name) => name.startsWith("%init."));
  }

  /** The functions writing a number global a shadow may stand for, or null
   * when the global is not such a number. */
  private numberGlobalWriters(id: string): ReadonlySet<string> | null {
    if (this.globalTypes.get(id)?.kind !== "f64") return null;
    if (this.tdzGlobals.has(id) || this.integerViews.has(id)) return null;
    if (!this.globalWriters) {
      const writers = new Map<string, Set<string>>();
      for (const fn of this.mod.functions) {
        const note = (localId: string): void => {
          if (!localId.startsWith("%g.")) return;
          const set = writers.get(localId) ?? new Set<string>();
          set.add(fn.name);
          writers.set(localId, set);
        };
        everyStmtList(fn.body, {
          stmt: (s) => {
            if (s.kind === "assign" || s.kind === "varDecl") note(s.localId);
            return true;
          },
          expr: (e) => {
            if (e.kind === "assignExpr" || e.kind === "incDec") note(e.localId);
            return true;
          },
        });
      }
      this.globalWriters = writers;
    }
    return this.globalWriters.get(id) ?? new Set<string>();
  }
  private emitSpeculativeWrite(s: IrStmt, resume: string | undefined): void {
    return emitSpeculativeWrite(this, s, resume);
  }

  /** The amortized cancellation poll, emitted on the loop's back edge (the
   * continue target), after the body. A poll in the header would be a loop
   * exit ahead of the body; LLVM then cannot rotate the loop, so loads that
   * the body repeats on every iteration (a typed array's length, for one)
   * stay in the loop. */
  emitWorkerLoopCheck(slot: string | null): void {
    if (slot === null) return;
    const B = this.B;
    const budget = B.tmp(),
      due = B.tmp(),
      remaining = B.tmp();
    const poll = B.newLabel("worker.poll"),
      next = B.newLabel("worker.next");
    B.line(`${budget} = load i32, ptr ${slot}`);
    B.line(`${remaining} = sub i32 ${budget}, 1`);
    B.line(`store i32 ${remaining}, ptr ${slot}`);
    B.line(`${due} = icmp eq i32 ${budget}, 0`);
    B.condBr(due, poll, next);
    B.startBlock(poll);
    B.line(`store i32 63, ptr ${slot}`);
    // Calls and throwing operations retain their own checks. Amortize the
    // extra cancellation poll across bounded loop batches so scalar work
    // does not cross the runtime ABI on every iteration.
    this.emitPendingCheck(undefined, true);
    B.br(next);
    B.startBlock(next);
  }

  /** Moves an already-evaluated value into the runtime's exception cell —
   * the `throw` statement's kind dispatch (stmts.ts's), shared with
   * every synthetic thrower. Ownership of a refcounted payload must have
   * been moved off its frame by the caller. */
  emitThrowValue(v: LlValue): void {
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
    } else if (
      t.kind === "object" &&
      this.classMeta.get(t.className)?.hierarchy === true &&
      this.classMeta.get(t.className)?.idInRc !== true
    ) {
      // Hierarchy instances carry a vtable word: the OBJ kind keeps the
      // dynamic class inspectable (catch-binding instanceof, the uncaught
      // printer's "name: message" for Error instances). Instances that keep
      // their class id in the rc word are never Errors and are thrown as
      // REF payloads (narrow-guards.ts emitCaughtClassIdInstanceof).
      const rc = vAdapters(this.shapeHost, t);
      this.declare(`declare void @scr_throw_obj(ptr, ptr, ptr, ptr)`);
      B.line(
        `call void @scr_throw_obj(ptr ${v.name}, ptr ${rc.retain}, ptr ${rc.release}, ptr ${traceArg(this.shapeHost, t)})`,
      );
    } else if (
      t.kind === "symbol" ||
      t.kind === "bigint" ||
      t.kind === "func" ||
      t.kind === "classval"
    ) {
      const rc = vAdapters(this.shapeHost, t);
      this.declare(`declare void @scr_throw_primitive_ref(ptr, ptr, ptr, ptr)`);
      B.line(
        `call void @scr_throw_primitive_ref(ptr ${v.name}, ptr ${rc.retain}, ptr ${rc.release}, ptr null)`,
      );
    } else if (t.kind === "dyn") {
      this.declare(`declare void @scr_dyn_throw(ptr)`);
      B.line(`call void @scr_dyn_throw(ptr ${v.name})`);
    } else {
      const rc = vAdapters(this.shapeHost, t);
      this.declare(`declare void @scr_throw_ref(ptr, ptr, ptr, ptr)`);
      B.line(
        `call void @scr_throw_ref(ptr ${v.name}, ptr ${rc.retain}, ptr ${rc.release}, ptr ${traceArg(this.shapeHost, t)})`,
      );
    }
  }

  /** JS truthiness of a value (falsy: false, 0, -0, NaN, "", nullish
   * union arms): one fcmp for f64 (NaN and both zeros compare !one), a
   * length load for strings, an inline tag switch for unions, `!= null`
   * for the always-truthy object kinds (JS: [] and {} are truthy). */
  truthy(v: LlValue): string {
    const B = this.B;
    if (v.type.kind === "union") {
      // The ARM value's ToBoolean: an inline tag switch (the runtime ABI’s
      // per-union interned helper, emitted at the use site instead).
      const def = this.unionsById.get(v.type.unionId);
      if (!def)
        throw new InternalCompilerError(
          `llvm emitter bug: truthiness of unknown union ${v.type.unionId}`,
        );
      const nullable = this.nullableUnions.get(def.id);
      // Object arms are always truthy: present iff neither unit encoding.
      if (nullable && isObjectArm(nullable)) return emitNullablePresent(B, nullable, v.name);
      const unionId = def.id;
      const slot = B.slot();
      B.entryAllocas.push(`${slot} = alloca i1`);
      const join = B.newLabel("ut.j");
      this.unionTagSwitch(v.name, def, (arm) => {
        let valueName = "false";
        if (arm.kind === "f64" || arm.kind === "procStream") {
          valueName = this.unionGetF64(v.name);
        } else if (arm.kind === "bool") {
          valueName = this.unionGetBool(v.name);
        } else if (arm.kind === "string") {
          valueName = this.unionPeek(v.name, unionId);
        } else if (arm.kind === "bigint" || arm.kind === "dyn") {
          valueName = this.unionPeek(v.name, unionId);
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
        return "false";
      case "bool":
        return valueName;
      case "f64": {
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
      case "bigint": {
        this.declare(`declare zeroext i1 @scr_bigint_truthy(ptr)`);
        const truthy = B.tmp();
        B.line(`${truthy} = call zeroext i1 @scr_bigint_truthy(ptr ${valueName})`);
        return truthy;
      }
      case "date":
      // Process streams use a numeric descriptor internally, including zero
      // for stdin. They remain JavaScript objects in boolean contexts.
      case "procStream":
      // A module namespace object is always present.
      case "moduleNs":
        return "true";
      case "array":
      case "record":
      case "object":
      case "classval":
      case "func":
      case "map":
      case "set":
      case "symbol":
      case "regex":
      case "promise":
      case "bytes":
      case "url":
      case "searchParams":
      case "stats":
      case "fileHandle":
      case "dir":
      case "spawnRes":
      case "child":
      case "childStream":
      case "childWriter":
      case "generator":
      case "fsWatcher":
      case "cryptoHash":
      case "cryptoHmac":
      case "netSocket":
      case "netServer":
      case "httpReq":
      case "httpRes":
      case "httpClientReq":
      case "http2Session":
      case "http2Stream":
      case "dgramSocket":
      case "secureCtx":
      case "testCtx": {
        if (unionArm) return "true";
        const truthy = B.tmp();
        B.line(`${truthy} = icmp ne ptr ${valueName}, null`);
        return truthy;
      }
      case "dyn": {
        this.declare(`declare zeroext i1 @scr_dyn_truthy(ptr)`);
        const truthy = B.tmp();
        B.line(`${truthy} = call zeroext i1 @scr_dyn_truthy(ptr ${valueName})`);
        return truthy;
      }
      case "jsval":
        return jsTruthy(this, valueName);
      default:
        throw new LlvmUnsupportedError(`truthy:${unionArm ? "union:" : ""}${kind}`);
    }
  }

  // ── union plumbing ──────────────────────────────────────────────────────

  /** A union value's tag (i32): the box's tag word, or the NULL test of a
   * nullable union's pointer. */
  /** A box's tag and payload words are written only where the box is
   * built (runtime constructors and untagged stack stores), so their loads
   * carry their own alias tags: element and field stores cannot change
   * them, and loops keep them hoisted. */
  unionTag(uName: string, unionId: string): string {
    return emitUnionTag(
      this.B,
      this.nullableUnions.get(unionId),
      uName,
      this.memoryAliasAttachment("union.tag"),
    );
  }

  /** Guard for helpers that build or read a union's `%ScrUnion` box
   * directly (library-shaped unions with fixed arms): a nullable union
   * reaching one is an emitter bug and throws InternalCompilerError. */
  requireBoxedUnion(unionId: string): void {
    if (this.nullableUnions.has(unionId))
      throw new InternalCompilerError(
        `llvm emitter bug: nullable union ${unionId} reached a tagged-box helper`,
      );
  }

  /** The BORROWED payload pointer of a ref arm (scr_union_peek inlined —
   * the runtime's is a static inline); a nullable union is its payload. */
  unionPeek(uName: string, unionId: string): string {
    return emitUnionPeek(
      this.B,
      this.nullableUnions.get(unionId),
      uName,
      this.memoryAliasAttachment("union.payload"),
    );
  }

  /** Emits `switch` over a union's tag with one block per arm; each arm
   * body must TERMINATE its block (the callers branch to a join). The
   * default block is the runtime ABI’s invalid-tag abort. Shared field
   * reads can group equivalent storage prefixes and emit one representative. */
  unionTagSwitch(
    uName: string,
    def: IrUnionDef,
    arm: (armType: IrType, tag: number) => void,
    fieldGroups?: number[][],
  ): void {
    const B = this.B;
    const tag = this.unionTag(uName, def.id);
    const bad = B.newLabel("u.bad");
    const labels: string[] = [];
    if (fieldGroups) {
      for (const group of fieldGroups) {
        const label = B.newLabel("u.a");
        for (const member of group) {
          if (member === undefined)
            throw new InternalCompilerError("llvm emitter bug: missing union field tag");
          labels[member] = label;
        }
      }
    } else {
      for (let i = 0; i < def.arms.length; i++) labels.push(B.newLabel("u.a"));
    }
    if (fieldGroups?.length === 1) {
      const valid = B.tmp();
      B.line(`${valid} = icmp ult i32 ${tag}, ${def.arms.length}`);
      B.condBr(valid, labels[0]!, bad);
    } else {
      B.terminate(
        `switch i32 ${tag}, label %${bad} [ ${def.arms.map((_, i) => `i32 ${i}, label %${labels[i]}`).join(" ")} ]`,
      );
    }
    if (fieldGroups) {
      for (const group of fieldGroups) {
        const representative = group[0]!;
        B.startBlock(labels[representative]!);
        arm(def.arms[representative]!, representative);
      }
    } else {
      def.arms.forEach((a, i) => {
        B.startBlock(labels[i]!);
        arm(a, i);
      });
    }
    B.startBlock(bad);
    this.needsBadTag = true;
    B.line(`call void @sc_bad_tag()`);
    B.terminate(`unreachable`);
  }

  /** The +1 extraction of a union's single narrowed arm (unionNarrow /
   * the nullish-family reads): scalars via inline payload loads, ref arms
   * a retained peek. */
  unionExtract(uName: string, unionId: string, arm: IrType): string {
    if (arm.kind === "f64" || arm.kind === "procStream") return this.unionGetF64(uName);
    if (arm.kind === "bool") return this.unionGetBool(uName);
    return this.retainFrame(this.unionPeek(uName, unionId), arm);
  }

  /** A scalar f64 arm's payload (scr_union_get_f64 inlined). Inline loads
   * keep stack boxes free of escaping calls, so LLVM can scalarize them. */
  unionGetF64(uName: string): string {
    const p = this.B.tmp();
    const t = this.B.tmp();
    this.B.line(`${p} = getelementptr inbounds %ScrUnion, ptr ${uName}, i64 0, i32 5`);
    this.B.line(`${t} = load double, ptr ${p}`);
    return t;
  }

  /** A bool arm's payload (scr_union_get_bool inlined: nonzero slot). */
  unionGetBool(uName: string): string {
    const p = this.B.tmp();
    const bits = this.B.tmp();
    const t = this.B.tmp();
    this.B.line(`${p} = getelementptr inbounds %ScrUnion, ptr ${uName}, i64 0, i32 5`);
    this.B.line(`${bits} = load i64, ptr ${p}`);
    this.B.line(`${t} = icmp ne i64 ${bits}, 0`);
    return t;
  }

  /** Constructs a union box around an OWNED (+1, already moved) value —
   * the scr_union_new_* dispatch of unionWrap and the wrap-into-join
   * sites (shift). */
  unionNewOwned(unionId: string, tag: number, v: LlValue): string {
    const B = this.B;
    const nullable = this.nullableUnions.get(unionId);
    if (nullable) {
      // The owned payload IS the nullable union's value.
      if (
        nullable.repr === "single"
          ? tag !== nullable.refTag
          : !nullable.arms.some((arm) => arm.tag === tag)
      )
        throw new InternalCompilerError(
          `llvm emitter bug: payload wrap into unit arm ${tag} of ${unionId}`,
        );
      return v.name;
    }
    const t = B.tmp();
    if (v.type.kind === "f64" || v.type.kind === "procStream") {
      this.declare(`declare ptr @scr_union_new_f64(i32, double)`);
      B.line(`${t} = call ptr @scr_union_new_f64(i32 ${tag}, double ${v.name})`);
      return t;
    }
    if (v.type.kind === "bool") {
      this.declare(`declare ptr @scr_union_new_bool(i32, i1 zeroext)`);
      B.line(`${t} = call ptr @scr_union_new_bool(i32 ${tag}, i1 ${v.name})`);
      return t;
    }
    const rc = vAdapters(this.shapeHost, v.type);
    this.declare(`declare ptr @scr_union_new_ref(i32, ptr, ptr, ptr, ptr)`);
    B.line(
      `${t} = call ptr @scr_union_new_ref(i32 ${tag}, ptr ${v.name}, ptr ${rc.retain}, ptr ${rc.release}, ptr ${traceArg(this.shapeHost, v.type)})`,
    );
    return t;
  }

  // ── class plumbing ──────────────────────────────────────────────────────

  classMetaOf(className: string): LlClassMeta {
    const meta = this.classMeta.get(className);
    if (!meta) throw new InternalCompilerError(`llvm emitter bug: unknown class ${className}`);
    return meta;
  }

  /** The field-slot pointer of a class member: rc at 0, the vtable word at
   * 1 on hierarchy members, then the flattened field list. Runtime error
   * classes GEP through %ScrError (their structs live in the runtime; the
   * def's [name, message, %code, %cause] order matches the layout). */
  classFieldPtr(
    objName: string,
    className: string,
    field: string,
    refs: "pointer" | "compressed" = "pointer",
  ): { ptr: string; type: IrType; inline: boolean; compressed: boolean } {
    const meta = this.classMetaOf(className);
    const { index, type, compressed } = classFieldIndex(meta, field, refs);
    const p = this.B.tmp();
    this.B.line(
      `${p} = getelementptr inbounds %${classStructSym(className)}, ptr ${objName}, i64 0, i32 ${index}`,
    );
    this.markFieldPointer(p, field);
    if (compressed) this.compressedFieldPtrs.add(p);
    return { ptr: p, type, inline: this.inlineUnions.classField(className, field), compressed };
  }

  /** Whether values of `t` are NULL or a compact class instance: `C`,
   * `C | undefined` or `C | null` for a compact class `C`. `C | null |
   * undefined` is not: its null is a sentinel outside the region. */
  compactRefType(
    t: IrType,
    isCompact: (className: string) => boolean = (name) =>
      this.classMeta.get(name)?.compact === true,
  ): boolean {
    if (t.kind === "object") return isCompact(t.className);
    if (t.kind !== "union") return false;
    const single = this.nullableUnions.single(t.unionId);
    return (
      single !== null &&
      single.nullTag < 0 &&
      single.arm.kind === "object" &&
      isCompact(single.arm.className)
    );
  }

  /** Whether arrays of `elem` hold 32-bit references (SCR_ELEM_CREF). */
  compactArrayElem(elem: IrType): boolean {
    return this.compactRegion && this.compactRefType(elem);
  }

  /** Loads the reference a field pointer addresses: a pointer, or the
   * decoded 32-bit reference of a compressed field (compressedFieldPtrs).
   * `tagged`: the load carries the field's alias tags. */
  loadRef(ptr: string, tagged = true): string {
    const B = this.B;
    const v = B.tmp();
    const tags = tagged ? this.fieldAliasAttachment(ptr) : "";
    if (!this.compressedFieldPtrs.has(ptr)) {
      B.line(`${v} = load ptr, ptr ${ptr}${tags}`);
      return v;
    }
    const idx = B.tmp();
    B.line(`${idx} = load i32, ptr ${ptr}${tags}`);
    for (const line of compactRefLoadLines(idx, v, `${v}.r`)) B.line(line.trimStart());
    return v;
  }

  /** Stores `value` (a pointer) through a field pointer: as is, or encoded
   * as the 32-bit reference of a compressed field. */
  storeRef(ptr: string, value: string): void {
    const B = this.B;
    if (!this.compressedFieldPtrs.has(ptr)) {
      B.line(`store ptr ${value}, ptr ${ptr}${this.fieldAliasAttachment(ptr)}`);
      return;
    }
    const idx = B.tmp();
    for (const line of compactRefStoreLines(value, idx, `${idx}.r`)) B.line(line.trimStart());
    B.line(`store i32 ${idx}, ptr ${ptr}${this.fieldAliasAttachment(ptr)}`);
  }

  /** The dynamic class's preorder number (borrowed object; the static class
   * names the struct spelling and where the number is, classPreLines). */
  loadVtPre(objName: string, staticClassName: string): string {
    const B = this.B;
    const pre = B.tmp();
    const meta = this.classMetaOf(staticClassName);
    for (const line of classPreLines(
      meta,
      classStructSym(staticClassName),
      objName,
      pre,
      this.sizeType,
    ))
      B.line(line.trimStart());
    return pre;
  }

  /** The class object's static symbol (classes as values), registering it
   * for assembly on first use and interning the .name literal while the
   * table is still open (the regex-literal discipline). */
  classObjSym(className: string): string {
    if (!this.classObjs.has(className)) {
      const meta = this.classMetaOf(className);
      // util.inspect prints `[class C extends B]` with the base's name.
      const baseName = meta.base ? classJsName(meta.base.def) : "";
      this.classObjs.set(className, {
        nameSym: this.internLiteral(classJsName(meta.def)),
        baseNameSym: baseName ? this.internLiteral(baseName) : null,
      });
    }
    this.journal?.entry("classObj", className, this.classObjs.get(className));
    return mangleClassObj(className);
  }

  // ── record plumbing ─────────────────────────────────────────────────────

  recordShape(shapeId: string): IrRecordShape {
    const shape = this.recordsById.get(shapeId);
    if (!shape)
      throw new InternalCompilerError(`llvm emitter bug: unknown record shape ${shapeId}`);
    return shape;
  }

  /** Record prefixes with the same LLVM storage types put a field at the
   * same offset on every target. Share one field-read block per matching
   * prefix; class variants retain their own concrete layout dispatch. */
  unionFieldGroups(def: IrUnionDef, field: string): number[][] {
    const key = `${def.id}\0${field}`;
    const cached = this.unionFieldReadGroups.get(key);
    if (cached !== undefined) return cached;
    const groups = new Map<string, number[]>();
    for (let tag = 0; tag < def.arms.length; tag++) {
      const arm = def.arms[tag]!;
      let layout = `variant:${tag}`;
      if (arm.kind === "record") {
        const shape = this.recordShape(arm.shapeId);
        const index = shape.fields.findIndex((entry) => entry.name === field);
        if (index < 0)
          throw new InternalCompilerError(`llvm emitter bug: missing union field ${field}`);
        layout = this.nullableUnions.fieldBase(arm.shapeId) === 2 ? "record:tagged;" : "record:";
        for (let i = 0; i <= index; i++) {
          const type = shape.fields[i]!.type;
          layout += `${llFieldType(type, this.inlineUnions.record(type))};`;
        }
      }
      const group = groups.get(layout);
      if (group) group.push(tag);
      else groups.set(layout, [tag]);
    }
    const result = [...groups.values()];
    this.unionFieldReadGroups.set(key, result);
    return result;
  }

  /** The zeroed `%ScrUnion` constant (inline-unions.ts unionBoxBits). */
  unionNoneRef(): string {
    this.needsUnionNone = true;
    return "@sc_union_none";
  }

  /** The field-slot pointer of a record member (rc header at index 0).
   * `inline`: the slot stores a scalar union's tag and bits. */
  recordFieldPtr(
    objName: string,
    shapeId: string,
    field: string,
  ): { ptr: string; type: IrType; inline: boolean } {
    const shape = this.recordShape(shapeId);
    const idx = shape.fields.findIndex((f) => f.name === field);
    if (idx < 0)
      throw new InternalCompilerError(
        `llvm emitter bug: unknown field ${field} on shape ${shapeId}`,
      );
    const p = this.B.tmp();
    this.B.line(
      `${p} = getelementptr inbounds %${mangleRecordStruct(shapeId)}, ptr ${objName}, i64 0, i32 ${idx + this.nullableUnions.fieldBase(shapeId)}`,
    );
    const type = shape.fields[idx]!.type;
    return { ptr: p, type, inline: this.inlineUnions.record(type) };
  }

  /** The overflow map's slot pointer on an index-signature shape. */
  recordOvfPtr(objName: string, shapeId: string): string {
    const shape = this.recordShape(shapeId);
    if (!shape.indexValue)
      throw new InternalCompilerError(`llvm emitter bug: shape ${shapeId} has no overflow map`);
    const p = this.B.tmp();
    const v = this.B.tmp();
    this.B.line(
      `${p} = getelementptr inbounds %${mangleRecordStruct(shapeId)}, ptr ${objName}, i64 0, i32 ${shape.fields.length + this.nullableUnions.fieldBase(shapeId)}`,
    );
    this.B.line(`${v} = load ptr, ptr ${p}`);
    return v;
  }

  /** The pointer to ScrMap.flags of an index-signature record's overflow
   * map (byte offset sizeof(size_t) + 3; SCR_MAP_NULL_PROTO is bit 0). */
  recordMapFlagsPtr(objName: string, shapeId: string): string {
    const ovf = this.recordOvfPtr(objName, shapeId);
    const p = this.B.tmp();
    this.B.line(
      `${p} = getelementptr inbounds i8, ptr ${ovf}, i64 ${mapFlagsOffset(this.sizeType)}`,
    );
    return p;
  }

  /** Loads a record field (i8-stored bools trunc to i1). An inline union
   * field answers a private stack box with the slot's own bits, ABSENT
   * included: it may only be borrowed. */
  loadField(ptr: string, t: IrType, inline: boolean): string {
    const B = this.B;
    if (inline) {
      const { tag, bits } = loadInlineUnion(B, ptr);
      return stackUnionBox(B, this.sizeType, tag, bits);
    }
    if (this.compressedFieldPtrs.has(ptr)) return this.loadRef(ptr);
    const fieldTy = llFieldType(t, false);
    const raw = B.tmp();
    B.line(`${raw} = load ${fieldTy}, ptr ${ptr}${this.fieldAliasAttachment(ptr)}`);
    if (fieldTy !== "i8") return raw;
    const b = B.tmp();
    B.line(`${b} = trunc i8 ${raw} to i1`);
    return b;
  }

  /** A record field of this shape stores its scalar union inline. */
  recordFieldInline(shapeId: string, field: string): boolean {
    const type = this.recordShape(shapeId).fields.find((f) => f.name === field)?.type;
    return type !== undefined && this.inlineUnions.record(type);
  }

  /** The value a field store writes: an inline union slot copies the tag
   * and bits of a borrowed projection, so no box is built for it. */
  emitFieldValue(value: IrExpr, inline: boolean): LlValue {
    return inline ? this.emitUnionProjection(value) : this.emitExpr(value);
  }

  /** Overwrites a field with `v` (from emitFieldValue). A reference moves
   * in, and the old value is released AFTER the field is overwritten. */
  replaceField(ptr: string, type: IrType, inline: boolean, v: LlValue): void {
    if (!inline && isRefCounted(type)) {
      this.toHeap(v);
      const old = this.loadRef(ptr, false);
      this.storeField(ptr, type, v.name, false);
      this.releaseHeap(old, type);
      return;
    }
    this.storeField(ptr, type, v.name, inline);
  }

  /** Stores `v` (from emitFieldValue) into a fresh field slot. */
  initField(ptr: string, type: IrType, inline: boolean, v: LlValue): void {
    if (!inline && isRefCounted(type)) this.toHeap(v);
    this.storeField(ptr, type, v.name, inline);
  }

  /** Stores a record field (i1 zext to the i8 storage). An inline union
   * field copies the tag and bits of the union value, which its owner
   * keeps. */
  storeField(ptr: string, t: IrType, value: string, inline: boolean): void {
    const B = this.B;
    if (inline) {
      const { tag, bits } = unionBoxBits(B, value, this.unionNoneRef());
      storeInlineUnion(B, ptr, tag, bits);
      return;
    }
    if (this.compressedFieldPtrs.has(ptr)) {
      this.storeRef(ptr, value);
      return;
    }
    const fieldTy = llFieldType(t, false);
    if (fieldTy !== "i8") {
      B.line(`store ${fieldTy} ${value}, ptr ${ptr}${this.fieldAliasAttachment(ptr)}`);
      return;
    }
    const z = B.tmp();
    B.line(`${z} = zext i1 ${value} to i8`);
    B.line(`store i8 ${z}, ptr ${ptr}${this.fieldAliasAttachment(ptr)}`);
  }

  /** Reads an int32-specialized class field: the i32 slot is the value,
   * and its widening is the exact double every program observation sees. */
  loadInt32Field(ptr: string, type: IrType): LlValue {
    const B = this.B;
    const raw = B.tmp();
    const number = B.tmp();
    B.line(`${raw} = load i32, ptr ${ptr}${this.fieldAliasAttachment(ptr)}`);
    B.line(`${number} = sitofp i32 ${raw} to double`);
    return {
      name: number,
      type,
      uint32: raw,
      integer: { name: raw, type: "i32", signed: true, range: INT32_RANGE },
    };
  }

  /** Stores a value the whole-program analysis proved to be an int32 (never
   * -0, NaN or fractional) into an int32-specialized class field. */
  storeInt32Field(ptr: string, value: LlValue, expr: IrExpr): void {
    if (!this.int32Slots.provenWrites.has(expr))
      throw new InternalCompilerError("llvm emitter bug: unproven int32 field write");
    const B = this.B;
    let bits: string;
    if (value.integer?.type === "i32") bits = value.integer.name;
    else if (value.integer) {
      bits = B.tmp();
      B.line(`${bits} = trunc i64 ${value.integer.name} to i32`);
    } else if (value.uint32 !== undefined) bits = value.uint32;
    else {
      bits = B.tmp();
      B.line(`${bits} = fptosi double ${value.name} to i32`);
    }
    B.line(`store i32 ${bits}, ptr ${ptr}${this.fieldAliasAttachment(ptr)}`);
  }

  // ── bindings ────────────────────────────────────────────────────────────

  /** A binding's storage: a module global, a plain local slot, or a boxed
   * local (the slot holds the capture BOX; access goes through it). */
  matchBytesLoopVersion(
    s: IrStmt & { kind: "for" | "while" },
    counted: IntegerCountedForLoop | null,
    paired: IntegerPairedForLoop | null = null,
  ): ReturnType<typeof matchBytesLoopVersion> {
    const fn = LOOPS.of(this).bytesLoopFunction;
    if (!fn) return null;
    LOOPS.of(this).bytesLoopEntries ??= findInitializedByteLoopBindings(fn);
    const initialized = LOOPS.of(this).bytesLoopEntries!.get(s);
    if (!initialized) return null;
    const invariantGlobals = new Set(this.stableGlobals);
    for (const global of this.initializerBindings.get(fn.name) ?? [])
      invariantGlobals.add(global.id);
    return matchBytesLoopVersion(
      s,
      counted,
      {
        locals: this.currentLocals,
        invariantGlobals,
        captured: this.captureIds,
        ranges: this.integerRanges,
        initialized,
        proven: this.bytesBounds,
        workers: this.mod.workers === true,
        owned: this.bytesOwned,
        scalarStrings: new Set(this.stringSlices.keys()),
      },
      paired,
    );
  }

  /** The alias tag of a whole-slot load of a binding (module globals only). */
  slotAlias(id: string): string {
    const binding = this.binding(id);
    return binding.kind === "global" ? globalSlotAlias(this, id, binding.type.kind) : "";
  }

  binding(id: string): {
    kind: "global" | "local" | "boxed";
    slot: string;
    type: IrType;
    local?: IrLocal;
  } {
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
    return {
      kind: "global",
      slot: this.privateGlobalSlots.get(id) ?? `@${mangleGlobal(id)}`,
      type: g,
    };
  }

  emitDebugLocal(local: IrLocal, slot: string, arg = 0, captured = false): void {
    const debug = this.debug?.local(local, this.debugScope, arg, captured);
    if (!debug) return;
    this.declare("declare void @llvm.dbg.declare(metadata, metadata, metadata)");
    this.B.entryAllocas.push(
      `call void @llvm.dbg.declare(metadata ptr ${slot}, metadata ${debug.variable}, metadata ${debug.expression}), !dbg ${debug.location}`,
    );
  }

  /** Loads a boxed binding's box pointer out of its slot. */
  loadBox(slot: string): string {
    const b = this.B.tmp();
    this.B.line(`${b} = load ptr, ptr ${slot}`);
    return b;
  }

  /** The function a call through `callee` is known to reach (a literal
   * closure, or a binding the constant-callback census resolves) and the
   * entry it calls directly. Async and generator functions stay indirect. */
  knownCallbackTarget(callee: IrExpr): { known: IrFunction; direct: string } | undefined {
    const knownName =
      callee.kind === "closure"
        ? callee.fnName
        : callee.kind === "varRef"
          ? this.currentConstantCallbacks.get(callee.localId)
          : undefined;
    const known = knownName ? this.fnByName.get(knownName) : undefined;
    if (!known || known.async || known.generator) return undefined;
    if (known.captures === undefined) {
      this.fnValues.add(known.name);
      return { known, direct: `@${mangleWrapper(known.name)}` };
    }
    return { known, direct: `@${this.callTarget(known.name)}` };
  }

  /** The payload slot of a capture box (ScrBox.slot, field 5). */
  boxSlot(box: string): string {
    const slot = this.B.tmp();
    this.B.line(`${slot} = getelementptr inbounds %ScrBox, ptr ${box}, i32 0, i32 5`);
    return slot;
  }

  boxGet(box: string, t: IrType): string {
    const B = this.B;
    const acc = boxAccess(t);
    const r = B.tmp();
    // Scalar payloads are read in place (scr_box_get_f64/bool are a
    // memcpy and a nonzero test of the same slot), so LLVM can keep a
    // captured number in a register across a loop of calls. They have an
    // alias category of their own: every other access to a box's payload
    // is untagged or a runtime call.
    if (acc === "f64") {
      B.line(
        `${r} = load double, ptr ${this.boxSlot(box)}${this.memoryAliasAttachment("box:scalar")}`,
      );
    } else if (acc === "bool") {
      const raw = B.tmp();
      B.line(
        `${raw} = load i64, ptr ${this.boxSlot(box)}${this.memoryAliasAttachment("box:scalar")}`,
      );
      B.line(`${r} = icmp ne i64 ${raw}, 0`);
    } else {
      this.declare(`declare ptr @scr_box_get_ref(ptr)`);
      B.line(`${r} = call ptr @scr_box_get_ref(ptr ${box})`); // returns +1
    }
    return r;
  }

  /** scr_box_set_* — the ref form takes ownership of the passed value. */
  boxSet(box: string, t: IrType, value: string): void {
    const B = this.B;
    const acc = boxAccess(t);
    if (acc === "f64") {
      B.line(
        `store double ${value}, ptr ${this.boxSlot(box)}${this.memoryAliasAttachment("box:scalar")}`,
      );
    } else if (acc === "bool") {
      const raw = B.tmp();
      B.line(`${raw} = zext i1 ${value} to i64`);
      B.line(
        `store i64 ${raw}, ptr ${this.boxSlot(box)}${this.memoryAliasAttachment("box:scalar")}`,
      );
    } else {
      this.declare(`declare void @scr_box_set_ref(ptr, ptr)`);
      B.line(`call void @scr_box_set_ref(ptr ${box}, ptr ${value})`);
    }
  }

  /** The box a new environment captures for `localId` (borrowed). An
   * unchanged parameter gets one box on first capture, holding its own
   * reference to the value; the function scope releases the cached box. */
  captureBox(localId: string): string {
    const cache = this.lazyCaptureBoxes.get(localId);
    if (cache === undefined) return this.loadBox(`%${mangleLocal(localId)}`);
    const B = this.B;
    const type = this.currentLocals.get(localId)!.type;
    const current = this.loadBox(cache);
    const missing = B.tmp();
    B.line(`${missing} = icmp eq ptr ${current}, null`);
    const create = B.newLabel("lazy.box"),
      join = B.newLabel("lazy.box.j");
    B.condBr(missing, create, join);
    B.startBlock(create);
    const stack = this.lazyStackBoxes.get(localId);
    const box = stack ?? B.tmp();
    if (!stack) B.line(`${box} = ${boxNewCall(this.shapeHost, type)}`);
    const value = B.tmp();
    B.line(`${value} = load ${this.llType(type)}, ptr %${mangleLocal(localId)}`);
    this.boxSet(box, type, isRefCounted(type) ? this.retainHeap(value, type) : value);
    B.line(`store ptr ${box}, ptr ${cache}`);
    B.br(join);
    B.startBlock(join);
    return this.loadBox(cache);
  }

  retainBox(box: string): string {
    this.needsRetainBox = true;
    const t = this.B.tmp();
    this.B.line(`${t} = call ptr @sc_retain_box(ptr ${box})`);
    return t;
  }

  /** The initializing write of a scalar TDZ box: mint the one-element
   * array cell holding the value and move it into the ARR-kind box
   * (set_ref releases nothing — the slot was the empty sentinel). */
  tdzScalarInit(box: string, t: IrType, value: string): void {
    const B = this.B;
    const acc = boxAccess(t);
    const cell = B.tmp();
    B.line(`${cell} = ${arrNewCall(this.shapeHost, t, "1")} ; TDZ cell`);
    this.arrPush(cell, acc === "bool" ? "bool" : "f64", value, null);
    this.declare(`declare void @scr_box_set_ref(ptr, ptr)`);
    B.line(`call void @scr_box_set_ref(ptr ${box}, ptr ${cell})`);
  }

  /** The payload a TDZ box holds before its declaration runs, when that is
   * not NULL. A nullable union's value is its arm pointer with NULL as a
   * unit arm (nullable-unions.ts), so a stored `null`/`undefined` would
   * read back as the temporal dead zone; such boxes start at the module's
   * immortal NULLABLE_ABSENT sentinel instead, which no value of the
   * binding can hold and every RC entry point and the collector skip. */
  tdzEmptySentinel(t: IrType): string | null {
    if (!this.nullableUnions.of(t)) return null;
    this.needsNullableAbsent = true;
    this.immortalValues.add(NULLABLE_ABSENT);
    return NULLABLE_ABSENT;
  }

  /** The TDZ-guarded read of a boxed binding: an empty payload slot is
   * the temporal dead zone — throw Node's exact catchable ReferenceError
   * (exprs.ts's varRef guard). Scalars then peek the one-element
   * array cell; ref kinds read the box normally (+1). */
  private checkTdz(box: string, t: IrType, name: string): string {
    const B = this.B;
    const slotp = B.tmp();
    const slotv = B.tmp();
    const empty = B.tmp();
    B.line(`${slotp} = getelementptr inbounds %ScrBox, ptr ${box}, i64 0, i32 5`);
    const sentinel = this.tdzEmptySentinel(t);
    if (sentinel !== null) {
      B.line(`${slotv} = load ptr, ptr ${slotp}`);
      B.line(`${empty} = icmp eq ptr ${slotv}, ${sentinel}`);
    } else {
      B.line(`${slotv} = load i64, ptr ${slotp}`);
      B.line(`${empty} = icmp eq i64 ${slotv}, 0`);
    }
    this.throwIfUninitialized(empty, name);
    return slotv;
  }

  checkGlobalTdz(id: string): void {
    const name = this.tdzGlobals.get(id);
    if (name === undefined) return;
    const B = this.B;
    const value = B.tmp();
    const empty = B.tmp();
    B.line(`${value} = load ptr, ptr @${mangleGlobal(id)}`);
    B.line(`${empty} = icmp eq ptr ${value}, null`);
    this.throwIfUninitialized(empty, name);
  }

  /** Throws the TDZ ReferenceError for `name` unless the i1 `flag` is set. */
  checkInitializedFlag(flag: string, name: string): void {
    const empty = this.B.tmp();
    this.B.line(`${empty} = xor i1 ${flag}, true`);
    this.throwIfUninitialized(empty, name);
  }

  private throwIfUninitialized(empty: string, name: string): void {
    const B = this.B;
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
  }

  tdzBoxRead(box: string, t: IrType, name: string): string {
    const slotv = this.checkTdz(box, t, name);
    const B = this.B;
    const acc = boxAccess(t);
    if (acc === "ref") return this.boxGet(box, t);
    // The scalar cell peek: the box keeps the array alive, so no
    // retain/release pair is needed for the copied-out scalar.
    const cell = B.tmp();
    B.line(`${cell} = inttoptr i64 ${slotv} to ptr`);
    const accTy = acc === "bool" ? "i1" : "double";
    this.declare(
      `declare ${acc === "bool" ? "zeroext i1" : accTy} @scr_arr_get_${acc}(ptr, double)`,
    );
    const v = B.tmp();
    B.line(`${v} = call ${accTy} @scr_arr_get_${acc}(ptr ${cell}, double ${f64Lit(0)})`);
    return v;
  }

  /** Declaration stores initialize an empty TDZ box. Later stores check
   * it after the RHS and update scalar cells in place. References move in. */
  writeBindingBox(
    box: string,
    local: IrLocal,
    value: string,
    initializes = false,
    borrowed = false,
  ): void {
    if (local.tdz) {
      const first = initializes || !local.mutable;
      const slotv = first ? null : this.checkTdz(box, local.type, local.name);
      const acc = boxAccess(local.type);
      if (acc !== "ref") {
        if (first) this.tdzScalarInit(box, local.type, value);
        else {
          const cell = this.B.tmp();
          this.B.line(`${cell} = inttoptr i64 ${slotv!} to ptr`);
          const ty = acc === "bool" ? "i1" : "double";
          this.declare(
            `declare void @scr_arr_set_${acc}(ptr, double, ${acc === "bool" ? "i1 zeroext" : ty})`,
          );
          this.B.line(
            `call void @scr_arr_set_${acc}(ptr ${cell}, double ${f64Lit(0)}, ${ty} ${value})`,
          );
        }
        return;
      }
    }
    this.boxSet(
      box,
      local.type,
      borrowed && isRefCounted(local.type) ? this.retainHeap(value, local.type) : value,
    );
  }

  // ── functions ───────────────────────────────────────────────────────────

  /** True when `fnName`'s borrowing body lends every reference parameter
   * and returns an owned result: a closure over it then carries that body
   * as its borrowing entry (ScrClosure.fn_borrowed), which callers that
   * keep their arguments alive across the call may enter instead of `fn`. */
  lendsEveryArgument(fnName: string): boolean {
    const fn = this.fnByName.get(fnName);
    if (!fn || fn.async || fn.generator || this.borrowedReturns.has(fnName)) return false;
    if (fn.classCaptures !== undefined || this.implSlotBorrowed(fnName).size > 0) return false;
    const borrowed = this.callLifetimes.borrowed.get(fnName);
    if (!borrowed) return false;
    let any = false;
    for (const [index, param] of fn.params.entries()) {
      if (!isRefCounted(param.type)) continue;
      if (!borrowed.has(index)) return false;
      any = true;
    }
    return any;
  }

  /** The LLVM symbol a direct call or closure enters a function through:
   * async bodies are entered via their emitted spawn wrapper (which runs
   * the fiber eagerly to its first suspension and returns the promise);
   * generator bodies via theirs (which only ALLOCATES the suspended
   * fiber and returns the generator object). */
  callTarget(fnName: string): string {
    const fn = this.fnByName.get(fnName);
    if (fn?.generator !== undefined) return mangleGenSpawn(fnName);
    if (fn?.async === true) return mangleAsyncSpawn(fnName);
    return mangleFunction(fnName);
  }

  /** Queue the current wasm coroutine and suspend it. The runtime decides
   * whether the promise waiter list or the ready FIFO owns the continuation;
   * LLVM keeps all live locals in the coroutine frame. */
  emitWasiSuspend(promise: string | null): void {
    const coro = this.currentCoro;
    if (coro === null)
      throw new InternalCompilerError("llvm emitter bug: wasm suspension outside async body");
    if (promise === null) {
      this.declare(`declare void @scr_wasi_await_hop_prepare(ptr)`);
      this.B.line(`call void @scr_wasi_await_hop_prepare(ptr ${coro.self})`);
    } else {
      this.declare(`declare void @scr_wasi_await_prepare(ptr, ptr)`);
      this.B.line(`call void @scr_wasi_await_prepare(ptr ${coro.self}, ptr ${promise})`);
    }
    this.emitCoroSuspendPrepared();
  }

  /** Awaits in the current body suspend its coroutine: every wasm32 async
   * body, and native stackless async bodies (selectStacklessAsync). */
  get coroAwait(): boolean {
    return this.wasi || this.currentCoro?.kind === "async";
  }

  /** Suspends the current coroutine body at an await of `promise` (null: a
   * single microtask hop, as for a non-promise operand). A native body
   * suspends unless the runtime continues it in place, where a fiber's
   * hop would continue without switching (scr_coro_await_prepare). */
  emitCoroAwait(promise: string | null): void {
    if (this.wasi) {
      this.emitWasiSuspend(promise);
      return;
    }
    const coro = this.currentCoro;
    if (coro === null)
      throw new InternalCompilerError("llvm emitter bug: await suspension outside a coroutine");
    const B = this.B;
    const suspend = B.tmp();
    if (promise === null) {
      this.declare(`declare zeroext i1 @scr_coro_hop_prepare(ptr)`);
      B.line(`${suspend} = call zeroext i1 @scr_coro_hop_prepare(ptr ${coro.self})`);
    } else {
      this.declare(`declare zeroext i1 @scr_coro_await_prepare(ptr, ptr)`);
      B.line(
        `${suspend} = call zeroext i1 @scr_coro_await_prepare(ptr ${coro.self}, ptr ${promise})`,
      );
    }
    const park = B.newLabel("await.suspend");
    const ready = B.newLabel("await.ready");
    B.condBr(suspend, park, ready);
    B.startBlock(park);
    this.emitCoroSuspendPrepared();
    B.br(ready);
    B.startBlock(ready);
  }

  /** The runtime entry extracting an await's result of `kind`. A native
   * coroutine has already suspended until the promise settled, so its
   * extraction takes no further turn. */
  awaitResultFn(kind: "void" | "f64" | "bool" | "str" | "ref"): string {
    return !this.wasi && this.currentCoro?.kind === "async"
      ? `scr_coro_await_${kind}`
      : `scr_await_${kind}`;
  }

  /** A native generator's OUT slot (scr_async.c's ScrGen.out, mirrored by
   * %ScrGenHead and %ScrGenSlot { kind, f64, b, payload, release_fn }). */
  genOutSlot(gen: string): string {
    this.usesGenSlots = true;
    const slot = this.B.tmp();
    this.B.line(`${slot} = getelementptr inbounds %ScrGenHead, ptr ${gen}, i32 0, i32 4`);
    return slot;
  }

  /** A yield on a number or boolean channel: scr_gen_slot_f64/bool inline.
   * Such a body's OUT never holds a reference at a yield (only its final
   * completion can park one), so the slot needs no release first. */
  emitGenSlotStore(slot: string, kind: "f64" | "bool", value: string): void {
    const B = this.B;
    const field = B.tmp();
    if (kind === "f64") {
      B.line(`store i32 ${SCR_EXC_F64}, ptr ${slot}`);
      B.line(`${field} = getelementptr inbounds %ScrGenSlot, ptr ${slot}, i32 0, i32 1`);
      B.line(`store double ${value}, ptr ${field}`);
    } else {
      const byte = B.tmp();
      B.line(`store i32 ${SCR_EXC_BOOL}, ptr ${slot}`);
      B.line(`${field} = getelementptr inbounds %ScrGenSlot, ptr ${slot}, i32 0, i32 2`);
      B.line(`${byte} = zext i1 ${value} to i8`);
      B.line(`store i8 ${byte}, ptr ${field}`);
    }
  }

  /** scr_gen_take_out_f64/bool inline: the slot's value when it holds that
   * kind (otherwise 0 or false), leaving the slot empty. */
  emitGenSlotTake(slot: string, kind: "f64" | "bool"): string {
    const B = this.B;
    const tag = B.tmp(),
      matches = B.tmp(),
      field = B.tmp(),
      raw = B.tmp(),
      out = B.tmp();
    B.line(`${tag} = load i32, ptr ${slot}`);
    B.line(`${matches} = icmp eq i32 ${tag}, ${kind === "f64" ? SCR_EXC_F64 : SCR_EXC_BOOL}`);
    if (kind === "f64") {
      B.line(`${field} = getelementptr inbounds %ScrGenSlot, ptr ${slot}, i32 0, i32 1`);
      B.line(`${raw} = load double, ptr ${field}`);
      B.line(`${out} = select i1 ${matches}, double ${raw}, double 0.0`);
    } else {
      const bit = B.tmp();
      B.line(`${field} = getelementptr inbounds %ScrGenSlot, ptr ${slot}, i32 0, i32 2`);
      B.line(`${raw} = load i8, ptr ${field}`);
      B.line(`${bit} = trunc i8 ${raw} to i1`);
      B.line(`${out} = select i1 ${matches}, i1 ${bit}, i1 false`);
    }
    B.line(`store i32 0, ptr ${slot}`);
    return out;
  }

  /** Suspend after a target-specific runtime helper already queued the
   * continuation (used by module awaits, which skip the hop when settled). */
  emitCoroSuspendPrepared(): void {
    const coro = this.currentCoro;
    if (coro === null)
      throw new InternalCompilerError("llvm emitter bug: wasm suspension outside async body");
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
  emitWasiFulfill(v: LlValue | null): void {
    return emitWasiFulfill(this, v);
  }

  /** Number locals declared as a copy of a capture or of a lazily boxed
   * parameter, at the top of the body. */
  doubleCopies(fn: IrFunction): string[] {
    const copies: string[] = [];
    for (const s of fn.body) {
      if (s.kind !== "varDecl") break;
      if (s.init?.kind !== "varRef" || s.init.type.kind !== "f64") continue;
      const source = s.init.localId;
      if (this.captureIds.has(source) || this.lazyCaptureBoxes.has(source)) copies.push(s.localId);
    }
    return copies;
  }
  emitFunction(fn: IrFunction): string {
    return emitFunction(this, fn);
  }

  /** What this range emitter (chunkEmitter) hands the merging emitter, as
   * plain data a worker process can write: its journal and the sets and
   * flags its functions set. */
  chunkResult(): ChunkResult {
    return {
      entries: this.journal!.entries,
      flags: {
        usesCoroutines: this.usesCoroutines,
        usesTimers: this.usesTimers,
        usesGenSlots: this.usesGenSlots,
        needsUnionNone: this.needsUnionNone,
        needsNullableAbsent: this.needsNullableAbsent,
        needsOom: this.needsOom,
        needsBadTag: this.needsBadTag,
        needsBadKey: this.needsBadKey,
        needsRetainBox: this.needsRetainBox,
      },
      publishedNamesSym: this.publishedNamesSym,
      rcHelpers: this.rcHelpers === null ? [] : [...this.rcHelpers],
      immortalValues: [...this.immortalValues],
      fnValues: [...this.fnValues],
      arraySearchKinds: [...this.arraySearchKinds],
      recordCloneShapes: [...this.recordCloneShapes],
      awaitCallees: [...this.awaitCallees],
      adoptCallees: [...this.adoptCallees],
      directAwaitCallees: [...this.directAwaitCallees],
      inlineAwaitCallees: [...this.inlineAwaitCallees],
    };
  }

  /** Merges a range emitter's result (chunkResult) into this emitter, in
   * the range's order, and answers the rename of the range's text to this
   * emitter's numbered helpers. Ranges merge in function order. */
  mergeChunk(chunk: ChunkResult): (text: string) => string {
    const names = new Map<string, string>();
    const tags = new Map<number, number>();
    // The range's helpers and table entries first, in its order; then the
    // sets and flags, which replayed definitions must find as serial
    // emission left them (a helper set guards the declarations its first
    // request adds).
    replayJournal(this, chunk.entries, names, tags);
    const flags = chunk.flags;
    this.usesCoroutines ||= flags.usesCoroutines;
    this.usesTimers ||= flags.usesTimers;
    this.usesGenSlots ||= flags.usesGenSlots;
    this.needsUnionNone ||= flags.needsUnionNone;
    this.needsNullableAbsent ||= flags.needsNullableAbsent;
    this.needsOom ||= flags.needsOom;
    this.needsBadTag ||= flags.needsBadTag;
    this.needsBadKey ||= flags.needsBadKey;
    this.needsRetainBox ||= flags.needsRetainBox;
    this.publishedNamesSym ??= chunk.publishedNamesSym;
    if (this.rcHelpers !== null) for (const key of chunk.rcHelpers) this.rcHelpers.add(key);
    for (const name of chunk.immortalValues) this.immortalValues.add(name);
    for (const name of chunk.fnValues) this.fnValues.add(name);
    for (const kind of chunk.arraySearchKinds) this.arraySearchKinds.add(kind as ArraySearchKind);
    for (const shapeId of chunk.recordCloneShapes) this.recordCloneShapes.add(shapeId);
    for (const name of chunk.awaitCallees) this.awaitCallees.add(name);
    for (const name of chunk.adoptCallees) this.adoptCallees.add(name);
    for (const name of chunk.directAwaitCallees) this.directAwaitCallees.add(name);
    for (const name of chunk.inlineAwaitCallees) this.inlineAwaitCallees.add(name);
    return renameChunk(names, tags);
  }

  /** Adds a content-named constant a chunk interned. Its symbol is this
   * emitter's own: a digest collision retries in first-use order, which a
   * chunk alone does not know. */
  private addContentEntry<V extends { sym: string }>(
    into: Map<string, V>,
    key: string,
    entry: V,
    prefix: string,
    names: Map<string, string>,
  ): void {
    let own = into.get(key);
    if (own === undefined) {
      own = { ...entry, sym: this.contentSymbol(prefix, key) };
      into.set(key, own);
    }
    if (own.sym !== entry.sym) names.set(entry.sym, own.sym);
  }

  /** Applies a chunk's table entry (EmitJournal.entry) at its place in the
   * chunk's order: a key this emitter lacks is added, numbered after its
   * own entries where the table numbers them, and the chunk's name for it
   * is renamed to this emitter's. */
  applyJournalEntry(
    table: string,
    key: string,
    value: unknown,
    names: Map<string, string>,
    tags: Map<number, number>,
  ): void {
    switch (table) {
      case "decl":
        this.decls.add(key);
        return;
      case "literal":
        this.addContentEntry(
          this.literals,
          key,
          value as { sym: string; len: number },
          "sc_lit_",
          names,
        );
        return;
      case "literalEquality":
        addEntry(this.literalEqualities, key, value as string);
        return;
      case "bigint":
        {
          const entry = value as { sym: string; value: string };
          this.addContentEntry(
            this.bigintLiterals,
            key,
            { sym: entry.sym, value: BigInt(entry.value) },
            "sc_bigint_",
            names,
          );
        }
        return;
      case "cstr":
        this.addContentEntry(
          this.cstrs,
          key,
          value as { sym: string; len: number },
          "sc_cs_",
          names,
        );
        return;
      case "mapOps": {
        let own = this.mapOpsConsts.get(key);
        if (own === undefined) {
          own = this.contentSymbol("sc_map_ops_", key);
          this.mapOpsConsts.set(key, own);
        }
        if (own !== value) names.set(value as string, own);
        return;
      }
      case "methodIdSlot": {
        let own = this.methodIdSlots.get(key);
        if (own === undefined) {
          own = this.contentSymbol("sc_mid_", key);
          this.methodIdSlots.set(key, own);
        }
        if (own !== value) names.set(value as string, own);
        return;
      }
      case "classObj":
        addEntry(this.classObjs, key, value as { nameSym: string; baseNameSym: string | null });
        return;
      case "retainWrapper":
        addEntry(this.nullableUnions.retainWrappers, key, value as string);
        return;
      case "unit":
        return addNumbered(this.unitInstances, key, value as string, "sc_unit_", names);
      case "absent":
        return addNumbered(this.absentInstances, key, value as string, "sc_absent_", names);
      case "retype":
        return addNumbered(this.retypeGuards, key, value as string, "sc_retype_guard_", names);
      case "slots":
        return addNumbered(this.threadSlotsBlocks, key, value as string, "@sc_slots_", names);
      case "regex":
        return addNumberedSymbol(this.regexInstances, key, value as never, "sc_re_", names);
      case "templateStrings":
        return addNumberedSymbol(
          this.templateStringsInstances,
          key,
          value as never,
          "sc_tsa_",
          names,
        );
      case "tag": {
        let own = this.fieldAliasTags.get(key);
        if (own === undefined) {
          own = 2 + this.fieldAliasTags.size * 2;
          this.fieldAliasTags.set(key, own);
        }
        if (own !== value) tags.set(value as number, own);
        return;
      }
      default:
        throw new InternalCompilerError(`llvm emitter bug: no journal table ${table}`);
    }
  }

  /** An emitter for a range of this module's functions: the same facts,
   * empty module-level tables, and a journal of what the range adds. */
  chunkEmitter(): LlEmitter {
    return new LlEmitter(this.mod, { ...this.targetOptions, functionChunks: 1 }, new EmitJournal());
  }

  /** The double-ABI entry of a function with an i32 entry: every caller
   * that is not a direct call (closures, dispatch, adapters, the runtime)
   * enters here. A pending exception passes through to its caller. */
  emitInt32AbiWrapper(fn: IrFunction, symbol: string, abi: Int32Abi): string {
    const lines: string[] = [];
    const params: string[] = [];
    const args: string[] = [];
    fn.params.forEach((param, index) => {
      const type = this.llType(param.type);
      params.push(`${type} %p${index}`);
      if (abi.params[index]) {
        lines.push(`  %a${index} = fptosi double %p${index} to i32`);
        args.push(`i32 %a${index}`);
      } else args.push(`${type} %p${index}`);
    });
    const ret = this.llType(fn.returnType);
    const entry = `@${symbol}${INT32_ABI_SUFFIX}(${args.join(", ")})`;
    if (abi.union) {
      // Box the register pair for every caller of the ordinary ABI.
      const B = new BlockBuilder();
      this.B = B;
      for (const line of lines) B.line(line.trim());
      const pair = B.tmp();
      B.line(`${pair} = call ${SCALAR_UNION_RESULT} ${entry}`);
      B.terminate(`ret ptr ${this.boxScalarUnion(pair, fn.returnType)}`);
      return `define internal ptr @${symbol}(${params.join(", ")}) ${FN_ATTRS} {\n${B.render()}\n}`;
    }
    const call = `call ${abi.result ? "i32" : ret} ${entry}`;
    if (ret === "void") lines.push(`  ${call}`, "  ret void");
    else if (abi.result)
      lines.push(`  %r = ${call}`, `  %d = sitofp i32 %r to double`, `  ret double %d`);
    else lines.push(`  %r = ${call}`, `  ret ${ret} %r`);
    return `define internal ${ret} @${symbol}(${params.join(", ")}) ${FN_ATTRS} {\nentry:\n${lines.join("\n")}\n}`;
  }

  /** The SCALAR_UNION_RESULT pair of a `%ScrUnion` box of `type`. */
  scalarUnionPair(box: string, type: IrType): string {
    const B = this.B;
    const unionId = type.kind === "union" ? type.unionId : "";
    const tag = this.unionTag(box, unionId);
    const payload = B.tmp(),
      bits = B.tmp(),
      partial = B.tmp(),
      pair = B.tmp();
    B.line(`${payload} = getelementptr inbounds %ScrUnion, ptr ${box}, i32 0, i32 5`);
    B.line(`${bits} = load i64, ptr ${payload}`);
    B.line(`${partial} = insertvalue ${SCALAR_UNION_RESULT} poison, i32 ${tag}, 0`);
    B.line(`${pair} = insertvalue ${SCALAR_UNION_RESULT} ${partial}, i64 ${bits}, 1`);
    return pair;
  }

  /** A private stack box holding a SCALAR_UNION_RESULT pair of `type`. */
  stackScalarUnion(pair: string, type: IrType): LlValue {
    const B = this.B;
    const box = B.slot(),
      tagSlot = B.slot(),
      payloadSlot = B.slot();
    B.entryAllocas.push(`${box} = alloca %ScrUnion`);
    B.entryAllocas.push(`${tagSlot} = getelementptr inbounds %ScrUnion, ptr ${box}, i32 0, i32 1`);
    B.entryAllocas.push(
      `${payloadSlot} = getelementptr inbounds %ScrUnion, ptr ${box}, i32 0, i32 5`,
    );
    const tag = B.tmp(),
      bits = B.tmp();
    B.line(`${tag} = extractvalue ${SCALAR_UNION_RESULT} ${pair}, 0`);
    B.line(`${bits} = extractvalue ${SCALAR_UNION_RESULT} ${pair}, 1`);
    B.line(`store i32 ${tag}, ptr ${tagSlot}`);
    B.line(`store i64 ${bits}, ptr ${payloadSlot}`);
    return { name: box, type };
  }

  /** A direct call whose i32 entry returns its scalar union in registers. */
  scalarResultCall(e: IrExpr): boolean {
    return e.kind === "call" && this.int32Abis.get(e.callee)?.union === true;
  }

  /** A fresh heap box (+1) for a SCALAR_UNION_RESULT pair of `type`; the
   * exception dummy (tag -1) answers NULL. */
  boxScalarUnion(pair: string, type: IrType): string {
    const B = this.B;
    const tag = B.tmp(),
      bits = B.tmp();
    B.line(`${tag} = extractvalue ${SCALAR_UNION_RESULT} ${pair}, 0`);
    B.line(`${bits} = extractvalue ${SCALAR_UNION_RESULT} ${pair}, 1`);
    return this.boxScalarUnionBits(tag, bits, type);
  }

  /** A fresh heap box (+1) for an inline union field's value; the ABSENT
   * state reads as the undefined arm. */
  inlineFieldUnion(ptr: string, type: IrType): string {
    const { tag, bits } = loadInlineUnion(this.B, ptr);
    return this.boxScalarUnionBits(tag, bits, type);
  }

  /** boxScalarUnion over a separate tag and payload bits. Unit arms answer
   * their immortal instances whatever the bits. */
  boxScalarUnionBits(tag: string, bits: string, type: IrType): string {
    const B = this.B;
    const unionId = type.kind === "union" ? type.unionId : "";
    const arms = this.unionsById.get(unionId)!.arms;
    const join = B.newLabel("union.box.join"),
      none = B.newLabel("union.box.none");
    const labels = arms.map(() => B.newLabel("union.box.arm"));
    B.terminate(
      `switch i32 ${tag}, label %${none} [ ${labels.map((label, armTag) => `i32 ${armTag}, label %${label}`).join(" ")} ]`,
    );
    const incoming: string[] = [];
    arms.forEach((arm, armTag) => {
      B.startBlock(labels[armTag]!);
      let value: string;
      if (isUnitType(arm)) value = this.unitInstanceRef(unionId, armTag);
      else {
        const payload = B.tmp();
        if (arm.kind === "bool") B.line(`${payload} = trunc i64 ${bits} to i1`);
        else B.line(`${payload} = bitcast i64 ${bits} to double`);
        value = this.unionNewOwned(unionId, armTag, { name: payload, type: arm });
      }
      incoming.push(`[ ${value}, %${B.currentLabel()} ]`);
      B.br(join);
    });
    B.startBlock(none);
    incoming.push(`[ null, %${none} ]`);
    B.br(join);
    B.startBlock(join);
    const box = B.tmp();
    B.line(`${box} = phi ptr ${incoming.join(", ")}`);
    return box;
  }

  /** The i32 bits of a number proven an int32 (a direct call's i32
   * argument or an i32 result): its exact integer when the value carries
   * one, else the conversion the proof makes exact. */
  int32Argument(value: LlValue, expr: IrExpr): string {
    const integer = exactInteger(this, value, expr);
    if (integer && /^-?\d+$/.test(integer.name)) return String(Number(integer.name) | 0);
    if (integer) return narrowInteger(this, integer);
    const bits = this.B.tmp();
    this.B.line(`${bits} = fptosi double ${value.name} to i32`);
    return bits;
  }

  /** A direct call's i32 result as a number, with the i32 as its integer
   * and ToUint32 forms. */
  int32Result(bits: string, type: IrType): LlValue {
    const number = this.B.tmp();
    this.B.line(`${number} = sitofp i32 ${bits} to double`);
    return {
      name: number,
      type,
      uint32: bits,
      integer: { name: bits, type: "i32", signed: true, range: INT32_RANGE },
    };
  }

  /** Keep the ordinary owned ABI for closures, virtual dispatch, generated
   * runtime adapters and library exports. Only direct IR calls, calls of a
   * known closure body and borrowing closure entries (fn_borrowed) select
   * the borrowing body. Ownership of other parameters moves into that body;
   * borrowed parameters are released here on normal and exceptional exits.
   * The pending exception remains for the adapter's caller to handle. */
  /** With `kept`, the virtual adapter of a borrowing slot instead: the
   * slot's parameters stay borrowed, the body's other borrowed ones are
   * released here. */
  emitOwnedCallAdapter(
    fn: IrFunction,
    borrowed: ReadonlySet<number>,
    kept: ReadonlySet<number> = NO_BORROWED,
  ): string {
    const B = new BlockBuilder();
    this.B = B;
    const params = fn.params.map((param, index) => `${this.llType(param.type)} %p${index}`);
    // Lifted bodies receive their closure first (the callValue ABI).
    if (fn.captures !== undefined) params.unshift("ptr %sc_env");
    const ret = this.llType(fn.returnType);
    const call = `call ${ret} @${mangleBorrowedFunction(fn.name)}(${params.join(", ")})`;
    B.line(ret === "void" ? call : `%result = ${call}`);
    // A borrowed result is reachable from the parameters: own it first. A
    // throwing body returns a null dummy, which needs no owner (and string
    // or array retains do not accept NULL).
    let result = "%result";
    if (this.borrowedReturns.has(fn.name)) {
      const slot = B.slot();
      B.entryAllocas.push(`${slot} = alloca ptr`);
      B.line(`store ptr null, ptr ${slot}`);
      const present = B.tmp();
      const own = B.newLabel("result.own");
      const done = B.newLabel("result.done");
      B.line(`${present} = icmp ne ptr %result, null`);
      B.condBr(present, own, done);
      B.startBlock(own);
      B.line(`store ptr ${this.retainFrame("%result", fn.returnType)}, ptr ${slot}`);
      B.br(done);
      B.startBlock(done);
      result = B.tmp();
      B.line(`${result} = load ptr, ptr ${slot}`);
    }
    for (const index of borrowed)
      if (!kept.has(index)) this.releaseFrame(`%p${index}`, fn.params[index]!.type);
    B.terminate(ret === "void" ? "ret void" : `ret ${ret} ${result}`);
    const symbol =
      kept.size > 0 ? `${mangleBorrowedFunction(fn.name)}.virtual` : mangleFunction(fn.name);
    return `define internal ${ret} @${symbol}(${params.join(", ")}) ${FN_ATTRS} {\n${B.render()}\n}`;
  }
  canBorrowCallArgument(value: IrExpr): boolean {
    return canBorrowCallArgument(this, value);
  }

  /** A plain-pointer read of a construction-only field outside any
   * constructor (ImmutableFields). */
  immutableRead(e: ExprOf<"fieldGet" | "recordGet">): boolean {
    if (this.inConstructor || this.immutableFields === null) return false;
    const t = e.type.kind;
    if (t !== "object" && t !== "record" && t !== "array" && t !== "string") return false;
    return e.kind === "fieldGet"
      ? this.immutableFields.classField(e.className, e.field)
      : this.immutableFields.recordField(e.shapeId, e.field);
  }

  /** A projection read whose locations nothing writes while a borrowed
   * read of it is in use (ReferenceWrites), given the writes of that
   * extent. The root binding itself must stay alive across it too, which
   * its own location (`l:`, `g:`, `bx`) covers. */
  unwrittenRead(e: IrExpr, writes: Writes): boolean {
    const rw = this.referenceWrites;
    if (rw === null) return false;
    const keys = rw.readKeys(e, (call) => this.borrowedReturnKeys(call.callee));
    return keys !== null && !rw.conflicts(keys, writes);
  }

  /** A stable binding initialized by a projection can borrow it when the
   * rest of its block (its whole lifetime) writes none of the projection's
   * locations: the source edge then keeps the value alive, and uses that
   * escape still retain their own copies. */
  unwrittenAlias(s: IrStmt & { kind: "varDecl" }): boolean {
    const cursor = this.stmtCursor;
    const rw = this.referenceWrites;
    if (rw === null || s.init === null || cursor === null || cursor.stmts[cursor.index] !== s)
      return false;
    if (
      !this.plainReference(s.init.type) ||
      !this.canBorrowReceiver(s.init) ||
      !this.unownedWalk(s.init)
    )
      return false;
    const writes = rw.union([rw.expr(s.init), rw.stmts(cursor.stmts.slice(cursor.index + 1))]);
    return this.unwrittenRead(s.init, writes);
  }

  /** An optional element read into a projection-only local can borrow the
   * element when the rest of the block writes no array element and none of
   * the locations keeping the array alive (which must itself be read
   * without a frame owner). */
  unwrittenLocalArrayRead(s: IrStmt & { kind: "varDecl" }, read: LocalArrayRead): boolean {
    const cursor = this.stmtCursor;
    const rw = this.referenceWrites;
    if (rw === null || s.init === null || cursor === null || cursor.stmts[cursor.index] !== s)
      return false;
    if (!this.unownedWalk(read.array)) return false;
    const keys = rw.readKeys(read.array);
    if (keys === null || rw.expr(read.index) !== null) return false;
    const writes = rw.union([rw.expr(s.init), rw.stmts(cursor.stmts.slice(cursor.index + 1))]);
    return !rw.conflicts(["a", ...keys], writes);
  }

  /** An optional element read passed to a projection-only parameter can
   * borrow the element when the callee and later arguments (`writes`)
   * write no array element and nothing keeping the array alive. */
  unwrittenCallArrayRead(read: LocalArrayRead, writes: Writes): boolean {
    const rw = this.referenceWrites;
    if (rw === null) return false;
    const keys = rw.readKeys(read.array);
    if (keys === null || rw.expr(read.index) !== null) return false;
    return !rw.conflicts(["a", ...keys], writes);
  }

  /** `return p` of a promise inside try regions of an async function. JS
   * completes the return first: p is evaluated, every crossed finally runs,
   * and only then does the function's promise adopt p's settlement (a then
   * job, then p's reaction). So the promise parks in a slot through the
   * finally copies, like any pending return value, and the adopting await
   * runs afterwards with no handler in scope: a rejection settles the
   * function's promise instead of reaching its own catch clauses. */
  emitAdoptingReturn(s: IrStmt & { kind: "return" }, adopted: ExprOf<"awaitExpr">): void {
    const B = this.B;
    const promise = this.emitExpr(adopted.value);
    this.toFrame(promise);
    const slot = B.slot();
    B.entryAllocas.push(`${slot} = alloca ptr ; adopted return promise`);
    B.line(`store ptr ${promise.name}, ptr ${slot}`);
    const parked: LlScopeEntry = { slot, type: adopted.value.type };
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
      this.scopes.push([parked]);
      this.emitBlock(fin.body);
      this.scopes.pop();
    }
    if (!B.isTerminated()) {
      this.releaseForJump(0, 0);
      // Nothing of the body is live any more except the parked promise,
      // whose scope releases it on either exit of the await.
      this.frames = [[]];
      this.scopes = [[parked]];
      this.finallyStack = [];
      this.tryStack = [];
      const loaded = B.tmp();
      B.line(`${loaded} = load ptr, ptr ${slot}`);
      this.adoptedOperand = { name: loaded, type: adopted.value.type };
      const v = this.emitExpr(s.value!);
      if (this.adoptedOperand !== null)
        throw new InternalCompilerError("llvm emitter bug: adopted return promise was not awaited");
      if (this.currentCoro !== null) this.toHeap(v);
      else this.toFrame(v);
      this.releaseForJump(0, 0);
      if (!B.isTerminated()) {
        if (this.currentCoro !== null) {
          this.emitWasiFulfill(v);
          B.terminate(`br label %${this.currentCoro.finalLabel}`);
        } else if (s.value!.type.kind === "void") B.terminate("ret void");
        else B.terminate(`ret ${this.llType(s.value!.type)} ${v.name}`);
      }
    }
    this.frames = savedFrames;
    this.scopes = savedScopes;
    this.finallyStack = savedFinally;
    this.tryStack = savedTry;
  }

  /** An async generator completing without a further turn: its request
   * settles as the body returns (scr_async_gen_hop_done). */
  emitAsyncGenSettled(): void {
    this.declare(`declare void @scr_async_gen_hop_done()`);
    this.B.line(`call void @scr_async_gen_hop_done()`);
  }

  /** Owned-binding reads that take over the binding's reference, by read
   * node (the binding's slot). */
  readonly lastUseMoves = new Map<IrExpr, string>();
  /** How often each varRef node object occurs in the current function:
   * lowering may share one node between several reads, and a move keyed by
   * node identity must fire for exactly one of them. */
  varRefCounts: Map<IrExpr, number> | null = null;
  currentFunctionBody: IrStmt[] = [];

  private varRefCount(e: IrExpr): number {
    if (this.varRefCounts === null) {
      const counts = new Map<IrExpr, number>();
      everyStmtList(this.currentFunctionBody, {
        stmt: () => true,
        expr: (node) => {
          if (node.kind === "varRef") counts.set(node, (counts.get(node) ?? 0) + 1);
          return true;
        },
      });
      this.varRefCounts = counts;
    }
    return this.varRefCounts.get(e) ?? 0;
  }

  /** Moves need plain slots that nothing else reads behind the binding's
   * back: no debugger view, no coroutine frame, no borrowed (+0) return. */
  /** Whether the program reads event-loop utilization (perf.loopStart /
   * perf.idleTime): main then marks the loop's start before running it. */
  private loopMetricsRead: boolean | undefined;
  readsLoopMetrics(): boolean {
    if (this.loopMetricsRead !== undefined) return this.loopMetricsRead;
    const visitor = {
      expr: (e: IrExpr): boolean =>
        !(e.kind === "libCall" && (e.fn === "perf.loopStart" || e.fn === "perf.idleTime")),
      stmt: (): boolean => true,
    };
    this.loopMetricsRead = !this.mod.functions.every((fn) => everyStmtList(fn.body, visitor));
    return this.loopMetricsRead;
  }

  private lastUseMovesAllowed(): boolean {
    return (
      this.debug === null &&
      !this.currentBorrowedReturn &&
      this.currentCoro === null &&
      this.currentGenerator === null
    );
  }

  /** An owned local declared at the statement cursor whose last statement
   * reads it once (lastUseRead): that read moves the reference. */
  noteLastUseMove(s: IrStmt & { kind: "varDecl" }, b: ReturnType<LlEmitter["binding"]>): void {
    const cursor = this.stmtCursor;
    if (
      !this.lastUseMovesAllowed() ||
      cursor === null ||
      cursor.stmts[cursor.index] !== s ||
      b.kind !== "local" ||
      b.local === undefined ||
      b.local.boxed ||
      b.local.tdz ||
      this.integerViews.has(s.localId)
    )
      return;
    const read = lastUseRead(cursor.stmts, cursor.index, s.localId);
    if (read !== null && this.varRefCount(read) === 1) this.lastUseMoves.set(read, b.slot);
  }

  /** An owned parameter whose last statement in the body reads it once:
   * that read moves the reference. Walk locals may borrow from an owned
   * parameter's slot (they need it until the function returns), so bodies
   * with walks keep their parameters, and locals rebound from the
   * parameter count as derived from it. */
  noteParameterMove(fn: IrFunction, localId: string, slot: string): void {
    if (
      !this.lastUseMovesAllowed() ||
      fn.async ||
      fn.generator !== undefined ||
      (this.walkBorrowsByFunction.get(fn.name)?.size ?? 0) > 0 ||
      this.reboundByFunction.get(fn.name)?.has(localId) === true ||
      this.integerViews.has(localId)
    )
      return;
    const read = lastUseRead(fn.body, -1, localId, true);
    if (read !== null && this.varRefCount(read) === 1) this.lastUseMoves.set(read, slot);
  }

  /** Emits the move of a noted last read: the slot is cleared, so scope
   * exits release nothing and the read's owned temp carries the reference. */
  takeLastUseMove(e: IrExpr, slot: string, type: IrType): boolean {
    if (this.lastUseMoves.get(e) !== slot || !typeEquals(type, e.type)) return false;
    this.lastUseMoves.delete(e);
    this.B.line(`store ptr null, ptr ${slot}`);
    return true;
  }

  /** `return x` of a local whose slot is an owned scope entry of the same
   * type: the return can take over the local's reference. */
  movableReturn(
    value: IrExpr | null,
  ): { scope: LlScopeEntry[]; entry: LlScopeEntry; index: number } | null {
    if (value === null || value.kind !== "varRef" || !isRefCounted(value.type)) return null;
    if (this.currentBorrowedReturn || this.currentCoro !== null) return null;
    const binding = this.binding(value.localId);
    if (binding.kind !== "local" || binding.local === undefined || binding.local.boxed) return null;
    if (!typeEquals(binding.type, value.type) || !typeEquals(this.currentReturnType, value.type))
      return null;
    for (const scope of this.scopes) {
      const index = scope.findIndex((entry) => entry.slot === binding.slot);
      if (index < 0) continue;
      const entry = scope[index]!;
      if (entry.boxed || entry.lazy || !typeEquals(entry.type, value.type)) return null;
      return { scope, entry, index };
    }
    return null;
  }

  /** A walk host for a body that may write the heap: each walk must read
   * only locations the whole body (with its callees) never writes;
   * rebinding the walk locals themselves releases nothing. */
  unwrittenWalkHost(fn: IrFunction, host: WalkBorrowHost): WalkBorrowHost {
    return {
      ...host,
      unwritten: (value, candidates) =>
        this.referenceWrites?.unwrittenWalk(fn, value, candidates, (call) =>
          this.borrowedReturnKeys(call.callee),
        ) ?? false,
    };
  }

  /** emitReadReceiver yields a plain pointer for `e` that no statement
   * frame owns, so it can outlive the statement (walk-borrows' walks, from
   * any unboxed plain-pointer binding, plus element reads). */
  private unownedWalk(e: IrExpr): boolean {
    switch (e.kind) {
      case "varRef": {
        const binding = this.binding(e.localId);
        if (binding.kind === "global") return this.plainReference(binding.type);
        return (
          binding.kind === "local" &&
          binding.local !== undefined &&
          !binding.local.boxed &&
          !binding.local.tdz &&
          this.plainReference(binding.local.type) &&
          !this.stringSlices.has(e.localId) &&
          !this.storedSplits.has(e.localId) &&
          !this.localUnionStorage.has(e.localId)
        );
      }
      case "fieldGet":
      case "recordGet":
        return this.borrowsWithoutOwning(e) && this.unownedWalk(e.obj);
      case "unionNarrow":
      case "downcast":
      case "upcast":
        return this.borrowsWithoutOwning(e) && this.unownedWalk(e.value);
      case "unionWrap":
        if (!this.borrowsWithoutOwning(e)) return false;
        return e.value.kind === "unitLit" || this.unownedWalk(e.value);
      case "ternary": {
        const arm = (v: IrExpr): boolean =>
          (v.kind === "libCall" && v.fn === "error.nodeThrow") || this.unownedWalk(v);
        return this.borrowsWithoutOwning(e) && arm(e.then) && arm(e.else_);
      }
      case "call":
        return (
          this.borrowsWithoutOwning(e) &&
          e.args.every((arg) => !isRefCounted(arg.type) || this.unownedWalk(arg))
        );
      case "arrayGet":
        return (
          !this.isStackUnionSource(e) &&
          this.optionalArrayReads.get(e) === null &&
          this.unownedWalk(e.arr)
        );
      case "seqExpr": {
        const guarded = guardedValue(e);
        return guarded !== null && this.unownedWalk(guarded);
      }
      default:
        return false;
    }
  }

  /** Every location a borrowed-return callee's walks can read (its body's
   * field, record and element reads, through nested borrowed returns). */
  private borrowedReturnKeys(callee: string): string[] | null {
    if (!this.borrowedReturns.has(callee)) return null;
    const known = this.borrowedReturnKeyCache.get(callee);
    if (known) return known;
    const rw = this.referenceWrites!;
    const keys = new Set<string>();
    const seen = new Set([callee]);
    const pending = [callee];
    while (pending.length > 0) {
      const fn = this.fnByName.get(pending.pop()!);
      if (!fn) continue;
      everyStmtList(fn.body, {
        stmt: () => true,
        expr: (e) => {
          if (e.kind === "fieldGet") keys.add(rw.fieldKey(e.className, e.field));
          else if (e.kind === "recordGet") {
            keys.add(`r:${e.field}`);
            keys.add("r:*");
          } else if (e.kind === "arrayGet") keys.add("a");
          else if (e.kind === "call" && this.borrowedReturns.has(e.callee) && !seen.has(e.callee)) {
            seen.add(e.callee);
            pending.push(e.callee);
          }
          return true;
        },
      });
    }
    const result = [...keys];
    this.borrowedReturnKeyCache.set(callee, result);
    return result;
  }

  // ── statements ──────────────────────────────────────────────────────────

  emitStmts(stmts: IrStmt[], scoped = false): void {
    const saved = this.stmtCursor;
    const cursor = scoped ? { stmts, index: 0 } : null;
    try {
      for (let i = 0; i < stmts.length; i++) {
        // Statements after a terminator are unreachable (dead code after
        // return/break/continue). Skip them so no dropped SSA definition
        // can leak forward.
        if (this.B.isTerminated()) return;
        if (cursor) cursor.index = i;
        this.stmtCursor = cursor;
        const reserve = reservedArrayLength(stmts, i);
        if (reserve !== null) this.reservedArrayLengths.set(reserve.literal, reserve.hint);
        const deferred = this.deferredPromiseAllLocal(stmts, i);
        if (deferred !== null) {
          this.deferredPromiseAllEntries.set((stmts[i] as { localId: string }).localId, deferred);
          continue;
        }
        this.emitStmt(stmts[i]!);
      }
    } finally {
      this.stmtCursor = saved;
    }
  }

  /** Emits a block in its own lexical scope (refcounted locals released at
   * end). `setup` runs after the
   * scope opens, before the statements — the catch-binding hook: it may
   * emit prelude lines and register entries the scope owns (released on
   * every exit, jumps and unwinds included). */
  emitBlock(stmts: IrStmt[], setup?: (scope: LlScopeEntry[]) => void): void {
    const scope: LlScopeEntry[] = [];
    this.scopes.push(scope);
    setup?.(scope);
    this.emitStmts(stmts, true);
    const ended = endsWithJump(stmts);
    this.scopes.pop();
    if (!ended) this.releaseScope(scope);
  }

  emitStmt(s: IrStmt): void {
    const resume = this.speculationResume?.get(s);
    if (resume && !resume.placed && !this.B.isTerminated()) {
      // The fast copy's failed checks re-execute this statement here.
      resume.placed = true;
      this.B.br(resume.label);
      this.B.startBlock(resume.label);
    }
    if (this.speculation?.writes.has(s)) {
      this.emitSpeculativeWrite(s, this.speculation.resume.get(s));
      return;
    }
    const previous = this.B.debugLocation;
    this.B.debugLocation = this.debug?.location(s.loc, this.debugScope) ?? null;
    const loop =
      s.kind === "while" || s.kind === "doWhile" || s.kind === "for" || s.kind === "forOf";
    if (loop) this.loopDepth++;
    // An int32 kind loop's fast-copy write leaves for its resume point.
    const kindResume = this.int32KindResume;
    this.int32KindResume = this.int32Kinds?.resume.get(s) ?? null;
    try {
      this.emitStmtBody(s);
    } finally {
      this.B.debugLocation = previous;
      this.int32KindResume = kindResume;
      if (loop) this.loopDepth--;
    }
  }
  private emitStmtBody(s: IrStmt): void {
    return emitStmtBody(this, s);
  }
  emitTryCatch(s: IrStmt & { kind: "tryCatch" }): void {
    return emitTryCatch(this, s);
  }
  emitSwitch(s: IrStmt & { kind: "switch" }): void {
    return emitSwitch(this, s);
  }

  /** Evaluates a condition (IR conds are bool-typed) and releases its
   * temps BEFORE the branch — safe because the result is a scalar i1, and
   * required in loop-condition blocks (their temps must not survive into
   * later blocks across the back edge). */
  emitCondition(cond: IrExpr): string {
    const v = this.emitExpr(cond);
    const frame = this.currentFrame();
    this.releaseTemps(frame);
    frame.length = 0;
    return v.name;
  }

  /** Evaluates `expr` in its own statement frame inside an already-open
   * branch and moves the result into `slot`: the chosen value's ownership
   * transfers, every other temp the arm allocated releases inside the
   * branch. The shared core of ternary/logical. */
  emitBranchInto(slot: string, expr: IrExpr, integerSlot?: string): boolean {
    this.frames.push([]);
    const v = this.emitExpr(expr);
    this.toFrame(v);
    this.B.line(`store ${this.llType(expr.type)} ${v.name}, ptr ${slot}`);
    if (integerSlot !== undefined && v.uint32 !== undefined)
      this.B.line(`store i32 ${v.uint32}, ptr ${integerSlot}`);
    this.releaseTemps(this.frames.pop()!);
    return v.uint32 !== undefined;
  }

  // ── expressions ─────────────────────────────────────────────────────────

  emitLiteralExpr(
    e: ExprOf<"numLit" | "boolLit" | "strLit" | "moduleNsRef" | "unitLit" | "varRef">,
  ): LlValue {
    return emitLiteralExpr(this, e);
  }

  emitOperatorExpr(
    e: ExprOf<"bin" | "unary" | "incDec" | "fieldIncDec" | "assignExpr" | "seqExpr">,
  ): LlValue {
    if (e.kind === "seqExpr")
      return this.emitSequence(
        () => emitBorrowedFieldSequence(this, e) ?? emitOperatorExpr(this, e),
      );
    return emitOperatorExpr(this, e);
  }

  /** Saved operands can feed later call arguments. Transfer ownership of a
   * sequence's locals to this expression's frame so they survive those
   * reads and still die on the path that created them, including inside
   * lazy branches. */
  private emitSequence<T>(body: () => T): T {
    this.scopes.push([]);
    const result = body();
    for (const local of this.scopes.pop()!) {
      this.currentFrame().push({
        name: local.slot,
        type: local.type,
        slot: true,
        ...(local.boxed ? { boxed: true } : {}),
      });
    }
    return result;
  }

  /** A statement-position expression whose value is dropped. When a
   * sequence's result only reads an unchanged local (a derived
   * constructor's `super()` evaluates to `this`), its statements still run
   * in place, but the result is neither retained nor released. */
  /** Whether a discarded value can be skipped entirely: a borrowable read
   * with no effect of its own. canBorrowCallArgument also accepts checked
   * projections (a ternary or narrow whose failing arm throws, and the
   * throwing call itself) because a borrowed use still evaluates them;
   * skipping those would drop the throw. */
  private discardableRead(value: IrExpr): boolean {
    if (value.kind === "libCall" || value.kind === "ternary" || value.kind === "unionNarrow")
      return false;
    if (
      (value.kind === "upcast" || value.kind === "downcast" || value.kind === "unionWrap") &&
      !this.discardableRead(value.value)
    )
      return false;
    if (value.kind === "seqExpr") {
      const guarded = guardedValue(value);
      if (guarded === null || !this.discardableRead(guarded)) return false;
    }
    return this.canBorrowCallArgument(value);
  }

  emitDiscarded(e: IrExpr): void {
    // A statement-position yield never reads the resumed value: it stays
    // in the IN slot until the next resume replaces it.
    if (e.kind === "yieldExpr" && e.captureCompletion === undefined && e.type.kind !== "void") {
      this.emitExpr({ ...e, type: VOID });
      return;
    }
    if (
      e.kind === "seqExpr" &&
      isRefCounted(e.result.type) &&
      e.result.kind !== "strLit" &&
      (this.discardableRead(e.result) ||
        // A function-local binding's read has no effect of its own (a
        // compound assignment's result, say); a module binding's read may
        // throw before initialization, so it stays.
        (e.result.kind === "varRef" && this.binding(e.result.localId).kind === "local"))
    ) {
      this.emitSequence(() => {
        for (const s of e.stmts) this.emitStmt(s);
      });
      return;
    }
    this.emitExpr(e);
  }

  emitControlExpr(
    e: ExprOf<
      | "dynDestrCheck"
      | "dynIterN"
      | "toBool"
      | "logical"
      | "ternary"
      | "optChain"
      | "chainRecv"
      | "orDefault"
      | "nullish"
    >,
  ): LlValue {
    return emitControlExpr(this, e);
  }

  emitStringExpr(
    e: ExprOf<
      | "strConcat"
      | "strEq"
      | "strCmp"
      | "toString"
      | "strIntrinsic"
      | "regexLit"
      | "templateStrings"
      | "regexIntrinsic"
    >,
  ): LlValue {
    return emitStringExpr(this, e);
  }
  emitStringSelfConcatAssign(
    localId: string,
    left: IrExpr,
    suffix: IrExpr,
    retainForYield: boolean,
  ): LlValue {
    return emitStringSelfConcatAssign(this, localId, left, suffix, retainForYield);
  }

  /** The code of a one-argument `String.fromCharCode(c)` suffix, emitted, so
   * `s += String.fromCharCode(c)` appends the character without building
   * the one-character string; null for any other suffix. */
  emitSingleCharCode(suffix: IrExpr): LlValue | null {
    if (suffix.kind !== "libCall" || suffix.fn !== "string.fromCharCode") return null;
    const packed = suffix.args[0];
    if (packed?.kind !== "arrayLit" || packed.elems.length !== 1 || packed.spreads?.length)
      return null;
    return this.emitExpr(packed.elems[0]!);
  }

  /**
   * Lower `recv.f = recv.f + suffix` on a plain string field like
   * emitStringSelfConcatAssign does for locals. The field's old value is
   * snapshotted (+1) and the suffix evaluated in JavaScript order; then the
   * field unlinks and releases its CURRENT value, so the snapshot is unique
   * unless a real alias exists and the concat appends in place instead of
   * copying the whole string on every append. Returns false (emitting
   * nothing) for every other store.
   */
  emitFieldSelfConcat(s: Extract<IrStmt, { kind: "fieldSet" | "recordSet" }>): boolean {
    const suffix = matchFieldSelfConcat(s);
    if (!suffix || s.value.kind !== "strConcat") return false;
    let fieldType: IrType | undefined;
    if (s.kind === "fieldSet") {
      if (
        this.inlineUnions.classField(s.className, s.field) ||
        this.classMeta.get(s.className)?.root.def.name === "%Error"
      )
        return false;
      fieldType = classFieldIndex(this.classMetaOf(s.className), s.field).type;
    } else {
      fieldType = this.recordShape(s.shapeId).fields.find((f) => f.name === s.field)?.type;
    }
    if (fieldType?.kind !== "string") return false;
    const B = this.B;
    const obj = this.emitStableReceiver(s.obj, [s.value]);
    const snapshot = this.emitExpr(s.value.left);
    const parts = stringParts(suffix);
    const mixed = parts.length > 1 || numberPart(parts[0]!) !== null;
    const inputs = mixed ? emitConcatInputs(this, parts) : [];
    const right = mixed ? null : this.emitExpr(suffix);
    if (s.kind === "fieldSet") this.emitStoreGuard(obj.name, s);
    else if (this.publishedTypes?.recordGuarded(s.shapeId) === true)
      this.emitPublishedFieldGuard(obj.name, null, s.field);
    const { ptr } =
      s.kind === "fieldSet"
        ? this.classFieldPtr(obj.name, s.className, s.field)
        : this.recordFieldPtr(obj.name, s.shapeId, s.field);
    // Unlink, then release: nothing between here and the store below can
    // run user code or observe the field (the concat only traps on OOM).
    // Only an owned snapshot may survive the field's release.
    const owned = this.ownsSnapshot(snapshot.name);
    if (owned) {
      const old = this.loadField(ptr, fieldType, false);
      this.storeField(ptr, fieldType, "null", false);
      this.releaseHeap(old, fieldType);
    }
    let raw: string;
    if (right === null) {
      raw = emitMixedConcat(this, snapshot.name, inputs);
    } else {
      this.declare(`declare ptr @scr_str_concat(ptr, ptr)`);
      raw = B.tmp();
      B.line(`${raw} = call ptr @scr_str_concat(ptr ${snapshot.name}, ptr ${right.name})`);
    }
    // The +1 result moves straight into the (now empty) field.
    if (owned) this.storeField(ptr, fieldType, raw, false);
    else this.replaceField(ptr, fieldType, false, this.own({ name: raw, type: fieldType }));
    return true;
  }

  /** A snapshot the current statement frames own (+1), or an immortal
   * value: it stays valid after its container releases the same string. */
  private ownsSnapshot(name: string): boolean {
    return (
      this.isImmortal(name) || this.frames.some((f) => f.some((v) => v.name === name && !v.slot))
    );
  }

  /**
   * `a[i] = a[i] + suffix` on a string array (the canonical statement form
   * of `a[i] += suffix`): the old element is snapshotted (+1) and the
   * suffix evaluated in JavaScript order; then, when the slot still holds
   * the snapshot, the array lets go of it (emitDenseSlotUnlink) so the
   * concat can append in place, and the result is stored as usual.
   */
  emitArraySelfConcat(s: Extract<IrStmt, { kind: "arraySet" }>): boolean {
    const value = s.value;
    if (
      value.kind !== "strConcat" ||
      value.type.kind !== "string" ||
      value.left.type.kind !== "string" ||
      value.right.type.kind !== "string" ||
      s.arr.type.kind !== "array" ||
      s.arr.type.elem.kind !== "string" ||
      s.arr.kind !== "varRef" ||
      s.index.kind !== "varRef" ||
      !readsArraySlot(value.left, s.arr.localId, s.index.localId)
    )
      return false;
    const elem = s.arr.type.elem;
    const B = this.B;
    const arr = this.emitStableReceiver(s.arr, [s.index, s.value]);
    const idx = this.emitExpr(s.index);
    const snapshot = this.emitExpr(value.left);
    const parts = stringParts(value.right);
    const mixed = parts.length > 1 || numberPart(parts[0]!) !== null;
    const inputs = mixed ? emitConcatInputs(this, parts) : [];
    const right = mixed ? null : this.emitExpr(value.right);
    this.emitPublishedArrayGuard(arr.name, s.arr.type, 0, idx.name);
    if (this.ownsSnapshot(snapshot.name))
      emitDenseSlotUnlink(
        this,
        arr.name,
        idx,
        s.index,
        snapshot.name,
        this.internLiteral(""),
        elem,
      );
    let raw: string;
    if (right === null) {
      raw = emitMixedConcat(this, snapshot.name, inputs);
    } else {
      this.declare(`declare ptr @scr_str_concat(ptr, ptr)`);
      raw = B.tmp();
      B.line(`${raw} = call ptr @scr_str_concat(ptr ${snapshot.name}, ptr ${right.name})`);
    }
    emitDenseArraySet(this, arr.name, idx, s.index, "ref", elem, raw);
    return true;
  }

  /** `local = local + suffix` when the suffix cannot read or write the
   * local (an unboxed binding is only reachable through this function's own
   * expressions): reading the binding after the suffix gives the value the
   * left side had, so it moves into a consuming concat, and the result takes
   * its place. Null when the general snapshot path is needed. */
  emitMovedSelfConcat(
    localId: string,
    left: IrExpr,
    suffix: IrExpr,
    retainForYield: boolean,
  ): LlValue | null {
    const b = this.binding(localId);
    if (
      retainForYield ||
      b.kind !== "local" ||
      b.local === undefined ||
      b.local.boxed ||
      b.local.tdz ||
      b.type.kind !== "string" ||
      left.kind !== "varRef" ||
      left.localId !== localId ||
      mentionsLocal(suffix, localId)
    )
      return null;
    const parts = stringParts(suffix);
    const mixed = parts.length > 1 || numberPart(parts[0]!) !== null;
    const charCode = mixed ? null : this.emitSingleCharCode(suffix);
    const inputs = mixed ? emitConcatInputs(this, parts) : [];
    // The concat only reads the suffix, which may stay borrowed.
    const right = mixed || charCode !== null ? null : emitStringInputs(this, [suffix])[0]!;
    this.materializeSplitLocal(localId);
    const B = this.B;
    const head = B.tmp();
    B.line(`${head} = load ptr, ptr ${b.slot}`);
    let raw: string;
    if (charCode !== null) {
      this.declare(`declare ptr @scr_str_concat_move_char_code(ptr, double)`);
      raw = B.tmp();
      B.line(
        `${raw} = call ptr @scr_str_concat_move_char_code(ptr ${head}, double ${charCode.name})`,
      );
    } else if (right === null) {
      raw = emitMixedConcat(this, head, inputs, true);
    } else {
      this.declare(`declare ptr @scr_str_concat_move(ptr, ptr)`);
      raw = B.tmp();
      B.line(`${raw} = call ptr @scr_str_concat_move(ptr ${head}, ptr ${right.name})`);
    }
    B.line(`store ptr ${raw}, ptr ${b.slot}`);
    return { name: raw, type: left.type }; // moved into the binding
  }

  emitContainerExpr(
    e: ExprOf<
      | "arrayLit"
      | "arrayNewLen"
      | "arrayGet"
      | "arrayHas"
      | "arrayState"
      | "arrIntrinsic"
      | "bytesNew"
      | "bytesIntrinsic"
      | "mapNew"
      | "mapIntrinsic"
      | "setIntrinsic"
      | "setNew"
    >,
  ): LlValue {
    return emitContainerExpr(this, e);
  }

  emitCallExpr(
    e: ExprOf<
      | "call"
      | "ffiCall"
      | "closure"
      | "callValue"
      | "selfRef"
      | "new"
      | "classRef"
      | "newValue"
      | "instanceOfValue"
      | "promiseVoidWiden"
      | "upcast"
      | "downcast"
      | "instanceOf"
      | "virtualCall"
    >,
  ): LlValue {
    return emitCallExpr(this, e);
  }

  /** A direct async call an enclosing `await` consumes whole: emitted
   * through the callee's await-call entry, yielding the awaited value. */
  emitAwaitedCall(e: ExprOf<"call">, adopt = false): LlValue {
    return emitCallExpr(this, e, adopt ? "adopt" : "await");
  }

  emitRecordExpr(
    e: ExprOf<
      | "fieldGet"
      | "recordGet"
      | "recordLit"
      | "recordClone"
      | "recordKeyGet"
      | "recordOvfKeys"
      | "recordOvfHas"
      | "recordNullProto"
      | "recordHas"
      | "fieldAbsent"
    >,
  ): LlValue {
    return emitRecordExpr(this, e);
  }

  emitDynamicExpr(
    e: ExprOf<
      | "dynFrom"
      | "dynCall"
      | "dynInvoke"
      | "dynArrLit"
      | "dynObjLit"
      | "unionWrap"
      | "unionNarrow"
      | "unionDisc"
      | "unionKeyGet"
      | "unionIsTag"
      | "dynKeyGet"
      | "dynHasKey"
      | "dynScalarEq"
      | "dynTest"
      | "unionEq"
      | "unionFuncEq"
      | "caughtTest"
      | "caughtCheck"
      | "caughtNarrow"
      | "caughtToDyn"
    >,
  ): LlValue {
    return emitDynamicExpr(this, e);
  }

  emitIntrinsicExpr(e: ExprOf<"intrinsic">): LlValue {
    if (e.name === "threads.publish") return this.emitPublish(e);
    if (
      e.name === "region.create" ||
      e.name === "region.enter" ||
      e.name === "region.leave" ||
      e.name === "region.release"
    )
      return this.emitRegionIntrinsic(e);
    if (e.name.startsWith("itable.")) return this.emitInternTableIntrinsic(e);
    if (e.name.startsWith("slots.")) return emitThreadSlotsIntrinsic(this, e);
    return emitIntrinsicExpr(this, e);
  }

  /** The ScrSlots block of the ThreadSlots family `name`. */
  threadSlotsBlock(name: string): string {
    let sym = this.threadSlotsBlocks.get(name);
    if (sym === undefined) {
      sym = `@sc_slots_${this.threadSlotsBlocks.size}`;
      this.threadSlotsBlocks.set(name, sym);
    }
    this.journal?.entry("slots", name, sym);
    return sym;
  }

  /** InternTable's runtime calls (scr_itable.c). Table and entry handles
   * are f64 values carrying pointer bits; entry values are 64-bit slots
   * (double bits, a bool, or a pointer to an immortal value) that the
   * table neither retains nor releases. Lookups and inserts of array keys
   * throw a TypeError for keys longer than a table accepts. */
  private emitInternTableIntrinsic(e: ExprOf<"intrinsic">): LlValue {
    const B = this.B;
    // The runtime copies keys and stores published values without counts,
    // so every operand is borrowed.
    const args = emitBorrowedInputs(this, e.args);
    if (B.isTerminated()) return { name: "", type: e.type };
    const toPtr = (handle: string): string => {
      const bits = B.tmp(),
        ptr = B.tmp();
      B.line(`${bits} = bitcast double ${handle} to i64`);
      B.line(`${ptr} = inttoptr i64 ${bits} to ptr`);
      return ptr;
    };
    const toHandle = (ptr: string): LlValue => {
      const bits = B.tmp(),
        handle = B.tmp();
      B.line(`${bits} = ptrtoint ptr ${ptr} to i64`);
      B.line(`${handle} = bitcast i64 ${bits} to double`);
      return { name: handle, type: e.type };
    };
    const keyCall = (op: "find" | "insert"): string => {
      const kind = e.args[1]!.type.kind;
      const key = kind === "string" ? "str" : kind === "array" ? "arr" : "f64";
      const keyTy = key === "f64" ? "double" : "ptr";
      const value = op === "insert" ? ", i64" : "";
      this.declare(`declare ptr @scr_itable_${op}_${key}(ptr, ${keyTy}${value})`);
      return `@scr_itable_${op}_${key}(ptr ${toPtr(args[0]!.name)}, ${keyTy} ${args[1]!.name}`;
    };
    switch (e.name) {
      case "itable.open": {
        this.declare(`declare ptr @scr_itable_open(ptr, i32)`);
        const kind = B.tmp(),
          table = B.tmp();
        B.line(`${kind} = fptosi double ${args[1]!.name} to i32`);
        B.line(`${table} = call ptr @scr_itable_open(ptr ${args[0]!.name}, i32 ${kind})`);
        return toHandle(table);
      }
      case "itable.find": {
        const call = keyCall("find");
        const entry = B.tmp();
        B.line(`${entry} = call ptr ${call})`);
        // Array keys longer than a table accepts throw a TypeError.
        if (e.args[1]!.type.kind === "array") this.emitPendingCheck();
        return toHandle(entry);
      }
      case "itable.insert": {
        const value = args[2]!;
        const ty = this.llType(value.type);
        let slot = value.name;
        if (ty === "double") {
          slot = B.tmp();
          B.line(`${slot} = bitcast double ${value.name} to i64`);
        } else if (ty === "i1") {
          slot = B.tmp();
          B.line(`${slot} = zext i1 ${value.name} to i64`);
        } else if (ty === "ptr") {
          slot = B.tmp();
          B.line(`${slot} = ptrtoint ptr ${value.name} to i64`);
        } else throw new InternalCompilerError(`llvm emitter bug: itable value of type ${ty}`);
        const call = keyCall("insert");
        const entry = B.tmp();
        B.line(`${entry} = call ptr ${call}, i64 ${slot})`);
        if (e.args[1]!.type.kind === "array") this.emitPendingCheck();
        return toHandle(entry);
      }
      case "itable.value": {
        // The handle's bits reach the address through memory: at -O0, x86
        // FastISel folds inttoptr(bitcast double) into the load's address
        // without moving the value out of its XMM register. Optimized
        // builds turn the stack round trip back into one register move.
        const carrier = B.slot();
        B.entryAllocas.push(`${carrier} = alloca double`);
        B.line(`store double ${args[0]!.name}, ptr ${carrier}`);
        const bits = B.tmp(),
          entry = B.tmp();
        B.line(`${bits} = load i64, ptr ${carrier}`);
        B.line(`${entry} = inttoptr i64 ${bits} to ptr`);
        const slot = B.tmp();
        B.line(`${slot} = load i64, ptr ${entry}, align 8`);
        const ty = this.llType(e.type);
        const result = B.tmp();
        if (ty === "double") B.line(`${result} = bitcast i64 ${slot} to double`);
        else if (ty === "i1") B.line(`${result} = trunc i64 ${slot} to i1`);
        else if (ty === "ptr") B.line(`${result} = inttoptr i64 ${slot} to ptr`);
        else throw new InternalCompilerError(`llvm emitter bug: itable value of type ${ty}`);
        // Stored values are immortal: owning one adds no count.
        return isRefCounted(e.type)
          ? this.own({ name: result, type: e.type })
          : { name: result, type: e.type };
      }
      case "itable.size": {
        this.declare(`declare double @scr_itable_size(ptr)`);
        const size = B.tmp();
        B.line(`${size} = call double @scr_itable_size(ptr ${toPtr(args[0]!.name)})`);
        return { name: size, type: e.type };
      }
      default:
        throw new InternalCompilerError(`llvm emitter bug: unknown intrinsic ${e.name}`);
    }
  }

  /** Lifetime regions in modules with lifetimeRegions (llvm/regions.ts).
   * Created with the class graph; null elsewhere. */
  regions: LifetimeRegions | null = null;

  /** LifetimeRegion's runtime calls: create answers the region id, enter
   * and leave bracket run(), release condemns. */
  private emitRegionIntrinsic(e: ExprOf<"intrinsic">): LlValue {
    if (this.regions === null)
      throw new InternalCompilerError(`llvm emitter bug: ${e.name} without lifetimeRegions`);
    const args = e.args.map((a) => this.emitExpr(a));
    if (this.B.isTerminated()) return { name: "", type: e.type };
    switch (e.name) {
      case "region.create": {
        this.declare(`declare double @scr_region_create(ptr)`);
        const id = this.B.tmp();
        this.B.line(`${id} = call double @scr_region_create(ptr ${REGION_TYPES})`);
        return { name: id, type: e.type };
      }
      case "region.enter":
        this.declare(`declare void @scr_region_enter(double)`);
        this.B.line(`call void @scr_region_enter(double ${args[0]!.name})`);
        break;
      case "region.leave":
        this.declare(`declare void @scr_region_leave()`);
        this.B.line(`call void @scr_region_leave()`);
        break;
      default:
        this.declare(`declare void @scr_region_release(double)`);
        this.B.line(`call void @scr_region_release(double ${args[0]!.name})`);
    }
    return { name: "", type: e.type };
  }

  publishWalkersCache: PublishWalkers | null = null;

  /** Per-type publication walkers, created on the first publish. */
  get publishWalkers(): PublishWalkers {
    if (this.publishWalkersCache !== null) return this.publishWalkersCache;
    const byPre = [...this.classMeta.values()].sort((a, b) => a.pre - b.pre);
    this.publishWalkersCache = new PublishWalkers({
      // Journal hooks only on emitters that can emit ranges (chunk
      // emitters, and emitters whose workers take a journal after the
      // fork), so the host's optional calls cost nothing otherwise.
      journalAllocated: !this.journaled
        ? undefined
        : (name, op, args) => this.journal?.allocated(name, op, args),
      journalBuilt: !this.journaled ? undefined : () => this.journal?.built(),
      journalOpened: !this.journaled ? undefined : (op) => this.journal?.opened(op),
      journalUsed: !this.journaled
        ? undefined
        : (name, op, args) => this.journal?.used(name, op, args),
      journalEntry: !this.journaled
        ? undefined
        : (table, key, value) => this.journal?.entry(table, key, value),
      declare: (decl) => this.declare(decl),
      cstr: (text) => this.cstr(text),
      sizeType: this.sizeType,
      rcAudit: this.shapeHost.objectAudit !== false,
      tracedShapes: this.tracedShapes,
      unionsById: this.unionsById,
      recordsById: this.recordsById,
      inlineUnions: this.inlineUnions,
      nullableArm: (t) => {
        const nullable = this.nullableUnions.of(t);
        return nullable?.repr === "single" ? nullable.arm : null;
      },
      shapeUnion: (t) => this.nullableUnions.of(t)?.repr === "shapes",
      fieldBase: (shapeId) => this.nullableUnions.fieldBase(shapeId),
      classInfo: (className) => {
        const meta = this.classMetaOf(className);
        return {
          def: meta.def,
          hierarchy: meta.hierarchy,
          pre: meta.pre,
          post: meta.post,
          runtimeRooted: meta.root.def.runtime === true,
          idInRc: meta.idInRc,
          compact: meta.compact,
          // Inline scalar-union fields are plain bits: nothing to push.
          fields: meta.def.fields.flatMap((f) =>
            this.inlineUnions.classField(className, f.name)
              ? []
              : [
                  {
                    name: f.name,
                    index: classFieldIndex(meta, f.name, "compressed").index,
                    type: this.nullableFields.storageType(className, f.name, f.type),
                    compressed: classFieldIndex(meta, f.name, "compressed").compressed,
                  },
                ],
          ),
        };
      },
      classesInInterval: (pre, post) =>
        byPre.filter((m) => m.pre >= pre && m.pre <= post).map((m) => m.def.name),
    });
    return this.publishWalkersCache;
  }

  /** `publish(value)` (@scriptc/threads): makes the graph immortal and
   * immutable (scr_publish with the static type's walker) and answers the
   * same value. Throws (pending) when a dyn part is unpublishable. */
  private emitPublish(e: ExprOf<"intrinsic">): LlValue {
    const value = this.emitExpr(e.args[0]!);
    if (this.B.isTerminated()) return value;
    const lines = this.publishWalkers.emitPublish(value.name, value.type, e.loc);
    if (lines.length > 0) {
      for (const line of lines) this.B.line(line.trimStart());
      // A refusal unwinds while the operand temp still owns its reference.
      this.emitPendingCheck();
    }
    // The result IS the operand: ownership moves to the result temp.
    if (!isRefCounted(value.type)) return { name: value.name, type: e.type };
    this.toFrame(value);
    return this.own({ name: value.name, type: e.type });
  }

  /** Branches on "`obj` is published" (rc == SIZE_MAX, or a count of
   * UINT32_MAX in the low half for `count` i32: classes.ts
   * LlClassMeta.idInRc, or the top bit of a compact header word for
   * "compact": classes.ts COMPACT_PUBLISHED); leaves the builder in the cold
   * block and answers the continuation label. */
  private emitPublishedTest(obj: string, count: "i32" | "i64" | "compact" = this.sizeType): string {
    const B = this.B;
    const rc = B.tmp(),
      frozen = B.tmp(),
      expected = B.tmp();
    if (count === "compact") {
      B.line(`${rc} = load i32, ptr ${obj}`);
      B.line(`${frozen} = icmp slt i32 ${rc}, 0`);
    } else {
      B.line(`${rc} = load ${count}, ptr ${obj}`);
      B.line(`${frozen} = icmp eq ${count} ${rc}, -1`);
    }
    this.declare(`declare i1 @llvm.expect.i1(i1, i1)`);
    B.line(`${expected} = call i1 @llvm.expect.i1(i1 ${frozen}, i1 false)`);
    const cold = B.newLabel("pub.frozen"),
      ok = B.newLabel("pub.ok");
    B.condBr(expected, cold, ok);
    B.startBlock(cold);
    return ok;
  }

  /** Branches on "the array `arr` is frozen" (SCR_ARR_FROZEN in its storage
   * flags, scr_array.h), or published too when `published`; like
   * emitPublishedTest, leaves the builder in the cold block and answers the
   * continuation label. */
  private emitFrozenArrayTest(arr: string, published: boolean): string {
    const B = this.B;
    const sparep = B.tmp(),
      spare = B.tmp(),
      bit = B.tmp();
    let frozen = B.tmp();
    B.line(
      `${sparep} = getelementptr inbounds %ScrArr, ptr ${arr}, i32 0, i32 ${SCR_ARR_FIELD.spare}`,
    );
    B.line(`${spare} = load i16, ptr ${sparep}`);
    B.line(`${bit} = and i16 ${spare}, ${SCR_ARR_FROZEN}`);
    B.line(`${frozen} = icmp ne i16 ${bit}, 0`);
    if (published) {
      const rc = B.tmp(),
        immortal = B.tmp(),
        either = B.tmp();
      B.line(`${rc} = load ${this.sizeType}, ptr ${arr}`);
      B.line(`${immortal} = icmp eq ${this.sizeType} ${rc}, -1`);
      B.line(`${either} = or i1 ${frozen}, ${immortal}`);
      frozen = either;
    }
    this.declare(`declare i1 @llvm.expect.i1(i1, i1)`);
    const expected = B.tmp();
    B.line(`${expected} = call i1 @llvm.expect.i1(i1 ${frozen}, i1 false)`);
    const cold = B.newLabel("arr.frozen"),
      ok = B.newLabel("arr.ok");
    B.condBr(expected, cold, ok);
    B.startBlock(cold);
    return ok;
  }

  private publishedNamesSym: string | null = null;

  /** The class-name table the hierarchy field guards index by preorder. */
  publishedClassNamesDefs(): string[] {
    if (this.publishedNamesSym === null) return [];
    const metas = [...this.classMeta.values()];
    const size = metas.reduce((max, m) => Math.max(max, m.pre + 1), 0);
    const names: string[] = new Array<string>(size).fill("ptr null");
    for (const m of metas) names[m.pre] = `ptr ${this.cstr(m.def.jsName ?? m.def.name)}`;
    return [
      `${this.publishedNamesSym} = internal constant [${size} x ptr] [ ${names.join(", ")} ]`,
      ``,
    ];
  }

  /** The frozen-object guard of a class field store, unless the store
   * provably targets a still-private `this` (PublishedTypes.privateStores). */
  emitStoreGuard(obj: string, s: Extract<IrStmt, { kind: "fieldSet" }>): void {
    if (this.publishedTypes?.privateStores.has(s) === true) return;
    this.emitPublishedFieldGuard(obj, s.className, s.field);
  }

  /** The frozen-object guard of a class field or record field store:
   * Node's "Cannot assign to read only property" TypeError when the target
   * is published. `className` null means a record (`#<Object>`). */
  emitPublishedFieldGuard(obj: string, className: string | null, field: string): void {
    const published = this.publishedTypes;
    if (published === null) return;
    if (className !== null && !published.classGuarded(className)) return;
    const B = this.B;
    const meta = className === null ? undefined : this.classMeta.get(className);
    const ok = this.emitPublishedTest(
      obj,
      meta?.compact === true ? "compact" : meta?.idInRc === true ? "i32" : this.sizeType,
    );
    let owner: string;
    if (meta === undefined) owner = this.cstr("Object");
    else if (!meta.hierarchy) owner = this.cstr(meta.def.jsName ?? meta.def.name);
    else {
      // The DYNAMIC class names the object, as in Node.
      this.publishedNamesSym ??= "@sc_pub_class_names";
      const pre = this.loadVtPre(obj, meta.def.name),
        slot = B.tmp(),
        name = B.tmp();
      B.line(
        `${slot} = getelementptr inbounds ptr, ptr ${this.publishedNamesSym}, ${this.sizeType} ${pre}`,
      );
      B.line(`${name} = load ptr, ptr ${slot}`);
      owner = name;
    }
    this.declare(`declare void @scr_throw_published_field(ptr, ptr)`);
    B.line(`call void @scr_throw_published_field(ptr ${this.cstr(field)}, ptr ${owner})`);
    this.emitUnwind();
    B.startBlock(ok);
  }

  /** The frozen-array guard (scr_throw_published_array's ops): `index` and
   * `count` are doubles (the written index, the argument count). */
  emitPublishedArrayGuard(
    arr: string,
    arrType: IrType,
    op: number,
    index = f64Lit(0),
    count = f64Lit(0),
    third: string | null = null,
  ): void {
    const published = this.publishedTypes;
    if (published?.containerGuarded(arrType) !== true) return;
    const B = this.B;
    const guards = published.arrayGuards(arrType);
    const ok = guards.frozen
      ? this.emitFrozenArrayTest(arr, guards.published)
      : this.emitPublishedTest(arr);
    const threw = B.tmp();
    if (third === null) {
      this.declare(`declare zeroext i1 @scr_throw_published_array(i32, ptr, double, double)`);
      B.line(
        `${threw} = call zeroext i1 @scr_throw_published_array(i32 ${op}, ptr ${arr}, double ${index}, double ${count})`,
      );
    } else {
      this.declare(
        `declare zeroext i1 @scr_throw_published_array_range(i32, ptr, double, double, double)`,
      );
      B.line(
        `${threw} = call zeroext i1 @scr_throw_published_array_range(i32 ${op}, ptr ${arr}, double ${index}, double ${count}, double ${third})`,
      );
    }
    const unwind = B.newLabel("pub.throw");
    B.condBr(threw, unwind, ok);
    B.startBlock(unwind);
    this.emitUnwind();
    B.startBlock(ok);
  }

  /** The published Map/Set guard: "Cannot modify a published Map/Set". */
  emitPublishedCollectionGuard(m: string, t: IrType): void {
    if (this.publishedTypes?.containerGuarded(t) !== true) return;
    const B = this.B;
    const ok = this.emitPublishedTest(m);
    this.declare(`declare void @scr_throw_published_collection(i1 zeroext)`);
    B.line(`call void @scr_throw_published_collection(i1 ${t.kind === "set" ? "true" : "false"})`);
    this.emitUnwind();
    B.startBlock(ok);
  }

  emitSerializationExpr(e: ExprOf<"jsonStringify" | "dynCheck">): LlValue {
    return emitSerializationExpr(this, e);
  }

  emitAsyncExpr(
    e: ExprOf<
      | "yieldExpr"
      | "genResume"
      | "awaitExpr"
      | "awaitUnionExpr"
      | "newPromise"
      | "promiseWithResolvers"
    >,
  ): LlValue {
    return emitAsyncExpr(this, e);
  }
  emitReadReceiver(e: IrExpr): LlValue {
    return emitReadReceiver(this, e);
  }

  /** The frame slot a reassigned stack-object local keeps for its value. */
  stackObjectSlot(localId: string, type: IrType): string {
    let slot = this.stackObjectSlots.get(localId);
    if (slot === undefined) {
      slot = this.B.slot();
      this.B.entryAllocas.push(`${slot} = alloca ${stackObjectStruct(type)}, align 8`);
      this.stackObjectSlots.set(localId, slot);
    }
    return slot;
  }
  canStackReceiver(e: IrExpr): boolean {
    return canStackReceiver(this, e);
  }
  isStackUnionSource(e: IrExpr): boolean {
    return isStackUnionSource(this, e);
  }

  /** A read of a record or class field that stores its scalar union
   * inline. */
  inlineFieldGet(e: IrExpr): boolean {
    if (e.kind === "recordGet") return this.recordFieldInline(e.shapeId, e.field);
    return e.kind === "fieldGet" && this.inlineUnions.classField(e.className, e.field);
  }

  /** The nullable-pointer representation behind a union-typed class field
   * read, or null for every other expression. */
  nullableFieldGet(e: IrExpr): NullableRefField | null {
    if (e.kind !== "fieldGet" || e.type.kind !== "union") return null;
    return this.nullableFields.get(e.className, e.field);
  }

  /** A union operand consumed only by a projection (tag test, payload
   * extraction, arm compare, truthiness). A nullable-pointer field read
   * becomes a private stack box whose payload is borrowed from the field:
   * the consumer must finish before any later expression can store to the
   * field, and must never retain, release, or store the box. Every other
   * operand takes the ordinary borrowed-receiver path. */
  emitUnionProjection(e: IrExpr): LlValue {
    const nullable = this.nullableFieldGet(e);
    if (!nullable || e.kind !== "fieldGet") return this.emitReadReceiver(e);
    const receiver = this.emitReadReceiver(e.obj);
    const { ptr } = this.classFieldPtr(receiver.name, e.className, e.field, "compressed");
    const p = this.loadRef(ptr);
    return { name: this.stackNullableBox(p, nullable), type: e.type };
  }

  /** A private stack box over a nullable-pointer field read whose payload
   * is retained into the current frame: an independent owner, so the box
   * may outlive later stores to the field (call arguments, local copies).
   * The box itself must still never reach an RC entry point. */
  emitOwnedNullableStack(e: IrExpr): { box: string; owner: LlValue } {
    const nullable = this.nullableFieldGet(e);
    if (!nullable || e.kind !== "fieldGet")
      throw new InternalCompilerError("llvm emitter bug: owned nullable stack of non-field");
    const receiver = this.emitReadReceiver(e.obj);
    const { ptr } = this.classFieldPtr(receiver.name, e.className, e.field, "compressed");
    const p = this.loadRef(ptr);
    const owner = this.own({ name: this.retainFrame(p, nullable.arm), type: nullable.arm });
    return { box: this.stackNullableBox(owner.name, nullable), owner };
  }

  /** A private stack box over a borrowed nullable pointer. */
  stackNullableBox(p: string, nullable: NullableRefField): string {
    const B = this.B;
    const box = B.slot();
    B.entryAllocas.push(`${box} = alloca %ScrUnion`);
    const isNull = B.tmp(),
      tag = B.tmp(),
      tagPtr = B.tmp(),
      slot = B.tmp();
    B.line(`${isNull} = icmp eq ptr ${p}, null`);
    B.line(`${tag} = select i1 ${isNull}, i32 ${nullable.unitTag}, i32 ${nullable.refTag}`);
    B.line(`${tagPtr} = getelementptr inbounds %ScrUnion, ptr ${box}, i64 0, i32 1`);
    B.line(`store i32 ${tag}, ptr ${tagPtr}`);
    B.line(`${slot} = getelementptr inbounds %ScrUnion, ptr ${box}, i64 0, i32 5`);
    B.line(`store i64 0, ptr ${slot}`);
    B.line(`store ptr ${p}, ptr ${slot}`);
    return box;
  }

  /** The owned (+1) union value of a nullable-pointer slot: the unit arm's
   * immortal instance, or a fresh heap box around a retained instance. */
  nullableToOwnedUnion(p: string, nullable: NullableRefField): string {
    const B = this.B;
    const slot = B.slot();
    B.entryAllocas.push(`${slot} = alloca ptr`);
    const isNull = B.tmp();
    const unit = B.newLabel("nf.u"),
      ref = B.newLabel("nf.r"),
      join = B.newLabel("nf.j");
    B.line(`${isNull} = icmp eq ptr ${p}, null`);
    B.condBr(isNull, unit, ref);
    B.startBlock(unit);
    B.line(`store ptr ${this.unitInstanceRef(nullable.unionId, nullable.unitTag)}, ptr ${slot}`);
    B.br(join);
    B.startBlock(ref);
    const owned = this.retainHeap(p, nullable.arm);
    const box = this.unionNewOwned(nullable.unionId, nullable.refTag, {
      name: owned,
      type: nullable.arm,
    });
    B.line(`store ptr ${box}, ptr ${slot}`);
    B.br(join);
    B.startBlock(join);
    const t = B.tmp();
    B.line(`${t} = load ptr, ptr ${slot}`);
    return t;
  }

  /** The owned (+1) instance pointer (NULL for the unit arm) of a union
   * box, which stays owned by its existing owner. */
  unionToNullable(u: string, nullable: NullableRefField): string {
    const B = this.B;
    const tag = this.unionTag(u, nullable.unionId);
    const isRef = B.tmp(),
      sel = B.tmp();
    B.line(`${isRef} = icmp eq i32 ${tag}, ${nullable.refTag}`);
    const payload = this.unionPeek(u, nullable.unionId);
    B.line(`${sel} = select i1 ${isRef}, ptr ${payload}, ptr null`);
    return this.retainHeap(sel, nullable.arm);
  }

  /** `obj.f = value` for a nullable-pointer field: the new instance pointer
   * is produced without a union box where the value is a wrap, and as a
   * retained payload of a borrowed box otherwise. Unlink-then-release like
   * every field store. */
  emitNullableFieldStore(
    obj: string,
    className: string,
    field: string,
    nullable: NullableRefField,
    value: IrExpr,
  ): void {
    let next: string;
    if (
      value.kind === "unionWrap" &&
      value.unionId === nullable.unionId &&
      (value.tag === nullable.refTag
        ? typeEquals(value.value.type, nullable.arm)
        : value.tag === nullable.unitTag)
    ) {
      if (value.tag === nullable.refTag) {
        const inner = this.emitExpr(value.value);
        this.toHeap(inner);
        next = inner.name;
      } else {
        // Unit payloads carry nothing; a void payload runs for effects.
        if (!isUnitType(value.value.type)) this.emitExpr(value.value);
        next = "null";
      }
    } else if (value.kind === "varRef" && !this.canBorrowReceiver(value)) {
      next = this.unionToNullable(this.emitExpr(value).name, nullable);
    } else {
      next = this.unionToNullable(this.emitUnionProjection(value).name, nullable);
    }
    const { ptr } = this.classFieldPtr(obj, className, field, "compressed");
    const old = this.loadRef(ptr, false);
    this.storeRef(ptr, next);
    this.releaseHeap(old, nullable.arm);
  }

  /** A union binding whose slot may hold a private stack box: stack locals
   * and projection-only parameters (callers may pass stack boxes). Such a
   * box must only be projected: never retained, released, or stored. */
  isStackUnionLocal(localId: string): boolean {
    return (
      this.projectedParameters.has(localId) ||
      this.localStackUnions.has(localId) ||
      this.localUnionStorage.has(localId) ||
      this.localArrayReads.has(localId) ||
      this.mapReadLifetimes.locals.has(localId)
    );
  }

  /** The instance of a capsule known to hold exactly this class (borrowed). */
  emitExactCapsuleObject(value: IrExpr, type: IrType): LlValue {
    const capsule = this.emitReadReceiver(value);
    const slot = this.B.tmp();
    const object = this.B.tmp();
    this.B.line(
      `${slot} = getelementptr inbounds i8, ptr ${capsule.name}, i64 16 ; ->v.typed_ref.ptr`,
    );
    this.B.line(`${object} = load ptr, ptr ${slot}`);
    return { name: object, type };
  }
  canBorrowReceiver(e: IrExpr): boolean {
    return canBorrowReceiver(this, e);
  }

  /** A reference held as one plain pointer that emitReadReceiver can read
   * without owning: class instances, records, arrays, strings, typed arrays
   * and nullable-pointer unions. Tagged union boxes, closures and dynamic
   * values keep ordinary ownership. */
  plainReference(type: IrType): boolean {
    switch (type.kind) {
      case "object":
      case "record":
      case "array":
      case "string":
      case "bytes":
        return true;
      case "union":
        return this.nullableUnions.has(type.unionId);
      default:
        return false;
    }
  }
  private analyzeBorrowedReturns(): void {
    return analyzeBorrowedReturns(this);
  }

  /** emitReadReceiver produces this node's pointer without acquiring a
   * reference, given operands (and ternary arms) that do the same: plain
   * class/record field reads, class casts, nullable-pointer narrows and
   * wraps, and checked ternaries. Stack-boxed, map-read and boxed-field
   * sources are owned. Depends only on module facts, not the current
   * function. */
  borrowsWithoutOwning(e: IrExpr): boolean {
    if (!isRefCounted(e.type) || this.isStackUnionSource(e)) return false;
    if (matchMapRead(e, this.boxedUnionsById)) return false;
    switch (e.kind) {
      case "fieldGet":
        return this.nullableFieldGet(e) === null;
      case "recordGet":
        return true;
      // emitReadReceiver lends a required element of a borrowed array when
      // computing the index removes no edge.
      case "arrayGet":
        return (
          e.arr.type.kind === "array" &&
          this.optionalArrayReads.get(e) === null &&
          this.referenceEffects.preserves(e.index)
        );
      case "unionNarrow":
        return this.nullableUnions.has(e.unionId);
      case "downcast":
      case "upcast":
        return e.value.type.kind === "object";
      case "unionWrap":
        return this.borrowableNullableWrap(e) !== null;
      // The caller proves each arm separately.
      case "ternary":
        return true;
      // The caller proves the arguments are walks; their evaluation must not
      // remove an edge before the call reads them.
      case "call":
        return (
          this.borrowedReturns.has(e.callee) &&
          e.args.every((arg) => this.referenceEffects.preserves(arg))
        );
      default:
        return false;
    }
  }

  /** A wrap into a nullable-pointer union is the payload pointer itself
   * (the reference arm) or an immortal constant (a unit arm), so it can
   * borrow exactly when its payload can. Void payloads run for effects and
   * keep the ordinary path; tagged unions still construct a box. */
  borrowableNullableWrap(e: IrExpr): "unit" | "ref" | null {
    if (e.kind !== "unionWrap") return null;
    const nullable = this.nullableUnions.get(e.unionId);
    if (!nullable) return null;
    if (isUnitType(e.value.type)) return e.value.kind === "unitLit" ? "unit" : null;
    const refArm =
      nullable.repr === "single"
        ? e.tag === nullable.refTag
        : nullable.arms.some((arm) => arm.tag === e.tag);
    return refArm && isRefCounted(e.value.type) ? "ref" : null;
  }

  materializeSplitLocal(localId: string): void {
    const span = this.splitSpans.get(localId);
    if (span) materializeSplitPiece(this, localId, span);
  }

  emitExpr(e: IrExpr): LlValue {
    return emitExpr(this, e);
  }

  /** The helper classification of this module's inline-cache sites. */
  get jsIcSites(): JsIcSites {
    return (this.jsIcSitesMemo ??= new JsIcSites(this.mod));
  }

  jsIcSite(): string {
    const name = `@sc_js_ic_${this.jsIcSiteCount++}`;
    this.journal?.site(name, "jsIcSite");
    return name;
  }

  /** A fresh read-site cache for one constant-key dyn read. */
  dynReadIcSite(): string {
    const name = `@sc_dyn_read_ic_${this.dynReadIcSites++}`;
    this.journal?.site(name, "dynReadIcSite");
    return name;
  }

  /** A fresh speculative loop site: the global that counts its bailing
   * entries in a row. */
  speculativeLoopSite(): string {
    const name = `@sc_spec_bails_${this.speculativeLoopSites++}`;
    this.journal?.site(name, "speculativeLoopSite");
    this.journal?.opened("speculativeLoopSite");
    this.declare(`${name} = internal global i8 0`);
    this.journal?.built();
    return name;
  }

  dynKind(d: string): string {
    return dynKind(this, d);
  }

  raceAdapterFor(from: IrType, to: IrType): string {
    return raceAdapterFor(this, from, to);
  }

  genResultThunkFor(
    genT: IrType & { kind: "generator" },
    recT: IrType & { kind: "record" },
  ): string {
    return genResultThunkFor(this, genT, recT);
  }

  childExitThunkFor(param: IrType): string {
    return childExitThunkFor(this, param);
  }

  execFileThunkFor(cbT: IrType & { kind: "func" }): string {
    return execFileThunkFor(this, cbT);
  }

  ipcMessageThunkFor(cbT: IrType & { kind: "func" }): string {
    return ipcMessageThunkFor(this, cbT);
  }

  ipcSendThunkFor(cbT: IrType & { kind: "func" }): string {
    return ipcSendThunkFor(this, cbT);
  }

  childExitSignalThunkFor(codeParam: IrType, sigParam: IrType): string {
    return childExitSignalThunkFor(this, codeParam, sigParam);
  }

  childDataThunkFor(param: IrType): string {
    return childDataThunkFor(this, param);
  }

  childDataDynThunkFor(chunk: "bytes" | "str"): string {
    return childDataDynThunkFor(this, chunk);
  }

  emitterFixedAdapter(cbT: IrType & { kind: "func" }): { fn: string; shim: string } {
    return emitterFixedAdapter(this, cbT);
  }

  emitterOnceAdapter(
    boxerT: IrType & { kind: "func" },
    fire?: string,
  ): { fn: string; shim: string } {
    return emitterOnceAdapter(this, boxerT, fire);
  }

  wrapEmitterListener(target: string, adapterFn: string): string {
    return wrapEmitterListener(this, target, adapterFn);
  }

  unwrapNullableClosure(u: string, funcTag: number): string {
    return unwrapNullableClosure(this, u, funcTag);
  }

  closeBindThunkFor(cbUnion: IrType, retServer: boolean): string {
    return closeBindThunkFor(this, cbUnion, retServer);
  }

  closeOverrideWrapFor(cbUnion: IrType, retServer: boolean): string {
    return closeOverrideWrapFor(this, cbUnion, retServer);
  }

  streamDataAdapter(cbT: IrType & { kind: "func" }): string {
    return streamDataAdapter(this, cbT);
  }

  streamDoneFnFor(
    kind: "w" | "f" | "d" | "t" | "l" | "c",
    doneT: IrType & { kind: "func" },
  ): string {
    return streamDoneFnFor(this, kind, doneT);
  }

  fsRenameThunkFor(cbT: IrType & { kind: "func" }): string {
    return fsRenameThunkFor(this, cbT);
  }

  cryptoBytesThunkFor(
    cbT: IrType & { kind: "func" },
    arrayBuffer = false,
    valueMode: BytesThunkValue = "buffer",
  ): string {
    return cryptoBytesThunkFor(this, cbT, arrayBuffer, valueMode);
  }

  cryptoIntThunkFor(cbT: IrType & { kind: "func" }): string {
    return cryptoIntThunkFor(this, cbT);
  }

  zlibBytesThunkFor(cbT: IrType & { kind: "func" }): string {
    return zlibBytesThunkFor(this, cbT);
  }

  streamCbThunkFor(kind: "r" | "w" | "f" | "d" | "t" | "l" | "e" | "c" | "v", cbT: IrType): string {
    return streamCbThunkFor(this, kind, cbT);
  }

  resolveThunkFor(inner: IrType): string {
    return resolveThunkFor(this, inner);
  }

  tagInSet(uName: string, unionId: string, tags: number[]): string {
    return tagInSet(this, uName, unionId, tags);
  }

  arrPush(arr: string, acc: ArrayAccess, value: string, element: IrType | null): string {
    return arrPush(this, arr, acc, value, element);
  }

  emitArrayCopyLoop(dst: string, src: string, acc: "f64" | "bool" | "ref"): void {
    return emitArrayCopyLoop(this, dst, src, acc);
  }

  emitStrIntrinsic(e: IrExpr & { kind: "strIntrinsic" }): LlValue {
    return emitStrIntrinsic(this, e);
  }

  emitArrIntrinsic(e: IrExpr & { kind: "arrIntrinsic" }): LlValue {
    return emitArrIntrinsic(this, e);
  }

  wrapNullable(
    raw: string,
    present: string,
    valueType: IrType,
    valueTag: number,
    resultType: IrType & { kind: "union" },
    absentTag: number,
  ): LlValue {
    return wrapNullable(this, raw, present, valueType, valueTag, resultType, absentTag);
  }

  emitMapNew(e: IrExpr & { kind: "mapNew" }): LlValue {
    return emitMapNew(this, e);
  }

  mapSet(
    m: string,
    kAcc: MapKeyAccess,
    vAcc: "f64" | "bool" | "ref",
    key: string,
    value: string,
  ): void {
    return mapSet(this, m, kAcc, vAcc, key, value);
  }

  emitMapLikeIntrinsic(e: Extract<IrExpr, { kind: "mapIntrinsic" | "setIntrinsic" }>): LlValue {
    return emitMapLikeIntrinsic(this, e);
  }

  emitSetNew(e: IrExpr & { kind: "setNew" }): LlValue {
    return emitSetNew(this, e);
  }

  emitStableReceiver(receiver: IrExpr, following: IrExpr[]): LlValue {
    return emitStableReceiver(this, receiver, following);
  }

  emitIntegerLoopIndex(expr: IrExpr): string | null {
    return emitIntegerLoopIndex(this, expr);
  }

  emitBytesIndex(receiver: string, index: LlValue, expr?: IrExpr, inBounds = false): string {
    return emitBytesIndex(this, receiver, index, expr, undefined, inBounds);
  }

  emitBytesData(receiver: string): string {
    return emitBytesData(this, receiver);
  }

  emitBytesLength(elem: IrBytesElem, receiver: string, bytes: boolean): LlValue {
    return emitBytesLength(this, elem, receiver, bytes);
  }

  emitBytesGet(
    elem: IrBytesElem,
    receiver: string,
    index: LlValue,
    expr?: IrExpr,
    inBounds = false,
    invalidNaN = false,
    owned = false,
  ): LlValue {
    return emitBytesGet(this, elem, receiver, index, expr, inBounds, invalidNaN, owned);
  }

  emitToUint32(value: string, expr?: IrExpr, uint32?: string): string {
    return emitToUint32(this, value, expr, uint32);
  }

  /** Stores a number into its int32-stored local, when it is one. The
   * value is proven to be in the local's range, so its low 32 bits are the
   * exact value. */
  storeInt32Local(localId: string, value: LlValue, expr?: IrExpr): boolean {
    const local = this.int32Locals.get(localId);
    if (local === undefined) return false;
    if (expr !== undefined && !this.int32LocalWrites.has(expr))
      throw new InternalCompilerError(`llvm emitter bug: unproven write of int32 local ${localId}`);
    const B = this.B;
    const integer = exactInteger(this, value, expr);
    let bits: string;
    if (integer && /^-?\d+$/.test(integer.name)) bits = String(Number(integer.name) | 0); // a literal's i32 bits
    else if (integer) bits = narrowInteger(this, integer);
    else if (value.uint32 !== undefined) bits = value.uint32;
    else {
      // An Int32 contract proved this write without a range at the value.
      bits = B.tmp();
      B.line(`${bits} = ${local.signed ? "fptosi" : "fptoui"} double ${value.name} to i32`);
    }
    B.line(`store i32 ${bits}, ptr %${mangleLocal(localId)}`);
    return true;
  }

  /** The number of an int32-stored local's i32, with the i32 as its
   * integer and ToUint32 forms. A parameter the body never writes reads
   * as its incoming double, which is the same number. */
  int32LocalValue(localId: string, bits: string, type: IrType): LlValue {
    const local = this.int32Locals.get(localId)!;
    let number = `%p_${mangleLocal(localId)}`;
    if (!local.incoming) {
      number = this.B.tmp();
      this.B.line(`${number} = ${local.signed ? "sitofp" : "uitofp"} i32 ${bits} to double`);
    }
    return {
      name: number,
      type,
      uint32: bits,
      integer: { name: bits, type: "i32", signed: local.signed, range: local.range },
    };
  }

  storeIntegerView(localId: string, value: LlValue, expr?: IrExpr): void {
    const slot = this.integerViews.get(localId);
    if (slot === undefined) return;
    const integer = this.emitToUint32(value.name, expr, value.uint32);
    this.B.line(`store i32 ${integer}, ptr ${slot}`);
  }

  emitBytesSet(
    elem: IrBytesElem,
    receiver: string,
    index: LlValue,
    value: LlValue,
    indexExpr?: IrExpr,
    expr?: IrExpr,
    inBounds = false,
    owned = false,
  ): void {
    return emitBytesSet(this, elem, receiver, index, value, indexExpr, expr, inBounds, owned);
  }

  emitBytesIntrinsic(e: IrExpr & { kind: "bytesIntrinsic" }): LlValue {
    return emitBytesIntrinsic(this, e);
  }

  emitRegexIntrinsic(e: IrExpr & { kind: "regexIntrinsic" }): LlValue {
    return emitRegexIntrinsic(this, e);
  }

  emitRecordKeyGet(e: IrExpr & { kind: "recordKeyGet" }): LlValue {
    return emitRecordKeyGet(this, e);
  }

  keyedRecordReadInto(
    slot: string,
    join: string,
    objName: string,
    keyName: string,
    shapeId: string,
    resultType: IrType,
    overflowOnly: boolean,
    loc?: SrcLoc,
    missNaN = false,
  ): void {
    return keyedRecordReadInto(
      this,
      slot,
      join,
      objName,
      keyName,
      shapeId,
      resultType,
      overflowOnly,
      loc,
      missNaN,
    );
  }

  dynPromiseAdapter(inner: IrType): string {
    return dynPromiseAdapter(this, inner);
  }

  streamTypedRefCommitAdapter(t: IrType, snapshot: string): string {
    return streamTypedRefCommitAdapter(this, t, snapshot);
  }

  liveDynRefAdapter(t: IrType): LlStreamTypedRefAdapter {
    if (!streamTypedRefEligible(t) && !isDynTypedRefType(t)) {
      throw new InternalCompilerError(`llvm emitter bug: live dyn ref of ${typeKey(t)}`);
    }
    return streamTypedRefMaterializeAdapter(this, t);
  }

  liveDynUnionRefAdapter(t: IrType & { kind: "union" }): string {
    return liveDynUnionRefAdapter(this, t);
  }

  streamTypedRefBoxValue(B: BlockBuilder, t: IrType, value: string): string {
    return streamTypedRefBoxValue(this, B, t, value);
  }

  streamFromArrayAdapter(t: IrType & { kind: "array" }): string {
    return streamFromArrayAdapter(this, t);
  }

  emitWebLibCall(e: LibCallExpr): LlValue {
    return emitWebLibCall(this, e);
  }

  emitDynamicLibCall(e: LibCallExpr): LlValue {
    return emitDynamicLibCall(this, e);
  }

  emitFilesystemLibCall(e: LibCallExpr): LlValue {
    return emitFilesystemLibCall(this, e);
  }

  emitPathUrlLibCall(e: LibCallExpr): LlValue {
    return emitPathUrlLibCall(this, e);
  }

  emitPrimitiveLibCall(e: LibCallExpr): LlValue {
    return emitPrimitiveLibCall(this, e);
  }

  emitChildProcessLibCall(e: LibCallExpr): LlValue {
    return emitChildProcessLibCall(this, e);
  }

  emitAsyncContextLibCall(e: LibCallExpr): LlValue {
    return emitAsyncContextLibCall(this, e);
  }

  emitProcessLibCall(e: LibCallExpr): LlValue {
    return emitProcessLibCall(this, e);
  }

  emitErrorsEventsLibCall(e: LibCallExpr): LlValue {
    return emitErrorsEventsLibCall(this, e);
  }

  emitStreamLibCall(e: LibCallExpr): LlValue {
    return emitStreamLibCall(this, e);
  }

  emitNetworkHttpLibCall(e: LibCallExpr): LlValue {
    return emitNetworkHttpLibCall(this, e);
  }

  emitAssertInspectLibCall(e: LibCallExpr): LlValue {
    return emitAssertInspectLibCall(this, e);
  }

  emitIoLibCall(e: LibCallExpr): LlValue {
    return emitIoLibCall(this, e);
  }

  emitGenericLibCall(e: LibCallExpr): LlValue {
    return emitGenericLibCall(this, e);
  }

  emitLibCall(e: LibCallExpr): LlValue {
    return emitLibCall(this, e);
  }
}

/** The adopting await a `return` value resolves through, if any: the value
 * itself or the operand of its conversion into the declared result. */
export function adoptingAwaitOf(value: IrExpr | null): ExprOf<"awaitExpr"> | null {
  if (value === null) return null;
  let found: ExprOf<"awaitExpr"> | null = null;
  everyExpr(value, {
    expr: (node) => {
      if (found !== null) return false;
      if (node.kind === "awaitExpr" && node.adopt === true) {
        found = node;
        return false;
      }
      return true;
    },
    stmt: () => true,
  });
  return found;
}

/** Adds `key` to `into` when it lacks it. */
function addEntry<V>(into: Map<string, V>, key: string, value: V): void {
  if (!into.has(key)) into.set(key, value);
}

/** Adds `key` to a numbered table when it lacks it, numbering it after the
 * table's own entries (`prefix` and its index), and records the rename of
 * the chunk's `name` for it. */
function addNumbered(
  into: Map<string, string>,
  key: string,
  name: string,
  prefix: string,
  names: Map<string, string>,
): void {
  let own = into.get(key);
  if (own === undefined) {
    own = `${prefix}${into.size}`;
    into.set(key, own);
  }
  if (own !== name) names.set(name.replace(/^@/, ""), own.replace(/^@/, ""));
}

/** addNumbered for entries that keep their numbered name in `sym`. */
function addNumberedSymbol<V extends { sym: string }>(
  into: Map<string, V>,
  key: string,
  entry: V,
  prefix: string,
  names: Map<string, string>,
): void {
  let own = into.get(key);
  if (own === undefined) {
    own = { ...entry, sym: `${prefix}${into.size}` };
    into.set(key, own);
  }
  if (own.sym !== entry.sym) names.set(entry.sym, own.sym);
}

registerReplay("jsIcSite", (emitter) => emitter.jsIcSite());
registerReplay("dynReadIcSite", (emitter) => emitter.dynReadIcSite());
registerReplay("speculativeLoopSite", (emitter) => emitter.speculativeLoopSite());
for (const op of [
  "dyn.collectionDynOps",
  "dyn.dynMatchHelper",
  "dyn.jsonSchema",
  "dyn.recordNameTable",
  "dyn.jsonParseHelper",
  "dyn.dynCheckHelper",
  "dyn.toDynHelper",
  "dyn.promiseDynAdapterHelper",
  "dyn.dynFuncThunkHelper",
  "dyn.dynFuncBoxHelper",
  "dyn.dynFuncAdapterHelper",
  "dyn.dynToStrHelper",
  "dyn.dynIterNHelper",
  "dyn.dynDestrCheckHelper",
  "dyn.dynKeyGetHelper",
  "dyn.dynComputedKeyGetHelper",
  "dyn.caughtToDynHelper",
  "dyn.messageListenerHelper",
  "dyn.messageReaderHelper",
])
  registerReplay(op, (emitter, args) => emitter.dyn.replayHelper(op, args));
for (const op of [
  "walkers.jsonWriteHelper",
  "walkers.recordFieldWriter",
  "walkers.unionJoinHelper",
])
  registerReplay(op, (emitter, args) => emitter.walkers.replayHelper(op, args));
for (const op of ["publish.walker", "publish.refusal"])
  registerReplay(op, (emitter, args) => emitter.publishWalkers.replayHelper(op, args));
