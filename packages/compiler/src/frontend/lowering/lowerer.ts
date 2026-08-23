import { InternalCompilerError } from "../../errors.js";
/* AST + checker → IR.
 *
 * Invariants:
 * - Runs only on programs that passed preflight (tsc-clean), so the lowerer
 *   may assume the checker's guarantees (no undeclared identifiers, no
 *   ill-typed operators) and every remaining rejection is a *scriptc*
 *   limitation with its own SC1xxx/SC2xxx code.
 * - Collects ALL diagnostics instead of stopping at the first: an
 *   unsupported construct poisons its enclosing statement (PoisonError),
 *   the statement is skipped, and lowering continues. The user sees every
 *   blocker at once — this list is the seed of the coverage report.
 * - Lexical scoping is resolved here: locals get function-unique ids
 *   ("x.0", "x.1" for shadowing); the IR is scope-flat.
 */
import { resolve } from "node:path";
import { isRelativeSpecifier, tsgoPath } from "../shared.js";
import * as ts from "../ts7/adapter.js";
import type { ScrDiagnostic } from "../../diagnostics/diagnostic.js";
import {
  anyOpRequiresDynamicDiag,
  blockedBindingUseDiag,
  checkerPanicDiag,
  componentTypeDiag,
  isCheckerPanic,
  genericSignatureTypeDiag,
  indexSignatureTypeDiag,
  intersectionTypeDiag,
  noLoweringDiag,
  overloadedSignatureTypeDiag,
  recordShapeMismatchDiag,
  requiresDynamicApiDiag,
  requiresDynamicPackageDiag,
  requiresDynamicTypeDiag,
  unionMismatchDiag,
  UNSUPPORTED,
  unsupportedDiag,
  unsupportedTypeDiag,
} from "../../diagnostics/diagnostic.js";
import type {
  IrClassDef,
  IrExpr,
  IrFfiImport,
  IrFunction,
  IrGlobal,
  IrLocal,
  IrModule,
  IrParam,
  IrRecordShape,
  IrStmt,
  IrType,
  IrUnionDef,
  SrcLoc,
} from "../../ir/nodes.js";
import { arrayOf, BOOL, canAdaptDynFuncTo, canConvertToDyn, canCrossIslandBoundary, canExitIslandToType, canMarshalTypedFuncIntoIsland, DYN, F64, isJsonSafeType, isUndefinedArmedUnion, isUnitType, JSVAL, RUNTIME_ERROR_CLASSES, STRING, typeEquals, UNDEFINED_T, VOID } from "../../ir/nodes.js";
import { type DynamicImportResolution, type NpmBuiltinUse, type NpmLazyTrap } from "../npm.js";
import { provenanceActive } from "../provenance-registry.js";
import {
  ambientDtsPath,
  canonicalBuiltinModule,
  type StartupCrash,
  cjsExportAssignmentOf,
  cjsExportDiscardReason,
  fallbackDtsPath,
  isCjsExportTableLiteral,
  isJsSourceFile,
  isNodeEsmFile,
  isNodeTypesPath,
  locOf,
  orderedImportsOf,
  overridesDtsPath,
  npmStaticDepSf7,
  requireSpecOf,
  resolveImport,
  workspacePackageOfPath,
} from "../program.js";
import {
  containsRecord,
  containsUnion,
  describeComponentBlocker,
  describeRecordMemberBlocker,
  formatIrType,
  ISLAND_AMBIENT_TYPES,
  isUnitOnlyTsType,
  mapType,
  ShapeRegistry,
  type DeclaredOrderPriorityRef,
  typeKey,
  type TypeMapperCtx,
  UnionRegistry,
  withUndefinedArm as withUndefinedArmCanonical,
} from "../types.js";
import { CompoundOp, IslandFnEntry, boundaryIntoIslandMsg, boundaryOutOfIslandMsg, BuiltinModuleFn, builtinConstLit, builtinModuleConstOf, builtinModulesArrayLit, builtinFenceHintOf, builtinModuleFnOf, stdlibMemberFence, isStdlibMember, isStdlibSymbol, isStdlibGlobal, stdlibGlobalMember, nodeTypesOnlySymbol } from "./surfaces.js";
import { FileParts, splitFiles, collectProgram, collectNpmImports, collectJsonImports, moduleArtifacts, collectGlobals, declSymbolOf, defaultExportSymbolOf, lowerFileInit, lowerDefaultExport, buildMain, appendDynamicImportModules } from "./lower-modules.js";
import { ClassInfo, ClassIteratorInfo, GenericClassInfo, registerBuiltinErrorClasses, registerBuiltinEmitterClass, registerBuiltinStreamClasses, builtinErrorInfoOf, builtinEmitterInfoOf, builtinStreamInfoOf, analyzeClassDecoration, classIteratorDrainCall, classIteratorNextCall, classIteratorOf, classIteratorOpenCall, classIteratorRestDrainCall, classMemberNameOf, classValueRef, collectClassShape, exactClassOfReceiver, collectClassShapeInner, ctorAbiEquals, findMethodOn, findStaticOn, findGenericMethodOn, findGenericStaticOn, genericClassInstanceType, isSubclassOf, inHierarchy, overrideBelow, staticShadowBelow, upcastTo, lowerClassMembers, lowerClassCtor, lowerClassExpression, lowerClassExpressionInfo, lowerClassMethodMember, lowerClassValueProperty, lowerStaticMethod, throwingSetterFn, fieldInitStmts, lowerStaticFieldInits, lowerStaticFieldRead, lowerDerivedCtorBody, superCallStmt, lowerSuperMethodCall, superThisRef, lowerSuperAccessorRead, lowerSuperAccessorWrite, inheritsBuiltinErrorCtor, inheritsBuiltinEmitterCtor, errorMessageArg, lowerNew, accessorCall } from "./lower-classes.js";
import { MixinFnShape, mixinCallClassInfoOf, mixinIntersectionInstanceType } from "./lower-mixins.js";
import { ParamShape, FnSig, GenericFnInfo, GenericInstance, bindingNeverReassigned, bodyReadsArguments, implicitMonoFile, isThisParameter, paramShape, paramShapes, checkDefaultParamBodyType, completeArgs, wrappedUndefined, undefinedArgFor, requireExactArityValue, bodyReturnType, declaredReturnType, collectSignature, collectSignatureInner, collectGenericSignature, genericFnOf, lowerGenericCall, lowerGenericFnValue, inferTypeParamBindings, lowerGenericInstance, lowerCall, lowerFfiCall, lowerTimersMemberCall, lowerPromiseMethodCall, lowerFilterNarrowCall, isTopLevelFnSymbol, lowerNestedFunctionDecl, lambdaSignature, lowerLambda, lowerFunction, validateFfiImports } from "./lower-calls.js";
import { lowerArrayMethodCall, lowerBufferStaticCall, lowerBytesMethodCall, lowerBytesNew, lowerMapMethodCall, lowerMapForEachCall, buildMapForEachFn, lowerRecordOvfCaptureHelper, lowerEnvToPairsHelper, lowerSetMethodCall, lowerSetForEachCall, buildSetForEachFn, lowerRegexMethodCall, lowerStringMethodCall } from "./lower-containers.js";
import { lowerStreamModuleCall } from "./lower-stream.js";
import { lowerEmitOverrideSpec, type EmitSpecCtx, type EmitSpecRequest } from "./lower-emitter.js";
import { builtinImportOf, createRequireBindingDecl, createRequireNamespaceDecl, createRequireSpecOf, stripTypeCasts, lowerBuiltinModuleCall, lowerFsToUnixTimestampCall, lowerFsLadderCall, lowerChildArgsArg, lowerSpawnSyncCall, lowerSpawnCall, lowerExecSyncCall, recordToEnvPairs, lowerJsonMethodCall, fencedBuiltinImportOf, lowerCryptoComposedCall, lowerUrlMethodCall, lowerSearchParamsMethodCall, lowerStatsMethodCall, lowerChildMethodCall, lowerAtomicsCall, lowerBuiltinExtraProperty, promisifiedExecFileDecl, lowerExecFileAsyncCall, execFileAsyncHelper, lowerStringDecoderMethodCall, strdecHelper, lowerReadlineMethodCall, lowerDcChannelMethodCall, lowerDcChannelProperty, lowerAlsMethodCall, lowerDcTracingChannelMethodCall, lowerDcTracingChannelProperty, lowerJsonProperty, lowerErrorCodeProperty, lowerProcessProperty, isProcessEnv, envValueType, lowerProcessEnvGet, lowerProcessMethodCall, lowerProcessOptionalMethodCall, lowerTimeoutMethodCall, envSnapshotHelper, isConsoleLog, consoleCallMember, lowerNumberStaticCall, lowerNumberStaticProperty, lowerDateCall, lowerTextCodecCall, lowerCryptoModuleCall, lowerFsConstantsProperty, lowerBuiltinConstantsProperty, builtinConstantBindingOf, builtinConstantsDestructureDecl, lowerProcessStreamProperty, lowerStringStaticCall, lowerStringLastIndexOfCall, lowerPromiseStaticCall, textCodecBindingClassOf } from "./lower-builtins.js";
import { fenceFetchObjectAssignment, fenceFetchObjectBinding, fenceStaticAbortControllerMemberRead, fenceStaticHeadersIteration, fenceStaticHeadersMember, fenceStaticReadableStreamMember, fenceStaticResponseMember, fenceUnsupportedFetchConstructorMember, isIslandExpr, islandFuncValueFence, islandRegexpOf, jsvalIn, requireDynamicApi, islandGlobalFnOf, lowerAbortControllerNew, lowerDynamicHeadersIteratorCall, lowerDynamicHeadersSpread, lowerDynamicImportCall, lowerFetchCall, lowerFetchElementMethodCall, lowerResponseNew, lowerStaticFetchCompanionCall, lowerStaticAbortControllerCall, lowerStaticAbortSignalListenerCall, lowerStaticReadableStreamCancelCall, lowerStaticReadableStreamControllerCall, lowerStaticReadableStreamNew, lowerStaticReadableStreamReaderCall, lowerStaticResponseCall, lowerIslandMethodCall, lowerMathProperty, npmPackageOf, npmMemberFence, npmPackageOfSymbol } from "./lower-island.js";
import { lowerHttpHeadersElement, lowerNetModuleCall, lowerServerMethodCall, lowerServerProperty, lowerTlsRootCertificates } from "./lower-server.js";
import { lowerDgramDnsModuleCall, lowerDgramMethodCall } from "./lower-dgram.js";
import { lowerNodeTestModuleCall, lowerTestDirectCall, lowerTestMethodCall, lowerTestCtxProperty } from "./lower-test.js";
import { lowerAssertModuleCall, lowerAssertDirectCall } from "./lower-assert.js";
import { lowerUtilModuleCall } from "./lower-inspect.js";
import { lowerComptime, comptimeBakeable, rejectComptimeCaptures, comptimeValueToIr } from "./lower-comptime.js";
import { lowerStmts, noteBlockedBindings, isBlockedBinding, lowerScopedBlock, predeclareForwardCapture, predeclareForwardFnDecl, predeclareForwardVar, rejectJumpCrossingFinally, lowerStmt, lowerVarStatement, lowerDestructuringDecl, lowerDestructuringAssignParts, lowerBindingPattern, lowerJsvalBindingPattern, checkBindingElement, bindPatternTarget, isParseArgsDynCheckerType, lowerVarDeclList, lowerVarDecl, lowerSwitch, lowerTry, lowerExprStatement, lowerForOf, lowerForStatement } from "./lower-stmts.js";
import { FieldTarget, lowerDynObjectLiteral, lowerExpr, maybeNarrow, lowerUnitComparison, lowerNullishCoalesce, lowerOptionalChain, finishOptionalChain, lowerCondition, ensureBool, requireTruthyUnion, eqComparableUnion, lowerIntrinsicProperty, lowerArrayLiteral, lowerObjectLiteral, lowerShorthandValue, rejectThisInObjectMethod, lowerElementAccess, lowerElementWrite, lowerRecordKeyRead, ensureString, lowerTemplate, lowerAsExpression, lowerPrefixUnary, lowerBinary, lowerCaughtTypeofTest, caughtRead, caughtLocalOf, caughtToString, lowerInstanceOf, lowerRegexLiteral, lowerFieldRead, lowerUnionProperty, fieldTarget, fieldGetExpr, fieldSetStmt, lowerFieldCompound, uniqueSymbolKeyOf, foldedStringKeyOf } from "./lower-exprs.js";
import type { ExpandoMember } from "./lower-expando.js";
import { lowerRecordFieldCall, lowerObjectMethodCall } from "./lower-calls.js";
import { fenceCrossBlockNsRef, nsPathPrefix } from "./lower-namespaces.js";
import { numLit, varRef } from "../../ir/build.js";

/** Entry function name. '%' cannot appear in a TS identifier, so a user
 * function can never collide with it (mangling is injective per prefix). */
export const ENTRY_NAME = "%main";

interface GenericDemandOwner {
  priority?: readonly [phase: number, order: number];
  functionDemands: GenericInstance[];
  classDemands: ClassInfo[];
}

/** One step of the copy-reshape width relation (widthLiftPlan): how a
 * source-typed value enters a destination slot. Pure data — the plan half;
 * applyWidthLift is the build half. */
export type WidthLift =
  | { how: "copy" }
  | { how: "wrap"; tag: number }
  | { how: "retag" }
  | { how: "liftWrap"; tag: number; arm: IrType }
  | { how: "width" }
  | { how: "arr" }
  | { how: "tupleArr" }
  | { how: "emptyArr" }
  | { how: "objWidth" }
  | { how: "clsWidth" }
  | { how: "narrow" }
  | { how: "dynIn" }
  | { how: "upcast" }
  | { how: "funcAdapt" };

export class PoisonError extends Error {}

/** Own-property lookup for the surface tables. They are plain object
 * literals, so a bare `table[name]` would also find Object.prototype
 * members ("toLocaleString", "constructor", "valueOf") — genuine member
 * NAMES user code can spell now that the real lib declares them; treating
 * an inherited function as a table entry would mis-lower or ICE. */
export function own<T>(table: Record<string, T | undefined>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/** Sentinel binding key for `this` (which has no ts.Symbol): a stable
 * object identity used in the same scope/capture maps as real symbols, so
 * arrows capturing `this` ride the ordinary capture machinery. */
const THIS_BINDING = { escapedName: "%this" } as unknown as ts.Symbol;

/* ── the island boundary, in one voice ────────────────────────────────
 * Whether a value can cross between the static world and the island is
 * ONE question — canCrossIslandBoundary (nodes.ts), asked here through
 * boundarySafe() — and each rejected direction has ONE message builder,
 * so the rule and its wording cannot drift apart across the implicit
 * coercion path, the explicit marshal path, and the exact-type fence. */

/** Per-function lowering context. A stack of these models nested functions:
 * identifier resolution walks outward, and a hit in an enclosing context
 * turns into a capture (boxing the binding at its origin and threading it
 * through every function in between). */
export interface FnCtx {
  locals: IrLocal[];
  scopes: Map<ts.Symbol, IrLocal>[];
  localCounters: Map<string, number>;
  /** Lifted functions only: capture entries (also present in `locals`,
   * boxed), in closure caps[] order. undefined ⇔ plain declared function. */
  captures: IrParam[] | null;
  /** Parent-function localIds feeding each capture, parallel to captures. */
  captureSources: string[];
  captureBySymbol: Map<ts.Symbol, IrLocal>;
  /** Named function expressions/declarations: the function's own name
   * symbol. Self-references become `selfRef` (NOT a capture — a box holding
   * its own closure would be an RC cycle and leak). */
  selfSymbol: ts.Symbol | null;
  selfType: IrType | null;
  /** Await is legal here (async function body). */
  isAsync?: boolean;
  /** Yield is legal here (generator function body): the yield/next value
   * channels the yield lowering types itself against. */
  generator?: { yieldT: IrType; nextT: IrType } | null;
  /** VARIADIC `arguments` form (rest-marked func type with no declared
   * rest param): the synthetic trailing dyn-array param `arguments`
   * reads resolve to. */
  argumentsLocal?: IrLocal | null;
  /** Declared return type — lets `return` detect record-shape mismatches
   * (SC2002) before the validator would ICE on them. */
  returnType: IrType;
  /** Implicit-any instance RETURN INFERENCE (resolveInferredReturn):
   * present ⇔ `return` statements lower their values BARE (no coercion)
   * and record themselves here; the post-pass unifies the types and wraps
   * each return onto the settled one. `returnType` holds the DYN pin. */
  inferReturn?: { entries: { stmt: IrStmt; node: ts.Expression | null }[] } | null;
  /** Enclosing control constructs, innermost last: loops/switches/labeled
   * blocks (jump targets — `labels` carries their JS label names so labeled
   * break/continue resolve), try-with-finally regions ("tryFinally" — a
   * try/catch body guarded by a finally: `return` crosses them now via the
   * backend's pending-return path; break/continue still reject), and
   * finally BLOCKS themselves ("finallyBlock" — jumps out stay rejected: a
   * return there would REPLACE a pending completion, a model the emitter
   * doesn't implement; see rejectJumpCrossingFinally). Per function: a
   * nested function's jumps never bind to enclosing constructs. */
  ctl: { kind: "loop" | "switch" | "block" | "tryFinally" | "finallyBlock"; labels?: string[] }[];
}

export function newFnCtx(
  lifted: boolean,
  selfSymbol: ts.Symbol | null,
  selfType: IrType | null,
  returnType: IrType,
): FnCtx {
  return {
    locals: [],
    scopes: [new Map()],
    localCounters: new Map(),
    captures: lifted ? [] : null,
    captureSources: [],
    captureBySymbol: new Map(),
    selfSymbol,
    selfType,
    returnType,
    ctl: [],
  };
}

export interface LowerStats {
  /** Statements the lowerer attempted (nested statements count individually;
   * statements inside a poisoned construct were never reached and don't). */
  statementsTotal: number;
  statementsFailed: number;
  /** Statements that LOWERED but contain island constructs (jsOp/jsExit —
   * package calls, island-backed lib members): they compile, but their
   * work runs in the embedded engine. Only a --dynamic analysis produces
   * these; coverage renders them as "compile dynamically". */
  statementsIsland: number;
  /** Functions whose signature couldn't be analyzed (bodies not counted). */
  functionsSkipped: number;
}

/** IrStmt discriminants — the island walk below must not descend into
 * NESTED statements (each is counted individually by its own lowerStmts
 * visit; descending would attribute a nested island statement to every
 * enclosing construct too). The top-level statement object itself is
 * always visited. */
const IR_STMT_KINDS = new Set([
  "varDecl", "assign", "exprStmt", "if", "while", "doWhile", "switch",
  "arraySet", "forOf", "return", "fieldSet", "recordSet", "break",
  "continue", "block", "tryCatch", "throw", "rethrow", "runtimeFence",
]);

/** True when a lowered statement's OWN expressions contain island
 * constructs — a generic JSON walk (like moduleUsesRegex): `kind`
 * discriminants live only on IR objects, so user string values can never
 * false-positive. Nested statements are skipped (counted separately). */
/** Every identifier a binding name binds: the identifier itself, or all
 * identifiers of a (possibly nested) destructuring pattern in source
 * order. */
export function boundIdentifiersOf(name: ts.BindingName): ts.Identifier[] {
  if (ts.isIdentifier(name)) return [name];
  const out: ts.Identifier[] = [];
  for (const el of name.elements) {
    // Elisions: OmittedExpression in 5.9.3, a NAMELESS BindingElement in 7
    // (the parity battery's pinned finding 2) — both spell "no binding".
    if (ts.isOmittedExpression(el) || el.name === undefined) continue;
    out.push(...boundIdentifiersOf(el.name));
  }
  return out;
}

export function stmtUsesIsland(stmts: IrStmt | IrStmt[]): boolean {
  let found = false;
  const visit = (v: unknown, root: boolean): void => {
    if (found || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const item of v) visit(item, root);
      return;
    }
    const kind = (v as { kind?: unknown }).kind;
    if (!root && typeof kind === "string" && IR_STMT_KINDS.has(kind)) return;
    const fn = (v as { fn?: unknown }).fn;
    if (
      kind === "jsOp" || kind === "jsExit" || kind === "jsBridgePromise" ||
      fn === "island.eval" || fn === "island.import" || fn === "island.importDyn" ||
      fn === "island.castFail"
    ) {
      found = true;
      return;
    }
    for (const value of Object.values(v)) visit(value, false);
  };
  visit(stmts, true);
  return found;
}

export interface LowerResult {
  /** Present iff diagnostics is empty. */
  module: IrModule | null;
  diagnostics: ScrDiagnostic[];
  /** JS statements whose compile fences DEFERRED to runtime (runtimeFence
   * statements in the module) — off the build, on the coverage report. */
  runtimeFences: ScrDiagnostic[];
  stats: LowerStats;
  /** --provenance-sources only: per-file statement attribution (the
   * coverage report aggregates it per provenance package). */
  statsByFile?: Map<string, { total: number; failed: number; island: number }>;
  /** --provenance-sources only: diagnostics of elided pure-annotated dead
   * consts in fetched source modules — off the build, on the report. */
  provenanceElided?: ScrDiagnostic[];
  /** Coverage only (LowerOptions.coverage): the unreached remainder,
   * lowered in a throwaway pass — blockers in it can never fail a build. */
  unreached?: { diagnostics: ScrDiagnostic[]; stats: LowerStats };
  /** --dynamic only: every Node builtin the embedded npm graph imports,
   * shimmed or not — the coverage report's island honesty. */
  npmBuiltins?: NpmBuiltinUse[];
  /** --dynamic only: unresolvable specifiers reached ONLY by require()/
   * import() edges — the build embeds Node's call-time error as a runtime
   * trap; the coverage report lists them beside the builtins. */
  npmLazyTraps?: NpmLazyTrap[];
}

export interface LowerOptions {
  /** --dynamic: the island engine is linked, so island constructs
   * (__island_eval) may lower. Off by default — without it they produce a
   * requires-dynamic diagnostic instead. */
  dynamic?: boolean;
  /** Coverage: additionally lower the unreached remainder (bodies nothing
   * on the entry path reaches) in a throwaway pass and report its
   * diagnostics and stats under `unreached` — the whole-program analysis
   * builds deliberately gave up. */
  coverage?: boolean;
  /** The platform the build TARGETS ("win32" under a windows cross triple,
   * the host platform otherwise — see buildTargetPlatform in index.ts).
   * The whole program compiles for one platform, so the platform-keyed
   * surfaces are compile-time constants: on win32 the bare path module
   * binds path.win32 (Node on Windows IS path.win32) and path.sep /
   * path.delimiter / os.EOL lower as the win32 literals; path.posix and
   * path.win32 keep answering THEIR platform everywhere, like Node's. */
  targetPlatform?: string;
  /** Node's startup refusal (LoadResult.startupCrash — preflight's
   * resolution walk and CJS named-import link check): the program
   * compiles to that startup crash. */
  startupCrash?: StartupCrash | null;
  /** LIBRARY mode's reachability roots: the profile-mapped exports of the
   * entry module. Executable builds root at the entry's top level alone
   * (an unreferenced export dead-strips); a library's exports are called from
   * OUTSIDE the graph, so discovery seeds them alongside the init
   * bodies. Names are the entry file's unqualified declaration names. */
  libRoots?: readonly string[];
  /** Outbound native FFI declarations from a validated format-1 manifest.
   * Calls of their exact ambient TypeScript bindings lower to direct C ABI
   * imports; without this option ambient declarations keep Node's ordinary
   * ReferenceError behavior. */
  ffiImports?: readonly IrFfiImport[];
  /** LIBRARY mode's host-callback surface marker: the `ffiImports` above
   * are profile-declared callback channels, not native-manifest bindings.
   * Flips the binding diagnostics to the library flavor (SC4024), keeps a
   * channel legal when no program declaration references it (an unused
   * channel is capacity, not an error), and refuses a CALL of any other
   * program-authored signature-only ambient function with the callback
   * teaching instead of the ambient ReferenceError lowering. */
  libraryCallbacks?: boolean;
  /** Coverage-only external host type surfaces. Their declarations inform
   * the checker, while every runtime value use remains an SC1010 fence. */
  externalTypes?: ReadonlyMap<string, string>;
  /** The mapped entries plus relative declaration dependencies, attributed
   * to their owning external specifier. */
  externalTypeSpecifiersByFile?: ReadonlyMap<string, readonly string[]>;
}

interface RuntimeFenceFallback {
  code: `SC${number}`;
  message: string;
}

interface RuntimeFenceBase {
  /** Used only by catches that can legitimately have no fresh diagnostic. */
  fallback?: RuntimeFenceFallback;
  /** Legacy function-body fences throw the diagnostic text without a site suffix. */
  bareMessage?: boolean;
  /** The closure-probe fallback historically applies inside diagnostic captures. */
  allowDiagSink?: boolean;
}

interface RuntimeFenceStatementTarget extends RuntimeFenceBase {
  kind: "statement";
}

interface RuntimeFenceFunctionTarget extends RuntimeFenceBase {
  kind: "function";
  name: string | (() => string);
  params?: IrParam[];
  returnType: IrType;
  paramsMutable?: boolean;
  async?: true;
  generator?: { yieldT: IrType; nextT: IrType };
}

interface RuntimeFenceClosureTarget extends Omit<RuntimeFenceFunctionTarget, "kind"> {
  kind: "closure";
  type: IrType & { kind: "func" };
}

type RuntimeFenceTarget =
  | RuntimeFenceStatementTarget
  | RuntimeFenceFunctionTarget
  | RuntimeFenceClosureTarget;

/** The Lowerer's pass configuration (see lowerToIr). */
export interface LowererMode {
  /** Names of bodies a prior reachability pass reached; null lowers everything. */
  reachable?: ReadonlySet<string> | null;
  /** Coverage remainder: lower ONLY bodies outside `reachable`, skip the
   * always-reachable init bodies and module building, and report deferred
   * collection diagnostics nothing flushed. */
  remainder?: boolean;
  /** Symbols whose deferred diagnostics reachable emit already flushed —
   * the remainder must not report them a second time. */
  alreadyFlushed?: ReadonlySet<ts.Symbol>;
  /** The build's target platform (LowerOptions.targetPlatform — lowerToIr
   * passes it to every pass). Defaults to the host. */
  targetPlatform?: string;
  /** Node's startup refusal (preflight's resolution walk / CJS named-
   * import link check): %main opens with exactly this throw, before any
   * module init — Node refuses the whole graph before anything evaluates,
   * so nothing runs. */
  startupCrash?: StartupCrash | null;
  /** The build's outbound native FFI declarations. */
  ffiImports?: readonly IrFfiImport[];
  /** LowerOptions.libraryCallbacks (see there). */
  libraryCallbacks?: boolean;
  /** Program-validated ambient declaration symbols for each FFI name.
   * Undefined in discovery's legacy call-local validation path. */
  ffiBindingSymbols?: ReadonlyMap<string, ReadonlySet<ts.Symbol>>;
  /** LowerOptions.externalTypes, threaded through every lowering pass. */
  externalTypes?: ReadonlyMap<string, string>;
  /** LowerOptions.externalTypeSpecifiersByFile, shared by every pass. */
  externalTypeSpecifiersByFile?: ReadonlyMap<string, readonly string[]>;
}

function directExternalTypeSpecifiersByFile(
  externalTypes: ReadonlyMap<string, string>,
): ReadonlyMap<string, readonly string[]> {
  const out = new Map<string, string[]>();
  for (const [specifier, file] of externalTypes) {
    const key = tsgoPath(resolve(file));
    const owners = out.get(key);
    if (owners === undefined) out.set(key, [specifier]);
    else if (!owners.includes(specifier)) owners.push(specifier);
  }
  return out;
}

/** Build lowering runs as a reachability worklist over the ts.Program:
 *
 * 1. REACHABLE EMIT — a worklist computes the set of reachable bodies.
 *    Seeds are
 *    the per-file init bodies (module top-level statements always run, in
 *    import order); lowering a body yields IR whose call/closure/new/
 *    virtualCall nodes are the edges that enqueue further bodies. The pass
 *    retains that IR. Once the graph closes, those functions are assembled in
 *    deterministic declaration order beside the already-lowered init,
 *    generic-instance, and lifted bodies. Checker-backed IR construction
 *    therefore happens once instead of once for discovery and again for
 *    emission.
 *
 * `coverage: true` adds a second pass — the REMAINDER — that lowers only
 * the bodies reachable emit did NOT mark (plus deferred collection
 * diagnostics nothing flushed), reported separately: whole-program analysis without
 * letting unreached code fail builds. */
export function lowerToIr(
  program: ts.Program,
  entry: ts.SourceFile,
  moduleOrder: ts.SourceFile[],
  options: LowerOptions = {},
): LowerResult {
  const phaseTiming = process.env["SCRIPTC_TIMING"] === "1";
  const phaseStarted = performance.now();
  let phaseLast = phaseStarted;
  const timing = (phase: string, detail: Record<string, unknown> = {}): void => {
    if (!phaseTiming) return;
    const now = performance.now();
    process.stderr.write(
      `scriptc lowering ${JSON.stringify({
        phase,
        phase_ms: Math.round((now - phaseLast) * 10) / 10,
        total_ms: Math.round((now - phaseStarted) * 10) / 10,
        ...detail,
      })}\n`,
    );
    phaseLast = now;
  };
  const dynamic = options.dynamic ?? false;
  const targetPlatform = options.targetPlatform ?? process.platform;
  const startupCrash = options.startupCrash ?? null;
  // --dynamic: modules reachable only through dynamic import() of the
  // program's own files join the compiled graph here, ONCE, before any
  // pass constructs (nothing calls their %init at startup — the import()
  // site's namespace builder does, on the engine microtask, Node's
  // evaluation point for them). Inadmissible static cycles inside the
  // added subgraph are minted here and handed to reachable emit after this
  // extension of the shared array; no later pass re-walks the subgraph.
  const dynamicCycleDiags: ScrDiagnostic[] = [];
  if (dynamic) {
    appendDynamicImportModules(program, moduleOrder, (cycle, reason) => {
      dynamicCycleDiags.push(
        unsupportedDiag("SC1016", { file: entry.fileName, start: 0, end: 0 }, `circular imports (${cycle}; ${reason})`),
      );
    });
  }
  const ffiImports = options.ffiImports ?? [];
  const libraryCallbacks = options.libraryCallbacks ?? false;
  const externalTypes = options.externalTypes ?? new Map<string, string>();
  const externalTypeSpecifiersByFile = options.externalTypeSpecifiersByFile ??
    directExternalTypeSpecifiersByFile(externalTypes);
  const validation = new Lowerer(program, entry, moduleOrder, dynamic, {
    targetPlatform,
    startupCrash,
    ffiImports,
    libraryCallbacks,
    externalTypes,
    externalTypeSpecifiersByFile,
  });
  const ffiValidation = validateFfiImports(validation);
  timing("ffi-validate");
  // Reachability must use the same exact-symbol ownership as FFI validation.
  // Otherwise a local function shadowing a configured ambient name is mistaken for FFI
  // while computing reachability, even though ordinary lowering would
  // correctly handle it as TypeScript. FFI-free builds reuse the validation
  // lowerer because validation is an immediate no-op there.
  const reachableEmit = ffiImports.length === 0
    ? validation
    : new Lowerer(program, entry, moduleOrder, dynamic, {
        targetPlatform,
        startupCrash,
        ffiImports,
        libraryCallbacks,
        externalTypes,
        externalTypeSpecifiersByFile,
        ffiBindingSymbols: ffiValidation.symbolsByName,
      });
  for (const d of dynamicCycleDiags) reachableEmit.pushDiag(d);
  for (const d of ffiValidation.diagnostics) reachableEmit.pushDiag(d);
  const emitted = reachableEmit.emitReachable(options.libRoots);
  const { reachable } = emitted;
  let result = emitted.result;
  let resultLowerer = reachableEmit;
  timing("reachable-emit", { reachable: reachable.size });
  // A generic class-rest support decision can depend on record metadata
  // whose historical owner is discovered only while retained bodies lower.
  // If the settled answer is a fence, rerun the ordinary reachable emit so
  // the PoisonError occurs in its original statement window: later
  // declarators stay unvisited, bindings block, cascades and stats match the
  // historical compiler. This is a rare compatibility fallback; programs
  // without such a settled fence retain checker-backed IR exactly once.
  if (reachableEmit.requiresHistoricalOrderRelower) {
    const emit = new Lowerer(program, entry, moduleOrder, dynamic, {
      reachable,
      targetPlatform,
      startupCrash,
      ffiImports,
      libraryCallbacks,
      ffiBindingSymbols: ffiValidation.symbolsByName,
      externalTypes,
      externalTypeSpecifiersByFile,
    });
    for (const d of dynamicCycleDiags) emit.pushDiag(d);
    for (const d of ffiValidation.diagnostics) emit.pushDiag(d);
    result = emit.run();
    resultLowerer = emit;
    timing("historical-order-relower");
  }
  if (options.coverage !== true) return result;
  const remainder = new Lowerer(program, entry, moduleOrder, dynamic, {
    reachable,
    remainder: true,
    alreadyFlushed: resultLowerer.flushedSymbols,
    targetPlatform,
    ffiImports,
    libraryCallbacks,
    ffiBindingSymbols: ffiValidation.symbolsByName,
    externalTypes,
    externalTypeSpecifiersByFile,
  });
  const rem = remainder.run();
  return { ...result, unreached: { diagnostics: rem.diagnostics, stats: rem.stats } };
}

/** The island-handle type a `import(...)` initializer gives a binding
 * whose DECLARED type has no static mapping (`Promise<typeof
 * import("./m")>` — module-namespace types don't map): the direct form
 * holds the static promise-of-handle, the awaited form holds the handle
 * itself. Null for every other initializer shape. */
export function importCallHandleType(expr: ts.Expression | undefined): IrType | null {
  if (!expr) return null;
  let e = expr;
  let awaited = false;
  for (;;) {
    if (ts.isParenthesizedExpression(e)) {
      e = e.expression;
    } else if (ts.isAwaitExpression(e)) {
      awaited = true;
      e = e.expression;
    } else {
      break;
    }
  }
  if (ts.isCallExpression(e) && e.expression.kind === ts.SyntaxKind.ImportKeyword) {
    return awaited ? JSVAL : { kind: "promise", inner: JSVAL };
  }
  return null;
}

/** True when `expr` is a call that resolved to an overload SIGNATURE of a
 * source-implemented function whose implementation returns an island value
 * (`any` under --dynamic): tsc never checks overload return types against
 * the body — only the implementation signature is checked — so the
 * overload's return is an unverifiable claim about an island value. The
 * binding stores the HANDLE instead of trap-extracting the claimed type
 * (reconcileOverloadReturn keeps the call jsval by the same rule), and
 * uses dispatch to engine ops — exactly the value Node's binding holds.
 * Ambient (.d.ts) declarations never reach this: they have no compiled
 * implementation, so their calls lower through the island/builtin paths
 * whose validated exits keep the checker-trust trap. */
export function uncheckedOverloadHandleCall(L: Lowerer, expr: ts.Expression | undefined): boolean {
  if (!L.dynamic || !expr) return false;
  let e = expr;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  // Tagged templates are calls too (tag(strings, ...values)) and resolve
  // overload sets the same way — foo1`${1}` against a TemplateStringsArray
  // overload of an any-returning implementation stores the handle.
  if (!ts.isCallExpression(e) && !ts.isTaggedTemplateExpression(e)) return false;
  const rsig = L.checker.getResolvedSignature(e);
  const rdecl = rsig ? L.checker.signatureDeclaration(rsig) : undefined;
  if (!rsig || !rdecl) return false;
  if (!(ts.isFunctionDeclaration(rdecl) || ts.isMethodDeclaration(rdecl)) || rdecl.body) return false;
  const name = rdecl.name;
  const symbol = name ? L.checker.getSymbolAtLocation(name) : undefined;
  if (!symbol) return false;
  const impl = L.checker
    .declarationsOf(symbol)
    .find((d) => (ts.isFunctionDeclaration(d) || ts.isMethodDeclaration(d)) && (d as ts.FunctionDeclaration).body !== undefined);
  if (!impl) return false;
  const implSig = L.checker.getSignatureFromDeclaration(impl);
  if (!implSig) return false;
  return L.mapTypeOf(L.checker.getReturnTypeOfSignature(implSig))?.kind === "jsval";
}

/** The JavaScript declaration fallback for unmappable binding types (see
 * irTypeOf): `any` and every other inference residue is the checked-
 * dynamic 'unknown' kind, and array types keep their array-ness with the
 * fallback applied to the ELEMENT (any[]/never[] evolving arrays become
 * unknown[], so length/push/index still lower). Null for TypeScript
 * files and for void (no value exists to represent). */
/** A JS-file type carrying `never[]` (or a never element) ANYWHERE in its
 * array/tuple/union structure: tsc's inference residue for evolving and
 * information-free shapes — the bare `const gb = []` (never[]), the mixed
 * command tuple `['pwd', []]` ((string | never[])[]). never's f64
 * representation (mapType's uninhabited stance, sound for genuinely dead
 * TS reads) must not capture these VALUES — a later dyn push would
 * dynCheck strings into a number array, a union arm would re-tag as
 * number[] and fence. Callers treat a tainted type as unmappable so the
 * checked-dynamic fallbacks apply, the pre-never-mapping behavior. Bare
 * `never` at the ROOT stays out (`for (const v of [])`'s loop var — the
 * dead read the f64 mapping is FOR). */
export function neverTaintedJsType(L: Lowerer, node: ts.Node, t: ts.Type): boolean {
  if (!isJsSourceFile(node.getSourceFile())) return false;
  const walk = (x: ts.Type, depth: number): boolean => {
    if (depth === 0) return false;
    if (x.isUnionType()) return ts.constituentTypes(x).some((a) => walk(a, depth - 1));
    if (L.checker.isArrayType(x) || L.checker.isTupleType(x)) {
      return L.checker
        .getTypeArguments(x as ts.TypeReference)
        .some((a) => (a.flags & ts.TypeFlags.Never) !== 0 || walk(a, depth - 1));
    }
    return false;
  };
  return walk(t, 4);
}

/** The dyn undefined value — what an uninitialized checked-dynamic
 * binding holds (JS: declared bindings read `undefined` before any
 * assignment). A NULL dyn slot is a trap, never a value, so every dyn
 * binding that is READABLE before its first assignment must start here:
 * `let x;` declarations, hoisted `var`s (function and module scope,
 * forward captures included), and the implicit-return completion
 * (lower-calls' own copy of this pattern predates the helper). */
export function dynUndefinedExpr(loc: SrcLoc): IrExpr {
  return {
    kind: "dynFrom",
    value: { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc },
    type: DYN,
    loc,
  };
}

/** An always-throwing Node-parity error expression (the error.nodeThrow
 * libCall — the lowered form of arms Node rejects unconditionally:
 * ERR_INVALID_THIS receivers, ERR_MISSING_ARGS arity ladders, the
 * symbol-to-string TypeError). kind 0 Error / 1 TypeError / 2 RangeError;
 * an empty code means no code slot. `type` is the replaced expression's
 * own (never materialized — the global.undefRead pattern). */
export function nodeThrowExpr(kind: 0 | 1 | 2, code: string, message: string, type: IrType, loc: SrcLoc): IrExpr {
  return {
    kind: "libCall",
    fn: "error.nodeThrow",
    args: [
      { kind: "numLit", value: kind, type: F64, loc },
      { kind: "strLit", value: code, type: STRING, loc },
      { kind: "strLit", value: message, type: STRING, loc },
    ],
    type,
    loc,
  };
}

/** The post-validation fence STRING a validation-ladder Chk libCall
 * throws after its Node-order checks pass: the same SC2020 text the
 * per-statement runtime fence would have thrown (message + "[code at
 * file:line]"), rendered eagerly so the runtime can throw it verbatim
 * (scr_throw_lowering_fence). The diagnostic joins the runtime-fence
 * ledger exactly like a deferred statement fence — nothing silently
 * drops off the coverage report. */
export function ladderFenceExpr(L: Lowerer, surface: string, node: ts.Node, hint?: string): IrExpr {
  const loc = locOf(node);
  const d = noLoweringDiag(surface, loc, hint);
  L.runtimeFences.push(d);
  const sf = node.getSourceFile();
  const pos = ts.getLineAndCharacterOfPosition(sf, loc.start);
  return {
    kind: "strLit",
    value: `${d.message} [${d.code} at ${loc.file}:${pos.line + 1}]`,
    type: STRING,
    loc,
  };
}

/** The checked-dynamic declaration fallback for unmappable binding types
 * (see irTypeOf), two gates over one story:
 *
 * JAVASCRIPT files: `any` and every other inference residue is the
 * checked-dynamic 'unknown' kind, and array types keep their array-ness
 * with the fallback applied to the ELEMENT (any[]/never[] evolving arrays
 * become unknown[], so length/push/index still lower).
 *
 * TYPESCRIPT files: genuine checker-`any` residue ONLY — a bare `any`
 * binding (`flags & Any`), or a single-call-signature function type whose
 * only unmappable pieces are `any` (`(value: any) => value is string` —
 * the arrow the binding holds lowers those params to dyn, so the binding
 * keeps its func-ness with the same per-piece fallback). The honest
 * static subset of `any` is a binding whose VALUES are dyn-representable:
 * the binding is 'unknown' storage with the boundary conversions
 * coerceToExpected already applies (dynFrom into the slot, validated
 * dynCheck out) and per-site SC2011 fences for the operations the checked-dynamic tree
 * cannot carry JS-exactly (the island still lifts those). Every OTHER
 * unmappable TS type keeps its own diagnostic — annotations exist there,
 * and the fence names the real blocker. `--dynamic` builds never reach
 * this fallback for `any` (mapType answers jsval first).
 *
 * Null for void (no value exists to represent). */
export function dynFallbackType(L: Lowerer, node: ts.Node, t: ts.Type): IrType | null {
  if (t.flags & ts.TypeFlags.Void) return null;
  if (!isJsSourceFile(node.getSourceFile())) {
    if (t.flags & ts.TypeFlags.Any) return DYN;
    // TS single-call-signature function types: per-piece fallback, but
    // ONLY `any` pieces fall to dyn — any other unmappable piece keeps
    // the whole type's own fence.
    return anyPiecedFuncType(L, node, t);
  }
  if (L.checker.isArrayType(t)) {
    const elem = L.checker.getTypeArguments(t as ts.TypeReference)[0];
    const elemTainted =
      elem !== undefined &&
      ((elem.flags & ts.TypeFlags.Never) !== 0 || neverTaintedJsType(L, node, elem));
    const mappedElem = elem !== undefined && !elemTainted ? L.mapTypeOf(elem) : null;
    // A mappable element keeps the static array; an unmappable one makes
    // the WHOLE value dyn (the checked-dynamic tree has real arrays — length/index/push
    // read through the keyed-dyn paths; dyn-element STATIC arrays have no
    // backend representation).
    if (mappedElem) return { kind: "array", elem: mappedElem };
  }
  // A PURE single-call-signature type (an implicit-any JS function —
  // `exports.check = function (certs) {...}`, common/tls's shape): keep
  // its func-ness like arrays keep array-ness, with the fallback applied
  // per PIECE — unmappable params/returns become the checked-dynamic
  // kind, so direct calls stay static calls and value uses cross the
  // boundary by boxing (canBoxFuncIntoDyn). Generics, rest params,
  // construct signatures, overloads, and function-with-properties shapes
  // stay out (the whole value falls to dyn below, where every reached
  // use meets its own fence or boxes as-is).
  const sig = pureSingleCallSignatureOf(L, t);
  if (sig) {
    const params = sig.getParameters().map((p): IrType => {
      const pt = L.checker.getTypeOfSymbolAtLocation(p, node);
      return L.mapTypeOf(pt) ?? DYN;
    });
    const retT = L.checker.getReturnTypeOfSignature(sig);
    const ret: IrType =
      retT.flags & ts.TypeFlags.Void ? VOID : L.mapTypeOf(retT) ?? DYN;
    return { kind: "func", params, ret };
  }
  return DYN;
}

/** The one call signature of a PURE function type — single signature, no
 * properties, no construct signatures, no type parameters, no rest params
 * (declared or synthesized from an `arguments` read). Null for every
 * other shape. The structural gate both dynFallbackType arms share. */
function pureSingleCallSignatureOf(L: Lowerer, t: ts.Type): ts.Signature | null {
  if (!(t.flags & ts.TypeFlags.Object)) return null;
  const sigs = L.checker.getCallSignatures(t);
  if (
    sigs.length === 1 &&
    L.checker.getPropertiesOfType(t).length === 0 &&
    L.checker.getConstructSignatures(t).length === 0 &&
    sigs[0]!.getTypeParameters().length === 0 &&
    sigs[0]!.getParameters().every(
      (p) => {
        const pDecl = L.checker.valueDeclarationOf(p);
        return !pDecl || !ts.isParameter(pDecl) || pDecl.dotDotDotToken === undefined;
      },
    ) &&
    // A SYNTHESIZED rest param (tsc's `arguments` inference — no
    // valueDeclaration to carry the dotDotDot): param-count mismatch
    // against the signature's declaration; the whole value stays dyn.
    (() => {
      const sigDecl = L.checker.signatureDeclaration(sigs[0]!);
      const declParams = sigDecl !== undefined && ts.isFunctionLike(sigDecl) ? sigDecl.parameters : undefined;
      if (declParams !== undefined && declParams.length !== sigs[0]!.getParameters().length) return false;
      // tsgo never synthesizes the `arguments` pseudo-rest into the
      // inferred signature (5.9.3 did — the count mismatch above was the
      // whole detector there), so ask the declaration's body directly.
      return !(sigDecl !== undefined && ts.isFunctionLike(sigDecl) && bodyReadsArguments(sigDecl as { body?: ts.Node }));
    })()
  ) {
    return sigs[0]!;
  }
  return null;
}

/** The TS arm's function-shape fallback: a pure single-call-signature
 * type whose only UNMAPPABLE pieces are `any`-flavored keeps its
 * func-ness with those pieces as dyn (`(value: any) => value is string`
 * — the arrow the binding holds lowers its params through the same
 * irTypeOf fallback, so the binding type and the closure type agree).
 * A piece that fails to map for any other reason answers null — the
 * whole type keeps its own diagnostic. */
function anyPiecedFuncType(L: Lowerer, node: ts.Node, t: ts.Type): IrType | null {
  const sig = pureSingleCallSignatureOf(L, t);
  if (!sig) return null;
  const params: IrType[] = [];
  for (const p of sig.getParameters()) {
    const pt = L.checker.getTypeOfSymbolAtLocation(p, node);
    const mapped = L.mapTypeOf(pt) ?? (pt.flags & ts.TypeFlags.Any ? DYN : null);
    if (!mapped || mapped.kind === "void") return null;
    params.push(mapped);
  }
  const retT = L.checker.getReturnTypeOfSignature(sig);
  const ret: IrType | null =
    retT.flags & (ts.TypeFlags.Void | ts.TypeFlags.Never) ? VOID
    : L.mapTypeOf(retT) ?? (retT.flags & ts.TypeFlags.Any ? DYN : null);
  if (!ret) return null;
  return { kind: "func", params, ret };
}

/** The best-effort JS `Function.prototype.name` of an expression flowing
 * into a dyn slot (the boxed function kind's inspect/error name):
 * identifier and property reads answer the referenced NAME (a
 * REFERENCE-SITE approximation of JS's creation-site naming — an aliased
 * binding reports the alias; SEMANTICS.md), named function expressions
 * their own name, anonymous function/arrow expressions their
 * NamedEvaluation home (a variable initializer or property assignment).
 * Null when nothing names the value (the box stays anonymous). */
export function jsFuncNameOf(node: ts.Node): string | null {
  let n: ts.Node = node;
  while (ts.isParenthesizedExpression(n)) n = n.expression;
  if (ts.isIdentifier(n)) return n.text;
  if (ts.isPropertyAccessExpression(n)) return n.name.text;
  if ((ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n)) && n.name) return n.name.text;
  if (ts.isFunctionExpression(n) || ts.isArrowFunction(n)) {
    const p = n.parent;
    if (p && ts.isVariableDeclaration(p) && p.initializer === n && ts.isIdentifier(p.name)) {
      return p.name.text;
    }
    if (p && ts.isPropertyAssignment(p) && p.initializer === n && ts.isIdentifier(p.name)) {
      return p.name.text;
    }
  }
  return null;
}

export class Lowerer {
  readonly checker: ts.TypeChecker;
  readonly diags: ScrDiagnostic[] = [];
  readonly fnSigsBySymbol = new Map<ts.Symbol, FnSig>();
  readonly genericFnsBySymbol = new Map<ts.Symbol, GenericFnInfo>();
  /** Object-literal GENERIC methods (`{ m<T>(x: T) {...} }`), interned by
   * their function-like node — instances ride the same monomorphization
   * queue (objLitGenericFnInfoOf). */
  readonly objLitGenericFns = new Map<ts.Node, GenericFnInfo>();
  /** Generic arrow/function-expression INITIALIZERS of never-reassigned
   * bindings (`const f = <T>(x: T) => x`), interned by the function-like
   * node — registered in genericFnsBySymbol under the binding's symbol
   * (and a named function expression's own inner name), so calls and
   * pinned values resolve through genericFnOf exactly like top-level
   * generic function declarations (bindingGenericFnInfoOf). */
  readonly bindingGenericFns = new Map<ts.Node, GenericFnInfo>();
  /** Per-symbol result of the never-reassigned file scan
   * (bindingNeverReassigned — object-literal generic-method receivers). */
  readonly neverReassignedCache = new Map<ts.Symbol, boolean>();
  /** TRAP bindings: declarations whose initializer provably throws before
   * producing a value (its chain roots at an ambient-undefined name —
   * ambientUndefVarRootOf). Module init unwinds at the declaration, so no
   * reference to the binding can ever execute; the statement lowers to the
   * root's throw, no storage exists, and references lower to the same
   * trap shape (never reached — sound whatever the type). */
  readonly trapBindings = new Set<ts.Symbol>();
  /** NULLISH bindings of unmappable (generic-signature) types: `const i:
   * I<A & B> = null as any` — the binding provably holds null/undefined
   * forever (every write's RHS is nullish too), so no storage exists and
   * each READ knows the value. Member reads and method calls through one
   * lower to Node's exact TypeError ("Cannot read properties of null
   * (reading 'fn')"); nullish-to-nullish flows lower to nothing. The map
   * answers which unit the binding holds (the TypeError names it). Null
   * entries cache probed non-qualifiers. */
  readonly nullishBindings = new Map<ts.Symbol, "null" | "undefined" | null>();
  /** DEAD bindings of unmappable types: never READ anywhere in the
   * program, declared with no initializer or a value-only one (a function
   * literal), every write's RHS side-effect-free. Node materializes the
   * value and drops it — zero observable effect — so the declaration and
   * its writes lower to nothing, and no type fence fires for a value the
   * program never consumes. */
  readonly deadBindings = new Set<ts.Symbol>();
  /** IMPLICIT-ANY function-value bindings (npm-static JS — `const knownBy
   * = (cmd) => ...`), by their VariableDeclaration: the registered info,
   * or null for probed non-qualifiers (implicitLocalFnNodeOf). */
  readonly implicitLocalFns = new Map<ts.Node, GenericFnInfo | null>();
  /** Monomorphization worklist: instances queued by call sites, drained in
   * run() (processing an instance body can queue more). */
  readonly instantiationQueue: { info: GenericFnInfo; inst: GenericInstance }[] = [];
  /** Historical emit rank of the retained declaration/init body currently
   * lowering, and the earliest such owner that demanded each generic
   * instance. Reachability can encounter a later caller first; the minimum
   * rank recovers the old emitter's source-order monomorphization queue. */
  private genericDemandOwner: GenericDemandOwner | null = null;
  private readonly genericDemandRoots: GenericDemandOwner[] = [];
  private readonly genericFunctionDemandOwner = new Map<GenericInstance, GenericDemandOwner>();
  private readonly genericClassDemandOwner = new Map<ClassInfo, GenericDemandOwner>();
  private readonly genericDemandPriority = new Map<GenericInstance, DeclaredOrderPriorityRef>();
  private readonly genericClassDemandPriority = new Map<ClassInfo, DeclaredOrderPriorityRef>();

  private withGenericDemandOwner<T>(
    owner: GenericDemandOwner,
    fn: () => T,
  ): T {
    const previous = this.genericDemandOwner;
    this.genericDemandOwner = owner;
    try {
      return fn();
    } finally {
      this.genericDemandOwner = previous;
    }
  }

  noteGenericInstanceDemand(inst: GenericInstance): void {
    const owner = this.genericDemandOwner;
    owner?.functionDemands.push(inst);
    const ref = this.genericDemandPriority.get(inst) ?? { rank: [4, Number.MAX_SAFE_INTEGER] };
    const currentRank = owner?.priority;
    if (currentRank && (
      currentRank[0] < ref.rank[0]! ||
      (currentRank[0] === ref.rank[0] && currentRank[1] < (ref.rank[1] ?? 0))
    )) {
      ref.rank = currentRank;
    }
    this.genericDemandPriority.set(inst, ref);
  }

  noteGenericClassInstanceDemand(info: ClassInfo): void {
    const owner = this.genericDemandOwner;
    owner?.classDemands.push(info);
    const ref = this.genericClassDemandPriority.get(info) ?? { rank: [4, Number.MAX_SAFE_INTEGER] };
    const currentRank = owner?.priority;
    if (currentRank && (
      currentRank[0] < ref.rank[0]! ||
      (currentRank[0] === ref.rank[0] && currentRank[1] < (ref.rank[1] ?? 0))
    )) {
      ref.rank = currentRank;
    }
    this.genericClassDemandPriority.set(info, ref);
  }

  /** The old emitter lowered all reachable declarations in source order,
   * then every init, before draining generic instances FIFO. Reorder the
   * retained queue from those recorded demands before any generic body
   * lowers, so immediate support decisions see the same shape metadata too. */
  private restoreGenericInstanceOrder(from = 0): void {
    const tail = this.instantiationQueue.slice(from);
    const discoveryOrder = new Map(tail.map((entry, index) => [entry.inst, index] as const));
    tail.sort((left, right) => {
      const a = this.genericDemandPriority.get(left.inst)?.rank;
      const b = this.genericDemandPriority.get(right.inst)?.rank;
      if (a !== undefined && b !== undefined) {
        const phase = a[0]! - b[0]!;
        if (phase !== 0) return phase;
        const order = a[1]! - b[1]!;
        if (order !== 0) return order;
      } else if (a !== undefined) {
        return -1;
      } else if (b !== undefined) {
        return 1;
      }
      return discoveryOrder.get(left.inst)! - discoveryOrder.get(right.inst)!;
    });
    this.instantiationQueue.splice(from, tail.length, ...tail);
  }

  private restoreGenericClassInstanceOrder(from = 0): void {
    const tail = this.genericClassInstances.slice(from);
    const discoveryOrder = new Map(tail.map((info, index) => [info, index] as const));
    tail.sort((left, right) => {
      const a = this.genericClassDemandPriority.get(left)?.rank;
      const b = this.genericClassDemandPriority.get(right)?.rank;
      if (a !== undefined && b !== undefined) {
        const phase = a[0]! - b[0]!;
        if (phase !== 0) return phase;
        const order = a[1]! - b[1]!;
        if (order !== 0) return order;
      } else if (a !== undefined) {
        return -1;
      } else if (b !== undefined) {
        return 1;
      }
      return discoveryOrder.get(left)! - discoveryOrder.get(right)!;
    });
    this.genericClassInstances.splice(from, tail.length, ...tail);
  }

  private settleGenericDemandPriorities(): void {
    const functionQueue: GenericInstance[] = [];
    const classQueue: ClassInfo[] = [];
    const seenFunctions = new Set<GenericInstance>();
    const seenClasses = new Set<ClassInfo>();
    const enqueue = (owner: GenericDemandOwner): void => {
      for (const info of owner.classDemands) {
        if (seenClasses.has(info)) continue;
        seenClasses.add(info);
        classQueue.push(info);
      }
      for (const inst of owner.functionDemands) {
        if (seenFunctions.has(inst)) continue;
        seenFunctions.add(inst);
        functionQueue.push(inst);
      }
    };
    for (const root of [...this.genericDemandRoots].sort((a, b) => {
      const left = a.priority!;
      const right = b.priority!;
      return left[0] - right[0] || left[1] - right[1];
    })) enqueue(root);
    let classIndex = 0;
    let functionIndex = 0;
    let order = 0;
    while (classIndex < classQueue.length || functionIndex < functionQueue.length) {
      while (classIndex < classQueue.length) {
        const info = classQueue[classIndex++]!;
        this.genericClassDemandPriority.get(info)!.rank = [4, order++];
        const owner = this.genericClassDemandOwner.get(info);
        if (owner) enqueue(owner);
      }
      while (functionIndex < functionQueue.length) {
        const inst = functionQueue[functionIndex++]!;
        this.genericDemandPriority.get(inst)!.rank = [4, order++];
        const owner = this.genericFunctionDemandOwner.get(inst);
        if (owner) enqueue(owner);
      }
    }
    for (const info of this.genericClassInstances) {
      const ref = this.genericClassDemandPriority.get(info);
      if (ref && ref.rank[1] === Number.MAX_SAFE_INTEGER) ref.rank = [4, order++];
    }
    for (const { inst } of this.instantiationQueue) {
      const ref = this.genericDemandPriority.get(inst);
      if (ref && ref.rank[1] === Number.MAX_SAFE_INTEGER) ref.rank = [4, order++];
    }
  }
  /** Non-null while an instance body lowers: type-parameter symbol →
   * concrete IR type, consulted inside mapType's recursion. */
  typeParamBindings: Map<ts.Symbol, IrType> | null = null;
  /** The ts-level twin of typeParamBindings, non-null while a CALL-keyed
   * instance body lowers: type-parameter symbol → the bound CHECKER type,
   * consulted where the mapped IrType has already widened away information
   * the body needs — indexed accesses (`T[K]` needs K's literal key) and
   * keyed record reads (`o[k]` where k's type is a literal-bound K). */
  typeParamTsBindings: Map<ts.Symbol, ts.Type> | null = null;
  /** Non-null while an IMPLICIT-ANY instance body lowers (npm-static JS —
   * lower-calls' implicit-monomorphization section): bound param symbol →
   * the call site's checker type, consulted by typeOf for identifier
   * references the checker still types `any`. The implicit twin of
   * typeParamBindings — the checker has no `T` to substitute, so the
   * binding rides the node-type accessor instead of mapType. */
  implicitParamTypes: Map<ts.Symbol, ts.Type> | null = null;
  /** IMPLICIT-ANY instances lowered EAGERLY at first demand (their return
   * types are inferred from the body — the call site needs them settled),
   * collected here for run()'s function list (the liftedFns discipline). */
  readonly implicitFns: IrFunction[] = [];
  /** ALIASED-TYPEOF narrowing (npm-static JS — ms's `var type = typeof
   * val; if (type === 'string') ...`): while a branch such a test proves
   * lowers, the tested operand's symbol maps to the proven ARM's checker
   * type here, and typeOf answers it — the checker only narrows const
   * aliases, so this carries the var/let form the checker cannot.
   * Scoped strictly by narrowingAliases (lowerIf / lowerCondition). */
  readonly aliasNarrowTypes = new Map<ts.Symbol, ts.Type>();
  /** Locals widened beyond the checker's type because an inferred indexed
   * read can be absent at runtime. Bare reads preserve that union until a
   * surrounding JavaScript guard/default consumes it. */
  readonly runtimeOptionalLocals = new Set<IrLocal>();
  /** All storage slots widened for runtime absence, including slots whose
   * current control-flow branch has temporarily narrowed the value. */
  readonly runtimeOptionalStorageLocals = new Set<IrLocal>();
  /** Capture entries and their origin share one mutable box. Normalize each
   * entry to the origin so writes and flow proofs stay synchronized. */
  readonly runtimeOptionalRoots = new Map<IrLocal, IrLocal>();

  runtimeOptionalRootOf(local: IrLocal): IrLocal {
    return this.runtimeOptionalRoots.get(local) ?? local;
  }

  /** Runs `fn` with the given aliased-typeof narrows applied (and restored
   * after) — the branch-scoping primitive. */
  narrowingAliases<T>(narrows: readonly { sym: ts.Symbol; tsArm: ts.Type }[], fn: () => T): T {
    if (narrows.length === 0) return fn();
    const saved = narrows.map((n) => [n.sym, this.aliasNarrowTypes.get(n.sym)] as const);
    for (const n of narrows) this.aliasNarrowTypes.set(n.sym, n.tsArm);
    try {
      return fn();
    } finally {
      for (const [sym, old] of saved) {
        if (old === undefined) this.aliasNarrowTypes.delete(sym);
        else this.aliasNarrowTypes.set(sym, old);
      }
    }
  }
  /** Non-null while an instance body lowers: appended to every diagnostic
   * so a body error names WHICH instantiation triggered it. */
  instantiationContext: string | null = null;
  /** True while re-lowering a base function's 2nd+ instance: the same source
   * statements were already counted for the first instance. */
  suppressStats = false;
  /** Synthetic array-HOF loop functions (map/filter/forEach desugar),
   * interned per method + element/callback-result type: key → fn name. */
  readonly arrHofHelpers = new Map<string, string>();
  /** Derived shape metadata that depends on another shape's declaration
   * order. These settle before helper bodies rebuild from that metadata. */
  readonly shapeOrderMetadataFinalizers: (() => void)[] = [];
  /** Settled generic class-rest metadata requires the historical emit
   * fallback so its fence can poison the original statement atomically. */
  requiresHistoricalOrderRelower = false;
  /** Helpers that snapshot shape declaration order into their bodies.
   * Reachability lowers inits before the declarations they discover, so
   * these rebuild after the worklist restores historical shape metadata. */
  readonly shapeOrderHelperFinalizers: (() => void)[] = [];
  /** Emit-override specializations (`%C.emit:<event>` — lower-emitter.ts's
   * emit-overrides block): interned names, the drive-loop queue, and the
   * currently-lowering specialization's context (the super-forward
   * interception reads it). */
  readonly emitSpecDone = new Set<string>();
  readonly emitSpecQueue: EmitSpecRequest[] = [];
  emitSpecCtx: EmitSpecCtx | null = null;
  /** Width-coercion helpers (%rec.width.N / %arr.width.N), interned per
   * (from, to) shape pair — see widthCoerce. */
  readonly widthHelpers = new Map<string, string>();
  /** (fromShape, toShape) pairs whose width plan is being computed — the
   * cycle guard for RECURSIVE shapes (a self-referential record narrowing
   * into a self-referential subset). Re-entering an in-progress pair
   * answers "assume coercible" (the greatest fixed point: every OTHER
   * constraint of the cycle is still checked by the outer call, and the
   * built helper terminates because recordWidthHelper interns its name
   * before building the body, so the recursive reference resolves to the
   * helper itself). */
  private readonly widthPlanning = new Set<string>();

  /** Interned node:assert helpers (deep-equality comparisons keyed by
   * typeKey, throws wrappers keyed by callback type + expected class) —
   * the widthHelpers pattern with its own namespace. */
  readonly assertHelpers = new Map<string, string>();
  /** util.inspect's per-type traversal helpers (%util.insp.N), interned
   * by typeKey — the assertHelpers pattern with its own namespace. */
  readonly inspectHelpers = new Map<string, string>();
  /** Union re-tag helpers (%union.retag.N), interned per (from, to)
   * unionId pair — see unionRetagHelper. */
  readonly retagHelpers = new Map<string, string>();
  /** Callee names of every interned coercion helper whose CALL mints a
   * FRESH closure per evaluation (%fn.width.*, %fn.adapt.*,
   * %fnval.spawnres.*). Registered at the mint site — NOT recovered by
   * name-prefix matching — because retained-FFI release identity is the
   * runtime closure pointer: a coercion adapter allocates a different
   * closure at the registration and release sites, so lowerFfiCall must
   * refuse these forms at compile time (SC5003). Any new closure-minting
   * adapter helper MUST add its name here, or the identity guard silently
   * reopens and the mismatch surfaces as a runtime release trap instead. */
  readonly freshClosureAdapters = new Set<string>();
  /** Symbols bound by `const x = promisify(execFile)` — the one lowered
   * util.promisify shape. Declarations register here and emit nothing;
   * calls through the binding lower (lowerExecFileAsyncCall) and value
   * uses fence. */
  readonly promisifiedExecFile = new Set<ts.Symbol>();
  /** Symbols bound by `const process = globalThis.process` (and the other
   * stdlib-global snapshot spellings): pure alias plumbing — receiver
   * checks resolve through this map (stdlibGlobalNameOf), declarations
   * emit nothing. */
  readonly stdlibGlobalAliases = new Map<ts.Symbol, string>();
  /** CJS export-table ACCESSORS (`module.exports = { get path() {...} }`),
   * lifted lazily as module-level functions and interned per accessor
   * declaration: member reads call the getter (lower-exprs). */
  readonly cjsAccessorFns = new Map<ts.Node, { fnName: string; type: IrType & { kind: "func" } }>();
  readonly narrowHelpers = new Map<string, string>();
  /** Interned `%iter.drain.<n>` helpers (classIteratorDrainCall): one per
   * receiver class — the eager drain of a class iterable's protocol into
   * a fresh element array, behind array/call spreads. */
  readonly iterDrainHelpers = new Map<string, string>();
  /** Island-lift builder helpers (%jsin.rec.N / %jsin.arr.N /
   * %jsin.elems.N), interned per source type — see jsvalLiftExpr. */
  readonly jsinHelpers = new Map<string, string>();
  /** Synthetic Map.forEach loop functions, interned per key/value type +
   * callback arity: key → fn name (see lowerMapForEachCall). */
  readonly mapHofHelpers = new Map<string, string>();
  /** Synthetic Set.forEach loop functions, interned per element type +
   * callback arity/return — Map's pattern. */
  readonly setHofHelpers = new Map<string, string>();
  /** Synthetic URLSearchParams.forEach loop functions, interned per
   * callback arity/return — Map's pattern over the sp index walk. */
  readonly spHofHelpers = new Map<string, string>();
  /** The primitive-constructor VALUES (`String`/`Number`/`Boolean` as
   * bare identifiers — CLI option tables store and compare them): one
   * synthesized coercion function per constructor per program, interned
   * here by name so every reference is the SAME zero-capture closure and
   * `opt.type === String` is JS identity (see primitiveCtorClosure). */
  readonly primitiveCtorFns = new Map<string, string>();
  /** Optional-chain lowering state. While a chain body lowers, the guarded
   * receiver NODE reads as a chainRecv (typed by the narrowed arm) instead
   * of re-lowering, its checker type reads non-nullish (typeOf), and the
   * node carrying the ?. token is marked handled so the receiver-typed
   * lowerings stop declining it (chainBlocked). */
  readonly chainRecvByNode = new Map<ts.Node, IrExpr>();
  readonly chainNarrowedType = new Map<ts.Node, ts.Type>();
  readonly chainHandled = new Set<ts.Node>();
  /** for-of-over-matchAll bindings whose `.index` reads the companion-index
   * array: binding SYMBOL → the hidden number[] of match start indices plus
   * the hidden cursor holding THIS iteration's position (registered while
   * the loop body lowers; the property path serves `m.index` as
   * idxs[cur] — computed only at an actual read, so a drain row is never
   * touched for bodies that ignore it). */
  readonly matchAllIndexBindings = new Map<ts.Symbol, { idxsLocalId: string; curLocalId: string }>();
  /** STORED matchAll drains: `const rows = s.matchAll(re)` lowers through
   * matchAllInto with a hidden companion index array, registered here so a
   * later `for (const m of rows)` in the SAME function serves `m.index`
   * (the ctx guard keeps hidden locals out of closures — a cross-function
   * walk falls back to the plain array walk and the fence). */
  readonly matchAllDrainIndexes = new Map<ts.Symbol, { idxsLocalId: string; ctx: FnCtx }>();
  /** STORED numeric value iterators: `const it = numbers.values()` (and
   * the equivalent `[Symbol.iterator]()` spelling) over number[] or a
   * represented typed array has no first-class IR value, so its statically
   * known protocol state lives in hidden source/cursor/done locals. A
   * later for-of in the SAME function reads and advances them.
   * `doneLocalId` is sticky: once next() observes the end, later source
   * changes do not revive the exhausted iterator, exactly like Node. */
  readonly numericIterators = new Map<
    ts.Symbol,
    { sourceLocalId: string; sourceType: IrType; indexLocalId: string; doneLocalId: string; ctx: FnCtx }
  >();
  chainCounter = 0;
  /** Keyed by program-wide qualified class name (what IR object types carry). */
  readonly classes = new Map<string, ClassInfo>();
  readonly classBySymbol = new Map<ts.Symbol, ClassInfo>();
  /** The class whose members are lowering — `super` binds lexically to it
   * (arrows inside methods lower within this window, so they see it too). */
  currentClass: ClassInfo | null = null;
  readonly globalsBySymbol = new Map<ts.Symbol, IrGlobal>();
  /** Expando function members (`foo.bar = 12` on a module-level function
   * or callable const): per function symbol, each written member's module
   * global — string keys for spelled/folded names, ts.Symbols for
   * unique-symbol keys (lower-expando.ts). */
  readonly expandoMembers = new Map<ts.Symbol, Map<string | ts.Symbol, ExpandoMember>>();
  /** CJS export globals ALSO key by their declaration NODE: the checker
   * hands importers a distinct (late-bound) symbol for `module.exports`
   * property exports — different object, same declaration — so globalOf
   * falls back through the shared node (collectGlobals registers both). */
  readonly globalsByDeclNode = new Map<ts.Node, IrGlobal>();
  readonly globalsList: IrGlobal[] = [];
  /** npm-import init statements (--dynamic), keyed by file AND import
   * declaration: the island.import assignments/side-effect loads for that
   * statement. lowerFileInit splices them into the importing file's %init
   * header at the statement's position — Node evaluates each imported
   * module (island packages included) where the import appears, so an
   * `import "polyfill"` before an `import "./app.js"` runs the package
   * top-level BEFORE app's init, not after. */
  readonly npmInitActions = new Map<ts.SourceFile, Map<ts.Statement, IrStmt[]>>();
  /** Per-file %init PRELUDE statements for JSON imports: bakeable DATA
   * assignments with no observable evaluation order of their own —
   * prepended by lowerFileInit so the bindings are live before any
   * top-level statement runs. */
  readonly jsonInitActions = new Map<ts.SourceFile, IrStmt[]>();
  /** The embedded npm runtime graph (collectNpmImports), attached to the
   * emitted module. Null without npm imports or without --dynamic. */
  npmEmbedded: IrModule["embedded"] | null = null;
  npmBuiltins: NpmBuiltinUse[] | null = null;
  npmLazyTraps: NpmLazyTrap[] | null = null;
  /** Dynamic `import("literal")` resolutions, keyed
   * `fileName\u0000specifier` (collectDynamicImports fills it during npm
   * collection; lowerDynamicImportCall reads it per site). */
  readonly dynImports = new Map<string, DynamicImportResolution>();
  /** createRequire-require resolutions of BARE npm specifiers, keyed
   * `fileName\u0000specifier` (collectCreateRequires fills it during npm
   * collection under --dynamic — the require-condition entry key plus its
   * embedded format; lowerCreateRequireCall reads it per site; "" marks a
   * failed resolution already reported at collection). */
  readonly createRequireImports = new Map<string, { entryKey: string; format: "esm" | "cjs" | "json" } | "">();
  /** Module → the name of its synthesized namespace-BUILDER function
   * (lowerOwnModuleImport): every `import()` of the same program module
   * shares one builder. */
  readonly dynNsBuilders = new Map<ts.SourceFile, string>();
  /** Parameters forced to the island-handle type (jsval) regardless of
   * their checker type: then-handler params whose settled value is an
   * engine handle (a dynamic import's namespace object) — paramShape's
   * early-out. */
  readonly jsvalParamOverrides = new Set<ts.ParameterDeclaration>();
  /** File → qualifier prefix: "" for the entry, "%mI." otherwise. */
  readonly fileTag = new Map<ts.SourceFile, string>();
  /** Namespace ModuleBlocks this program lowers, filled by splitFiles:
   * "flattened" — an instantiated namespace whose body joined the file's
   * parts (members resolve statically); "typeOnly" — a skipped
   * non-instantiated one (its only value members are import= aliases,
   * still resolved statically). Ambient blocks never register — their
   * members keep the ReferenceError/fence paths (lower-namespaces.ts). */
  readonly nsBlocks = new Map<ts.Node, "flattened" | "typeOnly">();
  /** File → its %init function name, filled by prepareModuleInits before
   * any body lowers: import headers and inline require statements call
   * dependency inits by these names. */
  readonly initNameOf = new Map<ts.SourceFile, string>();
  /** File → the id of its run-once guard global (a bool module global,
   * false at program start). Every non-entry module gets one: its %init
   * may be called from several importers/requirers, and the guard is what
   * makes each call after the first a Node-style cache hit. The entry has
   * none — %main calls it exactly once (a dependency edge back to the
   * entry would be a fenced cycle). */
  readonly moduleGuardOf = new Map<ts.SourceFile, string>();
  /** Files whose module evaluation is asynchronous: direct top-level
   * await/for-await modules plus their static ESM importers. Their %init
   * bodies run on fibers and every async dependency edge awaits the
   * dependency promise before the importer body starts. Synchronous files
   * stay synchronous — adding even an already-settled await would insert
   * an observable microtask hop. */
  readonly asyncInitFiles = new Set<ts.SourceFile>();
  /** Async module → its cached evaluation-promise global. The emitted
   * spawn wrapper fills this on first evaluation and returns a retained
   * reference on cache hits, matching Node's one ModuleJob promise per
   * module even across diamonds and concurrent dynamic imports. */
  readonly modulePromiseOf = new Map<ts.SourceFile, string>();
  /** Async import-cycle member → the cycle's deterministic graph
   * representative. Used to recognize internal SCC edges; this is NOT
   * necessarily the runtime evaluation root, because a dynamically-only
   * cycle can first be entered through any member. */
  readonly asyncCycleRepresentativeOf = new Map<ts.SourceFile, ts.SourceFile>();
  /** Async import-cycle member → the shared completion-promise global for
   * its SCC. Every member's spawn wrapper temporarily publishes its own
   * promise while eager recursive evaluation unwinds; the outermost
   * wrapper (the member actually requested first at runtime) writes last
   * and therefore becomes the cycle's evaluation root. Dynamic imports
   * wait on this shared verdict rather than a build-time-selected member. */
  readonly asyncCyclePromiseOf = new Map<ts.SourceFile, string>();
  /** Record-shape interner: canonical (name-sorted) field list → shapeId.
   * Threaded into every mapType call; its `shapes` array becomes
   * IrModule.records. */
  readonly shapes = new ShapeRegistry();
  /** Union interner: canonical (typeKey-sorted) arm list → unionId.
   * Threaded into every mapType call; its `unions` array becomes
   * IrModule.unions. An arm's index in the canonical list is its runtime
   * tag. */
  readonly unions = new UnionRegistry();
  /** Context-free successful type mappings. See TypeMapperCtx.typeMemo. */
  readonly typeMemo = new Map<string, IrType>();
  readonly ambient = ambientDtsPath();
  readonly overridesAmbient = overridesDtsPath();
  readonly fallbackAmbient = fallbackDtsPath();
  /** The one mapType context: registries + hooks, assembled in the
   * constructor (typeParamResolver reads the CURRENT instantiation bindings
   * through `this`, so the same ctx serves generic bodies too). */
  readonly typeCtx: TypeMapperCtx;

  readonly stats: LowerStats = {
    statementsTotal: 0,
    statementsFailed: 0,
    statementsIsland: 0,
    functionsSkipped: 0,
  };

  /** Reachability edge sink: every resolution of
   * a reference to a lowerable body reports its name here — recorded even
   * when the enclosing statement later poisons. */
  onEdge: ((name: string) => void) | null = null;

  // Stack of function contexts (bottom = the function being declared at
  // top level, top = the innermost nested function currently lowering).
  fnStack: FnCtx[] = [];
  readonly liftedFns: IrFunction[] = [];
  lambdaCounter = 0;

  /** Statement lists currently mid-lowering, innermost last: the forward-
   * capture machinery (predeclareForwardCapture) needs to know which later
   * statements of an OPEN list a symbol's declaration sits in, which scope
   * frame list-level declarations register into, and where to insert the
   * scope-entry TDZ varDecl (before the statement being lowered). */
  readonly activeStmtLists: {
    stmts: readonly ts.Statement[];
    index: number;
    ctx: FnCtx;
    frame: Map<ts.Symbol, IrLocal>;
    out: IrStmt[];
  }[] = [];
  /** Forward-captured consts pre-declared as TDZ boxes, keyed by symbol:
   * lowerVarDecl consumes the entry when the source declaration arrives and
   * emits the initializing `assign` instead of a fresh declaration. */
  readonly tdzPredeclared = new Map<ts.Symbol, IrLocal>();
  /** Nested function DECLARATIONS lowered eagerly by the forward-hoisting
   * machinery (predeclareForwardFnDecl — a reference above the declaration
   * in the same function, JS's function hoisting): the statement loop skips
   * the source statement when it arrives. */
  readonly hoistedFnDecls = new Set<ts.FunctionDeclaration>();
  /** `var` bindings hoisted to their function root (hoistVarBinding), keyed
   * by the checker's merged symbol — every same-name `var` in one function
   * is one symbol, so one slot. Module-scope vars live in globalsBySymbol
   * instead. */
  readonly hoistedVars = new Map<ts.Symbol, IrLocal>();
  /** Per-file `var` module globals whose type carries an undefined arm:
   * lowerFileInit assigns them the interned undefined right after the
   * run-once guard — JS hoists module vars to `undefined` at entry, so a
   * function called above the declaration statement reads that, never a
   * NULL slot. Filled by collectGlobals. */
  readonly varGlobalEntryInits = new Map<ts.SourceFile, IrGlobal[]>();

  get ctx(): FnCtx {
    const top = this.fnStack[this.fnStack.length - 1];
    if (!top) throw new InternalCompilerError("lowerer bug: no active function context");
    return top;
  }

  get scopes(): Map<ts.Symbol, IrLocal>[] {
    return this.ctx.scopes;
  }

  /** Names of bodies a prior reachability pass reached; null lowers everything. */
  readonly reachable: ReadonlySet<string> | null;
  /** Reachability computed by this same Lowerer when retained worklist IR
   * is assembled directly. The configured reachable set remains null so
   * demand-driven instance lowering keeps its existing gates. */
  reachableForArtifacts: ReadonlySet<string> | null = null;
  /** Coverage remainder mode: the reachability gate inverts (see wantBody)
   * and no module is built. */
  readonly remainder: boolean;
  /** Deferred collection diagnostics (failed signatures/class shapes) by
   * declaration symbol: an unreached declaration must not fail the build,
   * so its diagnostics wait until a reference makes them relevant. */
  readonly deferredDiags = new Map<ts.Symbol, ScrDiagnostic[]>();
  /** Deferred classes by qualified IR name — for flush sites that only
   * know the class name (typed receivers, module class retention). */
  readonly deferredClassByName = new Map<string, ts.Symbol>();
  /** Symbols whose deferred diagnostics THIS pass flushed (handed to the
   * coverage remainder as alreadyFlushed). */
  readonly flushedSymbols = new Set<ts.Symbol>();
  readonly alreadyFlushed: ReadonlySet<ts.Symbol>;
  /** The build's target platform ("win32" | "darwin" | "linux" | ...):
   * selects the platform-keyed builtin surfaces (builtinModuleFnsOf /
   * builtinModuleConstOf in surfaces.ts). */
  readonly targetPlatform: string;
  /** LowererMode.startupCrash — buildMain opens %main with the throw. */
  readonly startupCrash: StartupCrash | null;
  /** Outbound native bindings by their source-level ambient name. */
  readonly ffiImports: readonly IrFfiImport[];
  readonly libraryCallbacks: boolean;
  readonly ffiImportsByName: ReadonlyMap<string, IrFfiImport>;
  /** Non-null after whole-program FFI declaration validation. */
  readonly ffiBindingSymbols: ReadonlyMap<string, ReadonlySet<ts.Symbol>> | null;
  /** Exact specifier mappings and their reverse declaration-file lookup. */
  readonly externalTypes: ReadonlyMap<string, string>;
  readonly externalTypeSpecifiersByFile: ReadonlyMap<string, readonly string[]>;
  /** Symbols a POISONED declaration statement would have bound: the
   * declaration's own diagnostic is already recorded, and no local/global
   * registered, so later references fall through every resolution step —
   * the fallthroughs report the inherited-blocker cascade (SC2004)
   * instead of misattributing the reference. */
  readonly blockedBindings = new Set<ts.Symbol>();
  /** True while collectProgram runs: resolution helpers must not flush
   * deferred diagnostics (collection itself resolves symbols — extends
   * clauses — and collection order must not decide what reports). */
  collecting = false;
  /** Non-null redirects pushDiag into a capture buffer (the deferred
   * collection wrapper). */
  diagSink: ScrDiagnostic[] | null = null;
  /** Diagnostics converted into runtimeFence statements (JS sources —
   * see lowerStmts): off the build, preserved here so coverage reporting
   * can still name every deferred fence. */
  readonly runtimeFences: ScrDiagnostic[] = [];
  /** --provenance-sources: diagnostics of ELIDED pure-annotated dead
   * consts in fetched source modules (lowerStmts's elision rule) — off
   * the build entirely (the statement lowers to its poisoned bindings and
   * nothing throws), preserved for the coverage report's provenance
   * section. */
  readonly provenanceElided: ScrDiagnostic[] = [];
  /** --provenance-sources: per-file statement attribution (mirrors the
   * stats counters, keyed by fileName) so the coverage report can answer
   * "did the PACKAGE's statements compile static?" per provenance
   * package. Only populated while the registry is active; the remainder
   * pass skips it (attribution describes the build). */
  readonly statsByFile = new Map<string, { total: number; failed: number; island: number }>();

  /** Bumps the per-file attribution counter (no-op unless provenance is
   * active and this is the emit/discovery lane — mirror the CALLER's
   * suppressStats guard, this method only gates remainder). */
  bumpFileStat(file: string, kind: "total" | "failed" | "island"): void {
    if (this.remainder || !provenanceActive()) return;
    let s = this.statsByFile.get(file);
    if (!s) this.statsByFile.set(file, (s = { total: 0, failed: 0, island: 0 }));
    s[kind]++;
  }

  constructor(
    readonly program: ts.Program,
    readonly entry: ts.SourceFile,
    readonly moduleOrder: ts.SourceFile[],
    readonly dynamic: boolean,
    mode: LowererMode = {},
  ) {
    this.reachable = mode.reachable ?? null;
    this.remainder = mode.remainder ?? false;
    this.alreadyFlushed = mode.alreadyFlushed ?? new Set();
    this.targetPlatform = mode.targetPlatform ?? process.platform;
    this.startupCrash = mode.startupCrash ?? null;
    this.ffiImports = mode.ffiImports ?? [];
    this.libraryCallbacks = mode.libraryCallbacks ?? false;
    this.ffiImportsByName = new Map(this.ffiImports.map((entry) => [entry.name, entry]));
    this.ffiBindingSymbols = mode.ffiBindingSymbols ?? null;
    this.externalTypes = mode.externalTypes ?? new Map();
    this.externalTypeSpecifiersByFile = mode.externalTypeSpecifiersByFile ??
      directExternalTypeSpecifiersByFile(this.externalTypes);
    this.checker = program.getTypeChecker();
    this.typeCtx = {
      checker: this.checker,
      shapes: this.shapes,
      unions: this.unions,
      classNamer: this.classNamer,
      resolveTypeParam: this.typeParamResolver,
      resolveTypeParamTs: this.typeParamTsResolver,
      genericClassInstance: (decl, ref) => this.genericClassInstanceType(decl, ref),
      mixinClassInstance: (decl) =>
        this.mixinTypeContext && this.mixinTypeContext.classNode === decl
          ? { kind: "object", className: this.mixinTypeContext.className }
          : null,
      mixinIntersectionInstance: (widened) => mixinIntersectionInstanceType(this, widened),
      isStdlibFile: this.isStdlibFile,
      isNpmFile: this.isNpmFile,
      isExternalTypeFile: (sf) =>
        this.externalTypeSpecifiersByFile.has(tsgoPath(resolve(sf.fileName))),
      dynamic: this.dynamic,
      typeMemo: this.typeMemo,
      canMemoizeType: () =>
        this.typeParamBindings === null &&
        this.typeParamTsBindings === null &&
        this.mixinTypeContext === null,
      // fileTag is filled just below; the hook is only ever CALLED during
      // lowering, long after the constructor completes.
      isProgramFile: (sf) => this.fileTag.has(sf),
    };
    // --dynamic: modules reachable only through dynamic import() joined
    // moduleOrder BEFORE any pass constructed — lowerToIr runs
    // appendDynamicImportModules once on the shared array (a per-pass run
    // here would repeatedly extend the graph and duplicate cycle reports).
    this.moduleOrder.forEach((sf, i) => {
      this.fileTag.set(sf, sf === entry ? "" : `%m${i}.`);
    });
    if (this.moduleOrder.length === 0) this.fileTag.set(entry, "");
    this.registerBuiltinErrorClasses();
    registerBuiltinEmitterClass(this);
    registerBuiltinStreamClasses(this);
  }

  registerBuiltinErrorClasses(): void {
    return registerBuiltinErrorClasses(this);
  }

  builtinErrorInfoOf(symbol: ts.Symbol | null | undefined): ClassInfo | null {
    return builtinErrorInfoOf(this, symbol);
  }

  builtinEmitterInfoOf(symbol: ts.Symbol | null | undefined): ClassInfo | null {
    return builtinEmitterInfoOf(this, symbol);
  }

  builtinStreamInfoOf(symbol: ts.Symbol | null | undefined): ClassInfo | null {
    return builtinStreamInfoOf(this, symbol);
  }

  /** Program-wide qualified name for a top-level declaration. */
  qualify(sf: ts.SourceFile, name: string): string {
    return `${this.fileTag.get(sf) ?? ""}${name}`;
  }

  /** The IR name mapType gives class instance types — must agree with
   * collectClassShape's registration. Namespace-nested classes carry the
   * namespace path (nsPathPrefix), so `namespace A { export class C }`
   * and a top-level `class C` never collide. Class EXPRESSIONS name by
   * SOURCE POSITION (`%cx<start>.<name>`): deterministic across the
   * builds (no counter can drift between invocations),
   * program-unique through the file qualifier, and collision-free with
   * user identifiers ('%'). */
  readonly classNamer = (decl: ts.ClassLikeDeclaration): string =>
    ts.isClassExpression(decl)
      ? this.qualify(decl.getSourceFile(), `%cx${decl.getStart()}.${decl.name?.text ?? ""}`)
      : this.qualify(decl.getSourceFile(), nsPathPrefix(decl) + (decl.name ? decl.name.text : "%anon"));

  /** Follows import aliases to the original declaration's symbol. Every
   * value reference resolves through here, so it doubles as the flush
   * point for deferred collection diagnostics: resolving a reference to a
   * broken declaration reports what collection deferred. */
  resolveValueSymbol(ident: ts.Identifier): ts.Symbol | null {
    let symbol = this.checker.getSymbolAtLocation(ident);
    // A shorthand property's NAME resolves to the property symbol; the
    // VALUE binding it reads is the checker's shorthand-value symbol
    // (the option-object parsers lower `{ cwd }` through the identifier).
    if (ident.parent && ts.isShorthandPropertyAssignment(ident.parent) && ident.parent.name === ident) {
      symbol = this.checker.getShorthandAssignmentValueSymbol(ident.parent) ?? symbol;
    }
    // tsgo synthesizes no expando symbol at a CJS MEMBER-EXPORT use site
    // (`common.GREETING` where the exporter attached GREETING with
    // `module.exports.GREETING = ...` — 5.9.3 answered the expando
    // property symbol here), but the exporter's MODULE symbol still
    // carries the member in its exports table; resolve through it so both
    // ends of the export key one symbol identity, like 5.9.3's.
    if (!symbol && ident.parent && ts.isPropertyAccessExpression(ident.parent) && ident.parent.name === ident) {
      const recv = ident.parent.expression;
      if (ts.isIdentifier(recv) && this.cjsLocalModuleBindingOf(recv)) {
        const recvSym = this.checker.getSymbolAtLocation(recv);
        const recvDecls = recvSym ? this.checker.declarationsOf(recvSym) : [];
        const recvDecl = recvDecls.find(ts.isImportClause) ?? recvDecls[0];
        if (recvDecl && ts.isVariableDeclaration(recvDecl) && recvDecl.initializer) {
          const spec = requireSpecOf(recvDecl.initializer);
          const dep =
            spec === null
              ? null
              : isRelativeSpecifier(spec)
                ? resolveImport(this.program, recvDecl.getSourceFile(), spec)
                : npmStaticDepSf7(this.program, recvDecl.getSourceFile(), spec);
          if (dep) symbol = this.cjsModuleExportSymbol(dep, ident.text);
        } else if (recvDecl && ts.isImportClause(recvDecl)) {
          // The DEFAULT-import spelling of the same binding: the dep is
          // the import declaration's resolved CJS module.
          const dep = this.cjsDefaultImportDepOf(recvDecl);
          if (dep) symbol = this.cjsModuleExportSymbol(dep, ident.text);
        }
      }
    }
    if (!symbol) return null;
    // Bare references across MERGED-namespace blocks fence here (Node's
    // transform throws ReferenceError where tsc's emit would qualify —
    // lower-namespaces.ts); a no-op for programs without namespaces.
    fenceCrossBlockNsRef(this, ident, symbol);
    if (symbol.flags & ts.SymbolFlags.Alias) {
      // SNAPSHOT aliases own storage keyed by the PRE-alias symbol
      // (`import x = N.y` of a mutable target — collectGlobals): the
      // reference reads the snapshot, never the live target, exactly like
      // Node's emitted `var x = N.y`. Only those aliases register this
      // way; every other alias resolves through to its declaration.
      if (this.globalsBySymbol.has(symbol)) {
        this.flushDeferred(symbol);
        return symbol;
      }
      // DEFAULT-SNAPSHOT storage lives on the EXPORTER'S default alias
      // symbol (`export default someLet` — collectGlobals registers the
      // Node-semantics snapshot there). getAliasedSymbol would resolve
      // PAST it to the live let; walk the default-import hops and stop at
      // the first default symbol carrying storage instead.
      const snap = this.defaultSnapshotSymbolOf(symbol);
      if (snap) {
        this.flushDeferred(snap);
        return snap;
      }
      symbol = this.checker.getAliasedSymbol(symbol);
    }
    // CommonJS export plumbing: a binding that resolved to a PROPERTY of a
    // top-level `module.exports = { ... }` literal (shorthand, or a plain
    // identifier value — renames included) re-resolves to the local
    // declaration the property references. The export table is then pure
    // alias plumbing, exactly like an ESM export list: importers land on
    // the original function/const/class symbols and every existing
    // registry (globals, fn signatures, classes) applies unchanged.
    const cjsValue = this.cjsExportValueSymbol(symbol);
    if (cjsValue) symbol = cjsValue;
    this.flushDeferred(symbol);
    return symbol;
  }

  /** The configured external host module owning an expression's runtime
   * value, or null. Alias chains are followed to their declaration file so
   * direct imports and local re-export facades classify identically. Type
   * references never call this helper and remain ordinary checker input. */
  externalTypeSpecifierOf(expr: ts.Expression): string | null {
    if (this.externalTypes.size === 0) return null;

    let value: ts.Expression = expr;
    while (
      ts.isParenthesizedExpression(value) ||
      ts.isAsExpression(value) ||
      ts.isTypeAssertion(value) ||
      ts.isNonNullExpression(value)
    ) {
      value = value.expression;
    }
    if (ts.isCallExpression(value)) {
      if (value.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const spec = value.arguments[0];
        return spec !== undefined && ts.isStringLiteralLike(spec) && this.externalTypes.has(spec.text)
          ? spec.text
          : null;
      }
      if (
        ts.isIdentifier(value.expression) &&
        value.expression.text === "require" &&
        value.arguments.length === 1
      ) {
        const spec = value.arguments[0]!;
        if (ts.isStringLiteralLike(spec) && this.externalTypes.has(spec.text)) return spec.text;
      }
      return this.externalTypeSpecifierOf(value.expression);
    }
    if (ts.isNewExpression(value)) return this.externalTypeSpecifierOf(value.expression);
    if (ts.isTaggedTemplateExpression(value)) {
      return this.externalTypeSpecifierOf(value.tag);
    }
    if (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) {
      // Follow the runtime RECEIVER, not the property's declaration: a
      // project-owned record may use an interface declared by the mapped
      // file and remains ordinary static data (`const x: HostType = ...;
      // x.field`). Only a value rooted in the imported module is external.
      const receiver = this.externalTypeSpecifierOf(value.expression);
      if (receiver !== null) return receiver;
      const member = ts.isPropertyAccessExpression(value)
        ? value.name.text
        : value.argumentExpression !== undefined && ts.isStringLiteralLike(value.argumentExpression)
          ? value.argumentExpression.text
          : null;
      return member !== null
        ? this.externalTypeSpecifierOfNamespaceMember(value.expression, member)
        : null;
    }
    if (!ts.isIdentifier(value)) return null;
    return this.externalTypeSpecifierOfSymbol(this.checker.getSymbolAtLocation(value));
  }

  /** The source file a checker-resolved module-specifier node names. The
   * checker path covers package.json aliases as well as relative imports;
   * resolveImport is the fallback for the latter. */
  private moduleSourceFileOf(from: ts.SourceFile, spec: ts.StringLiteral): ts.SourceFile | null {
    const moduleSymbol = this.checker.getSymbolAtLocation(spec);
    for (const decl of moduleSymbol ? this.checker.declarationsOf(moduleSymbol) : []) {
      if (ts.isSourceFile(decl)) return decl;
    }
    return isRelativeSpecifier(spec.text) ? resolveImport(this.program, from, spec.text) : null;
  }

  /** Follow one project-module export through the checker's resolved export
   * table, then recover its exact external route where alias declarations
   * retain one. */
  private externalTypeSpecifierOfModuleExport(
    sf: ts.SourceFile,
    exportName: string,
    seenSymbols: Set<ts.Symbol>,
    seenExports: Set<string>,
  ): string | null {
    const exportKey = `${tsgoPath(resolve(sf.fileName))}\0${exportName}`;
    if (seenExports.has(exportKey)) return null;
    seenExports.add(exportKey);
    // Ask the checker which symbol the module ACTUALLY exports under this
    // name. Syntax-only `export *` scanning cannot answer shadowing: a local
    // or explicit export wins over a same-named star export, and a star
    // contributes only names its target really exports. The resolved symbol
    // retains route-aware ExportSpecifier/NamespaceExport declarations for
    // exact mappings, while star exports resolve to the mapped declaration
    // owner through externalTypeSpecifiersByFile.
    const moduleSymbol = this.checker.getSymbolAtLocation(sf);
    const exported = moduleSymbol?.getExports().get(exportName as ts.__String);
    return this.externalTypeSpecifierOfSymbol(exported, seenSymbols, seenExports);
  }

  private externalTypeSpecifierOfNamespaceMember(expr: ts.Expression, member: string): string | null {
    let value = expr;
    while (
      ts.isParenthesizedExpression(value) ||
      ts.isAsExpression(value) ||
      ts.isTypeAssertion(value) ||
      ts.isNonNullExpression(value)
    ) {
      value = value.expression;
    }
    if (!ts.isIdentifier(value)) return null;
    const symbol = this.checker.getSymbolAtLocation(value);
    const namespaceDecl = symbol
      ? this.checker.declarationsOf(symbol).find(ts.isNamespaceImport)
      : undefined;
    if (namespaceDecl === undefined) return null;
    const importDecl = namespaceDecl.parent.parent;
    if (!ts.isImportDeclaration(importDecl) || !ts.isStringLiteral(importDecl.moduleSpecifier)) return null;
    if (this.externalTypes.has(importDecl.moduleSpecifier.text)) return importDecl.moduleSpecifier.text;
    const dep = this.moduleSourceFileOf(importDecl.getSourceFile(), importDecl.moduleSpecifier);
    return dep !== null && !dep.isDeclarationFile
      ? this.externalTypeSpecifierOfModuleExport(dep, member, new Set(), new Set())
      : null;
  }

  private externalTypeSpecifierOfSymbol(
    symbol: ts.Symbol | undefined,
    seenSymbols: Set<ts.Symbol> = new Set(),
    seenExports: Set<string> = new Set(),
  ): string | null {
    if (symbol === undefined || seenSymbols.has(symbol)) return null;
    seenSymbols.add(symbol);
    const declarations = this.checker.declarationsOf(symbol);

    // Route-aware alias hops run before declaration-file ownership. An
    // exact import must keep the specifier it actually named, rather than
    // inheriting whichever alias happened to register the shared file last.
    for (const decl of declarations) {
      let specNode: ts.Expression | undefined;
      let importedName: string | null = null;
      if (ts.isImportSpecifier(decl)) {
        const importDecl: ts.Node = decl.parent.parent.parent;
        if (ts.isImportDeclaration(importDecl)) specNode = importDecl.moduleSpecifier;
        importedName = (decl.propertyName ?? decl.name).text;
      } else if (ts.isImportClause(decl)) {
        if (ts.isImportDeclaration(decl.parent)) specNode = decl.parent.moduleSpecifier;
        importedName = "default";
      } else if (ts.isNamespaceImport(decl)) {
        const importDecl: ts.Node = decl.parent.parent;
        if (ts.isImportDeclaration(importDecl)) specNode = importDecl.moduleSpecifier;
        importedName = null;
      } else if (ts.isExportSpecifier(decl)) {
        const exportDecl: ts.Node = decl.parent.parent;
        if (ts.isExportDeclaration(exportDecl)) specNode = exportDecl.moduleSpecifier;
        importedName = (decl.propertyName ?? decl.name).text;
      } else if (ts.isNamespaceExport(decl)) {
        const exportDecl: ts.Node = decl.parent;
        if (ts.isExportDeclaration(exportDecl)) specNode = exportDecl.moduleSpecifier;
        importedName = "*";
      } else {
        continue;
      }
      if (specNode === undefined || !ts.isStringLiteral(specNode)) continue;
      if (this.externalTypes.has(specNode.text)) return specNode.text;
      // A namespace OBJECT from a project module is not wholly external;
      // property accesses resolve their selected member separately above.
      if (importedName === null) return null;
      const dep = this.moduleSourceFileOf(decl.getSourceFile(), specNode);
      return dep !== null && !dep.isDeclarationFile
        ? this.externalTypeSpecifierOfModuleExport(dep, importedName, seenSymbols, seenExports)
        : null;
    }

    for (const decl of declarations) {
      const owners = this.externalTypeSpecifiersByFile.get(
        tsgoPath(resolve(decl.getSourceFile().fileName)),
      );
      if (owners !== undefined && owners.length > 0) return owners[0]!;
    }
    if ((symbol.flags & ts.SymbolFlags.Alias) === 0) return null;
    return this.externalTypeSpecifierOfSymbol(
      this.checker.getAliasedSymbol(symbol),
      seenSymbols,
      seenExports,
    );
  }

  /** The default-snapshot storage symbol a DEFAULT-import alias chain
   * lands on, or null. A mutable entity-name default (`export default
   * someLet`) registers its Node-semantics snapshot global under the
   * exporter's default ALIAS symbol; the checker's getAliasedSymbol
   * resolves through that symbol to the live let, so this walk follows
   * the default hops syntactically — default import clauses, `{ default
   * as x }` specifiers, `export { default } from` re-exports — and stops
   * at the first default symbol carrying registered storage. Local
   * `export { x as default }` specifiers (no module specifier) are LIVE
   * bindings in Node and fall through to ordinary alias resolution. */
  private defaultSnapshotSymbolOf(alias: ts.Symbol): ts.Symbol | null {
    let sym: ts.Symbol | undefined = alias;
    for (let hop = 0; sym !== undefined && hop < 32; hop++) {
      if (hop > 0 && sym.flags & ts.SymbolFlags.Alias && this.globalsBySymbol.has(sym)) return sym;
      const d = this.checker
        .declarationsOf(sym)
        .find((x) => ts.isImportClause(x) || ts.isImportSpecifier(x) || ts.isExportSpecifier(x));
      let spec: ts.Expression | undefined;
      let name: string | undefined;
      if (d && ts.isImportClause(d) && ts.isImportDeclaration(d.parent)) {
        spec = d.parent.moduleSpecifier;
        name = "default";
      } else if (d && ts.isImportSpecifier(d)) {
        const idecl: ts.Node = d.parent.parent.parent;
        if (ts.isImportDeclaration(idecl)) spec = idecl.moduleSpecifier;
        name = (d.propertyName ?? d.name).text;
      } else if (d && ts.isExportSpecifier(d)) {
        const edecl: ts.Node = d.parent.parent;
        if (ts.isExportDeclaration(edecl)) spec = edecl.moduleSpecifier;
        name = (d.propertyName ?? d.name).text;
      }
      if (d === undefined || spec === undefined || !ts.isStringLiteral(spec) || name !== "default") return null;
      const dep = resolveImport(this.program, d.getSourceFile(), spec.text);
      if (!dep) return null;
      sym = defaultExportSymbolOf(this, dep) ?? undefined;
    }
    return null;
  }

  /** A module's CJS export-table member symbol by NAME (the checker's
   * module-symbol exports map — present in tsgo even where no expando
   * property symbol exists at the attachment/use sites). */
  cjsModuleExportSymbol(sf: ts.SourceFile, name: string): ts.Symbol | undefined {
    const moduleSym = this.checker.getSymbolAtLocation(sf);
    return moduleSym?.getExports().get(name as ts.__String);
  }

  /** The local VALUE symbol behind a CJS export-table property symbol —
   * see resolveValueSymbol. Null when `symbol` is not such a property (or
   * the property's value is not a plain identifier reference). */
  private cjsExportValueSymbol(symbol: ts.Symbol): ts.Symbol | null {
    const d = this.checker.declarationsOf(symbol)[0];
    if (!d) return null;
    // MEMBER-form class exports (`exports.C = C` — commander's error.js):
    // alias plumbing exactly like a table entry, so importers land on the
    // class declaration and the class registry applies unchanged (a class
    // VALUE global would fence — builtin-derived classes have no
    // first-class value form). Only CLASS targets re-resolve this way;
    // every other member export keeps its snapshot storage semantics.
    const memberClass = this.cjsMemberExportClassSymbol(d);
    if (memberClass) return memberClass;
    const isShorthand = ts.isShorthandPropertyAssignment(d);
    const isIdentProp = ts.isPropertyAssignment(d) && ts.isIdentifier(d.initializer);
    if (!isShorthand && !isIdentProp) return null;
    if (!ts.isObjectLiteralExpression(d.parent) || !isCjsExportTableLiteral(d.parent)) return null;
    let value = isShorthand
      ? this.checker.getShorthandAssignmentValueSymbol(d)
      : this.checker.getSymbolAtLocation((d as ts.PropertyAssignment).initializer as ts.Identifier);
    if (!value) return null;
    if (value.flags & ts.SymbolFlags.Alias) value = this.checker.getAliasedSymbol(value);
    return value;
  }

  /** The CLASS symbol a member-form CJS export declaration forwards to:
   * `d` (an export property symbol's declaration) sits in a top-level
   * `exports.C = <ident>` / `module.exports.C = <ident>` statement of a
   * JS module, the statement is not discarded by a later table, and the
   * identifier resolves to a class declaration. Null otherwise. */
  cjsMemberExportClassSymbol(d: ts.Node): ts.Symbol | null {
    const assign = ts.isBinaryExpression(d)
      ? d
      : ts.isPropertyAccessExpression(d) && d.parent !== undefined && ts.isBinaryExpression(d.parent)
        ? d.parent
        : null;
    if (!assign || assign.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return null;
    if (!ts.isIdentifier(assign.right)) return null;
    const stmt = assign.parent;
    if (!stmt || !ts.isExpressionStatement(stmt) || !ts.isSourceFile(stmt.parent)) return null;
    if (!isJsSourceFile(stmt.parent)) return null;
    const cjs = cjsExportAssignmentOf(stmt);
    if (cjs?.kind !== "member" || cjs.expr !== assign) return null;
    if (cjsExportDiscardReason(stmt) !== null) return null;
    let value = this.checker.getSymbolAtLocation(assign.right);
    if (!value) return null;
    if (value.flags & ts.SymbolFlags.Alias) value = this.checker.getAliasedSymbol(value);
    const isClass = this.checker
      .declarationsOf(value)
      .some((decl) => ts.isClassDeclaration(decl));
    return isClass ? value : null;
  }

  /** The CommonJS JS module a DEFAULT-import binding's declaration loads
   * (`import d from "./lib.cjs"`), or null: Node's ESM-CJS interop binds
   * the default to module.exports — exactly a require binding — so those
   * bindings ride the CJS namespace machinery below. ESM dependencies
   * (any .ts, ESM-syntax .js/.mjs) answer null and keep the ESM default
   * machinery. */
  private cjsDefaultImportDepOf(clause: ts.ImportClause): ts.SourceFile | null {
    const importDecl = clause.parent;
    if (!ts.isImportDeclaration(importDecl) || !ts.isStringLiteral(importDecl.moduleSpecifier)) {
      return null;
    }
    const spec = importDecl.moduleSpecifier.text;
    // Bare specifiers resolve only for opted-in --npm-static packages —
    // their CJS entries take the same default-binding interop as a
    // relative require; every other bare import answers null and keeps
    // its own machinery.
    const dep = isRelativeSpecifier(spec)
      ? resolveImport(this.program, importDecl.getSourceFile(), spec)
      : npmStaticDepSf7(this.program, importDecl.getSourceFile(), spec);
    if (!dep || !isJsSourceFile(dep) || isNodeEsmFile(dep)) return null;
    return dep;
  }

  /** True when `expr` is an identifier bound by a top-level
   * `const x = require("./local")` of a RELATIVE module — the CommonJS
   * namespace binding — or of a bare specifier naming an opted-in
   * --npm-static package (its CJS entry is a program module, so the
   * binding is the same namespace over the same export table), or by a
   * DEFAULT import of a CommonJS JS module (`import d from "./lib.cjs"`:
   * Node binds d to module.exports, the same value require answers).
   * Member accesses on it resolve through the export table (property
   * symbols → resolveValueSymbol); the bare value keeps the
   * namespace-object fence, like ESM namespace imports of builtins. */
  cjsLocalModuleBindingOf(expr: ts.Expression): boolean {
    if (!ts.isIdentifier(expr)) return false;
    const sym = this.checker.getSymbolAtLocation(expr);
    const decls = sym ? this.checker.declarationsOf(sym) : [];
    const decl = decls.find(ts.isImportClause) ?? decls[0];
    if (!decl) return false;
    if (ts.isImportClause(decl)) {
      if (decl.name === undefined || this.cjsDefaultImportDepOf(decl) === null) return false;
    } else {
      if (!ts.isVariableDeclaration(decl) || !ts.isIdentifier(decl.name) || !decl.initializer) {
        return false;
      }
      const spec = requireSpecOf(decl.initializer);
      if (spec === null) return false;
      if (
        !isRelativeSpecifier(spec) &&
        npmStaticDepSf7(this.program, decl.getSourceFile(), spec) === null
      ) {
        return false;
      }
    }
    // SINGLE-VALUE exporters (`module.exports = Countdown` / `= double` /
    // `= 42`): the requirer's binding IS the exported value, not a
    // namespace over an export table — the alias resolves straight to the
    // class/function/const declaration (or the scalar export= statement)
    // and every ordinary identifier path applies (new, calls, bare value).
    // Exported-const TABLES (a VariableDeclaration whose initializer is
    // the object literal) keep the namespace reading — member accesses
    // resolve through the table's property symbols.
    if (sym && sym.flags & ts.SymbolFlags.Alias) {
      const d = this.checker.declarationsOf(this.checker.getAliasedSymbol(sym))[0];
      if (d && (ts.isClassDeclaration(d) || ts.isFunctionDeclaration(d))) return false;
      if (d && ts.isVariableDeclaration(d)) {
        let init = d.initializer;
        while (init && ts.isParenthesizedExpression(init)) init = init.expression;
        if (!init || !ts.isObjectLiteralExpression(init)) return false;
      }
      // The scalar-literal export= symbol declares AT the `module.exports
      // =` statement itself; table/Proxy replacements share that
      // declaration node, so only scalar RHS reads as a single value.
      if (d && ts.isBinaryExpression(d)) {
        let r: ts.Expression = d.right;
        while (ts.isParenthesizedExpression(r)) r = r.expression;
        const scalar =
          ts.isNumericLiteral(r) || ts.isStringLiteral(r) || ts.isNoSubstitutionTemplateLiteral(r) ||
          r.kind === ts.SyntaxKind.TrueKeyword || r.kind === ts.SyntaxKind.FalseKeyword ||
          (ts.isPrefixUnaryExpression(r) && r.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(r.operand));
        if (scalar) return false;
      }
    }
    return true;
  }

  /** Assignment-target resolution: a function local (possibly captured) or
   * a module global. tsc has already rejected writes to consts. */
  resolveWritable(ident: ts.Identifier): IrLocal | null {
    const local = this.resolveLocal(ident);
    if (local?.type.kind === "caught") {
      // tsc admits writes (the binding types as `unknown`), but the
      // snapshot is read-only by design — bind a new local instead.
      this.unsupported("SC1090", ident, "assignments to catch bindings");
    }
    if (local) return local;
    const g = this.globalOf(ident);
    if (g) return g;
    return null;
  }

  fnSigOf(ident: ts.Identifier): FnSig | null {
    const symbol = this.resolveValueSymbol(ident);
    return symbol ? (this.fnSigsBySymbol.get(symbol) ?? null) : null;
  }

  globalOf(ident: ts.Identifier): IrGlobal | null {
    const symbol = this.resolveValueSymbol(ident);
    if (!symbol) return null;
    const g = this.globalsBySymbol.get(symbol);
    if (g) return g;
    for (const d of this.checker.declarationsOf(symbol)) {
      const byDecl = this.globalsByDeclNode.get(d);
      if (byDecl) return byDecl;
    }
    return null;
  }

  splitFiles(): FileParts[] {
    return splitFiles(this);
  }

  collectProgram(parts: FileParts[]): void {
    return collectProgram(this, parts);
  }

  /** Names every file's %init and registers the run-once guard globals
   * (EVERY module, the entry included: an admissible import cycle can
   * close back on the entry, whose init call must be the cache hit Node's
   * revisit is — not a recursion) BEFORE any body lowers: function bodies
   * and init bodies alike may contain require statements that lower to
   * calls of these names. Runs in every pass so the ids are
   * deterministic. */
  prepareModuleInits(parts: FileParts[]): void {
    parts.forEach((fp, i) => this.initNameOf.set(fp.sf, `%init.${i}`));
    for (const fp of parts) {
      const rawTag = this.fileTag.get(fp.sf) ?? "";
      const tag = rawTag === "" ? "e." : rawTag.replace(/^%/, "");
      // '%' cannot appear in a user identifier, so the id can never
      // collide with a collected module global of the same file.
      const id = `%g.${tag}%loaded`;
      this.moduleGuardOf.set(fp.sf, id);
      this.globalsList.push({ id, name: "%loaded", type: BOOL, mutable: true });
    }

    // A module is intrinsically async when an await/for-await occurs
    // outside every nested function-like boundary. Then propagate that
    // status backwards through STATIC ESM edges: Node does not start an
    // importer's body until each async dependency has completed. CJS
    // import/require edges deliberately do not propagate — Node refuses
    // require(esm) when the graph contains top-level await, and the call
    // sites below keep that as a named unsupported boundary.
    for (const fp of parts) {
      let found = false;
      ts.walkPreorder(fp.sf, (node) => {
        if (node !== fp.sf && ts.isFunctionLike(node)) return "skip";
        if (
          ts.isAwaitExpression(node) ||
          (ts.isForOfStatement(node) && node.awaitModifier !== undefined)
        ) {
          found = true;
          return "stop";
        }
        return undefined;
      });
      if (found) this.asyncInitFiles.add(fp.sf);
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const fp of parts) {
        if (this.asyncInitFiles.has(fp.sf) || !isNodeEsmFile(fp.sf)) continue;
        if (orderedImportsOf(this.program, fp.sf).some(({ dep }) => dep !== null && this.asyncInitFiles.has(dep))) {
          this.asyncInitFiles.add(fp.sf);
          changed = true;
        }
      }
    }
    for (const fp of parts) {
      if (!this.asyncInitFiles.has(fp.sf)) continue;
      const rawTag = this.fileTag.get(fp.sf) ?? "";
      const tag = rawTag === "" ? "e." : rawTag.replace(/^%/, "");
      const id = `%g.${tag}%initPromise`;
      this.modulePromiseOf.set(fp.sf, id);
      this.globalsList.push({
        id,
        name: "%initPromise",
        type: { kind: "promise", inner: VOID },
        mutable: true,
      });
    }

    const orderIndex = new Map(parts.map((fp, i) => [fp.sf, i] as const));
    const partSet = new Set(parts.map((fp) => fp.sf));
    const staticDeps = (sf: ts.SourceFile): ts.SourceFile[] =>
      orderedImportsOf(this.program, sf)
        .map(({ dep }) => dep)
        .filter((dep): dep is ts.SourceFile => dep !== null && dep !== sf && partSet.has(dep));

    // Tarjan SCCs over the same static graph. The last postorder member is
    // a deterministic COMPONENT representative for internal-edge tests
    // and global naming. The runtime evaluation root can differ: a cycle
    // reached only through import() starts at whichever member is actually
    // requested first, not whichever import() site preflight discovered
    // first. The shared cycle-promise slot below is filled by the emitted
    // spawn wrappers so it records that runtime choice.
    let nextIndex = 0;
    const indexOf = new Map<ts.SourceFile, number>();
    const lowOf = new Map<ts.SourceFile, number>();
    const stack: ts.SourceFile[] = [];
    const onStack = new Set<ts.SourceFile>();
    const visit = (sf: ts.SourceFile): void => {
      const at = nextIndex++;
      indexOf.set(sf, at);
      lowOf.set(sf, at);
      stack.push(sf);
      onStack.add(sf);
      for (const dep of staticDeps(sf)) {
        if (!indexOf.has(dep)) {
          visit(dep);
          lowOf.set(sf, Math.min(lowOf.get(sf)!, lowOf.get(dep)!));
        } else if (onStack.has(dep)) {
          lowOf.set(sf, Math.min(lowOf.get(sf)!, indexOf.get(dep)!));
        }
      }
      if (lowOf.get(sf) !== indexOf.get(sf)) return;
      const component: ts.SourceFile[] = [];
      for (;;) {
        const member = stack.pop()!;
        onStack.delete(member);
        component.push(member);
        if (member === sf) break;
      }
      if (component.length < 2 || !component.some((member) => this.asyncInitFiles.has(member))) return;
      const root = component.reduce((a, b) => orderIndex.get(a)! > orderIndex.get(b)! ? a : b);
      const rawTag = this.fileTag.get(root) ?? "";
      const tag = rawTag === "" ? "e." : rawTag.replace(/^%/, "");
      const cyclePromiseId = `%g.${tag}%cyclePromise`;
      this.globalsList.push({
        id: cyclePromiseId,
        name: "%cyclePromise",
        type: { kind: "promise", inner: VOID },
        mutable: true,
      });
      for (const member of component) {
        if (this.asyncInitFiles.has(member)) {
          this.asyncCycleRepresentativeOf.set(member, root);
          this.asyncCyclePromiseOf.set(member, cyclePromiseId);
        }
      }
    };
    for (const fp of parts) if (!indexOf.has(fp.sf)) visit(fp.sf);
  }

  /** The lowering of a CommonJS `require("./local")` occurrence: a call of
   * the required module's run-once %init at exactly this statement's
   * position — Node's inline evaluation, with the guard supplying the
   * cache-hit behavior for every require after the first. Bare specifiers
   * naming an opted-in --npm-static package resolve to that package's
   * program entry (the same edge preflight admitted — bundle dists require
   * their external dependencies by name). Null for everything else
   * (builtins load nothing; the rest kept its preflight fence). */
  requireInitStmt(spec: string, node: ts.Node): IrStmt | null {
    // Relative requires resolve within the program; a BARE require can be
    // a program-module edge too when it names an opted-in --npm-static
    // package (one package requiring another — the resolution answered
    // its shipped JS, the file is in the module order, and the reads
    // alias its globals). Without the guarded %init call at this position
    // those globals stay uninitialized: the dep's module body would never
    // run.
    const dep = isRelativeSpecifier(spec)
      ? resolveImport(this.program, node.getSourceFile(), spec)
      : npmStaticDepSf7(this.program, node.getSourceFile(), spec);
    if (!dep || dep.fileName.endsWith(".json")) return null;
    if (this.asyncInitFiles.has(dep)) {
      this.unsupported(
        "SC1090",
        node,
        `require() of '${spec}' (its ES-module graph uses top-level await; use import() instead)`,
      );
    }
    const initName = this.initNameOf.get(dep);
    if (initName === undefined) return null;
    const loc = locOf(node);
    return {
      kind: "exprStmt",
      expr: { kind: "call", callee: initName, args: [], type: VOID, loc },
      loc,
    };
  }

  /** True when this body should lower: everything with no reachable set,
   * the marked bodies in an externally-gated pass, and exactly the
   * UNMARKED bodies in the coverage remainder. */
  wantBody(name: string): boolean {
    if (this.reachable === null) return true;
    return this.remainder ? !this.reachable.has(name) : this.reachable.has(name);
  }

  collectNpmImports(parts: FileParts[]): void {
    return collectNpmImports(this, parts);
  }

  collectJsonImports(parts: FileParts[]): void {
    return collectJsonImports(this, parts);
  }

  run(): LowerResult {
    const parts = this.splitFiles();
    // The coverage remainder deliberately visits every body that reachable
    // emit skipped. Those files are already phase-managed, so an ordinary
    // checker miss would stay a one-node IPC query instead of falling back
    // to the facade's whole-file batch. Coverage has no dead-body boundary
    // to preserve: prime each complete file now, reusing the answers the
    // reachable pass already memoized and batching only the cold remainder.
    if (this.remainder) {
      for (const fp of parts) this.checker.prefetchSourceFile(fp.sf);
    }
    this.collectProgram(parts);
    // Decorated classes analyze AFTER the whole collection pass: a
    // decorator's return type may name a subclass declared below the
    // class, and reference lowering needs each class's rebindability
    // (valueGlobalId) settled before any body lowers.
    for (const info of this.classes.values()) analyzeClassDecoration(this, info);
    this.prepareModuleInits(parts);

    const functions: IrFunction[] = [];
    for (const fp of parts) {
      for (const decl of fp.fnDecls) {
        // Overload signatures / ambient declarations are type-world (no
        // body to lower — and they share the implementation's symbol, so
        // counting them as skips would double-count the declaration).
        if (!decl.body) continue;
        // Generic functions have no body of their own: they are lowered
        // per-instantiation, on demand, from the worklist below.
        const declSymbol = declSymbolOf(this, decl);
        if (declSymbol && this.genericFnsBySymbol.has(declSymbol)) continue;
        // Mixin functions likewise: no signature, no body of their own —
        // calls instantiate the class inside per site (lower-mixins.ts).
        if (this.mixinFnShapes.get(decl)) continue;
        const sig = declSymbol ? this.fnSigsBySymbol.get(declSymbol) : undefined;
        // A body nothing reaches never lowers: its constructs can't fail
        // the build and it leaves no trace in the emitted C.
        if (sig && !this.wantBody(sig.name)) continue;
        const fn = this.lowerFunction(decl);
        if (fn) functions.push(fn);
        else if (this.countsSkips()) this.stats.functionsSkipped++;
      }
      for (const decl of fp.classDecls) {
        const info = this.classes.get(this.classNamer(decl));
        if (info) functions.push(...this.lowerClassMembers(info));
        else if (this.countsSkips()) this.stats.functionsSkipped++;
      }
    }

    // Each file's top-level statements form its run-once init function.
    // %main calls only the ENTRY's init: each init's hoisted import header
    // runs its dependencies (npm island loads at their import positions),
    // inline require statements call theirs mid-body, and the guards make
    // revisits cache hits — Node's evaluation order over the WHOLE graph
    // falls out of the nesting. The coverage remainder skips them — they
    // are reachable by definition, already counted by reachable emit.
    if (!this.remainder) {
      for (const fp of parts) {
        functions.push(this.lowerFileInit(fp.sf, fp.topStmts, this.initNameOf.get(fp.sf)!));
      }
      functions.push(this.buildMain());
    }
    // Class EXPRESSIONS collected while the inits lowered: their members
    // lower here, wantBody-gated like declaration members (nested class
    // expressions inside these bodies are fenced, so the list is stable).
    // Monomorphization worklists: every site above queued the generic
    // instances it needs — function instances (calls, pinned values) and
    // class instantiations (type references) — and lowering any instance
    // body can queue more of EITHER kind (generic functions constructing
    // generic classes, generic methods calling generic functions) — the
    // index loops run to the joint fixpoint. Same-key recursion re-uses
    // its own entry; polymorphic recursion is cut off by
    // MAX_GENERIC_INSTANCES.
    {
      let ec = 0;
      let gc = 0;
      let gi = 0;
      let es = 0;
      while (
        ec < this.exprClasses.length ||
        gc < this.genericClassInstances.length ||
        gi < this.instantiationQueue.length ||
        es < this.emitSpecQueue.length
      ) {
        while (ec < this.exprClasses.length) {
          functions.push(...this.lowerClassMembers(this.exprClasses[ec++]!));
        }
        while (gc < this.genericClassInstances.length) {
          functions.push(...this.lowerClassMembers(this.genericClassInstances[gc++]!));
        }
        while (gi < this.instantiationQueue.length) {
          const { info, inst } = this.instantiationQueue[gi++]!;
          // A body-level poison outside the per-statement catches (a
          // generic method's this/super fence, a fenced parameter
          // default): the diagnostic is recorded — the instance skips
          // like a signature-blocked function (lowerFunction's rule).
          try {
            functions.push(this.lowerGenericInstance(info, inst));
          } catch (e) {
            if (!(e instanceof PoisonError)) throw e;
          }
        }
        // Emit-override specializations queued by the emit sites above (a
        // body can queue more — the super-forward chain — and generic
        // instances of its own; the joint fixpoint covers both).
        while (es < this.emitSpecQueue.length) {
          try {
            const fn = lowerEmitOverrideSpec(this, this.emitSpecQueue[es++]!);
            if (fn) functions.push(fn);
          } catch (e) {
            if (!(e instanceof PoisonError)) throw e;
          }
        }
      }
    }
    // Lambdas lifted while lowering any of the above (plus synthetic
    // array-HOF loop functions, which ride the same list), and the
    // implicit-any instances lowered eagerly at their first call sites.
    functions.push(...this.liftedFns);
    functions.push(...this.implicitFns);

    if (this.remainder) {
      // Deferred collection diagnostics nothing flushed — declarations no
      // reference ever made relevant. They belong to the unreached group
      // (collection order keeps them deterministic).
      for (const [symbol, diags] of this.deferredDiags) {
        if (this.alreadyFlushed.has(symbol)) continue;
        for (const d of diags) this.pushDiag(d);
      }
      return {
        module: null,
        diagnostics: this.diags,
        runtimeFences: this.runtimeFences,
        stats: this.stats,
        ...(this.statsByFile.size > 0 ? { statsByFile: this.statsByFile } : {}),
        ...(this.provenanceElided.length > 0 ? { provenanceElided: this.provenanceElided } : {}),
        ...(this.npmBuiltins ? { npmBuiltins: this.npmBuiltins } : {}),
        ...(this.npmLazyTraps ? { npmLazyTraps: this.npmLazyTraps } : {}),
      };
    }

    return this.finishModule(functions);
  }

  /** Final retention, pruning, and module assembly shared by ordinary emit
   * and the retained reachability worklist. */
  finishModule(functions: IrFunction[]): LowerResult {

    // Globals typed by a class that never REGISTERED (a JS class whose
    // collection fenced — Symbol-keyed fields, an unsupported base): the
    // declaration statement and every use compiled to runtime fences, but
    // the collection-time global still carries the object type, and the
    // emitter would name a struct that does not exist — invalid C, the
    // compile-C escape family. The storage is dead by construction (the
    // initializing assign never lowered; reads cascade to their own
    // fences), so drop it — guarded by a reference scan, with the
    // validator's registration check as the backstop for anything that
    // does slip through with a live reference.
    const brokenGlobals = this.globalsList.filter((g) => this.typeNamesUnregisteredClass(g.type));
    const brokenLocalFns = functions.filter((fn) =>
      fn.locals.some((l) => this.typeNamesUnregisteredClass(l.type)),
    );
    if (brokenGlobals.length > 0 || brokenLocalFns.length > 0) {
      const referencedIn = (root: unknown): Set<string> => {
        const referenced = new Set<string>();
        const scan = (node: unknown): void => {
          if (node === null || typeof node !== "object") return;
          if (Array.isArray(node)) {
            for (const item of node) scan(item);
            return;
          }
          const rec = node as Record<string, unknown>;
          const id = rec["localId"];
          if (typeof id === "string") referenced.add(id);
          const catchId = rec["catchLocalId"];
          if (typeof catchId === "string") referenced.add(catchId);
          // Closure captures name their source locals as PLAIN STRINGS
          // (captures: string[]) — a captured broken-class local is live.
          if (rec["kind"] === "closure" && Array.isArray(rec["captures"])) {
            for (const c of rec["captures"]) if (typeof c === "string") referenced.add(c);
          }
          for (const key of Object.keys(rec)) scan(rec[key]);
        };
        scan(root);
        return referenced;
      };
      if (brokenGlobals.length > 0) {
        const referenced = referencedIn(functions);
        for (const g of brokenGlobals) {
          if (referenced.has(g.id)) continue; // live reference — validator reports
          const i = this.globalsList.indexOf(g);
          if (i >= 0) this.globalsList.splice(i, 1);
        }
      }
      // LOCALS left behind the same way (`const countdown = new Countdown(...)`
      // inside an init body whose declaration fenced): the emitter declares
      // every local at function top, so an unreferenced one typed by the
      // unregistered class is the identical invalid-C escape.
      for (const fn of brokenLocalFns) {
        // Params and captures list their locals by id too — never prune
        // those out from under them.
        const referenced = referencedIn([fn.body, fn.params, fn.captures ?? []]);
        fn.locals = fn.locals.filter(
          (l) => referenced.has(l.id) || !this.typeNamesUnregisteredClass(l.type),
        );
      }
    }

    // Computed before the module gate: retention resolves every class name
    // the emitted program references, flushing deferred class diagnostics
    // that a reached type makes relevant.
    const artifacts = this.moduleArtifacts(functions);
    // Types still naming a class that never REGISTERED after retention's
    // flush (JS graphs whose class fences deferred to runtime — the
    // sentence-walker's path params, printer tables whose func-typed
    // fields spell the fenced class): the emitter would name a struct
    // that does not exist — the compile-C escape family. No instance of
    // such a class can ever exist (every construction site fenced), so
    // the slots are inert by construction: rewrite each to the f64 dummy
    // placeholder (boxNewC's uncollected-class stance, applied to unboxed
    // slots), uniformly across params/locals/globals/fields/body types so
    // every producer and consumer agrees. Programs with no unregistered
    // reference are untouched — byte-stability holds.
    if (this.diags.length === 0) {
      this.sanitizeUnregisteredClassTypes([functions, this.globalsList, artifacts.classes, artifacts.records, artifacts.unions]);
    }
    const module: IrModule | null =
      this.diags.length > 0
        ? null
        : {
            irVersion: 6,
            sourceFile: this.entry.fileName,
            functions,
            classes: artifacts.classes,
            records: artifacts.records,
            unions: artifacts.unions,
            globals: this.globalsList,
            ...(this.npmEmbedded ? { embedded: this.npmEmbedded } : {}),
            entry: ENTRY_NAME,
            ...(this.ffiImports.length > 0 ? { ffiImports: [...this.ffiImports] } : {}),
          };
    return {
      module,
      diagnostics: this.diags,
      runtimeFences: this.runtimeFences,
      stats: this.stats,
      ...(this.statsByFile.size > 0 ? { statsByFile: this.statsByFile } : {}),
      ...(this.provenanceElided.length > 0 ? { provenanceElided: this.provenanceElided } : {}),
      ...(this.npmBuiltins ? { npmBuiltins: this.npmBuiltins } : {}),
      ...(this.npmLazyTraps ? { npmLazyTraps: this.npmLazyTraps } : {}),
    };
  }

  /** The unregistered-class type sweep (run()'s last step before the
   * module assembles): every `{kind:"object"}` TYPE naming a class with
   * no registered ClassInfo is rewritten IN PLACE to the f64 dummy.
   * classval types are exempt (they emit the class-independent
   * `ScrClassObj *` — inert-but-valid storage, the validator's own
   * stance), and only type objects rewrite — node-level classNames
   * (`new`, upcasts) cannot reach here (their lowerings fence without a
   * registered class), so the validator still backstops those. */
  sanitizeUnregisteredClassTypes(roots: unknown[]): void {
    const isUnregisteredObjectType = (v: unknown): boolean =>
      typeof v === "object" && v !== null &&
      (v as { kind?: unknown }).kind === "object" &&
      typeof (v as { className?: unknown }).className === "string" &&
      !this.classes.has((v as { className: string }).className);
    const sweep = (node: unknown): void => {
      if (node === null || typeof node !== "object") return;
      if (Array.isArray(node)) {
        node.forEach((item, i) => {
          if (isUnregisteredObjectType(item)) node[i] = F64;
          else sweep(item);
        });
        return;
      }
      const rec = node as Record<string, unknown>;
      for (const key of Object.keys(rec)) {
        if (key === "loc") continue;
        const v = rec[key];
        if (isUnregisteredObjectType(v)) rec[key] = F64;
        else sweep(v);
      }
    };
    for (const root of roots) sweep(root);
  }

  /** True when `t` (recursively) names a class instance type with no
   * registered ClassInfo — the shape of a JS class whose collection fenced.
   * Used by run()'s global pruning; shapes/unions recurse with a seen-set
   * (interned ids can nest). */
  typeNamesUnregisteredClass(t: IrType, seen: Set<string> = new Set()): boolean {
    switch (t.kind) {
      case "object":
        return !this.classes.has(t.className);
      case "array":
      case "set":
        return this.typeNamesUnregisteredClass(t.elem, seen);
      case "map":
        return (
          this.typeNamesUnregisteredClass(t.key, seen) ||
          this.typeNamesUnregisteredClass(t.value, seen)
        );
      case "promise":
        return this.typeNamesUnregisteredClass(t.inner, seen);
      case "func":
        return (
          t.params.some((p) => this.typeNamesUnregisteredClass(p, seen)) ||
          this.typeNamesUnregisteredClass(t.ret, seen)
        );
      case "record": {
        if (seen.has(t.shapeId)) return false;
        seen.add(t.shapeId);
        const shape = this.shapes.get(t.shapeId);
        if (!shape) return false;
        if (shape.indexValue && this.typeNamesUnregisteredClass(shape.indexValue, seen)) return true;
        return shape.fields.some((f) => this.typeNamesUnregisteredClass(f.type, seen));
      }
      case "union": {
        if (seen.has(t.unionId)) return false;
        seen.add(t.unionId);
        const def = this.unions.get(t.unionId);
        return !!def && def.arms.some((a) => this.typeNamesUnregisteredClass(a, seen));
      }
      default:
        return false;
    }
  }

  /** Whether run() counts a signature-blocked declaration in
   * stats.functionsSkipped: whole-program passes and the coverage
   * remainder do; an externally-gated emit pass leaves the counting to the
   * remainder (the declaration was never reached). */
  countsSkips(): boolean {
    return this.reachable === null || this.remainder;
  }

  /* ── reachability ─────────────────────────────────────────────────── */

  /** Reachable emit: computes the set of body names the program's entry
   * reaches and retains each body IR as it lowers. Seeds are the per-file
   * init bodies (top-level statements always run); edges fire from
   * RESOLUTION sites while a body lowers (noteEdge /
   * noteVirtualEdge) — direct calls, closure creation (a taken closure may
   * be called indirectly), `new`, super calls, accessor invocations, and
   * virtual dispatch. Recording at resolution time (not off the produced
   * IR) keeps edges from statements that later poison, so the callee's own
   * diagnostics still surface — the collect-everything invariant. Generic
   * instances ride the existing monomorphization queue (already
   * demand-driven) and lifted lambdas lower inline with their enclosing
   * body; both fire edges through the same hooks and are not units
   * themselves. */
  emitReachable(extraRoots?: readonly string[]): { reachable: Set<string>; result: LowerResult } {
    const parts = this.splitFiles();
    // Direct lowering callers do not necessarily run program preflight.
    // Establish the same managed header/top-level batch here before
    // collection, while the production path simply finds warm memos.
    this.checker.prefetchSourceFileStructures(parts.map((fp) => fp.sf));
    // Signature collection may read the initializer type of a default whose
    // body type still admits undefined (for example `value =
    // process.env.VALUE`). The expression executes only when reached, but
    // that type query is mandatory now; batch hot defaults across ordinary
    // declarations before collectProgram visits their signatures.
    this.checker.prefetchCollectionTypes(
      parts.flatMap((fp) =>
        fp.fnDecls
          .filter((decl) => decl.body !== undefined && decl.typeParameters === undefined)
          .flatMap((decl) =>
            decl.parameters.flatMap((param) => param.initializer ? [param.initializer] : []),
          ),
      ),
    );
    // JavaScript class shapes are partly declared by constructor-body
    // assignments. Batch those collection-time queries across declarations
    // before collectProgram visits them one by one; reached body lowering
    // will reuse the same answers later.
    this.prefetchClassCollection(parts.flatMap((fp) => fp.classDecls));
    this.collectProgram(parts);
    // Decorated classes analyze post-collection here too: the %init seeds
    // lower the decoration calls, whose edges (decorator bodies, construct
    // thunks) reachable emit must see.
    for (const info of this.classes.values()) analyzeClassDecoration(this, info);
    this.prepareModuleInits(parts);

    // Every lowerable body, by emitted-function name. The names double as
    // retained-function keys and are deterministic by construction
    // (qualified declaration names).
    const units = new Map<string, {
      order: number;
      roots: readonly ts.Node[];
      lower: () => IrFunction | null;
    }>();
    const bodyRoots = (...roots: (ts.Node | undefined | null)[]): ts.Node[] =>
      roots.filter((root): root is ts.Node => root !== undefined && root !== null);
    const functionRoots = (decl: ts.FunctionLikeDeclaration): ts.Node[] => bodyRoots(
      ...decl.parameters.map((param) => param.initializer),
      decl.body,
    );
    const classCtorRoots = (info: ClassInfo): ts.Node[] => bodyRoots(
      ...(info.ctor?.parameters ?? []).map((param) => param.initializer),
      info.ctor?.body,
      ...info.fieldOrder.map((field) => field.initializer),
    );
    const classMemberRoots = (info: ClassInfo): ts.Node[] => [
      ...classCtorRoots(info),
      ...[...this.classMethodMembers(info)].flatMap(({ member }) => functionRoots(member)),
      ...[...(info.staticMethods?.values() ?? [])].flatMap(({ member }) => functionRoots(member)),
    ];
    let unitOrder = 0;
    for (const fp of parts) {
      for (const decl of fp.fnDecls) {
        // Overload signatures share the implementation's symbol (and so
        // its FnSig): only the with-body declaration is the unit, or the
        // signature's closure would shadow the implementation's.
        if (!decl.body) continue;
        const declSymbol = declSymbolOf(this, decl);
        if (!declSymbol || this.genericFnsBySymbol.has(declSymbol)) continue;
        const sig = this.fnSigsBySymbol.get(declSymbol);
        if (sig) {
          units.set(sig.name, {
            order: unitOrder++,
            roots: functionRoots(decl),
            lower: () => this.lowerFunction(decl),
          });
        }
      }
    }
    for (const info of this.classes.values()) {
      if (info.builtinError) continue; // runtime-provided; nothing lowers
      // Generic-class INSTANTIATIONS (and mixin instantiations) are
      // demand-driven, not units: their members lower unconditionally in
      // the instance drain below — the generic-fn instance rule.
      if (info.genericInstance || info.mixinInstance) continue;
      const cName = info.def.name;
      // A FAMILY has no constructor function and no instance members —
      // only its statics are units.
      if (!info.generic) {
        units.set(`%${cName}.constructor`, {
          order: unitOrder++,
          roots: classCtorRoots(info),
          lower: () => this.lowerClassCtor(info),
        });
        for (const { mName, member } of this.classMethodMembers(info)) {
          units.set(`%${cName}.${mName}`, {
            order: unitOrder++,
            roots: functionRoots(member),
            lower: () => this.lowerClassMethodMember(info, member),
          });
        }
        for (const prop of info.throwingSetters) {
          units.set(`%${cName}.set:${prop}`, {
            order: unitOrder++,
            roots: [],
            lower: () => this.throwingSetterFn(info, prop),
          });
        }
      }
      for (const [name, entry] of info.staticMethods ?? []) {
        units.set(`%${cName}.static:${name}`, {
          order: unitOrder++,
          roots: functionRoots(entry.member),
          lower: () => lowerStaticMethod(this, info, name),
        });
      }
    }
    // The old emit pass visited each file's functions and then its classes,
    // before every module init. Retained reachability discovers those
    // bodies from the inits, but first-seen record metadata still has to
    // follow that old order: Object.keys/JSON/inspect observe a shape's
    // declaredOrder. Keep output sorting separate — this rank controls only
    // that observable metadata.
    const metadataPriority = new Map<string, readonly [phase: number, order: number]>();
    let declarationMetadataOrder = 0;
    const rank = (name: string): void => {
      if (units.has(name) && !metadataPriority.has(name)) {
        metadataPriority.set(name, [1, declarationMetadataOrder++]);
      }
    };
    for (const fp of parts) {
      for (const decl of fp.fnDecls) {
        if (!decl.body) continue;
        const symbol = declSymbolOf(this, decl);
        if (symbol && !this.genericFnsBySymbol.has(symbol)) {
          const sig = this.fnSigsBySymbol.get(symbol);
          if (sig) rank(sig.name);
        }
      }
      for (const decl of fp.classDecls) {
        const info = this.classes.get(this.classNamer(decl));
        if (!info) continue;
        const cName = info.def.name;
        rank(`%${cName}.constructor`);
        for (const { mName } of this.classMethodMembers(info)) rank(`%${cName}.${mName}`);
        for (const name of info.staticMethods?.keys() ?? []) rank(`%${cName}.static:${name}`);
        for (const prop of info.throwingSetters) rank(`%${cName}.set:${prop}`);
      }
    }
    // Defensive fallback for declaration-like units registered outside
    // FileParts; they still precede init bodies in the old emit pass.
    for (const name of units.keys()) rank(name);
    let expressionMetadataOrder = 0;
    let instanceMetadataOrder = 0;
    const demandOwner = (priority?: readonly [number, number]): GenericDemandOwner => {
      const owner: GenericDemandOwner = {
        ...(priority ? { priority } : {}),
        functionDemands: [],
        classDemands: [],
      };
      if (priority) this.genericDemandRoots.push(owner);
      return owner;
    };
    const reachable = new Set<string>();
    const queue: string[] = [];
    const loweredUnits = new Map<string, IrFunction>();
    const initFunctions: IrFunction[] = [];
    const instanceFunctions: IrFunction[] = [];
    this.onEdge = (name: string): void => {
      if (reachable.has(name)) return;
      reachable.add(name);
      if (units.has(name)) queue.push(name);
    };
    // Class EXPRESSIONS collect while init bodies lower (below): their
    // member units register the moment collection finishes — before any
    // edge to them can fire (references require the collected class).
    this.onExprClassCollected = (info: ClassInfo): void => {
      const cName = info.def.name;
      const register = (
        name: string,
        roots: readonly ts.Node[],
        lower: () => IrFunction | null,
      ): void => {
        units.set(name, { order: unitOrder++, roots, lower });
        metadataPriority.set(name, [3, expressionMetadataOrder++]);
      };
      register(`%${cName}.constructor`, classCtorRoots(info), () => this.lowerClassCtor(info));
      for (const { mName, member } of this.classMethodMembers(info)) {
        register(
          `%${cName}.${mName}`,
          functionRoots(member),
          () => this.lowerClassMethodMember(info, member),
        );
      }
      for (const [name, entry] of info.staticMethods ?? []) {
        register(
          `%${cName}.static:${name}`,
          functionRoots(entry.member),
          () => lowerStaticMethod(this, info, name),
        );
      }
      for (const prop of info.throwingSetters) {
        register(`%${cName}.set:${prop}`, [], () => this.throwingSetterFn(info, prop));
      }
    };
    // Generic instances queued by the bodies above lower here (an instance
    // body fires edges of its own and can queue further instances of
    // either kind — function instances and class instantiations drain to
    // the joint fixpoint).
    let instLowered = 0;
    let clsInstLowered = 0;
    let specLowered = 0;
    const drainInstances = (): void => {
      while (
        instLowered < this.instantiationQueue.length ||
        clsInstLowered < this.genericClassInstances.length ||
        specLowered < this.emitSpecQueue.length
      ) {
        while (clsInstLowered < this.genericClassInstances.length) {
          const waveEnd = this.genericClassInstances.length;
          this.checker.prefetchRoots(
            this.genericClassInstances.slice(clsInstLowered, waveEnd).flatMap(classMemberRoots),
          );
          while (clsInstLowered < waveEnd) {
            const info = this.genericClassInstances[clsInstLowered++]!;
            const owner = demandOwner();
            this.genericClassDemandOwner.set(info, owner);
            const ref = this.genericClassDemandPriority.get(info) ?? { rank: [4, instanceMetadataOrder++] };
            this.genericClassDemandPriority.set(info, ref);
            instanceFunctions.push(...this.withGenericDemandOwner(owner, () =>
              this.shapes.withDeclaredOrderPriority(ref, () => this.lowerClassMembers(info))));
          }
        }
        while (instLowered < this.instantiationQueue.length) {
          const waveEnd = this.instantiationQueue.length;
          this.checker.prefetchRoots(
            this.instantiationQueue
              .slice(instLowered, waveEnd)
              .flatMap(({ info }) => functionRoots(info.decl)),
          );
          while (instLowered < waveEnd) {
            const { info, inst } = this.instantiationQueue[instLowered++]!;
            const owner = demandOwner();
            this.genericFunctionDemandOwner.set(inst, owner);
            const ref = this.genericDemandPriority.get(inst) ?? { rank: [4, instanceMetadataOrder++] };
            this.genericDemandPriority.set(inst, ref);
            // Body-level poisons skip the instance after retaining the
            // diagnostic and every edge fired before poisoning.
            try {
              instanceFunctions.push(this.withGenericDemandOwner(owner, () =>
                this.shapes.withDeclaredOrderPriority(ref, () => this.lowerGenericInstance(info, inst))));
            } catch (e) {
              if (!(e instanceof PoisonError)) throw e;
            }
          }
        }
        // Emit-override specialization bodies fire edges of their own
        // (the super-forward chain, closures, generic calls) — lower them
        // exactly like generic instances.
        while (specLowered < this.emitSpecQueue.length) {
          const waveEnd = this.emitSpecQueue.length;
          this.checker.prefetchRoots(
            this.emitSpecQueue
              .slice(specLowered, waveEnd)
              .flatMap(({ info }) =>
                info.emitOverride ? functionRoots(info.emitOverride.decl) : []),
          );
          while (specLowered < waveEnd) {
            try {
              const fn = this.shapes.withDeclaredOrderPriority(
                [4, instanceMetadataOrder++],
                () => lowerEmitOverrideSpec(this, this.emitSpecQueue[specLowered++]!),
              );
              if (fn) instanceFunctions.push(fn);
            } catch (e) {
              if (!(e instanceof PoisonError)) throw e;
            }
          }
        }
      }
    };

    // Module inits are the unconditional root wave. Structure prefetch
    // already covered ordinary top-level expressions, but this full-root
    // pass also picks up nested/lifted function bodies and the class
    // declaration-time code that splitFiles hoists out of topStmts.
    this.checker.prefetchRoots([
      ...parts.flatMap((fp) => fp.topStmts),
      ...[...this.classes.values()].flatMap((info) => [
        ...info.staticFields.map((field) => field.initializer),
        ...(info.staticBlocks ?? []),
        ...(info.classDecorators?.nodes ?? []),
      ]),
    ]);
    parts.forEach((fp, index) => {
      const priority = [2, index] as const;
      const owner = demandOwner(priority);
      initFunctions.push(
        this.withGenericDemandOwner(
          owner,
          () => this.shapes.withDeclaredOrderPriority(
            priority,
            () => this.lowerFileInit(fp.sf, fp.topStmts, this.initNameOf.get(fp.sf)!),
          ),
        ),
      );
    });
    // LIBRARY mode's extra reachability roots (LowerOptions.libRoots): the
    // profile-mapped exports are called from outside the graph, so they
    // seed the worklist beside the init bodies. Unknown names are inert
    // (the export-map resolution reports them as SC4002 later).
    for (const root of extraRoots ?? []) this.onEdge?.(root);
    const drainUnits = (): void => {
      while (queue.length > 0) {
        const wave = queue.splice(0);
        this.checker.prefetchRoots(wave.flatMap((name) => units.get(name)!.roots));
        for (const name of wave) {
          // A body-level poison outside the per-statement catches (a fenced
          // constructor/method parameter default lowered by declareParams):
          // every edge fired before poisoning remains retained; the diagnostic
          // stays recorded and the member stays omitted.
          try {
            const unit = units.get(name)!;
            const priority = metadataPriority.get(name) ?? [3, expressionMetadataOrder++];
            const owner = demandOwner(priority);
            const fn = this.withGenericDemandOwner(
              owner,
              () => this.shapes.withDeclaredOrderPriority(priority, unit.lower),
            );
            if (fn) loweredUnits.set(name, fn);
          } catch (e) {
            if (!(e instanceof PoisonError)) throw e;
          }
        }
      }
    };
    drainUnits();
    this.restoreGenericInstanceOrder();
    this.restoreGenericClassInstanceOrder();
    // Generic bodies can reach ordinary declarations, whose bodies can in
    // turn queue more instances. Continue to the joint fixpoint; the initial
    // queue above is the only portion whose discovery order differed from
    // historical emit order.
    for (;;) {
      drainInstances();
      if (queue.length === 0) break;
      drainUnits();
      this.restoreGenericInstanceOrder(instLowered);
      this.restoreGenericClassInstanceOrder(clsInstLowered);
    }
    const orderedUnits = [...loweredUnits]
      .sort(([left], [right]) => units.get(left)!.order - units.get(right)!.order)
      .map(([, fn]) => fn);
    this.settleGenericDemandPriorities();
    this.shapes.settleDeclaredOrderPriorities();
    for (const finalize of this.shapeOrderMetadataFinalizers) finalize();
    for (const finalize of this.shapeOrderHelperFinalizers) finalize();
    const functions = [
      ...orderedUnits,
      ...initFunctions,
      this.buildMain(),
      ...instanceFunctions,
      ...this.liftedFns,
      ...this.implicitFns,
    ];
    this.reachableForArtifacts = reachable;
    return { reachable, result: this.finishModule(functions) };
  }

  /** Reachability hook (see emitReachable): fires when lowering resolves a
   * reference to a lowerable body. */
  noteEdge(name: string): void {
    if (this.onEdge) this.onEdge(name);
  }

  /** Discovery hook for virtual dispatch: a virtualCall on `info`'s static
   * class reaches the nearest declaration at/above it plus every override
   * on a STRICT descendant (receivers of sibling branches can't flow into
   * this call site; a virtualCall through their own static classes marks
   * them). */
  noteVirtualEdge(info: ClassInfo, method: string): void {
    if (!this.onEdge) return;
    const above = this.findMethodOn(info, method);
    if (above) this.noteEdge(`%${above.declarer.def.name}.${method}`);
    const below = (c: ClassInfo): void => {
      for (const s of c.subclasses) {
        if (s.methods.has(method)) this.noteEdge(`%${s.def.name}.${method}`);
        below(s);
      }
    };
    below(info);
  }

  moduleArtifacts(functions: IrFunction[]): {
    classes: IrClassDef[];
    records: IrRecordShape[];
    unions: IrUnionDef[];
  } {
    return moduleArtifacts(this, functions);
  }

  /* ── diagnostics plumbing ─────────────────────────────────────────── */

  /** Converts diagnostics recorded since `diagsBefore` into a runtime
   * fence. ICEs stay on the compile-diagnostic path; every other captured
   * diagnostic moves to the runtime-fence ledger. Function targets share
   * the same capture-free trap-function construction, while statement
   * targets return the fence inline. Null means the conversion was not
   * eligible (probe mode, no diagnostic/fallback, or an ICE). */
  deferToRuntimeFence(
    diagsBefore: number,
    node: ts.Node,
    target: RuntimeFenceStatementTarget,
  ): IrStmt | null;
  deferToRuntimeFence(
    diagsBefore: number,
    node: ts.Node,
    target: RuntimeFenceFunctionTarget,
  ): IrFunction | null;
  deferToRuntimeFence(
    diagsBefore: number,
    node: ts.Node,
    target: RuntimeFenceClosureTarget,
  ): IrExpr | null;
  deferToRuntimeFence(
    diagsBefore: number,
    node: ts.Node,
    target: RuntimeFenceTarget,
  ): IrStmt | IrFunction | IrExpr | null {
    if (
      (this.diagSink !== null && target.allowDiagSink !== true) ||
      (this.diags.length <= diagsBefore && target.fallback === undefined)
    ) {
      return null;
    }
    const captured = this.diags.splice(diagsBefore);
    if (captured.some((d) => d.code === "SC9001")) {
      this.diags.push(...captured);
      return null;
    }
    this.runtimeFences.push(...captured);

    const first = captured[0];
    const loc = locOf(node);
    const code = first?.code ?? target.fallback!.code;
    const baseMessage = first?.message ?? target.fallback!.message;
    const messageLoc = first?.loc ?? loc;
    const source = first
      ? this.program.getSourceFile(messageLoc.file) ?? node.getSourceFile()
      : node.getSourceFile();
    const pos = ts.getLineAndCharacterOfPosition(source, messageLoc.start);
    const fence: IrStmt = {
      kind: "runtimeFence",
      code,
      message: target.bareMessage
        ? baseMessage
        : `${baseMessage} [${code} at ${messageLoc.file}:${pos.line + 1}]`,
      loc,
    };
    if (target.kind === "statement") return fence;

    const params = target.params ?? [];
    const name = typeof target.name === "function" ? target.name() : target.name;
    const fn: IrFunction = {
      name,
      params,
      returnType: target.returnType,
      locals: params.map((p) => ({
        id: p.localId,
        name: p.name,
        type: p.type,
        mutable: target.paramsMutable ?? false,
      })),
      body: [fence],
      loc,
    };
    if (target.async) fn.async = true;
    if (target.generator) fn.generator = target.generator;
    if (target.kind === "function") return fn;

    fn.captures = [];
    this.liftedFns.push(fn);
    return { kind: "closure", fnName: fn.name, captures: [], type: target.type, loc };
  }

  /** All diagnostics land here; while a generic instance body is lowering,
   * the instantiation context is appended so the user knows which concrete
   * types made the (source-anchored) construct fail. */
  pushDiag(diag: ScrDiagnostic): void {
    const d = this.instantiationContext
      ? { ...diag, message: `${diag.message} (${this.instantiationContext})` }
      : diag;
    // Deferred collection: the wrapper decides whether these ever report
    // (a reference flushes them; unreferenced declarations stay silent in
    // builds and report under coverage's unreached group).
    if (this.diagSink) {
      this.diagSink.push(d);
      return;
    }
    // One site, one report: some declarations map a type twice (module
    // globals pre-register before their initializers lower) — an exact
    // duplicate (code + span + message) adds noise, not information.
    if (
      this.diags.some(
        (p) =>
          p.code === d.code &&
          p.loc.start === d.loc.start &&
          p.loc.end === d.loc.end &&
          p.message === d.message,
      )
    ) {
      return;
    }
    this.diags.push(d);
  }

  unsupported(
    code: keyof typeof UNSUPPORTED & `SC${number}`,
    node: ts.Node,
    featureOverride?: string,
    hintOverride?: string,
  ): never {
    this.pushDiag(unsupportedDiag(code, locOf(node), featureOverride, hintOverride));
    throw new PoisonError();
  }

  externalHostFence(specifier: string, node: ts.Node, valueUse = true): never {
    this.unsupported(
      "SC1010",
      node,
      valueUse
        ? `values from the '${specifier}' external host module (types supplied by --external-types, but no runtime implementation or scriptc lowering was provided)`
        : `the '${specifier}' external host module (types supplied by --external-types, but no runtime implementation or scriptc lowering was provided)`,
      `the declaration mapping is analysis-only: coverage continues through project code, while executing ${valueUse ? "this value" : "this module"} requires an embedder integration with explicit runtime semantics`,
    );
  }

  /** The dynamic-family fence for an OPERATION on an `any`-origin
   * checked-dynamic value that only the engine can execute (operators,
   * iteration, computed member names, ...). Carries SC2011 — the same
   * code as the `any` type fence — so the coverage report groups it with
   * the dynamic-capable family and the two-tier retry knows the island
   * lifts the site. Use exactly when the blocking operand IS dyn-typed
   * and its checker type is `any`-flavored; genuine `unknown` keeps the
   * SC1100-family fences (tsc constrains what unknown can do, so those
   * sites are checker-error territory, not engine territory). */
  anyOpFence(feature: string, node: ts.Node): never {
    this.pushDiag(anyOpRequiresDynamicDiag(feature, locOf(node)));
    throw new PoisonError();
  }

  /** True when this expression's CHECKER type is `any`-flavored — the
   * gate anyOpFence's call sites use to tell `any`-origin dyn values
   * (the engine could run the operation) from genuine `unknown` ones. */
  anyOrigin(node: ts.Node): boolean {
    return (this.typeOf(node).flags & ts.TypeFlags.Any) !== 0;
  }

  badType(node: ts.Node, type: ts.Type): never {
    const widened = this.checker.getBaseTypeOfLiteralType(type);
    // Types declared by the ADOPTED @types/node (Buffer, NodeJS.Timeout,
    // the undici Response, ...) are supported-surface provenance, not npm
    // packages — their values never lower, so the honest blame is the
    // SC2020-family fence naming @types/node. Checked FIRST: Buffer has
    // an index signature and would otherwise get the misleading use-a-Map
    // hint below, and no user-side remedy the other messages suggest
    // applies to node-typed values.
    const typeSym = widened.getAliasSymbol() ?? widened.getSymbol();
    if (this.nodeTypesOnlySymbol(typeSym)) {
      this.pushDiag(noLoweringDiag(this.checker.typeToString(type), locOf(node), undefined, true));
      throw new PoisonError();
    }
    // Engine-backed ambient TYPES in a STATIC build report the per-site
    // SC2012 rather than the generic supported-types recitation. Native
    // fetch values map earlier to checked-dynamic handles and do not reach
    // here; constructor objects such as Headers still can.
    if (
      !this.dynamic &&
      typeSym &&
      (ISLAND_AMBIENT_TYPES as readonly string[]).includes(typeSym.name) &&
      this.isStdlibSymbol(typeSym)
    ) {
      this.pushDiag(requiresDynamicApiDiag(`a value of type '${typeSym.name}'`, locOf(node)));
      throw new PoisonError();
    }
    // ENUM OBJECTS (`typeof e` — a numeric enum's type carries the
    // reverse-map index signature, a string enum's just its members):
    // shaped like a hybrid record, but the enum identifier has no value
    // lowering, so the honest fence names the construct in the same voice
    // as the per-site identifier fence — never the index-signature
    // recitation.
    if (typeSym && (typeSym.flags & ts.SymbolFlags.Enum) !== 0) {
      this.pushDiag(
        unsupportedDiag(
          "SC1090",
          locOf(node),
          `enum objects as values ('${typeSym.name}' — member reads like '${typeSym.name}.X' compile to constants; the object itself has no runtime representation)`,
        ),
      );
      throw new PoisonError();
    }
    // Would-be records with INDEX SIGNATURES (`Record<string, T>`,
    // `{ [k: string]: T }`) get the index-signature fence (SC2006) naming
    // the supported key/value domain instead of the generic
    // supported-types recitation.
    if (
      widened.flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection) &&
      this.checker.getCallSignatures(widened).length === 0 &&
      this.checker.getConstructSignatures(widened).length === 0 &&
      !this.checker.isTupleType(widened) &&
      !this.checker.isArrayLikeType(widened) &&
      this.checker.getIndexInfosOfType(widened).length > 0
    ) {
      // STANDARD-LIBRARY interface/class types that carry index signatures
      // (the typed arrays — Int8Array..Float16Array): the honest story is
      // the lib fence naming the type (SC2020 — only the supported surface
      // compiles), not a use-a-Map hint no user can act on. NOMINAL lib
      // declarations only: a lib-declared ALIAS or mapped type
      // (`Record<string, object>`) is still a data shape whose own story
      // (the value type, the key domain) the fences below tell better.
      const ownSym = widened.getSymbol();
      if (
        ownSym &&
        this.checker.declarationsOf(ownSym).some(
          (d) =>
            (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
            this.isStdlibFile(d.getSourceFile()),
        )
      ) {
        this.pushDiag(noLoweringDiag(this.checker.typeToString(type), locOf(node)));
        throw new PoisonError();
      }
      // The MEASURED island probe, same mechanism as the general dynamic
      // reroute below: an index-signature shape the dynamic mapping
      // accepts (an `any`-valued signature absorbing into an island
      // object, jsval-entangled members) reports the retry-eligible
      // SC2011 choice instead of the static recitation.
      if (
        !this.dynamic &&
        !(widened.flags & ts.TypeFlags.Any) &&
        mapType(widened, { ...this.typeCtx, dynamic: true }) !== null
      ) {
        this.pushDiag(requiresDynamicTypeDiag(this.checker.typeToString(type), locOf(node)));
        throw new PoisonError();
      }
      this.pushDiag(indexSignatureTypeDiag(this.checker.typeToString(type), locOf(node)));
      throw new PoisonError();
    }
    // Package-declared types in a STATIC build: name the package, not the
    // type — the per-package requires-dynamic diagnostic (and the coverage
    // report's one-line-per-package attribution). Under --dynamic these
    // types map to jsval, so reaching here means the type is genuinely
    // unrepresentable (a jsval union arm, a jsval array element) — the
    // generic type message tells that story better.
    if (!this.dynamic) {
      const pkg = this.npmPackageOf(widened);
      if (pkg) {
        this.pushDiag(requiresDynamicPackageDiag(pkg, locOf(node)));
        throw new PoisonError();
      }
    }
    // A type that keeps a GENERIC call signature (`<T>(x: T) => T` slots,
    // stored generic functions, higher-order-generic call results): the
    // pointed monomorphization message instead of the recitation. Union
    // arms count — a `(<T>(x: T) => T) | undefined` slot is the same
    // story through its callable arm. After the package check: a
    // package-declared generic signature stays the package's story.
    {
      const parts = widened.isUnionType() ? ts.constituentTypes(widened) : [widened];
      if (
        parts.some((p) =>
          this.checker.getCallSignatures(p).some((s) => (s.typeParameters?.length ?? 0) > 0),
        )
      ) {
        this.pushDiag(genericSignatureTypeDiag(this.checker.typeToString(type), locOf(node)));
        throw new PoisonError();
      }
    }
    // A type the DYNAMIC mapping accepts (`any[]`, records/functions with
    // `any`-typed members, .d.ts-declared shapes whose values are island
    // handles): the honest per-site story is the dynamic-family choice, not
    // the supported-types recitation — proved by re-running mapType with
    // `dynamic: true`, never guessed from the type text. Probing is safe
    // here: a diagnostic means this build already failed, so anything the
    // probe interns or registers on the way is never emitted. Checked LAST
    // so every more specific story above (island ambients, index
    // signatures, per-package attribution, generic signatures) keeps its
    // own fence class. Bare `any` is excepted: unsupportedTypeDiag's own
    // SC2011 arm tells that story with the stronger stay-static remedy
    // ('unknown' + a checked cast).
    if (
      !this.dynamic &&
      !(widened.flags & ts.TypeFlags.Any) &&
      mapType(widened, { ...this.typeCtx, dynamic: true }) !== null
    ) {
      this.pushDiag(requiresDynamicTypeDiag(this.checker.typeToString(type), locOf(node)));
      throw new PoisonError();
    }
    // STANDARD-LIBRARY nominal provenance, decided once: interface/class
    // declarations in the lib's own files (Date, ArrayBuffer, WeakMap, the
    // iterator/constructor interfaces). Such types report the SC2020 story
    // below — the same one the index-signature-carrying lib types above
    // tell — rather than an overload/record claim no user can act on.
    const stdlibOwnSym = widened.getSymbol();
    const stdlibNominal =
      stdlibOwnSym !== undefined &&
      this.checker.declarationsOf(stdlibOwnSym).some(
        (d) =>
          (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
          this.isStdlibFile(d.getSourceFile()),
      );
    // OVERLOADED call signatures (SC2007) — after the generic branch, so a
    // generic overload set keeps the monomorphization story: a value of a
    // multi-signature type has no single compiled signature to hold.
    if (!stdlibNominal && this.checker.getCallSignatures(widened).length > 1) {
      this.pushDiag(overloadedSignatureTypeDiag(this.checker.typeToString(type), locOf(node)));
      throw new PoisonError();
    }
    // INTERSECTIONS that resolved to no lowering (SC2008). The ones that
    // compile never get here: member intersections intern through the
    // record path, callable hybrids map to '%call' records, and pinned
    // mixin instantiations resolve by chain structure.
    if (widened.isIntersectionType()) {
      this.pushDiag(intersectionTypeDiag(this.checker.typeToString(type), locOf(node)));
      throw new PoisonError();
    }
    // SUPPORTED shapes over a component outside its slot (SC2009): the
    // Map/Set domains, array/tuple elements, union arms, function
    // parameters/returns. The container is not the blocker — name the
    // component instead of reciting the supported set. Checked BEFORE the
    // lib claim so Map/Set/Promise instantiation failures keep their
    // component story (describeComponentBlocker always answers for those
    // heads).
    {
      const detail = describeComponentBlocker(widened, this.typeCtx);
      if (detail !== null) {
        this.pushDiag(componentTypeDiag(this.checker.typeToString(type), detail, locOf(node)));
        throw new PoisonError();
      }
    }
    // STANDARD-LIBRARY nominal types with no lowering at all: the SC2020
    // story, naming the type — and for the families with a WHY, the same
    // pointed reason the identifier/constructor chokepoints teach.
    if (stdlibNominal) {
      const intlHint =
        "Intl formatter values have no representation — the COMPOSED en-US forms lower: " +
        'new Intl.NumberFormat("en-US").format(x) and x.toLocaleString("en-US") with default options; ' +
        "the rest is ICU locale data the binary does not carry";
      const typeHints: Record<string, string | undefined> = {
        ArrayBuffer:
          "no free-standing ArrayBuffer value exists — typed arrays own their storage " +
          "(new Uint8Array(n) allocates; new Uint8Array(new ArrayBuffer(n)) erases the buffer into the view)",
        SharedArrayBuffer:
          "no shared-memory threads exist in a compiled program — Uint8Array is the byte storage",
        NumberFormat: intlHint,
        DateTimeFormat: intlHint,
        DurationFormat: intlHint,
        PluralRules: intlHint,
        Collator: intlHint,
        ListFormat: intlHint,
        RelativeTimeFormat: intlHint,
        Segmenter: intlHint,
        DisplayNames: intlHint,
        TextEncoder:
          "TextEncoder values have no representation — call through a const initialized with new TextEncoder(), or use the composed new TextEncoder().encode(s) form",
        TextDecoder:
          "TextDecoder values have no representation — call through a const initialized with a recognized literal label, or use the composed new TextDecoder(<literal label>).decode(bytes) form",
      };
      this.pushDiag(
        noLoweringDiag(this.checker.typeToString(type), locOf(node), typeHints[stdlibOwnSym?.name ?? ""]),
      );
      throw new PoisonError();
    }
    // USER record shapes blocked by ONE member (SC2009's record arm):
    // name the member and its type.
    {
      const detail = describeRecordMemberBlocker(widened, this.typeCtx);
      if (detail !== null) {
        this.pushDiag(componentTypeDiag(this.checker.typeToString(type), detail, locOf(node)));
        throw new PoisonError();
      }
    }
    this.pushDiag(unsupportedTypeDiag(this.checker.typeToString(type), locOf(node)));
    throw new PoisonError();
  }

  /** The lib fence (SC2020): a reached use of standard-library surface
   * nothing lowers. Poisons the statement like every other rejection.
   * `sym`, when given, picks the wording: surface declared only by the
   * adopted @types/node is blamed at @types/node. */
  noLowering(surface: string, node: ts.Node, hint?: string, sym?: ts.Symbol | null): never {
    this.pushDiag(noLoweringDiag(surface, locOf(node), hint, this.nodeTypesOnlySymbol(sym)));
    throw new PoisonError();
  }

  stdlibMemberFence(access: ts.PropertyAccessExpression): void {
    return stdlibMemberFence(this, access);
  }

  fenceStaticResponseMember(
    access: ts.PropertyAccessExpression | ts.ElementAccessExpression,
    use: "read" | "call",
  ): IrExpr | null {
    return fenceStaticResponseMember(this, access, use);
  }

  fenceUnsupportedFetchConstructorMember(
    access: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  ): IrExpr | null {
    return fenceUnsupportedFetchConstructorMember(this, access);
  }

  fenceStaticHeadersMember(
    access: ts.PropertyAccessExpression | ts.ElementAccessExpression,
    use: "read" | "call",
  ): IrExpr | null {
    return fenceStaticHeadersMember(this, access, use);
  }

  fenceStaticAbortControllerMemberRead(
    access: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  ): IrExpr | null {
    return fenceStaticAbortControllerMemberRead(this, access);
  }

  fenceStaticHeadersIteration(node: ts.Node): void {
    return fenceStaticHeadersIteration(this, node);
  }

  fenceFetchObjectAssignment(
    target: ts.ObjectLiteralExpression,
    source: ts.Expression,
  ): void {
    return fenceFetchObjectAssignment(this, target, source);
  }

  lowerDynamicHeadersIteratorCall(
    call: ts.CallExpression,
    access: ts.ElementAccessExpression,
  ): IrExpr | null {
    return lowerDynamicHeadersIteratorCall(this, call, access);
  }

  lowerDynamicHeadersSpread(
    node: ts.Expression,
    type: IrType & { kind: "array" },
  ): IrExpr | null {
    return lowerDynamicHeadersSpread(this, node, type);
  }

  fenceStaticReadableStreamMember(
    access: ts.PropertyAccessExpression | ts.ElementAccessExpression,
    use: "read" | "call",
  ): IrExpr | null {
    return fenceStaticReadableStreamMember(this, access, use);
  }

  typeOf(node: ts.Node): ts.Type {
    // Inside an optional-chain body the guarded receiver is typed by its
    // NON-NULLISH type (the chain's tag test proved it), so every
    // receiver-kind check downstream sees the narrowed arm.
    const narrowed = this.chainNarrowedType.get(node);
    if (narrowed) return narrowed;
    const t = this.checker.getTypeAtLocation(node);
    // ALIASED-TYPEOF narrowing: inside a branch a `type === 'string'`
    // test proves (type = typeof val, both never reassigned), references
    // to the tested operand answer the proven arm — the var/let alias
    // form the checker only narrows for consts. Checked before the
    // implicit-param hook: a branch narrow is strictly more specific
    // than a call-site binding.
    if (this.aliasNarrowTypes.size > 0 && ts.isIdentifier(node)) {
      const sym = this.checker.getSymbolAtLocation(node);
      const arm = sym !== undefined ? this.aliasNarrowTypes.get(sym) : undefined;
      if (arm !== undefined) return arm;
    }
    // IMPLICIT-ANY instance bodies: an identifier reference to a BOUND
    // param answers the call site's concrete type wherever the checker
    // still says `any` (there is no `T` for mapType to substitute — the
    // binding rides here instead). Where tsc's own flow analysis DID
    // narrow the `any` (typeof/instanceof guards), a narrow CONSISTENT
    // with the binding wins — it IS the binding, an arm of it, or a
    // subclass; a CONTRADICTING narrow is the statically-dead branch of a
    // typeof dispatch this instantiation cannot take, and answering the
    // bound type there keeps dead branches on honest fences instead of
    // lowering the live value under a lying type.
    if (this.implicitParamTypes !== null && ts.isIdentifier(node)) {
      const sym = this.checker.getSymbolAtLocation(node);
      const bound = sym !== undefined ? this.implicitParamTypes.get(sym) : undefined;
      if (bound !== undefined && bound !== t) {
        if (t.flags & ts.TypeFlags.Any) return bound;
        const narrowedIr = this.mapTypeOf(t);
        const boundIr = this.mapTypeOf(bound);
        if (narrowedIr === null || boundIr === null) return bound;
        if (typeEquals(narrowedIr, boundIr)) return t;
        // A union binding narrowed to one of its arms (typeof/equality
        // guards over string|number bindings) — the narrow is truth.
        if (boundIr.kind === "union") {
          const arms = this.unions.get(boundIr.unionId)?.arms ?? [];
          const nArms =
            narrowedIr.kind === "union" ? (this.unions.get(narrowedIr.unionId)?.arms ?? [narrowedIr]) : [narrowedIr];
          if (nArms.every((n) => arms.some((a) => typeEquals(a, n)))) return t;
          return bound;
        }
        // An instanceof narrow to a SUBCLASS of the bound class — truth.
        if (
          boundIr.kind === "object" && narrowedIr.kind === "object" &&
          this.isSubclassOf(narrowedIr.className, boundIr.className)
        ) {
          return t;
        }
        return bound;
      }
    }
    return t;
  }

  /** mapType with this Lowerer's registries and (while a generic instance
   * body lowers) type-parameter bindings threaded through. */
  mapTypeOf(t: ts.Type): IrType | null {
    return mapType(t, this.typeCtx);
  }

  /** The one position where a contextual UNION must not be adopted over the
   * expression's own: the LEFT operand of `&&`, `||`, or `??`. Adopting a
   * contextual union is normally safe because tsc proved the value
   * assignable to the slot; that proof does not exist here, because tsc
   * builds a logical operator's result by DROPPING the left's falsy (or
   * nullish) arms. `const s: string | null = (c ? env : undefined) || null`
   * contextually types the ternary `string | null` while its value is
   * `string | undefined` — adopting that strands the very arm the operator
   * exists to answer, throwing where Node yields the default. Such operands
   * represent by their own union; the operator's own lowering re-tags on
   * the branch where the dropped arms are gone. Narrow by design: only the
   * union choice is unsound here. A contextual ARRAY still types the
   * element, and an unmappable own type still falls back to the context. */
  inLogicalLeftPosition(node: ts.Expression): boolean {
    let n: ts.Node = node;
    while (n.parent && ts.isParenthesizedExpression(n.parent)) n = n.parent;
    const p = n.parent;
    if (!p || !ts.isBinaryExpression(p) || p.left !== n) return false;
    const k = p.operatorToken.kind;
    return (
      k === ts.SyntaxKind.AmpersandAmpersandToken ||
      k === ts.SyntaxKind.BarBarToken ||
      k === ts.SyntaxKind.QuestionQuestionToken
    );
  }

  /** True when a ?. token blocks this lowering — i.e. it is NOT the one an
   * active optional-chain lowering is currently handling. Every receiver-
   * typed lowering that supports chained receivers guards with this
   * instead of a raw questionDotToken check. */
  chainBlocked(
    ...nodes: (ts.CallExpression | ts.PropertyAccessExpression | ts.ElementAccessExpression)[]
  ): boolean {
    return nodes.some((n) => n.questionDotToken !== undefined && !this.chainHandled.has(n));
  }

  /** formatIrType with this Lowerer's registries (records and unions expand
   * to their structure in diagnostics). */
  fmt(t: IrType): string {
    return formatIrType(t, this.shapes, this.unions);
  }

  /** Whether an IR value has JavaScript Array identity. Homogeneous arrays
   * use the native array representation; non-empty fixed tuples use a
   * positional record shape so their slots can keep distinct types, but
   * Array.isArray must still answer true for both representations. */
  isArrayValueType(t: IrType): boolean {
    return t.kind === "array" || (t.kind === "record" && this.shapes.get(t.shapeId)?.tuple === true);
  }

  /** Runtime tags of every JavaScript-array arm in one union. Kept beside
   * isArrayValueType so Array.isArray's predicate and its narrowing bridge
   * cannot disagree about fixed tuple arms. */
  arrayValueTags(unionId: string): number[] {
    const def = this.unions.get(unionId);
    return def ? def.arms.flatMap((arm, tag) => (this.isArrayValueType(arm) ? [tag] : [])) : [];
  }

  /** isJsonSafeType with this Lowerer's registries — the shared fence for
   * what JSON.stringify accepts and what a checked cast can validate. */
  jsonSafe(t: IrType): boolean {
    return isJsonSafeType(
      t,
      (id) => this.shapes.get(id),
      (id) => this.unions.get(id),
    );
  }

  /** True when a type is a BARE undefined-armed union — the one JSON-unsafe
   * shape whose rejections deserve their own wording: Node's stringify of
   * bare undefined is not a string at all and JSON text never matches the
   * arm, so exactness is unreachable and the fixes (narrow first / null arm
   * / make it an optional record FIELD, where drop-and-absent semantics ARE
   * Node's) are specific. Record fields don't count: an undefined-armed
   * union in field position is JSON-safe (isJsonSafeType), so a record that
   * still fails the fence does so for some other reason. */
  bareUndefinedArmedUnion(t: IrType): boolean {
    return isUndefinedArmedUnion(t, (id) => this.unions.get(id));
  }

  /** canCrossIslandBoundary with this Lowerer's registries — THE test
   * behind every marshal/exit decision (the implicit coercions, jsvalIn,
   * the checked island-exit cast). Rejections that follow a false answer
   * speak through boundaryIntoIslandMsg / boundaryOutOfIslandMsg. */
  boundarySafe(t: IrType): boolean {
    return canCrossIslandBoundary(
      t,
      (id) => this.shapes.get(id),
      (id) => this.unions.get(id),
    );
  }

  /** canExitIslandToType with this Lowerer's registries — the EXIT
   * direction's slightly wider test (bare undefined-armed unions of
   * JSON-safe data arms exit; the engine's undefined takes the undefined
   * arm before the JSON round trip). */
  boundaryExitSafe(t: IrType): boolean {
    return canExitIslandToType(
      t,
      (id) => this.shapes.get(id),
      (id) => this.unions.get(id),
    );
  }

  isIslandExpr(node: ts.Expression): boolean {
    return isIslandExpr(this, node);
  }

  /** True when this node's CHECKER type is proven `any[]`/`unknown[]`,
   * directly or through the intersection tsc builds for a readonly tuple
   * union (`(Model | readonly [Model, Command]) & any[]`; TS7 distributes
   * this over the union arms). These are forms of the `arg is any[]`
   * Array.isArray predicate; the VALUE behind them can still be a real
   * static array/tuple (maybeNarrow's bridge extracts the union's one
   * array-valued arm), so receiver-typed dispatch falls back to the LOWERED
   * type under this test. */
  checkerAnyArray(node: ts.Expression): boolean {
    return this.checkerAnyArrayType(this.typeOf(node));
  }

  /** Type-level half of checkerAnyArray, for narrowing sites that already
   * queried the checker type from a general AST node. */
  checkerAnyArrayType(t: ts.Type): boolean {
    const isAnyArray = (part: ts.Type): boolean =>
      this.checker.isArrayType(part) &&
      ((this.checker.getTypeArguments(part as ts.TypeReference)[0]?.flags ?? 0) &
        (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
    const visit = (part: ts.Type): boolean => {
      if (isAnyArray(part)) return true;
      // 5.9 leaves `(U) & any[]` as one intersection; 7 distributes it
      // into `(A & any[]) | (B & any[])`. An intersection is array-proven
      // when one constituent is; a union is array-proven only when EVERY
      // arm is, so an ordinary `any[] | string` never qualifies.
      if ((part.flags & ts.TypeFlags.Intersection) !== 0) {
        return ts.constituentTypes(part).some(visit);
      }
      if (part.isUnionType()) return ts.constituentTypes(part).every(visit);
      return false;
    };
    return visit(t);
  }

  /** The lowered static array/tuple value behind checkerAnyArray's
   * synthetic `any[]` spelling. Array.isArray can leave readonly tuple
   * unions as intersections that do not map directly, while maybeNarrow
   * still extracts the runtime-proven array arm from the original union.
   * Receiver dispatchers use this bridge instead of the synthetic type. */
  checkerArrayValue(node: ts.Expression): IrExpr | null {
    if (!this.checkerAnyArray(node)) return null;
    const value = this.lowerExpr(node);
    return this.isArrayValueType(value.type) ? value : null;
  }

  /** Substitutes a bound type parameter anywhere inside mapType's recursion
   * (`T`, `T[]`, `{ v: T }`, `(x: T) => T` all resolve). Inert outside
   * generic instantiation. */
  readonly typeParamResolver = (t: ts.Type): IrType | null => {
    if (!this.typeParamBindings || !(t.flags & ts.TypeFlags.TypeParameter)) return null;
    const sym: ts.Symbol | undefined = t.getSymbol();
    return (sym && this.typeParamBindings.get(sym)) ?? null;
  };

  /** The ts-level twin of typeParamResolver: the bound CHECKER type of a
   * type parameter in the current instantiation (typeParamTsBindings), for
   * the resolutions where mapType's widening already dropped what the body
   * needs (indexed accesses over literal-bound keys). Inert outside
   * call-keyed generic instantiation. */
  readonly typeParamTsResolver = (t: ts.Type): ts.Type | null => {
    if (!this.typeParamTsBindings || !(t.flags & ts.TypeFlags.TypeParameter)) return null;
    const sym: ts.Symbol | undefined = t.getSymbol();
    return (sym && this.typeParamTsBindings.get(sym)) ?? null;
  };

  irTypeOf(node: ts.Node): IrType {
    const t = this.typeOf(node);
    // A never-tainted JS type (neverTaintedJsType) maps — never rides as
    // f64 — but must not: pre-empt the mapping so the JS fallback below
    // answers instead.
    const mapped = neverTaintedJsType(this, node, t) ? null : this.mapTypeOf(t);
    if (!mapped) {
      // The checked-dynamic declaration fallback (dynFallbackType): a
      // JAVASCRIPT binding of any inference residue, or a TypeScript
      // binding of genuine checker-`any`, becomes the checked-dynamic
      // kind instead of a compile fence — 'unknown' with the boundary
      // checks coerceToExpected already applies (dynFrom into the slot,
      // validated dynCheck out) and per-site fences for operations dyn
      // cannot carry. JS arrays keep their array-ness (any[]/never[]
      // evolving arrays become unknown[]), so length/push/index still
      // lower.
      const dyn = dynFallbackType(this, node, t);
      if (dyn) return dyn;
      this.badType(node, t);
    }
    return mapped;
  }

  /** Exact-shape enforcement (SC2002). Records are monomorphic structs, so
   * everywhere a value flows into a typed slot (call arg, initializer,
   * assignment, field, return) the shapes must MATCH — or width-coerce:
   * coerceToExpected already ran widthCoerce (the copy-reshape family),
   * so what reaches here is the RESIDUE its rules decline, and the
   * diagnostic names the first blocking rule (describeRecordWidthBlocker).
   * Non-record mismatches are not reachable through tsc-clean programs; the
   * validator ICEs on them as the usual backstop. */
  requireExactShape(node: ts.Node, actual: IrType, expected: IrType): void {
    if (typeEquals(actual, expected)) return;
    // dyn mismatches first. A dyn ('unknown') value flowing into a typed
    // slot needs a CHECKED cast — the hint points at `as <type>`; tsc
    // usually rejects this before we do, so the fence is mostly defensive.
    // The reverse — a TYPED value flowing into an 'unknown' slot
    // (`const u: unknown = 5`, an unknown-typed param/return) — IS tsc-clean
    // and rejected here: a typed value has no dynamic representation
    // (constructing a dyn from static values is deliberately out this
    // round; only JSON.parse results are dyn).
    if (actual.kind === "dyn") {
      this.unsupported(
        "SC1100",
        node,
        `passing 'unknown' values where '${this.fmt(expected)}' is expected`,
      );
    }
    if (expected.kind === "dyn") {
      // Function values BOX into dyn when their signature crosses
      // (canBoxFuncIntoDyn — coerceToExpected already converted those), so
      // reaching here with a func means a param/result type outside the
      // conversion domains, a generic signature's residue, or an overload
      // set — name the shape instead of the generic typed-to-unknown
      // wording.
      if (actual.kind === "func") {
        this.unsupported(
          "SC1101",
          node,
          `passing '${this.fmt(actual)}' function values into 'unknown' slots (a parameter or result type has no dynamic representation — only JSON-safe data, Uint8Array, undefined-armed unions of those, 'unknown', and functions over the same set cross)`,
        );
      }
      this.unsupported("SC1101", node);
    }
    // jsval mismatches surviving coerceToExpected involve a type with no
    // island representation (in) or no validated exit (out).
    if (actual.kind === "jsval") {
      this.unsupported("SC1090", node, boundaryOutOfIslandMsg(this.fmt(expected)));
    }
    if (expected.kind === "jsval") {
      this.unsupported("SC1090", node, boundaryIntoIslandMsg(this.fmt(actual)));
    }
    // Class-value mismatches: the pointed stories — a widening whose
    // constructor ABIs differ (construction through the slot would
    // dispatch a mismatched signature), or a structural flow between
    // unrelated classes (nominal identity is the IR's only class
    // subtyping, instances and values alike).
    if (actual.kind === "classval" && expected.kind === "classval") {
      const sub = this.classes.get(actual.className);
      const sup = this.classes.get(expected.className);
      if (sub && sup && this.isSubclassOf(actual.className, expected.className)) {
        this.unsupported(
          "SC1090",
          node,
          `class values whose constructor signatures differ ('${this.fmt(actual)}' into a '${this.fmt(expected)}' slot: construction through the slot completes against the base signature, which '${sub.def.jsName ?? actual.className}' does not share — declare matching constructor parameters)`,
        );
      }
      this.unsupported(
        "SC1090",
        node,
        `structurally-typed class-value flows ('${this.fmt(actual)}' into a '${this.fmt(expected)}' slot: only a class and its subclasses share a slot — extend the base class)`,
      );
    }
    // Union-involving mismatches first: a union flowing into a different
    // union's slot (even a superset) would need a runtime re-tag — its own
    // diagnostic, not the record one. Arm-into-union coercions were already
    // wrapped by coerceToExpected before this check runs.
    if (containsUnion(actual) || containsUnion(expected)) {
      this.pushDiag(unionMismatchDiag(this.fmt(expected), this.fmt(actual), locOf(node)));
      throw new PoisonError();
    }
    if (containsRecord(actual) || containsRecord(expected)) {
      // A record→record pair gets the pointed story: WHICH width rule
      // declined (a field that doesn't lift, a required field with no
      // source, an index signature that could hold the completed key).
      const detail =
        actual.kind === "record" && expected.kind === "record"
          ? (this.describeRecordWidthBlocker(actual.shapeId, expected.shapeId) ?? undefined)
          : undefined;
      this.pushDiag(recordShapeMismatchDiag(this.fmt(expected), this.fmt(actual), locOf(node), detail));
      throw new PoisonError();
    }
    // Everything else — a plain-kind mismatch like a string flowing into a
    // class-instance slot — is tsc-rejected in the lowering world and only
    // reaches here through preflight's project-world second chance (e.g. a
    // Promise reject called with a non-Error reason, clean under the lib's
    // `reason?: any`). The honest fence; silence would hand the emitter a
    // reinterpret and the validator an ICE.
    this.unsupported(
      "SC1090",
      node,
      `'${this.fmt(actual)}' values where '${this.fmt(expected)}' is expected`,
    );
  }

  /** Unwraps a HYBRID (function-with-properties) record to its callable:
   * a record whose shape carries the reserved `%call` func field reads
   * that field; anything else returns unchanged. The consumer half of
   * types.ts's chalk-shape mapping — call paths and func-slot coercions
   * share it. */
  hybridCallUnwrap(expr: IrExpr): IrExpr {
    if (expr.type.kind !== "record") return expr;
    const shape = this.shapes.get(expr.type.shapeId);
    const call = shape?.fields.find((f) => f.name === "%call");
    if (!call || call.type.kind !== "func") return expr;
    return { kind: "recordGet", obj: expr, shapeId: expr.type.shapeId, field: "%call", type: call.type, loc: expr.loc };
  }

  /** The tag of the union arm equal to `arm`, or -1 (unknown union / no
   * such arm). Arm lists are canonical (typeKey-sorted) and interned, so
   * this is THE tag for that (union, arm) pair program-wide — every wrap,
   * narrow, and tag test agrees by construction. */
  armTag(unionId: string, arm: IrType): number {
    const def = this.unions.get(unionId);
    return def ? def.arms.findIndex((a) => typeEquals(a, arm)) : -1;
  }

  /** Implicit union construction. Wherever a value flows into a typed slot
   * (initializer, assignment, call argument, return, field write, record
   * literal field, ternary arm) whose expected type is a union and the
   * value's type is one of its arms, wrap it in a `unionWrap` carrying the
   * arm's canonical tag. Same-union values pass through untouched; anything
   * else (including a DIFFERENT union) is left for requireExactShape, which
   * rejects union mismatches with SC2003. */
  coerceToExpected(expr: IrExpr, expected: IrType): IrExpr {
    // Island boundary, both directions. IN: any static value flowing into
    // an any-typed slot marshals implicitly (tsc allows the assignment;
    // the marshal is where its semantics live). OUT: an 'any' value
    // flowing into a typed slot compiles to a VALIDATED exit — like every
    // dyn→static edge, trust-but-verify: a lying `any` throws a catchable
    // TypeError instead of corrupting memory (SEMANTICS.md). Unmarshalable
    // and unextractable types fall through to requireExactShape's fences.
    if (expected.kind === "jsval" && expr.type.kind !== "jsval") {
      // Bare unit literals: the engine's own undefined/null (units have no
      // other producers, so dropping the operand loses nothing).
      if (isUnitType(expr.type)) {
        return { kind: "jsOp", op: expr.type.kind === "undefinedT" ? "undefLit" : "nullLit", args: [], type: JSVAL, loc: expr.loc };
      }
      // A CHECKED-DYNAMIC (dyn/'unknown') value entering the island (the
      // `isJson ? JSON.parse(text) : islandParser(text)` config ternary):
      // the dyn tree deep-copies into engine values — data kinds only; a
      // dyn carrying a boxed function/handle/promise throws the catchable
      // TypeError at runtime (trust-but-verify, like every boundary).
      if (expr.type.kind === "dyn") {
        return { kind: "jsMarshal", value: expr, type: JSVAL, loc: expr.loc };
      }
      if (this.boundarySafe(expr.type)) {
        return { kind: "jsMarshal", value: expr, type: JSVAL, loc: expr.loc };
      }
      // Closures cross as host functions when their signature marshals —
      // the same shapes jsvalIn admits at call arguments (`const f: any =
      // (x: number) => x * 3` is the declaration-slot spelling of the
      // package-callback pattern).
      if (
        expr.type.kind === "func" &&
        canMarshalTypedFuncIntoIsland(expr.type, (id) => this.shapes.get(id), (id) => this.unions.get(id))
      ) {
        return { kind: "jsMarshal", value: expr, type: JSVAL, loc: expr.loc };
      }
      // jsval-BEARING composites (a record holding `any` fields, an array
      // of such records) have no JSON marshal but an honest per-field
      // island construction — see jsvalLiftExpr.
      if (this.jsvalLiftable(expr.type)) {
        return this.jsvalLiftExpr(expr, expr.loc);
      }
      // A RegExp flowing into an 'any' slot: the fresh-engine-RegExp
      // rebuild (see jsvalIn's regex rule); computed regex values fall
      // through to requireExactShape's fence.
      if (expr.type.kind === "regex") {
        const re = islandRegexpOf(expr);
        if (re) return re;
      }
      return expr;
    }
    if (expr.type.kind === "jsval" && expected.kind !== "jsval") {
      // The jsval→dyn crossing (the world unification's engine-handle
      // kind): an 'any'-typed engine value flowing into an 'unknown'/
      // 'object'/JS-residue slot wraps BY REFERENCE as the checked-dynamic tree's island
      // kind — engine scalars normalize to native dyn kinds at wrap time,
      // typeof/truthiness/String()/=== route to the engine, un-armed dyn
      // walks fence loudly, and the value unwraps back identity-preserved
      // (scr_jsval_from_dyn). Monotone under evolution/widening: a value
      // wraps once at its first dyn edge and stays valid through every
      // subsequent dyn slot; narrowing never changes representation.
      // This wrap RETIRES the silent-wrong-answer fence-closure box for
      // jsval members of dyn object literals (lowerDynObjectLiteral's
      // coercion lands here first).
      if (expected.kind === "dyn") {
        return { kind: "dynFromJsval", value: expr, type: DYN, loc: expr.loc };
      }
      // An island value flowing into a PROMISE-typed slot (the inferred
      // `loadPlugins` return — `Promise.all(...)` lowered engine-side
      // against a Promise<any[]> inference): the island→static promise
      // bridge — the engine promise settles a fresh static promise (void
      // fulfillments drop, `any[]`-declared fulfillments exit
      // Array.isArray-gated by reference at the settle, 'any' parks as an
      // island handle). Only inner shapes the bridge can deliver take the
      // arm; the rest keep the exit fence with the type named.
      if (
        expected.kind === "promise" &&
        (expected.inner.kind === "void" ||
          expected.inner.kind === "jsval" ||
          (expected.inner.kind === "array" && expected.inner.elem.kind === "jsval"))
      ) {
        return { kind: "jsBridgePromise", value: expr, type: expected, loc: expr.loc };
      }
      // The exit set: everything round-trippable, plus bare undefined-armed
      // unions of JSON-safe data arms (the engine's undefined takes the
      // undefined arm before the JSON detour) — canExitIslandToType.
      if (this.boundaryExitSafe(expected)) {
        return { kind: "jsExit", value: expr, type: expected, loc: expr.loc };
      }
      return expr;
    }
    // A TYPED value flowing into an 'unknown' slot (`const u: unknown = 5`,
    // an unknown-typed param/return, a dyn-valued index slot): the
    // static→dyn conversion — dynFrom, a DEEP COPY (the jsMarshal aliasing
    // stance intoIndexValueSlot documents; SEMANTICS.md). Bare
    // undefined/null literals store the dyn unit values. Types outside the
    // dyn's domain (bytes, classes, Maps, ...) fall through to
    // requireExactShape's SC1101 fence.
    // A promise flowing into a VOID-promise slot (an inferred
    // Promise<never> return holding a `return Promise.reject(value)` the
    // dyn arm typed promise<dyn>): awaiting through the slot ignores the
    // fulfillment payload (scr_await_void) and rejections flow untyped,
    // so the value passes through — one C representation, no adapter.
    if (
      expected.kind === "promise" &&
      expected.inner.kind === "void" &&
      expr.type.kind === "promise" &&
      expr.type.inner.kind !== "void"
    ) {
      return { kind: "promiseVoidWiden", value: expr, type: expected, loc: expr.loc };
    }
    if (expected.kind === "dyn" && expr.type.kind !== "dyn") {
      if (expr.kind === "unitLit" || this.dynConvertible(expr.type)) {
        return { kind: "dynFrom", value: expr, type: DYN, loc: expr.loc };
      }
      // An error-HIERARCHY object (builtin subclass or user `extends
      // Error` class) upcasts to the %Error root first — the caughtToDyn
      // encoding (scr_dyn_from_error) carries name/message/code and the
      // runtime CACHES the identity edge, so `instanceof TypeError` on
      // the dyn side still answers exactly (dyn.errInstanceof). Only the
      // root spelling was convertible before; the harness passes typed
      // errors into untyped helpers constantly.
      if (expr.type.kind === "object" && this.errorHierarchyClassOf(expr.type.className)) {
        return {
          kind: "dynFrom",
          value: this.upcastTo(expr, "%Error"),
          type: DYN,
          loc: expr.loc,
        };
      }
      return expr;
    }
    // A dyn ('unknown') ACTUAL flowing into a typed slot the checker
    // approved (an assertion function's narrowing, the error-any world's
    // forgiven chains): the VALIDATED extraction — dynCheck, the
    // checked-cast machinery, applied automatically. Trust-but-verify,
    // exactly the island exit's stance: a value that doesn't match the
    // slot's type throws a catchable TypeError instead of misreading the
    // payload. Only dynCheck's own domain (JSON-representable types,
    // undefined-armed unions of those, bytes<u8>, the %Error root)
    // converts; everything else keeps requireExactShape's SC1100 fence.
    if (expr.type.kind === "dyn" && expected.kind !== "dyn") {
      const undefArmedOk =
        expected.kind === "union" &&
        (this.unions
          .get(expected.unionId)
          ?.arms.every((a) => a.kind === "undefinedT" || this.jsonSafe(a)) ??
          false);
      const bytesOk = expected.kind === "bytes" && expected.elem === "u8";
      const errorOk = expected.kind === "object" && expected.className === "%Error";
      // ADAPTABLE function targets (the checked-dynamic function
      // boundary's OUT direction — `const wrapped: F = mustCall(fn)`):
      // check callable-kind, then unwrap an identical boxed signature
      // directly or adapt through a per-target shim that dynChecks
      // arguments/results per F.
      const funcOk =
        expected.kind === "func" &&
        canAdaptDynFuncTo(expected, (id) => this.shapes.get(id), (id) => this.unions.get(id));
      if (this.jsonSafe(expected) || undefArmedOk || bytesOk || errorOk || funcOk) {
        return { kind: "dynCheck", value: expr, type: expected, loc: expr.loc };
      }
      return expr;
    }
    // A HYBRID (function-with-properties) record flowing into a plain
    // func slot extracts its reserved %call field — the chalk shape's
    // "the value IS callable" half (types.ts's hybrid mapping).
    if (expected.kind === "func" && expr.type.kind === "record") {
      const un = this.hybridCallUnwrap(expr);
      if (un !== expr && typeEquals(un.type, expected)) return un;
    }
    // A zero-param function whose RETURN is a wider record array than the
    // slot's (`getRoutes: () => cachedRoutes` against `() => Narrow[]`):
    // the interned width adapter wraps it — each call maps the result
    // through the per-element record width copy.
    if (
      expected.kind === "func" &&
      expr.type.kind === "func" &&
      !typeEquals(expr.type, expected) &&
      expr.type.params.length === 0 &&
      expected.params.length === 0
    ) {
      const adapter = this.funcReturnWidthAdapter(expr.type, expected, expr.loc);
      if (adapter) {
        return { kind: "call", callee: adapter, args: [expr], type: expected, loc: expr.loc };
      }
    }
    // JS func-into-func mismatches ride the checked-dynamic function
    // boundary: box the value (dynFrom), adapt to the slot (dynCheck) —
    // the thunk delivers JS arity exactly (extras ignored, missing args
    // the undefined dyn value), so `return _return` fits _mustCallInner's
    // inferred (unknown) => unknown slot even though the wrapper declares
    // (). JS files only: TypeScript signatures keep the exact-shape
    // fences (a mismatch there is a compile-time story, not a boundary).
    if (expected.kind === "func" && expr.type.kind === "func" && !typeEquals(expr.type, expected)) {
      const sf = this.program.getSourceFile(expr.loc.file);
      if (
        sf !== undefined && isJsSourceFile(sf) &&
        canConvertToDyn(expr.type, (id) => this.shapes.get(id), (id) => this.unions.get(id)) &&
        canAdaptDynFuncTo(expected, (id) => this.shapes.get(id), (id) => this.unions.get(id))
      ) {
        return {
          kind: "dynCheck",
          value: { kind: "dynFrom", value: expr, type: DYN, loc: expr.loc },
          type: expected,
          loc: expr.loc,
        };
      }
    }
    // A spawnSync-runner value (`defaultRunner` — its inferred return is
    // the opaque spawnRes) flowing into a slot whose signature returns
    // the structural result record tsc accepted: the interned adapter
    // forwards the call and converts the result field-wise.
    if (expected.kind === "func" && expr.type.kind === "func" && !typeEquals(expr.type, expected)) {
      const adapter = this.spawnResFnAdapter(expr.type, expected, expr.loc);
      if (adapter) {
        return { kind: "call", callee: adapter, args: [expr], type: expected, loc: expr.loc };
      }
    }
    // The GENERAL function-value adapter (funcCoerceAdapter): a function
    // whose signature differs from the slot's only by coercible pieces —
    // fewer parameters (JS ignores extras: `load(function () {})` into an
    // `(x?: string) => void` slot), parameters/results that wrap into
    // union arms, re-tag union-to-union, take a checked narrow, or cross
    // the dyn boundary — wraps in a fresh closure applying exactly those
    // conversions per call. Runs after the specialized adapters above so
    // their pointed shapes keep winning.
    if (expected.kind === "func" && expr.type.kind === "func" && !typeEquals(expr.type, expected)) {
      const adapter = this.funcCoerceAdapter(expr.type, expected, expr.loc);
      if (adapter) {
        return { kind: "call", callee: adapter, args: [expr], type: expected, loc: expr.loc };
      }
    }
    // Derived-into-base widening: a legal implicit upcast (prefix layout —
    // a pointer reinterpret). Exactness stays required in every other
    // direction; there is never an implicit DOWNcast.
    if (
      expected.kind === "object" &&
      expr.type.kind === "object" &&
      expr.type.className !== expected.className &&
      this.isSubclassOf(expr.type.className, expected.className)
    ) {
      return { kind: "upcast", value: expr, type: expected, loc: expr.loc };
    }
    // CLASS-VALUE widening (classval:D into a classval:C slot): the same
    // pointer with only the static type changing — legal exactly when D
    // strictly descends from C AND the two completed constructor ABIs
    // agree, the invariant `newValue` completion against C's one
    // signature rests on. Mismatches fall through to requireExactShape's
    // pointed class-value fences.
    if (
      expected.kind === "classval" &&
      expr.type.kind === "classval" &&
      expr.type.className !== expected.className &&
      this.isSubclassOf(expr.type.className, expected.className)
    ) {
      const sub = this.classes.get(expr.type.className);
      const sup = this.classes.get(expected.className);
      // A generic FAMILY as the destination (`new () => Box<any>` slots):
      // no `%<family>.constructor` exists for the validator's ABI check
      // and no completion target is meaningful — the exact-shape fence
      // downstream names the class-value flow instead.
      if (sub && sup && !sup.generic && this.ctorAbiEquals(sub, sup)) {
        return { kind: "upcast", value: expr, type: expected, loc: expr.loc };
      }
    }
    if (expected.kind !== "union" || typeEquals(expr.type, expected)) {
      // A UNION value flowing into one of its own ARMS: the checker
      // proved the narrowing (control flow through a destructured
      // binding, `d ?? (d = ...)`, a predicate call — tsc typed the SITE
      // as the arm; the IR value still carries the declaration's union)
      // — the CHECKED extraction, exactly `x!`'s machinery: the proven
      // arm's payload comes out, every other arm throws the catchable
      // TypeError (divergence 38's lying-assertion stance — sound
      // narrowing never reaches them).
      if (
        expr.type.kind === "union" &&
        !isUnitType(expected) &&
        expected.kind !== "void" &&
        this.armTag(expr.type.unionId, expected) >= 0
      ) {
        const helper = this.narrowedArmHelper(expr.type.unionId, expected, expr.loc);
        if (helper) {
          return { kind: "call", callee: helper, args: [expr], type: expected, loc: expr.loc };
        }
      }
      if (!typeEquals(expr.type, expected)) {
        const w = this.widthCoerce(expr, expected);
        if (w) return w;
        // A UNIT (null/undefined) flowing into a plain non-nullable slot
        // the checker approved (`null!` casts, non-strict assignments):
        // the stranded-source stance (divergence 38) without a union in
        // sight — the flow compiles to the catchable TypeError, where
        // Node lets the impossible value ride until (unless) it is used.
        const trap = this.strandedUnitTrap(expr, expected, expr.loc);
        if (trap) return trap;
      }
      return expr;
    }
    if (expr.type.kind === "union") {
      // A DIFFERENT union flowing into this slot: re-tag at runtime when
      // every arm maps (unionRetagHelper); anything unmappable falls
      // through to requireExactShape's SC2003.
      const helper = this.unionRetagHelper(expr.type.unionId, expected.unionId, expr.loc);
      if (helper) {
        return { kind: "call", callee: helper, args: [expr], type: expected, loc: expr.loc };
      }
      return expr;
    }
    if (expr.type.kind === "void") {
      // A void CALL RESULT flowing into a union with an undefined arm
      // (`var r = foo({})` where foo returns void — tsc's void slots map
      // to undefined-armed unions): JS's void value IS undefined, so the
      // wrap takes the undefined arm. The backends evaluate the void
      // operand for its effects and produce the interned unit instance
      // (the unionWrap void-payload rule).
      const undefTag = this.armTag(expected.unionId, UNDEFINED_T);
      if (undefTag >= 0) {
        return { kind: "unionWrap", unionId: expected.unionId, tag: undefTag, value: expr, type: expected, loc: expr.loc };
      }
      return expr;
    }
    const tag = this.armTag(expected.unionId, expr.type);
    if (tag < 0) {
      // A derived class flowing into a union with a base-class arm widens
      // first (nearest ancestor arm wins), then wraps like any arm value.
      if (expr.type.kind === "object") {
        for (let c = this.classes.get(expr.type.className)?.base ?? null; c; c = c.base) {
          const baseTag = this.armTag(expected.unionId, { kind: "object", className: c.def.name });
          if (baseTag >= 0) {
            const widened = this.upcastTo(expr, c.def.name);
            return { kind: "unionWrap", unionId: expected.unionId, tag: baseTag, value: widened, type: expected, loc: expr.loc };
          }
        }
      }
      // A derived CLASS VALUE against a union with a base classval arm
      // (`typeof Base | undefined` slots receiving D): the same nearest-
      // ancestor widening, gated by the constructor-ABI rule; a mismatch
      // falls through to the union fence.
      if (expr.type.kind === "classval") {
        const sub = this.classes.get(expr.type.className);
        for (let c = sub?.base ?? null; c; c = c.base) {
          const baseTag = this.armTag(expected.unionId, { kind: "classval", className: c.def.name });
          if (baseTag >= 0) {
            if (!sub || !this.ctorAbiEquals(sub, c)) break;
            const widened: IrExpr = { kind: "upcast", value: expr, type: { kind: "classval", className: c.def.name }, loc: expr.loc };
            return { kind: "unionWrap", unionId: expected.unionId, tag: baseTag, value: widened, type: expected, loc: expr.loc };
          }
        }
      }
      // A width-coercible value against a union: coerce into the SINGLE
      // width-liftable arm, then wrap like any arm value (widthLiftPlan's
      // liftWrap — several candidate arms are ambiguous and decline).
      const lift = this.widthLiftPlan(expr.type, expected);
      if (lift) return this.applyWidthLift(lift, expr, expected, expr.loc);
      // Arms OUTSIDE widthLiftPlan's domain keep the historic per-arm
      // widthCoerce probe (first match): index-signature record arms (the
      // overflow CAPTURE helper owns their reshapes) and `any[]` arms
      // (the island-boundary per-element lift). Bounded to those arm
      // shapes so the plan's ambiguity rule for record/array lifts is
      // never undone by a first-match fallback.
      {
        const def = this.unions.get(expected.unionId);
        if (def) {
          for (let i = 0; i < def.arms.length; i++) {
            const arm = def.arms[i]!;
            const boundaryArm =
              (arm.kind === "record" && this.shapes.get(arm.shapeId)?.indexValue !== undefined) ||
              (arm.kind === "array" && arm.elem.kind === "jsval");
            if (!boundaryArm) continue;
            const w = this.widthCoerce(expr, arm);
            if (w) {
              return { kind: "unionWrap", unionId: expected.unionId, tag: i, value: w, type: expected, loc: expr.loc };
            }
          }
        }
      }
      // A checker-approved value the union CANNOT represent: a unit
      // (`getV(): Foo | Bar { return null! }`, `null as any as T`), or a
      // record/array with NO width-lift candidate at all (`{} as
      // InstanceOne | InstanceTwo`). Every one is a LYING assertion —
      // tsc accepted the flow only through a cast/assertion our arm list
      // proves impossible — so it compiles to the stranded-arm TRAP
      // (divergence 38's stance: the catchable TypeError at the flow,
      // where Node lets the impossible value ride). AMBIGUOUS width
      // candidates stay compile fences: honest code lands there.
      {
        const trap = this.strandedCoercionTrap(expr, expected, expr.loc);
        if (trap) return trap;
      }
      return expr;
    }
    return { kind: "unionWrap", unionId: expected.unionId, tag, value: expr, type: expected, loc: expr.loc };
  }

  /** Copy-based structural WIDTH coercion — a `Full` record flowing into a
   * narrower `{ id }` slot, or `Full[]` into `{ id }[]` (the Pick-typed
   * display-table pattern): TS's width subtyping is free on erased types,
   * but monomorphic structs must RESHAPE, so the value is rebuilt with the
   * subset of fields copied — per element, via an interned helper, for
   * arrays. A deliberate divergence from JS's aliasing (SEMANTICS.md 35,
   * next to the marshal-copy stance): mutations through the narrowed value
   * don't reach the original and vice versa. Exactly two flows coerce —
   * record→record and record-array→record-array, each target field copied
   * from a same-named source field whose type matches exactly or LIFTS
   * into the target field's union (see recordWidthHelper); anything
   * deeper keeps the exactness fences. Null when the pair isn't
   * width-coercible. */
  widthCoerce(expr: IrExpr, expected: IrType): IrExpr | null {
    if (expected.kind === "record" && expr.type.kind === "record") {
      // Index-signature pairs reshape through the overflow CAPTURE helper
      // (the `Object.fromEntries(e) as ModelPricing` pattern — declared
      // collisions validate at runtime); plain shapes keep the field-copy
      // width helper. Each declines the other's shapes.
      const helper =
        this.recordWidthHelper(expr.type.shapeId, expected.shapeId, expr.loc) ??
        lowerRecordOvfCaptureHelper(this, expr.type.shapeId, expected.shapeId, expr.loc);
      if (!helper) return null;
      return { kind: "call", callee: helper, args: [expr], type: expected, loc: expr.loc };
    }
    // A CLASS INSTANCE flowing into a record slot (`new Point(0, 0)` into
    // `{ x: number; y: number }` — tsc's structural view of classes): the
    // same field-projecting copy, each target field read off the instance.
    if (expected.kind === "record" && expr.type.kind === "object") {
      const helper = this.objRecordWidthHelper(expr.type.className, expected.shapeId, expr.loc);
      if (!helper) return null;
      return { kind: "call", callee: helper, args: [expr], type: expected, loc: expr.loc };
    }
    // A RECORD flowing into a class-instance slot (`{x: 0, y: 0}` into
    // `A.Point` — the parameter-property data-class pattern): construction
    // IS the projection when the constructor is nothing but parameter
    // properties (recordToClassPlan's gates).
    if (expected.kind === "object" && expr.type.kind === "record") {
      const helper = this.recordClassWidthHelper(expr.type.shapeId, expected.className, expr.loc);
      if (!helper) return null;
      return { kind: "call", callee: helper, args: [expr], type: expected, loc: expr.loc };
    }
    // A CLASS VALUE flowing into a record slot (`var f: ShapeFactory =
    // Shape` — an interface matched by the class's STATIC side): the
    // record captures the statics — fields as copies, methods as the
    // zero-capture closures `const f = C.m` builds. Direct classRef
    // sources only: the projection reads no runtime value, so an effectful
    // source expression would lose its evaluation.
    if (expected.kind === "record" && expr.type.kind === "classval" && expr.kind === "classRef") {
      return this.classStaticsProjection(expr.type.className, expected.shapeId, expr.loc);
    }
    if (expected.kind === "array" && expr.type.kind === "array" && expected.elem.kind !== "jsval") {
      const helper = this.arrayWidthHelper(expr.type, expected, expr.loc);
      if (helper) return { kind: "call", callee: helper, args: [expr], type: expected, loc: expr.loc };
      // The EMPTY-array lift (widthLiftPlan's emptyArr rule), top-level:
      // `cmd.aliases` typed `(null | undefined)[]` (an `aliases: []`
      // table) flowing into a `string[]` slot.
      const lift = this.widthLiftPlan(expr.type, expected);
      if (lift?.how !== "emptyArr") return null;
      return this.applyWidthLift(lift, expr, expected, expr.loc);
    }
    // A TUPLE flowing into an array slot (`const NAMES = [...] as const`
    // assigned to a `readonly T[]` — the const-table pattern): TS erases
    // the arity for free; the monomorphic tuple REBUILDS as a fresh array,
    // each position's value lifted into the element type (the same copy
    // stance as every width coercion — later mutations don't alias).
    if (expected.kind === "array" && expr.type.kind === "record" && expected.elem.kind !== "jsval") {
      const helper = this.tupleArrayWidthHelper(expr.type.shapeId, expected, expr.loc);
      if (!helper) return null;
      return { kind: "call", callee: helper, args: [expr], type: expected, loc: expr.loc };
    }
    // An `any[]` slot: any liftable element becomes one island handle per
    // element (the messages-array pattern — records holding `any` content).
    if (
      expected.kind === "array" &&
      expected.elem.kind === "jsval" &&
      expr.type.kind === "array" &&
      expr.type.elem.kind !== "jsval"
    ) {
      const helper = this.arrayToJsvalArrayHelper(expr.type.elem, expr.loc);
      if (!helper) return null;
      return { kind: "call", callee: helper, args: [expr], type: expected, loc: expr.loc };
    }
    return null;
  }

  /** One step of the recursive width-lift relation: how a `src`-typed
   * value enters a `dst`-typed slot under the copy-reshape family. The
   * pure planning side — nothing interns here, so whole plans validate
   * before any helper exists. The cases, in order:
   *   copy      — exact same type (typeEquals), the field/element moves as is
   *   retag     — union into union, every arm mapped (unionRetagMappable —
   *               identity arms, trap-less; record/array arms may width-lift
   *               into exactly one destination arm)
   *   wrap      — a non-unit arm value into a union that contains it
   *   liftWrap  — a record/array value into a union with NO identical arm
   *               but exactly ONE arm it width-lifts into (the findRoute
   *               rule applied at every level; several candidates are
   *               ambiguous and decline)
   *   width     — record into a strict-subset record (recordWidthPlan,
   *               recursively — NESTED width)
   *   arr       — array into array whose element pair lifts (per-element
   *               copy loop, arrayWidthHelper)
   *   dynIn     — a typed value into an 'unknown' (dyn) slot — the same
   *               static→dyn deep copy coerceToExpected applies top-level
   *   upcast    — a derived class instance into a base-typed slot (the
   *               prefix-layout pointer reinterpret, no copy)
   *   funcAdapt — a function into a slot whose signature differs only by
   *               CLEAN mechanical conversions (cleanFuncAdaptable); the
   *               stranded (trap-only) dispositions stay out of the plan
   * Null when the pair isn't in the relation — callers keep their fences. */
  widthLiftPlan(src: IrType, dst: IrType): WidthLift | null {
    if (typeEquals(src, dst)) return { how: "copy" };
    // An 'unknown' (dyn) DESTINATION slot: the static→dyn conversion —
    // dynFrom, a DEEP COPY (`{ v: 5 }` into `{ v: unknown }`, `number[]`
    // into `unknown[]` — tsc's top type over the width family's copies).
    if (dst.kind === "dyn" && src.kind !== "dyn" && this.dynConvertible(src)) {
      return { how: "dynIn" };
    }
    if (dst.kind === "union") {
      if (src.kind === "union") {
        return this.unionRetagMappable(src.unionId, dst.unionId) ? { how: "retag" } : null;
      }
      // A unit-typed source can't wrap here (unionWrap requires the
      // LITERAL unit — and no lowered shape carries a bare unit field).
      if (isUnitType(src)) return null;
      const tag = this.armTag(dst.unionId, src);
      if (tag >= 0) return { how: "wrap", tag };
      const def = this.unions.get(dst.unionId);
      if (!def) return null;
      const candidates: { tag: number; arm: IrType }[] = [];
      def.arms.forEach((arm, i) => {
        if (isUnitType(arm)) return;
        const sameFamily =
          (src.kind === "record" && arm.kind === "record") ||
          (src.kind === "array" && arm.kind === "array") ||
          (src.kind === "object" && arm.kind === "record") ||
          (src.kind === "record" && arm.kind === "object");
        if (sameFamily && this.widthLiftPlan(src, arm) !== null) candidates.push({ tag: i, arm });
      });
      if (candidates.length !== 1) return null;
      return { how: "liftWrap", tag: candidates[0]!.tag, arm: candidates[0]!.arm };
    }
    // A UNION source into a slot that is ONE of its arms (a width copy
    // whose target field narrowed — the option-table choices shape:
    // `value: boolean | string` copying into a `value: string` slot the
    // checker approved): the CHECKED extraction — narrowedArmHelper,
    // exactly `x!`'s machinery — the proven arm's payload comes out, any
    // other arm throws the catchable TypeError (divergence 38's stance).
    if (src.kind === "union" && !isUnitType(dst) && dst.kind !== "void" && this.armTag(src.unionId, dst) >= 0) {
      return { how: "narrow" };
    }
    // A DERIVED instance into a BASE-typed slot (`{ p: Q }` copying into
    // `{ p: P }`): the same implicit upcast coerceToExpected performs at
    // top level — prefix layout, a pointer reinterpret, no copy.
    if (
      dst.kind === "object" &&
      src.kind === "object" &&
      this.isSubclassOf(src.className, dst.className)
    ) {
      return { how: "upcast" };
    }
    // A FUNCTION into a slot whose signature differs only by CLEAN
    // mechanical conversions (fewer params — JS ignores extras — and
    // coercibleValue pieces): the general function-value adapter, plan-
    // gated to the clean subset. The stranded (trap-only) dispositions
    // funcCoerceAdapter also builds stay TOP-LEVEL only: a width plan
    // never promises a bridge that can only throw.
    if (dst.kind === "func" && src.kind === "func" && this.cleanFuncAdaptable(src, dst)) {
      return { how: "funcAdapt" };
    }
    if (dst.kind === "record" && src.kind === "record") {
      return this.recordWidthPlan(src.shapeId, dst.shapeId) !== null ? { how: "width" } : null;
    }
    if (dst.kind === "record" && src.kind === "object") {
      return this.objToRecordPlan(src.className, dst.shapeId) !== null ? { how: "objWidth" } : null;
    }
    if (dst.kind === "object" && src.kind === "record") {
      return this.recordToClassPlan(src.shapeId, dst.className) !== null ? { how: "clsWidth" } : null;
    }
    if (dst.kind === "array" && src.kind === "array") {
      if (this.widthLiftPlan(src.elem, dst.elem) !== null) return { how: "arr" };
      // The EMPTY-array lift: a unit-only element type (`readonly []`
      // mapped as the unit-element array, `(null | undefined)[]`) has no
      // per-element conversion into a data element — but the only value
      // such a slot honestly holds in the width family is EMPTY, so the
      // lift is a fresh empty array of the target type, guarded by a
      // runtime non-empty trap (the checked-extraction stance).
      if (this.unitOnlyElem(src.elem) && dst.elem.kind !== "jsval" && !this.unitOnlyElem(dst.elem)) {
        return { how: "emptyArr" };
      }
      return null;
    }
    // A TUPLE flowing into an array FIELD/ELEMENT (`aliases: ["ls"]` into
    // an `aliases: string[]` slot): per-position lifts, the top-level
    // tuple-into-array coercion applied recursively.
    if (dst.kind === "array" && src.kind === "record" && dst.elem.kind !== "jsval") {
      const from = this.shapes.get(src.shapeId);
      if (from?.tuple && from.fields.every((f) => this.widthLiftPlan(f.type, dst.elem) !== null)) {
        return { how: "tupleArr" };
      }
      return null;
    }
    return null;
  }

  /** True for the unit-only element types (`(null | undefined)[]`, the
   * `readonly []` mapping): a union whose every arm is a unit. */
  unitOnlyElem(t: IrType): boolean {
    if (t.kind !== "union") return false;
    const def = this.unions.get(t.unionId);
    return def !== undefined && def.arms.every((a) => isUnitType(a));
  }

  /** The build side of widthLiftPlan: the IrExpr converting `value` into
   * `dst` under a plan the caller validated. Interns whatever helpers the
   * lift needs (planned first, so the interns cannot fail — a failure here
   * is a lowerer bug, not a user diagnostic). */
  applyWidthLift(lift: WidthLift, value: IrExpr, dst: IrType, loc: SrcLoc): IrExpr {
    switch (lift.how) {
      case "copy":
        return value;
      case "wrap": {
        if (dst.kind !== "union") throw new InternalCompilerError("lowerer bug: wrap lift against a non-union");
        return { kind: "unionWrap", unionId: dst.unionId, tag: lift.tag, value, type: dst, loc };
      }
      case "retag": {
        if (dst.kind !== "union" || value.type.kind !== "union") throw new InternalCompilerError("lowerer bug: retag lift shape");
        const retag = this.unionRetagHelper(value.type.unionId, dst.unionId, loc);
        if (!retag) throw new InternalCompilerError("lowerer bug: planned retag lift failed to intern");
        return { kind: "call", callee: retag, args: [value], type: dst, loc };
      }
      case "liftWrap": {
        if (dst.kind !== "union") throw new InternalCompilerError("lowerer bug: liftWrap lift against a non-union");
        const inner = this.widthLiftPlan(value.type, lift.arm);
        if (!inner) throw new InternalCompilerError("lowerer bug: planned liftWrap arm stopped lifting");
        const lifted = this.applyWidthLift(inner, value, lift.arm, loc);
        return { kind: "unionWrap", unionId: dst.unionId, tag: lift.tag, value: lifted, type: dst, loc };
      }
      case "width": {
        if (dst.kind !== "record" || value.type.kind !== "record") throw new InternalCompilerError("lowerer bug: width lift shape");
        const helper = this.recordWidthHelper(value.type.shapeId, dst.shapeId, loc);
        if (!helper) throw new InternalCompilerError("lowerer bug: planned width lift failed to intern");
        return { kind: "call", callee: helper, args: [value], type: dst, loc };
      }
      case "arr": {
        if (dst.kind !== "array" || value.type.kind !== "array") throw new InternalCompilerError("lowerer bug: arr lift shape");
        const helper = this.arrayWidthHelper(value.type, dst, loc);
        if (!helper) throw new InternalCompilerError("lowerer bug: planned arr lift failed to intern");
        return { kind: "call", callee: helper, args: [value], type: dst, loc };
      }
      case "tupleArr": {
        if (dst.kind !== "array" || value.type.kind !== "record") throw new InternalCompilerError("lowerer bug: tupleArr lift shape");
        const helper = this.tupleArrayWidthHelper(value.type.shapeId, dst, loc);
        if (!helper) throw new InternalCompilerError("lowerer bug: planned tupleArr lift failed to intern");
        return { kind: "call", callee: helper, args: [value], type: dst, loc };
      }
      case "emptyArr": {
        if (dst.kind !== "array" || value.type.kind !== "array") throw new InternalCompilerError("lowerer bug: emptyArr lift shape");
        const helper = this.emptyArrayLiftHelper(value.type, dst, loc);
        return { kind: "call", callee: helper, args: [value], type: dst, loc };
      }
      case "objWidth": {
        if (dst.kind !== "record" || value.type.kind !== "object") throw new InternalCompilerError("lowerer bug: objWidth lift shape");
        const helper = this.objRecordWidthHelper(value.type.className, dst.shapeId, loc);
        if (!helper) throw new InternalCompilerError("lowerer bug: planned objWidth lift failed to intern");
        return { kind: "call", callee: helper, args: [value], type: dst, loc };
      }
      case "clsWidth": {
        if (dst.kind !== "object" || value.type.kind !== "record") throw new InternalCompilerError("lowerer bug: clsWidth lift shape");
        const helper = this.recordClassWidthHelper(value.type.shapeId, dst.className, loc);
        if (!helper) throw new InternalCompilerError("lowerer bug: planned clsWidth lift failed to intern");
        return { kind: "call", callee: helper, args: [value], type: dst, loc };
      }
      case "narrow": {
        if (value.type.kind !== "union") throw new InternalCompilerError("lowerer bug: narrow lift on a non-union");
        const helper = this.narrowedArmHelper(value.type.unionId, dst, loc);
        if (!helper) throw new InternalCompilerError("lowerer bug: planned narrow lift failed to intern");
        return { kind: "call", callee: helper, args: [value], type: dst, loc };
      }
      case "dynIn": {
        if (dst.kind !== "dyn") throw new InternalCompilerError("lowerer bug: dynIn lift against a non-dyn slot");
        return { kind: "dynFrom", value, type: DYN, loc };
      }
      case "upcast": {
        if (dst.kind !== "object" || value.type.kind !== "object") throw new InternalCompilerError("lowerer bug: upcast lift shape");
        return this.upcastTo(value, dst.className);
      }
      case "funcAdapt": {
        if (dst.kind !== "func" || value.type.kind !== "func") throw new InternalCompilerError("lowerer bug: funcAdapt lift shape");
        const adapter = this.funcCoerceAdapter(value.type, dst, loc);
        if (!adapter) throw new InternalCompilerError("lowerer bug: planned funcAdapt lift failed to intern");
        return { kind: "call", callee: adapter, args: [value], type: dst, loc };
      }
      default: {
        const _exhaustive: never = lift;
        void _exhaustive;
        throw new InternalCompilerError("unreachable");
      }
    }
  }

  /** Interned `%rec.width.<n>(r)` — builds the target shape from a source
   * record by copying fields: every target field must exist on the source
   * with the EXACT same type, or with a type that LIFTS under
   * widthLiftPlan — an arm value wraps (`text: string` into
   * `text?: string`), a whole union re-tags (unionRetagMappable), a field
   * whose own record/array type needs narrowing reshapes RECURSIVELY
   * (nested width — the copy stance applies per level), and a MISSING
   * optional-flavored field completes to its undefined arm (the
   * literal-completion rule). TUPLES width-coerce too, arity-exact (TS
   * permits no other tuple width): per-position lifts, never completion.
   * Index-signature SOURCES narrow here like any wider record — declared
   * fields copy, the overflow drops with the width (missing target
   * fields decline: the overflow could hold them). Index-signature
   * TARGETS keep the overflow CAPTURE helper (widthCoerce's other arm).
   * Null when the shapes don't relate that way. */
  /** The pure planning half of recordWidthHelper — every target field's
   * lift, or null when the pair isn't width-coercible. Callers that must
   * validate a WHOLE plan before interning anything (the retag helper's
   * per-arm width lifts) probe with this. */
  recordWidthPlan(fromId: string, toId: string): Map<string, { src: IrType; lift: WidthLift } | { absent: true; utag: number } | { absentDyn: true }> | null {
    const from = this.shapes.get(fromId);
    const to = this.shapes.get(toId);
    // INDEX-SIGNATURE sources narrow like any wider record — the target
    // fields copy off the declared struct slots and the overflow drops
    // with the rest of the width (divergence 36's stance; the absent-
    // completion rule below is the one extra fence). Index-signature
    // TARGETS keep the overflow CAPTURE helper (widthCoerce's other arm):
    // a fresh hybrid needs keyed writes, not a field-list literal.
    if (!from || !to || to.indexValue) return null;
    // Tuple↔record pairs never relate; tuple↔tuple only arity-exact.
    if (!!from.tuple !== !!to.tuple) return null;
    if (from.tuple && from.fields.length !== to.fields.length) return null;
    const key = `${fromId}:${toId}`;
    // Recursive shapes: an in-progress pair re-entered through its own
    // fields answers "assume coercible" — see widthPlanning.
    if (this.widthPlanning.has(key)) return new Map();
    this.widthPlanning.add(key);
    try {
      type FieldLift = { src: IrType; lift: WidthLift } | { absent: true; utag: number } | { absentDyn: true };
      const plan = new Map<string, FieldLift>();
      for (const tf of to.fields) {
        const ff = from.fields.find((f) => f.name === tf.name);
        if (!ff) {
          // A target field MISSING on the source: legal exactly when it is
          // optional-flavored (an undefined-armed union) — the unset field
          // IS the undefined arm, the same rule literal completion applies
          // — or 'unknown' (a dyn slot holds the dyn undefined, exactly
          // the absent-property read: the options-record call shape
          // against `{ plugins: unknown, ... }`). Never for tuples: a
          // completed position would change .length and JSON where Node
          // keeps the source arity. Never for INDEX-SIGNATURE sources:
          // the overflow may hold this very key at runtime (tsc lets the
          // signature satisfy optional target members), so completing to
          // undefined would drop a value Node keeps — the pair stays
          // fenced.
          if (from.tuple || from.indexValue) return null;
          if (tf.type.kind === "dyn") {
            plan.set(tf.name, { absentDyn: true });
            continue;
          }
          if (tf.type.kind !== "union") return null;
          const def = this.unions.get(tf.type.unionId);
          const utag = def ? def.arms.findIndex((a) => a.kind === "undefinedT") : -1;
          if (utag < 0) return null;
          plan.set(tf.name, { absent: true, utag });
          continue;
        }
        const lift = this.widthLiftPlan(ff.type, tf.type);
        if (!lift) return null;
        plan.set(tf.name, { src: ff.type, lift });
      }
      return plan;
    } finally {
      this.widthPlanning.delete(key);
    }
  }

  /** Post-hoc classifier for SC2002's record→record residue: WHY the
   * width family (recordWidthPlan and the overflow capture — widthCoerce's
   * two record arms) declined this pair — the FIRST blocking rule, named.
   * Pure description on the failure path (the site already carries the
   * rejection): mirrors the planners' gates, never changes what coerces,
   * and answers null when no pointed story applies (the generic message
   * stands). */
  describeRecordWidthBlocker(fromId: string, toId: string): string | null {
    const from = this.shapes.get(fromId);
    const to = this.shapes.get(toId);
    if (!from || !to) return null;
    if (to.indexValue) {
      // The overflow CAPTURE's gates (lowerRecordOvfCaptureHelper).
      if (from.tuple || to.tuple) return "a tuple cannot reshape into an index-signature record";
      const tIv = to.indexValue;
      const slotOk = (t: IrType): boolean =>
        typeEquals(t, tIv) ||
        (tIv.kind === "dyn" && (t.kind === "dyn" || this.dynConvertible(t))) ||
        this.widthLiftPlan(t, tIv) !== null;
      const consumed = new Set<string>();
      for (const tf of to.fields) {
        const sf = from.fields.find((f) => f.name === tf.name);
        if (sf) {
          if (this.widthLiftPlan(sf.type, tf.type) !== null) {
            consumed.add(tf.name);
            continue;
          }
          return `field '${tf.name}': '${this.fmt(sf.type)}' does not lift into '${this.fmt(tf.type)}'`;
        }
        if (tf.type.kind !== "union" || this.armTag(tf.type.unionId, UNDEFINED_T) < 0) {
          return `the expected field '${tf.name}' is required and the source has no field to copy into it`;
        }
        if (tIv.kind === "dyn" ? !this.dynConvertible(tf.type) : !typeEquals(tf.type, tIv)) {
          return `the expected field '${tf.name}' ('${this.fmt(tf.type)}') cannot take a runtime key collision from the '${this.fmt(tIv)}' signature slot`;
        }
      }
      for (const ff of from.fields) {
        if (consumed.has(ff.name)) continue;
        if (!slotOk(ff.type)) {
          return `the source field '${ff.name}' ('${this.fmt(ff.type)}') cannot enter the expected '[key: string]: ${this.fmt(tIv)}' slot`;
        }
      }
      if (from.indexValue && !slotOk(from.indexValue)) {
        return `the source's '[key: string]: ${this.fmt(from.indexValue)}' slot cannot enter the expected '[key: string]: ${this.fmt(tIv)}' slot`;
      }
      // The dispatch-writes gate: runtime-keyed writes can collide with a
      // declared field whose type is not the slot's.
      const dispatchWrites =
        from.indexValue !== undefined ||
        from.fields.some((ff) => !consumed.has(ff.name) && to.fields.some((f) => f.name === ff.name));
      if (dispatchWrites) {
        const bad = to.fields.find((f) =>
          tIv.kind === "dyn" ? !this.dynConvertible(f.type) : !typeEquals(f.type, tIv),
        );
        if (bad) {
          return `runtime-keyed writes can collide with the expected field '${bad.name}' ('${this.fmt(bad.type)}'), which cannot take a '${this.fmt(tIv)}' slot value`;
        }
      }
      return null;
    }
    // The field-copy plan's gates (recordWidthPlan).
    if (!!from.tuple !== !!to.tuple) return null;
    if (from.tuple && from.fields.length !== to.fields.length) {
      return `tuple arities differ (${from.fields.length} vs ${to.fields.length}; TS permits no tuple width)`;
    }
    for (const tf of to.fields) {
      const ff = from.fields.find((f) => f.name === tf.name);
      if (!ff) {
        if (from.tuple) return null;
        if (from.indexValue) {
          return `'${tf.name}' is not a declared field of the source, and the source's index signature could hold it at runtime (a completed undefined would drop that value)`;
        }
        if (tf.type.kind === "dyn") continue;
        if (tf.type.kind !== "union" || this.armTag(tf.type.unionId, UNDEFINED_T) < 0) {
          return `the expected field '${tf.name}' is missing on the source and is not optional`;
        }
        continue;
      }
      if (this.widthLiftPlan(ff.type, tf.type) === null) {
        return `field '${tf.name}': '${this.fmt(ff.type)}' does not lift into '${this.fmt(tf.type)}'`;
      }
    }
    return null;
  }

  recordWidthHelper(fromId: string, toId: string, loc: SrcLoc): string | null {
    const from = this.shapes.get(fromId);
    const to = this.shapes.get(toId);
    if (!from || !to) return null;
    // Plan every target field BEFORE interning anything (interned helpers
    // are part of the emitted program; a later field's failure must not
    // orphan one).
    const plan = this.recordWidthPlan(fromId, toId);
    if (!plan) return null;
    const key = `rec:${fromId}:${toId}`;
    const existing = this.widthHelpers.get(key);
    if (existing) return existing;
    const name = `%rec.width.${this.widthHelpers.size}`;
    // Interned BEFORE the body builds: a recursive nested-width field
    // (self-referential shapes) resolves to this helper itself.
    this.widthHelpers.set(key, name);
    const fromT: IrType = { kind: "record", shapeId: fromId };
    const toT: IrType = { kind: "record", shapeId: toId };
    const r: IrExpr = { kind: "varRef", localId: "r.0", type: fromT, loc };
    this.liftedFns.push({
      name,
      params: [{ localId: "r.0", name: "r", type: fromT }],
      returnType: toT,
      locals: [{ id: "r.0", name: "r", type: fromT, mutable: true }],
      body: [
        {
          kind: "return",
          value: {
            kind: "recordLit",
            fields: to.fields.map((f) => {
              const lift = plan.get(f.name)!;
              if ("absentDyn" in lift) {
                // The unset 'unknown' field: the dyn undefined — exactly
                // the absent-property read's answer.
                return { name: f.name, value: dynUndefinedExpr(loc) };
              }
              if ("absent" in lift) {
                if (f.type.kind !== "union") throw new InternalCompilerError("lowerer bug: absent lift against a non-union field");
                // The unset optional field: build the undefined arm.
                return {
                  name: f.name,
                  value: {
                    kind: "unionWrap",
                    unionId: f.type.unionId,
                    tag: lift.utag,
                    value: { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc },
                    type: f.type,
                    loc,
                  } satisfies IrExpr,
                };
              }
              const get: IrExpr = { kind: "recordGet", obj: r, shapeId: fromId, field: f.name, type: lift.src, loc };
              return { name: f.name, value: this.applyWidthLift(lift.lift, get, f.type, loc) };
            }),
            type: toT,
            loc,
          },
          loc,
        },
      ],
      loc,
    });
    return name;
  }

  /** Interned `%arr.width.<n>(a)` — the per-element copy loop over
   * widthLiftPlan's element lift: out = []; n = a.length; for (...)
   * out.push(lift(a[i])); return out. Record elements reshape
   * (recordWidthHelper), union elements wrap or re-tag (`number[]` into
   * `(number | undefined)[]`), nested arrays recurse. Null when the
   * element pair isn't width-liftable. */
  /** Interned `%tup.arr.<n>(t)` — rebuilds a TUPLE as an ARRAY: positions
   * read in order, each lifted into the element type under widthLiftPlan.
   * Null unless the source shape really is a tuple whose every position
   * lifts (records with named fields never relate to arrays). */
  tupleArrayWidthHelper(fromId: string, toT: IrType & { kind: "array" }, loc: SrcLoc): string | null {
    const from = this.shapes.get(fromId);
    if (!from || !from.tuple) return null;
    const lifts: WidthLift[] = [];
    for (const f of from.fields) {
      const lift = this.widthLiftPlan(f.type, toT.elem);
      if (!lift) return null;
      lifts.push(lift);
    }
    const key = `tuparr:${fromId}:${typeKey(toT.elem)}`;
    const existing = this.widthHelpers.get(key);
    if (existing) return existing;
    const name = `%tup.arr.${this.widthHelpers.size}`;
    this.widthHelpers.set(key, name);
    const fromT: IrType = { kind: "record", shapeId: fromId };
    const t: IrExpr = { kind: "varRef", localId: "t.0", type: fromT, loc };
    this.liftedFns.push({
      name,
      params: [{ localId: "t.0", name: "t", type: fromT }],
      returnType: toT,
      locals: [{ id: "t.0", name: "t", type: fromT, mutable: true }],
      body: [
        {
          kind: "return",
          value: {
            kind: "arrayLit",
            elems: from.fields.map((f, i) =>
              this.applyWidthLift(
                lifts[i]!,
                { kind: "recordGet", obj: t, shapeId: fromId, field: f.name, type: f.type, loc },
                toT.elem,
                loc,
              ),
            ),
            type: toT,
            loc,
          },
          loc,
        },
      ],
      loc,
    });
    return name;
  }

  /** Interned `%arr.empty.<n>(a)` — the EMPTY-array lift's build side: a
   * unit-only-element array reshapes into any data-element array by
   * answering a FRESH empty array, after a runtime non-empty trap (a
   * genuinely inhabited `(null | undefined)[]` cannot reshape — the
   * catchable-TypeError stance every checked extraction takes). */
  emptyArrayLiftHelper(fromT: IrType & { kind: "array" }, toT: IrType & { kind: "array" }, loc: SrcLoc): string {
    const key = `emptyarr:${typeKey(fromT.elem)}:${typeKey(toT.elem)}`;
    const existing = this.widthHelpers.get(key);
    if (existing) return existing;
    const name = `%arr.empty.${this.widthHelpers.size}`;
    this.widthHelpers.set(key, name);
    const a: IrExpr = { kind: "varRef", localId: "a.0", type: fromT, loc };
    this.liftedFns.push({
      name,
      params: [{ localId: "a.0", name: "a", type: fromT }],
      returnType: toT,
      locals: [{ id: "a.0", name: "a", type: fromT, mutable: true }],
      body: [
        {
          kind: "if",
          cond: {
            kind: "bin",
            op: "!==",
            left: { kind: "arrIntrinsic", method: "length", receiver: a, args: [], type: F64, loc },
            right: { kind: "numLit", value: 0, type: F64, loc },
            type: BOOL,
            loc,
          },
          then: [
            {
              kind: "throw",
              value: {
                kind: "libCall",
                fn: "error.new",
                args: [{ kind: "strLit", value: `expected ${this.fmt(toT)} (a non-empty ${this.fmt(fromT)} has no elements the target can hold)`, type: STRING, loc }],
                type: { kind: "object", className: "%TypeError" },
                loc,
              },
              loc,
            },
          ],
          else_: [],
          loc,
        },
        { kind: "return", value: { kind: "arrayLit", elems: [], type: toT, loc }, loc },
      ],
      loc,
    });
    return name;
  }

  arrayWidthHelper(fromT: IrType & { kind: "array" }, toT: IrType & { kind: "array" }, loc: SrcLoc,): string | null {
    const fromElem = fromT.elem;
    const toElem = toT.elem;
    const elemLift = this.widthLiftPlan(fromElem, toElem);
    if (!elemLift || elemLift.how === "copy") return null;
    const key = `arr:${typeKey(fromElem)}:${typeKey(toElem)}`;
    const existing = this.widthHelpers.get(key);
    if (existing) return existing;
    const name = `%arr.width.${this.widthHelpers.size}`;
    this.widthHelpers.set(key, name);
    const arrT: IrType = { kind: "array", elem: fromElem };
    const outT: IrType = { kind: "array", elem: toElem };

    const f64: IrType = { kind: "f64" };
    this.liftedFns.push({
      name,
      params: [{ localId: "a.0", name: "a", type: arrT }],
      returnType: outT,
      locals: [
        { id: "a.0", name: "a", type: arrT, mutable: true },
        { id: "out.0", name: "out", type: outT, mutable: false },
        { id: "n.0", name: "n", type: f64, mutable: false },
        { id: "i.0", name: "i", type: f64, mutable: true },
      ],
      body: [
        { kind: "varDecl", localId: "out.0", init: { kind: "arrayLit", elems: [], type: outT, loc }, loc },
        {
          kind: "varDecl",
          localId: "n.0",
          init: { kind: "arrIntrinsic", method: "length", receiver: varRef("a.0", arrT, loc), args: [], type: f64, loc },
          loc,
        },
        {
          kind: "for",
          init: { kind: "varDecl", localId: "i.0", init: numLit(0, loc), loc },
          cond: { kind: "bin", op: "<", left: varRef("i.0", f64, loc), right: varRef("n.0", f64, loc), type: BOOL, loc },
          update: {
            kind: "assign",
            localId: "i.0",
            value: { kind: "bin", op: "+", left: varRef("i.0", f64, loc), right: numLit(1, loc), type: f64, loc },
            loc,
          },
          body: [
            {
              kind: "exprStmt",
              expr: {
                kind: "arrIntrinsic",
                method: "push",
                receiver: varRef("out.0", outT, loc),
                args: [
                  this.applyWidthLift(
                    elemLift,
                    { kind: "arrayGet", arr: varRef("a.0", arrT, loc), index: varRef("i.0", f64, loc), type: fromElem, loc },
                    toElem,
                    loc,
                  ),
                ],
                type: f64,
                loc,
              },
              loc,
            },
          ],
          loc,
        },
        { kind: "return", value: varRef("out.0", outT, loc), loc },
      ],
      loc,
    });
    return name;
  }

  /** The planning half of objRecordWidthHelper — how a CLASS INSTANCE
   * projects into a record shape (tsc's structural view of classes makes
   * `new Point(0,0)` flow into `{x: number; y: number}` slots). Every
   * target field must be a plain instance FIELD on the class (inherited
   * included) whose type lifts, or a missing optional-flavored field
   * completing to its undefined arm — but never a field the class
   * satisfies through a METHOD or accessor (bound method references have
   * no lowering; the plan declines instead of projecting a lie). Builtin
   * runtime layouts (the Error/EventEmitter/stream chains) decline: their
   * fields aren't plain emitted storage. */
  objToRecordPlan(className: string, toId: string): Map<string, { src: IrType; lift: WidthLift } | { absent: true; utag: number }> | null {
    const info = this.classes.get(className);
    const to = this.shapes.get(toId);
    if (!info || !to || to.indexValue || to.tuple) return null;
    // Reserved slots (%call hybrids, %get:/%set: accessor closures) are
    // not projectable storage.
    if (to.fields.some((f) => f.name.startsWith("%"))) return null;
    for (let c: ClassInfo | null = info; c; c = c.base) {
      if (c.builtinError || c.builtinEmitter || c.builtinStream !== undefined || c.def.runtime) return null;
    }
    const key = `obj:${className}:${toId}`;
    if (this.widthPlanning.has(key)) return new Map();
    this.widthPlanning.add(key);
    try {
      const plan = new Map<string, { src: IrType; lift: WidthLift } | { absent: true; utag: number }>();
      for (const tf of to.fields) {
        // A method/accessor satisfying the checker has no projectable
        // value — decline the whole plan, field or not.
        if (
          findMethodOn(this, info, tf.name) ||
          findMethodOn(this, info, `get:${tf.name}`) ||
          findGenericMethodOn(this, info, tf.name)
        ) {
          return null;
        }
        const ft = info.fields.get(tf.name);
        if (ft === undefined) {
          if (tf.type.kind !== "union") return null;
          const def = this.unions.get(tf.type.unionId);
          const utag = def ? def.arms.findIndex((a) => a.kind === "undefinedT") : -1;
          if (utag < 0) return null;
          plan.set(tf.name, { absent: true, utag });
          continue;
        }
        const lift = this.widthLiftPlan(ft, tf.type);
        if (!lift) return null;
        plan.set(tf.name, { src: ft, lift });
      }
      return plan;
    } finally {
      this.widthPlanning.delete(key);
    }
  }

  /** Interned `%obj.width.<n>(o)` — builds a record from a class
   * instance's fields under objToRecordPlan: the width-copy stance
   * (divergence 305 — a fresh record, mutations don't alias, extra class
   * members drop). */
  objRecordWidthHelper(className: string, toId: string, loc: SrcLoc): string | null {
    const to = this.shapes.get(toId);
    if (!to) return null;
    const plan = this.objToRecordPlan(className, toId);
    if (!plan) return null;
    const key = `obj:${className}:${toId}`;
    const existing = this.widthHelpers.get(key);
    if (existing) return existing;
    const name = `%obj.width.${this.widthHelpers.size}`;
    this.widthHelpers.set(key, name);
    const fromT: IrType = { kind: "object", className };
    const toT: IrType = { kind: "record", shapeId: toId };
    const o: IrExpr = { kind: "varRef", localId: "o.0", type: fromT, loc };
    this.liftedFns.push({
      name,
      params: [{ localId: "o.0", name: "o", type: fromT }],
      returnType: toT,
      locals: [{ id: "o.0", name: "o", type: fromT, mutable: true }],
      body: [
        {
          kind: "return",
          value: {
            kind: "recordLit",
            fields: to.fields.map((f) => {
              const lift = plan.get(f.name)!;
              if ("absent" in lift) {
                if (f.type.kind !== "union") throw new InternalCompilerError("lowerer bug: absent lift against a non-union field");
                return {
                  name: f.name,
                  value: {
                    kind: "unionWrap",
                    unionId: f.type.unionId,
                    tag: lift.utag,
                    value: { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc },
                    type: f.type,
                    loc,
                  } satisfies IrExpr,
                };
              }
              const get: IrExpr = { kind: "fieldGet", obj: o, className, field: f.name, type: lift.src, loc };
              return { name: f.name, value: this.applyWidthLift(lift.lift, get, f.type, loc) };
            }),
            type: toT,
            loc,
          },
          loc,
        },
      ],
      loc,
    });
    return name;
  }

  /** The planning half of recordClassWidthHelper — how a RECORD enters a
   * class-instance slot. Construction IS the projection, so the class
   * must be a pure parameter-property data class: its own trivial
   * constructor (every parameter a parameter property, empty body), no
   * other fields, no methods/accessors anywhere in the chain (a
   * fabricated instance must carry no behavior the record lacks), no
   * decoration, no base beyond a generic FAMILY ancestor (fieldless and
   * methodless by construction). Each constructor parameter takes the
   * same-named source field under widthLiftPlan, or — omittable params —
   * the absent undefined arm. One entry per constructor parameter, in
   * parameter order. */
  recordToClassPlan(fromId: string, className: string): ({ field: string; src: IrType; lift: WidthLift } | { absent: true })[] | null {
    const from = this.shapes.get(fromId);
    const info = this.classes.get(className);
    if (!from || !info || from.indexValue || from.tuple) return null;
    if (from.fields.some((f) => f.name.startsWith("%"))) return null;
    if (!info.decl || info.def.abstract || info.def.runtime || info.generic) return null;
    if (info.builtinError || info.builtinEmitter || info.builtinStream !== undefined) return null;
    if (info.classDecorators) return null;
    if (info.base && !(info.base.generic && !info.base.base)) return null;
    for (let c: ClassInfo | null = info; c; c = c.base) {
      if (
        c.methods.size > 0 ||
        (c.genericMethods?.size ?? 0) > 0 ||
        (c.symbolFields?.size ?? 0) > 0 ||
        c.throwingSetters.length > 0 ||
        (c.def.abstractMethods?.length ?? 0) > 0
      ) {
        return null;
      }
    }
    if (!info.ctor || info.ctor.body === undefined || info.ctor.body.statements.length > 0) return null;
    const props = info.paramProps ?? [];
    if (props.length !== info.ctorParams.length) return null;
    // Every layout field must come from a parameter property (no declared
    // fields with initializers the projection would silently prefer).
    if (info.def.fields.length !== props.length) return null;
    const key = `cls:${fromId}:${className}`;
    if (this.widthPlanning.has(key)) return [];
    this.widthPlanning.add(key);
    try {
      const plan: ({ field: string; src: IrType; lift: WidthLift } | { absent: true })[] = [];
      for (let i = 0; i < props.length; i++) {
        const shape = info.ctorParams[i];
        if (!shape || (shape.mode !== "required" && shape.mode !== "omittable")) return null;
        const name = props[i]!.name;
        const ff = from.fields.find((f) => f.name === name);
        if (!ff) {
          if (shape.mode !== "omittable" || shape.type.kind !== "union") return null;
          const def = this.unions.get(shape.type.unionId);
          if (!def || !def.arms.some((a) => a.kind === "undefinedT")) return null;
          plan.push({ absent: true });
          continue;
        }
        const lift = this.widthLiftPlan(ff.type, shape.type);
        if (!lift) return null;
        plan.push({ field: name, src: ff.type, lift });
      }
      return plan;
    } finally {
      this.widthPlanning.delete(key);
    }
  }

  /** Interned `%cls.width.<n>(r)` — `new C(r.p1, ..., r.pn)` under
   * recordToClassPlan: the record's fields become the trivial
   * constructor's arguments (divergence 305's copy stance — a fresh
   * instance, mutations don't alias, and `instanceof C` answers true
   * where Node's plain object answers false). */
  recordClassWidthHelper(fromId: string, className: string, loc: SrcLoc): string | null {
    const info = this.classes.get(className);
    if (!info) return null;
    const plan = this.recordToClassPlan(fromId, className);
    if (!plan) return null;
    const key = `cls:${fromId}:${className}`;
    const existing = this.widthHelpers.get(key);
    if (existing) return existing;
    const name = `%cls.width.${this.widthHelpers.size}`;
    this.widthHelpers.set(key, name);
    this.noteEdge(`%${className}.constructor`);
    const fromT: IrType = { kind: "record", shapeId: fromId };
    const toT: IrType = { kind: "object", className };
    const r: IrExpr = { kind: "varRef", localId: "r.0", type: fromT, loc };
    const args = plan.map((entry, i): IrExpr => {
      const shape = info.ctorParams[i]!;
      if ("absent" in entry) {
        const u = this.wrappedUndefined(shape.type, loc);
        if (!u) throw new InternalCompilerError("lowerer bug: planned absent ctor arg has no undefined arm");
        return u;
      }
      const get: IrExpr = { kind: "recordGet", obj: r, shapeId: fromId, field: entry.field, type: entry.src, loc };
      return this.applyWidthLift(entry.lift, get, shape.type, loc);
    });
    this.liftedFns.push({
      name,
      params: [{ localId: "r.0", name: "r", type: fromT }],
      returnType: toT,
      locals: [{ id: "r.0", name: "r", type: fromT, mutable: true }],
      body: [
        { kind: "return", value: { kind: "new", className, args, type: toT, loc }, loc },
      ],
      loc,
    });
    return name;
  }

  /** A CLASS VALUE's statics projected into a record shape (`var f:
   * ShapeFactory = Shape`): the record literal capturing static FIELDS as
   * copies of their globals and static METHODS as the zero-capture
   * closures `const f = C.m` builds (params all required — value-form
   * completion rules stay out of coercions). Inherited statics resolve
   * like JS's class-object prototype walk. Divergence 305's copy stance:
   * later writes to a writable static field don't flow into the record
   * (Node aliases the one class object). Null when any target field has
   * no projectable static. */
  classStaticsProjection(className: string, toId: string, loc: SrcLoc): IrExpr | null {
    const info = this.classes.get(className);
    const to = this.shapes.get(toId);
    if (!info || !to || to.indexValue || to.tuple) return null;
    if (to.fields.some((f) => f.name.startsWith("%"))) return null;
    if (info.generic || !info.decl) return null;
    const fields: { name: string; value: IrExpr }[] = [];
    for (const tf of to.fields) {
      if (findGenericStaticOn(this, info, tf.name)) return null;
      const found = findStaticOn(this, info, tf.name);
      if (!found) {
        if (tf.type.kind !== "union") return null;
        const u = this.wrappedUndefined(tf.type, loc);
        if (!u) return null;
        fields.push({ name: tf.name, value: u });
        continue;
      }
      if (found.field !== undefined) {
        const read: IrExpr = { kind: "varRef", localId: found.field.globalId, type: found.field.type, loc };
        const lift = this.widthLiftPlan(found.field.type, tf.type);
        if (!lift) return null;
        fields.push({ name: tf.name, value: this.applyWidthLift(lift, read, tf.type, loc) });
        continue;
      }
      if (found.method.params.some((p) => p.mode !== "required")) return null;
      const funcType: IrType = {
        kind: "func",
        params: found.method.params.map((p) => p.type),
        ret: found.method.ret,
      };
      const lift = this.widthLiftPlan(funcType, tf.type);
      if (!lift) return null;
      const fnName = `%${found.declarer.def.name}.static:${tf.name}`;
      this.noteEdge(fnName);
      const closure: IrExpr = { kind: "closure", fnName, captures: [], type: funcType, loc };
      fields.push({ name: tf.name, value: this.applyWidthLift(lift, closure, tf.type, loc) });
    }
    return { kind: "recordLit", fields, type: { kind: "record", shapeId: toId }, loc };
  }

  /** Interned `%fn.width.<n>(f)` — the function-RETURN width adapter: a
   * zero-param `() => Wide[]` value flowing into a `() => Narrow[]` slot
   * (the createProxyServer getRoutes shape) wraps in a fresh closure that
   * calls the original and maps the result through the per-element record
   * width copy (%arr.width). The adapter is a factory lifted function
   * whose param the returned closure captures; each invocation of the
   * adapted value builds a FRESH array of narrowed records (the width
   * machinery's copy stance — callers see the values, not the identity).
   * Null when the return shapes aren't width-coercible; bounded to
   * zero-param signatures (the one observed site — widening needs a
   * param-forwarding story nothing drives yet). */
  funcReturnWidthAdapter(fromT: IrType & { kind: "func" }, toT: IrType & { kind: "func" }, loc: SrcLoc,): string | null {
    if (fromT.params.length !== 0 || toT.params.length !== 0) return null;
    if (fromT.ret.kind !== "array" || toT.ret.kind !== "array") return null;
    const mapper = this.arrayWidthHelper(fromT.ret, toT.ret, loc);
    if (!mapper) return null;
    const key = `fn:${typeKey(fromT.ret.elem)}:${typeKey(toT.ret.elem)}`;
    const existing = this.widthHelpers.get(key);
    if (existing) return existing;
    const name = `%fn.width.${this.widthHelpers.size}`;
    this.widthHelpers.set(key, name);
    this.freshClosureAdapters.add(name); // wraps `f` in a new closure per call

    const impl = `${name}.impl`;
    // The returned closure's body: call the captured original, width-map.
    this.liftedFns.push({
      name: impl,
      params: [],
      returnType: toT.ret,
      captures: [{ localId: "f.0", name: "f", type: fromT }],
      locals: [{ id: "f.0", name: "f", type: fromT, mutable: false, boxed: true }],
      body: [
        {
          kind: "return",
          value: {
            kind: "call",
            callee: mapper,
            args: [
              {
                kind: "callValue",
                callee: { kind: "varRef", localId: "f.0", type: fromT, loc },
                args: [],
                type: fromT.ret,
                loc,
              },
            ],
            type: toT.ret,
            loc,
          },
          loc,
        },
      ],
      loc,
    });
    // The factory: box the incoming function value, mint the closure.
    this.liftedFns.push({
      name,
      params: [{ localId: "f.0", name: "f", type: fromT }],
      returnType: toT,
      locals: [{ id: "f.0", name: "f", type: fromT, mutable: false, boxed: true }],
      body: [
        {
          kind: "return",
          value: { kind: "closure", fnName: impl, captures: ["f.0"], type: toT, loc },
          loc,
        },
      ],
      loc,
    });
    return name;
  }

  /** Whether a `src`-typed VALUE converts into a `dst` slot through the
   * coercions coerceToExpected applies mechanically — the PURE probe
   * behind funcCoerceAdapter (nothing interns): exact types, arm wraps
   * into unions, whole-union re-tags (unionRetagMappable), checked
   * single-arm narrows, void into an undefined-armed union, and the dyn
   * boundary in both directions (dynFrom / dynCheck's JSON-safe domain).
   * Deliberately EXCLUDES the trap-only stranded conversions — an adapter
   * that could only ever throw is a fence, not a bridge. */
  coercibleValue(src: IrType, dst: IrType): boolean {
    if (typeEquals(src, dst)) return true;
    // The island boundary joins the mechanical set: values that MARSHAL
    // in (units, the checked-dynamic deep copy, JSON-safe data, liftable
    // composites, marshalable closures — coerceToExpected's jsval-IN
    // block) and island handles whose exits VALIDATE (boundaryExitSafe) —
    // the `defaultFallback(cfg) { return { login, id, scopes } }` shape,
    // whose slot returns a package ('any') type.
    if (dst.kind === "jsval") {
      return (
        src.kind !== "jsval" &&
        (isUnitType(src) ||
          src.kind === "dyn" ||
          this.boundarySafe(src) ||
          this.jsvalLiftable(src) ||
          (src.kind === "func" &&
            canMarshalTypedFuncIntoIsland(src, (id) => this.shapes.get(id), (id) => this.unions.get(id))))
      );
    }
    if (src.kind === "jsval") return this.boundaryExitSafe(dst);
    if (dst.kind === "dyn") return src.kind !== "dyn" && this.dynConvertible(src);
    if (src.kind === "dyn") {
      // The checked-dynamic function boundary's OUT direction joins the
      // mechanical set: a dyn result landing in an adaptable func slot
      // takes dynCheck's per-target shim (coerceToExpected's funcOk rule
      // — the production/development function-choice ternary shape).
      return (
        this.jsonSafe(dst) ||
        (dst.kind === "func" && canAdaptDynFuncTo(dst, (id) => this.shapes.get(id), (id) => this.unions.get(id)))
      );
    }
    if (dst.kind === "union") {
      if (src.kind === "union") return this.unionRetagMappable(src.unionId, dst.unionId);
      if (src.kind === "void") return this.armTag(dst.unionId, UNDEFINED_T) >= 0;
      return !isUnitType(src) && this.armTag(dst.unionId, src) >= 0;
    }
    if (src.kind === "union") {
      return !isUnitType(dst) && dst.kind !== "void" && this.armTag(src.unionId, dst) >= 0;
    }
    return false;
  }

  /** True when a `src` function value enters a `dst` slot through
   * funcCoerceAdapter with NO stranded (trap-only) piece: no rest packs,
   * no surplus source params, every slot parameter converts into the
   * wrapped function's own type, and the result converts back (a void
   * slot drops it; a void result answers the exact JS undefined for
   * dyn/jsval slots). The width family's func gate — widthLiftPlan
   * bridges only signatures whose every call succeeds by construction. */
  cleanFuncAdaptable(src: IrType & { kind: "func" }, dst: IrType & { kind: "func" }): boolean {
    if (src.rest === true || dst.rest === true) return false;
    if (src.params.length > dst.params.length) return false;
    for (let i = 0; i < src.params.length; i++) {
      if (!this.coercibleValue(dst.params[i]!, src.params[i]!)) return false;
    }
    if (dst.ret.kind === "void") return src.ret.kind !== "jsval";
    if (this.coercibleValue(src.ret, dst.ret)) return true;
    return src.ret.kind === "void" && (dst.ret.kind === "dyn" || dst.ret.kind === "jsval");
  }

  /** Interned `%fn.adapt.<n>(f)` — the GENERAL function-value adapter: a
   * `fromT` function value flowing into a `toT` slot whose pieces differ
   * only by coercibleValue conversions. The slot's callers pass toT's
   * parameters: the wrapper takes them, converts the first
   * fromT.params.length into the wrapped function's own types (surplus
   * slot parameters are DROPPED — JS's extra-argument rule), calls it,
   * and converts the result back (a void slot drops the result; a void
   * result wraps as the slot union's undefined arm). Rest signatures on
   * either side decline (the pack shapes don't line up mechanically).
   * Null when any piece is outside coercibleValue — the exactness fences
   * stay. */
  funcCoerceAdapter(fromT: IrType & { kind: "func" }, toT: IrType & { kind: "func" }, loc: SrcLoc): string | null {
    if (fromT.rest === true || toT.rest === true) return null;
    if (fromT.params.length > toT.params.length) return null;
    // Piece dispositions beyond coercibleValue, all CHECKER-APPROVED
    // function compatibilities (bivariant method params under the suite's
    // non-strict settings, `() => never` throwers displayed as void by
    // the type mapping, void functions into unknown/any-returning slots):
    // - strandParams: some parameter cannot convert — the assignment
    //   compiles, INVOKING the slot throws the stranded TypeError (a
    //   never-called mismatched callback is exact; divergence 38's stance
    //   extended to calls).
    // - voidRet "dyn"/"jsval": calling yields JS's undefined — the exact
    //   undefined dyn/engine value after the call's effects.
    // - voidRet "strand": a void result where the slot promises a typed
    //   value — the call runs (a `never` thrower never comes back, so the
    //   trap is unreachable there), then the stranded TypeError.
    let strandParams = false;
    for (let i = 0; i < fromT.params.length; i++) {
      if (!this.coercibleValue(toT.params[i]!, fromT.params[i]!)) strandParams = true;
    }
    let voidRet: "dyn" | "jsval" | "strand" | null = null;
    let strandRet = false;
    if (toT.ret.kind !== "void" && !this.coercibleValue(fromT.ret, toT.ret)) {
      if (fromT.ret.kind !== "void") {
        // A RESULT that cannot convert — the strandParams stance, result
        // side (the production/development function-choice ternary: the
        // untaken arm's result shape never lands in the slot's): the
        // assignment compiles, INVOKING the slot runs the function and
        // throws the stranded TypeError where its result would convert.
        strandRet = true;
      } else {
        voidRet = toT.ret.kind === "dyn" ? "dyn" : toT.ret.kind === "jsval" ? "jsval" : "strand";
      }
    }
    if (toT.ret.kind === "void" && fromT.ret.kind === "jsval") return null;
    const key = `fnadapt:${typeKey(fromT)}:${typeKey(toT)}`;
    const existing = this.retagHelpers.get(key);
    if (existing) return existing;
    const name = `%fn.adapt.${this.retagHelpers.size}`;
    this.retagHelpers.set(key, name);
    this.freshClosureAdapters.add(name); // wraps `f` in a new closure per call

    const impl = `${name}.impl`;
    const params: IrParam[] = toT.params.map((t, i) => ({ localId: `a.${i}`, name: `a${i}`, type: t }));
    const strandThrow = (why: string): IrStmt => ({
      kind: "throw",
      value: {
        kind: "libCall",
        fn: "error.new",
        args: [{ kind: "strLit", value: why, type: STRING, loc }],
        type: { kind: "object", className: "%TypeError" },
        loc,
      },
      loc,
    });
    let body: IrStmt[];
    if (strandParams) {
      body = [
        strandThrow(
          `a '${this.fmt(fromT)}' function invoked through a '${this.fmt(toT)}' slot (the parameter types cannot convert — the checker's loose function compatibility admitted the assignment, but the call has no exact lowering)`,
        ),
      ];
    } else {
      const args = fromT.params.map((pt, i) => {
        const aRef: IrExpr = { kind: "varRef", localId: `a.${i}`, type: toT.params[i]!, loc };
        const converted = this.coerceToExpected(aRef, pt);
        if (!typeEquals(converted.type, pt)) throw new InternalCompilerError("lowerer bug: probed fn-adapter param stopped coercing");
        return converted;
      });
      const call: IrExpr = {
        kind: "callValue",
        callee: { kind: "varRef", localId: "f.0", type: fromT, loc },
        args,
        type: fromT.ret,
        loc,
      };
      if (toT.ret.kind === "void") {
        body = [
          { kind: "exprStmt", expr: call, loc },
          { kind: "return", value: null, loc },
        ];
      } else if (voidRet === "dyn") {
        body = [
          { kind: "exprStmt", expr: call, loc },
          { kind: "return", value: dynUndefinedExpr(loc), loc },
        ];
      } else if (voidRet === "jsval") {
        body = [
          { kind: "exprStmt", expr: call, loc },
          { kind: "return", value: { kind: "jsOp", op: "undefLit", args: [], type: JSVAL, loc }, loc },
        ];
      } else if (voidRet === "strand") {
        body = [
          { kind: "exprStmt", expr: call, loc },
          strandThrow(
            `a void result where the '${this.fmt(toT)}' slot promises '${this.fmt(toT.ret)}' (a thrower typed 'never' never reaches this; a genuinely void function has no result to hand over)`,
          ),
        ];
      } else if (strandRet) {
        body = [
          { kind: "exprStmt", expr: call, loc },
          strandThrow(
            `a '${this.fmt(fromT)}' function invoked through a '${this.fmt(toT)}' slot (the result cannot convert to '${this.fmt(toT.ret)}' — the checker's loose function compatibility admitted the assignment, but the call has no exact lowering)`,
          ),
        ];
      } else {
        const result = this.coerceToExpected(call, toT.ret);
        if (!typeEquals(result.type, toT.ret)) throw new InternalCompilerError("lowerer bug: probed fn-adapter return stopped coercing");
        body = [{ kind: "return", value: result, loc }];
      }
    }
    this.liftedFns.push({
      name: impl,
      params,
      returnType: toT.ret,
      captures: [{ localId: "f.0", name: "f", type: fromT }],
      locals: [
        { id: "f.0", name: "f", type: fromT, mutable: false, boxed: true },
        ...toT.params.map((t, i) => ({ id: `a.${i}`, name: `a${i}`, type: t, mutable: false })),
      ],
      body,
      loc,
    });
    this.liftedFns.push({
      name,
      params: [{ localId: "f.0", name: "f", type: fromT }],
      returnType: toT,
      locals: [{ id: "f.0", name: "f", type: fromT, mutable: false, boxed: true }],
      body: [
        {
          kind: "return",
          value: { kind: "closure", fnName: impl, captures: ["f.0"], type: toT, loc },
          loc,
        },
      ],
      loc,
    });
    return name;
  }

  /** The spawnSync-runner VALUE adapter's plan — a function returning the
   * opaque spawnRes flowing into a slot whose signature returns the
   * STRUCTURAL result record tsc accepted (`defaultRunner` into a
   * `CommandRunner` param: `{ status: number | null; stdout?: string;
   * stderr?: string; error?: Error }`). Parameters must agree pairwise;
   * each target field must be one of the spawnRes reads (status, stdout,
   * stderr, error) at its exact lowered type — string fields optionally
   * undefined-armed. Null when the pair isn't this shape. Pure: callers
   * probe before interning. */
  spawnResFnAdapterPlan(fromT: IrType & { kind: "func" }, toT: IrType & { kind: "func" },): { field: string; build: (r: IrExpr, loc: SrcLoc) => IrExpr }[] | null {
    if (!Array.isArray(fromT.params) || !Array.isArray(toT.params)) return null; // defensive: degenerate func types
    if (fromT.params.length !== toT.params.length) return null;
    if (!fromT.params.every((p, i) => typeEquals(p, toT.params[i]!))) return null;
    if (fromT.ret.kind !== "spawnRes" || toT.ret.kind !== "record") return null;
    const shape = this.shapes.get(toT.ret.shapeId);
    if (!shape || shape.tuple || shape.indexValue) return null;
    const statusT: IrType = { kind: "union", unionId: this.unions.intern([F64, { kind: "nullT" }]) };
    const errorT: IrType = { kind: "union", unionId: this.unions.intern([{ kind: "object", className: "%Error" }, UNDEFINED_T]) };
    const strOptT: IrType = { kind: "union", unionId: this.unions.intern([STRING, UNDEFINED_T]) };
    const plan: { field: string; build: (r: IrExpr, loc: SrcLoc) => IrExpr }[] = [];
    for (const f of shape.fields) {
      if (f.name === "status" && typeEquals(f.type, statusT)) {
        plan.push({ field: f.name, build: (r, loc) => ({ kind: "libCall", fn: "spawnRes.status", args: [r], type: statusT, loc }) });
        continue;
      }
      if ((f.name === "stdout" || f.name === "stderr") && (typeEquals(f.type, strOptT) || f.type.kind === "string")) {
        const fn = f.name === "stdout" ? ("spawnRes.stdout" as const) : ("spawnRes.stderr" as const);
        const strTag = this.armTag(strOptT.kind === "union" ? strOptT.unionId : "", STRING);
        plan.push({
          field: f.name,
          build: (r, loc) => {
            const read: IrExpr = { kind: "libCall", fn, args: [r], type: STRING, loc };
            return f.type.kind === "string"
              ? read
              : { kind: "unionWrap", unionId: (f.type as IrType & { kind: "union" }).unionId, tag: strTag, value: read, type: f.type, loc };
          },
        });
        continue;
      }
      if (f.name === "error" && typeEquals(f.type, errorT)) {
        plan.push({ field: f.name, build: (r, loc) => ({ kind: "libCall", fn: "spawnRes.error", args: [r], type: errorT, loc }) });
        continue;
      }
      return null;
    }
    return plan;
  }

  /** Interned `%fnval.spawnres.<n>(f)` — the runner-value adapter: a
   * fresh closure of the TARGET signature forwarding its arguments to the
   * captured function and converting the opaque spawnRes result into the
   * target's structural record (one eager read per declared field —
   * spawnResFnAdapterPlan's set). Divergence caveat: stdout/stderr read
   * as the captured text ("" when nothing was captured, e.g. stdio
   * "inherit") where Node stores null. */
  spawnResFnAdapter(fromT: IrType & { kind: "func" }, toT: IrType & { kind: "func" }, loc: SrcLoc,): string | null {
    const plan = this.spawnResFnAdapterPlan(fromT, toT);
    if (!plan) return null;
    if (toT.ret.kind !== "record") return null;
    const key = `fnspawn:${typeKey(fromT)}:${typeKey(toT)}`;
    const existing = this.widthHelpers.get(key);
    if (existing) return existing;
    const name = `%fnval.spawnres.${this.widthHelpers.size}`;
    this.widthHelpers.set(key, name);
    this.freshClosureAdapters.add(name); // wraps `f` in a new closure per call

    const impl = `${name}.impl`;
    const params: IrParam[] = toT.params.map((p, i) => ({ localId: `p${i}.0`, name: `p${i}`, type: p }));
    const rRef: IrExpr = { kind: "varRef", localId: "r.0", type: fromT.ret, loc };
    this.liftedFns.push({
      name: impl,
      params,
      returnType: toT.ret,
      captures: [{ localId: "f.0", name: "f", type: fromT }],
      locals: [
        { id: "f.0", name: "f", type: fromT, mutable: false, boxed: true },
        ...params.map((p) => ({ id: p.localId, name: p.name, type: p.type, mutable: false })),
        { id: "r.0", name: "r", type: fromT.ret, mutable: false },
      ],
      body: [
        {
          kind: "varDecl",
          localId: "r.0",
          init: {
            kind: "callValue",
            callee: { kind: "varRef", localId: "f.0", type: fromT, loc },
            args: params.map((p): IrExpr => ({ kind: "varRef", localId: p.localId, type: p.type, loc })),
            type: fromT.ret,
            loc,
          },
          loc,
        },
        {
          kind: "return",
          value: {
            kind: "recordLit",
            fields: plan.map((entry) => ({ name: entry.field, value: entry.build(rRef, loc) })),
            type: toT.ret,
            loc,
          },
          loc,
        },
      ],
      loc,
    });
    this.liftedFns.push({
      name,
      params: [{ localId: "f.0", name: "f", type: fromT }],
      returnType: toT,
      locals: [{ id: "f.0", name: "f", type: fromT, mutable: false, boxed: true }],
      body: [
        {
          kind: "return",
          value: { kind: "closure", fnName: impl, captures: ["f.0"], type: toT, loc },
          loc,
        },
      ],
      loc,
    });
    return name;
  }

  /** Interned `%union.retag.<n>(u)` — the runtime re-tag for a value of
   * union `fromId` flowing into a slot of union `toId`: a switch on the
   * source tag re-wraps the payload under its tag in the destination
   * (unionNarrow + unionWrap — the payload pointer moves, no copy, so
   * ref-arm identity is preserved across the re-tag). Arms map by
   * canonical type (typeEquals): every non-unit source arm must exist in
   * the destination, or the pair isn't mappable (null — the caller keeps
   * the SC2003 fence). A stranded UNIT arm (undefined/null with no
   * destination arm) is different: it means tsc's picture at the site was
   * NARROWER than the IR type — control-flow narrowing to a sub-union, or
   * a non-null assertion, both of which erase at lowering — so the arm is
   * exactly the possibility the checker proved (or the source asserted)
   * away. It compiles to a runtime trap case throwing a catchable
   * TypeError-shaped string, the lying-cast stance (SEMANTICS.md): sound
   * narrowing never reaches it, a lying `!` throws instead of smuggling
   * an unrepresentable unit into the destination. */
  /** True when unionRetagHelper can bridge the pair — every non-unit
   * source arm exists (typeEquals) in the destination, or width-lifts
   * into exactly one destination arm (widthLiftPlan — record and array
   * arms compose the re-tag with the per-arm reshape). Pure: callers that
   * must validate a WHOLE plan before interning anything (recordWidthHelper)
   * probe with this so a failed later field never orphans a helper. */
  unionRetagMappable(fromId: string, toId: string): boolean {
    const from = this.unions.get(fromId);
    if (!from || !this.unions.get(toId)) return false;
    // The union-pair face of the widthPlanning cycle guard: recursive
    // aliases can close their cycle through a union without repeating a
    // record pair (`type Json = Json[] | undefined`) — an in-progress
    // pair re-entered answers "assume mappable", same greatest-fixed-point
    // reading as recordWidthPlan's.
    const key = `u:${fromId}:${toId}`;
    if (this.widthPlanning.has(key)) return true;
    this.widthPlanning.add(key);
    try {
      const toT: IrType = { kind: "union", unionId: toId };
      return from.arms.every((arm) => isUnitType(arm) || this.widthLiftPlan(arm, toT) !== null);
    } finally {
      this.widthPlanning.delete(key);
    }
  }

  /** A checker-NARROWED union flowing into a different union: `typeof r
   * === "string" || Buffer.isBuffer(r)` proves the record arm of r away,
   * then `{ data: r }` needs `Buffer | string | Rec` in a `Buffer | string`
   * slot. Control-flow narrowing to a sub-union erases at lowering, so the
   * IR value still carries the wide union — but the SITE's checker type
   * names exactly the arms still possible, and every one of those must
   * exist in both unions. The stranded arms compile to trap cases exactly
   * like stranded units (divergence 38's trust-the-checker stance): sound
   * narrowing never reaches them, a lying cast throws a catchable
   * TypeError instead of smuggling an unrepresentable arm. Null when the
   * site type isn't a genuine sub-union of the source (the SC2003 fence
   * stays). */
  narrowedRetagHelper(node: ts.Node, fromId: string, toId: string, loc: SrcLoc): string | null {
    const from = this.unions.get(fromId);
    if (!from || !this.unions.get(toId)) return null;
    const siteT = this.mapTypeOf(this.typeOf(node));
    if (!siteT) return null;
    const siteArms = siteT.kind === "union" ? this.unions.get(siteT.unionId)?.arms : [siteT];
    if (!siteArms || siteArms.length === 0) return null;
    const allowed = new Set<number>();
    for (const a of siteArms) {
      const fi = this.armTag(fromId, a);
      if (fi < 0) return null; // not a narrowing of the source union
      allowed.add(fi);
    }
    const trappable = new Set<number>();
    from.arms.forEach((_, i) => {
      if (!allowed.has(i)) trappable.add(i);
    });
    if (trappable.size === 0) return null; // nothing stranded: the plain re-tag already declined
    return this.unionRetagHelper(fromId, toId, loc, trappable);
  }

  /** The stranded-UNIT trap for PLAIN (non-union) slots: a null/undefined
   * value flowing into a non-nullable typed slot the checker approved —
   * `null!` and `null as any as T` casts, and the non-strict world's
   * legal `let s: string = null`. The compiled representation has no null
   * to carry, so the FLOW throws the catchable stranded TypeError
   * (divergence 38's stance: Node lets the impossible value ride until it
   * is used; the trap surfaces at the assignment instead). Unit sources
   * only — they are pure, so the nullary helper evaluates nothing. */
  strandedUnitTrap(expr: IrExpr, expected: IrType, loc: SrcLoc): IrExpr | null {
    if (!isUnitType(expr.type)) return null;
    if (
      expected.kind === "union" || expected.kind === "void" || expected.kind === "dyn" ||
      expected.kind === "jsval" || isUnitType(expected)
    ) {
      return null;
    }
    const what = expr.type.kind === "undefinedT" ? "undefined" : "null";
    const key = `strandunit:${typeKey(expected)}:${expr.type.kind}`;
    let name = this.retagHelpers.get(key);
    if (!name) {
      name = `%unit.strand.${this.retagHelpers.size}`;
      this.retagHelpers.set(key, name);
      this.liftedFns.push({
        name,
        params: [],
        returnType: expected,
        locals: [],
        body: [
          {
            kind: "throw",
            value: {
              kind: "libCall",
              fn: "error.new",
              args: [
                {
                  kind: "strLit",
                  value: `${what} is not representable in a '${this.fmt(expected)}' slot (a value narrowed or asserted past the type still held it)`,
                  type: STRING,
                  loc,
                },
              ],
              type: { kind: "object", className: "%TypeError" },
              loc,
            },
            loc,
          },
        ],
        loc,
      });
    }
    return { kind: "call", callee: name, args: [], type: expected, loc };
  }

  /** The STRANDED-SOURCE trap: a checker-approved value flowing into a
   * union that cannot represent it (armTag < 0, no class widening, no
   * width lift). Only shapes that PROVE a lying assertion trap: unit
   * sources (null/undefined literals smuggled through `null!` / `as any`
   * casts), and record/array sources with ZERO same-family width-lift
   * candidates among the arms — an AMBIGUOUS lift (several candidates)
   * stays a compile fence, because honest code lands there. The interned
   * helper evaluates the operand (JS evaluates it too) and throws the
   * stranded-arm TypeError verbatim. Null when the shape doesn't prove
   * the lie. */
  strandedCoercionTrap(expr: IrExpr, expected: IrType & { kind: "union" }, loc: SrcLoc): IrExpr | null {
    const def = this.unions.get(expected.unionId);
    if (!def) return null;
    const src = expr.type;
    let what: string;
    if (isUnitType(src)) {
      what = src.kind === "undefinedT" ? "undefined" : "null";
    } else if (src.kind === "f64" || src.kind === "bool" || src.kind === "string") {
      // A SCALAR the union has no arm for (`4 as any as X`, a generic
      // dummy for an unmappable instantiation): no widening exists at
      // all, so the mismatch proves the lie the same way a unit does.
      what = `a '${this.fmt(src)}' value`;
    } else if (src.kind === "record" || src.kind === "array") {
      // Zero width-lift candidates proves no honest mapping was missed.
      const candidates = def.arms.filter(
        (arm) =>
          ((src.kind === "record" && arm.kind === "record") || (src.kind === "array" && arm.kind === "array")) &&
          this.widthLiftPlan(src, arm) !== null,
      );
      if (candidates.length !== 0) return null;
      what = `a '${this.fmt(src)}' value`;
    } else {
      return null;
    }
    // Unit sources have no runtime payload and are pure — the helper is
    // nullary (unit-typed ABI params have no representation); ref sources
    // pass through so the operand still evaluates, exactly JS.
    const takesOperand = !isUnitType(src);
    const key = `strand:${expected.unionId}:${typeKey(src)}`;
    let name = this.retagHelpers.get(key);
    if (!name) {
      name = `%union.strand.${this.retagHelpers.size}`;
      this.retagHelpers.set(key, name);
      const toT: IrType = { kind: "union", unionId: expected.unionId };
      this.liftedFns.push({
        name,
        params: takesOperand ? [{ localId: "v.0", name: "v", type: src }] : [],
        returnType: toT,
        locals: takesOperand ? [{ id: "v.0", name: "v", type: src, mutable: false }] : [],
        body: [
          {
            kind: "throw",
            value: {
              kind: "libCall",
              fn: "error.new",
              args: [
                {
                  kind: "strLit",
                  value: `${what} is not representable in the target union (a value narrowed or asserted past it still held it)`,
                  type: STRING,
                  loc,
                },
              ],
              type: { kind: "object", className: "%TypeError" },
              loc,
            },
            loc,
          },
        ],
        loc,
      });
    }
    return { kind: "call", callee: name, args: isUnitType(src) ? [] : [expr], type: expected, loc };
  }

  unionRetagHelper(fromId: string, toId: string, loc: SrcLoc, trappable?: ReadonlySet<number>): string | null {
    const from = this.unions.get(fromId);
    const to = this.unions.get(toId);
    if (!from || !to) return null;
    // Per-arm WIDTH LIFTS: a RECORD or ARRAY arm with no identical
    // destination arm may width-lift into exactly ONE destination arm
    // (widthLiftPlan's liftWrap — the findRoute pattern: `{hostname, port,
    // tailscaleUrl?} | undefined` returning as `{hostname, port} |
    // undefined`; nested width and per-element array reshapes compose).
    // Planned PURELY first so a failing arm never orphans an interned
    // width helper; ambiguity (several liftable destination arms) declines
    // — no honest single mapping exists. A lifted arm is a COPY
    // (divergence 35's stance), unlike the identity-preserving plain
    // re-wrap.
    const toT: IrType = { kind: "union", unionId: toId };
    const lifts = new Map<number, WidthLift & { how: "liftWrap" }>();
    from.arms.forEach((arm, i) => {
      if (this.armTag(toId, arm) >= 0 || isUnitType(arm) || (trappable?.has(i) ?? false)) return;
      const lp = this.widthLiftPlan(arm, toT);
      if (lp && lp.how === "liftWrap") lifts.set(i, lp);
    });
    // `trappable` extends the unit-arm rule to arms the CHECKER proved
    // away at the coercion site (narrowedRetagHelper): those may trap too.
    const ok = from.arms.every(
      (arm, i) => this.armTag(toId, arm) >= 0 || isUnitType(arm) || (trappable?.has(i) ?? false) || lifts.has(i),
    );
    if (!ok) return null;
    const mapping = from.arms.map((arm, i) => {
      const identity = this.armTag(toId, arm);
      return identity >= 0 ? identity : (lifts.get(i)?.tag ?? -1);
    });
    const stranded = mapping.flatMap((t, i) => (t < 0 ? [i] : []));
    // Lifts are a pure function of the (from, to) pair, so the historic
    // key stays sound for them; stranded arms depend on the SITE.
    const key = `${fromId}:${toId}:${stranded.join(".")}`;
    const existing = this.retagHelpers.get(key);
    if (existing) return existing;
    const name = `%union.retag.${this.retagHelpers.size}`;
    this.retagHelpers.set(key, name);
    const fromT: IrType = { kind: "union", unionId: fromId };
    const u: IrExpr = { kind: "varRef", localId: "u.0", type: fromT, loc };
    const body: IrStmt[] = [];
    from.arms.forEach((arm, i) => {
      const tag = mapping[i]!;
      const cond: IrExpr = { kind: "unionIsTag", unionId: fromId, tag: i, negated: false, value: u, type: BOOL, loc };
      let then: IrStmt[];
      if (tag < 0) {
        const what = isUnitType(arm)
          ? (arm.kind === "undefinedT" ? "undefined" : "null")
          : `a '${this.fmt(arm)}' value`;
        then = [
          {
            kind: "throw",
            value: {
              kind: "libCall",
              fn: "error.new",
              args: [
                {
                  kind: "strLit",
                  value: `${what} is not representable in the target union (a value narrowed or asserted past it still held it)`,
                  type: STRING,
                  loc,
                },
              ],
              type: { kind: "object", className: "%TypeError" },
              loc,
            },
            loc,
          },
        ];
      } else {
        const value: IrExpr = isUnitType(arm)
          ? { kind: "unitLit", unit: arm.kind === "undefinedT" ? "undefined" : "null", type: arm, loc }
          : { kind: "unionNarrow", unionId: fromId, tag: i, value: u, type: arm, loc };
        const lift = lifts.get(i);
        // Width-lifted arm: the narrowed payload reshapes into the
        // destination arm and wraps (applyWidthLift — planned above, so
        // the interns cannot fail here); identity arms re-wrap the same
        // payload pointer.
        const wrapped: IrExpr = lift
          ? this.applyWidthLift(lift, value, toT, loc)
          : { kind: "unionWrap", unionId: toId, tag, value, type: toT, loc };
        then = [{ kind: "return", value: wrapped, loc }];
      }
      body.push({ kind: "if", cond, then, else_: null, loc });
    });
    // Unreachable when tags are exhaustive (they are, by construction);
    // satisfies the all-paths-return rule and keeps a corrupted tag loud.
    body.push({
      kind: "throw",
      value: { kind: "strLit", value: "scriptc: internal error: invalid union tag", type: STRING, loc },
      loc,
    });
    this.liftedFns.push({
      name,
      params: [{ localId: "u.0", name: "u", type: fromT }],
      returnType: toT,
      locals: [{ id: "u.0", name: "u", type: fromT, mutable: true }],
      body,
      loc,
    });
    return name;
  }

  /** Interned `%union.narrow.<n>(u)` — the CHECKED single-arm extraction
   * behind `x!` on union values: the asserted arm's payload comes out
   * (+1 for ref arms, like any unionNarrow), and every OTHER arm throws
   * the catchable TypeError — divergence 38's lying-assertion stance (an
   * unchecked unionNarrow would misread the payload where JS lets the
   * impossible value flow on). Null when the target isn't a non-unit arm
   * of the union — those uses keep their erasure/fences. */
  narrowedArmHelper(fromId: string, target: IrType, loc: SrcLoc): string | null {
    const from = this.unions.get(fromId);
    if (!from || isUnitType(target)) return null;
    const tag = this.armTag(fromId, target);
    if (tag < 0) return null;
    const key = `${fromId}:${tag}`;
    const existing = this.narrowHelpers.get(key);
    if (existing) return existing;
    const name = `%union.narrow.${this.narrowHelpers.size}`;
    this.narrowHelpers.set(key, name);
    const fromT: IrType = { kind: "union", unionId: fromId };
    const u: IrExpr = { kind: "varRef", localId: "u.0", type: fromT, loc };
    const body: IrStmt[] = [];
    from.arms.forEach((arm, i) => {
      if (i === tag) return; // the fall-through extraction below
      const what = isUnitType(arm)
        ? (arm.kind === "undefinedT" ? "undefined" : "null")
        : `a '${this.fmt(arm)}' value`;
      body.push({
        kind: "if",
        cond: { kind: "unionIsTag", unionId: fromId, tag: i, negated: false, value: u, type: BOOL, loc },
        then: [
          {
            kind: "throw",
            value: {
              kind: "libCall",
              fn: "error.new",
              args: [
                {
                  kind: "strLit",
                  value: `${what} is not representable in the target union (a value narrowed or asserted past it still held it)`,
                  type: STRING,
                  loc,
                },
              ],
              type: { kind: "object", className: "%TypeError" },
              loc,
            },
            loc,
          },
        ],
        else_: null,
        loc,
      });
    });
    body.push({
      kind: "return",
      value: { kind: "unionNarrow", unionId: fromId, tag, value: u, type: target, loc },
      loc,
    });
    this.liftedFns.push({
      name,
      params: [{ localId: "u.0", name: "u", type: fromT }],
      returnType: target,
      locals: [{ id: "u.0", name: "u", type: fromT, mutable: true }],
      body,
      loc,
    });
    return name;
  }

  /** The DEFERRED-INIT field read (`stream!: T` assigned past the
   * constructor's top level — the slot is `T | undefined`): interned
   * `%deferred.read.<n>(u)` extracting the declared type. SCALAR arms
   * whose JS-undefined behavior a unit default reproduces read that
   * default — bool false (conditions are exact: undefined and false are
   * both falsy; only printing/strict-equality could tell) and f64 NaN
   * (arithmetic and conditions exact) — while string and REF arms keep
   * the checked-extraction TRAP: JS itself TypeErrors the first member
   * use of such an undefined, so the catchable TypeError at the read is
   * the same failure, named earlier (SEMANTICS.md). */
  deferredReadHelper(fromId: string, target: IrType, loc: SrcLoc): string | null {
    if (target.kind !== "bool" && target.kind !== "f64") {
      return this.narrowedArmHelper(fromId, target, loc);
    }
    const from = this.unions.get(fromId);
    const tag = this.armTag(fromId, target);
    const utag = from ? from.arms.findIndex((a) => a.kind === "undefinedT") : -1;
    if (!from || tag < 0 || utag < 0) return null;
    const key = `deferred:${fromId}:${tag}`;
    const existing = this.narrowHelpers.get(key);
    if (existing) return existing;
    const name = `%deferred.read.${this.narrowHelpers.size}`;
    this.narrowHelpers.set(key, name);
    const fromT: IrType = { kind: "union", unionId: fromId };
    const u: IrExpr = { kind: "varRef", localId: "u.0", type: fromT, loc };
    const dflt: IrExpr =
      target.kind === "bool"
        ? { kind: "boolLit", value: false, type: BOOL, loc }
        : { kind: "numLit", value: NaN, type: F64, loc };
    this.liftedFns.push({
      name,
      params: [{ localId: "u.0", name: "u", type: fromT }],
      returnType: target,
      locals: [{ id: "u.0", name: "u", type: fromT, mutable: true }],
      body: [
        {
          kind: "if",
          cond: { kind: "unionIsTag", unionId: fromId, tag: utag, negated: false, value: u, type: BOOL, loc },
          then: [{ kind: "return", value: dflt, loc }],
          else_: null,
          loc,
        },
        {
          kind: "return",
          value: { kind: "unionNarrow", unionId: fromId, tag, value: u, type: target, loc },
          loc,
        },
      ],
      loc,
    });
    return name;
  }

  /** True when a static value can become ONE island value: jsval itself,
   * anything boundary-safe (the deep JSON marshal), a record whose fields
   * all can (built as an island OBJECT literal, field by field), or an
   * array of such (built as an island ARRAY, element by element). The
   * lift beyond boundarySafe exists for jsval-BEARING composites —
   * `{ role: string; content: any[] }[]` flowing into an `any[]` slot —
   * which have no JSON serialization (a handle isn't JSON) but an honest
   * per-field construction. Recursion terminates: recursive shapes are
   * rejected at mapping time. */
  jsvalLiftable(t: IrType, visiting: Set<string> = new Set()): boolean {
    if (t.kind === "jsval") return true;
    if (this.boundarySafe(t)) return true;
    // Typed arrays, URLs, and Dates marshal IN without joining the round-trip
    // (JSON) set: an engine typed-array copy / an engine URL from href /
    // a Date as its millisecond timestamp (scr_jsval_from_f64).
    if (t.kind === "bytes" || t.kind === "url" || t.kind === "date") return true;
    // Checked-dynamic values deep-copy in (scr_jsval_from_dyn — data
    // kinds; a boxed function/handle/promise throws at runtime).
    if (t.kind === "dyn") return true;
    // Marshalable CLOSURES cross as host functions — a record carrying
    // methods (the service-registry entry: `{ label, load: () =>
    // Promise<any>, defaultFallback: (cfg) => any }`) lifts field by
    // field like any other.
    if (t.kind === "func") {
      return canMarshalTypedFuncIntoIsland(t, (id) => this.shapes.get(id), (id) => this.unions.get(id));
    }
    if (t.kind === "record") {
      const shape = this.shapes.get(t.shapeId);
      if (!shape || shape.tuple) return false;
      // Recursive shapes reaching here answer FALSE: this branch is the
      // per-field island lift (jsval/bytes-bearing composites — the
      // JSON-safe ones already answered true through boundarySafe, where
      // a cyclic value throws the circular TypeError at the marshal), and
      // the lift helpers walk values with no circular guard — fencing the
      // TYPE is the honest answer.
      if (visiting.has(t.shapeId)) return false;
      visiting.add(t.shapeId);
      // An INDEX-SIGNATURE record lifts when its value slot does (dyn
      // included): declared fields write first, then the overflow keys.
      if (shape.indexValue && !this.jsvalLiftable(shape.indexValue, visiting)) return false;
      return shape.fields.every((f) => !f.name.startsWith("%") && this.jsvalLiftable(f.type, visiting));
    }
    if (t.kind === "array") return this.jsvalLiftable(t.elem, visiting);
    // A union crossing IN lifts arm by arm (a runtime tag switch — see
    // unionToJsvalHelper) when every arm does: unit arms become the
    // engine's own undefined/null (which is why bare undefined-armed
    // unions lift here despite being JSON-unsafe), the rest lift as
    // themselves. Arms never nest unions, so this terminates (recursive
    // knots pass through records, guarded above).
    if (t.kind === "union") {
      const def = this.unions.get(t.unionId);
      return !!def && def.arms.every((a) => isUnitType(a) || this.jsvalLiftable(a, visiting));
    }
    return false;
  }

  /** A jsval-typed expression carrying `e`'s value into the island —
   * jsvalLiftable's constructive side. Primitives and JSON-safe composites
   * keep the jsMarshal deep copy; jsval-bearing records and arrays go
   * through interned per-type builder helpers (%jsin.*), so the operand is
   * always evaluated exactly once (as the helper's argument). */
  jsvalLiftExpr(e: IrExpr, loc: SrcLoc): IrExpr {
    if (e.type.kind === "jsval") return e;
    if (this.boundarySafe(e.type)) {
      return { kind: "jsMarshal", value: e, type: JSVAL, loc };
    }
    if (e.type.kind === "bytes" || e.type.kind === "url" || e.type.kind === "date") {
      return { kind: "jsMarshal", value: e, type: JSVAL, loc };
    }
    if (e.type.kind === "record") {
      const helper = this.recordToJsvalHelper(e.type.shapeId, loc);
      return { kind: "call", callee: helper, args: [e], type: JSVAL, loc };
    }
    if (e.type.kind === "array") {
      const helper = this.arrayToJsvalHelper(e.type.elem, loc);
      return { kind: "call", callee: helper, args: [e], type: JSVAL, loc };
    }
    if (e.type.kind === "union") {
      const helper = this.unionToJsvalHelper(e.type.unionId, loc);
      return { kind: "call", callee: helper, args: [e], type: JSVAL, loc };
    }
    // Checked-dynamic values and marshalable closures ride jsMarshal
    // directly (the checked-dynamic tree deep copy / the host-function wrap).
    if (e.type.kind === "dyn" || e.type.kind === "func") {
      return { kind: "jsMarshal", value: e, type: JSVAL, loc };
    }
    throw new InternalCompilerError(`lowerer bug: jsvalLiftExpr of unliftable ${e.type.kind}`);
  }

  /** Interned `%jsin.union.<n>(u)` — the runtime tag switch marshaling a
   * union value INTO the island: unit arms become the engine's own
   * undefined/null (JS-exact — `{ instructions: undefined }` crossing in
   * has the property present and undefined, exactly what the source
   * spells), every other arm narrows and lifts as itself (strings by
   * value, JSON-safe composites as deep copies, typed arrays as engine
   * typed-array copies, URLs as engine URL instances). Caller must have
   * checked jsvalLiftable. */
  unionToJsvalHelper(unionId: string, loc: SrcLoc): string {
    const key = `union:${unionId}`;
    const existing = this.jsinHelpers.get(key);
    if (existing) return existing;
    const def = this.unions.get(unionId);
    if (!def) throw new InternalCompilerError(`lowerer bug: jsval lift of unknown union ${unionId}`);
    const name = `%jsin.union.${this.jsinHelpers.size}`;
    this.jsinHelpers.set(key, name);
    const fromT: IrType = { kind: "union", unionId };
    const u: IrExpr = { kind: "varRef", localId: "u.0", type: fromT, loc };
    const body: IrStmt[] = [];
    def.arms.forEach((arm, i) => {
      const cond: IrExpr = { kind: "unionIsTag", unionId, tag: i, negated: false, value: u, type: BOOL, loc };
      const value: IrExpr = isUnitType(arm)
        ? { kind: "jsOp", op: arm.kind === "undefinedT" ? "undefLit" : "nullLit", args: [], type: JSVAL, loc }
        : this.jsvalLiftExpr({ kind: "unionNarrow", unionId, tag: i, value: u, type: arm, loc }, loc);
      body.push({ kind: "if", cond, then: [{ kind: "return", value, loc }], else_: null, loc });
    });
    // Unreachable when tags are exhaustive (they are, by construction);
    // satisfies the all-paths-return rule and keeps a corrupted tag loud.
    body.push({
      kind: "throw",
      value: { kind: "strLit", value: "scriptc: internal error: invalid union tag", type: STRING, loc },
      loc,
    });
    this.liftedFns.push({
      name,
      params: [{ localId: "u.0", name: "u", type: fromT }],
      returnType: JSVAL,
      locals: [{ id: "u.0", name: "u", type: fromT, mutable: true }],
      body,
      loc,
    });
    return name;
  }

  /** Interned `%jsin.rec.<n>(r)` — builds an island OBJECT from a
   * jsval-bearing record: marshaled key strings, each field lifted through
   * jsvalLiftExpr (jsval fields pass as handles, JSON-safe fields deep-copy,
   * nested composites recurse through their own helpers). Caller must have
   * checked jsvalLiftable. */
  recordToJsvalHelper(shapeId: string, loc: SrcLoc): string {
    const key = `rec:${shapeId}`;
    const existing = this.jsinHelpers.get(key);
    if (existing) return existing;
    const shape = this.shapes.get(shapeId);
    if (!shape) throw new InternalCompilerError(`lowerer bug: jsval lift of unknown shape ${shapeId}`);
    const name = `%jsin.rec.${this.jsinHelpers.size}`;
    this.jsinHelpers.set(key, name);
    const recT: IrType = { kind: "record", shapeId };
    const r: IrExpr = { kind: "varRef", localId: "r.0", type: recT, loc };
    const args: IrExpr[] = [];
    for (const f of shape.fields) {
      args.push({
        kind: "jsMarshal",
        value: { kind: "strLit", value: f.name, type: STRING, loc },
        type: JSVAL,
        loc,
      });
      args.push(
        this.jsvalLiftExpr(
          { kind: "recordGet", obj: r, shapeId, field: f.name, type: f.type, loc },
          loc,
        ),
      );
    }
    const lit: IrExpr = { kind: "jsOp", op: "objLit", args, type: JSVAL, loc };
    if (!shape.indexValue) {
      this.liftedFns.push({
        name,
        params: [{ localId: "r.0", name: "r", type: recT }],
        returnType: JSVAL,
        locals: [{ id: "r.0", name: "r", type: recT, mutable: true }],
        body: [{ kind: "return", value: lit, loc }],
        loc,
      });
      return name;
    }
    // An INDEX-SIGNATURE shape: the declared pairs build the object, then
    // the overflow map's live keys append in JS own-key order (setIdx —
    // runtime keys have no property-name literal).
    const iv = shape.indexValue;
    const f64: IrType = { kind: "f64" };
    const ksT = arrayOf(STRING);

    const kRef = varRef("k.0", STRING, loc);
    this.liftedFns.push({
      name,
      params: [{ localId: "r.0", name: "r", type: recT }],
      returnType: JSVAL,
      locals: [
        { id: "r.0", name: "r", type: recT, mutable: true },
        { id: "out.0", name: "out", type: JSVAL, mutable: false },
        { id: "ks.0", name: "ks", type: ksT, mutable: false },
        { id: "i.0", name: "i", type: f64, mutable: true },
        { id: "k.0", name: "k", type: STRING, mutable: false },
      ],
      body: [
        { kind: "varDecl", localId: "out.0", init: lit, loc },
        { kind: "varDecl", localId: "ks.0", init: { kind: "recordOvfKeys", obj: r, shapeId, type: ksT, loc }, loc },
        {
          kind: "for",
          init: { kind: "varDecl", localId: "i.0", init: numLit(0, loc), loc },
          cond: {
            kind: "bin",
            op: "<",
            left: varRef("i.0", f64, loc),
            right: { kind: "arrIntrinsic", method: "length", receiver: varRef("ks.0", ksT, loc), args: [], type: f64, loc },
            type: BOOL,
            loc,
          },
          update: { kind: "assign", localId: "i.0", value: { kind: "bin", op: "+", left: varRef("i.0", f64, loc), right: numLit(1, loc), type: f64, loc }, loc },
          body: [
            { kind: "varDecl", localId: "k.0", init: { kind: "arrayGet", arr: varRef("ks.0", ksT, loc), index: varRef("i.0", f64, loc), type: STRING, loc }, loc },
            {
              kind: "exprStmt",
              expr: {
                kind: "jsOp",
                op: "setIdx",
                args: [
                  varRef("out.0", JSVAL, loc),
                  { kind: "jsMarshal", value: kRef, type: JSVAL, loc },
                  this.jsvalLiftExpr({ kind: "recordKeyGet", obj: r, shapeId, key: kRef, overflowOnly: true, type: iv, loc }, loc),
                ],
                type: VOID,
                loc,
              },
              loc,
            },
          ],
          loc,
        },
        { kind: "return", value: varRef("out.0", JSVAL, loc), loc },
      ],
      loc,
    });
    return name;
  }

  /** Interned `%jsin.arr.<n>(a)` — builds ONE island ARRAY from a native
   * array whose elements lift: out = []; for (...) out[i] = lift(a[i]);
   * return out. The index marshals by value like any number. Caller must
   * have checked jsvalLiftable of the element. */
  arrayToJsvalHelper(elem: IrType, loc: SrcLoc): string {
    const key = `arr:${typeKey(elem)}`;
    const existing = this.jsinHelpers.get(key);
    if (existing) return existing;
    const name = `%jsin.arr.${this.jsinHelpers.size}`;
    this.jsinHelpers.set(key, name);
    const arrT: IrType = { kind: "array", elem };
    const f64: IrType = { kind: "f64" };

    this.liftedFns.push({
      name,
      params: [{ localId: "a.0", name: "a", type: arrT }],
      returnType: JSVAL,
      locals: [
        { id: "a.0", name: "a", type: arrT, mutable: true },
        { id: "out.0", name: "out", type: JSVAL, mutable: false },
        { id: "n.0", name: "n", type: f64, mutable: false },
        { id: "i.0", name: "i", type: f64, mutable: true },
      ],
      body: [
        { kind: "varDecl", localId: "out.0", init: { kind: "jsOp", op: "arrLit", args: [], type: JSVAL, loc }, loc },
        {
          kind: "varDecl",
          localId: "n.0",
          init: { kind: "arrIntrinsic", method: "length", receiver: varRef("a.0", arrT, loc), args: [], type: f64, loc },
          loc,
        },
        {
          kind: "for",
          init: { kind: "varDecl", localId: "i.0", init: numLit(0, loc), loc },
          cond: { kind: "bin", op: "<", left: varRef("i.0", f64, loc), right: varRef("n.0", f64, loc), type: BOOL, loc },
          update: {
            kind: "assign",
            localId: "i.0",
            value: { kind: "bin", op: "+", left: varRef("i.0", f64, loc), right: numLit(1, loc), type: f64, loc },
            loc,
          },
          body: [
            {
              kind: "exprStmt",
              expr: {
                kind: "jsOp",
                op: "setIdx",
                args: [
                  varRef("out.0", JSVAL, loc),
                  { kind: "jsMarshal", value: varRef("i.0", f64, loc), type: JSVAL, loc },
                  this.jsvalLiftExpr(
                    { kind: "arrayGet", arr: varRef("a.0", arrT, loc), index: varRef("i.0", f64, loc), type: elem, loc },
                    loc,
                  ),
                ],
                type: { kind: "void" },
                loc,
              },
              loc,
            },
          ],
          loc,
        },
        { kind: "return", value: varRef("out.0", JSVAL, loc), loc },
      ],
      loc,
    });
    return name;
  }

  /** Interned `%jsin.elems.<n>(a)` — a NATIVE array of island handles from
   * a native array whose elements lift: the `any[]`-slot coercion (each
   * element becomes one island value; the array stays static). Null when
   * the element doesn't lift. */
  arrayToJsvalArrayHelper(fromElem: IrType, loc: SrcLoc): string | null {
    if (fromElem.kind === "jsval" || !this.jsvalLiftable(fromElem)) return null;
    const key = `elems:${typeKey(fromElem)}`;
    const existing = this.jsinHelpers.get(key);
    if (existing) return existing;
    const name = `%jsin.elems.${this.jsinHelpers.size}`;
    this.jsinHelpers.set(key, name);
    const arrT: IrType = { kind: "array", elem: fromElem };
    const outT: IrType = { kind: "array", elem: JSVAL };
    const f64: IrType = { kind: "f64" };

    this.liftedFns.push({
      name,
      params: [{ localId: "a.0", name: "a", type: arrT }],
      returnType: outT,
      locals: [
        { id: "a.0", name: "a", type: arrT, mutable: true },
        { id: "out.0", name: "out", type: outT, mutable: false },
        { id: "n.0", name: "n", type: f64, mutable: false },
        { id: "i.0", name: "i", type: f64, mutable: true },
      ],
      body: [
        { kind: "varDecl", localId: "out.0", init: { kind: "arrayLit", elems: [], type: outT, loc }, loc },
        {
          kind: "varDecl",
          localId: "n.0",
          init: { kind: "arrIntrinsic", method: "length", receiver: varRef("a.0", arrT, loc), args: [], type: f64, loc },
          loc,
        },
        {
          kind: "for",
          init: { kind: "varDecl", localId: "i.0", init: numLit(0, loc), loc },
          cond: { kind: "bin", op: "<", left: varRef("i.0", f64, loc), right: varRef("n.0", f64, loc), type: BOOL, loc },
          update: {
            kind: "assign",
            localId: "i.0",
            value: { kind: "bin", op: "+", left: varRef("i.0", f64, loc), right: numLit(1, loc), type: f64, loc },
            loc,
          },
          body: [
            {
              kind: "exprStmt",
              expr: {
                kind: "arrIntrinsic",
                method: "push",
                receiver: varRef("out.0", outT, loc),
                args: [
                  this.jsvalLiftExpr(
                    { kind: "arrayGet", arr: varRef("a.0", arrT, loc), index: varRef("i.0", f64, loc), type: fromElem, loc },
                    loc,
                  ),
                ],
                type: f64,
                loc,
              },
              loc,
            },
          ],
          loc,
        },
        { kind: "return", value: varRef("out.0", outT, loc), loc },
      ],
      loc,
    });
    return name;
  }

  jsvalIn(e: IrExpr, node: ts.Node): IrExpr {
    return jsvalIn(this, e, node);
  }

  /** THE coercion path for values flowing into a typed slot: union arms
   * wrap implicitly (coerceToExpected), then the exact-type fence runs
   * (SC2002 for record shapes, SC2003 for unions). Every slot-directed
   * lowering goes through here (via lowerExprExpecting) or calls this
   * directly when the expression was already lowered. */
  coerceInto(node: ts.Node, expr: IrExpr, expected: IrType): IrExpr {
    let e = this.coerceToExpected(expr, expected);
    // An 'any' value PROVABLY null/undefined (the unit literal itself, or
    // a read of a binding nothing ever assigns a non-unit value) flowing
    // implicitly into a primitive slot: the validated exit refuses units
    // unconditionally, so every run would throw the boundary TypeError
    // where Node proceeds silently. A failure certain at compile time is
    // a fence, not a runtime surprise. Explicit casts keep their runtime
    // checked-cast semantics (the cast lowering builds its own jsExit
    // before this runs, so `e !== expr` skips them), and union/composite
    // targets keep the runtime exit (an undefined-armed union ACCEPTS the
    // engine's undefined; composite validation is dynCheck's business).
    if (
      e !== expr && e.kind === "jsExit" &&
      (e.type.kind === "f64" || e.type.kind === "string" || e.type.kind === "bool")
    ) {
      const unit = this.provenUnitAnyOf(node, e.value);
      if (unit !== null) {
        this.unsupported(
          "SC1090",
          node,
          `an 'any' value that is always ${unit} flowing into a '${this.fmt(expected)}' slot (nothing in the program gives this value another shape, and the island boundary's validated exit refuses ${unit} — every run would throw a TypeError where Node proceeds silently)`,
          `give the binding a value other than ${unit} before this use, or keep the slot's type 'any'`,
        );
      }
    }
    // A closure that just BOXED into dyn takes its best-effort JS name
    // from the source node (identifier reads, named function expressions,
    // NamedEvaluation through a variable initializer) — inspect prints
    // [Function: name] and call errors spell it, like Node.
    if (e.kind === "dynFrom" && e.value.type.kind === "func" && e.fnName === undefined) {
      const name = jsFuncNameOf(node);
      if (name !== null) e = { ...e, fnName: name };
    }
    // A union the plain re-tag declined (stranded NON-unit arms): when the
    // node's CHECKER type proves those arms away, they trap instead — the
    // sub-union narrowing bridge (narrowedRetagHelper).
    if (e.type.kind === "union" && expected.kind === "union" && !typeEquals(e.type, expected)) {
      const helper = this.narrowedRetagHelper(node, e.type.unionId, expected.unionId, e.loc);
      if (helper) {
        e = { kind: "call", callee: helper, args: [e], type: expected, loc: e.loc };
      }
    }
    // A JS FUNC value outside the island marshal set flowing into a
    // jsval slot (`withPlugins(getSupportInfoWithoutPlugins, 0)` — a
    // wrapper built at module init around a function the run may never
    // call): the crossing defers to a call-time fence closure instead of
    // stopping the statement — jsvalIn's deferral, the implicit-coercion
    // spelling.
    if (expected.kind === "jsval" && e.type.kind === "func" && !typeEquals(e.type, expected)) {
      const diagsBefore = this.diags.length;
      try {
        this.requireExactShape(node, e.type, expected);
      } catch (err) {
        const fence = islandFuncValueFence(this, err, diagsBefore, node);
        if (fence) return fence;
        throw err;
      }
      return e;
    }
    this.requireExactShape(node, e.type, expected);
    return e;
  }

  /** The unit an 'any' expression PROVABLY holds on every run, or null
   * when no proof exists. Two spellings prove: the lowered value IS the
   * engine unit literal (`null as any`, an any-contextual `undefined`),
   * or the node is an identifier whose every declaration is a plain,
   * non-ambient `var`/`let`/`const` declarator under a variable STATEMENT
   * (catch bindings, for-of/for-in cursors, parameters, and imports all
   * fail this shape test — each receives values from elsewhere), each
   * initializer absent or unit-typed by the checker (a unit TYPE has
   * exactly one value, so syntax doesn't matter), and nothing in the
   * declaring file ever assigns it — bindingNeverReassigned, the same
   * file-scan proof the generic-binding machinery leans on (ESM import
   * bindings are read-only, so cross-file writes don't exist). A hoisted
   * `var` read before its unit-initialized statement holds undefined —
   * also a unit — so the mixed case reports both names. */
  provenUnitAnyOf(node: ts.Node, value: IrExpr): string | null {
    if (value.kind === "jsOp" && value.args.length === 0) {
      if (value.op === "undefLit") return "undefined";
      if (value.op === "nullLit") return "null";
    }
    let n: ts.Node = node;
    while (ts.isParenthesizedExpression(n)) n = n.expression;
    if (!ts.isIdentifier(n)) return null;
    const sym = this.resolveValueSymbol(n);
    if (!sym) return null;
    const decls = this.checker.declarationsOf(sym);
    if (decls.length === 0) return null;
    const units = new Set<string>();
    let allConst = true;
    let firstDecl: ts.VariableDeclaration | null = null;
    for (const d of decls) {
      if (
        !ts.isVariableDeclaration(d) ||
        !ts.isIdentifier(d.name) ||
        !ts.isVariableDeclarationList(d.parent) ||
        !ts.isVariableStatement(d.parent.parent) ||
        d.getSourceFile().isDeclarationFile ||
        (ts.getCombinedModifierFlags(d) & ts.ModifierFlags.Ambient) !== 0
      ) {
        return null;
      }
      firstDecl ??= d;
      if ((ts.getCombinedNodeFlags(d) & ts.NodeFlags.Const) === 0) allConst = false;
      if (d.initializer === undefined) {
        units.add("undefined");
      } else {
        const t = this.typeOf(d.initializer);
        if (!isUnitOnlyTsType(t)) return null;
        for (const p of t.isUnionType() ? ts.constituentTypes(t) : [t]) {
          units.add((p.flags & ts.TypeFlags.Null) !== 0 ? "null" : "undefined");
        }
      }
      // A hoisted `var` with a unit initializer still reads `undefined`
      // between module/function entry and its statement.
      if ((ts.getCombinedNodeFlags(d) & (ts.NodeFlags.Const | ts.NodeFlags.Let)) === 0) {
        units.add("undefined");
      }
    }
    if (!allConst && !bindingNeverReassigned(this, sym, firstDecl!)) return null;
    return [...units].sort().join(" or ");
  }

  /** Lowers an expression that flows into a slot of a known expected type,
   * then applies the coercion path (coerceInto). An EMPTY array literal
   * takes the slot's array type directly — the caller-supplied `expected`
   * lowerArrayLiteral documents, for the positions where tsc's contextual
   * API answers nothing (binding-element defaults: `{ json = [] }`) and
   * the literal's own never[] would build the f64 representation. */
  lowerExprExpecting(node: ts.Expression, expected: IrType | undefined): IrExpr {
    if (expected?.kind === "array") {
      let x: ts.Expression = node;
      while (ts.isParenthesizedExpression(x)) x = x.expression;
      if (ts.isArrayLiteralExpression(x) && x.elements.length === 0) {
        return this.coerceInto(node, this.lowerArrayLiteral(x, expected), expected);
      }
    }
    // An OBJECT LITERAL against a checked-dynamic slot in a JS file (the
    // getSupportInfo options argument — a dyn-ABI param), or against the
    // standard RequestInit type in TypeScript: the value's world IS the
    // checked-dynamic tree — build the dyn literal directly.
    if (expected?.kind === "dyn") {
      let x: ts.Expression = node;
      while (ts.isParenthesizedExpression(x)) x = x.expression;
      if (ts.isObjectLiteralExpression(x)) {
        const contextual = this.checker.getContextualType(x);
        const widened = contextual
          ? this.checker.getBaseTypeOfLiteralType(contextual)
          : undefined;
        const sym = widened?.getAliasSymbol() ?? widened?.getSymbol();
        const requestInit =
          sym?.name === "RequestInit" && this.isStdlibSymbol(sym);
        if (isJsSourceFile(x.getSourceFile()) || requestInit) {
          return lowerDynObjectLiteral(this, x);
        }
      }
    }
    // An ARRAY LITERAL against a UNION slot whose own type has no static
    // home (the JS dyn fallback — the checker gave no usable context):
    // when the union has exactly ONE array-family arm — an array, or an
    // arity-matching tuple (the option-table `default: [{ value: [] }]`
    // shape) — build AS that arm and wrap; the IR-directed twin of
    // lowerArrayLiteral's contextual-union rule.
    if (expected?.kind === "union") {
      let x: ts.Expression = node;
      while (ts.isParenthesizedExpression(x)) x = x.expression;
      if (ts.isArrayLiteralExpression(x)) {
        const own = this.mapTypeOf(this.checker.getContextualType(x) ?? this.typeOf(x));
        // Elements beyond bare null/undefined literals can never live in
        // a unit-only-element array — a checker type that degraded to one
        // (`[]`-flavored inference over a populated literal) carries no
        // element information.
        const nonUnitElems = x.elements.some(
          (el) =>
            !ts.isOmittedExpression(el) &&
            el.kind !== ts.SyntaxKind.NullKeyword &&
            !(ts.isIdentifier(el) && el.text === "undefined"),
        );
        if (
          own === null || own.kind === "dyn" || own.kind === "jsval" ||
          (own.kind === "array" && nonUnitElems && this.unitOnlyElem(own.elem)) ||
          this.widthLiftPlan(own, expected) === null
        ) {
          const def = this.unions.get(expected.unionId);
          const arms = (def?.arms ?? []).filter(
            (a) =>
              (a.kind === "array" && !(nonUnitElems && this.unitOnlyElem(a.elem))) ||
              (a.kind === "record" &&
                !!this.shapes.get(a.shapeId)?.tuple &&
                this.shapes.get(a.shapeId)!.fields.length === x.elements.length &&
                !x.elements.some(ts.isSpreadElement)),
          );
          if (arms.length === 1) {
            const arm = arms[0]!;
            const built = this.lowerArrayLiteral(x, arm as IrType & { kind: "array" } | (IrType & { kind: "record" }));
            return this.coerceInto(node, built, expected);
          }
        }
      }
    }
    const e = this.lowerExpr(node);
    return expected ? this.coerceInto(node, e, expected) : e;
  }

  /** A value flowing into an index-signature VALUE slot (an overflow
   * literal entry, a dynamic-keyed record write). dyn slots (`unknown`
   * signatures — ModelPricing's) take a dyn conversion: dyn values pass
   * through, JSON-safe static values convert with dynFrom (a deep copy —
   * the jsMarshal aliasing stance), everything else keeps the dyn-boundary
   * fence. Typed slots ride the ordinary coercion path (union slots wrap
   * arm values, exactness enforced). */
  intoIndexValueSlot(value: IrExpr, indexValue: IrType, node: ts.Node): IrExpr {
    if (indexValue.kind !== "dyn") return this.coerceInto(node, value, indexValue);
    if (value.type.kind === "dyn") return value;
    // Bare `undefined`/`null` literals store the dyn unit values (JS keeps
    // the key; JSON.stringify drops an undefined-valued one, like Node).
    if (value.kind === "unitLit") {
      return { kind: "dynFrom", value, type: DYN, loc: value.loc };
    }
    // An ISLAND ('any') value: the by-reference jsval→dyn wrap — the same
    // edge coerceToExpected converts (dyn slots accept engine values).
    if (value.type.kind === "jsval") {
      return { kind: "dynFromJsval", value, type: DYN, loc: value.loc };
    }
    if (!this.dynConvertible(value.type)) {
      this.unsupported(
        "SC1100",
        node,
        `storing '${this.fmt(value.type)}' values under an 'unknown'-valued index signature (only numbers, strings, booleans, and JSON-safe records/arrays/unions convert)`,
      );
    }
    return { kind: "dynFrom", value, type: DYN, loc: value.loc };
  }

  /** IR-level `t | undefined` through the shared canonicalizer — the
   * declared result type of an index-signature read under
   * noUncheckedIndexedAccess. Null when the type cannot take the arm. */
  withUndefinedArmOf(t: IrType): IrType | null {
    return withUndefinedArmCanonical(t, this.unions);
  }

  /** True when a static type converts to a dyn value (the dynFrom
   * walker's domain): JSON-safe, bytes<u8> (Uint8Array/Buffer — the checked-dynamic tree's
   * bytes kind, payload copied; stdin chunks into unknown-typed helpers),
   * an undefined-armed union whose other arms are JSON-safe — the
   * undefined arm becomes the undefined dyn singleton — or a BOXABLE
   * function type (the checked-dynamic function boundary: the closure
   * crosses as the checked-dynamic tree's callable kind, identity preserved). */
  dynConvertible(t: IrType): boolean {
    return canConvertToDyn(t, (id) => this.shapes.get(id), (id) => this.unions.get(id));
  }

  /** The value of a `return` statement. In an async function `return p`
   * where p is a promise flattens (JS: the returned promise's settlement
   * becomes the async function's result), so it lowers exactly as
   * `return await p` — the awaitExpr parks the fiber and re-throws
   * rejections, which IS the flattening. Everything else flows into the
   * function's return slot through the usual coercion path. */
  /** The value of `return <expr>` against the context's declared return —
   * or NULL for a bare return: `return undefined`/`return null` in a
   * void-returning function (`{ bar() { return undefined } }`, inferred
   * `() => null` shapes whose return maps to void) hands the caller JS's
   * undefined, which the void slot drops. Units are pure literals, so
   * nothing evaluates; unit-typed non-literals keep the fences. */
  lowerReturnValue(node: ts.Expression): IrExpr | null {
    const expected = this.ctx.returnType;
    const e = this.lowerExpr(node);
    if (expected.kind === "void" && e.kind === "unitLit") return null;
    if (this.ctx.isAsync && e.type.kind === "promise" && expected.kind !== "promise") {
      const awaited: IrExpr = { kind: "awaitExpr", value: e, type: e.type.inner, loc: e.loc };
      return this.coerceInto(node, awaited, expected);
    }
    return this.coerceInto(node, e, expected);
  }

  /** `return <expr>` lowered as a STATEMENT against the declared return.
   * Void-returning contexts get the JS drop: a contextually void-typed
   * function may return a value (`fv = function() { return 0; }` into a
   * `() => void` slot) — the expression evaluates for its effects, the
   * caller never sees a value, so the return goes out bare. Async
   * void-inner returns still resolve a returned promise first. */
  lowerReturnStmt(node: ts.Expression, loc: SrcLoc): IrStmt {
    const expected = this.ctx.returnType;
    if (expected.kind === "void") {
      let e = this.lowerExpr(node);
      if (this.ctx.isAsync && e.type.kind === "promise") {
        e = { kind: "awaitExpr", value: e, type: e.type.inner, loc: e.loc };
      }
      if (e.kind === "unitLit") return { kind: "return", value: null, loc };
      if (e.type.kind === "void") return { kind: "return", value: e, loc };
      return {
        kind: "block",
        body: [
          { kind: "exprStmt", expr: e, loc },
          { kind: "return", value: null, loc },
        ],
        loc,
      };
    }
    return { kind: "return", value: this.lowerReturnValue(node), loc };
  }

  maybeNarrow(expr: IrExpr, node: ts.Node): IrExpr {
    return maybeNarrow(this, expr, node);
  }

  lowerUnitComparison(left: IrExpr,
    right: IrExpr,
    negated: boolean,
    loc: SrcLoc,): IrExpr | null {
    return lowerUnitComparison(this, left, right, negated, loc);
  }

  lowerNullishCoalesce(expr: ts.BinaryExpression, loc: SrcLoc): IrExpr {
    return lowerNullishCoalesce(this, expr, loc);
  }

  lowerOptionalChain(expr: ts.CallExpression | ts.PropertyAccessExpression | ts.ElementAccessExpression,): IrExpr {
    return lowerOptionalChain(this, expr);
  }

  finishOptionalChain(expr: ts.Expression,
    id: string,
    receiver: IrExpr,
    body: IrExpr,
    loc: SrcLoc,): IrExpr {
    return finishOptionalChain(this, expr, id, receiver, body, loc);
  }

  /* ── functions ────────────────────────────────────────────────────── */

  /** The union without `t`'s undefined arm (unchanged when there is none, or
   * when `t` isn't a union). The body-facing type of a defaulted parameter:
   * tsc types uses of `x: string | undefined = "hi"` as plain `string` inside
   * the body — the default removes exactly the undefined possibility. */
  stripUndefinedArm(t: IrType): IrType {
    if (t.kind !== "union") return t;
    const def = this.unions.get(t.unionId);
    if (!def || !def.arms.some((a) => a.kind === "undefinedT")) return t;
    const rest = def.arms.filter((a) => a.kind !== "undefinedT");
    if (rest.length === 1) return rest[0]!;
    // Removing an arm keeps canonical (typeKey-sorted) order.
    return { kind: "union", unionId: this.unions.intern(rest) };
  }

  /** The interned `T | undefined` union over a non-union arm type — the ABI
   * type of a defaulted parameter, and the result type of lookups that may
   * miss (process.env reads). "undefined" sorts last among all arm typeKeys,
   * so the sorted pair is always [t, undefined]. */
  withUndefinedArm(t: IrType): IrType {
    const arms = [t, UNDEFINED_T].sort((a, b) => (typeKey(a) < typeKey(b) ? -1 : 1));
    return { kind: "union", unionId: this.unions.intern(arms) };
  }

  paramShape(param: ts.ParameterDeclaration): ParamShape {
    return paramShape(this, param);
  }

  checkDefaultParamBodyType(param: ts.ParameterDeclaration, bodyType: IrType): void {
    return checkDefaultParamBodyType(this, param, bodyType);
  }

  paramShapes(params: readonly ts.ParameterDeclaration[]): ParamShape[] {
    return paramShapes(this, params);
  }

  completeArgs(argNodes: readonly ts.Expression[],
    shapes: readonly ParamShape[],
    loc: SrcLoc,
    blame: ts.Node,): IrExpr[] {
    return completeArgs(this, argNodes, shapes, loc, blame);
  }

  wrappedUndefined(type: IrType, loc: SrcLoc): IrExpr | null {
    return wrappedUndefined(this, type, loc);
  }

  /** The entry value of a binding JS initializes to `undefined` (an
   * initializer-less declaration, a hoisted `var` before its statement):
   * undefined-armed unions hold the interned undefined arm, and 'any'
   * slots hold the ENGINE's undefined — tsc's definite-assignment
   * analysis never guards `any` reads, so a jsval slot IS readable before
   * any assignment and must never stay a C-level NULL (a validated exit
   * or engine op on NULL is memory-unsafe, not a TypeError). Null for
   * every other type: tsc rejects their pre-assignment reads. */
  unassignedSlotInit(type: IrType, loc: SrcLoc): IrExpr | null {
    if (type.kind === "jsval") {
      return { kind: "jsOp", op: "undefLit", args: [], type: JSVAL, loc };
    }
    return this.wrappedUndefined(type, loc);
  }

  undefinedArgFor(type: IrType, loc: SrcLoc, blame: ts.Node): IrExpr {
    return undefinedArgFor(this, type, loc, blame);
  }

  requireExactArityValue(blame: ts.Node,
    contextual: ts.Expression | null,
    shapes: readonly ParamShape[],
    funcType: IrType,): void {
    return requireExactArityValue(this, blame, contextual, shapes, funcType);
  }

  bodyReturnType(isAsync: boolean, declared: IrType): IrType {
    return bodyReturnType(this, isAsync, declared);
  }
  genBodyReturnType(declared: IrType): IrType {
    return declared.kind === "generator" ? declared.retT : declared;
  }

  declaredReturnType(decl: ts.SignatureDeclaration, blame: ts.Node): IrType {
    return declaredReturnType(this, decl, blame);
  }

  /** Runs one declaration's collection with diagnostics captured: on
   * poison, they DEFER under the declaration's symbol instead of failing
   * the build — an unreached broken declaration costs nothing; the first
   * reference flushes them (flushDeferred). A declaration with no name
   * symbol reports eagerly (nothing could ever reference it). */
  collectDeferring(symbolOf: () => ts.Symbol | undefined, collect: () => void): ts.Symbol | null {
    const sink: ScrDiagnostic[] = [];
    this.diagSink = sink;
    try {
      collect();
      return null;
    } catch (e) {
      this.diagSink = null;
      const symbol = (() => {
        // symbolOf queries the checker too — a second panic must not
        // escape the fence that is handling the first.
        try {
          return symbolOf() ?? null;
        } catch {
          return null;
        }
      })();
      // An upstream tsgo panic reached through this declaration's queries
      // (the 1e999 JSON-marshal signature crossed collectSignature): the
      // declaration poisons under a source-anchored diagnostic, deferred
      // like any collection fence — never a crashed CLI.
      if (isCheckerPanic(e)) {
        const decl = symbol ? this.checker.declarationsOf(symbol)[0] : undefined;
        sink.push(checkerPanicDiag(
          e.message.split("\n", 1)[0]!,
          decl ? locOf(decl) : { file: this.entry.fileName, start: 0, end: 0 },
        ));
      } else if (!(e instanceof PoisonError)) {
        throw e;
      }
      if (!symbol) {
        for (const d of sink) this.pushDiag(d);
        return null;
      }
      const list = this.deferredDiags.get(symbol) ?? [];
      list.push(...sink);
      this.deferredDiags.set(symbol, list);
      return symbol;
    } finally {
      this.diagSink = null;
    }
  }

  /** Pushes a symbol's deferred collection diagnostics: lowering resolved
   * a reference to it, so the declaration is part of what the entry runs.
   * The reference site then proceeds exactly as before (its own rejection
   * may follow) — reached-but-broken declarations report the same set of
   * diagnostics the eager collector historically produced. */
  flushDeferred(symbol: ts.Symbol): void {
    if (this.collecting) return;
    const diags = this.deferredDiags.get(symbol);
    if (!diags) return;
    this.deferredDiags.delete(symbol);
    if (this.alreadyFlushed.has(symbol)) return; // the emit pass reported these
    this.flushedSymbols.add(symbol);
    for (const d of diags) this.pushDiag(d);
  }

  flushDeferredClass(className: string): void {
    const symbol = this.deferredClassByName.get(className);
    if (symbol) this.flushDeferred(symbol);
  }

  collectSignature(decl: ts.FunctionDeclaration): void {
    return collectSignature(this, decl);
  }

  collectSignatureInner(decl: ts.FunctionDeclaration): void {
    return collectSignatureInner(this, decl);
  }

  /* ── generic functions (monomorphization) ─────────────────────────── */

  collectGenericSignature(decl: ts.FunctionDeclaration): void {
    return collectGenericSignature(this, decl);
  }

  genericFnOf(ident: ts.Identifier): GenericFnInfo | null {
    return genericFnOf(this, ident);
  }

  lowerGenericCall(expr: ts.CallExpression, info: GenericFnInfo): IrExpr {
    return lowerGenericCall(this, expr, info);
  }

  lowerGenericFnValue(ref: ts.Expression, info: GenericFnInfo): IrExpr {
    return lowerGenericFnValue(this, ref, info);
  }

  inferTypeParamBindings(expr: ts.CallExpression,
    info: GenericFnInfo,
    rsig: ts.Signature,
    tsBindings?: Map<ts.Symbol, ts.Type>,): Map<ts.Symbol, IrType> {
    return inferTypeParamBindings(this, expr, info, rsig, tsBindings);
  }

  lowerGenericInstance(info: GenericFnInfo, inst: GenericInstance): IrFunction {
    return lowerGenericInstance(this, info, inst);
  }

  /* ── classes ──────────────────────────────────────────────────────── */

  /** Checker work class SHAPE collection performs inside otherwise
   * deferred JavaScript bodies. Constructor assignments declare fields,
   * so collection asks for each `this.x` symbol and RHS type even when the
   * constructor is unreachable. Keep that mandatory work batched without
   * sweeping unrelated dead method bodies. */
  private prefetchClassCollection(decls: readonly ts.ClassLikeDeclaration[]): void {
    const defaultTypeNodes: ts.Node[] = [];
    const typeNodes: ts.Node[] = [];
    const symbolRoots: ts.Node[] = [];
    for (const decl of decls) {
      for (const member of decl.members) {
        if (
          (ts.isConstructorDeclaration(member) ||
            ts.isMethodDeclaration(member) ||
            ts.isGetAccessor(member) ||
            ts.isSetAccessor(member)) &&
          (!ts.isMethodDeclaration(member) || member.typeParameters === undefined)
        ) {
          for (const param of member.parameters) {
            if (param.initializer) defaultTypeNodes.push(param.initializer);
          }
        }
      }
      if (!isJsSourceFile(decl.getSourceFile())) continue;
      for (const member of decl.members) {
        if (ts.isConstructorDeclaration(member)) {
          for (const param of member.parameters) {
            if (param.initializer) typeNodes.push(param.initializer);
          }
          for (const stmt of member.body?.statements ?? []) {
            if (!ts.isExpressionStatement(stmt) || !ts.isBinaryExpression(stmt.expression)) continue;
            if (stmt.expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) continue;
            const lhs = stmt.expression.left;
            if (
              (ts.isPropertyAccessExpression(lhs) || ts.isElementAccessExpression(lhs)) &&
              lhs.expression.kind === ts.SyntaxKind.ThisKeyword
            ) {
              symbolRoots.push(lhs);
              // Field inference normally uses the symbol's type, but its
              // panic/undefined fallback asks for the assignment node too.
              typeNodes.push(lhs, stmt.expression.right);
            }
          }
          continue;
        }
        if (
          ts.isMethodDeclaration(member) ||
          ts.isGetAccessor(member) ||
          ts.isSetAccessor(member)
        ) {
          for (const param of member.parameters) {
            if (param.initializer) typeNodes.push(param.initializer);
          }
          // npm-static implicit-any classification resolves body parameter
          // references while collecting the method's shape.
          if (implicitMonoFile(decl.getSourceFile()) && member.body) {
            symbolRoots.push(member.body);
          }
        }
      }
    }
    if (defaultTypeNodes.length > 0) {
      this.checker.prefetchCollectionTypes(defaultTypeNodes);
    }
    if (typeNodes.length > 0 || symbolRoots.length > 0) {
      this.checker.prefetchClassCollection(typeNodes, symbolRoots);
    }
  }

  collectClassShape(decl: ts.ClassDeclaration): void {
    return collectClassShape(this, decl);
  }

  collectClassShapeInner(decl: ts.ClassLikeDeclaration, jsNameOverride?: string,
    inst?: { family: ClassInfo; name: string; bindings: Map<ts.Symbol, IrType>; typeArgsText: string; ordinal: number },
    mixin?: { base: ClassInfo; name: string; call: ts.CallExpression; bindings: Map<ts.Symbol, IrType>; context: string; ordinal: number },): void {
    // Late class expressions and mixin/generic instances do not participate
    // in emitReachable's initial declaration wave. Prime their mandatory
    // shape queries at the collection boundary; initial declarations are
    // already warm and this is memo-free.
    this.prefetchClassCollection([decl]);
    return collectClassShapeInner(this, decl, jsNameOverride, inst, mixin);
  }

  lowerClassExpressionInfo(expr: ts.ClassExpression): ClassInfo {
    return lowerClassExpressionInfo(this, expr);
  }

  lowerClassExpression(expr: ts.ClassExpression): IrExpr {
    return lowerClassExpression(this, expr);
  }

  /* ── the class graph (single inheritance) ─────────────────────────── */

  findMethodOn(info: ClassInfo | null,
    name: string,): { declarer: ClassInfo; sig: { params: ParamShape[]; ret: IrType; abstract?: true; async?: true } } | null {
    return findMethodOn(this, info, name);
  }

  isSubclassOf(sub: string, sup: string): boolean {
    return isSubclassOf(this, sub, sup);
  }

  inHierarchy(info: ClassInfo): boolean {
    return inHierarchy(this, info);
  }

  overrideBelow(info: ClassInfo, name: string): boolean {
    return overrideBelow(this, info, name);
  }

  upcastTo(expr: IrExpr, className: string): IrExpr {
    return upcastTo(this, expr, className);
  }

  /** True when `className` is the %Error root or any class inside its
   * hierarchy (builtin kinds and user `extends Error` subclasses). */
  errorHierarchyClassOf(className: string): boolean {
    if (className === "%Error" || RUNTIME_ERROR_CLASSES.has(className)) return true;
    for (let c = this.classes.get(className)?.base ?? null; c; c = c.base) {
      if (c.def.name === "%Error") return true;
    }
    return false;
  }

  classValueRef(info: ClassInfo, blame: ts.Node): IrExpr {
    return classValueRef(this, info, blame);
  }

  /** Class EXPRESSIONS collected this run, in first-encounter order: the
   * emit pass lowers their members after the init bodies (declaration
   * members ride fp.classDecls; expressions register only when their
   * containing statement lowers). */
  readonly exprClasses: ClassInfo[] = [];
  readonly exprClassInfoByNode = new Map<ts.ClassExpression, ClassInfo>();
  /** Class expressions whose collection is IN FLIGHT — the reentrancy
   * guard for heritage-demanded collection (lowerClassExpressionInfo). */
  readonly collectingExprClasses = new Set<ts.ClassExpression>();
  /** Static-init statements of class expressions inside the statement
   * currently lowering — lowerFileInit drains the buffer immediately
   * BEFORE that statement (JS's order for the supported whole-initializer
   * positions). */
  readonly pendingClassExprInits: IrStmt[] = [];
  /** Discovery hook: registers a just-collected expression class's member
   * bodies as worklist units (the units map is otherwise built before
   * lowering starts). Null in the emit pass. */
  onExprClassCollected: ((info: ClassInfo) => void) | null = null;

  /** Mixin functions (`(Base: T) => class extends Base {…}`) by their
   * function-like node: recognized shape, or null for checked
   * non-qualifiers (lower-mixins.ts). */
  readonly mixinFnShapes = new Map<ts.Node, MixinFnShape | null>();
  /** Mixin instantiations by CALL SITE (one class per once-evaluated call
   * — the class-expression identity rule); null marks a poisoned
   * instantiation so re-demands fence instead of half-collecting. */
  readonly mixinInstanceByCall = new Map<ts.CallExpression, ClassInfo | null>();
  /** Mixin calls whose instantiation is IN FLIGHT — the cyclic-extends
   * backstop (the collectingExprClasses rule). */
  readonly mixinCollectingCalls = new Set<ts.CallExpression>();
  /** Per mixin-class-node demand count: only the FIRST instantiation
   * counts statements toward coverage (the generic-instance rule). */
  readonly mixinOrdinals = new Map<ts.ClassLikeDeclaration, number>();
  /** The mixin instantiation whose source is CURRENTLY collecting or
   * lowering: mapType resolves the inner class node's own instance type
   * (`this` inside members, self-referential fields) to THIS
   * instantiation — the shared AST means the checker keeps answering the
   * one class node for every instantiation, like generic bindings. */
  mixinTypeContext: { classNode: ts.ClassLikeDeclaration; className: string } | null = null;
  /** PINNED mixin instantiations (const-binding / heritage call sites) by
   * their class node — the intersection resolver's candidate sets
   * (mixinIntersectionInstanceType). */
  readonly mixinInstancesByClassNode = new Map<ts.ClassLikeDeclaration, ClassInfo[]>();

  mixinCallClassInfoOf(call: ts.CallExpression): ClassInfo | null {
    return mixinCallClassInfoOf(this, call);
  }

  /** Generic classes (monomorphization by flow): declaration → the family's
   * instance table. Filled by collectClassShapeInner's family mode;
   * consulted by mapType's genericClassInstance hook. */
  readonly genericClassByDecl = new Map<ts.ClassLikeDeclaration, GenericClassInfo>();
  /** Instantiations in demand order — the member-lowering worklist run()'s
   * monomorphization fixpoint drains (an instantiation's methods can
   * demand further instances of either kind). */
  readonly genericClassInstances: ClassInfo[] = [];
  /** Discovery hook: a generic-class instantiation collected mid-lowering
   * (instantiations are demand-driven, not units — their members lower in
   * the instance drain). Null everywhere today; reserved for symmetry with
   * onExprClassCollected should instantiations ever need eager
   * registration. */
  onLateClassCollected: ((info: ClassInfo) => void) | null = null;

  genericClassInstanceType(decl: ts.ClassLikeDeclaration, ref: ts.Type): IrType | null {
    return genericClassInstanceType(this, decl, ref);
  }

  findStaticOn(info: ClassInfo | null, name: string): ReturnType<typeof findStaticOn> {
    return findStaticOn(this, info, name);
  }

  staticShadowBelow(info: ClassInfo, name: string): boolean {
    return staticShadowBelow(this, info, name);
  }

  ctorAbiEquals(sub: ClassInfo, sup: ClassInfo): boolean {
    return ctorAbiEquals(this, sub, sup);
  }

  exactClassOfReceiver(expr: ts.Expression): ClassInfo | null {
    return exactClassOfReceiver(this, expr);
  }

  lowerClassMembers(info: ClassInfo): IrFunction[] {
    return lowerClassMembers(this, info);
  }

  lowerStaticFieldInits(info: ClassInfo): IrStmt[] {
    return lowerStaticFieldInits(this, info);
  }

  /** The method-like members (methods and accessors) of a class that have
   * lowerable bodies, with their collected method-map names. */
  *classMethodMembers(
    info: ClassInfo,
  ): Generator<{ mName: string; member: ts.MethodDeclaration | ts.AccessorDeclaration }> {
    if (!info.decl) return; // builtin error classes: runtime-provided bodies
    for (const member of info.decl.members) {
      const fnLike =
        ts.isMethodDeclaration(member) || ts.isGetAccessor(member) || ts.isSetAccessor(member)
          ? member
          : null;
      if (!fnLike) continue;
      // STATIC methods lower separately (`%C.static:m` via staticMethods;
      // accessors stay fenced per site) — and a static member SHARING an
      // instance member's name would match the instance entry in
      // info.methods below and lower a second body under the same %C.name
      // (the duplicate-function ICE, signature 10).
      const mods = ts.canHaveModifiers(fnLike) ? ts.getModifiers(fnLike) : undefined;
      if (mods?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword)) continue;
      // Computed method names resolve exactly like collection did
      // (classMemberNameOf — folded keys and the sym:iterator slot);
      // unresolvable ones never collected, so they skip here too.
      const baseName = ts.isMethodDeclaration(fnLike)
        ? classMemberNameOf(this, fnLike.name)
        : ts.isIdentifier(fnLike.name) || ts.isPrivateIdentifier(fnLike.name)
          ? fnLike.name.text
          : null;
      if (baseName === null) continue;
      const mName = ts.isMethodDeclaration(fnLike) ? baseName : `${ts.isGetAccessor(fnLike) ? "get" : "set"}:${baseName}`;
      if (!info.methods.get(mName) || !fnLike.body) continue;
      yield { mName, member: fnLike };
    }
  }

  lowerClassCtor(info: ClassInfo): IrFunction {
    return lowerClassCtor(this, info);
  }

  lowerClassMethodMember(info: ClassInfo,
    fnLike: ts.MethodDeclaration | ts.AccessorDeclaration,): IrFunction | null {
    return lowerClassMethodMember(this, info, fnLike);
  }

  throwingSetterFn(info: ClassInfo, prop: string): IrFunction {
    return throwingSetterFn(this, info, prop);
  }

  fieldInitStmts(info: ClassInfo, thisLocal: IrLocal): IrStmt[] {
    return fieldInitStmts(this, info, thisLocal);
  }

  lowerDerivedCtorBody(info: ClassInfo, thisLocal: IrLocal, forward?: IrExpr[]): IrStmt[] {
    return lowerDerivedCtorBody(this, info, thisLocal, forward);
  }

  superCallStmt(info: ClassInfo,
    thisLocal: IrLocal,
    args: IrExpr[],
    loc: SrcLoc,): IrStmt {
    return superCallStmt(this, info, thisLocal, args, loc);
  }

  /** Declares the `this` param local, registered under the THIS_BINDING
   * sentinel so lexical-this capture in arrows uses the normal machinery. */
  declareThis(type: IrType): IrLocal {
    const ctx = this.ctx;
    const local: IrLocal = { id: "this.0", name: "this", type, mutable: false };
    ctx.locals.push(local);
    ctx.scopes[ctx.scopes.length - 1]!.set(THIS_BINDING, local);
    return local;
  }

  lowerFunction(decl: ts.FunctionDeclaration): IrFunction | null {
    return lowerFunction(this, decl);
  }

  collectGlobals(sf: ts.SourceFile, topStmts: ts.Statement[]): void {
    return collectGlobals(this, sf, topStmts);
  }

  lowerFileInit(sf: ts.SourceFile, stmts: ts.Statement[], name: string): IrFunction {
    return lowerFileInit(this, sf, stmts, name);
  }

  lowerDefaultExport(stmt: ts.ExportAssignment): IrStmt | null {
    return lowerDefaultExport(this, stmt);
  }

  buildMain(): IrFunction {
    return buildMain(this);
  }

  /* ── scoping and captures ─────────────────────────────────────────── */

  declareLocal(nameNode: ts.Node, name: string, type: IrType, mutable: boolean): IrLocal {
    const ctx = this.ctx;
    const count = ctx.localCounters.get(name) ?? 0;
    ctx.localCounters.set(name, count + 1);
    const local: IrLocal = { id: `${name}.${count}`, name, type, mutable };
    ctx.locals.push(local);
    const symbol = this.checker.getSymbolAtLocation(nameNode);
    if (symbol) ctx.scopes[ctx.scopes.length - 1]!.set(symbol, local);
    return local;
  }

  /** A function-scope local bound to NO ts.Symbol — the hidden ABI slot of a
   * defaulted parameter (the parameter's symbol binds to the separately-
   * declared body local; nothing in the source can name this one). */
  declareHiddenLocal(name: string, type: IrType): IrLocal {
    const ctx = this.ctx;
    const count = ctx.localCounters.get(name) ?? 0;
    ctx.localCounters.set(name, count + 1);
    const local: IrLocal = { id: `${name}.${count}`, name, type, mutable: false };
    ctx.locals.push(local);
    return local;
  }

  /** Declares a callee's parameter locals from its ParamShapes and builds
   * the DEFAULT-PARAM PROLOGUE. Required/optional/rest params bind their
   * symbol directly (one local of the ABI type). A defaulted param `x: T = e`
   * gets TWO locals: the hidden ABI slot (the incoming `T | undefined`
   * union) and the body local `x` of plain T, initialized by
   *
   *   const x = <in> is undefined-arm ? e : narrow(<in>)
   *
   * — a lazily-branched ternary, so the default expression evaluates exactly
   * when the argument was omitted or undefined (JS's call-time rule), in the
   * callee scope, left-to-right across params (prologue order), and may
   * reference earlier params (their body locals are already bound) and
   * `this` in methods (param 0, declared before any of these). tsc rejects
   * self- and forward-references inside initializers. Must be called before
   * lowering the body; the returned prologue statements go first. */
  declareParams(
    rawDecls: readonly ts.ParameterDeclaration[],
    shapes: readonly ParamShape[],
  ): { params: IrParam[]; prologue: IrStmt[] } {
    // `this` parameters are type-world (paramShapes skipped them; callers
    // never pass them) — skip here too so decls stay shape-aligned.
    const decls = rawDecls.filter((p) => !isThisParameter(p));
    const params: IrParam[] = [];
    const prologue: IrStmt[] = [];
    decls.forEach((decl, i) => {
      const shape = shapes[i]!;
      if (ts.isArrayBindingPattern(decl.name) || ts.isObjectBindingPattern(decl.name)) {
        // Pattern parameter: one hidden ABI slot carries the source value;
        // the prologue binds each name exactly like a destructuring
        // declaration reading from it (the same lowerBindingPattern —
        // pattern fences included). Bound names are mutable, like any
        // parameter in JS.
        const loc = locOf(decl);
        const slot = this.declareHiddenLocal("%param", shape.type);
        params.push({ localId: slot.id, name: "%param", type: shape.type });
        let srcType = shape.type;
        let srcRef = (): IrExpr => ({ kind: "varRef", localId: slot.id, type: shape.type, loc });
        if (shape.mode === "omittable" && shape.bodyType && decl.initializer) {
          // A WHOLE-PATTERN default (`({ x } = { x: 1 })`): pick the
          // default exactly when the argument was omitted or undefined
          // (the ABI union's undefined arm — JS's call-time rule, the
          // identifier-param prologue's ternary), then destructure the
          // picked value.
          const abi = shape.type;
          if (abi.kind === "dyn" || abi.kind === "jsval") {
            // A DYNAMIC-TIER pattern source (`function f({} = a)` with
            // `a: any` — jsval for island values, dyn for the checked-
            // dynamic dyn): the slot holds its tier's undefined directly,
            // so the default test is the runtime undefined test — then
            // the pattern destructures the picked value.
            const dflt = this.lowerExprExpecting(decl.initializer, abi);
            const src = this.declareHiddenLocal("%psrc", abi);
            const inRef = (): IrExpr => ({ kind: "varRef", localId: slot.id, type: abi, loc });
            const isUndef: IrExpr =
              abi.kind === "jsval"
                ? { kind: "jsOp", op: "eq", args: [inRef(), { kind: "jsOp", op: "undefLit", args: [], type: JSVAL, loc }], type: BOOL, loc }
                : { kind: "dynTest", test: "undefined", value: inRef(), type: BOOL, loc };
            prologue.push({
              kind: "varDecl",
              localId: src.id,
              init: { kind: "ternary", cond: isUndef, then: dflt, else_: inRef(), type: abi, loc },
              loc,
            });
            const pickedT = abi;
            srcType = pickedT;
            srcRef = () => ({ kind: "varRef", localId: src.id, type: pickedT, loc });
            this.lowerBindingPattern(decl.name, srcRef, srcType, true, prologue);
            return;
          }
          if (abi.kind !== "union") this.unsupported("SC1090", decl, "this parameter form"); // defensive
          const undefTag = this.armTag(abi.unionId, UNDEFINED_T);
          if (undefTag < 0) this.unsupported("SC1090", decl, "this parameter form"); // defensive
          const isUndef: IrExpr = {
            kind: "unionIsTag", unionId: abi.unionId, tag: undefTag, negated: false,
            value: { kind: "varRef", localId: slot.id, type: abi, loc }, type: BOOL, loc,
          };
          let present: IrExpr | null = null;
          if (typeEquals(shape.bodyType, abi)) {
            present = { kind: "varRef", localId: slot.id, type: abi, loc };
          } else if (shape.bodyType.kind === "union") {
            const retag = this.unionRetagHelper(abi.unionId, shape.bodyType.unionId, loc);
            if (retag) present = { kind: "call", callee: retag, args: [{ kind: "varRef", localId: slot.id, type: abi, loc }], type: shape.bodyType, loc };
          } else {
            const tag = this.armTag(abi.unionId, shape.bodyType);
            if (tag >= 0) {
              present = { kind: "unionNarrow", unionId: abi.unionId, tag, value: { kind: "varRef", localId: slot.id, type: abi, loc }, type: shape.bodyType, loc };
            }
          }
          if (!present) this.unsupported("SC1090", decl, "this parameter form"); // defensive: abi = bodyType + undefined by construction
          const dflt = this.lowerExprExpecting(decl.initializer, shape.bodyType);
          const src = this.declareHiddenLocal("%psrc", shape.bodyType);
          prologue.push({
            kind: "varDecl",
            localId: src.id,
            init: { kind: "ternary", cond: isUndef, then: dflt, else_: present, type: shape.bodyType, loc },
            loc,
          });
          const pickedT = shape.bodyType;
          srcType = pickedT;
          srcRef = () => ({ kind: "varRef", localId: src.id, type: pickedT, loc });
        }
        this.lowerBindingPattern(decl.name, srcRef, srcType, true, prologue);
        return;
      }
      const name = (decl.name as ts.Identifier).text;
      if (shape.mode === "omittable" && shape.bodyType && decl.initializer) {
        const abi = shape.type;
        if (abi.kind === "dyn" || abi.kind === "jsval") {
          // A DYNAMIC-TIER defaulted param (`function f(x = a)` with
          // `a: any` — jsval for island values, dyn for the checked-
          // dynamic dyn): the slot holds its tier's undefined directly —
          // the body local picks the default on the runtime test.
          const loc = locOf(decl);
          const slot = this.declareHiddenLocal(name, abi);
          params.push({ localId: slot.id, name, type: abi });
          const inRef = (): IrExpr => ({ kind: "varRef", localId: slot.id, type: abi, loc });
          const isUndef: IrExpr =
            abi.kind === "jsval"
              ? { kind: "jsOp", op: "eq", args: [inRef(), { kind: "jsOp", op: "undefLit", args: [], type: JSVAL, loc }], type: BOOL, loc }
              : { kind: "dynTest", test: "undefined", value: inRef(), type: BOOL, loc };
          const dflt = this.lowerExprExpecting(decl.initializer, abi);
          const body = this.declareLocal(decl.name, name, abi, true);
          prologue.push({
            kind: "varDecl",
            localId: body.id,
            init: { kind: "ternary", cond: isUndef, then: dflt, else_: inRef(), type: abi, loc },
            loc,
          });
          return;
        }
        if (abi.kind !== "union") this.unsupported("SC1090", decl, "this parameter form"); // defensive
        const undefTag = this.armTag(abi.unionId, UNDEFINED_T);
        if (undefTag < 0) this.unsupported("SC1090", decl, "this parameter form"); // defensive
        const loc = locOf(decl);
        const slot = this.declareHiddenLocal(name, abi);
        params.push({ localId: slot.id, name, type: abi });
        const inRef = (): IrExpr => ({ kind: "varRef", localId: slot.id, type: abi, loc });
        if (typeEquals(shape.bodyType, abi)) {
          // The default may ITSELF be undefined (`x = process.env.FOO`):
          // the body keeps the full `T | undefined` union (tsc's type),
          // so a present argument passes through unchanged and an omitted
          // one takes the default AS IS — no narrow on either branch.
          const dflt = this.lowerExprExpecting(decl.initializer, abi);
          const body = this.declareLocal(decl.name, name, abi, true);
          prologue.push({
            kind: "varDecl",
            localId: body.id,
            init: {
              kind: "ternary",
              cond: { kind: "unionIsTag", unionId: abi.unionId, tag: undefTag, negated: false, value: inRef(), type: BOOL, loc },
              then: dflt,
              else_: inRef(),
              type: abi,
              loc,
            },
            loc,
          });
          return;
        }
        if (shape.bodyType.kind === "union") {
          // UNION body type: a present argument re-tags from the ABI union
          // (body arms + undefined) back into the body union through the
          // interned retag helper — the stranded undefined arm's trap case
          // is unreachable from this else-branch (the ternary just tested
          // it), and every other arm maps by identity.
          const retag = this.unionRetagHelper(abi.unionId, shape.bodyType.unionId, loc);
          if (!retag) this.unsupported("SC1090", decl, "this parameter form"); // defensive
          const dflt = this.lowerExprExpecting(decl.initializer, shape.bodyType);
          const body = this.declareLocal(decl.name, name, shape.bodyType, true);
          prologue.push({
            kind: "varDecl",
            localId: body.id,
            init: {
              kind: "ternary",
              cond: { kind: "unionIsTag", unionId: abi.unionId, tag: undefTag, negated: false, value: inRef(), type: BOOL, loc },
              then: dflt,
              else_: { kind: "call", callee: retag, args: [inRef()], type: shape.bodyType, loc },
              type: shape.bodyType,
              loc,
            },
            loc,
          });
          return;
        }
        const valueTag = this.armTag(abi.unionId, shape.bodyType);
        if (valueTag < 0) this.unsupported("SC1090", decl, "this parameter form"); // defensive
        // The default lowers BEFORE the body local binds, so a same-named
        // outer binding referenced in it can never resolve to the fresh
        // local (tsc separately rejects `x = x`).
        const dflt = this.lowerExprExpecting(decl.initializer, shape.bodyType);
        const body = this.declareLocal(decl.name, name, shape.bodyType, true);
        prologue.push({
          kind: "varDecl",
          localId: body.id,
          init: {
            kind: "ternary",
            cond: { kind: "unionIsTag", unionId: abi.unionId, tag: undefTag, negated: false, value: inRef(), type: BOOL, loc },
            then: dflt,
            else_: { kind: "unionNarrow", unionId: abi.unionId, tag: valueTag, value: inRef(), type: shape.bodyType, loc },
            type: shape.bodyType,
            loc,
          },
          loc,
        });
        return;
      }
      const local = this.declareLocal(decl.name, name, shape.type, true);
      params.push({ localId: local.id, name, type: local.type });
    });
    return { params, prologue };
  }

  /** The binding for `symbol` inside context `ctx` — a scoped local or an
   * already-threaded capture entry. */
  bindingIn(ctx: FnCtx, symbol: ts.Symbol): IrLocal | null {
    for (let i = ctx.scopes.length - 1; i >= 0; i--) {
      const local = ctx.scopes[i]!.get(symbol);
      if (local) return local;
    }
    return ctx.captureBySymbol.get(symbol) ?? null;
  }

  /** Resolves an identifier to a local of the CURRENT function, creating
   * capture entries (and boxing the origin binding) when the name lives in
   * an enclosing function. Self-references of a named lambda are NOT
   * resolved here — callers check `isSelfReference` first. */
  resolveLocal(ident: ts.Identifier): IrLocal | null {
    let symbol = this.checker.getSymbolAtLocation(ident);
    // Shorthand names read their VALUE binding (see resolveValueSymbol).
    if (ident.parent && ts.isShorthandPropertyAssignment(ident.parent) && ident.parent.name === ident) {
      symbol = this.checker.getShorthandAssignmentValueSymbol(ident.parent) ?? symbol;
    }
    if (!symbol) return null;
    const direct = this.resolveKey(symbol, ident);
    if (direct) return direct;
    // A PARAMETER PROPERTY declares two symbols: references resolve to the
    // PARAMETER symbol, while the declaration's name binds the PROPERTY
    // symbol — which is what declareParams registered the local under.
    // On a miss, normalize to the declaration's key and retry (ordinary
    // bindings never reach this — their two sides intern to one symbol).
    const vd = this.checker.valueDeclarationOf(symbol);
    if (
      vd && ts.isParameter(vd) && ts.isIdentifier(vd.name) &&
      vd.modifiers?.some(
        (m) =>
          m.kind === ts.SyntaxKind.PublicKeyword ||
          m.kind === ts.SyntaxKind.PrivateKeyword ||
          m.kind === ts.SyntaxKind.ProtectedKeyword ||
          m.kind === ts.SyntaxKind.ReadonlyKeyword ||
          m.kind === ts.SyntaxKind.OverrideKeyword,
      )
    ) {
      const propSym = this.checker.getSymbolAtLocation(vd.name);
      if (propSym && propSym !== symbol) return this.resolveKey(propSym, ident);
    }
    return null;
  }

  /** Lexical `this` — the enclosing method's this-param, possibly captured
   * through arrows (function expressions/declarations reset `this` in JS;
   * their bodies never see an enclosing method's binding). */
  resolveThis(): IrLocal | null {
    return this.resolveKey(THIS_BINDING);
  }

  /** READ-ONLY twin of resolveLocal for PROBES (isIslandExpr): answers
   * the nearest binding entry without boxing, threading, or predeclaring.
   * resolveKey mutates capture state as a side effect, and a speculative
   * island-ness query through a context that takes no captures (a plain
   * declared function between the origin and the reference) was an ICE —
   * the REAL lowering path still resolves (and diagnoses) the reference
   * itself. */
  peekLocal(ident: ts.Identifier): IrLocal | null {
    let symbol = this.checker.getSymbolAtLocation(ident);
    if (ident.parent && ts.isShorthandPropertyAssignment(ident.parent) && ident.parent.name === ident) {
      symbol = this.checker.getShorthandAssignmentValueSymbol(ident.parent) ?? symbol;
    }
    if (!symbol) return null;
    for (let depth = this.fnStack.length - 1; depth >= 0; depth--) {
      const hit = this.bindingIn(this.fnStack[depth]!, symbol);
      if (hit) return hit;
    }
    return null;
  }

  resolveKey(symbol: ts.Symbol, blame?: ts.Node): IrLocal | null {
    const direct = this.bindingIn(this.ctx, symbol);
    if (direct) return direct;

    // Search enclosing functions, innermost first.
    for (let depth = this.fnStack.length - 2; depth >= 0; depth--) {
      const origin = this.bindingIn(this.fnStack[depth]!, symbol);
      if (!origin) continue;
      // dyn captures ride an UNTRACED obj-box (scr_dyn_retain_v/release_v
      // — boxNewC): the mustCall wrapper closing over its implicit-any
      // `fn` param. A dyn tree is pure data except the function kind,
      // whose closure edge the collector never sees — cycles through a
      // captured dyn are uncollectable (leak, never dangle: trial
      // deletion treats untraced edges as external roots). SEMANTICS.md.
      // jsval captures are fine: the box is an obj-box carrying the
      // island handle's own retain/release (scr_jsval_*_v), untraced like
      // every jsval container position — engine-side back-references are
      // the island's documented collection stance, not the box's.
      if (origin.type.kind === "caught") {
        // A catch binding never escapes its catch (KEEP NARROW): narrow it
        // into a typed local and capture THAT.
        this.unsupported(
          "SC1090",
          blame ?? this.checker.declarationsOf(symbol)[0] ?? this.entry,
          "closures capturing catch bindings (narrow into a typed local first)",
        );
      }
      // The binding escapes into a nested function: it must live in a box,
      // shared by everyone (that's what makes mutation visible everywhere).
      origin.boxed = true;
      // Thread a capture through every function between origin and here.
      let parentEntry = origin;
      for (let j = depth + 1; j < this.fnStack.length; j++) {
        const ctx = this.fnStack[j]!;
        let entry = ctx.captureBySymbol.get(symbol);
        if (!entry) {
          // A context that takes NO captures (a plain declared function —
          // monomorphized/implicit instances lower this way) cannot carry
          // the binding through: the shape is a module binding whose only
          // storage is the init function's LOCAL (a typed-but-unmappable
          // const — the file-scope `new Map()` ledger idiom) read from
          // inside a nested instance. Fence it — in JS the statement
          // defers to its runtime trap like every collection failure;
          // asserting here was an ICE on ordinary npm-static JS.
          if (ctx.captures === null) {
            this.unsupported(
              "SC1090",
              blame ?? this.checker.declarationsOf(symbol)[0] ?? this.entry,
              `the binding '${origin.name}' captured through a plain nested function (the declaration has no static storage a capture can thread — bind the value through a typed const, or read it in the declaring scope)`,
            );
          }
          const count = ctx.localCounters.get(origin.name) ?? 0;
          ctx.localCounters.set(origin.name, count + 1);
          entry = {
            id: `${origin.name}.${count}`,
            name: origin.name,
            type: origin.type,
            mutable: origin.mutable,
            boxed: true,
            // TDZ travels with the binding: reads through ANY capture of a
            // forward-captured const must trap while the box is empty.
            ...(origin.tdz ? { tdz: true as const } : {}),
          };
          ctx.locals.push(entry);
          ctx.captureBySymbol.set(symbol, entry);
          ctx.captures.push({ localId: entry.id, name: entry.name, type: entry.type });
          ctx.captureSources.push(parentEntry.id);
          const runtimeOptionalRoot = this.runtimeOptionalRootOf(parentEntry);
          if (this.runtimeOptionalStorageLocals.has(runtimeOptionalRoot)) {
            this.runtimeOptionalRoots.set(entry, runtimeOptionalRoot);
          }
        }
        parentEntry = entry;
      }
      return parentEntry;
    }
    // Nothing declared yet anywhere on the stack: the hoisted-handler shape
    // — a function declared BEFORE a const it captures (`const cleanup =
    // () => onSigInt; ...; const onSigInt = ...`). Pre-declare the const as
    // a TDZ box at its scope's entry and resolve again (the recursion finds
    // it in the origin frame and threads captures normally).
    if (blame && predeclareForwardCapture(this, symbol)) {
      return this.resolveKey(symbol, blame);
    }
    // The FUNCTION-DECLARATION twin: JS hoists a nested `function f() {}`
    // to scope entry, so a reference lexically ABOVE the declaration in the
    // same function (`http.createServer(handler).listen(0, cb)` with
    // `function handler(req, res)` below — the suite's standard layout) is
    // a live binding, never a TDZ read. Lower the declaration eagerly at
    // the reference and resolve again; the statement loop skips the source
    // statement when it arrives.
    if (blame && predeclareForwardFnDecl(this, symbol)) {
      return this.resolveKey(symbol, blame);
    }
    // The `var` twin: a reference above the `var` statement (a direct read
    // tsc allowed because the type carries undefined, or a nested function
    // capturing the binding early). JS reads undefined there — never a TDZ
    // error — so only undefined-armed types predeclare; the rest land on
    // rejectUnresolvedSymbol's named fence.
    if (blame && predeclareForwardVar(this, symbol)) {
      return this.resolveKey(symbol, blame);
    }
    return null;
  }

  isSelfReference(ident: ts.Identifier): boolean {
    const ctx = this.ctx;
    if (!ctx.selfSymbol) return false;
    // The self binding can be shadowed by a scoped local of the same symbol?
    // No — a shadow is a different symbol; symbol identity is exact.
    return this.checker.getSymbolAtLocation(ident) === ctx.selfSymbol;
  }

  /* ── statements ───────────────────────────────────────────────────── */

  lowerStmts(stmts: readonly ts.Statement[]): IrStmt[] {
    return lowerStmts(this, stmts);
  }

  noteBlockedBindings(stmt: ts.Statement): void {
    return noteBlockedBindings(this, stmt);
  }

  isBlockedBinding(symbol: ts.Symbol | null): boolean {
    return isBlockedBinding(this, symbol);
  }

  /** The cascade rejection: an honest "inherits its declaration's blocker"
   * diagnostic (SC2004) when the symbol is a known-blocked binding, the
   * caller's own fallback otherwise. */
  rejectUnresolved(ident: ts.Identifier, fallback: string): never {
    this.rejectUnresolvedSymbol(this.resolveValueSymbol(ident), ident.text, ident, fallback);
  }

  rejectUnresolvedSymbol(
    symbol: ts.Symbol | null,
    name: string,
    node: ts.Node,
    fallback: string,
  ): never {
    if (this.isBlockedBinding(symbol)) {
      this.pushDiag(blockedBindingUseDiag(name, locOf(node)));
      throw new PoisonError();
    }
    // A binding whose TYPE keeps a generic call signature and whose
    // declaration carries no initializer (`declare const o4: undefined |
    // (<T>(f: (a: T) => T) => T)` — the optional-chained ambient shape):
    // there is no function body to monomorphize, so no use can ever pin a
    // concrete signature — name the shape instead of the generic
    // binding-form text.
    if (symbol) {
      const d = this.checker.valueDeclarationOf(symbol);
      if (
        d && ts.isVariableDeclaration(d) && ts.isVariableDeclarationList(d.parent) &&
        (d.parent.flags & ts.NodeFlags.Const) !== 0
      ) {
        const codec = textCodecBindingClassOf(this, d.name, d.initializer);
        if (codec !== null) {
          const call = codec === "TextEncoder" ? `${name}.encode(s)` : `${name}.decode(bytes)`;
          const composed =
            codec === "TextEncoder"
              ? "new TextEncoder().encode(s)"
              : "new TextDecoder().decode(bytes)";
          this.noLowering(
            `${codec} instance stored in ${name}`,
            node,
            `${call} compiles through this const; the codec object itself has no representation (the composed ${composed} form also compiles)`,
          );
        }
      }
      if (d && ts.isVariableDeclaration(d) && d.initializer === undefined) {
        const t = this.checker.getTypeOfSymbol(symbol);
        const parts = t.isUnionType() ? ts.constituentTypes(t) : [t];
        if (parts.some((p) => this.checker.getCallSignatures(p).some((s) => (s.typeParameters?.length ?? 0) > 0))) {
          this.unsupported(
            "SC1030",
            node,
            `the generic-signature binding '${name}' (its type keeps type parameters and the declaration has no initializer — no function body exists to monomorphize, so nothing can pin a concrete signature)`,
          );
        }
      }
    }
    // An unresolved reference to a LATER `var` whose predeclare was
    // refused: the reads Node would serve before the declaration's
    // assignment are `undefined`, and this binding's type has no slot for
    // that value — name the shape instead of the generic no-lowering text.
    if (symbol) {
      const d = this.checker.valueDeclarationOf(symbol);
      if (d && ts.isVariableDeclaration(d) && (ts.getCombinedNodeFlags(d) & ts.NodeFlags.BlockScoped) === 0) {
        this.unsupported(
          "SC1030",
          node,
          `the reference to '${name}' above its 'var' declaration (a read there would be 'undefined', which the binding's type cannot hold — annotate it '| undefined' or move the declaration up)`,
        );
      }
    }
    this.unsupported("SC1090", node, fallback);
  }

  lowerScopedBlock(stmt: ts.Statement): IrStmt[] {
    return lowerScopedBlock(this, stmt);
  }

  /** Lowers inside a control-construct marker (loop/switch/labeled block/
   * try-with-finally/finally block) so the jump fences below know what a
   * break/continue/return crosses. `labels` carries the construct's JS
   * label names when the source statement was labeled — labeled jumps
   * resolve against them. */
  inCtl<T>(kind: "loop" | "switch" | "block" | "tryFinally" | "finallyBlock", fn: () => T, labels?: string[]): T {
    this.ctx.ctl.push(labels !== undefined && labels.length > 0 ? { kind, labels } : { kind });
    try {
      return fn();
    } finally {
      this.ctx.ctl.pop();
    }
  }

  /** The label names a `lbl:` chain put on the statement currently being
   * lowered — set by lowerLabeled around lowering the labeled construct,
   * consumed exactly once by the construct's own lowering (takeLabels).
   * A lowering that never consumes them signals lowerLabeled to fence:
   * silently dropping a label would compile `break lbl` wrong. */
  pendingLabels: string[] | null = null;

  takeLabels(): string[] | undefined {
    const labels = this.pendingLabels;
    this.pendingLabels = null;
    return labels ?? undefined;
  }

  rejectJumpCrossingFinally(kw: "break" | "continue" | "return", stmt: ts.Statement, label?: string): void {
    return rejectJumpCrossingFinally(this, kw, stmt, label);
  }

  lowerStmt(stmt: ts.Statement): IrStmt | IrStmt[] | null {
    return lowerStmt(this, stmt);
  }

  lowerVarStatement(stmt: ts.VariableStatement): IrStmt[] {
    return lowerVarStatement(this, stmt);
  }

  lowerDestructuringDecl(decl: ts.VariableDeclaration, isLet: boolean): IrStmt[] {
    return lowerDestructuringDecl(this, decl, isLet);
  }

  lowerDestructuringAssignParts(target: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression, rhs: ts.Expression, loc: SrcLoc): { stmts: IrStmt[]; value: IrExpr } {
    return lowerDestructuringAssignParts(this, target, rhs, loc);
  }

  lowerBindingPattern(pattern: ts.ArrayBindingPattern | ts.ObjectBindingPattern,
    srcRef: () => IrExpr,
    srcType: IrType,
    isLet: boolean,
    out: IrStmt[],
    dynSpell?: string,
    allowDynObject = false,): void {
    if (ts.isObjectBindingPattern(pattern)) {
      fenceFetchObjectBinding(this, pattern);
      // parseArgs's declaration family deliberately maps to dyn. Infer the
      // scoped bridge at the binding site as well as at initializer-backed
      // declarations, covering parameter and for-of element patterns.
      allowDynObject ||= srcType.kind === "dyn" &&
        isParseArgsDynCheckerType(this, this.typeOf(pattern));
    }
    // An ISLAND source (`const { readFileSync } = await import("fs")` —
    // a namespace handle, or any 'any'-typed object): each bound name is
    // an engine property read, mirroring the island property-read rule —
    // a member the .d.ts declares as a primitive exits eagerly to the
    // static type; everything else (including members whose declared
    // types have no static mapping, like @types/node's function types)
    // stays a HANDLE, and its use sites dispatch to engine ops. Patterns
    // the element-wise walk cannot spell — ARRAY patterns (the iterator
    // protocol), empty patterns (the coercion checks), holes, rest,
    // defaults — run the REAL pattern in a synthesized engine function
    // instead (lowerJsvalBindingPattern).
    const elementWise =
      srcType.kind === "jsval" &&
      ts.isObjectBindingPattern(pattern) &&
      pattern.elements.length > 0 &&
      pattern.elements.every(
        (el) =>
          !el.dotDotDotToken &&
          !el.initializer &&
          el.name !== undefined &&
          ts.isIdentifier(el.propertyName ?? el.name),
      );
    if (srcType.kind === "jsval" && !elementWise) {
      if (lowerJsvalBindingPattern(this, pattern, srcRef, isLet, out)) return;
      // No engine form (computed keys, untransportable defaults): fall
      // through to the static fences below.
    }
    if (srcType.kind === "jsval" && ts.isObjectBindingPattern(pattern)) {
      for (const el of pattern.elements) {
        this.checkBindingElement(el);
        // 7's BindingElement declares name optional (array elisions are
        // nameless there); object-pattern elements always carry one.
        if (el.name === undefined) continue;
        const prop = el.propertyName ?? el.name;
        if (!ts.isIdentifier(prop)) {
          this.unsupported("SC1031", el, "destructuring with computed or non-identifier keys");
        }
        const loc = locOf(el);
        const read: IrExpr = {
          kind: "jsOp", op: "getProp", name: prop.text, args: [srcRef()], type: JSVAL, loc,
        };
        if (!ts.isIdentifier(el.name)) {
          // A nested pattern reads through its own handle temp.
          const tmp = this.declareHiddenLocal("%destr", JSVAL);
          out.push({ kind: "varDecl", localId: tmp.id, init: read, loc });
          this.lowerBindingPattern(
            el.name,
            () => ({ kind: "varRef", localId: tmp.id, type: JSVAL, loc }),
            JSVAL, isLet, out,
          );
          continue;
        }
        const declared = this.mapTypeOf(this.typeOf(el.name));
        const primitive =
          declared &&
          (declared.kind === "f64" || declared.kind === "bool" || declared.kind === "string");
        const value: IrExpr = primitive
          ? { kind: "jsExit", value: read, type: declared, loc }
          : read;
        const symbol = this.checker.getSymbolAtLocation(el.name);
        const g = symbol ? this.globalsBySymbol.get(symbol) : undefined;
        if (g) {
          out.push({ kind: "assign", localId: g.id, value: this.coerceInto(el.name, value, g.type), loc });
          continue;
        }
        const local = this.declareLocal(el.name, el.name.text, value.type, isLet);
        out.push({ kind: "varDecl", localId: local.id, init: value, loc });
      }
      return;
    }
    return lowerBindingPattern(this, pattern, srcRef, srcType, isLet, out, dynSpell, allowDynObject);
  }

  checkBindingElement(el: ts.BindingElement, allowDefault = false): void {
    return checkBindingElement(this, el, allowDefault);
  }

  bindPatternTarget(name: ts.BindingName,
    value: IrExpr,
    isLet: boolean,
    out: IrStmt[],
    allowDynObject = false,): void {
    return bindPatternTarget(this, name, value, isLet, out, allowDynObject);
  }

  lowerVarDeclList(list: ts.VariableDeclarationList): IrStmt | null {
    return lowerVarDeclList(this, list);
  }

  lowerVarDecl(decl: ts.VariableDeclaration, isLet: boolean): IrStmt | null {
    // ISLAND-HANDLE rescue (--dynamic): `const factory = (await
    // import("./x.mjs")).default` / `const buf = islandReadFileSync(p)` —
    // a binding whose DECLARED type either has no static mapping or has
    // one no island value can EXIT to (bytes, functions, promises), but
    // whose initializer is an island value. The declared type is a .d.ts
    // surface over an engine value; the binding stays a HANDLE (jsval
    // local) and typed use sites go through engine ops and validated
    // exits like any island value. Exit-CAPABLE declared types (numbers,
    // strings, JSON-safe composites, their undefined-armed unions) keep
    // the standard path and its validated-exit machinery; so does
    // everything non-island — including badType here when the
    // initializer turns out not to be island-typed, which is exactly
    // what the standard path would have reported.
    // Only reference-shaped initializers are candidates (awaits, calls,
    // member reads, identifiers, casts/parens over those): they are the
    // island producers, and re-lowering one on the fall-through emits
    // nothing twice — a lambda or literal initializer would (each
    // lowering mints a fresh %fn), and is never an island value anyway.
    const islandCandidate = (e: ts.Expression): boolean => {
      let cur = e;
      while (
        ts.isParenthesizedExpression(cur) ||
        ts.isAsExpression(cur) ||
        ts.isTypeAssertion(cur) ||
        ts.isNonNullExpression(cur)
      ) {
        cur = cur.expression;
      }
      if (
        !ts.isAwaitExpression(cur) &&
        !ts.isCallExpression(cur) &&
        !ts.isPropertyAccessExpression(cur) &&
        !ts.isElementAccessExpression(cur) &&
        !ts.isIdentifier(cur)
      ) {
        return false;
      }
      // A lambda ANYWHERE inside (a call argument) would emit its %fn
      // twice across the fall-through's re-lowering — skip those.
      let lambda = false;
      const scan = (n: ts.Node): void => {
        if (lambda) return;
        if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) {
          lambda = true;
          return;
        }
        ts.forEachChild(n, scan);
      };
      scan(cur);
      return !lambda;
    };
    if (
      this.dynamic &&
      ts.isIdentifier(decl.name) &&
      decl.initializer !== undefined &&
      // `var` stays out: the rescue's block-positioned jsval local can't
      // model the function-scoped hoisted binding (a redeclaration or an
      // out-of-block read would split the variable in two) — vars take the
      // standard path and its own fences.
      (ts.getCombinedNodeFlags(decl) & ts.NodeFlags.BlockScoped) !== 0 &&
      islandCandidate(decl.initializer) &&
      // createRequire's plumbing decls are COMPILE-TIME erasures (the
      // require binding and its builtin-namespace bindings) — never
      // island values; the standard path's skips own them.
      !createRequireBindingDecl(this, decl.name, decl.initializer) &&
      !createRequireNamespaceDecl(this, decl.name, decl.initializer)
    ) {
      const mapped = this.mapTypeOf(this.typeOf(decl.name));
      const handleOnly =
        mapped === null ||
        (mapped.kind !== "jsval" &&
          mapped.kind !== "void" &&
          !canExitIslandToType(
            mapped,
            (id) => this.shapes.get(id),
            (id) => this.unions.get(id),
          ));
      const symbol = this.checker.getSymbolAtLocation(decl.name);
      if (handleOnly && (!symbol || !this.globalsBySymbol.has(symbol))) {
        const init = this.lowerExpr(decl.initializer);
        if (init.type.kind === "jsval") {
          const local = this.declareLocal(decl.name, decl.name.text, JSVAL, isLet);
          return { kind: "varDecl", localId: local.id, init, loc: locOf(decl) };
        }
        // The CHECKED-DYNAMIC twin of the handle rescue (the runtime-world
        // local rule): an unmappable declared type over a dyn initializer
        // (`const first = plugins[0]` — the checker spells 'string |
        // object' while the read is a dyn keyed read) keeps the binding
        // dyn; typed use sites ride validated extractions and the routed
        // engine ops, exactly the JSON.parse-binding story.
        if (mapped === null && init.type.kind === "dyn") {
          const local = this.declareLocal(decl.name, decl.name.text, DYN, isLet);
          return { kind: "varDecl", localId: local.id, init, loc: locOf(decl) };
        }
        if (mapped === null) this.badType(decl.name, this.typeOf(decl.name));
        // A mappable declared type with a non-island initializer: the
        // standard path owns it (the initializer lowered clean; re-running
        // it re-produces the same IR with no duplicate diagnostics).
      }
    }
    return lowerVarDecl(this, decl, isLet);
  }

  lowerSwitch(stmt: ts.SwitchStatement): IrStmt {
    return lowerSwitch(this, stmt);
  }

  lowerTry(stmt: ts.TryStatement): IrStmt {
    return lowerTry(this, stmt);
  }

  lowerExprStatement(expr: ts.Expression): IrStmt {
    return lowerExprStatement(this, expr);
  }

  lowerForOf(stmt: ts.ForOfStatement): IrStmt {
    return lowerForOf(this, stmt);
  }

  lowerForStatement(stmt: ts.ForStatement): IrStmt {
    return lowerForStatement(this, stmt);
  }

  lowerCondition(expr: ts.Expression): IrExpr {
    return lowerCondition(this, expr);
  }

  ensureBool(e: IrExpr, node: ts.Expression): IrExpr {
    return ensureBool(this, e, node);
  }

  requireTruthyUnion(unionId: string, node: ts.Expression): void {
    return requireTruthyUnion(this, unionId, node);
  }

  eqComparableUnion(unionId: string): boolean {
    return eqComparableUnion(this, unionId);
  }

  /* ── expressions ──────────────────────────────────────────────────── */

  lowerExpr(expr: ts.Expression): IrExpr {
    return lowerExpr(this, expr);
  }

  lowerIntrinsicProperty(expr: ts.PropertyAccessExpression): IrExpr | null {
    // The builtin-spoke property extensions (Stats.mtimeMs,
    // SpawnSyncReturns.signal) claim their reads before the intrinsic
    // fallback's member fences fire for them.
    return lowerBuiltinExtraProperty(this, expr) ?? lowerIntrinsicProperty(this, expr);
  }

  /** True for the STANDARD LIBRARY's source files: the shipped ambient
   * .d.ts files (core + overrides + fallback), a lib.*.d.ts bundled with the typescript
   * package (asked via program.isSourceFileDefaultLibrary, never by path
   * matching), or the ADOPTED @types/node surface standing in for the
   * fallback (see loadProgram — the lowering tables recognize the same
   * members by name + this provenance, and everything else those files
   * declare hits the SC2020-family fence). The file half of every
   * supported-surface provenance check. */
  readonly isStdlibFile = (sf: ts.SourceFile): boolean =>
    sf.fileName === this.ambient ||
    sf.fileName === this.overridesAmbient ||
    sf.fileName === this.fallbackAmbient ||
    this.program.isSourceFileDefaultLibrary(sf) ||
    (sf.isDeclarationFile && isNodeTypesPath(sf.fileName));

  nodeTypesOnlySymbol(sym: ts.Symbol | null | undefined): boolean {
    return nodeTypesOnlySymbol(this, sym);
  }

  /** True for an npm package's shipped declaration files — under
   * node_modules but NOT the standard library (typescript's own lib files
   * live under node_modules too), or inside a registered workspace-linked
   * package (a node_modules symlink whose realpath'd files carry no
   * node_modules segment — shared.ts). The provenance half of the npm
   * typing rule (package types are island handles) and of the per-package
   * requires-dynamic attribution. */
  readonly isNpmFile = (sf: ts.SourceFile): boolean =>
    sf.isDeclarationFile &&
    (sf.fileName.includes("/node_modules/") || workspacePackageOfPath(sf.fileName) !== null) &&
    !this.isStdlibFile(sf);

  npmPackageOf(type: ts.Type): string | null {
    return npmPackageOf(this, type);
  }

  npmMemberFence(access: ts.PropertyAccessExpression): void {
    return npmMemberFence(this, access);
  }

  npmPackageOfSymbol(sym: ts.Symbol | undefined): string | null {
    return npmPackageOfSymbol(this, sym);
  }

  isStdlibMember(access: ts.PropertyAccessExpression): boolean {
    return isStdlibMember(this, access);
  }

  isStdlibSymbol(symbol: ts.Symbol | undefined): boolean {
    return isStdlibSymbol(this, symbol);
  }

  isStdlibGlobal(expr: ts.Expression, name: string): boolean {
    return isStdlibGlobal(this, expr, name);
  }

  stdlibGlobalMember(access: ts.PropertyAccessExpression, name: string): string | null {
    return stdlibGlobalMember(this, access, name);
  }

  lowerArrayLiteral(expr: ts.ArrayLiteralExpression, expected?: (IrType & { kind: "array" }) | (IrType & { kind: "record" })): IrExpr {
    return lowerArrayLiteral(this, expr, expected);
  }

  lowerObjectLiteral(expr: ts.ObjectLiteralExpression): IrExpr {
    return lowerObjectLiteral(this, expr);
  }

  lowerShorthandValue(prop: ts.ShorthandPropertyAssignment): IrExpr {
    return lowerShorthandValue(this, prop);
  }

  rejectThisInObjectMethod(node: ts.Node): void {
    return rejectThisInObjectMethod(this, node);
  }

  lowerElementAccess(expr: ts.ElementAccessExpression): IrExpr {
    return lowerElementAccess(this, expr);
  }

  lowerRecordKeyRead(
    expr: ts.ElementAccessExpression,
    shapeId: string,
    shape: IrRecordShape,
    includeUndefined = false,
  ): IrExpr {
    return lowerRecordKeyRead(this, expr, shapeId, shape, includeUndefined);
  }

  lowerElementWrite(expr: ts.BinaryExpression): IrStmt {
    return lowerElementWrite(this, expr);
  }

  ensureString(e: IrExpr, node: ts.Node): IrExpr {
    return ensureString(this, e, node);
  }

  lowerTemplate(expr: ts.TemplateExpression): IrExpr {
    return lowerTemplate(this, expr);
  }

  lowerAsExpression(expr: ts.AsExpression | ts.TypeAssertion): IrExpr {
    // ISLAND value cast to a PROMISE type (`factory(opts) as Promise<Mod>`
    // — the Node-typed async-API shape): promises never have a validated
    // exit, so instead of refusing the build the cast DEFERS the failure
    // to runtime — island.castFail evaluates the value (its side effects
    // are real) and throws a catchable TypeError naming the target, so
    // typed-but-never-executed code (a wasm decode path behind a
    // rejecting import) still compiles and a reached cast fails loudly at
    // the exact site. Claimed only when the source is island-typed by the
    // checker (jsval, or a promise whose inner is a handle); a source
    // that lowers to a real static promise keeps erasure — the standard
    // path's rule for non-island inners. Static builds keep their
    // per-site diagnostics.
    if (this.dynamic) {
      const srcMapped = this.mapTypeOf(this.typeOf(expr.expression));
      const island =
        srcMapped?.kind === "jsval" ||
        (srcMapped?.kind === "promise" && srcMapped.inner.kind === "jsval");
      if (island) {
        const targetTs = this.checker.getTypeFromTypeNode(expr.type);
        const target = this.mapTypeOf(targetTs);
        if (target?.kind === "promise") {
          const inner = this.lowerExpr(expr.expression);
          if (inner.type.kind !== "jsval") return inner; // static promise: erasure
          const loc = locOf(expr);
          const name: IrExpr = {
            kind: "strLit", value: this.fmt(target), type: STRING, loc,
          };
          return { kind: "libCall", fn: "island.castFail", args: [inner, name], type: target, loc };
        }
      }
    }
    return lowerAsExpression(this, expr);
  }

  lowerPrefixUnary(expr: ts.PrefixUnaryExpression): IrExpr {
    return lowerPrefixUnary(this, expr);
  }

  lowerBinary(expr: ts.BinaryExpression): IrExpr {
    return lowerBinary(this, expr);
  }

  lowerCaughtTypeofTest(expr: ts.BinaryExpression, loc: SrcLoc): IrExpr | null {
    return lowerCaughtTypeofTest(this, expr, loc);
  }

  caughtRead(node: ts.Identifier, local: IrLocal, loc: SrcLoc): IrExpr {
    return caughtRead(this, node, local, loc);
  }

  caughtLocalOf(node: ts.Expression): IrLocal | null {
    return caughtLocalOf(this, node);
  }

  caughtToString(node: ts.Expression): IrExpr | null {
    return caughtToString(this, node);
  }

  lowerInstanceOf(expr: ts.BinaryExpression, loc: SrcLoc): IrExpr {
    return lowerInstanceOf(this, expr, loc);
  }

  lowerCall(expr: ts.CallExpression): IrExpr {
    // Ambient fetch (native in static builds, island-backed under
    // --dynamic) and dynamic import() claim their calls before the general
    // dispatch. The general identifier-call paths have no lowering for a
    // promise-returning ambient global, and `import` is a keyword callee no
    // identifier path matches.
    return (
      lowerFfiCall(this, expr) ??
      lowerFetchCall(this, expr) ??
      lowerStaticFetchCompanionCall(this, expr) ??
      lowerStaticAbortControllerCall(this, expr) ??
      lowerStaticAbortSignalListenerCall(this, expr) ??
      lowerStaticReadableStreamCancelCall(this, expr) ??
      lowerStaticReadableStreamControllerCall(this, expr) ??
      lowerStaticReadableStreamReaderCall(this, expr) ??
      lowerStaticResponseCall(this, expr) ??
      lowerFetchElementMethodCall(this, expr) ??
      lowerDynamicImportCall(this, expr) ??
      lowerCall(this, expr)
    );
  }

  isTopLevelFnSymbol(ident: ts.Identifier): boolean {
    return isTopLevelFnSymbol(this, ident);
  }

  lowerNestedFunctionDecl(stmt: ts.FunctionDeclaration): IrStmt {
    return lowerNestedFunctionDecl(this, stmt);
  }

  lambdaSignature(node: ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration | ts.MethodDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration,): { shapes: ParamShape[]; funcType: IrType & { kind: "func" } } {
    return lambdaSignature(this, node);
  }

  lowerLambda(node: ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration | ts.MethodDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration,): IrExpr {
    return lowerLambda(this, node);
  }

  lowerArrayMethodCall(call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    return lowerArrayMethodCall(this, call, access);
  }

  lowerMapMethodCall(call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    return lowerMapMethodCall(this, call, access);
  }

  lowerMapForEachCall(call: ts.CallExpression,
    receiver: IrExpr,
    mapT: IrType & { kind: "map" },): IrExpr {
    return lowerMapForEachCall(this, call, receiver, mapT);
  }

  buildMapForEachFn(name: string,
    mapT: IrType & { kind: "map" },
    arity: number,
    fnRet: IrType,
    loc: SrcLoc,): IrFunction {
    return buildMapForEachFn(this, name, mapT, arity, fnRet, loc);
  }

  lowerSetMethodCall(call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    return lowerSetMethodCall(this, call, access);
  }

  lowerSetForEachCall(call: ts.CallExpression,
    receiver: IrExpr,
    setT: IrType & { kind: "set" },): IrExpr {
    return lowerSetForEachCall(this, call, receiver, setT);
  }

  buildSetForEachFn(name: string,
    setT: IrType & { kind: "set" },
    arity: number,
    fnRet: IrType,
    loc: SrcLoc,): IrFunction {
    return buildSetForEachFn(this, name, setT, arity, fnRet, loc);
  }

  lowerRegexLiteral(expr: ts.RegularExpressionLiteral): IrExpr {
    return lowerRegexLiteral(this, expr);
  }

  lowerRegexMethodCall(call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    return lowerRegexMethodCall(this, call, access);
  }

  lowerStringMethodCall(call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    return lowerStringMethodCall(this, call, access);
  }

  lowerBytesNew(expr: ts.NewExpression, symbol: ts.Symbol | null | undefined): IrExpr | null {
    return lowerBytesNew(this, expr, symbol);
  }

  lowerBytesMethodCall(call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    return lowerBytesMethodCall(this, call, access);
  }

  lowerBufferStaticCall(call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    return lowerBufferStaticCall(this, call, access);
  }

  fieldTarget(access: ts.PropertyAccessExpression): FieldTarget | null {
    return fieldTarget(this, access);
  }

  uniqueSymbolKeyOf(key: ts.Expression): { sym: ts.Symbol; fieldName: string } | null {
    return uniqueSymbolKeyOf(this, key);
  }

  foldedStringKeyOf(expr: ts.Expression): string | null {
    return foldedStringKeyOf(this, expr);
  }

  accessorCall(className: string,
    member: string,
    obj: IrExpr,
    extraArgs: IrExpr[],
    ret: IrType,
    loc: SrcLoc,): IrExpr {
    return accessorCall(this, className, member, obj, extraArgs, ret, loc);
  }

  classIteratorOf(t: IrType): ClassIteratorInfo | null {
    return classIteratorOf(this, t);
  }

  classIteratorOpenCall(cit: ClassIteratorInfo, recv: IrExpr, loc: SrcLoc): IrExpr {
    return classIteratorOpenCall(this, cit, recv, loc);
  }

  classIteratorNextCall(cit: ClassIteratorInfo, itRef: IrExpr, loc: SrcLoc): IrExpr {
    return classIteratorNextCall(this, cit, itRef, loc);
  }

  classIteratorDrainCall(src: IrExpr, loc: SrcLoc, elemT?: IrType): IrExpr | null {
    return classIteratorDrainCall(this, src, loc, elemT);
  }

  classIteratorRestDrainCall(cit: ClassIteratorInfo, itVal: IrExpr, loc: SrcLoc): IrExpr {
    return classIteratorRestDrainCall(this, cit, itVal, loc);
  }

  fieldGetExpr(target: FieldTarget, loc: SrcLoc, blame: ts.Node): IrExpr {
    return fieldGetExpr(this, target, loc, blame);
  }

  fieldSetStmt(target: FieldTarget, value: IrExpr, loc: SrcLoc, blame: ts.Node): IrStmt {
    return fieldSetStmt(this, target, value, loc, blame);
  }

  lowerFieldCompound(access: ts.PropertyAccessExpression | ts.ElementAccessExpression,
    op: CompoundOp,
    rhsNode: ts.Expression | null,
    loc: SrcLoc,): IrStmt {
    return lowerFieldCompound(this, access, op, rhsNode, loc);
  }

  errorMessageArg(args: readonly ts.Expression[], loc: SrcLoc, blame: ts.Node): IrExpr {
    return errorMessageArg(this, args, loc, blame);
  }

  inheritsBuiltinErrorCtor(info: ClassInfo): boolean {
    return inheritsBuiltinErrorCtor(this, info);
  }

  inheritsBuiltinEmitterCtor(info: ClassInfo): boolean {
    return inheritsBuiltinEmitterCtor(this, info);
  }

  lowerNew(expr: ts.NewExpression): IrExpr {
    // `new Uint8Array(handle)` (and the other typed-array ctors) over an
    // ISLAND argument: the construction is an ENGINE operation — the
    // engine's own constructor over the engine's own value (an Emscripten
    // factory's `wasmBinary: new Uint8Array(buf)` where buf came off an
    // island readFileSync) — and the instance stays a handle. The static
    // bytes ctor cannot claim it (bytes never cross the boundary), so
    // this preempts only when the single argument is island-typed;
    // every static form keeps the standard path.
    if (
      this.dynamic &&
      ts.isIdentifier(expr.expression) &&
      expr.arguments?.length === 1 &&
      !ts.isSpreadElement(expr.arguments[0]!) &&
      /^(Uint8|Uint8Clamped|Int8|Uint16|Int16|Uint32|Int32|Float32|Float64|BigInt64|BigUint64)Array$/.test(
        expr.expression.text,
      ) &&
      this.isStdlibSymbol(this.resolveValueSymbol(expr.expression) ?? undefined) &&
      this.isIslandExpr(expr.arguments[0]!)
    ) {
      const loc = locOf(expr);
      const ctor: IrExpr = {
        kind: "jsOp", op: "globalGet", name: expr.expression.text, args: [], type: JSVAL, loc,
      };
      const arg = this.lowerExpr(expr.arguments[0]!);
      return { kind: "jsOp", op: "construct", args: [ctor, arg], type: JSVAL, loc };
    }
    return lowerAbortControllerNew(this, expr) ?? lowerResponseNew(this, expr) ?? lowerStaticReadableStreamNew(this, expr) ?? lowerNew(this, expr);
  }

  lowerFieldRead(expr: ts.PropertyAccessExpression): IrExpr | null {
    // `C.x` static reads first (the receiver is a CLASS, not an instance
    // — the instance field path below could never claim it), then static
    // access through class VALUES (classval-typed bindings).
    return lowerStaticFieldRead(this, expr) ?? lowerClassValueProperty(this, expr) ?? lowerFieldRead(this, expr);
  }

  lowerUnionProperty(expr: ts.PropertyAccessExpression): IrExpr | null {
    return lowerUnionProperty(this, expr);
  }

  lowerRecordFieldCall(call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    return lowerRecordFieldCall(this, call, access);
  }

  lowerObjectMethodCall(call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    return lowerObjectMethodCall(this, call, access);
  }

  lowerSuperMethodCall(call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr {
    return lowerSuperMethodCall(this, call, access);
  }

  superThisRef(access: ts.PropertyAccessExpression): { thisRef: IrExpr; base: ClassInfo } {
    return superThisRef(this, access);
  }

  lowerSuperAccessorRead(access: ts.PropertyAccessExpression): IrExpr {
    return lowerSuperAccessorRead(this, access);
  }

  lowerSuperAccessorWrite(access: ts.PropertyAccessExpression,
    rhs: ts.Expression,
    loc: SrcLoc,): IrStmt {
    return lowerSuperAccessorWrite(this, access, rhs, loc);
  }

  /* ── comptime (compile-time evaluation) ───────────────────────────── */

  lowerComptime(expr: ts.CallExpression): IrExpr {
    return lowerComptime(this, expr);
  }

  comptimeBakeable(t: IrType): boolean {
    return comptimeBakeable(this, t);
  }

  rejectComptimeCaptures(cb: ts.ArrowFunction | ts.FunctionExpression): void {
    return rejectComptimeCaptures(this, cb);
  }

  comptimeValueToIr(value: unknown,
    expected: IrType,
    path: string,
    blame: ts.Node,): IrExpr {
    return comptimeValueToIr(this, value, expected, path, blame);
  }

  isConsoleLog(call: ts.CallExpression): boolean {
    return isConsoleLog(this, call);
  }

  consoleCallMember(call: ts.CallExpression): "log" | "info" | "debug" | "error" | "warn" | null {
    return consoleCallMember(this, call);
  }

  /* ── standard library (process + node:fs) ─────────────────────────── */

  builtinImportOf(ident: ts.Identifier): { module: string; member: string } | null {
    return builtinImportOf(this, ident);
  }

  /** The namespace-import twin of builtinImportOf's provenance rule:
   * resolves an expression to the supported builtin MODULE whose members
   * it exposes — an identifier declared by `import * as ns from "node:fs"`
   * (through the symbol, so shadowing locals never match), or a nested
   * member access that IS a module in its own right (`fs.promises` — the
   * same object as node:fs/promises, Node's rule). Null otherwise. */
  builtinNamespaceModuleOf(expr: ts.Expression): string | null {
    if (ts.isIdentifier(expr)) {
      const symbol = this.checker.getSymbolAtLocation(expr);
      const decl = symbol ? this.checker.declarationsOf(symbol)[0] : undefined;
      if (!decl) return null;
      // The CommonJS twin: `const fs = require("fs")` binds the same
      // namespace surface as `import * as fs from "node:fs"` — and the
      // createRequire spelling (`const fs = require("node:fs")` through a
      // createRequire binding, the fallback-typed cast idiom stripped)
      // binds it too.
      if (ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name) && decl.initializer) {
        const spec = requireSpecOf(decl.initializer);
        if (spec !== null) return canonicalBuiltinModule(spec);
        const init = stripTypeCasts(decl.initializer);
        if (ts.isCallExpression(init)) {
          const cr = createRequireSpecOf(this, init);
          if (cr !== null && cr.spec !== null) return canonicalBuiltinModule(cr.spec);
        }
        return null;
      }
      // A DESTRUCTURED sub-namespace binding — `const { promises } =
      // fs` / `= require('fs')`: the member is itself a supported module
      // ("fs/promises"), so the binding carries that module's namespace
      // surface. canonicalBuiltinModule gates the composition (an
      // ordinary destructured FUNCTION binding composes to an unknown
      // name and answers null — builtinImportOf owns those).
      if (ts.isBindingElement(decl) && ts.isObjectBindingPattern(decl.parent) &&
          ts.isVariableDeclaration(decl.parent.parent) && decl.parent.parent.initializer !== undefined &&
          decl.propertyName === undefined && decl.initializer === undefined) {
        const name = decl.name;
        if (name === undefined || !ts.isIdentifier(name)) return null;
        const init = decl.parent.parent.initializer;
        const spec = requireSpecOf(init);
        const outer = spec !== null
          ? canonicalBuiltinModule(spec)
          : ts.isIdentifier(init) ? this.builtinNamespaceModuleOf(init) : null;
        if (outer !== null) return canonicalBuiltinModule(`${outer}/${name.text}`);
        return null;
      }
    }
    // The INLINE CommonJS spelling: `require("cluster").isPrimary` — the
    // call expression IS the module namespace (Node evaluates the member
    // off the module object; a supported module's members key the same
    // tables as any namespace binding).
    {
      const spec = requireSpecOf(expr);
      if (spec !== null) return canonicalBuiltinModule(spec);
    }
    // The createRequire spelling of the same inline form:
    // `require("node:path").join(...)` through a createRequire binding
    // (the fallback-typed cast idiom strips: `(require("x") as T).m`).
    {
      const inner = stripTypeCasts(expr);
      if (ts.isCallExpression(inner)) {
        const cr = createRequireSpecOf(this, inner);
        if (cr !== null && cr.spec !== null) return canonicalBuiltinModule(cr.spec);
      }
    }
    if (ts.isIdentifier(expr)) {
      const symbol = this.checker.getSymbolAtLocation(expr);
      const decl = symbol ? this.checker.declarationsOf(symbol)[0] : undefined;
      if (!decl) return null;
      // The DEFAULT-import twin: Node's default export of a CJS builtin
      // IS the module object, so `import path from "node:path"` exposes
      // exactly the namespace form's member surface for EVERY supported
      // builtin (preflight admits the spelling in JS sources, plus the
      // callable module objects — assert, events, test — everywhere).
      if (ts.isImportClause(decl) && decl.name) {
        const importDecl = decl.parent;
        if (ts.isImportDeclaration(importDecl) && ts.isStringLiteral(importDecl.moduleSpecifier)) {
          return canonicalBuiltinModule(importDecl.moduleSpecifier.text);
        }
      }
      if (!ts.isNamespaceImport(decl)) return null;
      const importDecl = decl.parent.parent;
      if (!ts.isImportDeclaration(importDecl) || !ts.isStringLiteral(importDecl.moduleSpecifier)) return null;
      return canonicalBuiltinModule(importDecl.moduleSpecifier.text);
    }
    if (ts.isPropertyAccessExpression(expr) && !expr.questionDotToken && ts.isIdentifier(expr.expression)) {
      const outer = this.builtinNamespaceModuleOf(expr.expression);
      if (outer === null) return null;
      return canonicalBuiltinModule(`${outer}/${expr.name.text}`);
    }
    return null;
  }

  /** A member access on a supported builtin namespace import —
   * `fs.readFileSync`, `path.sep`, `fs.promises.readFile` — as the same
   * { module, member } shape builtinImportOf gives named imports, so both
   * import forms key the same lowering tables. Null for everything else. */
  builtinMemberOf(access: ts.PropertyAccessExpression): { module: string; member: string } | null {
    if (access.questionDotToken) return null;
    const module = this.builtinNamespaceModuleOf(access.expression);
    if (module !== null) return { module, member: access.name.text };
    // The RE-EXPORT FACADE's namespace spelling: `import * as assert from
    // "./facade.js"` over `export { ok } from "node:assert"` (the formatter idiom's
    // universal/assert). The member's symbol is the facade's
    // ExportSpecifier, and builtinImportOf's alias chase answers the
    // builtin's own module/member — the same tables as a direct import;
    // ordinary property symbols are not aliases and never match.
    return ts.isIdentifier(access.name) ? builtinImportOf(this, access.name) : null;
  }

  /** `ns.member(...)` on a builtin namespace import: exactly the named-
   * import dispatch — the module tables for lowered members, the module-
   * qualified per-member fence for the rest. Null for non-namespace
   * callees (the call chain keeps trying). */
  lowerNamespaceBuiltinCall(call: ts.CallExpression, access: ts.PropertyAccessExpression): IrExpr | null {
    const bi = this.builtinMemberOf(access);
    if (!bi) return null;
    // The timers spoke: `timers.setTimeout(...)` through a namespace or
    // require binding IS the global (Node's timers module re-exports
    // them) — the shared member lowering serves both spellings.
    if (bi.module === "timers") {
      const timersServed = lowerTimersMemberCall(this, call, bi.member, locOf(access));
      if (timersServed) return timersServed;
    }
    // The assert spoke owns node:assert wholesale (every call shape is
    // special-cased — optional messages, per-type comparisons, synthesized
    // deep-equality helpers).
    const assertServed = this.lowerAssertModuleCall(call, bi, locOf(access));
    if (assertServed) return assertServed;
    // The node:test spoke owns its module the same way (`test.skip(...)`
    // through the default import is a namespace-member call here).
    const testServed = this.lowerNodeTestModuleCall(call, bi, locOf(access));
    if (testServed) return testServed;
    // The util spoke owns inspect/format the same way (per-type
    // synthesized traversal helpers, compile-time format strings).
    const utilServed = this.lowerUtilModuleCall(call, bi, locOf(access));
    if (utilServed) return utilServed;
    // The dgram/dns spoke owns those modules for namespace imports too
    // (`import * as dns from "node:dns"` — portless's form): every call
    // shape is special-cased there, so it never rides the param tables.
    const dgramServed = this.lowerDgramDnsModuleCall(call, bi, locOf(access));
    if (dgramServed) return dgramServed;
    // The server-surface spoke owns net and http wholesale — the same
    // dispatch the named-import path takes (`net.createServer(...)` via
    // `import * as net` is portless's own spelling).
    const served = this.lowerNetModuleCall(call, bi, locOf(access));
    if (served) return served;
    // The stream spoke owns finished/pipeline the same way.
    const streamServed = lowerStreamModuleCall(this, call, bi, locOf(access));
    if (streamServed) return streamServed;
    // fs._toUnixTimestamp — off the param tables (an underscore-stable
    // internal), served by its own spoke before the table fence.
    const fsTs = this.lowerFsToUnixTimestampCall(call, bi, locOf(access));
    if (fsTs) return fsTs;
    // The fs validation-ladder spoke (checked-dynamic lane): misuse of
    // implemented-namespace members throws Node's typed errors instead
    // of meeting the table fence.
    const fsLadder = this.lowerFsLadderCall(call, bi, locOf(access));
    if (fsLadder) return fsLadder;
    // The crypto introspection statics (getFips and the name lists) bake
    // at the call site — no runtime entry exists to table.
    const cryptoServed = this.lowerCryptoModuleCall(call, bi, locOf(access));
    if (cryptoServed) return cryptoServed;
    const builtinFn = builtinModuleFnOf(this, bi.module, bi.member);
    if (!builtinFn) {
      this.noLowering(
        `${bi.module}.${bi.member}`,
        call,
        builtinFenceHintOf(bi.module, bi.member),
        this.checker.getSymbolAtLocation(access.name),
      );
    }
    return this.lowerBuiltinModuleCall(call, bi, builtinFn, locOf(access));
  }

  /** `ns.member` on a builtin namespace import as a VALUE: constants
   * (path.sep, os.EOL) read as interned string literals; fs.constants
   * access-mode bits bake as numbers exactly like the named-import form;
   * functions have no closure representation (call sites only); members
   * with no lowering fence with the module-qualified name. Null for
   * non-namespace receivers (the property chain keeps trying). */
  lowerNamespaceBuiltinProperty(expr: ts.PropertyAccessExpression): IrExpr | null {
    const loc = locOf(expr);
    // fs.constants.X_OK through the namespace: the same four POSIX
    // access-mode bits the named-import form bakes (lowerFsConstantsProperty).
    if (!expr.questionDotToken && ts.isPropertyAccessExpression(expr.expression)) {
      const inner = this.builtinMemberOf(expr.expression);
      if (inner && inner.module === "fs" && inner.member === "constants") {
        const MODES: Record<string, number | undefined> = { F_OK: 0, X_OK: 1, W_OK: 2, R_OK: 4 };
        const value = own(MODES, expr.name.text);
        if (value === undefined) {
          this.noLowering(
            `fs.constants.${expr.name.text}`,
            expr,
            "F_OK, R_OK, W_OK, and X_OK are the lowered constants",
          );
        }
        return { kind: "numLit", value, type: F64, loc };
      }
    }
    const bi = this.builtinMemberOf(expr);
    if (!bi) return null;
    // events.defaultMaxListeners READS the process-wide default (its
    // write twin routes through emitter.setDefaultMaxChk).
    if (bi.module === "events" && bi.member === "defaultMaxListeners") {
      return { kind: "libCall", fn: "emitter.getDefaultMax", args: [], type: F64, loc };
    }
    const c = builtinModuleConstOf(this, bi.module, bi.member);
    if (c !== undefined) return builtinConstLit(c, loc);
    // module.builtinModules through a namespace binding — the baked
    // Node v24 list, a fresh string[] per read.
    if (bi.module === "module" && bi.member === "builtinModules") {
      return builtinModulesArrayLit(loc);
    }
    // tls.rootCertificates through the namespace: the same runtime-valued
    // constant the named-import read lowers to.
    {
      const roots = lowerTlsRootCertificates(this, bi, loc);
      if (roots) return roots;
    }
    if (bi.member === "constants" && bi.module === "fs") {
      // A bare `fs.constants` read (not one of the baked bits above).
      this.noLowering(`fs.constants`, expr, "F_OK, R_OK, W_OK, and X_OK are the lowered constants");
    }
    if (builtinModuleFnOf(this, bi.module, bi.member)) {
      this.unsupported(
        "SC1090",
        expr,
        `library functions as values (call '${expr.getText()}' directly)`,
      );
    }
    this.noLowering(
      `${bi.module}.${bi.member}`,
      expr,
      builtinFenceHintOf(bi.module, bi.member),
      this.checker.getSymbolAtLocation(expr.name),
    );
  }

  lowerBuiltinModuleCall(expr: ts.CallExpression,
    bi: { module: string; member: string },
    fn: BuiltinModuleFn,
    loc: SrcLoc,): IrExpr {
    return lowerBuiltinModuleCall(this, expr, bi, fn, loc);
  }

  lowerFsToUnixTimestampCall(expr: ts.CallExpression,
    bi: { module: string; member: string },
    loc: SrcLoc,): IrExpr | null {
    return lowerFsToUnixTimestampCall(this, expr, bi, loc);
  }

  lowerFsLadderCall(expr: ts.CallExpression,
    bi: { module: string; member: string },
    loc: SrcLoc,): IrExpr | null {
    return lowerFsLadderCall(this, expr, bi, loc);
  }

  lowerChildArgsArg(node: ts.Expression | undefined, loc: SrcLoc): IrExpr {
    return lowerChildArgsArg(this, node, loc);
  }

  lowerSpawnSyncCall(expr: ts.CallExpression, loc: SrcLoc): IrExpr {
    return lowerSpawnSyncCall(this, expr, loc);
  }

  lowerSpawnCall(expr: ts.CallExpression, loc: SrcLoc): IrExpr {
    return lowerSpawnCall(this, expr, loc);
  }

  lowerExecSyncCall(expr: ts.CallExpression, shell: boolean, loc: SrcLoc): IrExpr {
    return lowerExecSyncCall(this, expr, shell, loc);
  }

  recordToEnvPairs(node: ts.Expression): IrExpr {
    return recordToEnvPairs(this, node);
  }

  envToPairsHelper(shapeId: string, loc: SrcLoc): string | null {
    return lowerEnvToPairsHelper(this, shapeId, loc);
  }

  lowerJsonMethodCall(call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    return lowerJsonMethodCall(this, call, access);
  }

  fencedBuiltinImportOf(ident: ts.Identifier): string | null {
    return fencedBuiltinImportOf(this, ident);
  }

  lowerCryptoComposedCall(call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    return lowerCryptoComposedCall(this, call, access);
  }

  lowerUrlMethodCall(call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    return lowerUrlMethodCall(this, call, access);
  }

  lowerSearchParamsMethodCall(call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    return lowerSearchParamsMethodCall(this, call, access);
  }

  lowerStatsMethodCall(call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    return lowerStatsMethodCall(this, call, access);
  }

  lowerChildMethodCall(call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    return lowerChildMethodCall(this, call, access);
  }

  lowerAtomicsCall(call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    return lowerAtomicsCall(this, call, access);
  }

  // The server-surface spoke (lower-server.ts): net module calls, the
  // netServer/netSocket method surface, and the composed address().port.
  lowerNetModuleCall(expr: ts.CallExpression,
    bi: { module: string; member: string },
    loc: SrcLoc,): IrExpr | null {
    return lowerNetModuleCall(this, expr, bi, loc);
  }

  lowerServerMethodCall(call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    return lowerServerMethodCall(this, call, access);
  }

  lowerServerProperty(expr: ts.PropertyAccessExpression): IrExpr | null {
    return lowerServerProperty(this, expr);
  }

  // The dgram/dns spoke (lower-dgram.ts): dgram/dns module calls and the
  // dgramSocket method surface.
  lowerAssertModuleCall(expr: ts.CallExpression,
    bi: { module: string; member: string },
    loc: SrcLoc,): IrExpr | null {
    return lowerAssertModuleCall(this, expr, bi, loc);
  }

  lowerAssertDirectCall(expr: ts.CallExpression, loc: SrcLoc): IrExpr | null {
    return lowerAssertDirectCall(this, expr, loc);
  }

  // The util spoke (lower-inspect.ts): inspect/format/formatWithOptions.
  lowerUtilModuleCall(expr: ts.CallExpression,
    bi: { module: string; member: string },
    loc: SrcLoc,): IrExpr | null {
    return lowerUtilModuleCall(this, expr, bi, loc);
  }

  lowerDgramDnsModuleCall(expr: ts.CallExpression,
    bi: { module: string; member: string },
    loc: SrcLoc,): IrExpr | null {
    return lowerDgramDnsModuleCall(this, expr, bi, loc);
  }

  lowerDgramMethodCall(call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    return lowerDgramMethodCall(this, call, access);
  }

  // The node:test spoke (lower-test.ts): registrations, suites, hooks,
  // and the TestContext surface.
  lowerNodeTestModuleCall(expr: ts.CallExpression,
    bi: { module: string; member: string },
    loc: SrcLoc,): IrExpr | null {
    return lowerNodeTestModuleCall(this, expr, bi, loc);
  }

  lowerTestDirectCall(expr: ts.CallExpression, loc: SrcLoc): IrExpr | null {
    return lowerTestDirectCall(this, expr, loc);
  }

  lowerTestMethodCall(call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    return lowerTestMethodCall(this, call, access);
  }

  lowerTestCtxProperty(expr: ts.PropertyAccessExpression): IrExpr | null {
    return lowerTestCtxProperty(this, expr);
  }

  lowerHttpHeadersElement(expr: ts.ElementAccessExpression): IrExpr | null {
    return lowerHttpHeadersElement(this, expr);
  }

  lowerJsonProperty(expr: ts.PropertyAccessExpression): IrExpr | null {
    return lowerJsonProperty(this, expr);
  }

  lowerErrorCodeProperty(expr: ts.PropertyAccessExpression): IrExpr | null {
    return lowerErrorCodeProperty(this, expr);
  }

  lowerStringDecoderMethodCall(call: ts.CallExpression, access: ts.PropertyAccessExpression): IrExpr | null {
    return lowerStringDecoderMethodCall(this, call, access);
  }

  lowerReadlineMethodCall(call: ts.CallExpression, access: ts.PropertyAccessExpression): IrExpr | null {
    return lowerReadlineMethodCall(this, call, access);
  }

  lowerDcChannelMethodCall(call: ts.CallExpression, access: ts.PropertyAccessExpression): IrExpr | null {
    return lowerDcChannelMethodCall(this, call, access);
  }

  lowerAlsMethodCall(call: ts.CallExpression, access: ts.PropertyAccessExpression): IrExpr | null {
    return lowerAlsMethodCall(this, call, access);
  }

  lowerDcChannelProperty(access: ts.PropertyAccessExpression): IrExpr | null {
    return lowerDcChannelProperty(this, access);
  }

  lowerDcTracingChannelMethodCall(call: ts.CallExpression, access: ts.PropertyAccessExpression): IrExpr | null {
    return lowerDcTracingChannelMethodCall(this, call, access);
  }

  lowerDcTracingChannelProperty(access: ts.PropertyAccessExpression): IrExpr | null {
    return lowerDcTracingChannelProperty(this, access);
  }

  strdecHelper(op: "write" | "end", shapeId: string, loc: SrcLoc): string {
    return strdecHelper(this, op, shapeId, loc);
  }

  lowerProcessProperty(expr: ts.PropertyAccessExpression): IrExpr | null {
    return lowerProcessProperty(this, expr);
  }

  lowerFsConstantsProperty(expr: ts.PropertyAccessExpression): IrExpr | null {
    return lowerFsConstantsProperty(this, expr);
  }

  lowerBuiltinConstantsProperty(expr: ts.PropertyAccessExpression): IrExpr | null {
    return lowerBuiltinConstantsProperty(this, expr);
  }

  builtinConstantBindingOf(ident: ts.Identifier): IrExpr | null {
    return builtinConstantBindingOf(this, ident);
  }

  builtinConstantsDestructureDecl(nameNode: ts.Node, init: ts.Expression | undefined): boolean {
    return builtinConstantsDestructureDecl(this, nameNode, init);
  }

  lowerCryptoModuleCall(expr: ts.CallExpression, bi: { module: string; member: string }, loc: SrcLoc): IrExpr | null {
    return lowerCryptoModuleCall(this, expr, bi, loc);
  }

  lowerProcessStreamProperty(expr: ts.PropertyAccessExpression): IrExpr | null {
    return lowerProcessStreamProperty(this, expr);
  }

  isProcessEnv(node: ts.Expression): boolean {
    return isProcessEnv(this, node);
  }

  envValueType(): IrType {
    return envValueType(this);
  }

  lowerProcessEnvGet(expr: ts.PropertyAccessExpression): IrExpr | null {
    return lowerProcessEnvGet(this, expr);
  }

  lowerProcessMethodCall(call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    return lowerProcessMethodCall(this, call, access);
  }

  lowerProcessOptionalMethodCall(call: ts.CallExpression): IrExpr | null {
    return lowerProcessOptionalMethodCall(this, call);
  }

  lowerTimeoutMethodCall(call: ts.CallExpression, access: ts.PropertyAccessExpression): IrExpr | null {
    return lowerTimeoutMethodCall(this, call, access);
  }

  promisifiedExecFileDecl(nameNode: ts.Node, init: ts.Expression | undefined): boolean {
    return promisifiedExecFileDecl(this, nameNode, init);
  }

  lowerExecFileAsyncCall(expr: ts.CallExpression, loc: SrcLoc): IrExpr {
    return lowerExecFileAsyncCall(this, expr, loc);
  }

  execFileAsyncHelper(loc: SrcLoc): { name: string; shapeId: string } {
    return execFileAsyncHelper(this, loc);
  }

  envSnapshotHelper(shapeId: string, loc: SrcLoc): string | null {
    return envSnapshotHelper(this, shapeId, loc);
  }

  lowerNumberStaticCall(call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    return lowerNumberStaticCall(this, call, access);
  }

  lowerDateCall(call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    return lowerDateCall(this, call, access);
  }

  lowerTextCodecCall(call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    return lowerTextCodecCall(this, call, access);
  }

  lowerStringStaticCall(call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    return lowerStringStaticCall(this, call, access);
  }

  lowerStringLastIndexOfCall(call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    return lowerStringLastIndexOfCall(this, call, access);
  }

  lowerFilterNarrowCall(call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    return lowerFilterNarrowCall(this, call, access);
  }

  lowerPromiseMethodCall(call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    return lowerPromiseMethodCall(this, call, access);
  }

  lowerPromiseStaticCall(call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    return lowerPromiseStaticCall(this, call, access);
  }

  lowerNumberStaticProperty(expr: ts.PropertyAccessExpression): IrExpr | null {
    return lowerNumberStaticProperty(this, expr);
  }

  /* ── the island-backed ambient surface (ISLAND_SURFACE) ───────────── */

  requireDynamicApi(feature: string, node: ts.Node): void {
    return requireDynamicApi(this, feature, node);
  }

  lowerMathProperty(expr: ts.PropertyAccessExpression): IrExpr | null {
    return lowerMathProperty(this, expr);
  }

  islandGlobalFnOf(ident: ts.Identifier): IslandFnEntry | null {
    return islandGlobalFnOf(this, ident);
  }

  lowerIslandMethodCall(call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    return lowerIslandMethodCall(this, call, access);
  }
}
