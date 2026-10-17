import { type ArraySearchKind, emitArraySearchHelpers } from "./array-search.js";
import { emitStringInputs } from "./string-lifetimes.js";
import { emitLlvmLayouts } from "./layouts.js";
import { compileRegexMatcher, type RegexMatcherCode } from "./regex-matchers.js";
import { CYC_BUF, CYC_HDR, FIRST_EMITTED_CYC_KIND, inlineAllocSupported } from "./alloc.js";
import { hasLoneSurrogate, llvmBytes as llBytes, wtf8Bytes } from "../literals.js";
import { InternalCompilerError } from "../../errors.js";
import { createHash } from "node:crypto";
import {
  endsWithJump,
  matchFieldSelfConcat,
  matchStringSelfConcat,
  readsArraySlot,
  streamTypedRefEligible,
  undefinedArmTag,
} from "../../ir/analysis.js";
import { emitLibraryIdentityLines } from "../library-identity-markers.js";
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
  CAUGHT,
  ffiCallbackType,
  isDynTypedRefType,
  isFfiContextParam,
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
  STRING,
  VOID,
} from "../../ir/ir.js";
import { moduleRuntimeFeatures } from "../../ir/runtime-features.js";
import {
  matchIntegerArrayForLoop,
  matchIntegerBytesForLoop,
  matchIntegerCountedForLoop,
} from "../../ir/integer-loops.js";
import { emitCountedLoopLimit } from "./counted-loops.js";
import {
  emitSafeIntegerCheck,
  emitSpeculativeInteger,
  planSpeculativeLoop,
  speculativeReads,
  speculativeWriteTarget,
  SPECULATIVE_RANGE,
} from "./speculative-integers.js";
import { emitLiteralSwitch } from "./switch-dispatch.js";
import { findBytesBounds } from "./bytes-bounds.js";
import {
  emitByteWindowGuard,
  findInitializedByteLoopBindings,
  matchByteWindow,
} from "./byte-windows.js";
import {
  canDeferSplitPiece,
  emitSplitSpanNext,
  materializeSplitPiece,
  type SplitSpan,
  emitSplitCursor,
  emitSplitNext,
  emitSplitScratch,
  emitSplitSnapshot,
  findPrivateSplitLocals,
  loadSplitSnapshot,
  storeSplitSnapshot,
  stringSplit,
  type StoredSplitSnapshot,
  type StringSplit,
} from "./split-loops.js";
import { scalarizeNumericRecords } from "../../ir/scalar-records.js";
import { RESULT_ENTRY_PREFIX, addRecordResultEntries } from "./record-results.js";
import { specializeCallbackCalls } from "../../ir/callback-specialization.js";
import { specializeNumericCalls } from "../../ir/numeric-call-specialization.js";
import { everyExpr, everyExprChild, everyStmtChild, everyStmtList } from "../../ir/traverse.js";
import {
  analyzeIntegerRanges,
  INT32_RANGE,
  type IntegerRange,
  type IntegerRanges,
} from "../../ir/integer-ranges.js";
import { unshareNodes } from "../../ir/unshare.js";
import { copyStableCaptures } from "../../ir/capture-values.js";
import { analyzeInt32Slots, dynamicFieldStores, type Int32Slots } from "../../ir/int32-slots.js";
import { analyzeFinalFields, constructorClass, type FinalFields } from "../../ir/final-fields.js";
import { foldConstantGlobals } from "../../ir/constant-globals.js";
import { dropUnwrittenPropertyBags } from "../../ir/property-bags.js";
import { freezeInitOnlyGlobals } from "../../ir/init-only-globals.js";
import { hoistFinalFieldReads } from "../../ir/field-values.js";
import { findIntegerViews } from "./integer-views.js";
import {
  findInt32Abis,
  INT32_ABI_SUFFIX,
  SCALAR_UNION_DUMMY,
  SCALAR_UNION_RESULT,
  type Int32Abi,
} from "./int32-abi.js";
import { findInt32Locals, type Int32Local } from "./int32-locals.js";
import {
  emitIntegerClone,
  emitIntegerDispatcher,
  findIntegerClones,
  NO_INTEGER_CLONES,
  type IntegerClones,
} from "./integer-clones.js";
import { exactInteger, narrowInteger } from "./integer-values.js";
import {
  conditionalLoopWrites,
  findInitializerBindings,
  initializerLocalCandidates,
  withInitializerBindings,
  withInitializerLocals,
} from "../../ir/initializer-bindings.js";
import { findConstantNumericTables, type ConstantNumericTable } from "../../ir/constant-tables.js";
import {
  allocateFfiCallbackAdapters,
  hasForeignFfiCallback,
  hasRetainedFfiCallback,
  type FfiCallbackAdapter,
} from "../ffi-callbacks.js";
import { RUNTIME_ABI_MARKER } from "../runtime-abi.js";
import { computeMayThrow } from "../may-throw.js";
import {
  mangleArgPack,
  mangleAsyncAdoptCall,
  mangleAsyncAwaitCall,
  mangleAsyncSpawn,
  mangleBorrowedFunction,
  mangleClassObj,
  mangleClassStruct,
  mangleFnClosure,
  mangleFunction,
  mangleGenDrop,
  mangleGenSpawn,
  mangleGlobal,
  mangleLocal,
  mangleRecordStruct,
  mangleTrampoline,
  mangleWrapper,
  mangleBorrowingWrapper,
  mangleVtInstance,
} from "../mangle.js";
import { analyzeCallLifetimes, type CallLifetimes } from "./call-lifetimes.js";
import { canStackUnion, emitStackUnion, findLocalStackUnions } from "./stack-unions.js";
import {
  emitStackObject,
  findLocalStackObjects,
  findReassignedStackObjects,
  stackObjectStruct,
  type StackObjectSource,
} from "./stack-objects.js";
import {
  allocateLocalUnion,
  emitScalarOptional,
  findLocalUnionStorage,
  isScalarOptionalSource,
  storeLocalUnion,
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
import {
  emitLocalArrayRead,
  emitProjectedArrayRead,
  emitBorrowedArrayRead,
  findLocalArrayReads,
  findCallArrayReads,
  OptionalArrayReads,
  type LocalArrayRead,
} from "./local-array-reads.js";
import { CheckedNarrows, emitCheckedNarrowReceiver } from "./checked-narrows.js";
import { emitDenseArrayGet, emitDenseArraySet, emitDenseSlotUnlink } from "./dense-array-access.js";
import {
  emitStackMapRead,
  findMapReadLifetimes,
  findReadNumberMapWrites,
  matchMapRead,
  type MapReadLifetimes,
} from "./map-read-lifetimes.js";
import { findMapEntryFusions, type MapEntryFusion } from "./map-entry-fusion.js";
import { emitBorrowedFieldSequence, guardedValue } from "./borrowed-receivers.js";
import { borrowableInputs, emitBorrowedInput, emitBorrowedInputs } from "./borrowed-inputs.js";
import { analyzeWalks, findWalkBorrows, type WalkBorrowHost } from "./walk-borrows.js";
import { lastUseRead } from "./local-extents.js";
import { findReboundParameters } from "./rebound-parameters.js";
import { ReferenceEffects } from "./reference-effects.js";
import { ReferenceWrites, type Writes } from "./reference-writes.js";
import { LlvmDebugInfo } from "./debug-info.js";
import { StackCallbacks } from "./stack-callbacks.js";
import { dynHoleRead, findLoopArrayBorrows } from "./loop-array-borrows.js";
import { findAppendedArrayLiterals } from "./appended-array-literals.js";
import { AmbientReceiverReaders, findConstantCallbacks } from "./constant-callbacks.js";
import {
  findScalarStringSlices,
  emitStringSliceSnapshot,
  type StringSliceSnapshot,
} from "./string-slices.js";
import { LazyCaptures } from "./lazy-captures.js";
import { StackCaptures } from "./stack-captures.js";
import {
  ABSENT_FIELD_PAYLOAD,
  emitFieldAbsentTest,
  exactIndexLines,
  f64Lit,
  ffiNativeTypeLl,
  ffiNativeParamLl,
  ffiNativeReturnLl,
  llvmCommentText,
  sizeToDouble,
} from "./common.js";
import { ffiExtendsNarrowIntegers } from "../targets.js";
import {
  emitLiteralExpr,
  emitOperatorExpr,
  emitStringExpr,
  emitContainerExpr,
  emitRecordExpr,
} from "./expr-primitives.js";
import { emitControlExpr } from "./expr-control.js";
import { emitBorrowedResultCall, emitCallExpr } from "./expr-calls.js";
import { emitDynamicExpr } from "./expr-dynamic.js";
import { emitIntrinsicExpr, emitSerializationExpr, emitAsyncExpr } from "./expr-async.js";
import { PublishWalkers } from "./publish.js";
import { computeImmutableFields, stableGlobals, type ImmutableFields } from "../immutability.js";
import { computePublishedTypes, type PublishedTypes } from "../publication.js";
import { emitExpr } from "./expr-dispatch.js";

import {
  dynKind,
  raceAdapterFor,
  genResultThunkFor,
  childExitThunkFor,
  childExitSignalThunkFor,
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
  emitDiscardedSplice,
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
  buildClassGraph,
  classMembershipIntervals,
  emitClassMembershipHelper,
  classEnvironmentIndex,
  classFieldIndex,
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
import { literalCapWord, literalCapWord32 } from "./string-key-hash.js";
import {
  MAP_ITER_DECL,
  NUMBER_MAP_ENTRY_DECL,
  STRING_MAP_ENTRY_DECL,
} from "./map-number-lookup.js";
import { STRING_READ_HELPERS, stringScanDecl } from "./string-reads.js";
import {
  emitConcatInputs,
  emitMixedConcat,
  numberPart,
  stringParts,
} from "./string-construction.js";
import {
  arrNewCall,
  boxAccess,
  boxNewCall,
  boxReleaseSym,
  computeTraced,
  elemAccess,
  emitInlineRcHelpers,
  emitNullableRetainWrappers,
  FN_ATTRS,
  inlineRcDecls,
  type InlineRcMode,
  limitInlineDynReleases,
  llFieldType,
  mapFlagsOffset,
  type MapKeyAccess,
  releaseSym,
  retainSym,
  traceArg,
  typedRefConstructor,
  vAdapters,
} from "./shapes.js";
import type { ExprOf, LibCallExpr, LlStreamTypedRefAdapter, LlValue } from "./expr-context.js";
import { INLINE_LITERAL_BYTES, literalEqualityDefinition } from "./string-literal-equality.js";

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

interface LlScopeEntry {
  slot: string;
  type: IrType;
  boxed?: boolean;
  /** A lazily created box: the slot stays null on paths that build no
   * environment, which skip the release call. */
  lazy?: boolean;
}

export interface LlvmTargetOptions {
  /** C ABI target; omitted direct emission uses the host ABI. */
  targetTriple?: string;
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
}

export function emitLlvmModule(input: IrModule, options: LlvmTargetOptions = {}): string {
  // Facts are keyed by node identity: emit the same module whether it was
  // lowered in memory or read back from its serialized form.
  const mod = unshareNodes(input);
  // Keep source storage intact for debugger inspection in dev builds.
  return new LlEmitter(
    options.debugSources === undefined
      ? addRecordResultEntries(
          scalarizeNumericRecords(
            specializeCallbackCalls(
              specializeNumericCalls(
                foldConstantGlobals(
                  copyStableCaptures(
                    hoistFinalFieldReads(freezeInitOnlyGlobals(dropUnwrittenPropertyBags(mod))),
                  ),
                ),
                mangleFunction,
              ),
              mangleFunction,
            ),
          ),
        )
      : mod,
    options,
  ).emit();
}

/** Keep large translation units below the host's single-string limit. */
export function emitLlvmModuleSource(
  input: IrModule,
  options: LlvmTargetOptions = {},
): string | readonly string[] {
  const mod = unshareNodes(input);
  const parts = new LlEmitter(
    options.debugSources === undefined
      ? addRecordResultEntries(
          scalarizeNumericRecords(
            specializeCallbackCalls(
              specializeNumericCalls(
                foldConstantGlobals(
                  copyStableCaptures(
                    hoistFinalFieldReads(freezeInitOnlyGlobals(dropUnwrittenPropertyBags(mod))),
                  ),
                ),
                mangleFunction,
              ),
              mangleFunction,
            ),
          ),
        )
      : mod,
    options,
  ).emitParts();
  const length = parts.reduce((total, part) => total + part.length, Math.max(0, parts.length - 1));
  if (length <= 256 * 1024 * 1024) return parts.join("\n");
  return parts.flatMap((part, index) => (index === 0 ? [part] : ["\n", part]));
}

function llStrBytes(text: string): string {
  return llBytes(wtf8Bytes(text));
}

const NO_BORROWED: ReadonlySet<number> = new Set();
/** ScrExcKind tags of a generator slot holding a number or a boolean. */
const SCR_EXC_F64 = 1;
const SCR_EXC_BOOL = 2;

/** Whether any node of `e` names the local (reads, writes, declarations,
 * captures). */
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

export class LlEmitter {
  localArrayReads = new Map<string, LocalArrayRead>();
  private loopArrayBorrows: ReadonlySet<IrStmt> = new Set();
  private scalarStringSlices = new Map<string, IrExpr & { kind: "strIntrinsic" }>();
  readonly stringSlices = new Map<string, StringSliceSnapshot>();
  private localStackUnions = new Map<string, IrExpr & { kind: "unionWrap" }>();
  private localStackObjects = new Map<string, StackObjectSource>();
  private reassignedStackObjects = new Set<string>();
  /** The binding slot of each reassigned stack-object local. */
  private stackObjectSlots = new Map<string, string>();
  private localUnionStorageProofs = new Map<string, LocalUnionStorageProof>();
  private localUnionStorage = new Map<string, LocalUnionStorage>();
  integerArrayBindings = new Set<string>();
  private readonly fieldAliasTags = new Map<string, number>();
  private readonly fieldPointerTags = new Map<string, number>();

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
    return `, !tbaa !${tag}`;
  }

  /** The `!range` attachment of an array length load: a length is at most
   * 2^32 - 1 (the runtime's SCR_ARR_MAX_LENGTH), so conversions to double
   * and back fold. 32-bit targets load the full range anyway. */
  get arrayLengthRange(): string {
    return this.sizeType === "i64" ? ", !range !{i64 0, i64 4294967296}" : "";
  }

  fieldAliasAttachment(ptr: string): string {
    const tag = this.fieldPointerTags.get(ptr);
    return tag === undefined ? "" : `, !tbaa !${tag}`;
  }

  private fieldAliasMetadata(): string[] {
    if (this.fieldAliasTags.size === 0) return [];
    const lines = ['!0 = !{!"scriptc native fields"}'];
    for (const tag of this.fieldAliasTags.values()) {
      lines.push(
        `!${tag - 1} = !{!"field.${tag}", !0, i64 0}`,
        `!${tag} = !{!${tag - 1}, !${tag - 1}, i64 0}`,
      );
    }
    return lines;
  }
  private readonly debug: LlvmDebugInfo | null;
  /** Projection-only scalar objects may live in frame storage (stack-objects.ts). */
  readonly stackObjects: boolean;
  private debugScope: string | null = null;
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
  /** Some function in the module is lowered as a coroutine. */
  private usesCoroutines = false;
  /** The target lacks a rounding instruction at its baseline CPU (x86-64
   * before SSE4.1), so `llvm.trunc` would lower to a libm call: emit
   * truncation inline through an integer round trip instead. */
  readonly inlineTrunc: boolean;
  /** ELF worker executables give thread-locals the executable TLS models. */
  private readonly executableTls: boolean;
  /** Source loops enclosing the statement being emitted in the current
   * function body. */
  private loopDepth = 0;
  /** Darwin worker executables read the stack guard from a pthread
   * thread-specific-data slot off the thread pointer (scr_runtime.h's
   * SCR_STACK_GUARD_TSD): the architecture names the access sequence. */
  private readonly stackGuardTsd: "aarch64" | "x86_64" | null;
  private readonly emitLibraryIdentity: boolean;
  private readonly runtimeAbiMarker: boolean;
  private readonly detachedExit: boolean;
  /** Interned string literals: UTF-8 text → { symbol, byte length } —
   * first-use order, the runtime ABI’s determinism discipline. */
  private readonly literals = new Map<string, { sym: string; len: number }>();
  /** Literal equality helpers: literal text → helper symbol (literalEquals). */
  private readonly literalEqualities = new Map<string, string>();
  /** Interned bigint literals: hex magnitude with sign → { symbol, value }. */
  private readonly bigintLiterals = new Map<string, { sym: string; value: bigint }>();
  /** Symbols of interned constant data, named by content (contentSymbol). */
  private readonly contentSymbols = new Set<string>();
  /** Interned unit-armed union instances: "unionId:tag" → symbol — one
   * immortal (rc == SIZE_MAX) static per (union, unit tag).
   * RC entry points and the collector skip immortals. */
  private readonly unitInstances = new Map<string, string>();
  /** unionId → symbol of the union's immortal ABSENT field-slot instance. */
  private readonly absentInstances = new Map<string, string>();
  /** The zeroed box an inline store reads for a NULL union dummy. */
  private needsUnionNone = false;
  /** unionId → symbol of a flag set once a checked-dynamic cast caches one
   * of the union's boxes. A cached box is refreshed in place, possibly with
   * a tag that another union numbers apart, so it is never shared. */
  private readonly retypeGuards = new Map<string, string>();
  /** The nullable-union ABSENT sentinel was referenced (absentInstanceRef). */
  private needsNullableAbsent = false;
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
  private readonly cstrs = new Map<string, { sym: string; len: number }>();
  /** Interned ScrMapOps descriptors (scr_map.h): initializer → symbol. */
  private readonly mapOpsConsts = new Map<string, string>();
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
  private readonly decls = new Set<string>();
  /** Declared functions referenced as values: each needs an env-signature
   * wrapper + an interned immortal closure (so `f === f` holds). */
  readonly fnValues = new Set<string>();
  private needsOom = false;
  needsBadTag = false;
  needsBadKey = false;
  private needsRetainBox = false;
  /** Inline RC fast-path helpers requested by call sites (shapes.ts); null
   * when inline RC is off. */
  private readonly rcHelpers: Set<string> | null;
  private readonly rcMode: InlineRcMode | undefined;
  private readonly rcHelpersNoinline: boolean;

  readonly fnByName = new Map<string, IrFunction>();
  /** Empty literals that construct with inline slots (appended-array-literals.ts). */
  appendedArrayLiterals: ReadonlySet<IrExpr> = new Set();
  /** Emitted LLVM text of every IR function body, by function name: the
   * fiberless-async analysis scans it for suspension entry points. */
  private readonly fnDefText = new Map<string, string>();
  readonly referenceEffects: ReferenceEffects;
  /** Field-sensitive reference writes (null in debug builds). */
  referenceWrites: ReferenceWrites | null = null;
  private readonly borrowedReturnKeyCache = new Map<string, string[]>();
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
  readonly stackCallbacks: StackCallbacks;
  readonly receiverReaders: AmbientReceiverReaders;
  private readonly stackCaptures: StackCaptures;
  private readonly lazyCaptures: LazyCaptures;
  /** Unchanged captured parameters of the current function: each maps to
   * the slot caching its box, NULL until the first closure needs it. */
  private readonly lazyCaptureBoxes = new Map<string, string>();
  private readonly lazyStackBoxes = new Map<string, string>();
  private borrowedParameters = new Set<string>();
  /** Captures of the current closure body that its environment holds
   * unchanged for the closure's whole life (LazyCaptures.stableCaptures). */
  private stableCaptureIds: ReadonlySet<string> = new Set<string>();
  /** Parameters proven projection-only: callers may pass stack boxes. */
  private projectedParameters = new Set<string>();
  private stableCallBindings: ReadonlySet<string> = new Set();
  /** Locals and rebound parameters holding borrowed pointers for their
   * whole lifetime (walk-borrows.ts), per function and for the current one. */
  private readonly walkBorrowsByFunction = new Map<string, ReadonlySet<string>>();
  private walkBorrows: ReadonlySet<string> = new Set();
  /** Functions whose borrowing body returns its result without a reference
   * (analyzeBorrowedReturns), and whether the current body is one. */
  readonly borrowedReturns = new Set<string>();
  /** Rebound parameters that keep the borrowed convention with an owner
   * slot (rebound-parameters.ts), per function, and the current owner slots. */
  private readonly reboundByFunction = new Map<string, ReadonlySet<string>>();
  private readonly reboundOwnerSlots = new Map<string, string>();
  private currentBorrowedReturn = false;
  /** Manifest-bound native imports, used by ffiCall emission. */
  readonly ffiByName = new Map<string, IrFfiImport>();
  /** C-ABI callback trampolines and (for raw/no-userdata callbacks) their
   * distinct call-scoped TLS closure slots. */
  private readonly ffiCallbackAdapters: Map<string, FfiCallbackAdapter>;
  /** Module-level constant consulted per ffiCall: with a retained
   * descriptor anywhere in the manifest, every native call is a
   * pending-exception checkpoint (may-throw derives the same fact from
   * the same helper). */
  readonly ffiHasRetainedCallback: boolean;
  private readonly ffiHasForeignCallback: boolean;
  private readonly globalTypes = new Map<string, IrType>();
  /** Module constants that keep one value once initialized
   * (immutability.ts stableGlobals). */
  private stableGlobals: ReadonlySet<string> = new Set();
  private readonly tdzGlobals = new Map<string, string>();
  readonly constantNumericTables: ReadonlyMap<string, ConstantNumericTable>;
  /** Constant-key reads on checked-dynamic objects, each with its own
   * zero-initialized ScrDynReadIc (scr_runtime.h). */
  private dynReadIcSites = 0;
  /** May-throw analysis (computeMayThrow): pending
   * checks are emitted only after calls that can actually raise. */
  readonly mayThrow: Set<string>;
  readonly indirectMayThrow: boolean;
  /** Worker programs: the functions that poll for termination on entry
   * (workerTerminationPolls); null outside worker programs. */
  private readonly workerEntryPolls: ReadonlySet<string> | null;
  /** Functions that check the native stack guard on entry
   * (stackCheckedFunctions); null where the runtime has no guard. */
  private readonly stackChecks: ReadonlySet<string> | null;
  /** Static types whose values can be published (@scriptc/threads): their
   * stores carry the frozen-object guard. Null without publish calls. */
  readonly publishedTypes: PublishedTypes | null;
  /** Construction-only class and record fields (immutability.ts); null
   * where the facts are disabled. */
  private readonly immutableFields: ImmutableFields | null;
  /** Constructor function names: their bodies may still write their own
   * `this`'s construction-only fields. */
  private readonly constructorFunctions: ReadonlySet<string>;
  private inConstructor = false;
  /** Method names with at least one may-throw implementation — the
   * virtualCall pending check's key. */
  readonly mayThrowMethods = new Set<string>();
  /** Async functions awaited directly at some `await f(...)` site; each
   * gets an await-call entry (emitAsyncAwaitCall). */
  readonly awaitCallees = new Set<string>();
  /** Async functions returned directly at some `return f(...)` site of an
   * async function; each gets an adopting entry (emitAsyncAwaitCall). */
  readonly adoptCallees = new Set<string>();
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
  /** The class graph (buildClassGraph): preorder numbering, hierarchy
   * membership, virtual slot lists. */
  readonly classMeta: Map<string, LlClassMeta>;
  /** Which vtable slots borrow which parameters (virtual-borrows.ts). */
  private virtualBorrows!: VirtualBorrows;
  /** Class objects (classes as first-class values): className → the
   * interned .name literal ref — registered during body emission, the
   * statics and construct thunks assemble around the bodies. */
  private readonly classObjs = new Map<string, { nameSym: string }>();
  private readonly unionFieldReadGroups = new Map<string, number[][]>();
  /** Preorder intervals of the runtime error classes under THIS module's
   * class-forest numbering (main() stamps scr_error_vts with them, exactly
   * like the runtime ABI’s errorVtStampLines). */
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
  B = new BlockBuilder();
  frames: LlValue[][] = [];
  private scopes: LlScopeEntry[][] = [];
  /** Scope slots dominate every throw site. Share their exceptional cleanup
   * for identical live bindings and handlers; statement temporaries stay at
   * their own throw sites because their SSA values are path-dependent. */
  private readonly unwindCleanups = new Map<
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
  private jumpTargets: {
    kind: "loop" | "block" | "switch";
    brkLabel: string;
    contLabel: string | null;
    labels?: string[] | undefined;
    frameDepth: number;
    scopeDepth: number;
    finallyDepth: number;
  }[] = [];
  private currentLocals = new Map<string, IrLocal>();
  private privateSplitLocals = new Map<string, StringSplit>();
  readonly splitSpans = new Map<string, SplitSpan>();
  private storedSplits = new Map<string, StoredSplitSnapshot>();
  private streamingSplitsEnabled = false;
  private readonly initializerBindings: ReturnType<typeof findInitializerBindings>;
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
  private numericLocals = new Map<string, IrLocal>();
  private captureIds = new Set<string>();
  /** Active induction bindings retain their width independently of size_t. */
  integerLoopBindings = new Map<
    string,
    { slot: string; type: "i32" | "i64"; signed?: boolean; range?: { min: number; max: number } }
  >();
  private countedLoopsEnabled = false;
  /** Speculative integer loops (speculative-integers.ts) run in this function. */
  private speculativeLoopsEnabled = false;
  /** The fast copy of a speculative integer loop being emitted: its
   * integer-computed writes and where each resumes in the ordinary copy. */
  private speculation: {
    writes: Set<IrStmt>;
    resume: Map<IrStmt, string>;
    /** Globals whose double is written back only when the copy is left. */
    deferred: Set<string>;
  } | null = null;
  /** The ordinary copy being emitted: resume labels still to place. */
  private speculationResume: Map<IrStmt, { label: string; placed: boolean }> | null = null;
  /** The function being emitted, for speculative globals. */
  private speculativeFunction = "";
  /** Every function that writes each number global (computed on demand). */
  private globalWriters: Map<string, Set<string>> | null = null;
  /** Whole-program final reference fields (ir/final-fields.ts). */
  private finalFields!: FinalFields;
  /** The current function may borrow final fields of borrowable objects:
   * not a constructor (where they change), not async or a generator. */
  private finalFieldBorrows = false;
  integerRanges: IntegerRanges = new Map();
  /** Number arrays of the current function whose every present element is
   * an int32 (Int32[] contracts), or null when the module has none. */
  int32Elements: ((arr: IrExpr) => boolean) | null = null;
  /** Sums whose result only feeds 32-bit conversions (wrapping-sums.ts). */
  wrappingSums = new Set<IrExpr>();
  private byteWindowsEnabled = true;
  private byteWindowEntries: ReturnType<typeof findInitializedByteLoopBindings> = new Map();
  bytesBounds: ReadonlySet<IrExpr | IrStmt> = new Set();
  integerViews = new Map<string, string>();
  /** Module globals the current function owns outright (initializer
   * bindings): their function-local slot, which stands in for the global. */
  private privateGlobalSlots = new Map<string, string>();
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
  private finallyStack: {
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
  private tryStack: { label: string; used: boolean; frameDepth: number; scopeDepth: number }[] = [];
  /** Return type of the function being emitted — the unwind path returns
   * a dummy of this type (never read: callers check the flag first). */
  currentReturnType: IrType = VOID;
  /** The current body returns its number result as i32. */
  private currentInt32Result = false;
  /** The function's i32 entry returns its scalar union result as tag and
   * payload bits (Int32Abi.union). */
  private currentUnionResult = false;
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
  private currentAsyncGenerator = false;
  /** Active optional-chain bind slots, by chain id (chainRecv reads). */
  readonly chainSlots = new Map<string, LlValue>();
  logArgSlots = 0;
  private readonly stackTraces: boolean;

  constructor(
    readonly mod: IrModule,
    options: LlvmTargetOptions,
  ) {
    this.stackTraces = mod.functions.some(
      (fn) =>
        !everyStmtList(fn.body, {
          stmt: () => true,
          expr: (expr) => !(expr.kind === "libCall" && expr.fn === "error.stack"),
        }),
    );
    this.nullableUnions = new NullableUnions(mod);
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
    this.initializerBindings = findInitializerBindings(mod);
    this.int32Slots = analyzeInt32Slots(mod);
    const dynamicStores = dynamicFieldStores(mod);
    this.liveViewsReadOnly =
      mod.lib === undefined && !dynamicStores.all && dynamicStores.names.size === 0;
    this.int32Abis = this.debug === null ? findInt32Abis(mod, this.int32Slots) : new Map();
    this.immortalGlobals = new Set(mod.contracts?.immortalGlobals ?? []);
    this.programLifetime = new Set(mod.contracts?.programLifetime ?? []);
    this.finalFields = analyzeFinalFields(mod);
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
    this.rcHelpers = options.inlineRc !== undefined ? new Set() : null;
    this.rcMode = options.inlineRc;
    this.rcHelpersNoinline = options.rcHelpersNoinline === true;
    // ScrCycHdr.buf sits 4 bytes behind every object on every target.
    this.cycleBufOffset = CYC_HDR - CYC_BUF;
    this.ffiCallbackAdapters = allocateFfiCallbackAdapters(mod.ffiImports ?? []);
    this.ffiHasRetainedCallback = hasRetainedFfiCallback(mod.ffiImports ?? []);
    this.ffiHasForeignCallback = hasForeignFfiCallback(mod.ffiImports ?? []);
    for (const fn of mod.functions) this.fnByName.set(fn.name, fn);
    this.appendedArrayLiterals = findAppendedArrayLiterals(mod);
    for (const entry of mod.ffiImports ?? []) {
      this.ffiByName.set(entry.name, entry);
    }
    // Executables on Linux and macOS install a native stack guard per thread
    // and per async fiber; WASI, Windows and library builds have none.
    const triple = (options.targetTriple ?? "").toLowerCase();
    const windows = triple === "" ? process.platform === "win32" : triple.includes("windows");
    const mt = computeMayThrow(mod, {
      stackChecks: !this.wasi && mod.lib === undefined && !windows,
    });
    this.mayThrow = mt.fns;
    this.workerEntryPolls = mt.workerEntryPolls ?? null;
    this.stackChecks = mt.stackChecks ?? null;
    this.publishedTypes = computePublishedTypes(mod);
    this.immutableFields = computeImmutableFields(mod);
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
    this.optionalArrayReads = new OptionalArrayReads(this.fnByName, this.unionsById, (id) =>
      this.nullableUnions.has(id),
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
      );
    const walkParameters = new Map<string, Set<number>>();
    if (this.debug === null) {
      const host = {
        pointerLocal: (local: IrLocal) => this.plainReference(local.type),
        borrowsWithoutOwning: (e: IrExpr) => this.borrowsWithoutOwning(e),
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
            (type.kind !== "union" || this.nullableUnions.get(type.unionId)?.arm.kind !== "string"),
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
    );
    this.constantCallbacks = findConstantCallbacks(mod, this.callLifetimes);
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
    const traced = computeTraced(mod);
    this.tracedShapes = traced.shapes;
    this.tracedUnions = traced.unions;
    this.shapeHost = {
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
      liveDynUnionRefAdapter: (type) => this.liveDynUnionRefAdapter(type),
      dynPromiseAdapter: (type) => this.dynPromiseAdapter(type),
      isErrorClass: (name) => this.classMeta.get(name)?.root.def.name === "%Error",
      classRootOf: (name) => this.classMeta.get(name)?.root.def.name,
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
    this.stableGlobals = stableGlobals(mod);
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
    this.classMeta = buildClassGraph(mod, this.fnByName);
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

  private implSlotBorrowed(implFn: string): ReadonlySet<number> {
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

  ffiCallbackAdapter(binding: string, id: string): FfiCallbackAdapter {
    const adapter = this.ffiCallbackAdapters.get(`${binding}:${id}`);
    if (!adapter)
      throw new InternalCompilerError(`llvm emitter bug: no callback adapter for ${binding}:${id}`);
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
    this.declare(`declare void @scr_trap(ptr)`);
    const expired = this.cstr(
      "scriptc: native callback invoked outside its call-scoped lifetime\n",
    );
    const released = this.cstr("scriptc: native callback invoked outside its retained lifetime\n");
    for (const adapter of this.ffiCallbackAdapters.values()) {
      const cb = adapter.callback;
      if (adapter.tls !== null)
        globals.push(`@${adapter.tls} = internal thread_local global ptr null`);
      if (adapter.global !== null)
        globals.push(`@${adapter.global} = internal thread_local global ptr null`);
      if (adapter.table !== null) {
        globals.push(
          `@${adapter.table} = internal ${this.mod.workers ? "thread_local " : ""}global %ScrFfiTable zeroinitializer`,
        );
      }
      const params = cb.params.flatMap((param, i): string[] => {
        if (isFfiContextParam(param)) return [`ptr %ctx`];
        if (param === "string" || param === "bytes") {
          return [`ptr %a${i}`, `${this.sizeType} %a${i}_len`];
        }
        return [`${ffiNativeParamLl(param, this.ffiExtendNarrowIntegers)} %a${i}`];
      });
      if (cb.invoke === "foreign") {
        if (
          adapter.table === null ||
          !cb.params.some(isFfiContextParam) ||
          cb.returns !== "void" ||
          cb.params.some((param) => param === "i64" || param === "u64" || param === "pointer")
        ) {
          throw new InternalCompilerError(
            "llvm emitter bug: invalid foreign FFI callback descriptor",
          );
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
            case "f32":
            case "i8":
            case "u16":
            case "i16":
              this.declare(`declare double @scr_ffi_call_get_f64(ptr, ${this.sizeType})`);
              dispatchBody.push(
                `  %s${i} = call double @scr_ffi_call_get_f64(ptr %call, ${this.sizeType} ${i})`,
              );
              scriptArgs.push(`double %s${i}`);
              break;
            case "bool":
              this.declare(`declare zeroext i1 @scr_ffi_call_get_bool(ptr, ${this.sizeType})`);
              dispatchBody.push(
                `  %s${i} = call zeroext i1 @scr_ffi_call_get_bool(ptr %call, ${this.sizeType} ${i})`,
              );
              scriptArgs.push(`i1 %s${i}`);
              break;
            case "u8":
            case "u32":
            case "i32":
              this.declare(`declare double @scr_ffi_call_get_${param}(ptr, ${this.sizeType})`);
              dispatchBody.push(
                `  %s${i} = call double @scr_ffi_call_get_${param}(ptr %call, ${this.sizeType} ${i})`,
              );
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
                dispatchBody.push(
                  `  %s${i} = call ptr @scr_bytes_from_data(ptr %data${i}, ${this.sizeType} %len${i})`,
                );
              } else {
                this.declare(`declare ptr @scr_str_from_utf8_lossy(ptr, ${this.sizeType})`);
                dispatchBody.push(
                  `  %s${i} = call ptr @scr_str_from_utf8_lossy(ptr %data${i}, ${this.sizeType} %len${i})`,
                );
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
        for (const line of dispatchBody) defs.push(line);

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
            defs.push(
              `  call void @scr_ffi_call_copy_cstring(ptr %call, ${this.sizeType} ${i}, ptr %a${i})`,
            );
          } else if (param === "string" || param === "bytes") {
            this.declare(
              `declare void @scr_ffi_call_copy_${param}(ptr, ${this.sizeType}, ptr, ${this.sizeType})`,
            );
            defs.push(
              `  call void @scr_ffi_call_copy_${param}(ptr %call, ${this.sizeType} ${i}, ptr %a${i}, ${this.sizeType} %a${i}_len)`,
            );
          } else if (param === "f32" || param === "i8" || param === "u16" || param === "i16") {
            const nativeTy = ffiNativeTypeLl(param);
            const op = param === "f32" ? "fpext" : param === "u16" ? "uitofp" : "sitofp";
            this.declare(`declare void @scr_ffi_call_set_f64(ptr, ${this.sizeType}, double)`);
            defs.push(
              `  %wide${i} = ${op} ${nativeTy} %a${i} to double`,
              `  call void @scr_ffi_call_set_f64(ptr %call, ${this.sizeType} ${i}, double %wide${i})`,
            );
          } else {
            const nativeTy = ffiNativeTypeLl(param);
            this.declare(
              `declare void @scr_ffi_call_set_${param}(ptr, ${this.sizeType}, ${nativeTy})`,
            );
            defs.push(
              `  call void @scr_ffi_call_set_${param}(ptr %call, ${this.sizeType} ${i}, ${nativeTy} %a${i})`,
            );
          }
        }
        defs.push(`  call void @scr_ffi_post(ptr %call)`, `  ret void`, `}`, ``);
        continue;
      }
      defs.push(
        `define internal ${ffiNativeReturnLl(cb.returns, this.ffiExtendNarrowIntegers)} @${adapter.symbol}(${params.join(", ")}) ${FN_ATTRS} {`,
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
        ...this.pendingTestLines("%pending"),
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
        const message =
          param === "cstring"
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
          case "i64":
          case "u64":
          case "pointer": {
            const ty = ffiNativeTypeLl(param);
            this.declare(`declare ptr @scr_bigint_from_${param}(${ty})`);
            defs.push(`  %s${i} = call ptr @scr_bigint_from_${param}(${ty} %a${i})`);
            scriptArgs.push(`ptr %s${i}`);
            break;
          }
          case "f64":
            scriptArgs.push(`double %a${i}`);
            break;
          case "f32":
          case "i8":
          case "u16":
          case "i16": {
            const nativeTy = ffiNativeTypeLl(param);
            const op = param === "f32" ? "fpext" : param === "u16" ? "uitofp" : "sitofp";
            defs.push(`  %s${i} = ${op} ${nativeTy} %a${i} to double`);
            scriptArgs.push(`double %s${i}`);
            break;
          }
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
          ...(cb.lifetime === "retained"
            ? [`  call void @scr_closure_release_v(ptr %invoke_pin)`]
            : []),
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
        case "i64":
        case "u64":
        case "pointer": {
          const ty = ffiNativeTypeLl(cb.returns);
          this.declare(`declare ${ty} @scr_bigint_to_${cb.returns}(ptr)`);
          this.declare(`declare void @scr_bigint_release(ptr)`);
          defs.push(
            `  %out = call ${ty} @scr_bigint_to_${cb.returns}(ptr %result)`,
            `  call void @scr_bigint_release(ptr %result)`,
            `  ret ${ty} %out`,
          );
          break;
        }
        case "f64":
          defs.push(`  ret double %result`);
          break;
        case "f32":
          defs.push(`  %out = fptrunc double %result to float`, `  ret float %out`);
          break;
        case "bool":
          defs.push(`  %out = zext i1 %result to i8`, `  ret i8 %out`);
          break;
        case "u8":
        case "i8":
        case "u16":
        case "i16":
        case "u32":
          this.declare(`declare double @scr_bit_ushr(double, double)`);
          defs.push(
            `  %coerced = call double @scr_bit_ushr(double %result, double ${f64Lit(0)})`,
            `  %wide = fptoui double %coerced to i32`,
          );
          if (cb.returns !== "u32") {
            const nativeTy = ffiNativeTypeLl(cb.returns);
            defs.push(`  %out = trunc i32 %wide to ${nativeTy}`, `  ret ${nativeTy} %out`);
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
    return this.emitParts().join("\n");
  }

  emitParts(): string[] {
    const parts = limitInlineDynReleases(this.emitModuleParts());
    if (!this.executableTls) return parts;
    // A worker executable's thread-locals all live in the executable's own
    // TLS block: the program's internal ones, and the runtime's external
    // ones, because the runtime is always linked statically into the
    // executable. So on ELF they can all use the local-exec model: LLVM's
    // default general-dynamic sequence (relaxed by the linker to `mov %fs:0`
    // plus an add), and even initial-exec (relaxed to `mov $offset` plus an
    // indexed access), become one %fs-relative operand LLVM can fold into
    // loads and compares. Darwin's thread-local variables have one model.
    return parts.map((part) =>
      part
        .replace(
          /^(@[-$._A-Za-z0-9]+ = internal )thread_local global /gm,
          "$1thread_local(localexec) global ",
        )
        .replace(
          /^(@[-$._A-Za-z0-9]+ = external )thread_local global /gm,
          "$1thread_local(localexec) global ",
        ),
    );
  }

  private emitModuleParts(): string[] {
    // Function bodies first (the literal/unit/fn-value tables fill as they
    // emit), then the file assembles around them — the runtime ABI’s order.
    const fnDefs: string[] = [];
    for (const fn of this.mod.functions) {
      const def = this.emitFunction(fn);
      fnDefs.push(def);
      this.fnDefText.set(fn.name, def);
    }
    const errorViews: string[] = [];
    for (const property of ["name", "message"])
      if (this.mod.functions.some((fn) => fn.name === `%error.${property}.read`)) {
        this.declare(`declare void @scr_error_install_${property}_reader(ptr)`);
        errorViews.push(
          `  call void @scr_error_install_${property}_reader(ptr @${mangleFunction(`%error.${property}.read`)})`,
        );
      }
    for (const meta of this.classMeta.values()) {
      if (meta.def.runtime || meta.root.def.name !== "%Error") continue;
      const type: IrType = { kind: "object", className: meta.def.name };
      const adapter = this.liveDynRefAdapter(type);
      const rc = vAdapters(this.shapeHost, type);
      const key = typeKey(type);
      const name = `sc_error_view_${errorViews.length}`;
      this.resolveThunkDefs.push(
        `define internal ptr @${name}(ptr %v) ${FN_ATTRS} {`,
        `entry:`,
        `  %d = call ptr ${typedRefConstructor(this.shapeHost, type)}(ptr %v, ptr ${rc.retain}, ptr ${rc.release}, ptr ${this.cstr(key)}, ${this.sizeType} ${Buffer.byteLength(key, "utf8")}, ptr @${adapter.snapshot}, ptr ${adapter.commit})`,
        `  ret ptr %d`,
        `}`,
        ``,
      );
      this.declare(`declare void @scr_error_register_dyn(ptr, ptr)`);
      errorViews.push(
        `  call void @scr_error_register_dyn(ptr @${mangleVtInstance(meta.def.name)}, ptr @${name})`,
      );
    }
    const layouts = emitLlvmLayouts(
      this.shapeHost,
      this.mod,
      this.classMeta,
      this.classObjs,
      this.fnByName,
      (t) => this.llType(t),
      this.nullableFields,
      this.int32Slots,
    );
    const shapes = layouts.records;
    const classShapes = layouts.classes;
    const classObjDefs = layouts.classObjects;
    const wrappers = this.emitFnValueDefs();
    const asyncDefs = this.emitAsyncScaffolding();
    const ffiCallbacks = this.emitFfiCallbackDefs();
    const hasNoInlineRecordClone = [...this.recordCloneShapes].some(
      (shapeId) => (this.recordsById.get(shapeId)?.fields.length ?? 0) >= 16,
    );

    // Module globals, FIRST OCCURRENCE per id: a class-expression static
    // instantiated through several mixin applications registers one global
    // id several times (2041-mixin-values) — C's tentative definitions
    // accept the duplicates without an error, LLVM rejects redefinition, so the
    // storage AND the release emit once per id here.
    const seenGlobalIds = new Set<string>();
    const globals = (this.mod.globals ?? []).filter((g) => {
      if (seenGlobalIds.has(g.id)) return false;
      seenGlobalIds.add(g.id);
      return true;
    });
    // Refcounted globals release before main returns — the runtime ABI’s
    // sc_release_globals, keeping the RC audit's live count exact. Built
    // before the declaration table flushes (it adds the release symbols).
    // Two spellings with distinct temp names: the normal exit and the
    // uncaught-exception exit are separate blocks of the same function.
    // Interned function-value closures are IMMORTAL (rc == SIZE_MAX), so
    // an own-property table Object.defineProperties hung on one would
    // outlive the RC audit — release it with the globals (the runtime ABI’s
    // sc_release_globals tail). Only when the dispatch unit is even
    // linked (defineProps is the only writer).
    const runtimeFeatures = moduleRuntimeFeatures(this.mod);
    const fnValueProps = [...this.fnValues];
    if (fnValueProps.length > 0) this.declare(`declare void @scr_box_release(ptr)`);
    if (this.classObjs.size > 0) this.declare(`declare void @scr_classobj_clear_properties(ptr)`);
    const globalReleaseLines = (prefix: string): string[] => {
      const lines: string[] = [];
      globals.forEach((g, i) => {
        if (!isRefCounted(g.type)) return;
        lines.push(
          `  %${prefix}${i} = load ptr, ptr @${mangleGlobal(g.id)}`,
          `  call void ${releaseSym(this.shapeHost, g.type)}(ptr %${prefix}${i}) ; ${g.name}`,
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
      for (const name of this.classObjs.keys())
        lines.push(`  call void @scr_classobj_clear_properties(ptr @${mangleClassObj(name)})`);
      return lines;
    };
    // Exit listeners can read MODULE GLOBALS directly, so they must run
    // BEFORE the global releases (the runtime ABI’s runExitListeners
    // ordering — the atexit half becomes an idempotent no-op).
    const usesEvents = runtimeFeatures.processEvents;
    const usesChildProcess = runtimeFeatures.childProcess;
    const usesFsWatch = runtimeFeatures.fsWatch;
    // Stream-surface programs fill the loop's stream hook (the deferred
    // next-tick emissions) and the emitter's post-registration flow kick
    // before %main — scr_stream.c links only when the line is emitted
    // (native/executable.ts gates on the same predicate).
    const usesStream = runtimeFeatures.stream;
    // Net-surface programs fill the loop's net hooks (and the netSocket
    // handle-dispatch ops for the checked-dynamic boundary); http-surface
    // programs additionally stamp the httpReq/httpRes ops — the C main's
    // install lines, gated on the same predicates native/executable.ts links by.
    const usesNet = runtimeFeatures.net;
    const usesDgram = runtimeFeatures.dgram;
    const usesHttp2 = runtimeFeatures.http2;
    const usesHttp = runtimeFeatures.http;
    // Fetch-referencing programs register native fetch before main.
    // Runtime selection compiles scr_fetch.c on the same predicate.
    const usesFetch = runtimeFeatures.fetch;
    const snapshotsTlsCa = runtimeFeatures.tls || runtimeFeatures.tlsCa;
    // The process verdict has the same precedence as the C reference
    // emitter: node:test owns the final status when present; otherwise an
    // embedded process.exitCode owns it; ordinary programs return zero.
    const usesNodeTest = runtimeFeatures.nodeTest;
    // Declared NOW — the extern block flushes before main assembles.
    if (usesEvents) this.declare(`declare void @scr_events_install()`);
    if (usesChildProcess) this.declare(`declare void @scr_child_dyn_install()`);
    const childStreamBoxes =
      usesChildProcess &&
      usesStream &&
      this.classMeta.has("%Readable") &&
      this.classMeta.has("%Writable")
        ? [
            this.dyn.toDynHelper({ kind: "object", className: "%Readable" }),
            this.dyn.toDynHelper({ kind: "object", className: "%Writable" }),
          ]
        : null;
    if (childStreamBoxes) {
      this.declare(
        `@scr_stream_child_ops = external constant { ptr, ptr, ptr, ptr, ptr, ptr, ptr, ptr, ptr }`,
      );
      this.declare(`declare void @scr_child_dyn_streams_install(ptr, ptr, ptr)`);
    }
    if (usesFsWatch) this.declare(`declare void @scr_watch_install()`);
    if (this.ffiHasForeignCallback) this.declare(`declare void @scr_ffi_install()`);
    if (usesStream) this.declare(`declare void @scr_stream_install()`);
    if (usesNet) {
      this.declare(`declare void @scr_net_install()`);
      this.declare(`declare void @scr_net_dyn_install()`);
    }
    if (usesDgram) this.declare(`declare void @scr_dgram_install()`);
    if (usesHttp2) this.declare(`declare void @scr_http2_dyn_install()`);
    if (usesHttp) this.declare(`declare void @scr_http_dyn_install()`);
    if (usesFetch) this.declare(`declare void @scr_fetch_install()`);

    if (usesNodeTest) this.declare(`declare i32 @scr_test_exit_code()`);
    if (snapshotsTlsCa) {
      this.declare(`declare void @scr_tls_ca_install()`);
    }
    // Inline exit listeners run when something they must beat exists:
    // the refcounted-global releases, or the retained-FFI atexit ledger
    // sweep (a listener may legitimately release or pump a registration,
    // and only the inline call orders ahead of every atexit handler —
    // the runtime ABI’s runExitListeners stance). Plain event programs
    // with neither keep the atexit path, so their listener timing is
    // unchanged.
    const hasRefGlobals = globals.some((g) => isRefCounted(g.type)) || fnValueProps.length > 0;
    const inlineExitListeners =
      usesEvents && (this.mod.workers || hasRefGlobals || this.ffiHasRetainedCallback);
    this.declare(`declare i32 @scr_exit_code_hint_get()`);
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
    // The entry's exits release the module globals only where the thread
    // frees its heap when its script ends (scr_exit_frees: workers, and
    // builds that check for leaks); the main thread of other builds leaves
    // it to the operating system.
    const exitReleaseLines = (prefix: string): string[] => {
      const releases = globalReleaseLines(prefix);
      if (releases.length === 0) return releases;
      this.declare(`declare zeroext i1 @scr_exit_frees()`);
      return [
        `  %${prefix}.frees = call zeroext i1 @scr_exit_frees()`,
        `  br i1 %${prefix}.frees, label %${prefix}.release, label %${prefix}.kept`,
        `${prefix}.release:`,
        ...releases,
        `  br label %${prefix}.kept`,
        `${prefix}.kept:`,
      ];
    };
    const globalReleases = exitReleaseLines("g");
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
      this.ffiHasForeignCallback ||
      this.mod.functions.some((f) => f.async === true || f.generator !== undefined);
    const uncaughtReleases = entryMayThrow && !asyncEntry ? exitReleaseLines("gu") : [];
    const loopReleasesU = runsLoop ? exitReleaseLines("gl") : [];
    const loopReleasesR = runsLoop ? exitReleaseLines("gr") : [];
    const topRejectReleases = asyncEntry ? exitReleaseLines("gt") : [];
    const topPendingReleases = asyncEntry ? exitReleaseLines("gp") : [];
    const loopReportedReleases = runsLoop ? exitReleaseLines("gq") : [];
    // main's epilogues read the flag / the loop entry points — declared
    // HERE, before the extern block flushes. They run once, so they keep
    // the out-of-line scr_exc_pending call; per-call checks inline the
    // test (pendingTestLines).
    if (entryMayThrow || runsLoop) this.declare(`declare zeroext i1 @scr_exc_pending()`);
    if (runsLoop) {
      this.declare(`declare zeroext i1 @scr_loop_run(ptr)`);
      if (this.mod.commonJsEntry === true) this.declare(`declare void @scr_loop_commonjs_entry()`);
      this.declare(`declare zeroext i1 @scr_report_unhandled_rejections()`);
      this.declare(`declare void @scr_discard_unhandled_rejections()`);
    }
    if (asyncEntry) {
      this.declare(`declare i32 @scr_promise_finish_top_level(ptr)`);
      this.declare(`declare void @scr_promise_rethrow_top_level(ptr)`);
      this.declare(`declare void @scr_promise_release(ptr)`);
      this.declare(`declare void @scr_exit_code_note(i32)`);
    }
    const topPendingExitLines = (): string[] => {
      if (!asyncEntry) return [];
      const lines: string[] = [];
      // finish_top_level noted 13 unless the program set process.exitCode.
      // A failed node:test run outranks either before exit listeners run.
      if (usesNodeTest) {
        lines.push(
          `  %tla_program_exit = call i32 @scr_test_exit_code()`,
          `  %tla_program_exit_zero = icmp eq i32 %tla_program_exit, 0`,
          `  %tla_hint = call i32 @scr_exit_code_hint_get()`,
          `  %tla_exit_status = select i1 %tla_program_exit_zero, i32 %tla_hint, i32 %tla_program_exit`,
          `  call void @scr_exit_code_note(i32 %tla_exit_status)`,
        );
      }
      for (const line of exitListenerLines("xp")) lines.push(line);
      for (const line of topPendingReleases) lines.push(line);
      // An exit listener may set process.exitCode again, as in Node.
      lines.push(
        `  %tla_exit_code = call i32 @scr_exit_code_hint_get()`,
        `  ret i32 %tla_exit_code`,
      );
      return lines;
    };
    // LIBRARY mode: the runtime entry points the generated library
    // symbols delegate to — declared before the extern block flushes.
    if (this.mod.lib !== undefined) {
      if (this.wasi) {
        this.declare(`declare ptr @malloc(${this.sizeType})`);
        this.declare(`declare void @free(ptr)`);
      }
      this.declare(`declare void @scr_library_entry(i1 zeroext, ptr)`);
      this.declare(`declare void @scr_library_reset()`);
      this.declare(`declare void @scr_library_check_exc()`);
      this.declare(`declare void @scr_library_set_sink(ptr, ptr)`);
      this.declare(`declare void @scr_library_callback_entry_guard(ptr)`);
      this.declare(`declare void @scr_library_arena_reset()`);
      this.declare(`declare void @scr_library_collect()`);
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
    const helpers = [
      ...this.helperDefs(),
      ...emitArraySearchHelpers(this.arraySearchKinds, this.sizeType, (line) => this.declare(line)),
      ...emitClassMembershipHelper(this.classMeta, this.sizeType),
      ...(this.publishWalkersCache?.defs() ?? []),
      ...this.publishedClassNamesDefs(),
      ...(this.regions?.moduleDefs() ?? []),
    ];
    if (this.constantNumericTables.size > 0)
      this.declare(`declare double @scr_arr_get_number(ptr, double)`);
    // Native matchers of the regex literals inside the compiled subset.
    const regexMatchers = new Map<string, RegexMatcherCode>();
    for (const [key, re] of this.regexInstances) {
      const code = compileRegexMatcher(
        `${re.sym}_match`,
        re.pattern,
        re.flags,
        this.sizeType,
        !this.wasi,
      );
      if (code === null) continue;
      regexMatchers.set(key, code);
      for (const decl of code.decls) this.declare(decl);
    }

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
      `%ScrClosure = type { ${this.sizeType}, ptr, ${this.sizeType}, ptr, i32, i32, ptr, ptr }`,
      `%ScrFfiTable = type { ptr, ${this.sizeType}, ${this.sizeType}, ptr, i8, ptr, ptr, ${this.sizeType}, ${this.sizeType}, ${this.sizeType}, ptr, ptr }`,
      `%ScrRegex = type { ${this.sizeType}, ptr, ptr, ptr, double, ptr, ptr, ptr }`,
      // ScrArr mirrors scr_runtime.h field-for-field: { rc, len, cap, elem,
      // cyc, spare, filled, ops, data, present, ext } (field numbers in
      // SCR_ARR_FIELD), where filled bounds the hole-free prefix, ops points at the element type's constant RC descriptor
      // (%ScrArrOps, SCR_ELEM_REF only) and ext at the out-of-line sparse,
      // property and metadata storage (NULL until first used). Live dynamic
      // stream commits swap its dense, presence and out-of-line storage while
      // preserving the target object's identity.
      `%ScrArr = type { ${this.sizeType}, ${this.sizeType}, ${this.sizeType}, i8, i8, i16, i32, ptr, ptr, ptr, ptr }`,
      `%ScrArrOps = type { ptr, ptr, ptr }`,
      // The ScrMap prefix { rc, key_kind, val_kind, traced } — the inline
      // RC fast paths test the traced byte (shapes.ts).
      ...(this.rcHelpers === null ? [] : [`%ScrMapRc = type { ${this.sizeType}, i8, i8, i8 }`]),
      // The complete ScrMap and its { key, val, hash } entry, read by the
      // inline number-key lookup (sc_map_entry_f64) and the inline
      // iteration steps (sc_map_iter_entry): field 8 is the i32 entry
      // count, field 10 the i64 absent-key filter, entries is field 11,
      // nbuckets and buckets fields 13 and 14, the direct index and its i32
      // length fields 15 and 16.
      ...(this.decls.has(NUMBER_MAP_ENTRY_DECL) ||
      this.decls.has(STRING_MAP_ENTRY_DECL) ||
      this.decls.has(MAP_ITER_DECL)
        ? [
            `%ScrMapIx = type { ${this.sizeType}, i8, i8, i8, i8, i32, ptr, ptr, i32, i32, i64, ptr, i32, i32, ptr, ptr, i32, i32 }`,
          ]
        : []),
      // String-keyed reference reads load the value slot of the entry
      // scr_map_entry_str returns (map-number-lookup.ts).
      ...(this.decls.has(NUMBER_MAP_ENTRY_DECL) ||
      this.decls.has(STRING_MAP_ENTRY_DECL) ||
      this.decls.has(MAP_ITER_DECL)
        ? [`%ScrMapEntry = type { i64, i64, i64 }`]
        : []),
      // The runtime error prefix { rc, vt, name, message, code, cause } and the
      // class-object shape { rc, pre, post, ctor, name } — field reads on
      // builtin errors and classval loads GEP through these.
      `%ScrError = type { ${this.sizeType}, ptr, ptr, ptr, ptr, ptr, i8, i8, i8, i8, i8, ptr, ptr }`,
      `%ScrClassObj = type { ${this.sizeType}, ${this.sizeType}, ${this.sizeType}, ptr, ptr, ${this.sizeType}, ${this.sizeType}, ptr, ptr }`,
      // The runtime emitter prefix { rc, vt, reg, cls } — user subclasses
      // embed it (classes.ts), and bare-emitter GEPs address through it.
      `%ScrEmitter = type { ${this.sizeType}, ptr, ptr, ptr }`,
      // The runtime stream layout { rc, vt, reg, cls, st } — one struct
      // for all five stream classes; stream subclasses embed it.
      `%ScrStream = type { ${this.sizeType}, ptr, ptr, ptr, ptr }`,
      // The EventTarget and Event subclass prefixes { rc, vt, state, cls }.
      ...(this.classMeta.has(RUNTIME_EVENT_TARGET_CLASS)
        ? [`%ScrEventTargetObj = type { ${this.sizeType}, ptr, ptr, ptr }`]
        : []),
      ...(this.classMeta.has(RUNTIME_EVENT_CLASS)
        ? [`%ScrEventObj = type { ${this.sizeType}, ptr, ptr, ptr }`]
        : []),
      // The catch-binding snapshot box { rc, kind, f64, b, payload,
      // retain_fn, release_fn, trace_fn } — caughtTest kind reads and
      // caughtNarrow payload extraction GEP through it (offsets match
      // scr_runtime.h's natural alignment: kind at 8, f64 at 16, b at 24,
      // payload at 32).
      `%ScrCaught = type { ${this.sizeType}, i32, double, i8, ptr, ptr, ptr, ptr }`,
      // ScrBytes { rc, len, elem(i32+pad), data, backing, brands, shared }. Indexed
      // typed-array access GEPs through this directly: the IR type already
      // fixes elem, so the hot path needs neither a runtime kind load nor
      // the generic scr_bytes_get/set call.
      `%ScrBytes = type { ${this.sizeType}, ${this.sizeType}, i32, ptr, ptr, i8, i8, i8, i8, ptr }`,
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
      // A generator's prefix { rc, receiver, fiber, state, out } and its
      // value slot { kind, f64, b, payload, release_fn } (scr_async.c pins
      // both): number and boolean yields and drives address OUT directly.
      ...(this.usesGenSlots
        ? [
            `%ScrGenSlot = type { i32, double, i8, ptr, ptr }`,
            `%ScrGenHead = type { ${this.sizeType}, ptr, ptr, i32, %ScrGenSlot }`,
          ]
        : []),
    ];
    for (const line of shapes.typeDefs) out.push(line);
    for (const line of classShapes.typeDefs) out.push(line);
    // Thread-instanced library state (abi.instance_per_thread): the
    // program TU's mutable globals — module globals, run-once guards, the
    // lazily-compiled regex literal caches — and the runtime globals its
    // init stamps live in thread-local storage, matching the runtime
    // objects compiled with -DSCR_THREAD_INSTANCES. Immutable interned
    // data (string literals, unit arms, template arrays, vtables) stays
    // shared.
    const tl =
      this.mod.workers === true || this.mod.lib?.threadInstances === true ? "thread_local " : "";
    out.push(
      ``,
      `@scr_error_vts = external ${tl}global [${RUNTIME_ERROR_CLASSES.size} x %ScrVt]`,
      `declare void @scr_init()`,
      `declare void @scr_lib_init(i32, ptr)`,
      ...(this.mod.workers ? [`declare void @scr_runtime_workers_v8()`] : []),
      ...(this.stackChecks?.size ? [`declare void @scr_stack_guard_init()`] : []),
      ...(this.runtimeAbiMarker && this.mod.lib === undefined
        ? [`declare void @${RUNTIME_ABI_MARKER}()`]
        : []),
      // Overrides the runtime's weak default (scr_lib.c).
      ...(this.detachedExit && this.mod.lib === undefined
        ? [`@scr_detached_exit = constant i8 1`]
        : []),
    );
    for (const d of this.decls) out.push(d);
    out.push(``);
    const flushedDecls = new Set(this.decls);
    {
      const tl =
        this.mod.workers === true || this.mod.lib?.threadInstances === true ? "thread_local " : "";
      for (let site = 0; site < this.dynReadIcSites; site++)
        out.push(
          `@sc_dyn_read_ic_${site} = internal ${tl}global { ptr, ${this.sizeType}, ${this.sizeType}, ptr } zeroinitializer`,
        );
    }
    for (const table of this.constantNumericTables.values()) {
      const n = table.values.length;
      let tableTmp = 0;
      const tableIndex = exactIndexLines("%i", String(n), "i64", () => `%ix${tableTmp++}`);
      out.push(
        `@${table.symbol} = private constant [${n} x double] [${table.values.map((v) => `double ${f64Lit(v)}`).join(", ")}]`,
        `define internal double @${table.symbol}_get(ptr %a, double %i) alwaysinline #0 {`,
        `entry:`,
        `  %initialized = icmp ne ptr %a, null`,
        ...tableIndex.lines.map((line) => `  ${line}`),
        `  %safe = and i1 %initialized, ${tableIndex.ok}`,
        `  br i1 %safe, label %read, label %fallback`,
        `read:`,
        `  %slot = getelementptr inbounds [${n} x double], ptr @${table.symbol}, i64 0, i64 ${tableIndex.wide}`,
        `  %value = load double, ptr %slot`,
        `  ret double %value`,
        `fallback:`,
        `  %generic = call double @scr_arr_get_number(ptr %a, double %i)`,
        `  ret double %generic`,
        `}`,
        ``,
      );
    }
    for (const [text, lit] of this.literals) {
      // Immortal interned ScrStr: { rc = SIZE_MAX, len, cap = len, bytes\0 } —
      // the runtime ABI’s static table, retain/release skip rc == SIZE_MAX.
      // 64-bit (little-endian) targets split the capacity word: the high
      // half carries the precomputed Map key hash (SCR_STR_HASH_CACHE).
      // Bit 31 marks all-ASCII literals (SCR_STR_ASCII_BIT) on every target.
      const capWord =
        this.sizeType === "i64"
          ? literalCapWord(wtf8Bytes(text))
          : literalCapWord32(wtf8Bytes(text));
      out.push(
        `@${lit.sym} = internal global { ${this.sizeType}, ${this.sizeType}, ${this.sizeType}, [${lit.len + 1} x i8] } ` +
          `{ ${this.sizeType} -1, ${this.sizeType} ${lit.len}, ${this.sizeType} ${capWord}, [${lit.len + 1} x i8] c"${llStrBytes(text)}" }`,
      );
    }
    if (this.literals.size > 0) out.push(``);
    for (const lit of this.bigintLiterals.values()) {
      // Immortal ScrBigInt: { rc = SIZE_MAX, len, sign, cap, limbs } with
      // pointer-sized little-endian limbs (scr_bigint.c); zero keeps one
      // zero limb so limb 0 is always readable.
      const size = this.sizeType;
      const limbBits = size === "i64" ? 64n : 32n;
      const mask = (1n << limbBits) - 1n;
      const limbs: string[] = [];
      for (let m = lit.value < 0n ? -lit.value : lit.value; m > 0n; m = m >> limbBits) {
        limbs.push(`${size} ${m & mask}`);
      }
      const len = limbs.length;
      if (len === 0) limbs.push(`${size} 0`);
      const sign = lit.value < 0n ? -1 : lit.value > 0n ? 1 : 0;
      out.push(
        `@${lit.sym} = internal global { ${size}, ${size}, i32, i32, [${limbs.length} x ${size}] } ` +
          `{ ${size} -1, ${size} ${len}, i32 ${sign}, i32 ${limbs.length}, [${limbs.length} x ${size}] [${limbs.join(", ")}] }`,
      );
    }
    if (this.bigintLiterals.size > 0) out.push(``);
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
    for (const [unionId, sym] of this.retypeGuards) {
      // Thread-local like module globals: a thread's cast caches hold only
      // its own boxes. Never written, the flag folds to false.
      out.push(`@${sym} = internal ${tl}global i8 0 ; ${unionId} boxes in a cast cache`);
    }
    if (this.retypeGuards.size > 0) out.push(``);
    for (const [unionId, sym] of this.absentInstances) {
      // One immortal ABSENT field-slot instance per undefined-armed union:
      // the undefined arm's tag with payload 1 (ordinary unit instances
      // carry 0). Every tag reader sees undefined; recordHas and the
      // field reads compare tag and payload, never the address, so the
      // per-object copies of separately compiled units agree.
      const tag = undefinedArmTag({ kind: "union", unionId }, this.unionsById);
      out.push(
        `@${sym} = internal global %ScrUnion { ${this.sizeType} -1, i32 ${tag}, ptr null, ptr null, ptr null, i64 ${ABSENT_FIELD_PAYLOAD} } ; ${unionId} absent field`,
      );
    }
    if (this.absentInstances.size > 0) out.push(``);
    if (this.needsUnionNone)
      out.push(
        `@sc_union_none = internal constant %ScrUnion zeroinitializer ; NULL union dummy read by inline stores`,
        ``,
      );
    if (this.nullableUnions.usesNullSentinel) {
      // `null` in every `C | null | undefined` union (NULL is undefined):
      // one module-scope immortal object like the ABSENT sentinel.
      const S = this.sizeType;
      out.push(
        `${NULLABLE_NULL} = internal global { ${S}, ${S}, ${S}, ${S} } { ${S} -1, ${S} 0, ${S} 0, ${S} 0 } ; nullable null arm`,
        ``,
      );
    }
    if (this.needsNullableAbsent) {
      // The ABSENT field-slot state of every nullable-pointer union: one
      // module-scope immortal object (rc == SIZE_MAX), distinct from NULL
      // (undefined) and from every instance. RC entry points and the
      // collector skip it like any immortal; field reads compare its address.
      const S = this.sizeType;
      out.push(
        `${NULLABLE_ABSENT} = internal global { ${S}, ${S}, ${S}, ${S} } { ${S} -1, ${S} 0, ${S} 0, ${S} 0 } ; nullable absent field`,
        ``,
      );
    }
    for (const [key, re] of this.regexInstances) {
      // One immortal ScrRegex per (pattern, flags) literal, pointing at
      // the interned source/flags strings. The bc and translated-program
      // slots start null (lazy compile, cached by the runtime) — a mutable
      // global, not constant. The last slot is the build-time matcher.
      const matcher = regexMatchers.has(key) ? `@${re.sym}_match` : "null";
      out.push(
        `@${re.sym} = internal ${tl}global %ScrRegex { ${this.sizeType} -1, ptr ${re.src}, ptr ${re.fl}, ptr null, double 0.0, ptr null, ptr null, ptr ${matcher} } ; ${key.replace(/\n/g, "\\n")}`,
      );
    }
    if (this.regexInstances.size > 0) out.push(``);
    for (const code of regexMatchers.values()) out.push(...code.lines, ``);
    for (const [, inst] of this.templateStringsInstances) {
      // One immortal ScrArr per tagged-template site: a [N x ptr] data
      // global of interned cooked-string literals, and the ScrArr header
      // over it (rc == SIZE_MAX, len == cap == filled, SCR_ELEM_STR = 2,
      // no REF entry points). Every dense slot is present; reads retain
      // immortal strings — a no-op.
      const n = inst.slots.length;
      const present =
        n === 0 ? "zeroinitializer" : `[ ${inst.slots.map(() => "i8 1").join(", ")} ]`;
      out.push(
        `@${inst.sym}_data = internal constant [${n} x ptr] [ ${inst.slots.map((s) => `ptr ${s}`).join(", ")} ]`,
        `@${inst.sym}_present = internal constant [${n} x i8] ${present}`,
        `@${inst.sym} = internal global %ScrArr { ${this.sizeType} -1, ${this.sizeType} ${n}, ${this.sizeType} ${n}, i8 2, i8 0, i16 0, i32 ${n}, ptr null, ptr @${inst.sym}_data, ptr @${inst.sym}_present, ptr null }`,
      );
    }
    if (this.templateStringsInstances.size > 0) out.push(``);
    for (const [text, c] of this.cstrs) {
      // NUL-terminated byte-array constants for scr_jb_puts and indentation.
      out.push(`@${c.sym} = internal constant [${c.len + 1} x i8] c"${llStrBytes(text)}"`);
    }
    if (this.cstrs.size > 0) out.push(``);
    for (const [body, sym] of this.mapOpsConsts) {
      out.push(`@${sym} = internal constant { ptr, ptr, ptr, ptr, ptr, ptr, ptr } { ${body} }`);
    }
    if (this.mapOpsConsts.size > 0) out.push(``);

    for (const line of ffiCallbacks.globals) out.push(line);
    if (ffiCallbacks.globals.length > 0) out.push(``);
    for (const g of globals) {
      const ty = this.llType(g.type);
      const zero = ty === "double" ? f64Lit(0) : ty === "ptr" ? "null" : "false";
      const debug = this.debug?.global(g);
      out.push(
        `@${mangleGlobal(g.id)} = internal ${tl}global ${ty} ${zero}${debug ? `, !dbg ${debug}` : ""} ; ${g.name}`,
      );
    }
    if (globals.length > 0) out.push(``);
    for (const line of helpers) out.push(line);
    for (const line of ffiCallbacks.defs) out.push(line);
    for (const line of shapes.defs) out.push(line);
    for (const line of classShapes.defs) out.push(line);
    for (const line of classObjDefs) out.push(line);
    for (const line of this.walkers.defs) out.push(line);
    for (const line of this.dyn.defs) out.push(line);
    for (const line of wrappers) out.push(line);
    for (const line of asyncDefs) out.push(line);
    for (const line of this.resolveThunkDefs) out.push(line);
    out.push(fnDefs[0] ?? "");
    for (let i = 1; i < fnDefs.length; i++) out.push("", fnDefs[i]!);
    out.push("");

    // main(): scr_init, the program-dependent error-vt interval stamps,
    // scr_lib_init(argc, argv), then the entry function. An uncaught
    // exception escaping top-level code prints and exits 1 (Node).
    // The exception epilogue is emitted when the entry may throw.
    const stamps: string[] = [...errorViews];
    for (const iv of this.errorIntervals) {
      const fields: [number, number][] = [
        [0, iv.pre],
        [1, iv.post],
      ];
      for (const [field, value] of fields) {
        stamps.push(
          `  store ${this.sizeType} ${value}, ptr getelementptr inbounds ([${RUNTIME_ERROR_CLASSES.size} x %ScrVt], ptr @scr_error_vts, i64 0, i64 ${iv.kind}, i32 ${field})${field === 1 ? ` ; ${iv.lib}` : ""}`,
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
      out.push(`@${iv.vt} = external ${tl}global %ScrVt`);
      stamps.push(
        `  store ${this.sizeType} ${iv.pre}, ptr getelementptr inbounds (%ScrVt, ptr @${iv.vt}, i64 0, i32 0)`,
        `  store ${this.sizeType} ${iv.post}, ptr getelementptr inbounds (%ScrVt, ptr @${iv.vt}, i64 0, i32 1) ; ${iv.lib}`,
      );
    }
    if (this.streamIntervals.length > 0) out.push(``);
    if ([...this.literals.keys(), ...this.cstrs.keys()].some(hasLoneSurrogate)) {
      // The runtime skips surrogate work until a lone surrogate may exist
      // (scr_wtf8_any); its own producers note one, and literals do here.
      out.push(`declare void @scr_wtf8_note()`, ``);
      stamps.push(`  call void @scr_wtf8_note()`);
    }
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
      out.push(
        `declare void @scr_exc_print_uncaught()`,
        `declare zeroext i1 @scr_exc_handle_uncaught(i1 zeroext)`,
        ``,
      );
    }
    if (this.mod.lib !== undefined) {
      // LIBRARY mode: no @main — the profile-declared external
      // symbols specified by the library IR instead.
      for (const line of this.emitLibDefs(globals, globalReleaseLines, stamps)) out.push(line);
      out.push(...this.inlineRcTail(flushedDecls));
      out.push(`attributes #0 = { sanitize_address }`);
      if (this.usesCoroutines) out.push(`attributes #1 = { sanitize_address presplitcoroutine }`);
      if (hasNoInlineRecordClone) out.push(`attributes #2 = { noinline sanitize_address }`);
      out.push(``);
      out.push(...this.fieldAliasMetadata());
      if (this.debug !== null) out.push(this.debug.render());
      return out;
    }
    out.push(
      `define i32 @${this.mod.workers ? "sc_context_entry" : this.wasi ? "__main_argc_argv" : "main"}(i32 %argc, ptr %argv) ${FN_ATTRS} {`,
      `entry:`,
      ...(this.runtimeAbiMarker ? [`  call void @${RUNTIME_ABI_MARKER}()`] : []),
      ...(this.mod.workers ? [`  call void @scr_runtime_workers_v8()`] : []),
      `  call void @scr_init()`,
      // Each context (the main thread, every worker) installs its stack
      // guard before running compiled code that checks it.
      ...(this.stackChecks?.size ? [`  call void @scr_stack_guard_init()`] : []),
      ...stamps,
      // Event-surface programs (signal/exit listeners) fill the loop's
      // nullable event hooks before %main — scr_events.c links only when
      // this line is emitted (native/executable.ts gates on the same predicate).
      ...(usesEvents ? [`  call void @scr_events_install()`] : []),
      ...(usesChildProcess ? [`  call void @scr_child_dyn_install()`] : []),
      ...(childStreamBoxes
        ? [
            `  call void @scr_child_dyn_streams_install(ptr @scr_stream_child_ops, ptr @${childStreamBoxes[0]}, ptr @${childStreamBoxes[1]})`,
          ]
        : []),
      // fs.watch programs fill the loop's watch hooks the same way —
      // scr_watch.c links only when this line is emitted.
      ...(usesFsWatch ? [`  call void @scr_watch_install()`] : []),
      ...(this.ffiHasForeignCallback ? [`  call void @scr_ffi_install()`] : []),
      ...(snapshotsTlsCa ? [`  call void @scr_tls_ca_install()`] : []),
      ...(usesFetch ? [`  call void @scr_fetch_install()`] : []),
      ...(usesNet ? [`  call void @scr_net_install()`, `  call void @scr_net_dyn_install()`] : []),
      ...(usesHttp ? [`  call void @scr_http_dyn_install()`] : []),
      ...(usesDgram ? [`  call void @scr_dgram_install()`] : []),
      ...(usesHttp2 ? [`  call void @scr_http2_dyn_install()`] : []),
      ...(usesStream ? [`  call void @scr_stream_install()`] : []),
      `  call void @scr_lib_init(i32 %argc, ptr %argv)`,
      ...(asyncEntry
        ? [`  %top = call ptr @${mangleAsyncSpawn(this.mod.entry)}()`]
        : [`  call void @${mangleFunction(this.mod.entry)}()`]),
      // Uncaught exception from top-level code: Node exits 1.
      ...(entryMayThrow && !asyncEntry
        ? [
            `  %exc = call zeroext i1 @scr_exc_pending()`,
            `  br i1 %exc, label %uncaught, label %ok`,
            `uncaught:`,
            `  %handled = call zeroext i1 @scr_exc_handle_uncaught(i1 false)`,
            `  br i1 %handled, label %ok, label %fatal`,
            `fatal:`,
            `  call void @scr_exc_print_uncaught()`,
            ...exitListenerLines("xu"),
            ...uncaughtReleases,
            `  %failure_code_0 = call i32 @scr_exit_code_hint_get()`,
            `  ret i32 %failure_code_0`,
            `ok:`,
          ]
        : []),
      // The event loop runs to exhaustion (microtasks before timers). A
      // throw escaping a timer callback and unhandled promise rejections
      // both exit 1, like Node — the C main's loop block exactly.
      ...(runsLoop
        ? [
            ...(this.mod.commonJsEntry === true ? [`  call void @scr_loop_commonjs_entry()`] : []),
            `  %loop_rejection = call zeroext i1 @scr_loop_run(ptr ${asyncEntry ? "%top" : "null"})`,
            `  %lexc = call zeroext i1 @scr_exc_pending()`,
            `  br i1 %lexc, label %luncaught, label %lok`,
            `luncaught:`,
            `  call void @scr_exc_print_uncaught()`,
            ...(asyncEntry ? [`  call void @scr_promise_release(ptr %top)`] : []),
            ...exitListenerLines("xl"),
            ...loopReleasesU,
            `  %failure_code_1 = call i32 @scr_exit_code_hint_get()`,
            `  ret i32 %failure_code_1`,
            `lok:`,
            `  br i1 %loop_rejection, label %lreported, label %lclean`,
            `lreported:`,
            `  call void @scr_discard_unhandled_rejections()`,
            ...(asyncEntry ? [`  call void @scr_promise_release(ptr %top)`] : []),
            ...exitListenerLines("xq"),
            ...loopReportedReleases,
            `  %failure_code_2 = call i32 @scr_exit_code_hint_get()`,
            `  ret i32 %failure_code_2`,
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
                  `  %failure_code_3 = call i32 @scr_exit_code_hint_get()`,
                  `  ret i32 %failure_code_3`,
                  `tla_not_rejected:`,
                  `  call void @scr_promise_release(ptr %top)`,
                ]
              : []),
            `  %rej = call zeroext i1 @scr_report_unhandled_rejections()`,
            `  br i1 %rej, label %lrej, label %lrok`,
            `lrej:`,
            ...exitListenerLines("xr"),
            ...loopReleasesR,
            `  %failure_code_4 = call i32 @scr_exit_code_hint_get()`,
            `  ret i32 %failure_code_4`,
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
        : [`  %native_exit = call i32 @scr_exit_code_hint_get()`, `  ret i32 %native_exit`]),
      `}`,
      ``,
      ...this.inlineRcTail(flushedDecls),
      // sanitize_address is inert under the plain pipeline; the sanitized
      // lane's -fsanitize=address link activates instrumentation over the
      // emitted functions too (the runtime TUs get theirs from clang).
      `attributes #0 = { sanitize_address }`,
      ...(this.usesCoroutines ? [`attributes #1 = { sanitize_address presplitcoroutine }`] : []),
      ...(hasNoInlineRecordClone ? [`attributes #2 = { noinline sanitize_address }`] : []),
      ``,
    );
    if (this.mod.workers) {
      out.push(
        `declare void @scr_context_cleanup()`,
        `declare i32 @scr_worker_argc()`,
        `declare ptr @scr_worker_argv()`,
        `define i32 @sc_worker_entry(i32 %root) ${FN_ATTRS} {`,
        `entry:`,
        `  %argc = call i32 @scr_worker_argc()`,
        `  %argv = call ptr @scr_worker_argv()`,
        `  %result = call i32 @sc_context_entry(i32 %argc, ptr %argv)`,
        `  ret i32 %result`,
        `}`,
        `define i32 @main(i32 %argc, ptr %argv) ${FN_ATTRS} {`,
        `entry:`,
        `  %result = call i32 @sc_context_entry(i32 %argc, ptr %argv)`,
        `  call void @scr_context_cleanup()`,
        `  ret i32 %result`,
        `}`,
      );
    }
    out.push(...this.fieldAliasMetadata());
    if (this.debug !== null) out.push(this.debug.render());
    return out;
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
      out.push(
        `${symConst(sym)} = internal constant [${Buffer.byteLength(sym, "utf8") + 1} x i8] c"${llStrBytes(sym)}"`,
      );
    };
    emitSymConst(lib.initSymbol);
    emitSymConst(lib.sinkRegisterSymbol);
    if (lib.callbackRegisterSymbol !== null && lib.callbackRegisterSymbol !== undefined)
      emitSymConst(lib.callbackRegisterSymbol);
    if (lib.resultResetSymbol !== null) emitSymConst(lib.resultResetSymbol);
    if (lib.collectSymbol !== null) emitSymConst(lib.collectSymbol);
    for (const e of lib.exports) emitSymConst(e.symbol);
    out.push(``);
    if (this.wasi) {
      for (const symbol of ["scriptc_alloc", "scriptc_free"]) emitSymConst(symbol);
      out.push(
        `define ptr @scriptc_alloc(i32 %size) ${FN_ATTRS} {`,
        `entry:`,
        `  call void @scr_library_entry(i1 zeroext false, ptr ${symConst("scriptc_alloc")})`,
        `  %p = call ptr @malloc(i32 %size)`,
        `  ret ptr %p`,
        `}`,
        ``,
        `define void @scriptc_free(ptr %p) ${FN_ATTRS} {`,
        `entry:`,
        `  call void @scr_library_entry(i1 zeroext false, ptr ${symConst("scriptc_free")})`,
        `  call void @free(ptr %p)`,
        `  ret void`,
        `}`,
        ``,
      );
    }
    // The runtime detected-trap overlay table (scr_runtime.h declares it,
    // the library trap funnel consults it): flat code/teaching/remediation
    // triples, one per runtime trap code (SC4013–SC4019) the profile
    // declares text for. The funnel assembles the structured sink message.
    // The empty table still defines the symbols the funnel links against.
    const ovlCells: string[] = [];
    lib.trapOverlays.forEach((o, i) => {
      const cell = (name: string, text: string | undefined): void => {
        if (text === undefined) {
          ovlCells.push("ptr null");
          return;
        }
        const sym = `@sc_lib_ovl_${i}_${name}`;
        out.push(
          `${sym} = internal constant [${Buffer.byteLength(text, "utf8") + 1} x i8] c"${llStrBytes(text)}"`,
        );
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
      // scr_library_cb_require operands), and the registration function:
      // a pure store dispatch
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
      for (const line of emitLibraryIdentityLines(lib.identity, FN_ATTRS)) out.push(line);
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
    for (const e of lib.exports) {
      const params: string[] = [];
      const body: string[] = [
        `  call void @scr_library_entry(i1 zeroext ${autoReset ? "true" : "false"}, ptr ${symConst(e.symbol)})`,
      ];
      const args: string[] = [];
      if (e.inboundBytesTrap !== undefined) {
        // The bytes-in helper's trap message: the compiler-assembled
        // structured trap-teaching form (0x01 text 0x1F SC4012 0x1F symbol
        // [0x1F remediation]) consumed by the runtime sink.
        const trapBytes = Buffer.byteLength(e.inboundBytesTrap, "utf8");
        out.push(
          `@sc_lib_bytes_trap_${e.symbol} = internal constant [${trapBytes + 1} x i8] c"${llStrBytes(e.inboundBytesTrap)}"`,
          ``,
        );
      }
      if (e.inboundIntTrap !== undefined) {
        // The i64/u64-in helpers' host-contract trap message (ask 4): an
        // inbound integer past ±(2^53−1) cannot ride f64 exactly. Same
        // assembled structured form, same SC4012 code, same
        // emission-invariance argument as the bytes trap.
        const trapBytes = Buffer.byteLength(e.inboundIntTrap, "utf8");
        out.push(
          `@sc_lib_int_trap_${e.symbol} = internal constant [${trapBytes + 1} x i8] c"${llStrBytes(e.inboundIntTrap)}"`,
          ``,
        );
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
            // the value cannot ride f64 without rounding).
            params.push(`i64 %a${i}`);
            body.push(
              `  %c${i} = call double @scr_library_i64_in(i64 %a${i}, ptr @sc_lib_int_trap_${e.symbol})`,
            );
            args.push(`double %c${i}`);
            break;
          case "u64":
            params.push(`i64 %a${i}`);
            body.push(
              `  %c${i} = call double @scr_library_u64_in(i64 %a${i}, ptr @sc_lib_int_trap_${e.symbol})`,
            );
            args.push(`double %c${i}`);
            break;
          case "string":
            params.push(`ptr %a${i}_ptr`, `${this.sizeType} %a${i}_len`);
            body.push(
              `  %c${i} = call ptr @scr_library_str_in(ptr %a${i}_ptr, ${this.sizeType} %a${i}_len)`,
            );
            args.push(`ptr %c${i}`);
            break;
          case "bytes":
            params.push(`ptr %a${i}_ptr`, `${this.sizeType} %a${i}_len`);
            body.push(
              `  %c${i} = call ptr @scr_library_bytes_in(ptr %a${i}_ptr, ${this.sizeType} %a${i}_len, ptr @sc_lib_bytes_trap_${e.symbol})`,
            );
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
          body.push(
            `  call void ${target}(${callArgs})`,
            `  call void @scr_library_check_exc()`,
            `  ret void`,
          );
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
   * both print the runtime ABI’s exact message on fd 2 and abort. */
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
      // scr_box_retain is a static inline (increment-unless-immortal);
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
        `  br label %done`,
        `done:`,
        `  ret ptr %b`,
        `}`,
        ``,
      );
    }
    // Number-key Map/Set lookups probe the runtime's direct index inline:
    // while ndense is nonzero every live key is an integer below it, so an
    // in-range integral key reads its slot (entry index + 1, 0 = absent) and
    // any other key is absent. Maps without the index (ndense 0) hash the
    // key in sc_map_entry_f64_hashed, which scans the entries of a small map
    // or probes a compact bucket table as scr_map_find_f64 does, and calls
    // the runtime lookup for a wide table. It stays out of line so that the
    // direct-index path stays small at every call site. Both only read
    // memory, so LLVM merges lookups of one key when nothing is stored in
    // between (a has() followed by get(), for example).
    if (this.decls.has(NUMBER_MAP_ENTRY_DECL)) {
      const sz = this.sizeType;
      let mapTmp = 0;
      const mapIndex = exactIndexLines("%k", "%nd", sz, () => `%ix${mapTmp++}`);
      defs.push(
        `define internal ptr @sc_map_entry_f64(ptr %m, double %k) ${FN_ATTRS} {`,
        `entry:`,
        `  %ndp = getelementptr inbounds %ScrMapIx, ptr %m, i32 0, i32 16`,
        ...(sz === "i64"
          ? [`  %nd32 = load i32, ptr %ndp`, `  %nd = zext i32 %nd32 to i64`]
          : [`  %nd = load i32, ptr %ndp`]),
        // A non-integral key inside the table is as absent as one outside it.
        ...mapIndex.lines.map((line) => `  ${line}`),
        `  br i1 ${mapIndex.ok}, label %slot, label %outside`,
        `slot:`,
        sz === "i64"
          ? `  %i = add i64 ${mapIndex.wide}, 0`
          : `  %i = trunc i64 ${mapIndex.wide} to ${sz}`,
        `  %dp = getelementptr inbounds %ScrMapIx, ptr %m, i32 0, i32 15`,
        `  %dense = load ptr, ptr %dp`,
        `  %sp = getelementptr inbounds i32, ptr %dense, ${sz} %i`,
        `  %s = load i32, ptr %sp`,
        `  %empty = icmp eq i32 %s, 0`,
        `  br i1 %empty, label %miss, label %hit`,
        `hit:`,
        `  %e32 = sub i32 %s, 1`,
        sz === "i32" ? `  %e = add i32 %e32, 0` : `  %e = zext i32 %e32 to ${sz}`,
        `  %ep = getelementptr inbounds %ScrMapIx, ptr %m, i32 0, i32 11`,
        `  %entries = load ptr, ptr %ep`,
        `  %found = getelementptr inbounds %ScrMapEntry, ptr %entries, ${sz} %e`,
        `  ret ptr %found`,
        `miss:`,
        `  ret ptr null`,
        `outside:`,
        `  %dense.any = icmp ne ${sz} %nd, 0`,
        `  br i1 %dense.any, label %miss, label %slow`,
        `slow:`,
        `  %hashed = call ptr @sc_map_entry_f64_hashed(ptr %m, double %k)`,
        `  ret ptr %hashed`,
        `}`,
        ``,
        // Hashing (scr_map_find_f64): the SameValueZero key word, its
        // scr_key_mix hash (zero remapped to one) and the absent-key filter.
        `define internal ptr @sc_map_entry_f64_hashed(ptr %m, double %k) noinline ${FN_ATTRS} {`,
        `entry:`,
        `  %nan = fcmp uno double %k, %k`,
        `  %zero = fcmp oeq double %k, 0.0`,
        `  %kz = select i1 %zero, double 0.0, double %k`,
        `  %kzb = bitcast double %kz to i64`,
        `  %kb = select i1 %nan, i64 9221120237041090560, i64 %kzb`,
        `  %x1s = lshr i64 %kb, 30`,
        `  %x1 = xor i64 %kb, %x1s`,
        `  %x2 = mul i64 %x1, -4658895280553007687`,
        `  %x3s = lshr i64 %x2, 27`,
        `  %x3 = xor i64 %x2, %x3s`,
        `  %x4 = mul i64 %x3, -7723592293110705685`,
        `  %x5s = lshr i64 %x4, 31`,
        `  %x5 = xor i64 %x4, %x5s`,
        `  %hz = icmp eq i64 %x5, 0`,
        `  %h = select i1 %hz, i64 1, i64 %x5`,
        `  %f1s = lshr i64 %h, 44`,
        `  %f1a = and i64 %f1s, 63`,
        `  %f1 = shl i64 1, %f1a`,
        `  %f2s = lshr i64 %h, 50`,
        `  %f2a = and i64 %f2s, 63`,
        `  %f2 = shl i64 1, %f2a`,
        `  %fb = or i64 %f1, %f2`,
        `  %fp = getelementptr inbounds %ScrMapIx, ptr %m, i32 0, i32 10`,
        `  %filter = load i64, ptr %fp`,
        `  %fm = and i64 %filter, %fb`,
        `  %fin = icmp eq i64 %fm, %fb`,
        `  br i1 %fin, label %table, label %miss`,
        `table:`,
        `  %nbp = getelementptr inbounds %ScrMapIx, ptr %m, i32 0, i32 13`,
        ...(sz === "i64"
          ? [`  %nb32 = load i32, ptr %nbp`, `  %nb = zext i32 %nb32 to i64`]
          : [`  %nb = load i32, ptr %nbp`]),
        `  %eps = getelementptr inbounds %ScrMapIx, ptr %m, i32 0, i32 11`,
        `  %ents = load ptr, ptr %eps`,
        `  %linear = icmp eq ${sz} %nb, 0`,
        `  br i1 %linear, label %scan, label %buckets`,
        // Small maps keep no bucket table: scan the cached entry hashes.
        `scan:`,
        `  %nep = getelementptr inbounds %ScrMapIx, ptr %m, i32 0, i32 8`,
        ...(sz === "i64"
          ? [`  %ne32 = load i32, ptr %nep`, `  %ne = zext i32 %ne32 to i64`]
          : [`  %ne = load i32, ptr %nep`]),
        `  br label %scan.loop`,
        `scan.loop:`,
        `  %si = phi ${sz} [ 0, %scan ], [ %si.next, %scan.next ]`,
        `  %sdone = icmp eq ${sz} %si, %ne`,
        `  br i1 %sdone, label %miss, label %scan.entry`,
        `scan.entry:`,
        `  %se = getelementptr inbounds %ScrMapEntry, ptr %ents, ${sz} %si`,
        `  %seh = getelementptr inbounds %ScrMapEntry, ptr %se, i32 0, i32 2`,
        `  %sh = load i64, ptr %seh`,
        `  %sk = load i64, ptr %se`,
        `  %shq = icmp eq i64 %sh, %h`,
        `  %skq = icmp eq i64 %sk, %kb`,
        `  %sq = and i1 %shq, %skq`,
        `  br i1 %sq, label %scan.found, label %scan.next`,
        `scan.found:`,
        `  ret ptr %se`,
        `scan.next:`,
        `  %si.next = add ${sz} %si, 1`,
        `  br label %scan.loop`,
        // Compact tables tag each 24-bit entry index (+1) with the hash's
        // top byte; wider tables take the runtime lookup.
        `buckets:`,
        `  %wide = icmp ugt ${sz} %nb, 16777216`,
        `  br i1 %wide, label %runtime, label %probe`,
        `probe:`,
        `  %bp = getelementptr inbounds %ScrMapIx, ptr %m, i32 0, i32 14`,
        `  %bk = load ptr, ptr %bp`,
        `  %mask = sub ${sz} %nb, 1`,
        `  %ht = lshr i64 %h, 32`,
        `  %ht32 = trunc i64 %ht to i32`,
        `  %tag = and i32 %ht32, -16777216`,
        sz === "i64" ? `  %hi = add i64 %h, 0` : `  %hi = trunc i64 %h to ${sz}`,
        `  %i0 = and ${sz} %hi, %mask`,
        `  br label %probe.loop`,
        `probe.loop:`,
        `  %pi = phi ${sz} [ %i0, %probe ], [ %pi.next, %probe.next ]`,
        `  %bep = getelementptr inbounds i32, ptr %bk, ${sz} %pi`,
        `  %b = load i32, ptr %bep`,
        `  %bempty = icmp eq i32 %b, 0`,
        `  br i1 %bempty, label %miss, label %probe.tag`,
        `probe.tag:`,
        `  %bt = and i32 %b, -16777216`,
        `  %btq = icmp eq i32 %bt, %tag`,
        `  br i1 %btq, label %probe.entry, label %probe.next`,
        `probe.entry:`,
        `  %bix = and i32 %b, 16777215`,
        `  %bix1 = sub i32 %bix, 1`,
        sz === "i32" ? `  %bi = add i32 %bix1, 0` : `  %bi = zext i32 %bix1 to ${sz}`,
        `  %pe = getelementptr inbounds %ScrMapEntry, ptr %ents, ${sz} %bi`,
        `  %peh = getelementptr inbounds %ScrMapEntry, ptr %pe, i32 0, i32 2`,
        `  %ph = load i64, ptr %peh`,
        `  %pk = load i64, ptr %pe`,
        `  %phq = icmp eq i64 %ph, %h`,
        `  %pkq = icmp eq i64 %pk, %kb`,
        `  %pq = and i1 %phq, %pkq`,
        `  br i1 %pq, label %probe.found, label %probe.next`,
        `probe.found:`,
        `  ret ptr %pe`,
        `probe.next:`,
        `  %pi.inc = add ${sz} %pi, 1`,
        `  %pi.next = and ${sz} %pi.inc, %mask`,
        `  br label %probe.loop`,
        `miss:`,
        `  ret ptr null`,
        `runtime:`,
        `  %r = call ptr @scr_map_entry_f64(ptr %m, double %k) memory(read) nounwind willreturn`,
        `  ret ptr %r`,
        `}`,
        ``,
      );
    }
    // Map/Set iteration steps read the entries array inline: an index is
    // live when it is below the entry count and its entry's cached hash is
    // nonzero (a tombstone's is zero), as scr_map_iter_live decides. The
    // entry count is read again at every step, so entries appended during
    // the iteration are visited.
    if (this.decls.has(MAP_ITER_DECL)) {
      const sz = this.sizeType;
      defs.push(
        `define internal ptr @sc_map_iter_entry(ptr %m, double %i) ${FN_ATTRS} {`,
        `entry:`,
        `  %np = getelementptr inbounds %ScrMapIx, ptr %m, i32 0, i32 8`,
        `  %n = load i32, ptr %np`,
        `  %nf = uitofp i32 %n to double`,
        `  %lo = fcmp oge double %i, 0.0`,
        `  %hi = fcmp olt double %i, %nf`,
        `  %in = and i1 %lo, %hi`,
        `  br i1 %in, label %load, label %none`,
        `load:`,
        `  %ix = fptoui double %i to ${sz}`,
        `  %ep = getelementptr inbounds %ScrMapIx, ptr %m, i32 0, i32 11`,
        `  %entries = load ptr, ptr %ep`,
        `  %e = getelementptr inbounds %ScrMapEntry, ptr %entries, ${sz} %ix`,
        `  %hp = getelementptr inbounds %ScrMapEntry, ptr %e, i32 0, i32 2`,
        `  %h = load i64, ptr %hp`,
        `  %live = icmp ne i64 %h, 0`,
        `  br i1 %live, label %yes, label %none`,
        `yes:`,
        `  ret ptr %e`,
        `none:`,
        `  ret ptr null`,
        `}`,
        ``,
        `define internal double @sc_map_iter_count(ptr %m) ${FN_ATTRS} {`,
        `entry:`,
        `  %np = getelementptr inbounds %ScrMapIx, ptr %m, i32 0, i32 8`,
        `  %n = load i32, ptr %np`,
        `  %nf = uitofp i32 %n to double`,
        `  ret double %nf`,
        `}`,
        ``,
      );
    }
    // String-key Map/Set lookups test the map's absent-key filter inline
    // (scr_map.c scr_map_filter_bits): a key whose two filter bits are not
    // both set is absent, so most misses on small and medium maps return
    // without a call. On 64-bit targets the key's cached hash h is the high
    // half of its capacity word, the runtime's widened hash is (h << 32) | h,
    // and the filter reads its bits 44..55, which are the capacity word's
    // own. A key without a cached hash, and every possible hit, take the
    // runtime lookup.
    if (this.decls.has(STRING_MAP_ENTRY_DECL)) {
      defs.push(
        `define internal ptr @sc_map_entry_str(ptr %m, ptr %k) ${FN_ATTRS} {`,
        `entry:`,
        ...(this.sizeType === "i64"
          ? [
              `  %fp = getelementptr inbounds %ScrMapIx, ptr %m, i32 0, i32 10`,
              `  %filter = load i64, ptr %fp`,
              `  %capp = getelementptr inbounds %ScrStr, ptr %k, i32 0, i32 2`,
              `  %cap = load i64, ptr %capp`,
              `  %cached = icmp uge i64 %cap, 4294967296`,
              `  br i1 %cached, label %test, label %slow`,
              `test:`,
              `  %s1 = lshr i64 %cap, 44`,
              `  %i1 = and i64 %s1, 63`,
              `  %b1 = shl i64 1, %i1`,
              `  %s2 = lshr i64 %cap, 50`,
              `  %i2 = and i64 %s2, 63`,
              `  %b2 = shl i64 1, %i2`,
              `  %bits = or i64 %b1, %b2`,
              `  %have = and i64 %filter, %bits`,
              `  %maybe = icmp eq i64 %have, %bits`,
              `  br i1 %maybe, label %slow, label %absent`,
              `absent:`,
              `  ret ptr null`,
            ]
          : [`  br label %slow`]),
        `slow:`,
        `  %r = call ptr @scr_map_entry_str(ptr %m, ptr %k)`,
        `  ret ptr %r`,
        `}`,
        ``,
      );
    }
    // String comparisons enter through small internal wrappers that LLVM
    // inlines at each site: interned literals and shared values compare by
    // identity, and equality rejects different byte lengths, before any
    // runtime call (scr_str_eq/scr_str_cmp keep the complete semantics).
    if (this.decls.has(`declare zeroext i1 @scr_str_eq(ptr, ptr)`)) {
      defs.push(
        `define internal zeroext i1 @sc_str_eq(ptr %a, ptr %b) ${FN_ATTRS} {`,
        `entry:`,
        `  %same = icmp eq ptr %a, %b`,
        `  br i1 %same, label %yes, label %lengths`,
        `lengths:`,
        `  %alen.p = getelementptr inbounds %ScrStr, ptr %a, i32 0, i32 1`,
        `  %blen.p = getelementptr inbounds %ScrStr, ptr %b, i32 0, i32 1`,
        `  %alen = load ${this.sizeType}, ptr %alen.p`,
        `  %blen = load ${this.sizeType}, ptr %blen.p`,
        `  %samelen = icmp eq ${this.sizeType} %alen, %blen`,
        `  br i1 %samelen, label %bytes, label %no`,
        `bytes:`,
        `  %eq = call zeroext i1 @scr_str_eq(ptr %a, ptr %b)`,
        `  ret i1 %eq`,
        `yes:`,
        `  ret i1 true`,
        `no:`,
        `  ret i1 false`,
        `}`,
        ``,
      );
    }
    for (const [text, name] of this.literalEqualities) {
      defs.push(
        ...literalEqualityDefinition(
          name,
          wtf8Bytes(text),
          this.internLiteral(text),
          this.sizeType,
          FN_ATTRS,
        ),
        ``,
      );
    }
    // String length and charCodeAt read proven-ASCII strings inline: bit 31
    // of the capacity word (SCR_STR_ASCII_BIT, the low half's sign bit on
    // little-endian targets) makes UTF-16 units bytes. Unproven strings and
    // anything but an in-range index take the runtime's UTF-16 mapping.
    // A scan's receiver reads inline too where runtime state is ordinary
    // global storage (ScrStrScan; SCR_TL makes it thread-local otherwise).
    const scanInline = this.mod.workers !== true && this.mod.lib?.threadInstances !== true;
    let scanDeclared = false;
    for (const helper of STRING_READ_HELPERS) {
      if (!this.decls.has(helper.decl)) continue;
      if (scanInline && !scanDeclared) {
        defs.push(stringScanDecl(this.sizeType), ``);
        scanDeclared = true;
      }
      defs.push(...helper.define(this.sizeType, FN_ATTRS, scanInline), ``);
    }
    // Ordering also decides inline when the first bytes differ: byte order
    // is the plain comparison's order, and the UTF-16 order whenever both
    // bytes are ASCII. Callers only test the sign of the result.
    for (const fn of ["scr_str_cmp", "scr_str_cmp_u16"]) {
      if (!this.decls.has(`declare i32 @${fn}(ptr, ptr)`)) continue;
      this.declare("declare i64 @llvm.bswap.i64(i64)");
      const utf16 = fn === "scr_str_cmp_u16";
      defs.push(
        `define internal i32 @${fn.replace(/^scr_/, "sc_")}(ptr %a, ptr %b) ${FN_ATTRS} {`,
        `entry:`,
        `  %same = icmp eq ptr %a, %b`,
        `  br i1 %same, label %equal, label %lengths`,
        `lengths:`,
        `  %alen.p = getelementptr inbounds %ScrStr, ptr %a, i32 0, i32 1`,
        `  %blen.p = getelementptr inbounds %ScrStr, ptr %b, i32 0, i32 1`,
        `  %alen = load ${this.sizeType}, ptr %alen.p`,
        `  %blen = load ${this.sizeType}, ptr %blen.p`,
        `  %aempty = icmp eq ${this.sizeType} %alen, 0`,
        `  %bempty = icmp eq ${this.sizeType} %blen, 0`,
        `  %empty = or i1 %aempty, %bempty`,
        `  br i1 %empty, label %order, label %words`,
        // Both at least 8 bytes: the first differing byte of one word pair.
        // Byte-swapped little-endian words compare in byte order.
        `words:`,
        `  %along = icmp uge ${this.sizeType} %alen, 8`,
        `  %blong = icmp uge ${this.sizeType} %blen, 8`,
        `  %long = and i1 %along, %blong`,
        `  br i1 %long, label %word, label %first`,
        `word:`,
        `  %awp = getelementptr inbounds %ScrStr, ptr %a, i32 1`,
        `  %bwp = getelementptr inbounds %ScrStr, ptr %b, i32 1`,
        `  %aw = load i64, ptr %awp, align 1`,
        `  %bw = load i64, ptr %bwp, align 1`,
        `  %wdiffer = icmp ne i64 %aw, %bw`,
        `  br i1 %wdiffer, label %wdiff, label %wsame`,
        `wdiff:`,
        ...(utf16
          ? [
              `  %wbits = or i64 %aw, %bw`,
              `  %whigh = and i64 %wbits, -9187201950435737472`,
              `  %wascii = icmp eq i64 %whigh, 0`,
              `  br i1 %wascii, label %wordorder, label %order`,
            ]
          : [`  br label %wordorder`]),
        `wordorder:`,
        `  %asw = call i64 @llvm.bswap.i64(i64 %aw)`,
        `  %bsw = call i64 @llvm.bswap.i64(i64 %bw)`,
        `  %wbelow = icmp ult i64 %asw, %bsw`,
        `  %wsign = select i1 %wbelow, i32 -1, i32 1`,
        `  ret i32 %wsign`,
        // Equal first words and one length of at most 16 bytes: the word
        // ending at that length covers the rest, and any difference lies
        // past the equal first word.
        `wsame:`,
        `  %samelen = icmp eq ${this.sizeType} %alen, %blen`,
        `  %short = icmp ule ${this.sizeType} %alen, 16`,
        `  %tailable = and i1 %samelen, %short`,
        `  br i1 %tailable, label %tail, label %order`,
        `tail:`,
        `  %toff = sub ${this.sizeType} %alen, 8`,
        `  %atp = getelementptr inbounds i8, ptr %awp, ${this.sizeType} %toff`,
        `  %btp = getelementptr inbounds i8, ptr %bwp, ${this.sizeType} %toff`,
        `  %at = load i64, ptr %atp, align 1`,
        `  %bt = load i64, ptr %btp, align 1`,
        `  %tdiffer = icmp ne i64 %at, %bt`,
        `  br i1 %tdiffer, label %tdiff, label %equal`,
        `tdiff:`,
        ...(utf16
          ? [
              `  %tbits = or i64 %at, %bt`,
              `  %thigh = and i64 %tbits, -9187201950435737472`,
              `  %tascii = icmp eq i64 %thigh, 0`,
              `  br i1 %tascii, label %tailorder, label %order`,
            ]
          : [`  br label %tailorder`]),
        `tailorder:`,
        `  %ats = call i64 @llvm.bswap.i64(i64 %at)`,
        `  %bts = call i64 @llvm.bswap.i64(i64 %bt)`,
        `  %tbelow = icmp ult i64 %ats, %bts`,
        `  %tsign = select i1 %tbelow, i32 -1, i32 1`,
        `  ret i32 %tsign`,
        `first:`,
        `  %adata = getelementptr inbounds %ScrStr, ptr %a, i32 1`,
        `  %bdata = getelementptr inbounds %ScrStr, ptr %b, i32 1`,
        `  %x = load i8, ptr %adata`,
        `  %y = load i8, ptr %bdata`,
        `  %differ = icmp ne i8 %x, %y`,
        ...(utf16
          ? [
              `  %bits = or i8 %x, %y`,
              `  %ascii = icmp sge i8 %bits, 0`,
              `  %decide = and i1 %differ, %ascii`,
            ]
          : [`  %decide = and i1 %differ, true`]),
        `  br i1 %decide, label %byte, label %order`,
        `byte:`,
        `  %below = icmp ult i8 %x, %y`,
        `  %sign = select i1 %below, i32 -1, i32 1`,
        `  ret i32 %sign`,
        `order:`,
        `  %c = call i32 @${fn}(ptr %a, ptr %b)`,
        `  ret i32 %c`,
        `equal:`,
        `  ret i32 0`,
        `}`,
        ``,
      );
    }
    // The declarations these helpers added must land in the extern block,
    // which already flushed — append here instead (LLVM is order-free).
    return defs.length > 0 ? [...defs] : defs;
  }

  /** The inline RC helpers every call site requested, emitted last so
   * requests from main/library epilogues are included. Slow-path
   * declarations a late request added after the extern block flushed land
   * here too. */
  private inlineRcTail(flushedDecls: ReadonlySet<string>): string[] {
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
      ...emitInlineRcHelpers(this.shapeHost),
    ];
  }

  /** Env-signature wrappers + interned immortal closures for declared
   * functions used as values (the runtime ABI’s sc_w_/sc_fc_ pair): every
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

  /** The argument-pack ABI and trampoline prefix shared by async functions
   * and generators. Their promise/generator completion and spawn tails stay
   * with the callers below. */
  private emitArgPackAndTrampolinePrologue(fn: IrFunction): LlArgPackAndTrampolinePrologue {
    const pack = mangleArgPack(fn.name);
    const lifted = fn.captures !== undefined;
    const fieldTys = [...(lifted ? ["ptr"] : []), ...fn.params.map((p) => this.llType(p.type))];
    const definitions = [`%${pack} = type { ${fieldTys.join(", ") || "i8"} } ; ${fn.name} args`];
    const sizeOf = `ptrtoint (ptr getelementptr (%${pack}, ptr null, i32 1) to ${this.sizeType})`;

    // Async argument packs live from the spawn to the trampoline's first
    // instructions, so they take the runtime's small-block allocator.
    // Generator packs keep malloc: the runtime frees never-started ones.
    const smallPack = fn.generator === undefined;
    const packAlloc = smallPack ? "scr_rt_calloc" : "malloc";
    const packFree = smallPack ? "scr_rt_free" : "free";
    this.declare(`declare void @${packFree}(ptr)`);
    this.declare(`declare ptr @${packAlloc}(${this.sizeType})`);

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
    tr.push(`  call void @${packFree}(ptr %ap)`);
    const ret = fn.returnType;
    const retTy = this.llType(ret);
    const bodyCall = `call ${retTy} @${mangleFunction(fn.name)}(${loads.join(", ")})`;
    tr.push(retTy === "void" ? `  ${bodyCall}` : `  %r = ${bodyCall}`);
    if (lifted && !this.coroLowered(fn)) {
      tr.push(`  call void @scr_closure_release(ptr %a0)`);
    }

    const spawnParams = fieldTys.map((ty, i) => `${ty} %a${i}`);
    const argPackLines = [
      `  %ap = call ptr @${packAlloc}(${this.sizeType} ${sizeOf})`,
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

  /** Settles `promise` from a clean async body result `%r` (moved in). */
  private asyncFulfillLines(ret: IrType, promise: string): string[] {
    switch (ret.kind) {
      case "void":
        this.declare(`declare void @scr_promise_fulfill_void(ptr)`);
        return [`  call void @scr_promise_fulfill_void(ptr ${promise})`];
      case "f64":
      case "date":
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

  /** Async functions whose calls can skip the fiber (scr_async_inline_*).
   * A body qualifies only when nothing it runs can park its execution
   * context: its emitted text, and the text of every module function it
   * mentions (transitively), contains no suspension entry point. Such a
   * body always completes before the call returns, which is exactly the
   * behavior of a fiber that never suspends. Excluded conservatively:
   * wasm32 (its coroutine lowering owns async bodies), module-evaluation
   * bodies (their promise caches),
   * `dyn` results (resolution may adopt a thenable), and every program
   * that uses node:test subtests — `t.test()` runs a subtest inline and
   * awaits it on the CURRENT fiber even from synchronous code. Worker
   * programs keep fibers too: their fiber epilogue owns context
   * termination (a stopping worker rejects and observes the promise), which
   * the fiberless wrapper does not reproduce. A missed suspension still
   * cannot reorder execution undetected: the runtime traps when a context parks while a
   * fiberless body is on its stack. */
  private fiberlessAsyncFunctions(): Set<string> {
    const eligible = new Set<string>();
    if (this.wasi || this.mod.workers === true) return eligible;
    const suspends =
      /@(?:scr_(?:await_|module_await\b|promise_await_settled\b|test_sub\b|gen_yield_|async_gen_|fiber_)|sc_a[wd]_)/;
    for (const decl of this.decls) if (/@scr_test_sub\b/.test(decl)) return eligible;
    for (const text of this.fnDefText.values()) if (/@scr_test_sub\b/.test(text)) return eligible;
    const byMangled = new Map<string, string>();
    for (const fn of this.mod.functions) {
      byMangled.set(mangleFunction(fn.name), fn.name);
      byMangled.set(mangleBorrowedFunction(fn.name), fn.name);
    }
    // Reverse mention edges, then propagate "may park" to every mentioner.
    const mentionedBy = new Map<string, Set<string>>();
    const parks = new Set<string>();
    const work: string[] = [];
    for (const [name, text] of this.fnDefText) {
      if (suspends.test(text)) {
        parks.add(name);
        work.push(name);
      }
      for (const match of text.matchAll(/@(sc_b?f_[A-Za-z0-9_]+)/g)) {
        const callee = byMangled.get(match[1]!);
        if (callee === undefined || callee === name) continue;
        let callers = mentionedBy.get(callee);
        if (callers === undefined) mentionedBy.set(callee, (callers = new Set()));
        callers.add(name);
      }
    }
    while (work.length > 0) {
      const callers = mentionedBy.get(work.pop()!);
      if (callers === undefined) continue;
      for (const caller of callers) {
        if (parks.has(caller)) continue;
        parks.add(caller);
        work.push(caller);
      }
    }
    for (const fn of this.mod.functions) {
      if (fn.async !== true || fn.generator !== undefined) continue;
      if (fn.asyncCacheGlobal !== undefined || fn.asyncCycleCacheGlobal !== undefined) continue;
      if (fn.returnType.kind === "dyn" || parks.has(fn.name)) continue;
      if (!this.fnDefText.has(fn.name)) continue;
      eligible.add(fn.name);
    }
    return eligible;
  }

  /** The spawn wrapper of a fiberless async function: runs the body on the
   * caller's stack between scr_async_inline_enter/leave and settles the
   * fresh promise from its outcome — the fiber trampoline's epilogue,
   * without the fiber. */
  private emitFiberlessAsyncSpawn(fn: IrFunction, spawnParams: string[]): string[] {
    const ret = fn.returnType;
    const retTy = this.llType(ret);
    const lifted = fn.captures !== undefined;
    this.declare(`declare void @scr_async_inline_enter(ptr)`);
    this.declare(`declare ptr @scr_async_inline_leave(ptr)`);
    this.declare(`declare void @scr_promise_reject_pending(ptr)`);
    if (lifted) {
      this.declare(`declare ptr @scr_closure_retain_v(ptr)`);
      this.declare(`declare void @scr_closure_release(ptr)`);
    }
    const bodyCall = `call ${retTy} @${mangleFunction(fn.name)}(${spawnParams.join(", ")})`;
    const out = [
      `define internal ptr @${mangleAsyncSpawn(fn.name)}(${spawnParams.join(", ")}) ${FN_ATTRS} { ; fiberless ${fn.name}`,
      `entry:`,
      `  %frame = alloca { ptr, ptr }`,
      // The fiber path holds +1 on a lifted environment for the body's
      // duration (packed, released by the trampoline); keep that lifetime.
      ...(lifted ? [`  %env = call ptr @scr_closure_retain_v(ptr %a0)`] : []),
      `  call void @scr_async_inline_enter(ptr %frame)`,
      retTy === "void" ? `  ${bodyCall}` : `  %r = ${bodyCall}`,
      ...(lifted ? [`  call void @scr_closure_release(ptr %a0)`] : []),
      ...this.pendingTestLines("%pend"),
      `  %p = call ptr @scr_async_inline_leave(ptr %frame)`,
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
    if (this.wasi || this.mod.workers === true) return false;
    const fn = this.fnByName.get(fnName);
    if (fn === undefined || fn.async !== true || fn.generator !== undefined) return false;
    if (fn.captures !== undefined || fn.returnType.kind === "dyn") return false;
    return fn.asyncCacheGlobal === undefined && fn.asyncCycleCacheGlobal === undefined;
  }

  /** The await-call entry of an async function (`sc_aw_*`): one direct
   * `await f(...)` as a call returning the awaited value, so the call site
   * needs no promise of its own. A fiberless body runs on the caller's
   * stack as in its spawn wrapper; a clean result then takes the await's
   * one microtask turn (scr_await_hop) and is returned without ever
   * materializing the promise, which nothing else could observe. A throw
   * builds the rejected promise exactly as the spawn wrapper would and
   * awaits it, so the rejection reaches the awaiter on the same turn. Other
   * bodies pack their arguments as the spawn wrapper does and enter
   * scr_async_spawn_await_*, which parks the caller on the promise as soon
   * as the body first suspends. The adopting entry (`sc_ad_*`, for
   * `return f(...)` in an async function) adds the turn of the then job
   * that adopts the returned promise, before the await proper. */
  private emitAsyncAwaitCall(
    fn: IrFunction,
    argPackLines: string[] | null,
    adopt = false,
  ): string[] {
    const ret = fn.returnType;
    const retTy = this.llType(ret);
    const params = fn.params.map((p, i) => `${this.llType(p.type)} %a${i}`);
    const awaitLine = (dest: string, promise: string): string => {
      switch (ret.kind) {
        case "void":
          this.declare(`declare void @scr_await_void(ptr)`);
          return `  call void @scr_await_void(ptr ${promise})`;
        case "f64":
        case "date":
          this.declare(`declare double @scr_await_f64(ptr)`);
          return `  ${dest} = call double @scr_await_f64(ptr ${promise})`;
        case "bool":
          this.declare(`declare zeroext i1 @scr_await_bool(ptr)`);
          return `  ${dest} = call zeroext i1 @scr_await_bool(ptr ${promise})`;
        case "string":
          this.declare(`declare ptr @scr_await_str(ptr)`);
          return `  ${dest} = call ptr @scr_await_str(ptr ${promise})`;
        default:
          this.declare(`declare ptr @scr_await_ref(ptr)`);
          return `  ${dest} = call ptr @scr_await_ref(ptr ${promise})`;
      }
    };
    const retLine = (v: string): string =>
      retTy === "void" ? `  ret void` : `  ret ${retTy} ${v}`;
    const head = adopt
      ? `define internal ${retTy} @${mangleAsyncAdoptCall(fn.name)}(${params.join(", ")}) ${FN_ATTRS} { ; adopt ${fn.name}`
      : `define internal ${retTy} @${mangleAsyncAwaitCall(fn.name)}(${params.join(", ")}) ${FN_ATTRS} { ; await ${fn.name}`;
    const args = params.join(", ");
    if (adopt && argPackLines !== null) {
      // A body that may suspend settles later than the adoption's then job
      // runs: materialize its promise, take that turn, then await it.
      this.declare(`declare void @scr_await_hop()`);
      this.declare(`declare void @scr_promise_release(ptr)`);
      return [
        head,
        `entry:`,
        `  %p = call ptr @${mangleAsyncSpawn(fn.name)}(${args})`,
        `  call void @scr_await_hop()`,
        awaitLine("%v", "%p"),
        `  call void @scr_promise_release(ptr %p)`,
        retLine("%v"),
        `}`,
        ``,
      ];
    }
    if (argPackLines !== null) {
      const kind =
        ret.kind === "void"
          ? "void"
          : ret.kind === "f64" || ret.kind === "date"
            ? "f64"
            : ret.kind === "bool"
              ? "bool"
              : ret.kind === "string"
                ? "str"
                : "ref";
      const cret = kind === "bool" ? "zeroext i1" : retTy;
      this.declare(`declare ${cret} @scr_async_spawn_await_${kind}(ptr, ptr)`);
      this.needOom();
      const call = `call ${cret} @scr_async_spawn_await_${kind}(ptr @${mangleTrampoline(fn.name)}, ptr %ap)`;
      return [
        head,
        `entry:`,
        ...argPackLines,
        kind === "void" ? `  ${call}` : `  %v = ${call}`,
        retLine("%v"),
        `}`,
        ``,
      ];
    }
    this.declare(`declare void @scr_async_inline_enter(ptr)`);
    this.declare(`declare void @scr_async_inline_exit(ptr)`);
    this.declare(`declare void @scr_await_hop()`);
    this.declare(`declare ptr @scr_promise_new()`);
    this.declare(`declare void @scr_promise_reject_pending(ptr)`);
    this.declare(`declare void @scr_promise_release(ptr)`);
    const bodyCall = `call ${retTy} @${mangleFunction(fn.name)}(${args})`;
    const out = [
      head,
      `entry:`,
      `  %frame = alloca { ptr, ptr }`,
      `  call void @scr_async_inline_enter(ptr %frame)`,
      retTy === "void" ? `  ${bodyCall}` : `  %r = ${bodyCall}`,
      ...this.pendingTestLines("%pend"),
      `  call void @scr_async_inline_exit(ptr %frame)`,
      // Adopting: the then job's turn comes before the settled promise's
      // own reaction, whichever way the body completed.
      ...(adopt ? [`  call void @scr_await_hop()`] : []),
      `  br i1 %pend, label %thrown, label %clean`,
      `clean:`,
      `  call void @scr_await_hop()`,
      retLine("%r"),
      `thrown:`,
    ];
    if (ret.kind !== "void" && isRefCounted(ret)) {
      // An escaping throw means %r is the never-read dummy (NULL).
      out.push(`  call void ${releaseSym(this.shapeHost, ret)}(ptr %r)`);
    }
    out.push(
      `  %p = call ptr @scr_promise_new()`,
      `  call void @scr_promise_reject_pending(ptr %p)`,
      awaitLine("%v", "%p"),
      `  call void @scr_promise_release(ptr %p)`,
      retLine("%v"),
      `}`,
      ``,
    );
    return out;
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
    const fiberless = this.fiberlessAsyncFunctions();
    for (const fn of this.mod.functions) {
      if (fn.async !== true || fn.generator !== undefined) continue;
      if (fiberless.has(fn.name) && this.awaitCallees.has(fn.name)) {
        for (const line of this.emitAsyncAwaitCall(fn, null)) out.push(line);
      }
      if (fiberless.has(fn.name) && this.adoptCallees.has(fn.name)) {
        for (const line of this.emitAsyncAwaitCall(fn, null, true)) out.push(line);
      }
      if (fiberless.has(fn.name)) {
        const fieldTys = [
          ...(fn.captures !== undefined ? ["ptr"] : []),
          ...fn.params.map((p) => this.llType(p.type)),
        ];
        const params = fieldTys.map((ty, i) => `${ty} %a${i}`);
        for (const line of this.emitFiberlessAsyncSpawn(fn, params)) out.push(line);
        continue;
      }
      const { definitions, ret, tr, spawnParams, argPackLines } =
        this.emitArgPackAndTrampolinePrologue(fn);
      for (const line of definitions) out.push(line);
      if (this.awaitCallees.has(fn.name)) {
        for (const line of this.emitAsyncAwaitCall(fn, argPackLines)) out.push(line);
      }
      if (this.adoptCallees.has(fn.name)) {
        for (const line of this.emitAsyncAwaitCall(fn, argPackLines, true)) out.push(line);
      }
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
          ...this.pendingTestLines("%pend"),
          `  br i1 %pend, label %thrown, label %clean`,
          `clean:`,
          `  %pr = call ptr @scr_fiber_promise(ptr %self)`,
        );
        for (const line of this.asyncFulfillLines(ret, "%pr")) tr.push(line);
        tr.push(`  ret void`, `thrown:`);
        if (ret.kind !== "void" && isRefCounted(ret)) {
          // An escaping throw means %r is the never-read dummy (NULL).
          tr.push(`  call void ${releaseSym(this.shapeHost, ret)}(ptr %r)`);
        }
        tr.push(`  ret void`, `}`, ``);
      }
      for (const line of tr) out.push(line);

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
      for (const line of sp) out.push(line);
    }
    for (const line of this.emitGenScaffolding()) out.push(line);
    return out;
  }

  /** Whether `fn`'s body is emitted as an LLVM switched coroutine: every
   * wasm32 async or generator body, and native synchronous generators. */
  private coroLowered(fn: IrFunction): boolean {
    if (this.wasi) return fn.async === true || fn.generator !== undefined;
    return this.stacklessGenerators && fn.generator !== undefined && fn.async !== true;
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
      const { definitions, pack, lifted, fieldTys, ret, tr, spawnParams, argPackLines } =
        this.emitArgPackAndTrampolinePrologue(fn);
      for (const line of definitions) out.push(line);
      this.declare(`declare zeroext i1 @scr_exc_genret_pending()`);
      this.declare(`declare void @scr_exc_clear()`);
      this.declare(`declare ptr @scr_gen_of_fiber(ptr)`);
      this.declare(`declare void @scr_gen_ret_to_out(ptr)`);
      this.declare(`declare ptr @scr_gen_new(ptr, ptr, ptr)`);
      this.needOom();
      const coroBody = this.coroLowered(fn);
      if (lifted && !coroBody) {
        this.declare(`declare void @scr_closure_release(ptr)`);
      }
      // Normal completion stores the (typed) return value; void completes
      // with the NONE slot — JS's undefined done-value. A GENRET unwind
      // consumes the sentinel and promotes the parked .return value; a
      // real exception stays pending (the consumer-side resume moves it).
      if (coroBody) {
        tr.push(`  ret void`, `}`, ``);
      } else {
        tr.push(
          `  %g = call ptr @scr_gen_of_fiber(ptr %self)`,
          ...this.pendingTestLines("%pend"),
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
            const v = vAdapters(this.shapeHost, ret);
            this.declare(`declare void @scr_gen_out_ref(ptr, ptr, ptr)`);
            tr.push(
              `  call void @scr_gen_out_ref(ptr %g, ptr %r, ptr ${v.release})`,
              `  br label %done`,
            );
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
          tr.push(
            `  call void ${releaseSym(this.shapeHost, ret)}(ptr %r) ; unwound: the never-read dummy`,
          );
        }
        tr.push(`  br label %done`, `done:`, `  ret void`, `}`, ``);
      }
      for (const line of tr) out.push(line);

      let settleAsync: string | null = null;
      if (fn.async) {
        this.declare(`declare ptr @scr_async_gen_new(ptr, ptr, ptr, ptr)`);
        const genT: IrType & { kind: "generator" } = {
          kind: "generator",
          async: true,
          yieldT: fn.generator.yieldT,
          retT: ret,
          nextT: fn.generator.nextT,
        };
        const resultT = fn.generator.resultType;
        const build = this.genResultThunkFor(genT, resultT);
        settleAsync = `${build}_async`;
        const settleKey = `ags:${typeKey(genT)}`;
        if (!this.resolveThunks.has(settleKey)) {
          this.resolveThunks.set(settleKey, settleAsync);
          const adapters = vAdapters(this.shapeHost, resultT);
          this.resolveThunkDefs.push(
            `define internal void @${settleAsync}(ptr %g, ptr %p) ${FN_ATTRS} {`,
            `entry:`,
            `  %r = call ptr @${build}(ptr %g)`,
            `  call void @scr_promise_fulfill_ref(ptr %p, ptr %r, ptr ${adapters.retain}, ptr ${adapters.release}, ptr ${traceArg(this.shapeHost, resultT)})`,
            `  ret void`,
            `}`,
            ``,
          );
        }
        this.declare(`declare void @scr_promise_fulfill_ref(ptr, ptr, ptr, ptr, ptr)`);
      }

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
          dr.push(`  call void ${releaseSym(this.shapeHost, pType)}(ptr %dv${i})`);
        }
      });
      dr.push(`  call void @free(ptr %ap)`, `  ret void`, `}`, ``);
      for (const line of dr) out.push(line);

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
      const genNew = coroBody && !this.wasi ? "scr_gen_new_stackless" : "scr_gen_new";
      if (genNew !== "scr_gen_new") this.declare(`declare ptr @${genNew}(ptr, ptr, ptr)`);
      sp.push(
        settleAsync === null
          ? `  %gg = call ptr @${genNew}(ptr @${mangleTrampoline(fn.name)}, ptr %ap, ptr @${mangleGenDrop(fn.name)})`
          : `  %gg = call ptr @scr_async_gen_new(ptr @${mangleTrampoline(fn.name)}, ptr %ap, ptr @${mangleGenDrop(fn.name)}, ptr @${settleAsync})`,
        `  ret ptr %gg`,
        `}`,
        ``,
      );
      for (const line of sp) out.push(line);
    }
    return out;
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
    const name = `@${lit.sym}`;
    this.immortalValues.add(name);
    return name;
  }

  /** The inline equality test against one string literal (an
   * `i1 (ptr)` helper LLVM inlines at each site), by literal symbol. */
  literalEquals(text: string): string {
    const literal = this.internLiteral(text);
    const name = `@sc_streq_${literal.slice("@sc_lit_".length)}`;
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
    return `@${c.sym}`;
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

  /** Strike a refcounted temp from its frame: ownership is being moved. */
  moveTemp(v: LlValue): void {
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

  /** The retained (+1) read of a refcounted value — type-directed through
   * the `_v` table (immortals skip, exactly the C retain calls). */
  retainValue(name: string, type: IrType): string {
    if (this.isImmortal(name)) return name;
    const t = this.B.tmp();
    this.B.line(`${t} = call ptr ${retainSym(this.shapeHost, type)}(ptr ${name})`);
    return t;
  }

  /** The release call for one owned refcounted value — type-directed like
   * releaseCallC (all runtime releases are NULL-tolerant). */
  releaseValue(name: string, type: IrType): void {
    if (this.isImmortal(name)) return;
    this.B.line(`call void ${releaseSym(this.shapeHost, type)}(ptr ${name})`);
  }

  releaseFrame(frame: LlValue[]): void {
    for (const v of frame) {
      if (v.slot) {
        const t = this.B.tmp();
        this.B.line(`${t} = load ptr, ptr ${v.name}`);
        if (v.boxed) {
          this.B.line(`call void ${boxReleaseSym(this.shapeHost)}(ptr ${t})`);
        } else {
          this.releaseValue(t, v.type);
        }
      } else {
        this.releaseValue(v.name, v.type);
      }
    }
  }

  private releaseScope(scope: LlScopeEntry[]): void {
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
        this.releaseValue(t, e.type); // runtime releases are NULL-tolerant
      }
    }
  }

  /** THE release-on-jump path (break/continue/return): pending statement
   * frames and entered scopes down to the given depths, innermost first —
   * everything whose normal fall-through releases the jump bypasses.
   * Release every scope crossed by the control-flow edge. */
  private releaseForJump(frameDepth: number, scopeDepth: number): void {
    for (let i = this.frames.length - 1; i >= frameDepth; i--) this.releaseFrame(this.frames[i]!);
    for (let i = this.scopes.length - 1; i >= scopeDepth; i--) this.releaseScope(this.scopes[i]!);
  }

  /** Run the finally regions an abrupt loop/block jump crosses, then
   * release to the already-resolved target. This is the return path's
   * completion walk without a parked result value. */
  private emitFinallysForJump(finallyDepth: number, frameDepth: number, scopeDepth: number): void {
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
  private emitUnwind(passThrough?: string): void {
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
    for (let i = this.frames.length - 1; i >= frameDepth; i--) this.releaseFrame(this.frames[i]!);
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
   * (function entry or loop budget), whose test must stay ordered. */
  emitPendingCheck(passThrough?: { name: string; type: IrType }, poll = false): void {
    const through =
      passThrough !== undefined &&
      this.llType(passThrough.type) === this.llType(this.currentReturnType) &&
      (passThrough.type.kind === "f64" || passThrough.type.kind === "bool")
        ? passThrough.name
        : undefined;
    const B = this.B;
    if (B.isTerminated()) return;
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
  private emitStackCheck(): void {
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

  private workerLoopBudget(
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

  /** Emit a loop's condition, body and update through `emitCopy`, twice
   * when speculative-integers.ts plans a fast integer copy. Both copies
   * share the loop's setup and exit; the ordinary copy comes first so the
   * fast copy is only emitted when every resume point exists. */
  private emitLoopCopies(
    loop: Extract<IrStmt, { kind: "while" | "doWhile" | "for" }>,
    allowed: boolean,
    exit: string,
    emitCopy: (exit: string) => void,
  ): void {
    const plan =
      allowed &&
      this.speculativeLoopsEnabled &&
      this.speculation === null &&
      this.speculationResume === null
        ? planSpeculativeLoop(
            loop,
            (id) => this.speculativeLocal(id),
            (id) => this.integerLoopBindings.has(id) || this.int32Locals.has(id),
            (e) => {
              const range = this.integerRanges.get(e);
              return (
                range !== undefined &&
                range !== null &&
                range.min >= -Number.MAX_SAFE_INTEGER &&
                range.max <= Number.MAX_SAFE_INTEGER
              );
            },
            (id) => this.speculativeLocal(id) || this.speculativeInvariantGlobal(id),
          )
        : null;
    if (!plan) {
      emitCopy(exit);
      return;
    }
    const B = this.B;
    const entries = new Map<string, string>();
    let ok = "true";
    for (const [id, live] of plan.locals) {
      if (!live) continue;
      const value = B.tmp();
      B.line(`${value} = load double, ptr ${this.binding(id).slot}`);
      const [integer, exact] = emitSafeIntegerCheck(this, value);
      entries.set(id, integer);
      if (ok === "true") ok = exact;
      else {
        const both = B.tmp();
        B.line(`${both} = and i1 ${ok}, ${exact}`);
        ok = both;
      }
    }
    const fast = B.newLabel("spec.fast"),
      slow = B.newLabel("spec.slow");
    B.condBr(ok, fast, slow);
    const resume = new Map<IrStmt, { label: string; placed: boolean }>();
    for (const s of plan.writes) resume.set(s, { label: B.newLabel("spec.resume"), placed: false });
    B.startBlock(slow);
    this.speculationResume = resume;
    try {
      emitCopy(exit);
    } finally {
      this.speculationResume = null;
    }
    B.startBlock(fast);
    if (![...resume.values()].every((r) => r.placed)) {
      B.br(slow);
      return;
    }
    for (const id of plan.locals.keys()) {
      const shadow = B.slot();
      B.entryAllocas.push(
        `${shadow} = alloca i64 ; speculative integer ${this.currentLocals.get(id)?.name ?? id}`,
      );
      const entry = entries.get(id);
      if (entry !== undefined) {
        // The same double, now visibly an integer conversion: the double
        // phis of the fast copy fold into integer phis.
        const exact = B.tmp();
        B.line(`store i64 ${entry}, ptr ${shadow}`);
        B.line(`${exact} = sitofp i64 ${entry} to double`);
        B.line(`store double ${exact}, ptr ${this.binding(id).slot}`);
      } else B.line(`store i64 0, ptr ${shadow}`);
      this.integerLoopBindings.set(id, {
        slot: shadow,
        type: "i64",
        signed: true,
        range: SPECULATIVE_RANGE,
      });
    }
    // A global's store stays in the loop (calls may read it). When nothing
    // in the loop can observe it, its double is written once on leaving the
    // copy instead, so the loop keeps it in a register as the double copy
    // would.
    const deferred = new Set<string>();
    // Worker loops also leave through their cancellation poll.
    if (plan.observerFree && !this.mod.workers)
      for (const s of plan.writes) {
        const id = speculativeWriteTarget(s)!.localId;
        if (!this.currentLocals.has(id)) deferred.add(id);
      }
    this.speculation = {
      writes: plan.writes,
      resume: new Map([...resume].map(([s, r]) => [s, r.label])),
      deferred,
    };
    try {
      if (deferred.size === 0) emitCopy(exit);
      else {
        const leave = B.newLabel("spec.leave");
        emitCopy(leave);
        B.startBlock(leave);
        this.writeBackSpeculativeGlobals(deferred);
        B.br(exit);
      }
    } finally {
      this.speculation = null;
      for (const id of plan.locals.keys()) this.integerLoopBindings.delete(id);
    }
  }

  private writeBackSpeculativeGlobals(deferred: Set<string>): void {
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
  private speculativeLocal(id: string): boolean {
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
  private speculativeInvariantGlobal(id: string): boolean {
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

  /** A speculated write in the fast copy: compute the value as a safe
   * integer, store it to the shadow and its exact double to the local.
   * Any failed check re-executes the statement in the ordinary copy. */
  private emitSpeculativeWrite(s: IrStmt, resume: string): void {
    const B = this.B;
    const target = speculativeWriteTarget(s)!;
    const binding = this.integerLoopBindings.get(target.localId)!;
    const failed = B.newLabel("spec.bail");
    let bails = false;
    this.declare("declare i1 @llvm.expect.i1(i1, i1)");
    const bail = (condition: string): void => {
      if (condition === "false") return;
      bails = true;
      const expected = B.tmp();
      B.line(`${expected} = call i1 @llvm.expect.i1(i1 ${condition}, i1 false)`);
      const next = B.newLabel("spec.ok");
      B.condBr(expected, failed, next);
      B.startBlock(next);
    };
    // Heap reads come first, before any check, and release their temporaries
    // at once: a bailing path then owns nothing, and reads have no effect
    // whose reordering before the arithmetic could be observed.
    const reads = new Map<IrExpr, LlValue>();
    if (target.value !== null) {
      this.frames.push([]);
      for (const read of speculativeReads(target.value)) reads.set(read, this.emitExpr(read));
      this.releaseFrame(this.frames.pop()!);
    }
    this.frames.push([]);
    let result: string;
    if (target.value === null) {
      const old = B.tmp();
      result = B.tmp();
      B.line(`${old} = load i64, ptr ${binding.slot}`);
      B.line(`${result} = ${target.op === "+" ? "add" : "sub"} nsw i64 ${old}, 1`);
      const biased = B.tmp(),
        outside = B.tmp();
      B.line(`${biased} = add i64 ${result}, ${Number.MAX_SAFE_INTEGER}`);
      B.line(`${outside} = icmp ugt i64 ${biased}, ${2 * Number.MAX_SAFE_INTEGER}`);
      bail(outside);
    } else result = emitSpeculativeInteger(this, target.value, bail, reads);
    // Speculable values read only numbers past this point.
    if (this.frames.pop()!.length > 0)
      throw new InternalCompilerError("llvm emitter bug: speculative write owns a temporary");
    B.line(`store i64 ${result}, ptr ${binding.slot}`);
    const deferred = this.speculation!.deferred;
    if (!deferred.has(target.localId)) {
      const number = B.tmp();
      B.line(`${number} = sitofp i64 ${result} to double`);
      B.line(`store double ${number}, ptr ${this.binding(target.localId).slot}`);
    }
    if (!bails) return;
    const done = B.newLabel("spec.done");
    B.br(done);
    B.startBlock(failed);
    this.writeBackSpeculativeGlobals(deferred);
    B.br(resume);
    B.startBlock(done);
  }

  /** The amortized cancellation poll, emitted on the loop's back edge (the
   * continue target), after the body. A poll in the header would be a loop
   * exit ahead of the body; LLVM then cannot rotate the loop, so loads that
   * the body repeats on every iteration (a typed array's length, for one)
   * stay in the loop. */
  private emitWorkerLoopCheck(slot: string | null): void {
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
    } else if (t.kind === "object" && this.classMeta.get(t.className)?.hierarchy === true) {
      // Hierarchy instances carry a vtable word: the OBJ kind keeps the
      // dynamic class inspectable (catch-binding instanceof, the uncaught
      // printer's "name: message" for Error instances).
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
      default:
        throw new LlvmUnsupportedError(`truthy:${unionArm ? "union:" : ""}${kind}`);
    }
  }

  // ── union plumbing ──────────────────────────────────────────────────────

  /** A union value's tag (i32): the box's tag word, or the NULL test of a
   * nullable union's pointer. */
  unionTag(uName: string, unionId: string): string {
    return emitUnionTag(this.B, this.nullableUnions.get(unionId), uName);
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
    return emitUnionPeek(this.B, this.nullableUnions.get(unionId), uName);
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
    return this.retainValue(this.unionPeek(uName, unionId), arm);
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
      if (tag !== nullable.refTag)
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
  ): { ptr: string; type: IrType; inline: boolean } {
    const meta = this.classMetaOf(className);
    const { index, type } = classFieldIndex(meta, field);
    const p = this.B.tmp();
    this.B.line(
      `${p} = getelementptr inbounds %${classStructSym(className)}, ptr ${objName}, i64 0, i32 ${index}`,
    );
    this.markFieldPointer(p, field);
    return { ptr: p, type, inline: this.inlineUnions.classField(className, field) };
  }

  /** `o->vt->pre` — the dynamic class's preorder number (borrowed object;
   * the static class names which struct spelling carries the vt word). */
  loadVtPre(objName: string, staticClassName: string): string {
    const B = this.B;
    const vtp = B.tmp();
    const vt = B.tmp();
    const prep = B.tmp();
    const pre = B.tmp();
    B.line(
      `${vtp} = getelementptr inbounds %${classStructSym(staticClassName)}, ptr ${objName}, i64 0, i32 1`,
    );
    B.line(`${vt} = load ptr, ptr ${vtp}`);
    B.line(`${prep} = getelementptr inbounds %ScrVt, ptr ${vt}, i64 0, i32 0`);
    B.line(`${pre} = load ${this.sizeType}, ptr ${prep}`);
    return pre;
  }

  /** The class object's static symbol (classes as values), registering it
   * for assembly on first use and interning the .name literal while the
   * table is still open (the regex-literal discipline). */
  classObjSym(className: string): string {
    if (!this.classObjs.has(className)) {
      const meta = this.classMetaOf(className);
      this.classObjs.set(className, { nameSym: this.internLiteral(meta.def.jsName ?? "") });
    }
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
        layout = "record:";
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
      `${p} = getelementptr inbounds %${mangleRecordStruct(shapeId)}, ptr ${objName}, i64 0, i32 ${idx + 1}`,
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
      `${p} = getelementptr inbounds %${mangleRecordStruct(shapeId)}, ptr ${objName}, i64 0, i32 ${shape.fields.length + 1}`,
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
      this.moveTemp(v);
      const old = this.B.tmp();
      this.B.line(`${old} = load ptr, ptr ${ptr}`);
      this.storeField(ptr, type, v.name, false);
      this.releaseValue(old, type);
      return;
    }
    this.storeField(ptr, type, v.name, inline);
  }

  /** Stores `v` (from emitFieldValue) into a fresh field slot. */
  initField(ptr: string, type: IrType, inline: boolean, v: LlValue): void {
    if (!inline && isRefCounted(type)) this.moveTemp(v);
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

  private emitDebugLocal(local: IrLocal, slot: string, arg = 0, captured = false): void {
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

  /** The payload slot of a capture box (ScrBox.slot, field 5). */
  private boxSlot(box: string): string {
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
    // captured number in a register across a loop of calls.
    if (acc === "f64") {
      B.line(`${r} = load double, ptr ${this.boxSlot(box)}`);
    } else if (acc === "bool") {
      const raw = B.tmp();
      B.line(`${raw} = load i64, ptr ${this.boxSlot(box)}`);
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
      B.line(`store double ${value}, ptr ${this.boxSlot(box)}`);
    } else if (acc === "bool") {
      const raw = B.tmp();
      B.line(`${raw} = zext i1 ${value} to i64`);
      B.line(`store i64 ${raw}, ptr ${this.boxSlot(box)}`);
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
    this.boxSet(box, type, isRefCounted(type) ? this.retainValue(value, type) : value);
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
  private tdzScalarInit(box: string, t: IrType, value: string): void {
    const B = this.B;
    const acc = boxAccess(t);
    const cell = B.tmp();
    B.line(`${cell} = ${arrNewCall(this.shapeHost, t, "1")} ; TDZ cell`);
    this.arrPush(cell, acc === "bool" ? "bool" : "f64", value);
    this.declare(`declare void @scr_box_set_ref(ptr, ptr)`);
    B.line(`call void @scr_box_set_ref(ptr ${box}, ptr ${cell})`);
  }

  /** The payload a TDZ box holds before its declaration runs, when that is
   * not NULL. A nullable union's value is its arm pointer with NULL as a
   * unit arm (nullable-unions.ts), so a stored `null`/`undefined` would
   * read back as the temporal dead zone; such boxes start at the module's
   * immortal NULLABLE_ABSENT sentinel instead, which no value of the
   * binding can hold and every RC entry point and the collector skip. */
  private tdzEmptySentinel(t: IrType): string | null {
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
      borrowed && isRefCounted(local.type) ? this.retainValue(value, local.type) : value,
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

  /** Move a clean async return value into the current fiber's promise. */
  private emitWasiFulfill(v: LlValue | null): void {
    const coro = this.currentCoro;
    if (coro === null)
      throw new InternalCompilerError("llvm emitter bug: wasm fulfillment outside async body");
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
          this.B.line(
            `call void @scr_gen_out_ref(ptr ${gen}, ptr ${v!.name}, ptr ${vAdapters(this.shapeHost, ret).release})`,
          );
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
      case "dyn":
        this.declare(`declare void @scr_promise_resolve_dyn(ptr, ptr)`);
        this.B.line(`call void @scr_promise_resolve_dyn(ptr ${pr}, ptr ${v!.name}) ; moves in`);
        break;
      default: {
        const rc = vAdapters(this.shapeHost, ret);
        this.declare(`declare void @scr_promise_fulfill_ref(ptr, ptr, ptr, ptr, ptr)`);
        this.B.line(
          `call void @scr_promise_fulfill_ref(ptr ${pr}, ptr ${v!.name}, ptr ${rc.retain}, ptr ${rc.release}, ptr ${traceArg(this.shapeHost, ret)})`,
        );
      }
    }
  }

  /** Number locals declared as a copy of a capture or of a lazily boxed
   * parameter, at the top of the body. */
  private doubleCopies(fn: IrFunction): string[] {
    const copies: string[] = [];
    for (const s of fn.body) {
      if (s.kind !== "varDecl") break;
      if (s.init?.kind !== "varRef" || s.init.type.kind !== "f64") continue;
      const source = s.init.localId;
      if (this.captureIds.has(source) || this.lazyCaptureBoxes.has(source)) copies.push(s.localId);
    }
    return copies;
  }

  private emitFunction(fn: IrFunction): string {
    const B = new BlockBuilder();
    this.B = B;
    this.currentFunctionName = fn.name;
    // Fiber switches restore the active exception cell before control
    // returns to a synchronous frame (emitPendingCheck).
    B.excCellInvariant = fn.async !== true && fn.generator === undefined;
    this.debugScope = this.debug?.function(fn) ?? null;
    B.debugLocation = this.debug?.location(fn.loc, this.debugScope) ?? null;
    this.frames = [];
    this.scopes = [];
    this.unwindCleanups.clear();
    this.jumpTargets = [];
    this.currentLocals = new Map(fn.locals.map((l) => [l.id, l]));
    this.lazyCaptureBoxes.clear();
    this.lazyStackBoxes.clear();
    // An unchanged captured parameter keeps its value in a plain slot; the
    // binding is boxed only for closures (captureBox).
    const lazyParameters = this.lazyCaptures.parameters(fn);
    for (const id of lazyParameters) {
      const { boxed: _boxed, ...plain } = this.currentLocals.get(id)!;
      this.currentLocals.set(id, plain);
      this.lazyCaptureBoxes.set(id, "");
    }
    this.currentConstantCallbacks =
      this.debug === null ? (this.constantCallbacks.get(fn.name) ?? new Map()) : new Map();
    // Preserve concrete source bindings for debugger inspection. Suspended
    // functions keep the established array lifetime across continuations.
    this.streamingSplitsEnabled = this.debug === null && !fn.async && !fn.generator;
    this.stackCallbacks.reset(this.streamingSplitsEnabled);
    this.stackCaptures.reset(fn, this.streamingSplitsEnabled, lazyParameters);
    this.privateSplitLocals = this.streamingSplitsEnabled ? findPrivateSplitLocals(fn) : new Map();
    this.storedSplits.clear();
    this.splitSpans.clear();
    this.stringSlices.clear();
    const initializerBindings = this.initializerBindings.get(fn.name) ?? [];
    const numericFn = withInitializerBindings(fn, initializerBindings);
    this.numericLocals = new Map(numericFn.locals.map((l) => [l.id, l]));
    this.borrowedParameters.clear();
    this.referenceWrites?.enter(fn);
    this.reboundOwnerSlots.clear();
    this.projectedParameters.clear();
    const projectedParameterIndexes = this.callLifetimes.parameters.get(fn.name);
    if (projectedParameterIndexes)
      for (const index of projectedParameterIndexes)
        this.projectedParameters.add(fn.params[index]!.localId);
    this.stableCallBindings = this.callLifetimes.bindings.get(fn.name) ?? new Set();
    const borrowedParameterIndexes = this.callLifetimes.borrowed.get(fn.name);
    if (borrowedParameterIndexes) {
      // Rebound walk parameters borrow too, but only unchanged ones may
      // serve as stable owners for call arguments and aliases.
      for (const index of borrowedParameterIndexes)
        if (
          !this.walkBorrowsByFunction.get(fn.name)?.has(fn.params[index]!.localId) &&
          !this.reboundByFunction.get(fn.name)?.has(fn.params[index]!.localId)
        )
          this.borrowedParameters.add(fn.params[index]!.localId);
    }
    // A generator frame owns its unchanged parameters across suspensions.
    const generatorParameters = this.callLifetimes.generatorParameters.get(fn.name);
    if (generatorParameters !== undefined)
      for (const id of generatorParameters) this.borrowedParameters.add(id);
    this.captureIds = new Set(
      [...(fn.captures ?? []), ...(fn.classCaptures ?? [])].map((c) => c.localId),
    );
    this.stableCaptureIds =
      fn.captures !== undefined ? this.lazyCaptures.stableCaptures(fn.name) : new Set();
    this.integerLoopBindings.clear();
    this.countedLoopsEnabled = this.debug === null && !fn.async && !fn.generator;
    this.speculativeLoopsEnabled = this.countedLoopsEnabled;
    this.speculativeFunction = fn.name;
    this.speculation = null;
    this.speculationResume = null;
    this.finalFieldBorrows =
      !fn.async && !fn.generator && constructorClass(fn.name) === null && this.finalFields.size > 0;
    this.byteWindowsEnabled = this.countedLoopsEnabled;
    this.byteWindowEntries =
      this.byteWindowsEnabled && numericFn.locals.some((l) => l.type.kind === "bytes")
        ? findInitializedByteLoopBindings(fn)
        : new Map();
    this.integerViews.clear();
    this.fieldPointerTags.clear();
    this.integerArrayBindings.clear();
    this.loopArrayBorrows =
      this.debug === null
        ? findLoopArrayBorrows(
            fn,
            this.callLifetimes,
            this.referenceEffects,
            this.optionalArrayReads,
            this.referenceWrites,
            this.fnByName,
          )
        : new Set();
    this.localArrayReads = findLocalArrayReads(
      fn,
      this.fnByName,
      this.unionsById,
      this.referenceEffects.functions,
      this.callLifetimes,
      this.optionalArrayReads,
      this.loopArrayBorrows,
      this.debug === null ? this.referenceEffects : undefined,
    );
    this.callArrayReads = findCallArrayReads(
      fn,
      this.optionalArrayReads,
      this.referenceEffects.functions,
      this.callLifetimes,
      this.debug === null ? this.referenceEffects : undefined,
    );
    this.scalarStringSlices =
      this.debug === null ? findScalarStringSlices(fn, this.callLifetimes) : new Map();
    this.mapReadLifetimes = findMapReadLifetimes(fn, this.boxedUnionsById, this.callLifetimes);
    this.readNumberMapWrites = findReadNumberMapWrites(fn);
    this.mapEntryFusion = this.debug === null ? findMapEntryFusions(fn) : null;
    this.localStackUnions = findLocalStackUnions(fn, this.callLifetimes, this.boxedUnionsById);
    this.localStackObjects = this.stackObjects
      ? findLocalStackObjects(this, fn, this.callLifetimes)
      : new Map();
    this.reassignedStackObjects = this.stackObjects
      ? findReassignedStackObjects(this, fn, this.callLifetimes)
      : new Set();
    this.stackObjectSlots = new Map();
    this.localUnionStorageProofs = findLocalUnionStorage(fn, this.callLifetimes, this.unionSources);
    this.localUnionStorage = new Map();
    this.walkBorrows = this.walkBorrowsByFunction.get(fn.name) ?? new Set();
    const slotFacts = this.int32Slots.facts(fn.name);
    this.integerRanges = analyzeIntegerRanges(numericFn, slotFacts);
    this.int32Elements = slotFacts.elements ?? null;
    this.bytesBounds = findBytesBounds(numericFn, this.integerRanges);
    // Debug builds keep every number local a double for the debugger's
    // variable view. Lazily boxed captured parameters keep their double,
    // which the box is created from, and so do plain copies of a capture or
    // such a parameter (copyStableCaptures): the source already holds the
    // double, which an i32 copy would convert and widen again on every call.
    // Initializer bindings proven int32 move into an i32 local of their
    // initializer: no other code observes the global, so the loop-carried
    // value never round-trips through the double slot.
    const initializerLocals = initializerLocalCandidates(initializerBindings);
    const int32Locals =
      this.debug === null
        ? findInt32Locals(
            withInitializerLocals(fn, initializerLocals),
            this.integerRanges,
            this.int32Slots.facts(fn.name),
            new Set([...this.lazyCaptureBoxes.keys(), ...this.doubleCopies(fn)]),
          )
        : null;
    this.int32Locals = int32Locals?.locals ?? new Map();
    this.int32LocalWrites = int32Locals?.values ?? new Set();
    const localizedGlobals = new Set<string>();
    for (const global of initializerLocals) {
      if (!this.int32Locals.has(global.id)) continue;
      localizedGlobals.add(global.id);
      this.currentLocals.set(global.id, {
        id: global.id,
        name: global.name,
        type: global.type,
        mutable: global.mutable,
      });
    }
    this.chainSlots.clear();
    this.finallyStack = [];
    this.tryStack = [];
    this.loopDepth = 0;
    this.currentReturnType = fn.returnType;
    const int32Abi = this.int32Abis.get(fn.name);
    this.currentInt32Result = int32Abi?.result === true;
    this.currentUnionResult = int32Abi?.union === true;
    this.currentGenerator = fn.generator ?? null;
    this.currentAsyncGenerator = fn.async === true && fn.generator !== undefined;
    this.currentBorrowedReturn = this.borrowedReturns.has(fn.name);
    this.lastUseMoves.clear();
    this.varRefCounts = null;
    this.currentFunctionBody = fn.body;
    this.inConstructor = this.constructorFunctions.has(fn.name);
    this.currentCoro = null;
    this.logArgSlots = 0;

    if (this.coroLowered(fn)) {
      this.usesCoroutines = true;
      this.declare(`declare token @llvm.coro.id(i32, ptr, ptr, ptr)`);
      this.declare(`declare ${this.sizeType} @llvm.coro.size.${this.sizeType}()`);
      this.declare(`declare ptr @llvm.coro.begin(token, ptr)`);
      this.declare(`declare token @llvm.coro.save(ptr)`);
      this.declare(`declare i8 @llvm.coro.suspend(token, i1)`);
      this.declare(`declare ptr @llvm.coro.free(token, ptr)`);
      this.declare(`declare void @llvm.coro.end(ptr, i1, token)`);
      // Native frames come from the runtime's small-block allocator.
      const frameAlloc = this.wasi ? "malloc" : "scr_rt_calloc";
      this.declare(`declare ptr @${frameAlloc}(${this.sizeType})`);
      this.declare(`declare void @${this.wasi ? "free" : "scr_rt_free"}(ptr)`);
      const started = this.wasi ? "scr_wasi_coro_started" : "scr_coro_started";
      this.declare(`declare void @${started}(ptr)`);
      this.declare(`declare ptr @scr_fiber_self()`);
      const id = B.tmp();
      const size = B.tmp();
      const mem = B.tmp();
      const handle = B.tmp();
      const self = B.tmp();
      B.line(`${id} = call token @llvm.coro.id(i32 0, ptr null, ptr null, ptr null)`);
      B.line(`${size} = call ${this.sizeType} @llvm.coro.size.${this.sizeType}()`);
      B.line(`${mem} = call ptr @${frameAlloc}(${this.sizeType} ${size})`);
      B.line(`${handle} = call ptr @llvm.coro.begin(token ${id}, ptr ${mem})`);
      B.line(`call void @${started}(ptr ${handle})`);
      B.line(`${self} = call ptr @scr_fiber_self()`);
      // A native synchronous body owns its generator for the whole run (the
      // ScrGen owns the frame), so its OUT slot address is fixed.
      let out: string | null = null;
      const yieldKind = fn.generator?.yieldT.kind;
      if (
        !this.wasi &&
        fn.async !== true &&
        (yieldKind === "f64" || yieldKind === "date" || yieldKind === "bool")
      ) {
        this.declare(`declare ptr @scr_gen_of_fiber(ptr)`);
        const gen = B.tmp();
        B.line(`${gen} = call ptr @scr_gen_of_fiber(ptr ${self})`);
        out = this.genOutSlot(gen);
      }
      this.currentCoro = {
        kind: fn.generator !== undefined ? "generator" : "async",
        id,
        handle,
        self,
        finalLabel: B.newLabel("coro.final"),
        cleanupLabel: B.newLabel("coro.cleanup"),
        suspendLabel: B.newLabel("coro.suspend"),
        out,
      };
    }

    const paramIds = new Set(fn.params.map((p) => p.localId));
    if (this.debug === null) {
      for (const id of findIntegerViews(numericFn)) {
        // An i32 slot is its own view.
        if (this.int32Locals.has(id)) continue;
        const slot = B.slot();
        B.entryAllocas.push(
          `${slot} = alloca i32 ; integer view ${this.numericLocals.get(id)!.name}`,
        );
        this.integerViews.set(id, slot);
      }
    }
    for (const global of initializerBindings) {
      if (!this.integerViews.has(global.id)) continue;
      const value = B.tmp();
      B.line(`${value} = load double, ptr @${mangleGlobal(global.id)}`);
      this.storeIntegerView(global.id, { name: value, type: global.type });
    }
    // A number global only its guarded, synchronous initializer reads or
    // writes (findInitializerBindings) is invisible to every other function,
    // and reentry returns before reaching it, so a local slot can stand in
    // for it: LLVM keeps it in a register across calls and loops that would
    // otherwise force a store and reload per iteration. The global's
    // storage is never read again, so nothing writes the slot back. Bindings
    // proven int32 already live in an i32 local (localizedGlobals above);
    // this covers the remaining doubles.
    this.privateGlobalSlots.clear();
    if (this.debug === null && this.currentCoro === null && !fn.async && !fn.generator) {
      const conditional = initializerLocals.length ? conditionalLoopWrites(fn.body) : null;
      for (const global of initializerLocals) {
        if (localizedGlobals.has(global.id)) continue;
        // A conditional update in a loop stays a memory update (see
        // conditionalLoopWrites).
        if (conditional?.has(global.id)) continue;
        const slot = B.slot();
        const value = B.tmp();
        B.entryAllocas.push(`${slot} = alloca double ; module binding ${global.name}`);
        B.line(`${value} = load double, ptr @${mangleGlobal(global.id)}`);
        B.line(`store double ${value}, ptr ${slot}`);
        this.privateGlobalSlots.set(global.id, slot);
      }
    }
    for (const local of this.currentLocals.values()) {
      // Boxed locals' slots hold their capture BOX (a ptr); captured
      // (env-borrowed) locals bind the incoming box below. A caught-typed
      // local is a catch binding: its slot holds the ScrCaught snapshot
      // box the catch prologue takes (scr_exc_take).
      const slotTy =
        local.boxed || this.captureIds.has(local.id) || local.type.kind === "caught"
          ? "ptr"
          : this.int32Locals.has(local.id)
            ? "i32"
            : this.llType(local.type);
      B.entryAllocas.push(`%${mangleLocal(local.id)} = alloca ${slotTy} ; ${local.name}`);
      this.emitDebugLocal(
        local,
        `%${mangleLocal(local.id)}`,
        fn.params.findIndex((p) => p.localId === local.id) + 1,
        this.captureIds.has(local.id),
      );
      // A localized initializer binding starts at its global's zero value.
      if (localizedGlobals.has(local.id)) B.line(`store i32 0, ptr %${mangleLocal(local.id)}`);
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
    (fn.classCaptures ?? []).forEach((c) => {
      const self = fn.params[0]!;
      if (self.type.kind !== "object")
        throw new InternalCompilerError("class captures require an instance receiver");
      const classSlot = B.tmp();
      const classValue = B.tmp();
      const caps = B.tmp();
      const slot = B.tmp();
      const box = B.tmp();
      B.line(
        `${classSlot} = getelementptr inbounds %${mangleClassStruct(self.type.className)}, ptr %p_${mangleLocal(self.localId)}, i64 0, i32 ${classEnvironmentIndex(this.classMeta.get(self.type.className)!)}`,
      );
      B.line(`${classValue} = load ptr, ptr ${classSlot}`);
      B.line(`${caps} = getelementptr inbounds %ScrClassObj, ptr ${classValue}, i64 1`);
      B.line(`${slot} = getelementptr inbounds ptr, ptr ${caps}, ${this.sizeType} ${c.slot}`);
      B.line(`${box} = load ptr, ptr ${slot}`);
      B.line(`store ptr ${box}, ptr %${mangleLocal(c.localId)} ; class capture ${c.name}`);
    });
    // Params spill into their slots; the function scope owns refcounted
    // params (callees own their params — callers passed +1). Boxed params
    // allocate the shared binding and move the raw value in.
    const fnScope: LlScopeEntry[] = [];
    for (const id of this.lazyCaptureBoxes.keys()) {
      const cache = B.slot();
      B.entryAllocas.push(`${cache} = alloca ptr ; lazy box ${this.currentLocals.get(id)!.name}`);
      B.line(`store ptr null, ptr ${cache}`);
      fnScope.push({
        slot: cache,
        type: this.currentLocals.get(id)!.type,
        boxed: true,
        lazy: true,
      });
      this.lazyCaptureBoxes.set(id, cache);
      // Environments that finish during the call can share an immortal
      // frame box. Its payload owner is released with the function scope.
      const stack = this.stackCaptures.emit(this, id, this.currentLocals.get(id)!.type);
      if (stack) {
        this.lazyStackBoxes.set(id, stack.box);
        if (stack.owner) fnScope.push(stack.owner);
      }
    }
    const borrowed = this.callLifetimes.borrowed.get(fn.name);
    for (const [index, p] of fn.params.entries()) {
      const local = this.currentLocals.get(p.localId)!;
      const slot = `%${mangleLocal(p.localId)}`;
      if (local.boxed) {
        const box = B.tmp();
        B.line(`${box} = ${boxNewCall(this.shapeHost, p.type)} ; ${p.name} (boxed param)`);
        this.boxSet(box, p.type, `%p_${mangleLocal(p.localId)}`);
        B.line(`store ptr ${box}, ptr ${slot}`);
        fnScope.push({ slot, type: p.type, boxed: true });
        continue;
      }
      const incoming: LlValue = { name: `%p_${mangleLocal(p.localId)}`, type: p.type };
      if (int32Abi?.params[index]) {
        const bits = `%p_${mangleLocal(p.localId)}${INT32_ABI_SUFFIX}`;
        incoming.uint32 = bits;
        incoming.integer = { name: bits, type: "i32", signed: true, range: INT32_RANGE };
      }
      if (this.storeInt32Local(p.localId, incoming)) continue;
      B.line(`store ${this.llType(p.type)} %p_${mangleLocal(p.localId)}, ptr ${slot}`);
      this.storeIntegerView(p.localId, incoming);
      if (isRefCounted(p.type) && !borrowed?.has(index)) {
        fnScope.push({ slot, type: p.type });
        this.noteParameterMove(fn, p.localId, slot);
      }
      if (this.reboundByFunction.get(fn.name)?.has(p.localId) && borrowed?.has(index)) {
        // The caller's borrow stays in the parameter slot; values the body
        // assigns are owned here until rebinding or exit releases them.
        const owner = `${slot}.owner`;
        B.entryAllocas.push(`${owner} = alloca ptr`);
        B.line(`store ptr null, ptr ${owner}`);
        fnScope.push({ slot: owner, type: p.type });
        this.reboundOwnerSlots.set(p.localId, owner);
      }
    }
    this.scopes.push(fnScope);
    // Stackful native fibers and native coroutine frames retain these frames
    // while suspended. The active exception context owns the chain, so
    // concurrent fibers isolate it.
    if (this.stackTraces && !this.wasi && fn.sourceName !== undefined) {
      this.declare(`declare void @scr_stack_enter(ptr, ptr)`);
      this.declare(`declare void @scr_stack_leave(ptr)`);
      B.entryAllocas.push(`%source_frame = alloca { ptr, ptr }`);
      const frame = `    at ${fn.sourceName} (${fn.loc.file})`;
      B.line(`call void @scr_stack_enter(ptr %source_frame, ptr ${this.cstr(frame)})`);
      B.returnEpilogue = `call void @scr_stack_leave(ptr %source_frame)`;
    }
    if (this.stackChecks?.has(fn.name)) this.emitStackCheck();
    if (this.workerEntryPolls?.has(fn.name)) this.emitPendingCheck(undefined, true);
    this.emitStmts(fn.body, true);
    // Implicit exit of a void function: release the function scope unless
    // the body already terminated its final block (return, or a throw
    // whose unwind released everything down to depth 0).
    if (fn.returnType.kind === "void" && !B.isTerminated()) {
      this.releaseScope(this.scopes[0]!);
      // Completing by falling off the end has nothing to await.
      if (this.currentAsyncGenerator) this.emitAsyncGenSettled();
      if (this.currentCoro !== null) {
        this.emitWasiFulfill(null);
        B.terminate(`br label %${this.currentCoro.finalLabel}`);
      } else {
        B.terminate("ret void");
      }
    }
    this.scopes.pop();

    const coro = this.currentCoro;
    if (coro !== null) {
      B.startBlock(coro.finalLabel);
      // Every exit of a coroutine body joins here: its source frame (part
      // of the coroutine frame) leaves the generator's own chain.
      const epilogue = B.returnEpilogue;
      B.returnEpilogue = null;
      if (epilogue !== null) B.line(epilogue);
      if (fn.captures !== undefined) {
        this.declare(`declare void @scr_closure_release(ptr)`);
        B.line(`call void @scr_closure_release(ptr %sc_env)`);
      }
      if (coro.kind === "generator") {
        const finish = this.wasi ? "scr_wasi_gen_finish" : "scr_gen_coro_finish";
        this.declare(`declare void @${finish}(ptr)`);
        B.line(`call void @${finish}(ptr ${coro.self})`);
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
      B.line(`call void @${this.wasi ? "free" : "scr_rt_free"}(ptr ${frame})`);
      B.br(coro.suspendLabel);
      B.startBlock(coro.suspendLabel);
      B.line(`call void @llvm.coro.end(ptr ${coro.handle}, i1 false, token none)`);
      const ret = this.llType(fn.returnType);
      if (ret === "void") B.terminate(`ret void`);
      else if (ret === "double") B.terminate(`ret double ${f64Lit(0)}`);
      else if (ret === "i1") B.terminate(`ret i1 false`);
      else B.terminate(`ret ptr null`);
    }

    // Shared blocks have multiple source locations. Keep the location on
    // each incoming exception check instead of assigning one to the cleanup.
    B.debugLocation = null;
    for (const cleanup of this.unwindCleanups.values()) {
      B.startBlock(cleanup.label);
      this.releaseScope(cleanup.entries);
      B.terminate(cleanup.terminator);
    }

    if (this.logArgSlots > 0) {
      B.entryAllocas.push(`%logargs = alloca [${this.logArgSlots} x %ScrLogArg]`);
    }
    const params = fn.params.map((p, index) =>
      int32Abi?.params[index]
        ? `i32 %p_${mangleLocal(p.localId)}${INT32_ABI_SUFFIX}`
        : `${this.llType(p.type)} %p_${mangleLocal(p.localId)}`,
    );
    // The i32 entry widens its i32 parameters once; the proof makes the
    // double exact, so readers of the incoming number see the same value.
    if (int32Abi)
      fn.params.forEach((p, index) => {
        if (!int32Abi.params[index]) return;
        const name = `%p_${mangleLocal(p.localId)}`;
        B.entryAllocas.push(`${name} = sitofp i32 ${name}${INT32_ABI_SUFFIX} to double`);
      });
    // Lifted functions receive their closure first (the callValue ABI).
    if (fn.captures !== undefined) params.unshift("ptr %sc_env");
    const ret = int32Abi?.result
      ? "i32"
      : int32Abi?.union
        ? SCALAR_UNION_RESULT
        : this.llType(fn.returnType);
    let attrs = coro !== null ? "#1" : FN_ATTRS;
    // The shared indexed-read helper (lowerSafeIndexRead) is a dense bounds
    // test, a state test and a load behind cold runtime fallbacks, called
    // from every `a[i]` of one element type. Without the hint LLVM keeps the
    // hot instances out of line once they have many callers: every read pays
    // a call, and an integer index converts to a double and back across it.
    if (fn.name.startsWith("%arr.idxOr.")) attrs = `inlinehint ${attrs}`;
    // Interface dispatch is a few key tests and direct calls ahead of the
    // checked dynamic call. Keeping that fallback out of line leaves the
    // tests small enough to inline at each call site.
    if (fn.name.startsWith("%dyn.class.protocol.fallback.")) attrs = `noinline ${attrs}`;
    else if (fn.name.startsWith("%dyn.class.protocol.")) attrs = `inlinehint ${attrs}`;
    if (fn.name.startsWith(RESULT_ENTRY_PREFIX)) attrs = `inlinehint ${attrs}`;
    const debug = this.debugScope === null ? "" : ` !dbg ${this.debugScope}`;
    const symbol = borrowed ? mangleBorrowedFunction(fn.name) : mangleFunction(fn.name);
    this.privateGlobalSlots.clear();
    let body = `define internal ${ret} @${symbol}${int32Abi ? INT32_ABI_SUFFIX : ""}(${params.join(", ")}) ${attrs}${debug} { ; ${fn.name}\n${B.render()}\n}`;
    if (int32Abi) body += "\n" + this.emitInt32AbiWrapper(fn, symbol, int32Abi);
    if (this.integerClones.members.has(fn.name)) {
      body += "\n" + emitIntegerClone(fn, this, this.stackChecks?.has(fn.name) === true);
      if (this.integerClones.dispatched.has(fn.name))
        body +=
          "\n" +
          emitIntegerDispatcher(
            fn,
            this,
            `${symbol}${int32Abi ? INT32_ABI_SUFFIX : ""}`,
            int32Abi?.params ?? [],
            int32Abi?.result === true,
          );
    }
    if (!borrowed) return body;
    const slot = this.implSlotBorrowed(fn.name);
    const virtual =
      slot.size > 0 && slot.size !== borrowed.size
        ? "\n" + this.emitOwnedCallAdapter(fn, borrowed, slot)
        : "";
    return body + "\n" + this.emitOwnedCallAdapter(fn, borrowed) + virtual;
  }

  /** The double-ABI entry of a function with an i32 entry: every caller
   * that is not a direct call (closures, dispatch, adapters, the runtime)
   * enters here. A pending exception passes through to its caller. */
  private emitInt32AbiWrapper(fn: IrFunction, symbol: string, abi: Int32Abi): string {
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
  private emitOwnedCallAdapter(
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
      B.line(`store ptr ${this.retainValue("%result", fn.returnType)}, ptr ${slot}`);
      B.br(done);
      B.startBlock(done);
      result = B.tmp();
      B.line(`${result} = load ptr, ptr ${slot}`);
    }
    for (const index of borrowed)
      if (!kept.has(index)) this.releaseValue(`%p${index}`, fn.params[index]!.type);
    B.terminate(ret === "void" ? "ret void" : `ret ${ret} ${result}`);
    const symbol =
      kept.size > 0 ? `${mangleBorrowedFunction(fn.name)}.virtual` : mangleFunction(fn.name);
    return `define internal ${ret} @${symbol}(${params.join(", ")}) ${FN_ATTRS} {\n${B.render()}\n}`;
  }

  /** A local stable binding keeps its value alive while later arguments
   * and the callee execute. A proven local union box cannot escape or be
   * rebound during a call; its independent payload owner keeps it alive.
   * Other writable bindings need an owned snapshot. */
  canBorrowCallArgument(value: IrExpr): boolean {
    if (value.kind === "strLit") return true;
    // An exact capsule owns its instance while the capsule's binding holds it.
    if (value.kind === "dynCheck" && value.exact)
      return value.value.kind === "varRef" && this.canBorrowCallArgument(value.value);
    // An inline union field has no box to lend.
    if (this.inlineFieldGet(value)) return false;
    // Class casts reinterpret the same pointer (prefix layouts).
    if (
      (value.kind === "upcast" || value.kind === "downcast") &&
      value.value.type.kind === "object"
    )
      return this.canBorrowCallArgument(value.value);
    if (value.kind === "seqExpr") {
      const guarded = guardedValue(value);
      return guarded !== null && this.canBorrowCallArgument(guarded);
    }
    // A nullable-union wrap reinterprets its payload pointer; an immortal
    // unit constant needs no owner at all.
    const wrap = this.borrowableNullableWrap(value);
    if (wrap === "unit") return true;
    if (wrap === "ref" && value.kind === "unionWrap")
      return this.canBorrowCallArgument(value.value);
    // Checked casts (`x as C`, `x!` on a nullable) lower to a ternary whose
    // failing arm always throws; the successful arm projects the same
    // stable owner. The throwing arm's typed dummy owns nothing.
    if (value.kind === "unionNarrow") return this.canBorrowCallArgument(value.value);
    if (value.kind === "libCall") return value.fn === "error.nodeThrow";
    // A final field never changes outside constructors: while its object is
    // borrowable, so is the field's value. Nullable-pointer fields have no
    // box to lend and keep their owning path.
    if (
      value.kind === "fieldGet" &&
      this.finalFieldBorrows &&
      isRefCounted(value.type) &&
      this.finalFields.isFinal(value.className, value.field) &&
      !this.nullableFieldGet(value)
    )
      return this.canBorrowReceiver(value.obj) && this.canBorrowCallArgument(value.obj);
    if (value.kind === "ternary")
      return (
        this.canBorrowReceiver(value.then) &&
        this.canBorrowReceiver(value.else_) &&
        this.canBorrowCallArgument(value.then) &&
        this.canBorrowCallArgument(value.else_)
      );
    // A construction-only field of a stable owner keeps its value until the
    // owner dies: no later operand or callee can replace and release it.
    if ((value.kind === "fieldGet" || value.kind === "recordGet") && this.immutableRead(value))
      return this.canBorrowCallArgument(value.obj);
    // An optional chain's bound receiver stays unchanged until its body
    // finishes (see emitReadReceiver).
    if (value.kind === "chainRecv") return this.chainSlots.has(value.id);
    if (value.kind !== "varRef") return false;
    const binding = this.binding(value.localId);
    // A module constant owns its value for the rest of the program.
    if (binding.kind === "global") return this.stableGlobals.has(value.localId);
    // So does the environment for a capture nothing ever rebinds.
    if (binding.kind === "boxed")
      return this.stableCaptureIds.has(value.localId) && this.canBorrowReceiver(value);
    return (
      binding.kind === "local" &&
      binding.local !== undefined &&
      (!binding.local.mutable ||
        this.stableCallBindings.has(value.localId) ||
        this.borrowedParameters.has(value.localId) ||
        this.localUnionStorage.has(value.localId)) &&
      !binding.local.boxed &&
      !binding.local.tdz
    );
  }

  /** A plain-pointer read of a construction-only field outside any
   * constructor (ImmutableFields). */
  private immutableRead(e: ExprOf<"fieldGet" | "recordGet">): boolean {
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
  private unwrittenAlias(s: IrStmt & { kind: "varDecl" }): boolean {
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
  private unwrittenLocalArrayRead(s: IrStmt & { kind: "varDecl" }, read: LocalArrayRead): boolean {
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
  private emitAdoptingReturn(s: IrStmt & { kind: "return" }, adopted: ExprOf<"awaitExpr">): void {
    const B = this.B;
    const promise = this.emitExpr(adopted.value);
    this.moveTemp(promise);
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
      this.moveTemp(v);
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
  private emitAsyncGenSettled(): void {
    this.declare(`declare void @scr_async_gen_hop_done()`);
    this.B.line(`call void @scr_async_gen_hop_done()`);
  }

  /** Owned-binding reads that take over the binding's reference, by read
   * node (the binding's slot). */
  private readonly lastUseMoves = new Map<IrExpr, string>();
  /** How often each varRef node object occurs in the current function:
   * lowering may share one node between several reads, and a move keyed by
   * node identity must fire for exactly one of them. */
  private varRefCounts: Map<IrExpr, number> | null = null;
  private currentFunctionBody: IrStmt[] = [];

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
  private noteLastUseMove(
    s: IrStmt & { kind: "varDecl" },
    b: ReturnType<LlEmitter["binding"]>,
  ): void {
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
  private noteParameterMove(fn: IrFunction, localId: string, slot: string): void {
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
  private movableReturn(
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
  private unwrittenWalkHost(fn: IrFunction, host: WalkBorrowHost): WalkBorrowHost {
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

  private emitStmts(stmts: IrStmt[], scoped = false): void {
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
  private emitBlock(stmts: IrStmt[], setup?: (scope: LlScopeEntry[]) => void): void {
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
      this.emitSpeculativeWrite(s, this.speculation.resume.get(s)!);
      return;
    }
    const previous = this.B.debugLocation;
    this.B.debugLocation = this.debug?.location(s.loc, this.debugScope) ?? null;
    const loop =
      s.kind === "while" || s.kind === "doWhile" || s.kind === "for" || s.kind === "forOf";
    if (loop) this.loopDepth++;
    try {
      this.emitStmtBody(s);
    } finally {
      this.B.debugLocation = previous;
      if (loop) this.loopDepth--;
    }
  }

  private emitStmtBody(s: IrStmt): void {
    const B = this.B;
    this.frames.push([]);
    switch (s.kind) {
      case "varDecl": {
        if (s.init && this.int32Locals.has(s.localId)) {
          this.storeInt32Local(s.localId, this.emitExpr(s.init), s.init);
          break;
        }
        const b = this.binding(s.localId);
        if (this.walkBorrows.has(s.localId) && b.kind === "local") {
          // A borrowed walk pointer: no retain now, no release at scope exit.
          const v = s.init === null ? "null" : this.emitReadReceiver(s.init).name;
          B.line(`store ptr ${v}, ptr ${b.slot}`);
          break;
        }
        const slice = this.scalarStringSlices.get(s.localId);
        if (slice) {
          const snapshot = emitStringSliceSnapshot(this, slice);
          this.stringSlices.set(s.localId, snapshot);
          this.scopes[this.scopes.length - 1]!.push({ slot: snapshot.source, type: STRING });
          break;
        }
        const split = this.privateSplitLocals.get(s.localId);
        if (split) {
          const snapshot = storeSplitSnapshot(this, emitSplitSnapshot(this, split));
          this.storedSplits.set(s.localId, snapshot);
          this.scopes[this.scopes.length - 1]!.push(
            { slot: snapshot.sourceSlot, type: STRING },
            { slot: snapshot.separatorSlot, type: STRING },
          );
          break;
        }
        const stackObject = this.localStackObjects.get(s.localId);
        if (stackObject) {
          B.line(`store ptr ${emitStackObject(this, stackObject).name}, ptr ${b.slot}`);
          break;
        }
        if (s.init && this.reassignedStackObjects.has(s.localId)) {
          const slot = this.stackObjectSlot(s.localId, s.init.type);
          emitStackObject(this, s.init as StackObjectSource, slot);
          B.line(`store ptr ${slot}, ptr ${b.slot}`);
          break;
        }
        const localUnion = this.localStackUnions.get(s.localId);
        if (localUnion) {
          const union = emitStackUnion(this, localUnion);
          B.line(`store ptr ${union.value.name}, ptr ${b.slot}`);
          if (union.payload) {
            this.moveTemp(union.payload);
            this.scopes[this.scopes.length - 1]!.push({
              slot: union.payloadSlot,
              type: union.payload.type,
            });
          }
          break;
        }
        const localRead = this.localArrayReads.get(s.localId);
        if (localRead) {
          const owner = emitLocalArrayRead(
            this,
            !localRead.borrow && this.unwrittenLocalArrayRead(s, localRead)
              ? { ...localRead, borrow: true }
              : localRead,
            b.slot,
          );
          if (owner) this.scopes[this.scopes.length - 1]!.push(owner);
          break;
        }
        const mapRead = this.mapReadLifetimes.locals.get(s.localId);
        if (mapRead) {
          const result = emitStackMapRead(this, mapRead);
          B.line(`store ptr ${result.value.name}, ptr ${b.slot}`);
          if (result.owner) this.scopes[this.scopes.length - 1]!.push(result.owner);
          break;
        }
        const localStorage = this.localUnionStorageProofs.get(s.localId);
        if (localStorage && s.init) {
          const storage = allocateLocalUnion(this, localStorage);
          this.localUnionStorage.set(s.localId, storage);
          storeLocalUnion(this, storage, s.init);
          B.line(`store ptr ${storage.box}, ptr ${b.slot}`);
          if (storage.owner && storage.ownerType)
            this.scopes[this.scopes.length - 1]!.push({
              slot: storage.owner,
              type: storage.ownerType,
            });
          break;
        }
        if (b.kind === "boxed") {
          const stack = this.stackCaptures.emit(this, s.localId, b.type);
          if (stack) {
            B.line(`store ptr ${stack.box}, ptr ${b.slot}`);
            if (stack.owner) this.scopes[this.scopes.length - 1]!.push(stack.owner);
            if (s.init) {
              const value = this.emitExpr(s.init);
              if (isRefCounted(value.type)) this.moveTemp(value);
              this.boxSet(stack.box, b.type, value.name);
            }
            break;
          }
          // Box FIRST, then evaluate the initializer: a named function
          // expression's closure captures this box during init evaluation.
          // A SCALAR TDZ box rides an ARR-kind box: the value lives in a
          // one-element array cell, so the empty (NULL) slot stays the
          // not-yet-initialized sentinel — a raw scalar slot has no spare
          // bit pattern to spend on it (stmts.ts's varDecl).
          const boxNew =
            b.local!.tdz === true && boxAccess(b.type) !== "ref"
              ? (this.declare(`declare ptr @scr_box_new(i32)`), `call ptr @scr_box_new(i32 3)`)
              : boxNewCall(this.shapeHost, b.type);
          const box = B.tmp();
          B.line(`${box} = ${boxNew} ; let ${b.local!.name} (boxed)`);
          B.line(`store ptr ${box}, ptr ${b.slot}`);
          this.scopes[this.scopes.length - 1]!.push({ slot: b.slot, type: b.type, boxed: true });
          if (s.init === null) {
            // An empty TDZ box whose payload can legitimately be NULL
            // starts at its distinct sentinel (tdzEmptySentinel).
            const sentinel = b.local!.tdz === true ? this.tdzEmptySentinel(b.type) : null;
            if (sentinel !== null) B.line(`store ptr ${sentinel}, ptr ${this.boxSlot(box)}`);
            break;
          }
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
        if (this.loopArrayBorrows.has(s) && s.init.kind === "arrayGet") {
          emitBorrowedArrayRead(this, s.init, b.slot);
          break;
        }
        const holeRead = this.loopArrayBorrows.has(s) ? dynHoleRead(s.init) : null;
        if (holeRead && s.init.kind === "ternary") {
          // A hole reads as the immortal undefined value, which needs no owner.
          const present = this.emitExpr(s.init.cond);
          const filled = B.newLabel("borrow.hole.filled"),
            missing = B.newLabel("borrow.hole.missing"),
            done = B.newLabel("borrow.hole.done");
          B.condBr(present.name, filled, missing);
          B.startBlock(filled);
          emitBorrowedArrayRead(this, holeRead, b.slot);
          B.br(done);
          B.startBlock(missing);
          this.declare("declare ptr @scr_dyn_undefined()");
          const undef = B.tmp();
          B.line(`${undef} = call ptr @scr_dyn_undefined()`);
          B.line(`store ptr ${undef}, ptr ${b.slot}`);
          B.br(done);
          B.startBlock(done);
          break;
        }
        // A stable lexical alias cannot outlive its unchanged local owner.
        // Whole-value uses still retain their own copies, so returning or
        // storing the alias preserves the ordinary heap representation.
        // Boxed captures, reassigned sources and projections need ownership.
        if (
          b.kind === "local" &&
          b.local &&
          isRefCounted(b.type) &&
          this.stableCallBindings.has(s.localId) &&
          (this.canBorrowCallArgument(s.init) || this.unwrittenAlias(s))
        ) {
          const v = this.emitReadReceiver(s.init);
          B.line(`store ptr ${v.name}, ptr ${b.slot}`);
          break;
        }
        const v = this.emitExpr(s.init);
        this.moveTemp(v);
        B.line(`store ${this.llType(b.type)} ${v.name}, ptr ${b.slot}`);
        this.storeIntegerView(s.localId, v, s.init);
        if (isRefCounted(b.type)) {
          this.scopes[this.scopes.length - 1]!.push({ slot: b.slot, type: b.type });
          this.noteLastUseMove(s, b);
        }
        break;
      }
      case "assign": {
        if (this.int32Locals.has(s.localId)) {
          this.storeInt32Local(s.localId, this.emitExpr(s.value), s.value);
          break;
        }
        const owner = this.reboundOwnerSlots.get(s.localId);
        if (owner !== undefined && !this.walkBorrows.has(s.localId)) {
          // A rebound borrowed parameter: the new value moves into the owner
          // slot, replacing (and releasing) the previous owned value. This
          // precedes the in-place string append, which would release the
          // caller's borrow.
          const param = this.binding(s.localId);
          const slot = param.slot;
          const v = this.emitExpr(s.value);
          this.moveTemp(v);
          const old = B.tmp();
          B.line(`${old} = load ptr, ptr ${owner}`);
          this.releaseValue(old, param.type);
          B.line(`store ptr ${v.name}, ptr ${slot}`);
          B.line(`store ptr ${v.name}, ptr ${owner}`);
          break;
        }
        if (this.reassignedStackObjects.has(s.localId)) {
          // The new value may read the old one: build it apart, then copy.
          const struct = stackObjectStruct(s.value.type);
          const value = emitStackObject(this, s.value as StackObjectSource);
          const bits = B.tmp();
          B.line(`${bits} = load ${struct}, ptr ${value.name}`);
          B.line(`store ${struct} ${bits}, ptr ${this.stackObjectSlot(s.localId, s.value.type)}`);
          break;
        }
        const localStorage = this.localUnionStorage.get(s.localId);
        if (localStorage) {
          storeLocalUnion(this, localStorage, s.value);
          break;
        }
        const self = matchStringSelfConcat(s.localId, s.value);
        if (self) {
          this.emitStringSelfConcatAssign(s.localId, self.left, self.suffix, false);
          break;
        }
        const b = this.binding(s.localId);
        if (this.walkBorrows.has(s.localId) && b.kind === "local") {
          // Rebinding a borrowed walk pointer releases nothing.
          B.line(`store ptr ${this.emitReadReceiver(s.value).name}, ptr ${b.slot}`);
          break;
        }
        const v = this.emitExpr(s.value);
        if (b.kind === "global" && !s.initializes) this.checkGlobalTdz(s.localId);
        if (b.kind === "boxed") {
          this.writeBindingBox(this.loadBox(b.slot), b.local!, v.name, s.initializes);
          // The RHS remains frame-owned until a possible TDZ throw passes.
          if (isRefCounted(v.type)) this.moveTemp(v);
          break;
        }
        this.moveTemp(v);
        if (isRefCounted(b.type)) {
          const old = B.tmp();
          B.line(`${old} = load ptr, ptr ${b.slot}`);
          this.releaseValue(old, b.type);
        }
        B.line(`store ${this.llType(b.type)} ${v.name}, ptr ${b.slot}`);
        this.storeIntegerView(s.localId, v, s.value);
        if (b.kind === "global" && this.immortalGlobals.has(s.localId)) {
          // An Immutable module constant (contracts/check.ts proved it is
          // fresh, publishable and never written): its graph becomes
          // immortal, so reads skip reference counting and the collector
          // never visits it.
          const lines = this.publishWalkers.emitPublish(v.name, v.type, s.loc);
          for (const line of lines) B.line(line.trimStart());
          // Reads of this global skip retains from here on, which is only
          // sound once the graph really is immortal. Node.js never fails
          // here, so a refusal means the contract proof was wrong: stop
          // rather than keep running with a mortal graph read as immortal.
          if (lines.length > 0) {
            this.declare(`declare zeroext i1 @scr_exc_pending()`);
            this.declare(`declare void @scr_trap(ptr)`);
            const refused = B.tmp();
            B.line(`${refused} = call zeroext i1 @scr_exc_pending()`);
            const stop = B.newLabel("immutable.refused");
            const done = B.newLabel("immutable.published");
            B.condBr(refused, stop, done);
            B.startBlock(stop);
            B.line(
              `call void @scr_trap(ptr ${this.cstr("scriptc: internal error: an Immutable value could not be published\n")})`,
            );
            B.terminate("unreachable");
            B.startBlock(done);
          }
        }
        break;
      }
      case "exprStmt":
        // A statement-position splice never observes its removed elements.
        if (!emitDiscardedSplice(this, s.expr)) this.emitDiscarded(s.expr);
        break;
      case "arraySet": {
        // Evaluation order matches JS: array, index, then value. Ownership
        // of a refcounted value moves into the array (the runtime releases
        // the replaced element itself). A local receiver that the index and
        // value cannot rebind is read in place, as for field stores; the
        // released element cannot reach that binding.
        if (this.emitArraySelfConcat(s)) break;
        const arr = this.emitStableReceiver(s.arr, [s.index, s.value]);
        const idx = this.emitExpr(s.index);
        const v = this.emitExpr(s.value);
        if (s.arr.type.kind !== "array")
          throw new InternalCompilerError("llvm emitter bug: arraySet on non-array");
        const acc = elemAccess(s.arr.type.elem);
        this.emitPublishedArrayGuard(arr.name, s.arr.type, 0, idx.name);
        if (acc === "ref") this.moveTemp(v);
        emitDenseArraySet(this, arr.name, idx, s.index, acc, s.arr.type.elem, v.name);
        break;
      }
      case "arraySetLength": {
        // Pop's `length = 0` store on an empty array only matters when the
        // array can be frozen (published); its operand is a local.
        if (
          s.pop === true &&
          s.length.kind === "numLit" &&
          s.length.value === 0 &&
          this.publishedTypes?.containerGuarded(s.arr.type) !== true
        )
          break;
        const arr = emitBorrowedInput(this, s.arr);
        const length = this.emitExpr(s.length);
        if (s.arr.type.kind !== "array")
          throw new InternalCompilerError("llvm emitter bug: arraySetLength on non-array");
        this.emitPublishedArrayGuard(arr.name, s.arr.type, s.pop === true ? 2 : 3);
        this.declare(`declare void @scr_arr_set_len(ptr, double)`);
        // Assigning the current length (a reused work array reset to where
        // it already is) changes nothing: the runtime's validation accepts
        // exactly the value equal to the length (-0 included, NaN never),
        // and no element is released. Everything else keeps the call.
        const lenPtr = B.tmp(),
          len = B.tmp(),
          lenNumber = B.tmp(),
          same = B.tmp();
        const resize = B.newLabel("arr.len.set"),
          done = B.newLabel("arr.len.done");
        B.line(`${lenPtr} = getelementptr inbounds %ScrArr, ptr ${arr.name}, i32 0, i32 1`);
        this.markMemoryPointer(lenPtr, "array:header");
        B.line(
          `${len} = load ${this.sizeType}, ptr ${lenPtr}${this.fieldAliasAttachment(lenPtr)}${this.arrayLengthRange}`,
        );
        B.line(`${lenNumber} = ${sizeToDouble(this.sizeType)} ${this.sizeType} ${len} to double`);
        B.line(`${same} = fcmp oeq double ${length.name}, ${lenNumber}`);
        B.condBr(same, done, resize);
        B.startBlock(resize);
        B.line(`call void @scr_arr_set_len(ptr ${arr.name}, double ${length.name})`);
        this.emitPendingCheck();
        B.br(done);
        B.startBlock(done);
        break;
      }
      case "arraySetUndefined":
      case "arrayDelete": {
        const arr = emitBorrowedInput(this, s.arr);
        const idx = this.emitExpr(s.index);
        if (s.arr.type.kind !== "array")
          throw new InternalCompilerError(`llvm emitter bug: ${s.kind} on non-array`);
        this.emitPublishedArrayGuard(
          arr.name,
          s.arr.type,
          s.kind === "arrayDelete" ? 5 : 0,
          idx.name,
        );
        const fn = s.kind === "arraySetUndefined" ? "scr_arr_set_undefined" : "scr_arr_delete";
        this.declare(
          `declare ${s.kind === "arrayDelete" ? "zeroext i1" : "void"} @${fn}(ptr, double)`,
        );
        if (s.kind === "arrayDelete")
          B.line(`call zeroext i1 @${fn}(ptr ${arr.name}, double ${idx.name})`);
        else B.line(`call void @${fn}(ptr ${arr.name}, double ${idx.name})`);
        break;
      }
      case "bytesSet": {
        // Typed-array element write: same evaluation order as arraySet;
        // the value is a scalar (the kind-specific inline path coerces
        // JS-exactly), so no ownership moves. Invalid writes are ignored.
        // IrBytesElem is static, so never rediscover it through the
        // generic runtime switch in a hot loop.
        const arr = this.emitStableReceiver(s.arr, [s.index, s.value]);
        const idx = this.emitExpr(s.index);
        const v = this.emitExpr(s.value);
        if (s.arr.type.kind !== "bytes")
          throw new InternalCompilerError("llvm emitter bug: bytesSet on non-bytes");
        this.emitBytesSet(
          s.arr.type.elem,
          arr.name,
          idx,
          v,
          s.index,
          s.value,
          this.bytesBounds.has(s),
        );
        break;
      }
      case "fieldSet":
      case "recordSet": {
        // Evaluation order: obj, then value. New value moved in; the old
        // value is released AFTER the field is overwritten (unlink-then-
        // release — a release can trigger a cycle collection, which must
        // never see a heap edge whose count was already given up).
        // Classes and records share the struct layout, so one emission.
        const nullable =
          s.kind === "fieldSet" ? this.nullableFields.get(s.className, s.field) : null;
        if (nullable && s.kind === "fieldSet") {
          const obj = this.emitStableReceiver(s.obj, [s.value]);
          // (The guard precedes the value here: the nullable store
          // evaluates it itself.)
          this.emitStoreGuard(obj.name, s);
          this.emitNullableFieldStore(obj.name, s.className, s.field, nullable, s.value);
          break;
        }
        if (s.kind === "fieldSet" && this.int32Slots.isField(s.className, s.field)) {
          const obj = this.emitStableReceiver(s.obj, [s.value]);
          const v = this.emitExpr(s.value);
          this.emitStoreGuard(obj.name, s);
          const { ptr } = this.classFieldPtr(obj.name, s.className, s.field);
          this.storeInt32Field(ptr, v, s.value);
          break;
        }
        if (this.emitFieldSelfConcat(s)) break;
        const obj = this.emitStableReceiver(s.obj, [s.value]);
        const v = this.emitFieldValue(
          s.value,
          s.kind === "recordSet"
            ? this.recordFieldInline(s.shapeId, s.field)
            : this.inlineUnions.classField(s.className, s.field),
        );
        if (s.kind === "fieldSet") this.emitStoreGuard(obj.name, s);
        else if (this.publishedTypes?.recordGuarded(s.shapeId) === true)
          this.emitPublishedFieldGuard(obj.name, null, s.field);
        const { ptr, type, inline } =
          s.kind === "fieldSet"
            ? this.classFieldPtr(obj.name, s.className, s.field)
            : this.recordFieldPtr(obj.name, s.shapeId, s.field);
        this.replaceField(ptr, type, inline, v);
        if (
          s.kind === "fieldSet" &&
          s.field === "name" &&
          this.classMeta.get(s.className)?.root.def.name === "%Error"
        ) {
          const present = this.classFieldPtr(obj.name, s.className, "%namePresent").ptr;
          const enumerable = this.classFieldPtr(obj.name, s.className, "%nameEnumerable").ptr;
          const wasPresent = B.tmp(),
            wasEnumerable = B.tmp(),
            isPresent = B.tmp(),
            nextEnumerable = B.tmp();
          B.line(`${wasPresent} = load i8, ptr ${present}`);
          B.line(`${wasEnumerable} = load i8, ptr ${enumerable}`);
          B.line(`${isPresent} = icmp ne i8 ${wasPresent}, 0`);
          B.line(`${nextEnumerable} = select i1 ${isPresent}, i8 ${wasEnumerable}, i8 1`);
          B.line(`store i8 1, ptr ${present}`);
          B.line(`store i8 ${nextEnumerable}, ptr ${enumerable}`);
        }
        break;
      }
      case "recordKeyDelete": {
        // `delete obj[k]` on a pure index-signature shape: a Map delete on
        // the overflow (key and value released; absent keys no-op).
        const obj = this.emitExpr(s.obj);
        const key = this.emitExpr(s.key);
        if (this.publishedTypes?.recordGuarded(s.shapeId) === true) {
          // Node: "Cannot delete property 'k' of #<Object>" (key known at
          // run time only; the guard reports the frozen record generically).
          this.emitPublishedFieldGuard(obj.name, null, "[key]");
        }
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
        if (this.publishedTypes?.recordGuarded(s.shapeId) === true)
          this.emitPublishedFieldGuard(obj.name, null, "[key]");
        if (isRefCounted(v.type)) this.moveTemp(v);
        const shape = this.recordShape(s.shapeId);
        // Signature-free shapes dispatch over their (one-typed) declared
        // fields and TRAP on a miss (scr_record_key_miss — JS would add
        // the property, which a monomorphic struct cannot); overflow
        // shapes keep the map insert tail.
        const iv = shape.indexValue ?? shape.fields[0]?.type;
        if (!iv)
          throw new InternalCompilerError(
            `llvm emitter bug: keyed write on field-free non-overflow shape ${s.shapeId}`,
          );
        const vAcc = iv.kind === "f64" ? "f64" : iv.kind === "bool" ? "bool" : "ref";
        if (s.overflowOnly === true) {
          // A LITERAL key naming no declared field: a plain overflow
          // insert — no field chain.
          const ovf = this.recordOvfPtr(obj.name, s.shapeId);
          this.mapSet(ovf, "str", vAcc, key.name, v.name);
          break;
        }
        const join = B.newLabel("rks.j");
        if (iv.kind === "dyn" && shape.indexValue) {
          // A dyn-valued shape (the C recordKeySetHelper's dyn arm,
          // inline): declared keys VALIDATE the dyn value against the
          // field's type first (dynCheck — a mismatched write throws the
          // catchable TypeError and leaves the field untouched; JS would
          // store anything, the documented divergence); undeclared keys
          // insert the dyn value into the overflow map as-is.
          this.declare(`declare void @scr_dyn_release(ptr)`);
          for (const f of shape.fields) {
            const hit = B.tmp();
            B.line(
              `${hit} = call zeroext i1 ${this.literalEquals(f.name)}(ptr ${key.name}) ; ${llvmCommentText(f.name)}`,
            );
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
            B.line(
              `${nv} = call ${fty === "i1" ? "zeroext i1" : fty} @${helper}(ptr ${v.name}, ptr ${pathSlot})`,
            );
            B.line(`call void @scr_dyn_release(ptr ${v.name})`);
            // Mismatched write: TypeError pending, field untouched — the
            // statement-level check below unwinds.
            const pend = B.tmp();
            for (const line of this.pendingTestLines(pend)) B.line(line.trimStart());
            const lw = B.newLabel("rks.w");
            B.condBr(pend, join, lw);
            B.startBlock(lw);
            const { ptr, type, inline } = this.recordFieldPtr(obj.name, s.shapeId, f.name);
            if (inline) {
              // The slot copies the checked value's bits; nv is released below.
              this.storeField(ptr, type, nv, true);
              this.releaseValue(nv, type);
            } else if (isRefCounted(type)) {
              const old = B.tmp();
              B.line(`${old} = load ptr, ptr ${ptr}`);
              this.storeField(ptr, type, nv, false);
              this.releaseValue(old, type);
            } else {
              this.storeField(ptr, type, nv, false);
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
          const hit = B.tmp();
          B.line(
            `${hit} = call zeroext i1 ${this.literalEquals(f.name)}(ptr ${key.name}) ; ${llvmCommentText(f.name)}`,
          );
          const lh = B.newLabel("rks.h");
          const ln = B.newLabel("rks.n");
          B.condBr(hit, lh, ln);
          B.startBlock(lh);
          const { ptr, type, inline } = this.recordFieldPtr(obj.name, s.shapeId, f.name);
          if (inline) {
            // The write owns the moved-in value; the slot copies its bits.
            this.storeField(ptr, type, v.name, true);
            this.releaseValue(v.name, type);
          } else if (isRefCounted(type)) {
            const old = B.tmp();
            B.line(`${old} = load ptr, ptr ${ptr}`);
            this.storeField(ptr, type, v.name, false);
            this.releaseValue(old, type);
          } else {
            this.storeField(ptr, type, v.name, false);
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
          finallyDepth: this.finallyStack.length,
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
        const workerBudget = this.workerLoopBudget(s);
        const le = B.newLabel("loop.e");
        this.emitLoopCopies(s, true, le, (exit) => {
          const lc = B.newLabel("loop.c");
          const lb = B.newLabel("loop.b");
          const lp = workerBudget !== null ? B.newLabel("loop.p") : lc;
          B.br(lc);
          B.startBlock(lc);
          B.condBr(this.emitCondition(s.cond), lb, exit);
          B.startBlock(lb);
          this.jumpTargets.push({
            kind: "loop",
            brkLabel: exit,
            contLabel: lp,
            labels: s.labels,
            frameDepth: this.frames.length,
            scopeDepth: this.scopes.length,
            finallyDepth: this.finallyStack.length,
          });
          this.emitBlock(s.body);
          this.jumpTargets.pop();
          B.br(lp);
          if (lp !== lc) {
            B.startBlock(lp);
            this.emitWorkerLoopCheck(workerBudget);
            B.br(lc);
          }
        });
        B.startBlock(le);
        break;
      }
      case "doWhile": {
        const workerBudget = this.workerLoopBudget(s);
        // Body first (runs at least once); continue jumps to the CONDITION.
        const le = B.newLabel("loop.e");
        this.emitLoopCopies(s, true, le, (exit) => {
          const lb = B.newLabel("loop.b");
          const lc = B.newLabel("loop.c");
          B.br(lb);
          B.startBlock(lb);
          this.jumpTargets.push({
            kind: "loop",
            brkLabel: exit,
            contLabel: lc,
            labels: s.labels,
            frameDepth: this.frames.length,
            scopeDepth: this.scopes.length,
            finallyDepth: this.finallyStack.length,
          });
          this.emitBlock(s.body);
          this.jumpTargets.pop();
          B.br(lc);
          B.startBlock(lc);
          this.emitWorkerLoopCheck(workerBudget);
          B.condBr(this.emitCondition(s.cond), lb, exit);
        });
        B.startBlock(le);
        break;
      }
      case "for": {
        // The init's scope wraps the whole loop (break/continue must NOT
        // release it — scopeDepth captured after the push, C parity).
        const integerArrayLoop =
          this.debug === null
            ? matchIntegerArrayForLoop(s, this.currentLocals, this.integerArrayBindings)
            : null;
        const integerLoop =
          integerArrayLoop ??
          (this.debug === null ? matchIntegerBytesForLoop(s, this.numericLocals) : null);
        const countedLoop =
          !integerLoop && this.countedLoopsEnabled
            ? matchIntegerCountedForLoop(s, this.numericLocals, this.integerRanges)
            : null;
        const window =
          countedLoop && this.byteWindowsEnabled
            ? matchByteWindow(
                s,
                countedLoop,
                this.numericLocals,
                this.captureIds,
                this.integerRanges,
                this.byteWindowEntries.get(s) ?? new Set(),
              )
            : null;
        if (window) {
          const valid = emitByteWindowGuard(this, window);
          const fast = B.newLabel("bytes.window.fast"),
            slow = B.newLabel("bytes.window.slow"),
            done = B.newLabel("bytes.window.done");
          B.condBr(valid, fast, slow);
          const originalRanges = this.integerRanges,
            originalBounds = this.bytesBounds;
          this.byteWindowsEnabled = false;
          try {
            B.startBlock(slow);
            this.emitStmt(s);
            B.br(done);
            B.startBlock(fast);
            this.integerRanges = window.ranges;
            this.bytesBounds = new Set([...originalBounds, ...window.bounds]);
            this.emitStmt(s);
            B.br(done);
          } finally {
            this.integerRanges = originalRanges;
            this.bytesBounds = originalBounds;
            this.byteWindowsEnabled = true;
          }
          B.startBlock(done);
          break;
        }
        let countedJoin: string | null = null;
        if (countedLoop?.guarded) {
          let safe = "true";
          if (countedLoop.limitGuarded) {
            const bound = this.emitExpr(countedLoop.limit);
            safe = B.tmp();
            B.line(
              `${safe} = fcmp ${countedLoop.step > 0 ? "ole" : "oge"} double ${bound.name}, ${f64Lit(countedLoop.guardLimit)}`,
            );
          }
          if (countedLoop.startGuarded) {
            // An exact integer of at most 2^53 - 1 in magnitude, and not -0
            // (the bit patterns of the value and its round trip agree).
            // NaN and infinities fail the ordered range tests.
            const start = this.emitExpr(countedLoop.start);
            const low = B.tmp(),
              high = B.tmp(),
              raw = B.tmp(),
              wide = B.tmp(),
              back = B.tmp(),
              bits = B.tmp(),
              backBits = B.tmp(),
              exact = B.tmp(),
              inRange = B.tmp(),
              ok = B.tmp();
            B.line(`${low} = fcmp oge double ${start.name}, ${f64Lit(-Number.MAX_SAFE_INTEGER)}`);
            B.line(`${high} = fcmp ole double ${start.name}, ${f64Lit(Number.MAX_SAFE_INTEGER)}`);
            B.line(`${inRange} = and i1 ${low}, ${high}`);
            B.line(`${raw} = fptosi double ${start.name} to i64`);
            B.line(`${wide} = freeze i64 ${raw}`);
            B.line(`${back} = sitofp i64 ${wide} to double`);
            B.line(`${bits} = bitcast double ${start.name} to i64`);
            B.line(`${backBits} = bitcast double ${back} to i64`);
            B.line(`${exact} = icmp eq i64 ${bits}, ${backBits}`);
            B.line(`${ok} = and i1 ${inRange}, ${exact}`);
            if (safe === "true") safe = ok;
            else {
              const both = B.tmp();
              B.line(`${both} = and i1 ${safe}, ${ok}`);
              safe = both;
            }
          }
          const fast = B.newLabel("counted.fast");
          const slow = B.newLabel("counted.slow");
          countedJoin = B.newLabel("counted.done");
          B.condBr(safe, fast, slow);
          B.startBlock(slow);
          this.countedLoopsEnabled = false;
          this.emitStmt(s);
          this.countedLoopsEnabled = true;
          B.br(countedJoin);
          B.startBlock(fast);
        }
        this.scopes.push([]);
        let integerSlot: string | null = null;
        let countedLimit: string | null = null;
        if (integerLoop) {
          integerSlot = B.slot();
          B.entryAllocas.push(
            `${integerSlot} = alloca ${this.sizeType} ; integer induction ${this.currentLocals.get(integerLoop.localId)!.name}`,
          );
          let start = "0";
          if (integerArrayLoop && s.init?.kind === "varDecl" && s.init.init) {
            const value = this.emitExpr(s.init.init);
            start = B.tmp();
            // The start is 0 or an enclosing array index plus one (at most
            // 2^32 - 1): on 64-bit targets the signed conversion is exact
            // and avoids x86-64's unsigned 64-bit conversion sequence.
            const conversion = this.sizeType === "i64" ? "fptosi" : "fptoui";
            B.line(`${start} = ${conversion} double ${value.name} to ${this.sizeType}`);
            this.integerArrayBindings.add(integerLoop.localId);
          }
          B.line(`store ${this.sizeType} ${start}, ptr ${integerSlot}`);
          this.integerLoopBindings.set(integerLoop.localId, {
            slot: integerSlot,
            type: this.sizeType,
            range: { min: 0, max: integerArrayLoop ? 4294967294 : Number.MAX_SAFE_INTEGER - 1 },
          });
        } else if (countedLoop) {
          integerSlot = B.slot();
          B.entryAllocas.push(
            `${integerSlot} = alloca i64 ; integer induction ${this.currentLocals.get(countedLoop.localId)!.name}`,
          );
          const startNumber = this.emitExpr(countedLoop.start);
          const start = B.tmp();
          B.line(`${start} = fptosi double ${startNumber.name} to i64`);
          B.line(`store i64 ${start}, ptr ${integerSlot}`);
          this.integerLoopBindings.set(countedLoop.localId, {
            slot: integerSlot,
            type: "i64",
            signed: true,
            range: countedLoop.range,
          });
          countedLimit = emitCountedLoopLimit(this, countedLoop);
        } else if (s.init) {
          // A multi-declarator head shares the loop's scope. Emitting its
          // IR block as an ordinary block would release captured/ref locals
          // before the first condition.
          const initializers = s.init.kind === "block" ? s.init.body : [s.init];
          for (const initializer of initializers) this.emitStmt(initializer);
        }
        const le = B.newLabel("loop.e");
        // JS `for (let i ...)`: each iteration gets a FRESH binding holding
        // a copy of the previous one (closures made in iteration k keep
        // seeing iteration k's value) — only observable, and only emitted,
        // when a let variable is captured (boxed). Freshen before the first
        // condition and again in the continue-target block before updating.
        const initializers = s.init?.kind === "block" ? s.init.body : s.init ? [s.init] : [];
        const capturedLets = initializers.flatMap((init) => {
          const local = init.kind === "varDecl" ? this.currentLocals.get(init.localId) : undefined;
          return local?.boxed && local.mutable ? [local] : [];
        });
        const freshenBindings = (): void => {
          for (const local of capturedLets) {
            const slot = `%${mangleLocal(local.id)}`;
            const fresh = B.tmp();
            const old = B.tmp();
            B.line(
              `${fresh} = ${boxNewCall(this.shapeHost, local.type)} ; per-iteration ${local.name}`,
            );
            B.line(`${old} = load ptr, ptr ${slot}`);
            const val = this.boxGet(old, local.type);
            this.boxSet(fresh, local.type, val);
            this.declare(`declare void @scr_box_release(ptr)`);
            B.line(`call void @scr_box_release(ptr ${old})`);
            B.line(`store ptr ${fresh}, ptr ${slot}`);
          }
        };
        const workerBudget = this.workerLoopBudget(s);
        freshenBindings();
        this.emitLoopCopies(s, capturedLets.length === 0, le, (exit) => {
          const lc = B.newLabel("loop.c");
          const lb = B.newLabel("loop.b");
          const lu =
            s.update || capturedLets.length > 0 || workerBudget !== null
              ? B.newLabel("loop.u")
              : lc;
          B.br(lc);
          B.startBlock(lc);
          if (integerLoop && integerSlot) {
            const receiver = this.emitStableReceiver(integerLoop.limitReceiver, []);
            const lenPtr = B.tmp();
            const len = B.tmp();
            const index = B.tmp();
            const inBounds = B.tmp();
            B.line(
              `${lenPtr} = getelementptr inbounds %${integerArrayLoop ? "ScrArr" : "ScrBytes"}, ptr ${receiver.name}, i64 0, i32 1`,
            );
            if (integerArrayLoop) this.markMemoryPointer(lenPtr, "array:header");
            B.line(
              `${len} = load ${this.sizeType}, ptr ${lenPtr}${this.fieldAliasAttachment(lenPtr)}`,
            );
            B.line(`${index} = load ${this.sizeType}, ptr ${integerSlot}`);
            B.line(`${inBounds} = icmp ult ${this.sizeType} ${index}, ${len}`);
            B.condBr(inBounds, lb, exit);
          } else if (countedLoop && integerSlot && countedLimit) {
            const index = B.tmp();
            const inBounds = B.tmp();
            B.line(`${index} = load i64, ptr ${integerSlot}`);
            B.line(
              `${inBounds} = icmp ${countedLoop.step > 0 ? "slt" : "sgt"} i64 ${index}, ${countedLimit}`,
            );
            B.condBr(inBounds, lb, exit);
          } else if (s.cond) B.condBr(this.emitCondition(s.cond), lb, exit);
          else B.br(lb);
          B.startBlock(lb);
          this.jumpTargets.push({
            kind: "loop",
            brkLabel: exit,
            contLabel: lu,
            labels: s.labels,
            frameDepth: this.frames.length,
            scopeDepth: this.scopes.length,
            finallyDepth: this.finallyStack.length,
          });
          this.emitBlock(s.body);
          this.jumpTargets.pop();
          B.br(lu);
          if (lu !== lc) {
            B.startBlock(lu);
            this.emitWorkerLoopCheck(workerBudget);
            freshenBindings();
            if (integerLoop && integerSlot) {
              const old = B.tmp();
              const next = B.tmp();
              B.line(`${old} = load ${this.sizeType}, ptr ${integerSlot}`);
              B.line(`${next} = add nuw ${this.sizeType} ${old}, 1`);
              B.line(`store ${this.sizeType} ${next}, ptr ${integerSlot}`);
            } else if (countedLoop && integerSlot) {
              const old = B.tmp();
              const next = B.tmp();
              B.line(`${old} = load i64, ptr ${integerSlot}`);
              B.line(`${next} = add nsw i64 ${old}, ${countedLoop.step}`);
              B.line(`store i64 ${next}, ptr ${integerSlot}`);
            } else if (s.update) this.emitStmt(s.update);
            B.br(lc);
          }
        });
        B.startBlock(le);
        this.releaseScope(this.scopes.pop()!);
        if (integerLoop) this.integerLoopBindings.delete(integerLoop.localId);
        if (countedLoop) this.integerLoopBindings.delete(countedLoop.localId);
        if (integerArrayLoop) this.integerArrayBindings.delete(integerArrayLoop.localId);
        if (countedJoin) {
          B.br(countedJoin);
          B.startBlock(countedJoin);
        }
        break;
      }
      case "forOf": {
        // Ascending index loop; the length is re-read every iteration
        // (JS-exact — pushes inside the body extend the iteration). The
        // iterable temp lives in this statement's frame, so it is released
        // when the whole loop ends (and by `return`'s frame sweep).
        if (s.iterable.type.kind !== "array")
          throw new LlvmUnsupportedError(`forOf:${s.iterable.type.kind}`, s.loc);
        const elem = s.iterable.type.elem;
        const stored =
          s.iterable.kind === "varRef" ? this.storedSplits.get(s.iterable.localId) : undefined;
        const direct = this.streamingSplitsEnabled ? stringSplit(s.iterable) : null;
        const snapshot = stored
          ? loadSplitSnapshot(this, stored)
          : direct
            ? emitSplitSnapshot(this, direct)
            : null;
        const arr = snapshot ? null : this.emitExpr(s.iterable);
        const cursor = snapshot ? emitSplitCursor(this, snapshot) : null;
        const scratch = snapshot ? emitSplitScratch(this) : null;
        const deferred = snapshot && canDeferSplitPiece(s, this.currentLocals.get(s.localId));
        const spanLength = deferred ? B.slot() : null;
        if (spanLength) B.entryAllocas.push(`${spanLength} = alloca ${this.sizeType}`);
        const idxSlot = snapshot ? null : B.slot();
        if (idxSlot) {
          B.entryAllocas.push(`${idxSlot} = alloca double`);
          B.line(`store double ${f64Lit(0)}, ptr ${idxSlot}`);
        }
        const lc = B.newLabel("fof.c");
        const lb = B.newLabel("fof.b");
        const lu = B.newLabel("fof.u");
        const le = B.newLabel("fof.e");
        const workerBudget = this.workerLoopBudget(s);
        B.br(lc);
        B.startBlock(lc);
        const inBounds = B.tmp();
        let cur: string;
        if (snapshot && cursor && scratch) {
          cur = spanLength
            ? emitSplitSpanNext(this, snapshot, cursor, spanLength)
            : emitSplitNext(this, snapshot, cursor, scratch);
          B.line(`${inBounds} = icmp ne ptr ${cur}, null`);
        } else {
          const i = B.tmp(),
            lenPtr = B.tmp(),
            rawLen = B.tmp(),
            len = B.tmp();
          B.line(`${i} = load double, ptr ${idxSlot}`);
          // The inline form of scr_arr_len, like the `length` intrinsic.
          B.line(`${lenPtr} = getelementptr inbounds %ScrArr, ptr ${arr!.name}, i32 0, i32 1`);
          this.markMemoryPointer(lenPtr, "array:header");
          B.line(
            `${rawLen} = load ${this.sizeType}, ptr ${lenPtr}${this.fieldAliasAttachment(lenPtr)}${this.arrayLengthRange}`,
          );
          B.line(`${len} = ${sizeToDouble(this.sizeType)} ${this.sizeType} ${rawLen} to double`);
          B.line(`${inBounds} = fcmp olt double ${i}, ${len}`);
          cur = i;
        }
        B.condBr(inBounds, lb, le);
        B.startBlock(lb);
        this.jumpTargets.push({
          kind: "loop",
          brkLabel: le,
          contLabel: lu,
          labels: s.labels,
          frameDepth: this.frames.length,
          scopeDepth: this.scopes.length,
          finallyDepth: this.finallyStack.length,
        });
        // The loop variable is a fresh const per iteration: its scope opens
        // here, holds the (for ref elements: owned +1) current element, and
        // releases it at the end of each iteration.
        this.scopes.push([]);
        const localInfo = this.currentLocals.get(s.localId);
        const slot = `%${mangleLocal(s.localId)}`;
        const borrowedElement = !snapshot && this.loopArrayBorrows.has(s);
        if (!snapshot) {
          const acc = elemAccess(elem);
          const getter = borrowedElement ? "scr_arr_borrow_ref" : `scr_arr_get_${acc}`;
          cur = emitDenseArrayGet(
            this,
            arr!.name,
            { name: cur, type: { kind: "f64" } },
            undefined,
            acc,
            elem,
            getter,
            !borrowedElement,
          );
        }
        if (spanLength) {
          const length = B.tmp();
          B.line(`${length} = load ${this.sizeType}, ptr ${spanLength}`);
          this.splitSpans.set(s.localId, { bytes: cur, length, scratch: scratch! });
          cur = "null";
        }
        if (localInfo?.boxed) {
          // Captured loop variable: a fresh box per iteration, matching the
          // fresh const binding. The box takes ownership of a ref element's
          // +1 and is released with the iteration's scope.
          const box = B.tmp();
          B.line(`${box} = ${boxNewCall(this.shapeHost, elem)} ; per-iteration ${localInfo.name}`);
          this.boxSet(box, elem, cur);
          B.line(`store ptr ${box}, ptr ${slot}`);
          this.scopes[this.scopes.length - 1]!.push({ slot, type: elem, boxed: true });
        } else {
          B.line(`store ${this.llType(elem)} ${cur}, ptr ${slot}`);
          if (isRefCounted(elem) && !borrowedElement)
            this.scopes[this.scopes.length - 1]!.push({ slot, type: elem });
        }
        this.emitStmts(s.body);
        if (spanLength) this.splitSpans.delete(s.localId);
        const endedWithJump = endsWithJump(s.body);
        const scope = this.scopes.pop()!;
        if (!endedWithJump) this.releaseScope(scope);
        this.jumpTargets.pop();
        B.br(lu);
        B.startBlock(lu);
        this.emitWorkerLoopCheck(workerBudget);
        if (idxSlot) {
          const i2 = B.tmp(),
            i3 = B.tmp();
          B.line(`${i2} = load double, ptr ${idxSlot}`);
          B.line(`${i3} = fadd double ${i2}, ${f64Lit(1)}`);
          B.line(`store double ${i3}, ptr ${idxSlot}`);
        }
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
        this.emitFinallysForJump(target.finallyDepth, target.frameDepth, target.scopeDepth);
        if (!B.isTerminated()) B.terminate(`br label %${target.brkLabel}`);
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
        if (!target || target.contLabel === null)
          throw new InternalCompilerError("llvm emitter bug: continue target not found");
        this.emitFinallysForJump(target.finallyDepth, target.frameDepth, target.scopeDepth);
        if (!B.isTerminated()) B.terminate(`br label %${target.contLabel}`);
        break;
      }
      case "return": {
        // The value computes FIRST (an SSA temp — finally mutations of
        // returned locals cannot change it, Node-exact), then every
        // crossed finally runs innermost-first with the frames/scopes/
        // tryStack it sees truncated to its region (its releases already
        // ran; a throw inside a copy propagates OUT of the completing
        // try, past its own catch), then the function-level releases and
        // the actual ret. The parked value owns a synthetic slot-backed
        // scope entry during each copy so a throwing finally releases it.
        const adopted =
          this.finallyStack.length > 0 || this.tryStack.length > 0
            ? adoptingAwaitOf(s.value)
            : null;
        if (adopted !== null) {
          this.emitAdoptingReturn(s, adopted);
          break;
        }
        let v: LlValue | null = null;
        const moved =
          this.finallyStack.length === 0 && !this.currentUnionResult
            ? this.movableReturn(s.value)
            : null;
        if (s.value !== null && this.currentUnionResult) {
          // The tag and payload bits leave in registers; a heap box the
          // value needed is released with its frame below.
          const box = this.emitUnionProjection(s.value);
          v = { name: this.scalarUnionPair(box.name, s.value.type), type: s.value.type };
        } else if (moved !== null) {
          // Returning an owned local hands its reference to the caller: no
          // retain now and no release of the local below.
          const t = B.tmp();
          B.line(`${t} = load ptr, ptr ${moved.entry.slot}`);
          v = { name: t, type: s.value!.type };
          moved.scope.splice(moved.scope.indexOf(moved.entry), 1);
          this.releaseForJump(0, 0);
          moved.scope.splice(moved.index, 0, moved.entry);
        } else if (s.value !== null && this.currentBorrowedReturn) {
          // A borrowed-return body hands back its walk without a reference
          // (it has no try statements, so no finally can intervene). An
          // optional element read lends the element its array keeps alive.
          const read = this.optionalArrayReads.get(s.value);
          if (read) {
            const slot = B.slot();
            B.entryAllocas.push(`${slot} = alloca ptr`);
            emitLocalArrayRead(this, { ...read, borrow: true }, slot);
            const t = B.tmp();
            B.line(`${t} = load ptr, ptr ${slot}`);
            v = { name: t, type: s.value.type };
          } else v = this.emitReadReceiver(s.value);
        } else if (s.value !== null) {
          v = this.emitExpr(s.value);
          this.moveTemp(v);
        }
        // An async generator's `return v` awaits v before any crossed
        // finally runs. Past finally regions that turn is taken here and
        // the request settles at completion; otherwise the completion's
        // own turn is the await (nothing runs in between).
        const genSettles =
          this.currentAsyncGenerator && (s.awaited === true || this.finallyStack.length > 0);
        if (this.currentAsyncGenerator && s.awaited !== true && this.finallyStack.length > 0) {
          if (this.wasi) this.emitWasiSuspend(null);
          else {
            this.declare(`declare void @scr_await_hop()`);
            B.line(`call void @scr_await_hop()`);
          }
        }
        if (this.finallyStack.length > 0) {
          let pretSlot: string | null = null;
          if (v !== null && isRefCounted(v.type) && !this.currentUnionResult) {
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
        } else if (moved === null) {
          this.releaseForJump(0, 0);
        }
        if (!B.isTerminated()) {
          if (genSettles) this.emitAsyncGenSettled();
          if (this.currentCoro !== null) {
            this.emitWasiFulfill(v);
            B.terminate(`br label %${this.currentCoro.finalLabel}`);
          } else if (v === null) B.terminate("ret void");
          else if (this.currentInt32Result)
            B.terminate(`ret i32 ${this.int32Argument(v, s.value!)}`);
          else if (this.currentUnionResult) B.terminate(`ret ${SCALAR_UNION_RESULT} ${v.name}`);
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
        const c = this.emitExpr({ kind: "varRef", localId: s.localId, type: CAUGHT, loc: s.loc });
        this.declare(`declare void @scr_rethrow(ptr)`);
        B.line(`call void @scr_rethrow(ptr ${c.name})`);
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
        // keep throwing LlvmUnsupportedError for any future IR statement kind.
        const rest: never = s;
        const k = (rest as IrStmt).kind;
        throw new LlvmUnsupportedError(`stmt:${k}`, (rest as IrStmt).loc);
      }
    }
    const frame = this.frames.pop()!;
    // return/throw already released their frames on the jump path; the
    // fall-through releases after them would be dead double-release code.
    if (
      s.kind !== "return" &&
      s.kind !== "throw" &&
      s.kind !== "rethrow" &&
      s.kind !== "runtimeFence"
    ) {
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
   * Abrupt completions inside tryBody/catchBody ride the finallyStack:
   * returns inline copies at the return site, while break/continue use the
   * shared region walk before branching to their resolved target. */
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
          if (this.currentLocals.get(s.catchLocalId!)?.boxed) {
            const box = B.tmp();
            B.line(`${box} = ${boxNewCall(this.shapeHost, CAUGHT)} ; captured exception`);
            this.boxSet(box, CAUGHT, c);
            B.line(`store ptr ${box}, ptr ${slot}`);
            scope.push({ slot, type: CAUGHT, boxed: true });
          } else {
            B.line(`store ptr ${c}, ptr ${slot}`);
            scope.push({ slot, type: CAUGHT });
          }
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
        const suppressHandler = s.suppressFinallyErrors
          ? {
              label: B.newLabel("try.fs"),
              used: false,
              frameDepth: this.frames.length,
              scopeDepth: this.scopes.length,
            }
          : null;
        if (suppressHandler) this.tryStack.push(suppressHandler);
        this.emitBlock(s.finallyBody!);
        if (suppressHandler) this.tryStack.pop();
        this.scopes.pop(); // normal completion keeps the stash for the re-raise
        B.line(`call void @scr_rethrow(ptr ${stash})`);
        B.line(`call void @scr_caught_release(ptr ${stash})`);
        this.emitUnwind();
        if (suppressHandler?.used) {
          B.startBlock(suppressHandler.label);
          this.declare(`declare void @scr_exc_suppress(ptr)`);
          B.line(`call void @scr_exc_suppress(ptr ${stash}) ; consumes stash`);
          this.emitUnwind();
        }
      }
      B.startBlock(endLabel);
    } else {
      B.startBlock(endLabel);
    }
  }

  /** JS-exact switch: lazily evaluated, arbitrary-expression case tests in
   * source order, bodies falling through in source order until a break —
   * Literal-only tests can use native dispatch; other tests keep a chain
   * of conditional branches. All case bodies
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
    const defaultIdx = s.cases.findIndex((c) => c.test === null);
    const fallback = defaultIdx >= 0 ? caseLabels[defaultIdx]! : end;
    if (!emitLiteralSwitch(this, disc, s.disc, s.cases, caseLabels, fallback)) {
      s.cases.forEach((c, i) => {
        if (c.test === null) return;
        // Lazy source-order test evaluation (a test after the match never
        // runs). Each test's temps release right after its comparison.
        this.frames.push([]);
        const t = this.emitExpr(c.test);
        const hit = B.tmp();
        if (c.test.kind === "strLit") {
          B.line(`${hit} = call zeroext i1 ${this.literalEquals(c.test.value)}(ptr ${disc.name})`);
        } else if (c.test.type.kind === "string") {
          this.declare(`declare zeroext i1 @scr_str_eq(ptr, ptr)`);
          B.line(`${hit} = call zeroext i1 @sc_str_eq(ptr ${disc.name}, ptr ${t.name})`);
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
      B.br(fallback);
    }

    this.jumpTargets.push({
      kind: "switch",
      brkLabel: end,
      contLabel: null,
      labels: s.labels,
      frameDepth: this.frames.length,
      scopeDepth: this.scopes.length,
      finallyDepth: this.finallyStack.length,
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
   * later blocks across the back edge). */
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
   * branch. The shared core of ternary/logical. */
  emitBranchInto(slot: string, expr: IrExpr, integerSlot?: string): boolean {
    this.frames.push([]);
    const v = this.emitExpr(expr);
    this.moveTemp(v);
    this.B.line(`store ${this.llType(expr.type)} ${v.name}, ptr ${slot}`);
    if (integerSlot !== undefined && v.uint32 !== undefined)
      this.B.line(`store i32 ${v.uint32}, ptr ${integerSlot}`);
    this.releaseFrame(this.frames.pop()!);
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

  private emitDiscarded(e: IrExpr): void {
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

  /**
   * Lower canonical `target = target + suffix` after evaluating the old
   * left side and suffix in JavaScript order.  The snapshot stays owned by
   * the statement frame while the destination relinquishes its CURRENT
   * value, making the snapshot unique unless a real observable alias exists.
   */
  emitStringSelfConcatAssign(
    localId: string,
    left: IrExpr,
    suffix: IrExpr,
    retainForYield: boolean,
  ): LlValue {
    const moved = this.emitMovedSelfConcat(localId, left, suffix, retainForYield);
    if (moved) return moved;
    const snapshot = this.emitExpr(left);
    // A suffix of several parts, or a number, appends each operand to the
    // snapshot directly (in place once the binding lets go of it) instead
    // of first building the suffix as a separate string.
    const parts = stringParts(suffix);
    const mixed = parts.length > 1 || numberPart(parts[0]!) !== null;
    const charCode = mixed ? null : this.emitSingleCharCode(suffix);
    const inputs = mixed ? emitConcatInputs(this, parts) : [];
    // The concat only reads the suffix; relinquishing the binding below
    // runs no code that could rebind a borrowed local.
    const right = mixed || charCode !== null ? null : emitStringInputs(this, [suffix])[0]!;
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
    let raw: string;
    if (charCode !== null) {
      // The snapshot moves into the consuming character append.
      this.moveTemp(snapshot);
      this.declare(`declare ptr @scr_str_concat_move_char_code(ptr, double)`);
      raw = B.tmp();
      B.line(
        `${raw} = call ptr @scr_str_concat_move_char_code(ptr ${snapshot.name}, double ${charCode.name})`,
      );
    } else if (right === null) {
      raw = emitMixedConcat(this, snapshot.name, inputs);
    } else {
      this.declare(`declare ptr @scr_str_concat(ptr, ptr)`);
      raw = B.tmp();
      B.line(`${raw} = call ptr @scr_str_concat(ptr ${snapshot.name}, ptr ${right.name})`);
    }
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

  /** The code of a one-argument `String.fromCharCode(c)` suffix, emitted, so
   * `s += String.fromCharCode(c)` appends the character without building
   * the one-character string; null for any other suffix. */
  private emitSingleCharCode(suffix: IrExpr): LlValue | null {
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
  private emitFieldSelfConcat(s: Extract<IrStmt, { kind: "fieldSet" | "recordSet" }>): boolean {
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
      this.releaseValue(old, fieldType);
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
  private emitArraySelfConcat(s: Extract<IrStmt, { kind: "arraySet" }>): boolean {
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
  private emitMovedSelfConcat(
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
    return emitIntrinsicExpr(this, e);
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
  private regions: LifetimeRegions | null = null;

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

  private publishWalkersCache: PublishWalkers | null = null;

  /** Per-type publication walkers, created on the first publish. */
  private get publishWalkers(): PublishWalkers {
    if (this.publishWalkersCache !== null) return this.publishWalkersCache;
    const byPre = [...this.classMeta.values()].sort((a, b) => a.pre - b.pre);
    this.publishWalkersCache = new PublishWalkers({
      declare: (decl) => this.declare(decl),
      cstr: (text) => this.cstr(text),
      sizeType: this.sizeType,
      rcAudit: this.shapeHost.objectAudit !== false,
      tracedShapes: this.tracedShapes,
      unionsById: this.unionsById,
      recordsById: this.recordsById,
      inlineUnions: this.inlineUnions,
      nullableArm: (t) => this.nullableUnions.of(t)?.arm ?? null,
      classInfo: (className) => {
        const meta = this.classMetaOf(className);
        return {
          def: meta.def,
          hierarchy: meta.hierarchy,
          pre: meta.pre,
          post: meta.post,
          runtimeRooted: meta.root.def.runtime === true,
          // Inline scalar-union fields are plain bits: nothing to push.
          fields: meta.def.fields.flatMap((f) =>
            this.inlineUnions.classField(className, f.name)
              ? []
              : [
                  {
                    name: f.name,
                    index: classFieldIndex(meta, f.name).index,
                    type: this.nullableFields.storageType(className, f.name, f.type),
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
    this.moveTemp(value);
    return this.own({ name: value.name, type: e.type });
  }

  /** Branches on "`obj` is published" (rc == SIZE_MAX); leaves the builder
   * in the cold block and answers the continuation label. */
  private emitPublishedTest(obj: string): string {
    const B = this.B;
    const rc = B.tmp(),
      frozen = B.tmp(),
      expected = B.tmp();
    B.line(`${rc} = load ${this.sizeType}, ptr ${obj}`);
    B.line(`${frozen} = icmp eq ${this.sizeType} ${rc}, -1`);
    this.declare(`declare i1 @llvm.expect.i1(i1, i1)`);
    B.line(`${expected} = call i1 @llvm.expect.i1(i1 ${frozen}, i1 false)`);
    const cold = B.newLabel("pub.frozen"),
      ok = B.newLabel("pub.ok");
    B.condBr(expected, cold, ok);
    B.startBlock(cold);
    return ok;
  }

  private publishedNamesSym: string | null = null;

  /** The class-name table the hierarchy field guards index by preorder. */
  private publishedClassNamesDefs(): string[] {
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
  private emitStoreGuard(obj: string, s: Extract<IrStmt, { kind: "fieldSet" }>): void {
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
    const ok = this.emitPublishedTest(obj);
    let owner: string;
    const meta = className === null ? undefined : this.classMeta.get(className);
    if (meta === undefined) owner = this.cstr("Object");
    else if (!meta.hierarchy) owner = this.cstr(meta.def.jsName ?? meta.def.name);
    else {
      // The DYNAMIC class names the object, as in Node.
      this.publishedNamesSym ??= "@sc_pub_class_names";
      const vtp = B.tmp(),
        vt = B.tmp(),
        pre = B.tmp(),
        slot = B.tmp(),
        name = B.tmp();
      B.line(`${vtp} = getelementptr inbounds ptr, ptr ${obj}, i64 1`);
      B.line(`${vt} = load ptr, ptr ${vtp}`);
      B.line(`${pre} = load ${this.sizeType}, ptr ${vt}`);
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
  ): void {
    if (this.publishedTypes?.containerGuarded(arrType) !== true) return;
    const B = this.B;
    const ok = this.emitPublishedTest(arr);
    this.declare(`declare zeroext i1 @scr_throw_published_array(i32, ptr, double, double)`);
    const threw = B.tmp();
    B.line(
      `${threw} = call zeroext i1 @scr_throw_published_array(i32 ${op}, ptr ${arr}, double ${index}, double ${count})`,
    );
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

  /** Read a receiver whose value is consumed immediately by a field or tag
   * load. No user code may run between this read and its consumer. Locals
   * and their projections already have an owner; other expressions keep
   * their ordinary statement-frame ownership. The caller must retain any
   * reference result before evaluating another expression. */
  emitReadReceiver(e: IrExpr): LlValue {
    if (!isRefCounted(e.type)) return this.emitExpr(e);
    if (e.kind === "strLit") return { name: this.internLiteral(e.value), type: e.type };
    const guarded = guardedValue(e);
    if (guarded !== null) {
      // Throwing guards run in place, exactly as the sequence emits them.
      for (const s of (e as IrExpr & { kind: "seqExpr" }).stmts) this.emitStmt(s);
      return this.emitReadReceiver(guarded);
    }
    if (e.kind === "varRef") {
      this.materializeSplitLocal(e.localId);
      const binding = this.binding(e.localId);
      if (binding.kind === "boxed") {
        // A projection consumes this pointer before any user code runs.
        // Keep TDZ checks and caught-value conversion on the owned path.
        if (!this.canBorrowReceiver(e)) return this.emitExpr(e);
        const box = this.loadBox(binding.slot);
        const payload = this.B.tmp();
        const value = this.B.tmp();
        this.B.line(`${payload} = getelementptr inbounds %ScrBox, ptr ${box}, i32 0, i32 5`);
        this.B.line(`${value} = load ptr, ptr ${payload}`);
        return { name: value, type: e.type };
      }
      if (binding.kind === "global") this.checkGlobalTdz(e.localId);
      const value = this.B.tmp();
      this.B.line(`${value} = load ptr, ptr ${binding.slot}`);
      return { name: value, type: e.type };
    }
    if (e.kind === "dynCheck" && e.exact) return this.emitExactCapsuleObject(e.value, e.type);
    if (e.kind === "chainRecv") {
      // The chain's bind slot holds its receiver unchanged until the body
      // finishes, owned by the slot itself or by the chain's receiver.
      const bound = this.chainSlots.get(e.id);
      if (!bound)
        throw new InternalCompilerError(`llvm emitter bug: chainRecv "${e.id}" outside its chain`);
      const value = this.B.tmp();
      this.B.line(`${value} = load ${this.llType(bound.type)}, ptr ${bound.name}`);
      return { name: value, type: e.type };
    }
    if (e.kind === "arrayGet" && this.canBorrowReceiver(e)) {
      // The array keeps the element alive until the consumer; a missing
      // element still traps exactly like the owned read.
      const slot = this.B.slot();
      this.B.entryAllocas.push(`${slot} = alloca ptr`);
      emitBorrowedArrayRead(this, e, slot);
      const value = this.B.tmp();
      this.B.line(`${value} = load ptr, ptr ${slot}`);
      return { name: value, type: e.type };
    }
    const wrap = this.borrowableNullableWrap(e);
    if (wrap === "unit" && e.kind === "unionWrap")
      return { name: this.unitInstanceRef(e.unionId, e.tag), type: e.type };
    if (wrap === "ref" && e.kind === "unionWrap")
      return { name: this.emitReadReceiver(e.value).name, type: e.type };
    const read = matchMapRead(e, this.boxedUnionsById);
    if (read) {
      const result = emitStackMapRead(this, read);
      if (result.owner) this.ownSlot(result.owner.slot, result.owner.type);
      return result.value;
    }
    // A borrowed-return helper (such as an optional element read) lends its
    // result like any borrowed-return call.
    if (e.kind === "call" && this.borrowedReturns.has(e.callee) && this.canBorrowReceiver(e))
      return emitBorrowedResultCall(this, e);
    const arrayRead = this.optionalArrayReads.get(e);
    if (arrayRead) return emitProjectedArrayRead(this, arrayRead);
    const narrow = this.checkedNarrows.get(e);
    const narrowed = narrow ? emitCheckedNarrowReceiver(this, narrow) : null;
    if (narrowed) return narrowed;
    if (canStackUnion(e, this.boxedUnionsById)) return emitStackUnion(this, e).value;
    if (e.kind === "unionNarrow") {
      const union = this.emitUnionProjection(e.value);
      return { name: this.unionPeek(union.name, e.unionId), type: e.type };
    }
    if ((e.kind === "downcast" || e.kind === "upcast") && e.value.type.kind === "object") {
      // Prefix layouts: a class cast reads the operand's own pointer.
      return { name: this.emitReadReceiver(e.value).name, type: e.type };
    }
    // A nullable-pointer field has no box to borrow. Projections use
    // emitUnionProjection; other borrowers get an owned heap box.
    if (this.nullableFieldGet(e)) return this.emitExpr(e);
    if (e.kind === "recordGet" || e.kind === "fieldGet") {
      const receiver = this.emitReadReceiver(e.obj);
      if (e.kind === "recordGet") {
        // An inline union field answers a private stack box.
        const { ptr, type, inline } = this.recordFieldPtr(receiver.name, e.shapeId, e.field);
        return { name: this.loadRecordField(ptr, type, inline), type: e.type };
      }
      const { ptr, type, inline } = this.classFieldPtr(receiver.name, e.className, e.field);
      if (this.int32Slots.isField(e.className, e.field)) return this.loadInt32Field(ptr, e.type);
      return { name: this.loadField(ptr, type, inline), type: e.type };
    }
    if (e.kind === "ternary" && this.canBorrowReceiver(e.then) && this.canBorrowReceiver(e.else_)) {
      // Checked projections lower to a ternary with an always-throwing
      // arm. Keep that check at the use, but borrow the successful arm.
      const B = this.B;
      const cond = this.emitExpr(e.cond);
      const slot = B.slot();
      B.entryAllocas.push(`${slot} = alloca ptr`);
      const yes = B.newLabel("read.then"),
        no = B.newLabel("read.else"),
        join = B.newLabel("read.join");
      B.condBr(cond.name, yes, no);
      for (const [label, value] of [
        [yes, e.then],
        [no, e.else_],
      ] as const) {
        B.startBlock(label);
        this.frames.push([]);
        const result = this.emitReadReceiver(value);
        B.line(`store ptr ${result.name}, ptr ${slot}`);
        this.releaseFrame(this.frames.pop()!);
        B.br(join);
      }
      B.startBlock(join);
      const value = B.tmp();
      B.line(`${value} = load ptr, ptr ${slot}`);
      return { name: value, type: e.type };
    }
    // Scalar optional values and register results answer a private stack
    // box. A ternary of borrowable arms above keeps lending its arm.
    if (
      (e.kind === "optChain" ||
        e.kind === "nullish" ||
        e.kind === "ternary" ||
        e.kind === "arrIntrinsic") &&
      isScalarOptionalSource(e, this.unionSources)
    )
      return emitScalarOptional(this, e);
    if (e.kind === "call" && this.scalarResultCall(e)) return emitCallExpr(this, e, false, true);
    if (e.kind === "call" && this.canBorrowReceiver(e)) return emitBorrowedResultCall(this, e);
    return this.emitExpr(e);
  }

  /** The frame slot a reassigned stack-object local keeps for its value. */
  private stackObjectSlot(localId: string, type: IrType): string {
    let slot = this.stackObjectSlots.get(localId);
    if (slot === undefined) {
      slot = this.B.slot();
      this.B.entryAllocas.push(`${slot} = alloca ${stackObjectStruct(type)}, align 8`);
      this.stackObjectSlots.set(localId, slot);
    }
    return slot;
  }

  /** A private stack union source with an independently owned payload. */
  canStackReceiver(e: IrExpr): boolean {
    return this.isStackUnionSource(e);
  }

  /** True for union sources that emitReadReceiver can produce as a private
   * stack box with an independently owned payload (no heap union). */
  isStackUnionSource(e: IrExpr): boolean {
    if (e.type.kind !== "union") return false;
    return (
      canStackUnion(e, this.boxedUnionsById) ||
      matchMapRead(e, this.boxedUnionsById) !== null ||
      this.optionalArrayReads.get(e) !== null ||
      isScalarOptionalSource(e, this.unionSources) ||
      this.scalarResultCall(e) ||
      this.inlineFieldGet(e)
    );
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
    const B = this.B;
    const receiver = this.emitReadReceiver(e.obj);
    const { ptr } = this.classFieldPtr(receiver.name, e.className, e.field);
    const p = B.tmp();
    B.line(`${p} = load ptr, ptr ${ptr}${this.fieldAliasAttachment(ptr)}`);
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
    const { ptr } = this.classFieldPtr(receiver.name, e.className, e.field);
    const p = this.B.tmp();
    this.B.line(`${p} = load ptr, ptr ${ptr}${this.fieldAliasAttachment(ptr)}`);
    const owner = this.own({ name: this.retainValue(p, nullable.arm), type: nullable.arm });
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
    const owned = this.retainValue(p, nullable.arm);
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
    return this.retainValue(sel, nullable.arm);
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
    const B = this.B;
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
        this.moveTemp(inner);
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
    const { ptr } = this.classFieldPtr(obj, className, field);
    const old = B.tmp();
    B.line(`${old} = load ptr, ptr ${ptr}`);
    B.line(`store ptr ${next}, ptr ${ptr}${this.fieldAliasAttachment(ptr)}`);
    this.releaseValue(old, nullable.arm);
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
    switch (e.kind) {
      case "chainRecv":
        return this.chainSlots.has(e.id);
      case "varRef": {
        const binding = this.binding(e.localId);
        return (
          binding.kind !== "boxed" ||
          (!binding.local!.tdz &&
            binding.type.kind === e.type.kind &&
            e.type.kind !== "caught" &&
            isRefCounted(e.type))
        );
      }
      case "unionNarrow":
      // Class casts reinterpret the same pointer (prefix layouts).
      case "downcast":
      case "upcast":
        return this.canBorrowReceiver(e.value);
      // An inline union field has no box to lend: projections read it
      // through emitReadReceiver's private stack box.
      case "fieldGet":
      case "recordGet":
        return !this.inlineFieldGet(e) && this.canBorrowReceiver(e.obj);
      case "ternary":
        return this.canBorrowReceiver(e.then) && this.canBorrowReceiver(e.else_);
      case "seqExpr": {
        const guarded = guardedValue(e);
        return guarded !== null && this.canBorrowReceiver(guarded);
      }
      // The runtime always sets a pending exception; its unreachable
      // typed dummy is null and owns no receiver.
      case "libCall":
        return e.fn === "error.nodeThrow";
      case "unionWrap": {
        const wrap = this.borrowableNullableWrap(e);
        return wrap === "unit" || (wrap === "ref" && this.canBorrowReceiver(e.value));
      }
      // A borrowed-return result stays reachable from its borrowed
      // arguments until the consumer runs. Each argument is lent without a
      // snapshot, so neither the callee nor a later argument may replace
      // what it was read from: a callee that preserves every edge cannot,
      // and any other one must leave the argument's locations unwritten.
      case "call": {
        if (!this.borrowedReturns.has(e.callee)) return false;
        if (!e.args.every((arg) => this.referenceEffects.preserves(arg))) return false;
        const preserving = this.referenceEffects.functions.has(e.callee);
        if (preserving)
          return e.args.every((arg) => !isRefCounted(arg.type) || this.canBorrowReceiver(arg));
        if (this.referenceWrites === null) return false;
        const lent = borrowableInputs(this, e.args, false, this.referenceWrites.summary(e.callee));
        return e.args.every((arg, i) => !isRefCounted(arg.type) || lent[i] === true);
      }
      // A required element read: the (borrowed) array owns the element
      // while an edge-preserving index computes.
      case "arrayGet":
        return (
          e.arr.type.kind === "array" &&
          isRefCounted(e.arr.type.elem) &&
          this.canBorrowReceiver(e.arr) &&
          this.referenceEffects.preserves(e.index)
        );
      default:
        return false;
    }
  }

  /** A reference held as one plain pointer that emitReadReceiver can read
   * without owning: class instances, records, arrays, strings and
   * nullable-pointer unions. Tagged union boxes, closures and dynamic
   * values keep ordinary ownership. */
  plainReference(type: IrType): boolean {
    switch (type.kind) {
      case "object":
      case "record":
      case "array":
      case "string":
        return true;
      case "union":
        return this.nullableUnions.has(type.unionId);
      default:
        return false;
    }
  }

  /** Functions returning a walk of their borrowed parameters return it
   * without a reference (+0) from their borrowing body; direct callers
   * either consume it as a receiver/walk or retain it at once, and the owned
   * adapter retains before releasing its parameters. Candidates preserve
   * every heap edge (so the result stays reachable from the arguments),
   * borrow every reference parameter and return plain pointers. The set
   * grows to a fixpoint because a call to a borrowed-return function with
   * walk arguments is itself a walk; walk facts are then recomputed with
   * the final set, admitting only parameters whose convention borrows. */
  private analyzeBorrowedReturns(): void {
    const pointer = (type: IrType): boolean => this.plainReference(type);
    const borrowedIds = (fn: IrFunction): Set<string> => {
      const indexes = this.callLifetimes.borrowed.get(fn.name);
      return new Set(fn.params.filter((_, i) => indexes?.has(i)).map((p) => p.localId));
    };
    const hostFor = (fn: IrFunction): WalkBorrowHost => {
      const allowed = borrowedIds(fn);
      const host = {
        pointerLocal: (local: IrLocal) => pointer(local.type),
        borrowsWithoutOwning: (e: IrExpr) => this.borrowsWithoutOwning(e),
        borrowedReturn: (callee: string) => this.borrowedReturns.has(callee),
        parameterAllowed: (id: string) => allowed.has(id),
      };
      return this.referenceEffects.functions.has(fn.name) ? host : this.unwrittenWalkHost(fn, host);
    };
    // With ReferenceWrites, a body that writes none of its walks' locations
    // qualifies like one that preserves every edge.
    const preserving = [...this.fnByName.values()].filter(
      (fn) => this.referenceEffects.functions.has(fn.name) || this.referenceWrites !== null,
    );
    const candidates = preserving.filter((fn) => {
      if (!pointer(fn.returnType) || fn.async || fn.generator || fn.captures) return false;
      // A borrowing vtable slot dispatches to the borrowing body (or its
      // virtual adapter) directly, and virtual callers own the result.
      if (this.implSlotBorrowed(fn.name).size > 0) return false;
      const indexes = this.callLifetimes.borrowed.get(fn.name);
      return (
        indexes !== undefined &&
        indexes.size > 0 &&
        fn.params.every((p, i) => !isRefCounted(p.type) || indexes.has(i))
      );
    });
    for (let changed = true; changed;) {
      changed = false;
      for (const fn of candidates) {
        if (this.borrowedReturns.has(fn.name)) continue;
        if (!analyzeWalks(fn, hostFor(fn)).returnsWalk) continue;
        this.borrowedReturns.add(fn.name);
        // Nested borrowed returns extend the locations a caller depends on.
        this.borrowedReturnKeyCache.clear();
        changed = true;
      }
    }
    if (this.borrowedReturns.size === 0) return;
    for (const fn of preserving) {
      const walks = analyzeWalks(fn, hostFor(fn)).locals;
      if (walks.size > 0) this.walkBorrowsByFunction.set(fn.name, walks);
    }
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
    return e.tag === nullable.refTag && isRefCounted(e.value.type) ? "ref" : null;
  }

  materializeSplitLocal(localId: string): void {
    const span = this.splitSpans.get(localId);
    if (span) materializeSplitPiece(this, localId, span);
  }

  emitExpr(e: IrExpr): LlValue {
    return emitExpr(this, e);
  }

  /** A fresh read-site cache for one constant-key dyn read. */
  dynReadIcSite(): string {
    return `@sc_dyn_read_ic_${this.dynReadIcSites++}`;
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

  emitterFixedAdapter(cbT: IrType & { kind: "func" }): { fn: string; shim: string } {
    return emitterFixedAdapter(this, cbT);
  }

  emitterOnceAdapter(boxerT: IrType & { kind: "func" }): { fn: string; shim: string } {
    return emitterOnceAdapter(this, boxerT);
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

  streamDoneFnFor(kind: "w" | "f" | "d" | "t" | "l", doneT: IrType & { kind: "func" }): string {
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

  streamCbThunkFor(kind: "r" | "w" | "f" | "d" | "t" | "l" | "e", cbT: IrType): string {
    return streamCbThunkFor(this, kind, cbT);
  }

  resolveThunkFor(inner: IrType): string {
    return resolveThunkFor(this, inner);
  }

  tagInSet(uName: string, unionId: string, tags: number[]): string {
    return tagInSet(this, uName, unionId, tags);
  }

  arrPush(arr: string, acc: "f64" | "bool" | "ref", value: string): string {
    return arrPush(this, arr, acc, value);
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
  ): LlValue {
    return emitBytesGet(this, elem, receiver, index, expr, inBounds, invalidNaN);
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

  private emitBytesSet(
    elem: IrBytesElem,
    receiver: string,
    index: LlValue,
    value: LlValue,
    indexExpr?: IrExpr,
    expr?: IrExpr,
    inBounds = false,
  ): void {
    return emitBytesSet(this, elem, receiver, index, value, indexExpr, expr, inBounds);
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
function adoptingAwaitOf(value: IrExpr | null): ExprOf<"awaitExpr"> | null {
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
