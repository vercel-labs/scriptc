import { isIslandPromisifyCall, noteIslandSubclass } from "./lower-node-island.js";
import { isIslandSubclassDecl } from "../../node-islands/boundary.js";
import { THREADS_MODULE } from "../threads-import.js";
import { collectIslandImport } from "./lower-node-island.js";
import { NODE_API_MODULE } from "../node-api-import.js";
import { positionTag } from "./structural-positions.js";
import { EXPERIMENTAL_MODULE } from "../experimental-import.js";
import { dynUndefinedExpr } from "../../ir/build.js";
import { everyStmtList, everyTypeChild } from "../../ir/traverse.js";
import { InternalCompilerError } from "../../errors.js";
/* Module-graph lowering: splitting each source file into its parts, the
 * program-collection pass (signatures, classes, globals — reachability
 * seeds), npm/JSON import collection, per-file %init functions, %main, and
 * the module artifacts (globals, embedded npm tables) the IR module carries. */
import * as ts from "../ts7/adapter.js";
import { collectRebindableFunctions, isRebindableFunction } from "./rebindable-functions.js";
import { bindingSource } from "../binding-source.js";
import type { Lowerer } from "./lowerer.js";
import {
  sharedInitFlagStores,
  sharedModulePlans,
  sharedModuleRegistrations,
} from "./lower-shared-modules.js";
import { dirname as dirnamePath, resolve as resolvePath } from "node:path";
import { packageNameOfPath, probeNodeImportRefusal } from "../npm.js";
import { isNpmStaticPackage } from "../npm-static.js";
import { isJsSourceFileName } from "../tsc-codes.js";
import { isRelativeSpecifier } from "../workspace-registry.js";
import {
  canonicalBuiltinModule,
  cjsExportAssignmentOf,
  cjsExportChainOf,
  cjsVoidInitPreambleReals,
  cjsExportDiscardReason,
  cjsExportTargetLiteral,
  entryPackageFilePredicate,
  isCjsJsFile,
  isJsSourceFile,
  isRequireStatement,
  locOf,
  makeCycleAdmission,
  orderedImportsOf,
  requireSpecOf,
  resolveImport,
  resolveNpmImport,
} from "../program.js";
import type { CycleEdge } from "../program.js";
import {
  markCycleEarlyBindings,
  withClassInitFlag,
  withCycleInitFlags,
} from "./cycle-initialization.js";
import { markRequireEarlyBindings } from "./require-initialization.js";
import {
  cjsTableMethodEntry,
  inlineProgramRequireOf,
  nestedCjsExportAssignmentsOf,
  requireNestedPatternsOf,
} from "./cjs-inline-require.js";
import { isDeadTscHelperDecl, tscInteropBindingOfDecl } from "./cjs-tsc-interop.js";
import { collectJsonRequires, isJsonRequireDecl } from "./json-require.js";
import {
  invalidJsonModuleDiag,
  unsupportedPackageImportDiag,
} from "../../diagnostics/diagnostic.js";
import {
  BOOL,
  CAUGHT,
  DYN,
  F64,
  type IrClassDef,
  type IrExpr,
  type IrFunction,
  type IrGlobal,
  type IrRecordShape,
  type IrStmt,
  type IrType,
  type IrUnionDef,
  RUNTIME_ERROR_CLASSES,
  STRING,
  type SrcLoc,
  VOID,
  arrayOf,
  canBoxFuncIntoDyn,
  canConvertToDyn,
  isUnitType,
} from "../../ir/ir.js";
import {
  ENTRY_NAME,
  PoisonError,
  boundIdentifiersOf,
  dynFallbackType,
  newFnCtx,
  staticImportNamespaceType,
} from "./lowerer.js";
import {
  isNativeFfiRequire,
  builtinMemberRequireDecl,
  builtinNamespaceDestructureModuleOf,
  createRequireBindingDecl,
  createRequireNamespaceDecl,
  createRequireProgramModuleDecl,
} from "./builtins/module-bindings.js";
import { isPromisifyCall, registerBuiltinCallableAlias } from "./builtins/callable-aliases.js";
import { registerBuiltinClassAlias } from "./builtins/class-values.js";
import { stripTypeCasts } from "./builtins/arguments.js";
import { isWebCryptoMemberType } from "./builtins/webcrypto.js";
import {
  bindingContextualGenericFnNodeOf,
  bindingGenericFnAliasInfoOf,
  bindingGenericFnInfoOf,
  bindingGenericFnNodeOf,
  implicitLocalFnInfoOf,
  implicitLocalFnNodeOf,
} from "./generic-functions.js";
import {
  bindingNeverReassigned,
  deadUnmappableBinding,
  nullishGenericBindingUnitOf,
} from "./binding-analysis.js";
import { funcTypeFromParamShapes, registerOverloadedCallableAlias } from "./call-signatures.js";
import {
  jsBindingHasOpenWrites,
  hasJsTypeAnnotation,
  isVarDeclared,
  numericIteratorSourceOf,
  provenanceElidedConstDecl,
  stdlibBufferVarAlias,
} from "./lower-stmts.js";
import { objectFactoryGlobalType } from "./object-factory-new.js";
import { streamClassAliasDecl } from "./lower-stream.js";
import { isAssertClassNew } from "./assert-instances.js";
import { stdlibGlobalAliasDecl, stdlibGlobalAliasNameOf, stdlibGlobalNameOf } from "./surfaces.js";
import { isNativeBuiltinValueInitializer } from "./lower-builtin-values.js";
import { isPromisePrototypeRead } from "./expressions/property-access.js";
import {
  collectNamespaceStmt,
  nsMemberIdentOf,
  nsPathPrefix,
  trapDeclRootOf,
} from "./lower-namespaces.js";
import { collectExpandoMembers } from "./lower-expando.js";
import { recordTextCodecClass } from "../../ir/ir.js";
import { isUnitOnlyTsType, unitOnlyUnion } from "../type-mapper.js";
import type { ClassInfo } from "./lower-classes.js";
import {
  builtinRequireBaseOf,
  collectInheritedJsFieldWrites,
  collectVirtualJsMethods,
  decoratorNodesOf,
  genericIfaceBindingKeepsClass,
  guaranteedDecorationThrow,
  storedClassValueType,
} from "./lower-classes.js";
import { isMixinFnBinding, mixinResultBindingClassOf } from "./lower-mixins.js";
import { cjsModuleRef, cjsModuleRegistryPrelude } from "./lower-node-module.js";
import { forkTargetPaths } from "../fork-target.js";
import { workerTargetPaths } from "../worker-target.js";
import { isNativeProxyInitializer } from "./expressions/native-proxy.js";
import { handleEventReaderPrelude } from "./lower-event-target.js";
import { dateClassOperationPrelude } from "./builtins/date-classes.js";
import { cjsAccessorSnapshotStores, jsHoldsDynObject } from "./lower-exprs.js";
import { keptIdentityAssertion } from "./assertion-identity.js";

/** One file's declarations, split for collection and init-body lowering. */
export interface FileParts {
  sf: ts.SourceFile;
  fnDecls: ts.FunctionDeclaration[];
  classDecls: ts.ClassDeclaration[];
  topStmts: ts.Statement[];
}

/** Preflight's module graph (LoadResult.moduleEdges), for the walks that
 * append modules outside the startup order, and the set collecting the
 * inline require() calls that close a cycle there. */
export interface AppendGraph {
  edges?: ReadonlyMap<ts.SourceFile, readonly CycleEdge[]> | undefined;
  inlineCycleCalls?: Set<ts.Node>;
}

/** An appended module's edges: its import and export declarations, then
 * the require() edges preflight resolved — a CommonJS file's only edges
 * (the compiled CommonJS package a workspace module loaded on demand
 * imports, and the sibling packages and files IT requires). */
function appendedEdgesOf(
  program: ts.Program,
  graph: AppendGraph | undefined,
): (sf: ts.SourceFile) => CycleEdge[] {
  const cache = new Map<ts.SourceFile, CycleEdge[]>();
  return (sf) => {
    let out = cache.get(sf);
    if (out !== undefined) return out;
    out = orderedImportsOf(program, sf).flatMap(({ stmt, dep }) =>
      dep !== null && dep !== sf
        ? [{ dep, stmt: stmt as ts.ImportDeclaration | ts.ExportDeclaration }]
        : [],
    );
    for (const e of graph?.edges?.get(sf) ?? [])
      if (e.stmt === undefined && e.dep !== sf) out.push(e);
    cache.set(sf, out);
    return out;
  };
}

/** Lazy inline requires run after their module's top level: their modules
 * join the order afterwards, as in preflight's walk. */
function visitLazyEdges(
  sf: ts.SourceFile,
  edgesOf: (sf: ts.SourceFile) => CycleEdge[],
  state: ReadonlyMap<ts.SourceFile, "visiting" | "done">,
  visit: (sf: ts.SourceFile) => void,
): void {
  for (const e of edgesOf(sf)) if (e.lazy === true && state.get(e.dep) === undefined) visit(e.dep);
}

/** Program modules selected by statically resolved child_process.fork()
 * calls join the compiled graph without becoming startup dependencies of
 * the parent entry. Their guarded init functions are selected by %main only
 * in a re-executed fork child. `targets` is append-only so ids stay stable
 * across the dynamic-import/fork discovery fixpoint. */
export function appendForkModules(
  program: ts.Program,
  order: ts.SourceFile[],
  targets: ts.SourceFile[],
  onCycle: (cycle: string, reason: string) => void,
  graph?: AppendGraph,
): void {
  appendEntryModules(program, order, targets, forkTargetPaths(program, order), onCycle, graph);
}

export function appendWorkerModules(
  program: ts.Program,
  order: ts.SourceFile[],
  targets: ts.SourceFile[],
  onCycle: (cycle: string, reason: string) => void,
  graph?: AppendGraph,
): void {
  appendEntryModules(program, order, targets, workerTargetPaths(program, order), onCycle, graph);
}

function appendEntryModules(
  program: ts.Program,
  order: ts.SourceFile[],
  targets: ts.SourceFile[],
  paths: readonly string[],
  onCycle: (cycle: string, reason: string) => void,
  graph?: AppendGraph,
): void {
  if (order.length === 0) return;
  const byPath = new Map(
    program.getImplementationSourceFiles().map((sf) => [resolvePath(sf.fileName), sf] as const),
  );
  const state = new Map<ts.SourceFile, "visiting" | "done">();
  for (const sf of order) state.set(sf, "done");
  const added: ts.SourceFile[] = [];
  const stack: string[] = [];
  const staticEdgesOf = appendedEdgesOf(program, graph);
  const cycleAdmissionReason = makeCycleAdmission(program, (sf) =>
    staticEdgesOf(sf).filter((e) => e.call === undefined),
  );
  const visit = (sf: ts.SourceFile): void => {
    const prior = state.get(sf);
    if (prior === "done") return;
    state.set(sf, "visiting");
    stack.push(sf.fileName);
    for (const edge of staticEdgesOf(sf)) {
      if (edge.lazy === true) continue; // visited after this module completes
      const edgeState = state.get(edge.dep);
      if (edgeState === "done") continue;
      if (edgeState === "visiting") {
        if (edge.call !== undefined) {
          graph?.inlineCycleCalls?.add(edge.call);
          continue;
        }
        const reason = cycleAdmissionReason(sf, edge);
        if (reason !== null) {
          const cycleStart = stack.indexOf(edge.dep.fileName);
          onCycle([...stack.slice(cycleStart), edge.dep.fileName].join(" → "), reason);
        }
        continue;
      }
      visit(edge.dep);
    }
    stack.pop();
    state.set(sf, "done");
    added.push(sf);
    visitLazyEdges(sf, staticEdgesOf, state, visit);
  };

  const knownTargets = new Set(targets);
  for (const path of paths) {
    const target = byPath.get(resolvePath(path));
    if (!target || target.isDeclarationFile || target.fileName.endsWith(".json")) continue;
    if (!knownTargets.has(target)) {
      knownTargets.add(target);
      targets.push(target);
    }
    visit(target);
  }
  if (added.length > 0) order.splice(order.length - 1, 0, ...added);
}

/** Splits each file into function/class declarations and the top-level
 * statements that form its init body. Node's evaluation order (depth-first
 * postorder, entry last), computed by preflight. Single-file programs
 * (tests, coverage on broken files) may arrive with an empty order — fall
 * back to the entry alone. */
export function splitFiles(lowerer: Lowerer): FileParts[] {
  const files = lowerer.moduleOrder.length > 0 ? lowerer.moduleOrder : [lowerer.entry];
  return files.map((sf) => {
    const fp: FileParts = { sf, fnDecls: [], classDecls: [], topStmts: [] };
    const rebindable = collectRebindableFunctions(lowerer, sf);
    for (const stmt of sf.statements.nodes) {
      // A reassigned JavaScript declaration lives in a module global that
      // the init body assigns first (rebindable-functions.ts).
      if (ts.isFunctionDeclaration(stmt) && rebindable.has(stmt)) fp.topStmts.push(stmt);
      else if (ts.isFunctionDeclaration(stmt)) fp.fnDecls.push(stmt);
      // A native class extending an island class is a value the init body
      // creates at its position (NI-5b, lower-node-island.ts).
      else if (ts.isClassDeclaration(stmt) && noteIslandSubclass(lowerer, stmt))
        fp.topStmts.push(stmt);
      else if (ts.isClassDeclaration(stmt)) fp.classDecls.push(stmt);
      // Namespaces: ambient/type-only ones are zero-runtime and skip;
      // instantiated bodies FLATTEN into this file's parts (functions/
      // classes hoist under namespace-qualified names, statements join
      // the init body in source order) — lower-namespaces.ts.
      else if (ts.isModuleDeclaration(stmt)) collectNamespaceStmt(lowerer, stmt, fp);
      else if (
        ts.isInterfaceDeclaration(stmt) ||
        ts.isTypeAliasDeclaration(stmt) ||
        ts.isImportDeclaration(stmt) ||
        // Export lists and re-exports are pure alias plumbing (importers
        // resolve through them to the original declarations); their
        // module EDGES live in preflight/buildInitSteps. Nothing runs.
        ts.isExportDeclaration(stmt)
      ) {
        continue; // type-only / already-resolved module plumbing
      } else fp.topStmts.push(stmt);
    }
    return fp;
  });
}

/** A source file dynamic `import("<project specifier>")` can host as a COMPILED
 * module namespace (lowerOwnModuleImport): a non-declaration program file
 * that is not JSON and not CommonJS-flavored (a CJS namespace is built
 * from module.exports through Node's lexer — a different surface with no
 * static story here). Null for everything else. */
function dynamicImportProgramTargetOf(
  program: ts.Program,
  sf: ts.SourceFile,
  spec: string,
): ts.SourceFile | null {
  const dep = resolveImport(program, sf, spec);
  if (!dep || dep.isDeclarationFile) return null;
  if (dep.fileName.endsWith(".json") || dep.fileName.endsWith(".cts")) return null;
  if (isCjsJsFile(dep, program)) return null;
  return dep;
}

/** Every distinct program module a file's `import("literal")` sites name
 * (source order, deduped). */
function dynamicProgramImportsOf(program: ts.Program, sf: ts.SourceFile): ts.SourceFile[] {
  const out: ts.SourceFile[] = [];
  const seen = new Set<ts.SourceFile>();
  ts.walkPreorder(sf, (node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.nodes[0] !== undefined &&
      ts.isStringLiteralLike(node.arguments.nodes[0])
    ) {
      const dep = dynamicImportProgramTargetOf(program, sf, node.arguments.nodes[0].text);
      if (dep && !seen.has(dep)) {
        seen.add(dep);
        out.push(dep);
      }
    }
  });
  return out;
}

export function appendDynamicImportModules(
  program: ts.Program,
  order: ts.SourceFile[],
  onCycle: (cycle: string, reason: string) => void,
  graph?: AppendGraph,
): void {
  if (order.length === 0) return; // no preflight order — sites keep their fences
  const state = new Map<ts.SourceFile, "visiting" | "done">();
  for (const sf of order) state.set(sf, "done");
  const added: ts.SourceFile[] = [];
  const stack: string[] = [];
  const staticEdgesOf = appendedEdgesOf(program, graph);
  const cycleAdmissionReason = makeCycleAdmission(program, (sf) =>
    staticEdgesOf(sf).filter((e) => e.call === undefined),
  );
  const visit = (sf: ts.SourceFile): void => {
    if (state.get(sf) !== undefined) return;
    state.set(sf, "visiting");
    stack.push(sf.fileName);
    for (const e of staticEdgesOf(sf)) {
      if (e.lazy === true) continue; // visited after this module completes
      const s = state.get(e.dep);
      if (s === "done") continue;
      if (s === "visiting") {
        if (e.call !== undefined) {
          graph?.inlineCycleCalls?.add(e.call);
          continue;
        }
        // A back edge: Node answers it from the cache. Same admission
        // question as preflight's static walk, same fence when refused.
        const reason = cycleAdmissionReason(sf, e);
        if (reason !== null) {
          const cycleStart = stack.indexOf(e.dep.fileName);
          onCycle([...stack.slice(cycleStart), e.dep.fileName].join(" → "), reason);
        }
        continue;
      }
      visit(e.dep);
    }
    stack.pop();
    state.set(sf, "done");
    added.push(sf);
    visitLazyEdges(sf, staticEdgesOf, state, visit);
  };
  const scanned = new Set<ts.SourceFile>();
  for (;;) {
    const scan = [...order, ...added].filter((sf) => !scanned.has(sf));
    if (scan.length === 0) break;
    for (const sf of scan) {
      scanned.add(sf);
      for (const dep of dynamicProgramImportsOf(program, sf)) visit(dep);
    }
  }
  if (added.length > 0) order.splice(order.length - 1, 0, ...added);
}

/** Collect pass over the WHOLE program: signatures, class shapes, and
 * file-scope globals visible everywhere → hoisting, mutual recursion, and
 * cross-module references resolve without extra handling. Runs in both passes —
 * signatures are cheap and calls resolve against them; only BODY lowering
 * is reachability-gated. */
export function collectProgram(lowerer: Lowerer, parts: FileParts[]): void {
  const computed = new Set<ts.ClassDeclaration>();
  for (const fp of parts)
    for (const decl of fp.classDecls) {
      const heritage = decl.heritageClauses?.nodes.find(
        (clause) => clause.token === ts.SyntaxKind.ExtendsKeyword,
      )?.types?.nodes[0]?.expression;
      if (heritage && ts.isCallExpression(heritage) && !builtinRequireBaseOf(lowerer, heritage))
        computed.add(decl);
    }
  // Descendants need the computed ancestor's completed layout before
  // their own fields and inherited methods can be collected.
  const computedSymbols = new Set(
    [...computed]
      .map((decl) => declSymbolOf(lowerer, decl))
      .filter((symbol) => symbol !== undefined),
  );
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const fp of parts)
      for (const decl of fp.classDecls) {
        if (computed.has(decl)) continue;
        const heritage = decl.heritageClauses?.nodes.find(
          (clause) => clause.token === ts.SyntaxKind.ExtendsKeyword,
        )?.types?.nodes[0]?.expression;
        const base =
          heritage && ts.isIdentifier(heritage) ? lowerer.resolveValueSymbol(heritage) : undefined;
        if (!base || !computedSymbols.has(base)) continue;
        computed.add(decl);
        const symbol = declSymbolOf(lowerer, decl);
        if (symbol) computedSymbols.add(symbol);
        expanded = true;
      }
  }
  lowerer.collecting = true;
  try {
    collectVirtualJsMethods(
      lowerer,
      parts.map((part) => part.sf),
    );
    collectInheritedJsFieldWrites(
      lowerer,
      parts.map((part) => part.sf),
    );
    for (const fp of parts)
      for (const decl of fp.classDecls) if (!computed.has(decl)) lowerer.collectClassShape(decl);
    for (const fp of parts) for (const decl of fp.fnDecls) lowerer.collectSignature(decl);
  } finally {
    lowerer.collecting = false;
  }
  // Globals are top-level (always reachable), so their collection reports
  // eagerly — including deferred-class flushes their types trigger. The
  // coverage remainder still needs the registrations but the emit pass
  // already reported the diagnostics; discard the duplicates.
  if (lowerer.remainder) {
    lowerer.diagSink = [];
    try {
      for (const fp of parts) lowerer.collectGlobals(fp.sf, fp.topStmts);
      lowerer.collectNpmImports(parts);
      lowerer.collectJsonImports(parts);
      collectJsonRequires(lowerer, parts);
    } finally {
      lowerer.diagSink = null;
    }
  } else {
    for (const fp of parts) lowerer.collectGlobals(fp.sf, fp.topStmts);
    lowerer.collectNpmImports(parts);
    lowerer.collectJsonImports(parts);
    collectJsonRequires(lowerer, parts);
  }
  for (const decl of computed) {
    const symbol = declSymbolOf(lowerer, decl);
    const wasCollecting: boolean = lowerer.collecting;
    lowerer.collecting = true;
    const previousSink = lowerer.diagSink;
    const deferred: import("../../diagnostics/diagnostic.js").ScrDiagnostic[] = [];
    lowerer.diagSink = deferred;
    const expression = decl.heritageClauses!.nodes.find(
      (clause) => clause.token === ts.SyntaxKind.ExtendsKeyword,
    )!.types.nodes[0]!.expression;
    const context = newFnCtx(false, null, null, DYN);
    lowerer.fnStack.push(context);
    try {
      let value = lowerer.lowerExpr(expression);
      const known = value.type.kind === "dyn" ? storedClassValueType(lowerer, expression) : null;
      if (known?.kind === "classval") value = lowerer.coerceToExpected(value, known);
      if (value.type.kind === "dyn" || value.type.kind === "func") {
        const name = `%class.base.${lowerer.classNamer(decl)}`;
        const loc = locOf(expression);
        lowerer.liftedFns.push({
          name,
          params: [],
          returnType: value.type,
          locals: context.locals,
          body: [{ kind: "return", value, loc }],
          loc,
        });
        lowerer.computedCallableBases.set(decl, {
          kind: "call",
          callee: name,
          args: [],
          type: value.type,
          loc,
        });
      }
      if (value.type.kind === "classval") {
        const classInfo = lowerer.classes.get(value.type.className);
        if (classInfo) {
          const name = `%class.base.${lowerer.classNamer(decl)}`;
          const loc = locOf(expression);
          lowerer.liftedFns.push({
            name,
            params: [],
            returnType: value.type,
            locals: context.locals,
            body: [{ kind: "return", value, loc }],
            loc,
          });
          lowerer.computedClassBases.set(lowerer.classNamer(decl), {
            value: { kind: "call", callee: name, args: [], type: value.type, loc },
            classInfo,
          });
        }
      }
    } catch (error) {
      if (!(error instanceof PoisonError)) throw error;
    } finally {
      lowerer.fnStack.pop();
      lowerer.diagSink = previousSink;
    }
    lowerer.diagSink = deferred;
    try {
      lowerer.collectClassShape(decl);
    } finally {
      lowerer.diagSink = previousSink;
    }
    if (symbol && deferred.length) {
      lowerer.deferredDiags.set(symbol, [
        ...(lowerer.deferredDiags.get(symbol) ?? []),
        ...deferred,
      ]);
      lowerer.deferredClassByName.set(lowerer.classNamer(decl), symbol);
    }
    lowerer.collecting = wasCollecting;
  }
  markCycleEarlyBindings(lowerer);
  markRequireEarlyBindings(lowerer);
}

export function collectNpmImports(lowerer: Lowerer, parts: FileParts[]): void {
  const entryPackageFile = entryPackageFilePredicate(lowerer.entry.fileName);
  for (const fp of parts) {
    for (const stmt of fp.sf.statements.nodes) {
      // NAMED re-exports from npm packages (`export { isUrl } from
      // "url-or-path"`): use the same package bindings as direct imports.
      const reexport =
        ts.isExportDeclaration(stmt) &&
        !stmt.isTypeOnly &&
        stmt.moduleSpecifier !== undefined &&
        ts.isStringLiteral(stmt.moduleSpecifier) &&
        stmt.exportClause !== undefined &&
        ts.isNamedExports(stmt.exportClause) &&
        stmt.exportClause.elements.nodes.some((e) => !e.isTypeOnly) &&
        !stmt.moduleSpecifier.text.startsWith("#")
          ? stmt.exportClause
          : null;
      if (
        reexport === null &&
        (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier))
      )
        continue;
      const specNode =
        ts.isImportDeclaration(stmt) || ts.isExportDeclaration(stmt)
          ? stmt.moduleSpecifier
          : undefined;
      if (specNode === undefined || !ts.isStringLiteral(specNode)) continue;
      const clause = ts.isImportDeclaration(stmt) ? stmt.importClause : undefined;
      if (ts.isImportDeclaration(stmt) && clause?.phaseModifier === ts.SyntaxKind.TypeKeyword)
        continue;
      if (
        clause?.namedBindings &&
        ts.isNamedImports(clause.namedBindings) &&
        !clause.name &&
        clause.namedBindings.elements.nodes.every((e) => e.isTypeOnly)
      ) {
        continue;
      }
      const spec = specNode.text;
      // --external-types owns this exact module interpretation. Even when
      // an install happens to resolve the same name (or --npm-static auto
      // selects its package), the declaration mapping owns this boundary.
      if (lowerer.externalTypes.has(spec)) continue;
      // A source-only workspace package is part of the program module
      // graph: resolveImport follows its node_modules link to the loaded
      // TypeScript entry. Its internal `.js` spellings have already been
      // resolved to `.ts` by that graph.
      if (!isRelativeSpecifier(spec) && resolveImport(lowerer.program, fp.sf, spec) !== null) {
        continue;
      }
      const npm = resolveNpmImport(fp.sf.fileName, spec);
      // --npm-static: an opted-in package that made it through preflight
      // is a PROGRAM-MODULE dependency — its entry sits in the module
      // order, orderedImportsOf answers it for the %init header, and the
      // checker's alias chains bind the imports to its own exports. The

      if (
        npm !== null &&
        isNpmStaticPackage(npm.packageName) &&
        isJsSourceFileName(npm.typesFile) &&
        lowerer.program.getSourceFile(npm.typesFile) !== undefined
      ) {
        continue;
      }
      // A RELATIVE specifier resolving INTO node_modules (the e2e driver
      // shape: `import "../node_modules/vercel/dist/index.js"`) is
      // package code too. Attribute it to the package so unselected source
      // receives a diagnostic instead of dropping the import.
      const relPkg =
        npm === null && isRelativeSpecifier(spec)
          ? packageNameOfPath(resolvePath(dirnamePath(fp.sf.fileName), spec))
          : null;
      const relIsJs = relPkg !== null && !/\.(ts|tsx|mts|cts)$/.test(spec);
      // A relative import INTO an opted-in --npm-static package is the
      // program-module path too (preflight resolved the file edge).
      if (relIsJs && isNpmStaticPackage(relPkg)) continue;
      if (relIsJs) {
        // An explicitly selected installed entry owns its package's
        // source graph. Preflight included these modules for native

        const dep = resolveImport(lowerer.program, fp.sf, spec);
        if (dep !== null && entryPackageFile(dep.fileName) && lowerer.fileTag.has(dep)) continue;
      }
      if (!npm && !relIsJs) continue;
      // scriptc's own @scriptc/threads and @scriptc/experimental: their
      // exports lower at their use sites (threads-import.ts,
      // experimental-import.ts); their Node.js bodies never run.
      if (
        npm?.packageName === THREADS_MODULE ||
        npm?.packageName === EXPERIMENTAL_MODULE ||
        npm?.packageName === NODE_API_MODULE
      )
        continue;
      // An edge Node's RUNTIME resolution refuses at startup (types
      // resolved, but the exports target ships no JS — the types-only
      // package shape): preflight registered Node's startup crash for
      // it, %main throws before any init runs, and the bindings never

      if (npm !== null && probeNodeImportRefusal(fp.sf.fileName, spec) !== null) continue;
      // A Node island package (scope-B NI-4): loaded in Node at this
      // module's position, its bindings are island values.
      if (collectIslandImport(lowerer, fp.sf, stmt, spec)) continue;
      {
        lowerer.pushDiag(unsupportedPackageImportDiag(npm?.packageName ?? relPkg!, locOf(stmt)));
        continue;
      }
    }
  }
  for (const fp of parts) collectDynamicImports(lowerer, fp.sf);
}

/** Literal dynamic-import collection: every
 * `import("literal")` in the file — whatever body it sits in — resolves
 * and embeds AT COLLECTION time, so the per-site lowering later just
 * looks its key up (the emitted tables are assembled once, here; a
 * site lowered in any pass finds its module embedded). Resolution
 * In static builds this records compiled program modules and supported
 * builtins without constructing an npm graph. Dynamic package-resolution
 * failures and unshimmed builtins are diagnostics HERE, at the import
 * expression, exactly like static npm imports at their statements; the
 * lowering poisons those sites without re-reporting. Non-literal
 * specifiers are skipped — the lowering owns that fence (the module
 * graph is a build-time artifact; there is nothing to embed for a
 * runtime-computed name). */
function collectDynamicImports(lowerer: Lowerer, sf: ts.SourceFile): void {
  ts.walkPreorder(sf, (node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.nodes.length >= 1 &&
      node.arguments.nodes[0] !== undefined &&
      ts.isStringLiteralLike(node.arguments.nodes[0])
    ) {
      const spec = node.arguments.nodes[0].text;
      if (lowerer.externalTypes.has(spec)) {
        return undefined;
      }
      const mapKey = `${sf.fileName}\u0000${spec}`;
      if (!lowerer.dynImports.has(mapKey)) {
        // The program's OWN modules first, by the checker's resolution
        // (tsc already resolved "./helper.js" to helper.ts): a compiled
        // module has no runtime namespace object — the per-site fence
        // says so. Only non-declaration source files count; a sibling
        // .d.mts typing shipped JS is the EMBED case, not this one.
        const modSym = lowerer.checker.getSymbolAtLocation(node.arguments.nodes[0]);
        const ownModule =
          modSym !== undefined &&
          modSym.declarations.some((d) => ts.isSourceFile(d) && !d.isDeclarationFile);
        const builtin = canonicalBuiltinModule(spec);
        const res = ownModule
          ? ({ kind: "program-module" } as const)
          : builtin !== null
            ? ({ kind: "static-builtin", module: builtin } as const)
            : undefined;
        if (res === undefined) {
          return undefined;
        }
        lowerer.dynImports.set(mapKey, res);
      }
    }
    return undefined;
  });
}

/** JSON module default imports (`import pkg from "../package.json"`):
 * the document is DATA known at build time, so the binding bakes into a
 * record global — the checker's structural type for the module (thanks
 * to resolveJsonModule) maps to a record shape, the JSON text parses in
 * the compiler, and comptimeValueToIr turns the value into literal IR
 * assigned in the importing module's %init prelude (evaluation order:
 * imports before the importer's body, like npm bindings). Two importers
 * of the same document share one global (keyed by the ALIASED symbol).
 * Shapes outside the bakeable surface (null-valued fields, mixed
 * arrays, ...) report the standard unsupported-type diagnostic at the
 * import site. Preflight already fenced named/namespace JSON imports
 * and kept .json files out of the module order. */
export function collectJsonImports(lowerer: Lowerer, parts: FileParts[]): void {
  for (const fp of parts) {
    for (const stmt of fp.sf.statements.nodes) {
      if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
      const clause = stmt.importClause;
      if (!clause?.name || clause.phaseModifier === ts.SyntaxKind.TypeKeyword) continue;
      const nameSym = lowerer.checker.getSymbolAtLocation(clause.name);
      if (!nameSym || !(nameSym.flags & ts.SymbolFlags.Alias)) continue;
      const target = lowerer.checker.getAliasedSymbol(nameSym);
      const jsonSf =
        target.declarations.length === 0
          ? undefined
          : ts.getSourceFileOfNode(target.declarations[0]!);
      if (!jsonSf || !jsonSf.fileName.endsWith(".json")) continue;
      try {
        const tsType = lowerer.typeOf(clause.name);
        const mapped = lowerer.mapTypeOf(tsType);
        if (!mapped || !lowerer.comptimeBakeable(mapped)) {
          lowerer.badType(clause.name, tsType);
        }
        // tsgo tolerates JSON shapes strict JSON.parse rejects (a leading
        // `//` comment — importAttributes11), so no SC0001 guarantees a
        // clean document: a failing parse gates at the import statement
        // (Node refuses to import the module at runtime too).
        let parsed: unknown;
        try {
          parsed = JSON.parse(jsonSf.text);
        } catch (e) {
          lowerer.pushDiag(
            invalidJsonModuleDiag(
              jsonSf.fileName,
              e instanceof Error ? e.message : String(e),
              locOf(stmt),
            ),
          );
          throw new PoisonError();
        }
        const value = lowerer.comptimeValueToIr(parsed, mapped, "$", clause.name);
        let g = lowerer.globalsBySymbol.get(target);
        if (!g) {
          g = {
            id: `%g.json.${lowerer.globalsList.length}`,
            name: clause.name.text,
            type: mapped,
            mutable: false,
          };
          lowerer.globalsBySymbol.set(target, g);
          lowerer.globalsList.push(g);
        }
        const actions = lowerer.jsonInitActions.get(fp.sf) ?? [];
        lowerer.jsonInitActions.set(fp.sf, actions);
        actions.push({ kind: "assign", localId: g.id, value, loc: locOf(stmt) });
      } catch (e) {
        if (!(e instanceof PoisonError)) throw e;
        // diagnostic already recorded; uses of the binding poison too
      }
    }
  }
}

/** The classes, records, and unions the emitted module carries: exactly
 * what the lowered functions and globals reference, closed transitively
 * over record fields, union arms, class field types, base chains, and
 * constructible descendants and their base chains. Registry entries interned while collecting
 * signatures nothing reaches stay out — an unreached type leaves no
 * trace. A referenced class with no registration had its collection
 * deferred: the reference flushes those diagnostics. Methods whose
 * bodies were not lowered leave the def's method list, so vtable slots
 * exist exactly for emitted overrides. */
export function moduleArtifacts(
  lowerer: Lowerer,
  functions: IrFunction[],
): {
  classes: IrClassDef[];
  records: IrRecordShape[];
  unions: IrUnionDef[];
} {
  const valueInstanceOfRoots = new Set<string>();
  const classNames = new Set<string>();
  const shapeIds = new Set<string>();
  const unionIds = new Set<string>();
  const pendingClasses: string[] = [];
  const pendingShapes: string[] = [];
  const pendingUnions: string[] = [];
  const boxedChild = (type: IrType, seen = new Set<string>()): boolean => {
    switch (type.kind) {
      case "child":
        return true;
      case "array":
      case "set":
        return boxedChild(type.elem, seen);
      case "promise":
        return boxedChild(type.inner, seen);
      case "map":
        return boxedChild(type.key, seen) || boxedChild(type.value, seen);
      case "func":
        return boxedChild(type.ret, seen);
      case "record":
        if (seen.has(type.shapeId)) return false;
        seen.add(type.shapeId);
        return (
          lowerer.shapes.get(type.shapeId)?.fields.some((field) => boxedChild(field.type, seen)) ??
          false
        );
      case "union":
        if (seen.has(type.unionId)) return false;
        seen.add(type.unionId);
        return lowerer.unions.get(type.unionId)?.arms.some((arm) => boxedChild(arm, seen)) ?? false;
      default:
        return false;
    }
  };
  const visitClass = (name: string): void => {
    if (classNames.has(name)) return;
    classNames.add(name);
    pendingClasses.push(name);
  };
  const visitShape = (id: string): void => {
    if (shapeIds.has(id)) return;
    shapeIds.add(id);
    pendingShapes.push(id);
  };
  const visitUnion = (id: string): void => {
    if (unionIds.has(id)) return;
    unionIds.add(id);
    pendingUnions.push(id);
  };
  const visitType = (type: IrType): boolean => {
    switch (type.kind) {
      case "object":
      case "classval":
        visitClass(type.className);
        break;
      case "record":
        visitShape(type.shapeId);
        break;
      case "union":
        visitUnion(type.unionId);
        break;
    }
    return everyTypeChild(type, visitType);
  };
  const visitor = {
    expr: (node: IrExpr): boolean => {
      visitType(node.type);
      switch (node.kind) {
        case "fieldIncDec":
        case "new":
        case "classRef":
        case "instanceOf":
        case "virtualCall":
        case "fieldGet":
        case "caughtCheck":
          visitClass(node.className);
          break;
        case "caughtTest":
          if (node.className !== undefined) visitClass(node.className);
          break;
        case "recordGet":
        case "recordKeyGet":
        case "recordOvfKeys":
        case "recordOvfHas":
        case "recordNullProto":
        case "recordHas":
          visitShape(node.shapeId);
          break;
        case "unionWrap":
        case "unionFuncEq":
        case "unionNarrow":
        case "unionDisc":
        case "unionKeyGet":
        case "unionIsTag":
        case "unionEq":
        case "fieldAbsent":
          visitUnion(node.unionId);
          break;
        case "unionRetype":
          visitUnion(node.fromId);
          visitUnion(node.unionId);
          break;
        case "yieldExpr":
          if (node.captureCompletion !== undefined) visitType(node.captureCompletion.returnType);
          break;
        case "instanceOfValue":
          for (const type of [node.value.type, node.classValue.type]) {
            if (type.kind !== "object" && type.kind !== "classval") continue;
            let root = lowerer.classes.get(type.className);
            if (!root) continue;
            while (root.base) root = root.base;
            valueInstanceOfRoots.add(root.def.name);
          }
          break;
        case "libCall":
          // The general stream representation's child stdio read bridges
          // through the runtime install that boxes both stream classes.
          if (node.fn === "child.stdioStream") {
            visitClass("%Readable");
            visitClass("%Writable");
          }
          break;
        case "dynFrom":
          if (boxedChild(node.value.type)) {
            // A generic child can expose native stdio without importing stream.
            visitClass("%Readable");
            visitClass("%Writable");
          }
          break;
        default:
          // A new node with a named artifact reference must join this switch.
          node satisfies Exclude<
            IrExpr,
            { className: string } | { shapeId: string } | { unionId: string }
          >;
      }
      return true;
    },
    stmt: (node: IrStmt): boolean => {
      switch (node.kind) {
        case "fieldSet":
          visitClass(node.className);
          break;
        case "recordSet":
        case "recordKeySet":
        case "recordKeyDelete":
          visitShape(node.shapeId);
          break;
        default:
          node satisfies Exclude<
            IrStmt,
            { className: string } | { shapeId: string } | { unionId: string }
          >;
      }
      return true;
    },
  };
  // Visit compiler-owned typed storage and executable trees directly, without
  // creating dynamic snapshots of every node's properties and metadata.
  for (const fn of functions) {
    for (const param of fn.params) visitType(param.type);
    visitType(fn.returnType);
    for (const local of fn.locals) visitType(local.type);
    for (const capture of fn.captures ?? []) visitType(capture.type);
    for (const capture of fn.classCaptures ?? []) visitType(capture.type);
    if (fn.generator !== undefined) {
      visitType(fn.generator.yieldT);
      visitType(fn.generator.nextT);
      visitType(fn.generator.resultType);
    }
    everyStmtList(fn.body, visitor);
  }
  for (const global of lowerer.globalsList) visitType(global.type);
  // The builtin error classes ride EVERY module: the runtime's own throws
  // (JSON/dynCheck/regex failures) mint instances of them whether or not
  // user code mentions Error, and the uncaught printer tells Error
  // payloads apart by their preorder interval — which must therefore be
  // part of this program's numbering (backends stamp it into the
  // runtime's vtables at main).
  for (const name of [...RUNTIME_ERROR_CLASSES.keys()]) {
    if (!classNames.has(name)) {
      classNames.add(name);
      pendingClasses.push(name);
    }
  }
  while (pendingClasses.length > 0 || pendingShapes.length > 0 || pendingUnions.length > 0) {
    while (pendingShapes.length > 0) {
      // Declared fields AND the index-signature value type: an
      // overflow-valued shape (`{ [key: string]: {script?: string} }`)
      // references its value shape through indexValue alone.
      const shape = lowerer.shapes.get(pendingShapes.pop()!);
      if (shape !== undefined) {
        for (const field of shape.fields) visitType(field.type);
        if (shape.indexValue !== undefined) visitType(shape.indexValue);
      }
    }
    while (pendingUnions.length > 0) {
      const union = lowerer.unions.get(pendingUnions.pop()!);
      if (union !== undefined) for (const arm of union.arms) visitType(arm);
    }
    while (pendingClasses.length > 0) {
      const name = pendingClasses.pop()!;
      const info = lowerer.classes.get(name);
      if (!info) {
        // Referenced by an emitted type but never registered: collection
        // deferred its diagnostics — a reached reference makes them count.
        lowerer.flushDeferredClass(name);
        continue;
      }
      for (const field of info.def.fields) visitType(field.type);
      if (info.base) visitClass(info.base.def.name);
      if (info.def.genericOf) visitClass(info.def.genericOf);
      if (lowerer.inHierarchy(info)) {
        let root = info;
        while (root.base) root = root.base;
        const wholeTree = (c: ClassInfo): void => {
          if (valueInstanceOfRoots.has(root.def.name) || lowerer.classCanBeConstructed(c))
            visitClass(c.def.name);
          for (const s of c.subclasses) wholeTree(s);
        };
        wholeTree(root);
      }
    }
  }
  const reachable = lowerer.reachableForArtifacts ?? lowerer.reachable;
  return {
    classes: lowerer
      .classesInTableOrder()
      .map((c) => c.def)
      .filter((def) => classNames.has(def.name))
      .map((def): IrClassDef => {
        if (!def) throw new InternalCompilerError("missing reachable class definition");
        // Generic-class instantiations bypass the reachability gate
        // (demand-driven — every member of a demanded instantiation
        // lowers; see lowerClassMembers), so their defs keep every
        // method: the emitted functions all exist. ABSTRACT entries ride
        // the same rule (noteVirtualEdge marks the abstract declarer, so
        // a dispatched slot keeps its declaration; an unreferenced one
        // drops and the root-most CONCRETE declaration owns the slot).
        const className = def.name;
        const methods =
          reachable === null || def.genericOf !== undefined
            ? (def.methods ?? [])
            : (def.methods?.filter((m) => reachable.has(`%${className}.${m}`)) ?? []);
        const abstractMethods = def.abstractMethods?.filter((m) => methods.includes(m)) ?? [];
        const rest = { ...def };
        if (methods.length > 0) rest.methods = methods;
        else delete rest.methods;
        if (abstractMethods.length > 0) rest.abstractMethods = abstractMethods;
        else delete rest.abstractMethods;
        return rest;
      }),
    // Ids come from what each shape and union is (keyedHelperName), so
    // ordering by id gives every lowering order the same module.
    records: lowerer.shapes.shapes
      .filter((r) => shapeIds.has(r.id))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    unions: lowerer.unions.unions
      .filter((u) => unionIds.has(u.id))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  };
}

/** Registers every DIRECT top-level `const`/`let` of a file as a module
 * global (stable storage: cross-module live bindings, and functions can
 * reference them without capture). Block-scoped vars inside nested
 * statements keep their different symbols and stay locals. */
/** JS collection failures defer to runtime fences: the registration's
 * diagnostics move off the build (into lowerer.runtimeFences) — the declaring
 * statement re-fails during init lowering and compiles to the
 * runtimeFence trap there, and every use site cascades to its own trap.
 * TypeScript files keep eager collection reports. */
function deferJsCollectionDiags(lowerer: Lowerer, sf: ts.SourceFile, diagsBefore: number): void {
  if (!isJsSourceFile(sf)) return;
  const captured = lowerer.diags.splice(diagsBefore);
  const ice = captured.filter((d) => d.code === "SC9001");
  if (ice.length > 0) lowerer.diags.push(...ice);
  lowerer.runtimeFences.push(...captured.filter((d) => d.code !== "SC9001"));
}

/** A scalar-literal expression a single-value `module.exports =` can carry
 * without any declaration to alias to: string/number/boolean literals,
 * substitution-free templates, and negated numbers. */
function cjsScalarLiteral(e: ts.Expression): boolean {
  if (ts.isNumericLiteral(e) || ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e))
    return true;
  if (e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword) return true;
  return (
    ts.isPrefixUnaryExpression(e) &&
    e.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(e.operand)
  );
}

/** True when a JS file-scope declaration's initializer provably LOWERS to
 * a checked-dynamic (or unit) value, so a DYN module global can hold it:
 * no initializer, a unit literal, or a checker-`any` call/member/
 * identifier read (any-typed operations lower through the checked-dynamic tree in JS).
 * User-class `new` expressions stay OUT even when checker-any (`new Anon.Sub()` over
 * an expando class member constructs a TYPED instance — corpus 2032), as
 * does everything else (object/array literals have their own rules;
 * typed-but-unmappable initializers keep the %init-local adoption). */
function checkedGlobalReference(lowerer: Lowerer, expression: ts.Expression): boolean {
  if (ts.isIdentifier(expression)) return lowerer.globalOf(expression)?.type.kind === "dyn";
  if (
    !ts.isPropertyAccessExpression(expression) ||
    !ts.isIdentifier(expression.name) ||
    !ts.isIdentifier(expression.expression)
  )
    return false;
  const root = lowerer.checker.getSymbolAtLocation(expression.expression);
  const namespace = root && root.declarations.some(ts.isNamespaceImport);
  return (
    (namespace || lowerer.cjsLocalModuleBindingOf(expression.expression)) &&
    lowerer.globalOf(expression.name)?.type.kind === "dyn"
  );
}

function jsDynHoldableInitializer(lowerer: Lowerer, init: ts.Expression | undefined): boolean {
  if (init === undefined) return true;
  if (isNativeProxyInitializer(lowerer, init)) return true;
  let e: ts.Expression = init;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (checkedGlobalReference(lowerer, e)) return true;
  if (
    ts.isCallExpression(e) &&
    ts.isPropertyAccessExpression(e.expression) &&
    ["freeze", "seal", "preventExtensions"].includes(e.expression.name.text) &&
    lowerer.stdlibGlobalMember(e.expression, "Object") !== null &&
    e.arguments.nodes[0] &&
    ts.isArrayLiteralExpression(e.arguments.nodes[0])
  )
    return true;
  // The built-in Array constructor can create an evolving array whose
  // inferred element type has no native mapping. Its checked reference
  // must remain shared with separately declared functions and aliases.
  if (
    (ts.isCallExpression(e) || ts.isNewExpression(e)) &&
    lowerer.isStdlibGlobal(e.expression, "Array")
  )
    return true;
  // JavaScript process streams lower to native checked handles even when
  // their declared method overloads prevent a structural type mapping.
  // Register the shared slot before separately declared functions lower.
  if (ts.isPropertyAccessExpression(e)) {
    const member = lowerer.stdlibGlobalMember(e, "process");
    if (member === "stdin" || member === "stdout" || member === "stderr") return true;
    if (
      e.name.text === "constructor" &&
      lowerer.checker.getCallSignatures(lowerer.typeOf(e.expression)).length > 0
    )
      return true;
  }
  if (e.kind === ts.SyntaxKind.NullKeyword) return true;
  if (ts.isIdentifier(e) && e.text === "undefined") return true;
  if (ts.isConditionalExpression(e)) {
    return (
      jsDynHoldableInitializer(lowerer, e.whenTrue) &&
      jsDynHoldableInitializer(lowerer, e.whenFalse)
    );
  }
  if (
    ts.isBinaryExpression(e) &&
    (e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      e.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
  ) {
    return jsDynHoldableInitializer(lowerer, e.left) && jsDynHoldableInitializer(lowerer, e.right);
  }
  // A member of a checked module value is itself checked, including a
  // callable whose inferred overloads cannot describe one native ABI.
  if (
    (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) &&
    ts.isIdentifier(e.expression) &&
    lowerer.globalOf(e.expression)?.type.kind === "dyn"
  )
    return true;
  if (ts.isPropertyAccessExpression(e)) {
    const member = nsMemberIdentOf(lowerer, e);
    if (
      member &&
      (lowerer.globalOf(member)?.type.kind === "dyn" || lowerer.genericFnOf(member)?.implicitParams)
    )
      return true;
  }
  // Optional callable reads (for example descriptor?.get) can be held in
  // the same checked slot as a callable. Their nullish arm must remain
  // observable by functions declared outside the module initializer.
  if (
    ts.isPropertyAccessExpression(e) ||
    ts.isElementAccessExpression(e) ||
    ts.isCallExpression(e)
  ) {
    const fallback =
      lowerer.mapTypeOf(lowerer.typeOf(e)) ?? dynFallbackType(lowerer, e, lowerer.typeOf(e));
    if (
      fallback?.kind === "func" &&
      canBoxFuncIntoDyn(
        fallback,
        (id) => lowerer.shapes.get(id),
        (id) => lowerer.unions.get(id),
      )
    )
      return true;
    const arms =
      fallback?.kind === "union" ? lowerer.unions.get(fallback.unionId)?.arms : undefined;
    if (
      arms?.some((arm) => arm.kind === "func") &&
      arms.every(
        (arm) =>
          isUnitType(arm) ||
          (arm.kind === "func" &&
            canBoxFuncIntoDyn(
              arm,
              (id) => lowerer.shapes.get(id),
              (id) => lowerer.unions.get(id),
            )),
      )
    )
      return true;
  }
  if (
    (ts.isFunctionExpression(e) || ts.isArrowFunction(e)) &&
    !e.typeParameters?.nodes.length &&
    isJsSourceFile(ts.getSourceFileOfNode(e))
  )
    return true;
  if (ts.isIdentifier(e) || ts.isArrowFunction(e) || ts.isFunctionExpression(e)) {
    if (ts.isIdentifier(e)) {
      if (lowerer.globalOf(e)?.type.kind === "dyn") return true;
      const signature = lowerer.isTopLevelFnSymbol(e) ? lowerer.fnSigOf(e) : null;
      if (
        signature &&
        canBoxFuncIntoDyn(
          funcTypeFromParamShapes(signature.params, signature.returnType),
          (id) => lowerer.shapes.get(id),
          (id) => lowerer.unions.get(id),
        )
      )
        return true;
    }
    const type =
      lowerer.mapTypeOf(lowerer.typeOf(e)) ?? dynFallbackType(lowerer, e, lowerer.typeOf(e));
    if (
      type?.kind === "func" &&
      canBoxFuncIntoDyn(
        type,
        (id) => lowerer.shapes.get(id),
        (id) => lowerer.unions.get(id),
      )
    )
      return true;
  }
  if (
    (ts.isCallExpression(e) || ts.isPropertyAccessExpression(e) || ts.isIdentifier(e)) &&
    (lowerer.typeOf(e).flags & ts.TypeFlags.Any) !== 0
  ) {
    return true;
  }
  // A CALL whose inferred type has no static mapping and whose residue
  // falls to the checked-dynamic kind (`const exec = common.mustCall(() =>
  // ... exec ...)` — the wrapper's rest-args type is not checker-`any`,
  // but the VALUE lowers through the checked-dynamic tree the same way): registering the
  // dyn global BEFORE the initializer lowers is what lets the callback
  // capture the binding itself — the Node-suite self-referential-const
  // idiom. Non-dyn residues (pure single-signature function types, typed
  // arrays) keep their static stories.
  if (ts.isCallExpression(e)) {
    const t = lowerer.typeOf(e);
    if (lowerer.mapTypeOf(t) === null && dynFallbackType(lowerer, e, t)?.kind === "dyn")
      return true;
  }
  return false;
}

/** A JavaScript default-export object literal holding a class the program
 * could not lower (`export default { parse, TomlDate }` where TomlDate
 * extends an unsupported base): the literal narrows that member away, its
 * diagnostics deferred to the reads that reach it, so the binding's type
 * drops it too. Otherwise the module's own initialization would fail the
 * width check against members no build can supply. */
function withoutRejectedClassMembers(
  lowerer: Lowerer,
  expression: ts.Expression,
  type: IrType,
): IrType {
  let literal = expression;
  while (ts.isParenthesizedExpression(literal)) literal = literal.expression;
  if (!ts.isObjectLiteralExpression(literal) || type.kind !== "record") return type;
  const shape = lowerer.shapes.get(type.shapeId);
  if (!shape || shape.tuple) return type;
  const rejected = (t: IrType): boolean =>
    t.kind === "classval" &&
    !lowerer.classes.has(t.className) &&
    lowerer.deferredClassByName.has(t.className);
  if (!shape.fields.some((f) => rejected(f.type))) return type;
  const kept = shape.fields.filter((f) => !rejected(f.type));
  const shapeId = lowerer.shapes.intern(
    kept.map((f) => ({ name: f.name, type: f.type })),
    false,
    shape.indexValue,
  );
  return { kind: "record", shapeId };
}

export function collectGlobals(
  lowerer: Lowerer,
  sf: ts.SourceFile,
  topStmts: ts.Statement[],
): void {
  // Segment-tagged so mangled names can't collide across files (user
  // identifiers cannot contain '.'): entry globals "e.<name>", others
  // "m<i>.<name>".
  const rawTag = lowerer.fileTag.get(sf) ?? "";
  const tag = rawTag === "" ? "e." : rawTag.replace(/^%/, "");
  // Expando function members (`foo.bar = 12` anywhere in the file)
  // register their module globals first — reads inside function bodies
  // collected earlier in this pass must resolve them (lower-expando.ts).
  collectExpandoMembers(lowerer, sf);
  for (const stmt of topStmts) {
    if (ts.isClassDeclaration(stmt) && stmt.name && isIslandSubclassDecl(stmt)) {
      const symbol = lowerer.checker.getSymbolAtLocation(stmt.name);
      const g: IrGlobal = {
        id: `%g.${tag}${stmt.name.text}`,
        name: stmt.name.text,
        type: DYN,
        mutable: true,
      };
      if (symbol) lowerer.globalsBySymbol.set(symbol, g);
      lowerer.globalsByDeclNode.set(stmt, g);
      lowerer.globalsList.push(g);
      continue;
    }
    if (ts.isFunctionDeclaration(stmt) && stmt.name && isRebindableFunction(lowerer, stmt)) {
      const symbol = lowerer.checker.getSymbolAtLocation(stmt.name);
      if (symbol && !lowerer.globalsBySymbol.has(symbol)) {
        const g: IrGlobal = {
          id: `%g.${tag}${stmt.name.text}`,
          name: stmt.name.text,
          type: DYN,
          mutable: true,
        };
        lowerer.globalsBySymbol.set(symbol, g);
        lowerer.globalsByDeclNode.set(stmt, g);
        lowerer.globalsList.push(g);
      }
      continue;
    }
    // `export default <expr>`: the module's `default` binding is a const
    // module global (registered under the checker's default-export
    // symbol — the symbol a default IMPORT's alias chain terminates at,
    // so importers share the storage). The init body assigns it at the
    // statement's position (lowerDefaultExport) — which IS Node's
    // semantics for expression defaults: the binding snapshots the value
    // once, when the export statement evaluates.
    //
    // ENTITY-NAME defaults (`export default x`, `export default N.a`)
    // are different: the checker binds the default symbol as an ALIAS to
    // the target, and importers resolve straight through to the target's
    // own storage — pure plumbing, like `export { x as default }`. That
    // is honest exactly when the target cannot be reassigned (consts,
    // function/class declarations — reassignment of those is fenced
    // elsewhere): Node's default binding would NOT see a later write
    // (snapshot), the alias-resolved read would (live). MUTABLE targets
    // (`export default someLet` — the visitor-keys pattern
    // reassigns the let, then default-exports it) get SNAPSHOT storage
    // instead: Node's default binding captures the value once, when the
    // export statement runs, so the default registers its own const
    // global keyed by the DEFAULT alias symbol — the `import x = N.y`
    // snapshot precedent. Importer reads stop at it through
    // resolveValueSymbol's default-snapshot walk instead of chasing the
    // alias to the live let.
    if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
      const symbol = defaultExportSymbolOf(lowerer, sf);
      if (!symbol) continue;
      if (symbol.flags & ts.SymbolFlags.Alias) {
        const target = lowerer.checker.getAliasedSymbol(symbol);
        const vd = target.valueDeclaration;
        const mutableVar =
          vd !== undefined &&
          ts.isVariableDeclaration(vd) &&
          !ts.getSourceFileOfNode(vd).isDeclarationFile &&
          (ts.getCombinedNodeFlags(vd) & ts.NodeFlags.Const) === 0;
        // Immutable targets: alias plumbing — importers resolve to the
        // target's storage (the alias-resolved read IS the snapshot when
        // nothing can reassign). Mutable targets fall through to the
        // expression-default registration below.
        if (!mutableVar) continue;
      }
      // A default whose expression is a decorated class expression with
      // a PROVABLY-THROWING decoration (the ambient-decorator shape):
      // evaluating the export statement throws before the binding could
      // snapshot anything, so no storage registers — the statement
      // lowering emits the throw itself (lowerDefaultExport), and no
      // importer's read can ever run (the module init unwound).
      {
        let inner: ts.Expression = stmt.expression;
        while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
        if (
          ts.isClassExpression(inner) &&
          !isJsSourceFile(sf) &&
          inner.typeParameters === undefined &&
          (decoratorNodesOf(inner).length > 0 ||
            inner.members.nodes.some((m) => decoratorNodesOf(m).length > 0)) &&
          guaranteedDecorationThrow(lowerer, inner) !== null
        ) {
          continue;
        }
      }
      try {
        let tsType = lowerer.typeOf(stmt.expression);
        // tsgo answers `any` at some export-assignment EXPRESSION
        // positions (a bare literal default) — the SYMBOL's type is the
        // declared truth and serves as the fallback.
        if (tsType.flags & ts.TypeFlags.Any) {
          const symType = lowerer.checker.getTypeOfSymbol(symbol);
          if (!(symType.flags & ts.TypeFlags.Any)) tsType = symType;
        }
        let type = lowerer.mapTypeOf(tsType) ?? dynFallbackType(lowerer, stmt.expression, tsType);
        if (type === null) lowerer.badType(stmt.expression, tsType);
        // Inferred JavaScript factory exports keep their original value,
        // including callable objects decorated with Object.assign.
        if (
          isJsSourceFile(sf) &&
          ts.isCallExpression(stmt.expression) &&
          type.kind === "record" &&
          lowerer.dynConvertible(type)
        )
          type = DYN;
        // `export default undefined` — the unit-only union, like any
        // unit-only binding (`export default null` maps via mapType).
        if (type.kind === "void" && isUnitOnlyTsType(tsType)) {
          type = unitOnlyUnion(lowerer.unions);
        }
        if (type.kind === "void") lowerer.badType(stmt.expression, tsType);
        if (isJsSourceFile(sf)) type = withoutRejectedClassMembers(lowerer, stmt.expression, type);
        const g: IrGlobal = { id: `%g.${tag}default`, name: "default", type, mutable: false };
        lowerer.globalsBySymbol.set(symbol, g);
        lowerer.globalsList.push(g);
      } catch (e) {
        if (!(e instanceof PoisonError)) throw e;
        // diagnostic already recorded; lowering the statement poisons too
      }
      continue;
    }
    // CommonJS EXPORT statements (JS files): `exports.f = <expr>` /
    // `module.exports.f = <expr>` register a module global keyed by the
    // export symbol (the symbol importer bindings alias to), assigned by
    // the statement's lowering at its source position — the `export
    // default` machinery's shape. `module.exports = { ... }` registers
    // one for each EXPRESSION-valued property; identifier/shorthand
    // properties are pure alias plumbing (resolveValueSymbol re-resolves
    // importers to the referenced declarations — no storage needed).
    if (isJsSourceFile(sf)) {
      // Statements Node would DISCARD (a replaced export object) never
      // register storage — importer reads must not bind to values Node's
      // importers never see. The statement lowering owns the diagnostic.
      const cjs = cjsExportDiscardReason(stmt) === null ? cjsExportAssignmentOf(stmt) : null;
      const registerExport = (nameNode: ts.Node, name: string, typeNode: ts.Node): void => {
        const diagsBefore = lowerer.diags.length;
        try {
          // tsgo answers no symbol at the attachment site's NAME (no
          // expando synthesis); the module symbol's exports table still
          // names the member — the same identity use sites resolve.
          const symbol =
            lowerer.checker.getSymbolAtLocation(nameNode) ??
            lowerer.cjsModuleExportSymbol(sf, name);
          if (!symbol || lowerer.globalsBySymbol.has(symbol)) return;
          // JS exports whose strict type has no mapping take the
          // checked-dynamic fallback (implicit-any function exports —
          // common/tls's `exports.check = function (certs) {...}` —
          // keep func-ness with dyn pieces; everything else is dyn).
          const strict = lowerer.checker.getTypeOfSymbol(symbol);
          let t = lowerer.mapTypeOf(strict) ?? dynFallbackType(lowerer, nameNode, strict);
          if (!t || t.kind === "void") lowerer.badType(typeNode, strict);
          // An export typed as the empty object literal (tsc's enum output
          // `exports.E || (exports.E = {})` after its `exports.E = void 0`
          // preamble): TS's `{}` admits any later non-nullish value and the
          // export is undefined until then, so it rides checked-dynamic
          // storage like the same-shaped var binding (varBindingType).
          if (t.kind === "record" && isJsSourceFile(sf)) {
            const shape = lowerer.shapes.get(t.shapeId);
            if (shape && shape.fields.length === 0 && !shape.indexValue && !shape.tuple) t = DYN;
          }
          // An immutable export source shares its live storage and native
          // callable ABI. Mutable sources need a separate snapshot slot:
          // later writes to the binding do not change the exported value.
          {
            let rhs: ts.Node = typeNode;
            while (ts.isParenthesizedExpression(rhs)) rhs = rhs.expression;
            if (ts.isIdentifier(rhs)) {
              const vSym = lowerer.checker.getSymbolAtLocation(rhs);
              const vG = vSym && lowerer.globalsBySymbol.get(vSym);
              if (vG) {
                if (!vG.mutable) {
                  lowerer.globalsBySymbol.set(symbol, vG);
                  for (const d of symbol.declarations) lowerer.globalsByDeclNode.set(d, vG);
                  return;
                }
                const g: IrGlobal = {
                  id: `%g.${tag}%export.${name}`,
                  name,
                  type: vG.type,
                  mutable: false,
                };
                lowerer.globalsBySymbol.set(symbol, g);
                for (const d of symbol.declarations) lowerer.globalsByDeclNode.set(d, g);
                lowerer.globalsList.push(g);
                return;
              }
            }
          }
          const g: IrGlobal = { id: `%g.${tag}%export.${name}`, name, type: t, mutable: false };
          lowerer.globalsBySymbol.set(symbol, g);
          // Importer aliases resolve to a DISTINCT late-bound symbol with
          // the same declaration — key the node too (globalOf's fallback).
          for (const d of symbol.declarations) lowerer.globalsByDeclNode.set(d, g);
          lowerer.globalsList.push(g);
        } catch (e) {
          if (!(e instanceof PoisonError)) throw e;
          // diagnostic recorded; the statement lowering poisons too —
          // both defer to the statement's runtime fence in JS files.
          deferJsCollectionDiags(lowerer, sf, diagsBefore);
        }
      };
      // Export members assigned in VALUE position at the module's top
      // level (`const src = exports.src = []`) are exports too.
      for (const nested of nestedCjsExportAssignmentsOf(stmt, cjs?.expr)) {
        registerExport(nested.name, nested.name.text, nested.value);
      }
      if (cjs?.kind === "member" && ts.isIdentifier(cjs.name)) {
        // `exports.C = C` naming a CLASS declaration: alias plumbing —
        // no storage (a class VALUE global would fence for
        // builtin-derived classes); importers re-resolve to the class
        // symbol (cjsMemberExportClassSymbol) and the class registry
        // applies unchanged.
        if (lowerer.cjsMemberExportClassSymbol(cjs.expr) !== null) continue;
        // A chain `exports.a = exports.b = value`: every member is an
        // export holding the chain's one value.
        const chain = cjsExportChainOf(cjs.expr);
        if (chain !== null) {
          for (const nameNode of chain.names) registerExport(nameNode, nameNode.text, chain.value);
          continue;
        }
        // A dropped tsc void-init preamble whose real assignment is such a
        // class alias registers nothing either: storage here would never
        // be assigned, and importers would read it instead of the class.
        const real = cjsVoidInitPreambleReals(cjs)?.get(cjs.name.text);
        if (real && lowerer.cjsMemberExportClassSymbol(real.expr) !== null) continue;
        registerExport(cjs.name, cjs.name.text, cjs.value);
        continue;
      }
      // `module.exports = <scalar literal>` — a single-value replacement
      // export with no declaration for requirer aliases to land on: the
      // checker's `export=` symbol declares AT this statement, so the
      // const export global registers keyed by the statement node
      // (globalOf's declaration-node fallback routes requirer reads
      // here). Identifier values register nothing — alias plumbing, like
      // identifier table entries; other value shapes fence in the
      // statement lowering.
      if (cjs?.kind === "table" && !cjs.obj) {
        let rhs = cjs.expr.right;
        while (ts.isParenthesizedExpression(rhs)) rhs = rhs.expression;
        // `module.exports = function (…) {…}` (ms's shape — the whole
        // export IS an anonymous function): a FUNC-typed const export
        // global keyed by the statement node, exactly the scalar
        // plumbing — requirer/default-import aliases resolve to the
        // checker's export= symbol, whose declaration IS this statement
        // (globalOf's node fallback), and calls ride the ordinary
        // func-value paths. The inference types the signature (JSDoc
        // included); unmappable pieces take the JS checked-dynamic
        // fallback like every JS binding.
        const fnValued = ts.isFunctionExpression(rhs) || ts.isArrowFunction(rhs);
        // A factory-returned CommonJS root (`module.exports = make()`)
        // is a single value just like the scalar/function forms above
        // when its result has a static or checked-dynamic representation. Register one
        // snapshot slot keyed by the export-assignment declaration; the
        // statement lowering evaluates the call exactly once at its
        // source position and assigns that slot. Unmappable calls retain
        // the existing statement-level fence.
        // Any other computed value (`os.homedir || function () {…}`,
        // `cond ? a : b`, `new Registry()`, `ns.member`) is the same single
        // snapshot: Node stores whatever the expression produced. A
        // require() of a program module is not: the exporter re-exports
        // that module's exports, which requirers resolve through the
        // checker's alias (the statement lowers to the dep's %init).
        const factoryValued =
          !ts.isIdentifier(rhs) &&
          !ts.isClassExpression(rhs) &&
          !ts.isObjectLiteralExpression(rhs) &&
          !(
            requireSpecOf(rhs) !== null &&
            inlineProgramRequireOf(lowerer, rhs) !== null &&
            !sf.statements.nodes.some((s) => cjsExportAssignmentOf(s)?.kind === "member")
          ) &&
          cjsExportTargetLiteral(rhs, sf) === null;
        if (cjsScalarLiteral(rhs) || fnValued || factoryValued) {
          const diagsBefore = lowerer.diags.length;
          try {
            const strict = lowerer.typeOf(rhs);
            let t =
              lowerer.mapTypeOf(strict) ??
              (fnValued || factoryValued ? dynFallbackType(lowerer, rhs, strict) : null);
            // A returned object remains the live CommonJS root; later
            // exports.member writes must update that same open object.
            if (factoryValued && t?.kind === "record" && lowerer.dynConvertible(t)) t = DYN;
            if (t && t.kind !== "void") {
              const g: IrGlobal = {
                id: `%g.${tag}exports`,
                name: "exports",
                type: t,
                mutable: false,
              };
              lowerer.globalsByDeclNode.set(cjs.expr, g);
              lowerer.globalsList.push(g);
            }
          } catch (e) {
            if (!(e instanceof PoisonError)) throw e;
            deferJsCollectionDiags(lowerer, sf, diagsBefore);
          }
        }
        continue;
      }
      if (cjs?.kind === "table" && cjs.obj) {
        for (const prop of cjs.obj.properties.nodes) {
          if (ts.isShorthandPropertyAssignment(prop)) continue; // alias plumbing
          if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.initializer)) continue;
          if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
            registerExport(prop.name, prop.name.text, prop.initializer);
          }
          // A METHOD entry (`module.exports = { f(x) { … } }`) is an
          // expression-valued export whose value is the method's function.
          const method = cjsTableMethodEntry(prop);
          if (method !== null) registerExport(method.name, method.name.text, method.name);
          // other property forms fence in the statement lowering
        }
        continue;
      }
    }
    // `import x = N.y` where the target is a MUTABLE binding: Node's
    // transform emits `var x = N.y` — a SNAPSHOT taken when the alias
    // statement runs — so the alias gets its own const storage, keyed by
    // the alias's PRE-alias symbol (resolveValueSymbol stops at alias
    // symbols with registered storage instead of chasing them to the
    // live target). lowerImportEquals assigns it at the statement's
    // source position. Immutable targets stay pure plumbing (no storage;
    // the alias-resolved read IS the snapshot when nothing can
    // reassign), and the require/type-only forms are handled at the
    // statement lowering.
    if (ts.isImportEqualsDeclaration(stmt)) {
      if (ts.isExternalModuleReference(stmt.moduleReference) || stmt.isTypeOnly) continue;
      const aliasSym = lowerer.checker.getSymbolAtLocation(stmt.name);
      if (
        !aliasSym ||
        !(aliasSym.flags & ts.SymbolFlags.Alias) ||
        lowerer.globalsBySymbol.has(aliasSym)
      )
        continue;
      const target = lowerer.checker.getAliasedSymbol(aliasSym);
      const vd = target.valueDeclaration;
      const mutableVar =
        vd !== undefined &&
        ts.isVariableDeclaration(vd) &&
        !ts.getSourceFileOfNode(vd).isDeclarationFile &&
        (ts.getCombinedNodeFlags(vd) & ts.NodeFlags.Const) === 0;
      if (!mutableVar) continue;
      const diagsBefore = lowerer.diags.length;
      try {
        let type = lowerer.irTypeOf(stmt.name);
        if (type.kind === "void" && isUnitOnlyTsType(lowerer.typeOf(stmt.name))) {
          type = unitOnlyUnion(lowerer.unions);
        }
        if (type.kind === "void") lowerer.badType(stmt.name, lowerer.typeOf(stmt.name));
        const g: IrGlobal = {
          id: `%g.${tag}${nsPathPrefix(lowerer, stmt)}%alias.${stmt.name.text}%${positionTag(lowerer, stmt)}`,
          name: stmt.name.text,
          type,
          mutable: false,
        };
        lowerer.globalsBySymbol.set(aliasSym, g);
        lowerer.globalsList.push(g);
      } catch (e) {
        if (!(e instanceof PoisonError)) throw e;
        deferJsCollectionDiags(lowerer, sf, diagsBefore);
      }
      continue;
    }
    // `var` at module scope hoists across the WHOLE module body, blocks
    // included: `if (c) { var y = 1; }` at top level is a module-scoped
    // binding other functions in the file read. Non-top-level var
    // statements get their globals from the nested walk (top-level
    // statements continue into the main registration below, which also
    // owns the special forms — requires, aliases, promisify).
    if (!ts.isVariableStatement(stmt)) {
      collectNestedVarGlobals(lowerer, sf, stmt, tag);
      continue;
    }
    // tsc's interop bindings and its then-dead helper declarations own no
    // storage either (cjs-tsc-interop.ts).
    if (
      isJsSourceFile(sf) &&
      (isDeadTscHelperDecl(lowerer, stmt) ||
        (stmt.declarationList.declarations.nodes.length === 1 &&
          tscInteropBindingOfDecl(lowerer, stmt.declarationList.declarations.nodes[0]!) !== null))
    ) {
      continue;
    }
    // CommonJS require declarations are alias plumbing (preflight owns
    // the module edges; resolveValueSymbol routes reads through to the
    // exporter's declarations): no storage, and the statement lowers to
    // nothing. One registration DOES happen here: `const process =
    // require('node:process')` aliases the global process
    // (stdlibGlobalAliasDecl's require form) so reads through the
    // binding lower via the process surface.
    if (
      isRequireStatement(stmt) &&
      !(
        ts.isVariableStatement(stmt) &&
        stmt.declarationList.declarations.nodes.some(
          (decl) =>
            isNativeFfiRequire(lowerer, decl.initializer) || isJsonRequireDecl(lowerer, decl),
        )
      )
    ) {
      if (ts.isVariableStatement(stmt))
        for (const decl of stmt.declarationList.declarations.nodes)
          registerRequireDeclBindings(lowerer, sf, stmt.declarationList, decl, tag);
      continue;
    }
    // `declare const __VERSION__: string` — AMBIENT: no storage exists
    // (a bundler define in the real pipeline; nothing defines it here,
    // exactly like running the source under Node). Reads lower to
    // Node's ReferenceError at the access (lower-exprs), and the
    // statement itself lowers to nothing.
    if (
      ts.getCombinedModifierFlags(stmt.declarationList.declarations.nodes[0]!) &
      ts.ModifierFlags.Ambient
    )
      continue;
    const list = stmt.declarationList;
    if ((list.flags & ts.NodeFlags.Using) !== 0) continue; // fenced at the statement lowering
    const isConst = (list.flags & ts.NodeFlags.Const) !== 0;
    // `var` registers a mutable module global exactly like `let` — the
    // hoisting difference (binding exists from module entry, undefined
    // until assigned) lives in lowerFileInit's entry inits.
    const isLet =
      (list.flags & ts.NodeFlags.Let) !== 0 || (list.flags & ts.NodeFlags.BlockScoped) === 0;
    // Namespace members carry their namespace path in the storage id
    // (`%g.e.A%B.x`), so `namespace A { export const x }` and a
    // top-level `const x` never collide; non-exported members add the
    // declaring block's position (block-local bindings).
    const nsPrefix = nsPathPrefix(lowerer, stmt, list.declarations.nodes[0]);
    for (const decl of list.declarations.nodes) {
      // --provenance-sources: an elided pure-annotated dead const in a
      // fetched source module registers no global (the statement
      // lowering emits nothing by the same test — see
      // provenanceElidedConstDecl). Checked FIRST: the mixin/promisify
      // probes below would otherwise claim the call-initializer shape
      // and put its fences on the build.
      if (provenanceElidedConstDecl(lowerer, decl)) continue;
      // A require declarator beside other declarators (`var EventEmitter =
      // require("events"), R = class extends EventEmitter {}`): the
      // statement lowering treats it as the alias plumbing of a whole
      // require statement (lowerVarDeclarator), so it owns no storage
      // either. A global here would never be assigned, and a read through
      // it would see null.
      if (requireAliasDecl(lowerer, decl)) {
        registerRequireDeclBindings(lowerer, sf, list, decl, tag);
        continue;
      }
      // A stored built-in numeric value iterator has no first-class
      // global representation. Its same-%init for-of uses are backed by
      // hidden source/cursor/done locals registered when the declaration
      // lowers; skip the unmappable iterator global here so collection
      // does not fence that statically closed protocol path.
      // Cross-function or exported uses still fence at reference sites.
      if (
        isConst &&
        ts.isIdentifier(decl.name) &&
        numericIteratorSourceOf(lowerer, decl.initializer) !== null
      ) {
        continue;
      }
      // The trap/nullish/dead classification probes below resolve
      // symbols INSIDE the initializer, and resolution can fence (the
      // cross-block merged-namespace SC1090, resolveValueSymbol →
      // fenceCrossBlockNsRef): a fence mid-probe means the probe cannot
      // classify the declaration, not that collection dies — the
      // diagnostic is recorded, the binding falls through to ordinary
      // registration, and the statement lowering re-fences at its own
      // site (pushDiag dedupes), exactly the per-probe recovery the
      // alias/generic-fn registrations below already use.
      const classifyDiagsBefore = lowerer.diags.length;
      const classified = (() => {
        try {
          // A TRAP declaration at file scope — the initializer's chain roots
          // at an ambient-undefined name (`declare const t: Type<string>;
          // export const out = t.pipe(...)`): Node throws the root's
          // ReferenceError evaluating the initializer, so no value ever
          // exists and no reference can ever run. No global registers; the
          // binding enters trapBindings (registered HERE, before any body
          // lowers, so hoisted-function references resolve the trap), and
          // the statement lowering emits the throw at its position.
          // Written bindings keep ordinary storage (trapDeclRootOf).
          if (trapDeclRootOf(lowerer, decl) !== null) {
            for (const nameNode of boundIdentifiersOf(decl.name)) {
              const sym = lowerer.checker.getSymbolAtLocation(nameNode);
              if (sym) lowerer.trapBindings.add(sym);
            }
            return true;
          }
          // A NULLISH generic binding at file scope (`export const Mixin:
          // MixinHelperFunc = null as any`): no storage — reads know the
          // value (lower-exprs/lower-calls claim them); the statement
          // lowering emits nothing by the same test.
          if (
            ts.isIdentifier(decl.name) &&
            nullishGenericBindingUnitOf(
              lowerer,
              lowerer.checker.getSymbolAtLocation(decl.name) ?? null,
            ) !== null
          ) {
            return true;
          }
          // A DEAD unmappable binding at file scope (`var xs2: typeof
          // Array;` — never read anywhere): no global, no statement, no
          // type fence for a value the program never consumes.
          if (
            ts.isIdentifier(decl.name) &&
            deadUnmappableBinding(
              lowerer,
              lowerer.checker.getSymbolAtLocation(decl.name) ?? null,
              decl,
            )
          ) {
            return true;
          }
        } catch (e) {
          if (!(e instanceof PoisonError)) throw e;
          // A probe fenced mid-classification: JS files defer the
          // recorded diagnostics to runtime fences like every other
          // collection failure; TS keeps the eager report (the
          // statement lowering re-fences at its own site — pushDiag
          // dedupes).
          deferJsCollectionDiags(lowerer, sf, classifyDiagsBefore);
        }
        return false;
      })();
      if (classified) continue;
      // `const f = <T>(x: T) => x` at file scope: a generic function
      // value binding — no global exists (the binding is never read;
      // calls and pinned references monomorphize against the
      // initializer like a generic function declaration, registered
      // HERE so hoisted function bodies and cross-module references
      // resolve it). Non-qualifying shapes (reassigned bindings) fence
      // by name; the statement lowering skips (or re-fences — pushDiag
      // dedupes) by the same test.
      {
        const gfnNode =
          bindingGenericFnNodeOf(decl) ?? bindingContextualGenericFnNodeOf(lowerer, decl);
        if (gfnNode) {
          try {
            bindingGenericFnInfoOf(lowerer, decl, gfnNode);
          } catch (e) {
            if (!(e instanceof PoisonError)) throw e;
          }
          continue;
        }
      }
      // `const h = id` at file scope — an ALIAS of a generic function:
      // registers the target's info under the alias's symbol (no global
      // exists; the binding is never read). Aliases resolve in
      // declaration order, so a chain (`const h2 = h`) registers link by
      // link; an unresolved target falls through to the ordinary global
      // registration and its fences.
      {
        let aliased = false;
        try {
          aliased = bindingGenericFnAliasInfoOf(lowerer, decl) !== null;
        } catch (e) {
          if (!(e instanceof PoisonError)) throw e;
          aliased = true; // fenced by name — no global either way
        }
        if (aliased) continue;
      }
      // An immutable alias of an overloaded declared function is a
      // compile-time callable projection: calls retain per-site overload
      // resolution and value reads reuse the source's interned closure.
      if (isConst && registerOverloadedCallableAlias(lowerer, decl)) continue;
      if (isConst && registerBuiltinCallableAlias(lowerer, decl.name, decl.initializer)) continue;
      if (registerBuiltinClassAlias(lowerer, decl.name, decl.initializer)) continue;
      // `const f = (x) => ...` at file scope of an npm-static JS file
      // whose params are implicit-any: the implicit-monomorphization
      // twin of the generic binding above — no global exists; calls and
      // value references resolve through genericFnsBySymbol, and the
      // statement lowering skips by the same test.
      {
        const implicitNode = implicitLocalFnNodeOf(lowerer, decl);
        if (implicitNode) {
          implicitLocalFnInfoOf(lowerer, decl, implicitNode);
          continue;
        }
      }
      // `const M = (Base: Ctor) => class extends Base {…}` — a
      // NON-generic mixin function binding (generic ones took the
      // branch above): no global exists — calls instantiate the class
      // inside per site (lower-mixins.ts); the statement lowering skips
      // by the same test.
      if (isMixinFnBinding(lowerer, decl)) continue;
      // `const Thing1 = Tagged(Derived)` — a mixin RESULT binding: the
      // binding provably holds that one call's class object forever
      // (const), so it registers like a class declaration
      // (classBySymbol) HERE — before any body lowers — and every
      // downstream path (new, statics, extends, instanceof, reads)
      // answers directly. No global exists; the statement lowering
      // skips by the same test. A poisoned instantiation reported its
      // own diagnostics — the binding registers nothing and use sites
      // fence per reference.
      if (ts.isIdentifier(decl.name) && decl.initializer !== undefined && isConst) {
        let init: ts.Expression = decl.initializer;
        while (ts.isParenthesizedExpression(init)) init = init.expression;
        if (ts.isCallExpression(init)) {
          const bindSym = lowerer.checker.getSymbolAtLocation(decl.name);
          try {
            if (mixinResultBindingClassOf(lowerer, bindSym)) continue;
          } catch (e) {
            if (!(e instanceof PoisonError)) throw e;
            continue;
          }
        }
      }
      // `const execFileAsync = promisify(execFile)` at file scope: no
      // global exists (the promisified function value never does) — the
      // symbol registers HERE, before any use site can lower, and the
      // statement lowering skips the declaration by the same check. A
      // bad promisify target reports here (recorded once; the statement
      // lowering poisons too, like every collectGlobals failure).
      if (
        ts.isIdentifier(decl.name) &&
        decl.initializer &&
        isPromisifyCall(lowerer, decl.initializer)
      ) {
        try {
          lowerer.registerPromisifiedBuiltinDecl(decl.name, decl.initializer);
        } catch (e) {
          if (!(e instanceof PoisonError)) throw e;
        }
        continue;
      }
      // `const inspect = require("util").inspect` at file scope: a
      // named import in const clothing (builtinImportOf resolves uses)
      // — no global storage; the statement lowering skips it by the
      // same test.
      if (builtinMemberRequireDecl(decl.name, decl.initializer)) continue;
      // `const require = createRequire(import.meta.url)` at file scope:
      // compile-time plumbing — no global storage; the statement
      // lowering skips it by the same test.
      if (createRequireBindingDecl(lowerer, decl.name, decl.initializer)) continue;
      // `const fs = require("node:fs")` through that binding at file
      // scope — a namespace import in const clothing, same story.
      if (isConst && createRequireNamespaceDecl(lowerer, decl.name, decl.initializer)) continue;
      // `const local = require("./local.cjs")` through createRequire:
      // the binding is static module alias plumbing. Its statement emits
      // the dependency init at this exact source position; no value slot
      // represents the namespace object itself.
      if (isConst && createRequireProgramModuleDecl(lowerer, decl.name, decl.initializer)) continue;
      // `const { createSign } = crypto` over a builtin NAMESPACE binding
      // at file scope: alias plumbing like the destructured-require form
      // — no storage (the statement lowering skips by the same test).
      if (builtinNamespaceDestructureModuleOf(lowerer, decl) !== null) continue;
      // `const { NGHTTP2_CANCEL } = http2.constants` at file scope: a
      // destructure over the baked constants table — alias plumbing, no
      // global storage (the statement lowering skips it by the same
      // test).
      if (lowerer.builtinConstantsDestructureDecl(decl.name, decl.initializer)) continue;
      // `const Writable = stream.Writable` at file scope: a stream
      // class through the namespace binding — alias plumbing, no
      // global storage (the statement lowering skips it by the same
      // test).
      if (isConst && streamClassAliasDecl(lowerer, decl.name, decl.initializer)) continue;
      // `new Assert(...)`: a static instance has no global storage, and any
      // other instance is refused where its declaration lowers.
      if (
        decl.initializer !== undefined &&
        ts.isNewExpression(stripTypeCasts(decl.initializer)) &&
        isAssertClassNew(lowerer, stripTypeCasts(decl.initializer))
      )
        continue;
      // `const process = globalThis.process` at file scope: a stdlib-
      // global snapshot — alias plumbing, no global storage (see
      // stdlibGlobalAliasDecl; the statement lowering skips it by the
      // same test).
      const stableStdlibAlias =
        isConst ||
        stdlibBufferVarAlias(lowerer, decl) ||
        ((list.flags & ts.NodeFlags.Let) !== 0 &&
          ts.isIdentifier(decl.name) &&
          stdlibGlobalAliasNameOf(lowerer, decl.initializer) !== null &&
          (() => {
            const symbol = lowerer.checker.getSymbolAtLocation(decl.name);
            return symbol !== undefined && bindingNeverReassigned(lowerer, symbol, decl);
          })());
      if (stableStdlibAlias && stdlibGlobalAliasDecl(lowerer, decl.name, decl.initializer))
        continue;
      // Destructuring declarations register EVERY bound identifier (the
      // desugar in the init function assigns the pre-registered globals,
      // exactly like plain declarations).
      for (const nameNode of boundIdentifiersOf(decl.name)) {
        const diagsBefore = lowerer.diags.length;
        try {
          // Checked JavaScript factories can expose inferred callables by
          // destructuring. Keep each exported binding in module storage so
          // separately lowered functions see the initialized value.
          if (
            isJsSourceFile(sf) &&
            !ts.isIdentifier(decl.name) &&
            decl.initializer &&
            !decl.type &&
            !hasJsTypeAnnotation(decl) &&
            (!lowerer.mapTypeOf(lowerer.typeOf(nameNode)) ||
              isWebCryptoMemberType(lowerer, lowerer.typeOf(nameNode)))
          ) {
            const symbol = lowerer.checker.getSymbolAtLocation(nameNode);
            if (symbol && !lowerer.globalsBySymbol.has(symbol)) {
              const g: IrGlobal = {
                id: `%g.${tag}${nsPrefix}${nameNode.text}`,
                name: nameNode.text,
                type: DYN,
                mutable: isLet,
                source: bindingSource(nameNode),
                ...(!isVarDeclared(decl) ? { tdz: true as const } : {}),
              };
              lowerer.globalsBySymbol.set(symbol, g);
              lowerer.globalsList.push(g);
              if (isVarDeclared(decl)) noteVarGlobalEntryInit(lowerer, sf, g);
            }
            continue;
          }
          // Builtin declarations do not always describe the concrete native
          // callable ABI. Preserve checked-native values in shared storage;
          // adapting the loader to (string) would replace its validation.
          // An inferred Promise.prototype binding holds an ordinary object
          // (isPromisePrototypeRead), in TypeScript as well.
          const initializer = decl.initializer ? stripTypeCasts(decl.initializer) : undefined;
          if (
            (nameNode === decl.name &&
              !decl.type &&
              isPromisePrototypeRead(lowerer, decl.initializer)) ||
            (isJsSourceFile(sf) &&
              nameNode === decl.name &&
              initializer &&
              (isNativeBuiltinValueInitializer(lowerer, initializer) ||
                (!decl.type &&
                  !hasJsTypeAnnotation(decl) &&
                  lowerer.mapTypeOf(lowerer.typeOf(nameNode))?.kind === "date") ||
                (!decl.type &&
                  !hasJsTypeAnnotation(decl) &&
                  checkedGlobalReference(lowerer, initializer)) ||
                stdlibGlobalNameOf(lowerer, initializer) === "globalThis"))
          ) {
            const symbol = lowerer.checker.getSymbolAtLocation(nameNode);
            if (symbol && !lowerer.globalsBySymbol.has(symbol)) {
              const g: IrGlobal = {
                id: `%g.${tag}${nsPrefix}${nameNode.text}`,
                name: nameNode.text,
                type: DYN,
                mutable: isLet,
                source: bindingSource(nameNode),
                ...(!isVarDeclared(decl) ? { tdz: true as const } : {}),
              };
              lowerer.globalsBySymbol.set(symbol, g);
              lowerer.globalsList.push(g);
              if (isVarDeclared(decl)) noteVarGlobalEntryInit(lowerer, sf, g);
            }
            continue;
          }
          // A file-scope binding of an assertion of the global object
          // (`const state = globalThis as { [KEY]?: State }`): the binding
          // holds that object, so writes through it reach the object other
          // modules read (assertion-identity.ts).
          const asserted = decl.initializer
            ? keptIdentityAssertion(lowerer, decl.initializer)
            : undefined;
          if (nameNode === decl.name && !decl.type && asserted) {
            const symbol = lowerer.checker.getSymbolAtLocation(nameNode);
            if (symbol && !lowerer.globalsBySymbol.has(symbol)) {
              const g: IrGlobal = {
                id: `%g.${tag}${nsPrefix}${nameNode.text}`,
                name: nameNode.text,
                type: DYN,
                mutable: isLet,
                source: bindingSource(nameNode),
                ...(!isVarDeclared(decl) ? { tdz: true as const } : {}),
              };
              lowerer.globalsBySymbol.set(symbol, g);
              lowerer.globalsList.push(g);
              if (isVarDeclared(decl)) noteVarGlobalEntryInit(lowerer, sf, g);
            }
            continue;
          }
          // `const f = util.promisify(islandFn)` (NI-5b): an island function.
          if (
            ts.isIdentifier(decl.name) &&
            nameNode === decl.name &&
            decl.initializer !== undefined &&
            isIslandPromisifyCall(lowerer, decl.initializer)
          ) {
            const symbol = lowerer.checker.getSymbolAtLocation(nameNode);
            if (symbol) {
              const g: IrGlobal = {
                id: `%g.${tag}${nsPrefix}${nameNode.text}`,
                name: nameNode.text,
                type: DYN,
                mutable: isLet,
                source: bindingSource(nameNode),
              };
              lowerer.globalsBySymbol.set(symbol, g);
              lowerer.globalsList.push(g);
            }
            continue;
          }
          // A JS file-scope evolving ARRAY (`const mustCallChecks = [];`
          // — test/common's exit-accounting ledger): the strict type
          // (any[]) has no mapping, but the VALUE is the dyn array the
          // literal builds (lowerArrayLiteral's JS fallback) — register
          // a checked-dynamic global so separately-declared function
          // bodies (runCallChecks, _mustCallInner) reach the SAME
          // storage instead of fencing per reference. Identifier
          // declarations only: a destructured array literal binds its
          // pieces, not the array.
          if (
            isJsSourceFile(sf) &&
            !lowerer.mapTypeOf(lowerer.typeOf(nameNode)) &&
            ts.isIdentifier(decl.name) &&
            nameNode === decl.name &&
            decl.initializer !== undefined &&
            ts.isArrayLiteralExpression(decl.initializer)
          ) {
            const symbol = lowerer.checker.getSymbolAtLocation(nameNode);
            if (symbol) {
              const g: IrGlobal = {
                id: `%g.${tag}${nameNode.text}`,
                name: nameNode.text,
                type: DYN,
                mutable: isLet,
                source: bindingSource(nameNode),
              };
              lowerer.globalsBySymbol.set(symbol, g);
              lowerer.globalsList.push(g);
            }
            continue;
          }
          // A JS file-scope OBJECT LITERAL (`const input = { foo: 'bar' }`
          // Methods and computed properties require live checked storage:
          // symbol identity and a method's receiver cannot be reconstructed
          // from a copied, inferred record shape.
          if (
            isJsSourceFile(sf) &&
            ts.isIdentifier(decl.name) &&
            nameNode === decl.name &&
            decl.initializer &&
            ts.isObjectLiteralExpression(decl.initializer) &&
            decl.initializer.properties.nodes.some(
              (p) =>
                !ts.isSpreadAssignment(p) &&
                (ts.isMethodDeclaration(p) ||
                  ts.isAccessor(p) ||
                  ts.isComputedPropertyName(p.name) ||
                  (ts.isShorthandPropertyAssignment(p) &&
                    lowerer.checker.getCallSignatures(lowerer.typeOf(p.name)).length > 0)),
            )
          ) {
            const symbol = lowerer.checker.getSymbolAtLocation(nameNode);
            if (symbol && !lowerer.globalsBySymbol.has(symbol)) {
              const g: IrGlobal = {
                id: `%g.${tag}${nsPrefix}${nameNode.text}`,
                name: nameNode.text,
                type: DYN,
                mutable: isLet,
                source: bindingSource(nameNode),
              };
              lowerer.globalsBySymbol.set(symbol, g);
              lowerer.globalsList.push(g);
              if (isVarDeclared(decl)) noteVarGlobalEntryInit(lowerer, sf, g);
            }
            continue;
          }
          // A JS file-scope OBJECT LITERAL (`const input = { foo: 'bar' }`
          // — the Node-suite trace-context idiom): JS object identity is
          // the literal's contract — the SAME object flows into untyped
          // callees, gets stamped by them, and is compared back against
          // the binding (assert.strictEqual(found, input)). A static
          // record global would re-box at every dyn crossing and lose
          // that identity, so the binding holds the dyn object itself.
          // Gated to literals that are PURE DATA WRITTEN INLINE — every
          // property a non-computed PropertyAssignment whose value is
          // dyn-representable (unmappable member types are the checked-dynamic tree
          // fallback's own case) — so shorthand aggregates (test/common's
          // export object: alias plumbing importers resolve THROUGH),
          // accessors, and literals holding unconvertible typed
          // values (a Map member) keep their static/alias stories.
          // Spreads from an existing checked dictionary stay checked too;
          // copying its entries must not extract nested callable records.
          if (
            isJsSourceFile(sf) &&
            ts.isIdentifier(decl.name) &&
            nameNode === decl.name &&
            decl.initializer !== undefined &&
            ts.isObjectLiteralExpression(decl.initializer) &&
            decl.initializer.properties.nodes.every((p) => {
              if (ts.isSpreadAssignment(p)) {
                return (
                  ts.isIdentifier(p.expression) &&
                  lowerer.globalOf(p.expression)?.type.kind === "dyn"
                );
              }
              if (!ts.isPropertyAssignment(p) || ts.isComputedPropertyName(p.name)) return false;
              const mt = lowerer.mapTypeOf(lowerer.typeOf(p.initializer));
              return (
                mt === null ||
                mt.kind === "dyn" ||
                canConvertToDyn(
                  mt,
                  (id) => lowerer.shapes.get(id),
                  (id) => lowerer.unions.get(id),
                )
              );
            })
          ) {
            const symbol = lowerer.checker.getSymbolAtLocation(nameNode);
            if (symbol && !lowerer.globalsBySymbol.has(symbol)) {
              const g: IrGlobal = {
                id: `%g.${tag}${nameNode.text}`,
                name: nameNode.text,
                type: DYN,
                mutable: isLet,
                source: bindingSource(nameNode),
              };
              lowerer.globalsBySymbol.set(symbol, g);
              lowerer.globalsList.push(g);
            }
            continue;
          }
          // A JS file-scope ARRAY LITERAL holding an existing checked-dynamic
          // object (a file-scope object literal binding above, directly or
          // in a nested literal): the literal builds as a checked-dynamic
          // array (lowerArrayLiteral), and the binding holds it, so the
          // element keeps its identity.
          if (
            isJsSourceFile(sf) &&
            ts.isIdentifier(decl.name) &&
            nameNode === decl.name &&
            !decl.type &&
            !hasJsTypeAnnotation(decl) &&
            decl.initializer !== undefined &&
            ts.isArrayLiteralExpression(decl.initializer) &&
            jsHoldsDynObject(lowerer, decl.initializer)
          ) {
            const symbol = lowerer.checker.getSymbolAtLocation(nameNode);
            if (symbol && !lowerer.globalsBySymbol.has(symbol)) {
              const g: IrGlobal = {
                id: `%g.${tag}${nsPrefix}${nameNode.text}`,
                name: nameNode.text,
                type: DYN,
                mutable: isLet,
                source: bindingSource(nameNode),
              };
              lowerer.globalsBySymbol.set(symbol, g);
              lowerer.globalsList.push(g);
              if (isVarDeclared(decl)) noteVarGlobalEntryInit(lowerer, sf, g);
            }
            continue;
          }
          // A JS file-scope ANY-RESIDUE binding whose VALUE provably
          // lives in the checked-dynamic tree: no initializer (`let catchWarning;` —
          // test/common's warning ledger), a unit initializer (`let
          // localhostIPv4 = null;` — the lazy-cache idiom), or an
          // initializer whose own checker type is `any` (`const handler
          // = common.mustCall(cb)` — a dyn call result). Register a
          // checked-dynamic global (the evolving-array precedent above)
          // so separately-declared functions and getters reach the SAME
          // storage instead of fencing per reference. Typed-but-
          // unmappable initializers (`new Set(...)` — a real Set the
          // decl keeps as an %init local) stay OUT: forcing those into
          // the checked-dynamic tree would trade their working typed representation for
          // fences.
          if (
            isJsSourceFile(sf) &&
            !lowerer.mapTypeOf(lowerer.typeOf(nameNode)) &&
            ts.isIdentifier(decl.name) &&
            nameNode === decl.name &&
            jsDynHoldableInitializer(lowerer, decl.initializer) &&
            dynFallbackType(lowerer, nameNode, lowerer.typeOf(nameNode))?.kind === "dyn"
          ) {
            const symbol = lowerer.checker.getSymbolAtLocation(nameNode);
            if (symbol && !lowerer.globalsBySymbol.has(symbol)) {
              const g: IrGlobal = {
                id: `%g.${tag}${nsPrefix}${nameNode.text}`,
                name: nameNode.text,
                type: DYN,
                mutable: isLet,
                source: bindingSource(nameNode),
              };
              lowerer.globalsBySymbol.set(symbol, g);
              lowerer.globalsList.push(g);
              // Mutable dyn globals hold the dyn undefined from module
              // entry (the main path's rule below): a closure called
              // above the declaration reads undefined instead of
              // faulting on NULL.
              if (g.mutable) noteVarGlobalEntryInit(lowerer, sf, g);
            }
            continue;
          }
          // A function initializer can have a native calling convention
          // even when its inferred return/parameter pieces need DYN. Keep
          // that closure in a checked-value global so class methods and
          // other module functions see its declaration-position assignment.
          // A var starts undefined; lexical bindings retain the TDZ guard.
          if (
            isJsSourceFile(sf) &&
            !lowerer.mapTypeOf(lowerer.typeOf(nameNode)) &&
            ts.isIdentifier(decl.name) &&
            nameNode === decl.name &&
            decl.initializer &&
            jsDynHoldableInitializer(lowerer, decl.initializer)
          ) {
            const initializer = decl.initializer;
            const member = ts.isPropertyAccessExpression(initializer)
              ? nsMemberIdentOf(lowerer, initializer)
              : null;
            const generic = member && lowerer.genericFnOf(member);
            const fallback =
              (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) &&
              !initializer.typeParameters?.nodes.length
                ? lowerer.lambdaSignature(initializer).funcType
                : member && lowerer.globalOf(member)?.type.kind === "dyn"
                  ? DYN
                  : member && generic?.implicitParams
                    ? lowerer.lowerGenericFnValue(member, generic).type
                    : dynFallbackType(lowerer, nameNode, lowerer.typeOf(nameNode));
            const symbol = lowerer.checker.getSymbolAtLocation(nameNode);
            if (
              symbol &&
              fallback &&
              (fallback.kind === "dyn" || fallback.kind === "func" || fallback.kind === "union") &&
              lowerer.dynConvertible(fallback)
            ) {
              if (!lowerer.globalsBySymbol.has(symbol)) {
                const g: IrGlobal = {
                  id: `%g.${tag}${nsPrefix}${nameNode.text}`,
                  name: nameNode.text,
                  type: DYN,
                  mutable: isLet,
                  source: bindingSource(nameNode),
                  ...(!isVarDeclared(decl) ? { tdz: true as const } : {}),
                };
                lowerer.globalsBySymbol.set(symbol, g);
                lowerer.globalsList.push(g);
                if (isVarDeclared(decl)) noteVarGlobalEntryInit(lowerer, sf, g);
              }
              continue;
            }
          }
          // JS declarations whose STRICT type has no mapping register no
          // global at all: the declaration lowers as an %init-body LOCAL
          // whose type adopts the initializer's (lowerVarDecl's JS
          // rule — `new Set([...tokens])` becomes a real Set<string>),
          // and closures created in the init body capture it normally.
          // References from separately-declared functions cascade to
          // their own per-site runtime fences.
          const factoryType =
            !isLet &&
            isJsSourceFile(sf) &&
            !decl.type &&
            !hasJsTypeAnnotation(decl) &&
            ts.isIdentifier(decl.name) &&
            nameNode === decl.name &&
            decl.initializer &&
            ts.isNewExpression(decl.initializer)
              ? (objectFactoryGlobalType(lowerer, decl.initializer) ?? undefined)
              : undefined;
          // Prefer the initializer's native namespace or proxy storage
          // where it is more precise than the declaration's checker type.
          const handleT =
            ts.isIdentifier(decl.name) && nameNode === decl.name
              ? ((isNativeProxyInitializer(lowerer, decl.initializer) ? DYN : null) ??
                staticImportNamespaceType(lowerer, decl.initializer) ??
                null)
              : null;
          // JavaScript factory results with unmappable annotations still
          // need shared storage. Unannotated callable unions also use a
          // checked slot; mappable authored annotations keep their layout.
          const unannotatedCall = !decl.type && !hasJsTypeAnnotation(decl);
          const callSignature =
            (isJsSourceFile(sf) || unannotatedCall) &&
            decl.initializer &&
            ts.isCallExpression(decl.initializer)
              ? lowerer.checker.getResolvedSignature(decl.initializer)
              : undefined;
          const callDeclaration = callSignature && callSignature.declaration;
          const callType =
            callDeclaration && isJsSourceFile(ts.getSourceFileOfNode(callDeclaration))
              ? lowerer.mapTypeOf(lowerer.typeOf(nameNode))
              : null;
          const inferredJsCall =
            callDeclaration &&
            isJsSourceFile(ts.getSourceFileOfNode(callDeclaration)) &&
            (!callType ||
              (unannotatedCall &&
                callType.kind === "union" &&
                lowerer.unions.get(callType.unionId)?.arms.some((arm) => arm.kind === "func")));
          if (
            !factoryType &&
            !inferredJsCall &&
            isJsSourceFile(sf) &&
            !lowerer.mapTypeOf(lowerer.typeOf(nameNode))
          )
            continue;
          let type = handleT ?? factoryType ?? (inferredJsCall ? DYN : lowerer.irTypeOf(nameNode));
          if (
            isJsSourceFile(sf) &&
            !decl.type &&
            !hasJsTypeAnnotation(decl) &&
            decl.initializer &&
            (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer)) &&
            !decl.initializer.typeParameters?.nodes.length
          ) {
            type = lowerer.lambdaSignature(decl.initializer).funcType;
          }
          // Namespace aliases of inferred helpers carry the helper's
          // settled callable, whose return can differ from checker inference.
          // Keep a shared checked slot before any consumer specializes it.
          if (
            isJsSourceFile(sf) &&
            !decl.type &&
            !hasJsTypeAnnotation(decl) &&
            type.kind === "func" &&
            decl.initializer &&
            ts.isPropertyAccessExpression(decl.initializer)
          ) {
            const member = nsMemberIdentOf(lowerer, decl.initializer);
            if (member && lowerer.genericFnOf(member)?.implicitParams) type = DYN;
            else if (member) {
              const source = lowerer.globalOf(member);
              if (source?.type.kind === "func") type = source.type;
            }
          }
          if (
            isJsSourceFile(sf) &&
            !decl.type &&
            !hasJsTypeAnnotation(decl) &&
            decl.initializer &&
            ts.isCallExpression(decl.initializer) &&
            type.kind === "union"
          ) {
            const arms = lowerer.unions.get(type.unionId)?.arms;
            if (
              arms?.some((arm) => arm.kind === "record") &&
              arms.every((arm) => isUnitType(arm) || arm.kind === "record")
            )
              type = DYN;
          }
          if (
            isJsSourceFile(sf) &&
            !decl.type &&
            !hasJsTypeAnnotation(decl) &&
            decl.initializer &&
            ts.isNewExpression(decl.initializer) &&
            lowerer.mapTypeOf(lowerer.typeOf(decl.initializer.expression))?.kind === "dyn" &&
            !(
              ts.isIdentifier(decl.initializer.expression) &&
              lowerer.isStdlibSymbol(
                lowerer.checker.getSymbolAtLocation(decl.initializer.expression),
              )
            )
          )
            type = DYN;
          // Calls through checked function values retain their object
          // identity, including symbol keys absent from inferred records.
          if (
            isJsSourceFile(sf) &&
            !decl.type &&
            !hasJsTypeAnnotation(decl) &&
            type.kind === "record" &&
            decl.initializer &&
            ts.isCallExpression(decl.initializer) &&
            lowerer.dynConvertible(type)
          ) {
            type = DYN;
          }
          if (
            isJsSourceFile(sf) &&
            !decl.type &&
            !hasJsTypeAnnotation(decl) &&
            type.kind === "record" &&
            decl.initializer &&
            ts.isCallExpression(decl.initializer) &&
            ts.isPropertyAccessExpression(decl.initializer.expression) &&
            lowerer.stdlibGlobalMember(decl.initializer.expression, "Object") === "assign" &&
            decl.initializer.arguments.nodes.some(
              (arg) => ts.isIdentifier(arg) && lowerer.globalOf(arg)?.type.kind === "dyn",
            )
          ) {
            type = DYN;
          }
          // Runtime-arity JavaScript callables can be returned by a
          // checked factory. Keep that callable boxed instead of asking
          // a fixed-signature adapter to reconstruct its hidden rest ABI.
          if (
            !decl.type &&
            !hasJsTypeAnnotation(decl) &&
            type.kind === "func" &&
            type.rest === true &&
            type.restAbi === undefined
          )
            type = DYN;
          if (
            isJsSourceFile(sf) &&
            isLet &&
            !decl.type &&
            !hasJsTypeAnnotation(decl) &&
            (type.kind === "object" || jsBindingHasOpenWrites(lowerer, decl))
          )
            type = DYN;
          // JavaScript call results may retain a checked array supplied by
          // the caller. A typed global here would copy it on extraction.
          if (
            isJsSourceFile(sf) &&
            !decl.type &&
            !hasJsTypeAnnotation(decl) &&
            type.kind === "array" &&
            decl.initializer &&
            ts.isCallExpression(decl.initializer)
          )
            type = DYN;
          if (
            isJsSourceFile(sf) &&
            !decl.type &&
            !hasJsTypeAnnotation(decl) &&
            decl.initializer &&
            ts.isNewExpression(decl.initializer) &&
            lowerer.isStdlibGlobal(decl.initializer.expression, "Array") &&
            (type.kind !== "array" || type.elem.kind === "dyn")
          )
            type = DYN;
          // Unannotated JavaScript aliases retain an existing native
          // checked object instead of copying it into an inferred record.
          if (
            isJsSourceFile(sf) &&
            !decl.type &&
            !hasJsTypeAnnotation(decl) &&
            decl.initializer &&
            ts.isIdentifier(decl.initializer) &&
            (type.kind === "record" || type.kind === "func")
          ) {
            const source = lowerer.globalOf(decl.initializer);
            if (source?.type.kind === "dyn") type = DYN;
          }
          // JavaScript bind inference can leave an artificial tuple-rest
          // signature. Keep the returned callable's runtime arity intact.
          if (
            isJsSourceFile(sf) &&
            type.kind === "func" &&
            decl.initializer &&
            ts.isCallExpression(decl.initializer) &&
            ts.isPropertyAccessExpression(decl.initializer.expression) &&
            decl.initializer.expression.name.text === "bind" &&
            lowerer.isStdlibMember(decl.initializer.expression) &&
            decl.type === undefined &&
            !hasJsTypeAnnotation(decl)
          ) {
            type = DYN;
          }
          // An exact class behind a generic interface keeps its native
          // representation so generic calls can specialize against its body.
          if (
            (type.kind === "record" || type.kind === "dyn") &&
            ts.isIdentifier(decl.name) &&
            nameNode === decl.name &&
            genericIfaceBindingKeepsClass(lowerer, decl, type)
          ) {
            const initT = lowerer.mapTypeOf(lowerer.typeOf(decl.initializer!));
            if (initT?.kind === "object") type = initT;
          }

          // File-scope unit-only bindings (`var x: undefined`, `const
          // y: void = undefined`) ride the unit-only union, exactly
          // like function-scope locals (lowerVarDecl's rule).
          if (type.kind === "void" && isUnitOnlyTsType(lowerer.typeOf(nameNode))) {
            type = unitOnlyUnion(lowerer.unions);
          }
          if (type.kind === "void") lowerer.badType(nameNode, lowerer.typeOf(nameNode));
          // A JS file-scope FUNCTION binding whose unannotated return
          // infers a record (`const wrapped = function () { return
          // expectedResult; }`): the closure VALUE lowers with a dyn
          // return (declaredReturnType's record twin — JS object
          // literals are dyn values, and a record return would copy
          // identity away), so the binding's slot must agree or an
          // adapter would re-copy at the assignment.
          if (
            isJsSourceFile(sf) &&
            type.kind === "func" &&
            (type.ret.kind === "date" ||
              (type.ret.kind === "record" && lowerer.dynConvertible(type.ret))) &&
            decl.initializer !== undefined &&
            (ts.isFunctionExpression(decl.initializer) || ts.isArrowFunction(decl.initializer)) &&
            decl.initializer.type === undefined &&
            type.params.every((pt) => pt.kind === "dyn")
          ) {
            type = { ...type, ret: DYN };
          }
          // A file-scope JS `let x = {}`: the same checked-dynamic rule
          // lowerVarDecl applies to locals — TS's empty-object-literal
          // type admits ANY later non-nullish assignment, so the static
          // empty struct cannot hold the binding's future.
          if (isLet && type.kind === "record" && isJsSourceFile(sf)) {
            const shape = lowerer.shapes.get(type.shapeId);
            if (shape && shape.fields.length === 0 && !shape.indexValue && !shape.tuple) type = DYN;
          }
          // Module vars hold real undefined until their declaration runs.
          // Unannotated JS function values need that state too: callers
          // before the initializer must see undefined and a TypeError.
          if (
            isJsSourceFile(sf) &&
            isVarDeclared(decl) &&
            type.kind === "func" &&
            lowerer.dynConvertible(type)
          )
            type = DYN;
          // Codec records keep that state in the ordinary optional union;
          // lexical codec declarations retain their separate TDZ guard.
          const codec =
            type.kind === "record" &&
            recordTextCodecClass(lowerer.shapes.get(type.shapeId)!) !== null;
          if (codec && isVarDeclared(decl)) {
            type = {
              kind: "union",
              unionId: lowerer.unions.intern([type, { kind: "undefinedT" }]),
            };
          } else if (codec && !decl.initializer) {
            lowerer.noLowering(
              "uninitialized lexical codec bindings",
              decl,
              "initialize let or const TextEncoder/TextDecoder bindings at their declaration",
            );
          }
          const symbol = lowerer.checker.getSymbolAtLocation(nameNode);
          // Merged `var` redeclarations (`var y = 1; ...; var y = 2;` —
          // one symbol) register exactly one global; later declarations
          // are plain assignments.
          if (!symbol || lowerer.globalsBySymbol.has(symbol)) continue;
          const g: IrGlobal = {
            id: `%g.${tag}${nsPrefix}${nameNode.text}`,
            name: nameNode.text,
            type,
            mutable: isLet,
            source: bindingSource(nameNode),
            // A function pointer must not be dereferenced before a lexical
            // declaration assigns it. The shared pointer TDZ guard handles
            // these bindings like stored codec records.
            ...((codec || type.kind === "func") && !isVarDeclared(decl)
              ? { tdz: true as const }
              : {}),
          };
          lowerer.globalsBySymbol.set(symbol, g);
          lowerer.globalsList.push(g);
          // `let f: T;` initializes the binding (to undefined) where the
          // declaration runs: later writes are ordinary stores, which the
          // pointer guard alone would refuse (markCycleEarlyBindings).
          if (g.tdz && !decl.initializer)
            lowerer.uninitializedLexicalGlobals.set(g.id, { name: nameNode, module: sf, symbol });
          // Mutable checked-dynamic LET globals ride the same entry
          // init: a closure called above the declaration statement
          // reads the dyn undefined instead of faulting on NULL — the
          // dyn face of let's documented pre-declaration window (Node
          // throws the TDZ ReferenceError there).
          if (isVarDeclared(decl) || (g.type.kind === "dyn" && g.mutable)) {
            noteVarGlobalEntryInit(lowerer, sf, g);
          }
        } catch (e) {
          if (!(e instanceof PoisonError)) throw e;
          // diagnostic already recorded; lowering the statement poisons
          // too — and in a JS file BOTH defer to the statement's
          // runtime fence (deferJsCollectionDiags).
          deferJsCollectionDiags(lowerer, sf, diagsBefore);
        }
      }
    }
  }
}

/** Registers the entry-init note for a `var` module global: JS hoists
 * module vars to `undefined` at module entry, so an undefined-armed slot
 * must hold the interned undefined arm BEFORE the body runs (a function
 * called above the declaration statement may read it — lowerFileInit
 * emits the assigns right after the run-once guard). Checked-dynamic
 * slots hold the dyn undefined the same way (a NULL dyn is a trap, not
 * a value). Other types need nothing: tsc's flow analysis rejects their
 * direct early reads, and closure reads share let's documented
 * zero/NULL divergence window. */
function noteVarGlobalEntryInit(lowerer: Lowerer, sf: ts.SourceFile, g: IrGlobal): void {
  // Every var global is noted: the runtime-optional analysis may still
  // widen its type to an undefined-armed union (a var read before its
  // first store), and the module entry stores undefined for the types
  // that hold it once that settled. 'any' globals need the entry init
  // exactly like undefined-armed unions: tsc never guards `any` reads,
  // so `var x: any;` is readable before any assignment and its slot must
  // hold native undefined rather than a C-level NULL (an op or validated
  // exit on NULL is memory-unsafe, not a TypeError).
  const inits = lowerer.varGlobalEntryInits.get(sf) ?? [];
  inits.push(g);
  lowerer.varGlobalEntryInits.set(sf, inits);
}

/** A JavaScript require declaration the statement lowering treats as alias
 * plumbing (lowerVarDeclarator): no storage, the reads resolve through to
 * the module. JSON documents and native FFI requires keep their storage. */
function requireAliasDecl(lowerer: Lowerer, decl: ts.VariableDeclaration): boolean {
  return (
    decl.initializer !== undefined &&
    requireSpecOf(decl.initializer) !== null &&
    !isNativeFfiRequire(lowerer, decl.initializer) &&
    !isJsonRequireDecl(lowerer, decl) &&
    isJsSourceFile(decl.getSourceFile())
  );
}

/** The registrations a top-level require declaration does make. `const
 * process = require('node:process')` aliases the global process
 * (stdlibGlobalAliasDecl's require form) so reads through the binding
 * lower via the process surface. In `const { codes: { ERR_X } } =
 * require("./errors")` the outer keys stay alias plumbing, but a nested
 * pattern destructures the export's value at the require, so its bindings
 * own storage like any destructured declaration (lowerVarDeclarator
 * assigns them). */
function registerRequireDeclBindings(
  lowerer: Lowerer,
  sf: ts.SourceFile,
  list: ts.VariableDeclarationList,
  decl: ts.VariableDeclaration,
  tag: string,
): void {
  if ((list.flags & ts.NodeFlags.Const) !== 0)
    stdlibGlobalAliasDecl(lowerer, decl.name, decl.initializer);
  const isLetList =
    (list.flags & ts.NodeFlags.Let) !== 0 || (list.flags & ts.NodeFlags.BlockScoped) === 0;
  for (const element of requireNestedPatternsOf(decl)) {
    for (const nameNode of boundIdentifiersOf(element.name!)) {
      const symbol = lowerer.checker.getSymbolAtLocation(nameNode);
      if (!symbol || lowerer.globalsBySymbol.has(symbol)) continue;
      const mapped = lowerer.mapTypeOf(lowerer.typeOf(nameNode));
      const type = mapped && mapped.kind !== "void" ? mapped : DYN;
      const g: IrGlobal = {
        id: `%g.${tag}${nameNode.text}`,
        name: nameNode.text,
        type,
        mutable: isLetList,
        source: bindingSource(nameNode),
        ...((type.kind === "func" || type.kind === "dyn") && !isVarDeclared(decl)
          ? { tdz: true as const }
          : {}),
      };
      lowerer.globalsBySymbol.set(symbol, g);
      lowerer.globalsList.push(g);
      if (isVarDeclared(decl)) noteVarGlobalEntryInit(lowerer, sf, g);
    }
  }
}

/** The nested half of module-scope `var` hoisting: a `var` inside a
 * top-level BLOCK (an if arm, a loop body, a try) is module-scoped in
 * JS — other functions in the file read the same binding — so it must
 * be a module global like its top-level siblings. Walks a top-level
 * statement's insides for var-flagged declaration lists (statement and
 * for/for-in/for-of initializer positions), never descending into
 * function-likes, classes, or static blocks (each hoists to its own
 * scope). Registration mirrors the main path's identifier story:
 * JS-unmappable types register nothing (per-site fences own the
 * references), everything else gets a mutable global. */
function collectNestedVarGlobals(
  lowerer: Lowerer,
  sf: ts.SourceFile,
  stmt: ts.Statement,
  tag: string,
): void {
  const lists: ts.VariableDeclarationList[] = [];
  // Iterative walk (walkPreorder): this sweep sees every non-var top-level
  // statement whole — the binderBinaryExpressionStress bare ~6500-term
  // chain sat within ~50 terms of overflowing the recursive form.
  ts.walkPreorder(stmt, (node) => {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node) ||
      ts.isClassStaticBlockDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node) ||
      ts.isModuleDeclaration(node)
    ) {
      return "skip";
    }
    if (ts.isVariableDeclarationList(node) && (node.flags & ts.NodeFlags.BlockScoped) === 0) {
      lists.push(node);
      return "skip"; // initializer expressions hold no further statements outside function bodies
    }
    return undefined;
  });
  for (const list of lists) {
    for (const decl of list.declarations.nodes) {
      // A nested builtin require (`if (c) { var fs = require("fs"); }`)
      // lowers to nothing: its bindings are alias plumbing wherever the
      // statement sits (lowerVarDeclarator), so they own no storage.
      if (
        requireAliasDecl(lowerer, decl) &&
        canonicalBuiltinModule(requireSpecOf(decl.initializer!)!) !== null
      )
        continue;
      for (const nameNode of boundIdentifiersOf(decl.name)) {
        const diagsBefore = lowerer.diags.length;
        try {
          if (isJsSourceFile(sf) && !lowerer.mapTypeOf(lowerer.typeOf(nameNode))) continue;
          let type = lowerer.irTypeOf(nameNode);
          // Nested-var unit-only bindings take the unit-only union too
          // (the top-level registration's rule).
          if (type.kind === "void" && isUnitOnlyTsType(lowerer.typeOf(nameNode))) {
            type = unitOnlyUnion(lowerer.unions);
          }
          if (type.kind === "void") lowerer.badType(nameNode, lowerer.typeOf(nameNode));
          if (type.kind === "record" && isJsSourceFile(sf)) {
            const shape = lowerer.shapes.get(type.shapeId);
            if (shape && shape.fields.length === 0 && !shape.indexValue && !shape.tuple) type = DYN;
          }
          if (
            type.kind === "record" &&
            recordTextCodecClass(lowerer.shapes.get(type.shapeId)!) !== null
          ) {
            type = {
              kind: "union",
              unionId: lowerer.unions.intern([type, { kind: "undefinedT" }]),
            };
          }
          const symbol = lowerer.checker.getSymbolAtLocation(nameNode);
          if (!symbol || lowerer.globalsBySymbol.has(symbol)) continue;
          const g: IrGlobal = {
            id: `%g.${tag}${nameNode.text}`,
            name: nameNode.text,
            type,
            mutable: true,
            source: bindingSource(nameNode),
          };
          lowerer.globalsBySymbol.set(symbol, g);
          lowerer.globalsList.push(g);
          noteVarGlobalEntryInit(lowerer, sf, g);
        } catch (e) {
          if (!(e instanceof PoisonError)) throw e;
          deferJsCollectionDiags(lowerer, sf, diagsBefore);
        }
      }
    }
  }
}

/** The checker's symbol for a module's default export — the symbol a
 * default import of this module aliases to (getAliasedSymbol), so keying
 * the default's global by it makes every importer resolve to the same
 * storage through the ordinary globalOf path. Null for modules without
 * a default export (or non-module files). */
export function defaultExportSymbolOf(lowerer: Lowerer, sf: ts.SourceFile): ts.Symbol | null {
  const moduleSym = lowerer.checker.getSymbolAtLocation(sf);
  return moduleSym?.getExports().get(ts.InternalSymbolName.Default as ts.__String) ?? null;
}

/** The declaration symbol of a top-level function/class declaration,
 * covering the one legal NAMELESS form: `export default function () {}` /
 * `export default class {}`. A named declaration answers through its
 * name node; the anonymous default IS the module's `default` export
 * symbol (the binder declares it there), so collection, reachability,
 * and body lowering all key that one identity — which is also what a
 * default import's alias chain resolves to. */
export function declSymbolOf(
  lowerer: Lowerer,
  decl: ts.FunctionDeclaration | ts.ClassDeclaration,
): ts.Symbol | undefined {
  if (decl.name) return lowerer.checker.getSymbolAtLocation(decl.name);
  const isDefault =
    ts.canHaveModifiers(decl) &&
    ts.getModifiers(decl)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) === true;
  if (!isDefault) return undefined;
  const sym = defaultExportSymbolOf(lowerer, ts.getSourceFileOfNode(decl));
  return sym ?? undefined;
}

/** `export default <expr>` in a module's init body: the first (and only)
 * assignment of the pre-registered `default` global — evaluated at the
 * statement's source position, exactly where Node runs it (Node's
 * expression defaults snapshot exactly once, here). ENTITY-NAME defaults
 * of immutable targets are alias plumbing with no storage of their own:
 * the statement lowers to nothing — importers' alias-resolved reads
 * equal the snapshot. MUTABLE entity-name defaults registered snapshot
 * storage in collection and assign it here like any expression default
 * (the identifier read takes the let's value at this statement's
 * position — Node's snapshot). A NON-alias default whose type had no
 * registration (collection reported the blocker) re-lowers the
 * expression so the expression's OWN diagnostic wins when it has one,
 * then poisons. */
export function lowerDefaultExport(lowerer: Lowerer, stmt: ts.ExportAssignment): IrStmt | null {
  const symbol = defaultExportSymbolOf(lowerer, ts.getSourceFileOfNode(stmt));
  if (symbol && symbol.flags & ts.SymbolFlags.Alias && !lowerer.globalsBySymbol.has(symbol))
    return null;
  const g = symbol ? lowerer.globalsBySymbol.get(symbol) : undefined;
  if (!g) {
    // A provably-throwing decorated class expression registered no
    // storage (the registration pass skipped it): the statement IS the
    // throw — lowerClassExpression answers the ambient undefRead.
    {
      let inner: ts.Expression = stmt.expression;
      while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
      if (
        ts.isClassExpression(inner) &&
        !isJsSourceFile(ts.getSourceFileOfNode(stmt)) &&
        inner.typeParameters === undefined &&
        (decoratorNodesOf(inner).length > 0 ||
          inner.members.nodes.some((m) => decoratorNodesOf(m).length > 0)) &&
        guaranteedDecorationThrow(lowerer, inner) !== null
      ) {
        return { kind: "exprStmt", expr: lowerer.lowerExpr(stmt.expression), loc: locOf(stmt) };
      }
    }
    lowerer.lowerExpr(stmt.expression);
    lowerer.badType(stmt.expression, lowerer.typeOf(stmt.expression));
  }
  const value = lowerer.lowerExprExpecting(stmt.expression, g.type);
  return { kind: "assign", localId: g.id, value, loc: locOf(stmt) };
}

/** Marks the runtime fences recorded since `fencesBefore` that lie in
 * `sf`'s top-level code: they run when the module initializes. A fence
 * inside a function, or inside a class member that runs later (a method,
 * accessor, constructor or instance field initializer), runs when that
 * code is called. */
function markModuleInitFences(lowerer: Lowerer, sf: ts.SourceFile, fencesBefore: number): void {
  for (let i = fencesBefore; i < lowerer.runtimeFences.length; i++) {
    const fence = lowerer.runtimeFences[i]!;
    if (fence.loc.file !== sf.fileName || runsAfterModuleInit(sf, fence.loc.start)) continue;
    lowerer.runtimeFences[i] = { ...fence, startup: true };
  }
}

/** Whether the code at `pos` sits in a function or a later-running class
 * member body. */
function runsAfterModuleInit(sf: ts.SourceFile, pos: number): boolean {
  let later = false;
  ts.walkPreorder(sf, (node) => {
    if (node.pos > pos || node.end <= pos) return "skip";
    if (
      ts.isFunctionLike(node) ||
      (ts.isPropertyDeclaration(node) &&
        !node.modifiers?.nodes.some((m) => m.kind === ts.SyntaxKind.StaticKeyword))
    ) {
      later = true;
      return "stop";
    }
    return undefined;
  });
  return later;
}

export function lowerFileInit(
  lowerer: Lowerer,
  sf: ts.SourceFile,
  stmts: ts.Statement[],
  name: string,
): IrFunction {
  const isAsync = lowerer.asyncInitFiles.has(sf);
  const ctx = newFnCtx(false, null, null, VOID);
  ctx.isAsync = isAsync;
  const fencesBefore = lowerer.runtimeFences.length;
  lowerer.fnStack.push(ctx);
  try {
    const loc0: SrcLoc = { file: sf.fileName, start: 0, end: 0 };
    const header: IrStmt[] = [];
    const asyncDeps: { completionId: string; loc: SrcLoc; cycleInternal: boolean }[] = [];
    const guardId = lowerer.moduleGuardOf.get(sf);
    if (guardId !== undefined) {
      header.push({
        kind: "if",
        cond: { kind: "varRef", localId: guardId, type: BOOL, loc: loc0 },
        then: [{ kind: "return", value: null, loc: loc0 }],
        else_: null,
        loc: loc0,
      });
      // The flag sets BEFORE the body runs — Node marks the cache entry
      // before evaluating too (moot while cycles are fenced, but the
      // honest order costs nothing).
      header.push({
        kind: "assign",
        localId: guardId,
        value: { kind: "boolLit", value: true, type: BOOL, loc: loc0 },
        loc: loc0,
      });
    }
    if (sf === lowerer.entry) header.push(...lowerer.punycodeLinkWarning());
    // Modules shared with Node islands register before any module runs
    // (NI-6); the plan also creates their declarations' TDZ flags.
    if (sharedModulePlans(lowerer).length > 0 && sf === lowerer.entry)
      header.push(...sharedModuleRegistrations(lowerer));
    // Top-level `this` of a CommonJS module: its object exists before the
    // module's first statement (lowerCjsTopLevelThis).
    const exportsThis = lowerer.cjsExportsThis.get(sf);
    if (exportsThis) {
      header.push({
        kind: "assign",
        localId: exportsThis.id,
        value: { kind: "dynObjLit", fields: [], type: DYN, loc: loc0 },
        loc: loc0,
      });
    }
    // Reassigned function declarations are initialized when the module
    // starts, as declarations are hoisted: before its dependencies run, so
    // a module of an import cycle can call one while it initializes. Their
    // statements then lower to nothing (rebindable-functions.ts).
    for (const stmt of stmts) {
      if (!ts.isFunctionDeclaration(stmt) || !stmt.name || !isRebindableFunction(lowerer, stmt))
        continue;
      const g = lowerer.globalsByDeclNode.get(stmt);
      if (!g) continue;
      header.push({
        kind: "assign",
        localId: g.id,
        value: lowerer.coerceToExpected(lowerer.lowerLambda(stmt), DYN),
        loc: locOf(stmt),
      });
      ctx.hoistedFnDecls.add(stmt);
    }
    for (const { stmt, dep } of orderedImportsOf(lowerer.program, sf)) {
      const npm = lowerer.npmInitActions.get(sf)?.get(stmt);
      if (npm !== undefined && npm.length > 0) {
        header.push(...npm);
      } else if (dep !== null && dep !== sf) {
        // dep === sf is the self-import (the package self-name resolving
        // to the importing module): Node answers it from the module
        // cache mid-evaluation — no re-evaluation, nothing to call (and
        // the ENTRY has no run-once guard, so a self-call would recurse).
        const depInit = lowerer.initNameOf.get(dep);
        if (depInit !== undefined) {
          const loc = locOf(stmt);
          const depAsync = lowerer.asyncInitFiles.has(dep);
          if (depAsync && !isAsync) {
            lowerer.unsupported(
              "SC1090",
              stmt,
              `loading '${dep.fileName}' from a CommonJS module ` +
                "(the required ES-module graph uses top-level await; use import() instead)",
            );
          }
          const call: IrExpr = {
            kind: "call",
            callee: depInit,
            args: [],
            type: depAsync ? { kind: "promise", inner: VOID } : VOID,
            loc,
          };
          if (depAsync) {
            // Start every dependency in source order before waiting for
            // any of them. ECMAScript's module evaluator continues into
            // later sibling dependencies while an earlier one is
            // suspended; the importer body waits for all of them.
            const p = lowerer.declareHiddenLocal("%depInit", { kind: "promise", inner: VOID });
            header.push({ kind: "varDecl", localId: p.id, init: call, loc });
            const sfCycle = lowerer.asyncCycleRepresentativeOf.get(sf);
            const depCycle = lowerer.asyncCycleRepresentativeOf.get(dep);
            const cycleInternal = sfCycle !== undefined && sfCycle === depCycle;
            // An importer outside the requested member's SCC waits for
            // the SCC's RUNTIME root, not merely that member's promise.
            // Another earlier sibling can already have entered the cycle
            // through a different member; a non-root member may complete
            // while the root remains suspended. The eager spawn above has
            // published the root by the time it returns. Internal edges
            // keep the member promise: their guard-hit completion is what
            // breaks recursive evaluation without an await hop.
            const completionId =
              !cycleInternal && depCycle !== undefined
                ? lowerer.asyncCyclePromiseOf.get(dep)!
                : p.id;
            asyncDeps.push({
              completionId,
              loc,
              cycleInternal,
            });
          } else {
            header.push({ kind: "exprStmt", expr: call, loc });
            // An ES-module importer links a CommonJS dependency: Node
            // copies its lexer-visible exports here.
            if (
              (ts.isImportDeclaration(stmt) || ts.isExportDeclaration(stmt)) &&
              !isCjsJsFile(sf, lowerer.program) &&
              isCjsJsFile(dep, lowerer.program)
            )
              header.push(...cjsAccessorSnapshotStores(lowerer, dep, loc));
          }
        }
      }
    }
    if (asyncDeps.length === 1) {
      const dep = asyncDeps[0]!;
      const promiseT: IrType = { kind: "promise", inner: VOID };
      const value: IrExpr = {
        kind: "varRef",
        localId: dep.completionId,
        type: promiseT,
        loc: dep.loc,
      };
      header.push({
        kind: "exprStmt",
        expr: dep.cycleInternal
          ? { kind: "intrinsic", name: "module.await", args: [value], type: VOID, loc: dep.loc }
          : { kind: "awaitExpr", value, type: VOID, loc: dep.loc },
        loc: dep.loc,
      });
    } else if (asyncDeps.length > 1) {
      const promiseT: IrType = { kind: "promise", inner: VOID };
      const loc = asyncDeps[0]!.loc;
      const entries: IrExpr = {
        kind: "arrayLit",
        elems: asyncDeps.map((dep): IrExpr => ({
          kind: "varRef",
          localId: dep.completionId,
          type: promiseT,
          loc: dep.loc,
        })),
        type: arrayOf(promiseT),
        loc,
      };
      const all: IrExpr = {
        kind: "intrinsic",
        name: "promise.all",
        args: [entries],
        type: promiseT,
        loc,
      };
      header.push({
        kind: "exprStmt",
        expr: asyncDeps.every((dep) => dep.cycleInternal)
          ? { kind: "intrinsic", name: "module.await", args: [all], type: VOID, loc }
          : { kind: "awaitExpr", value: all, type: VOID, loc },
        loc,
      });
    }
    // Module-scope `var` hoisting: undefined-armed var globals hold the
    // interned undefined from module entry (before any body statement —
    // a function called above the declaration reads `undefined`, exactly
    // Node); checked-dynamic var globals hold the dyn undefined the same
    // way. After the guard: a cache-hit revisit must not reset them.
    // A union slot the body retypes checked-dynamic (lowerVarDecl: a
    // JavaScript var initialized with an existing checked-dynamic object)
    // gets the dyn undefined once the body has lowered.
    const unionEntryInits: { at: number; g: IrGlobal }[] = [];
    for (const g of lowerer.varGlobalEntryInits.get(sf) ?? []) {
      if (g.type.kind !== "union" && g.type.kind !== "dyn") continue;
      const wrapped =
        g.type.kind === "dyn" ? dynUndefinedExpr(loc0) : lowerer.unassignedSlotInit(g.type, loc0);
      if (wrapped) {
        if (g.type.kind === "union") unionEntryInits.push({ at: header.length, g });
        // A let global whose early reads are checked (initFlag) only
        // gets its storage filled here: this is not the source write, so
        // it must neither run the TDZ check nor set the flag.
        header.push({
          kind: "assign",
          localId: g.id,
          value: wrapped,
          ...(g.initFlag !== undefined ? { initializes: true as const } : {}),
          loc: loc0,
        });
      }
    }
    const prelude = lowerer.jsonInitActions.get(sf) ?? [];
    // Class STATIC readonly fields, static BLOCKS, and class DECORATORS
    // run at their class statement's source position (splitFiles hoisted
    // the declarations out of `stmts`, so the statements merge back in
    // by position) — exactly when JS evaluates decorators, static
    // initializers, and blocks, so code reading an earlier module
    // binding sees its assigned value.
    const statics = [...lowerer.classes.values()]
      .filter(
        (c) =>
          // Class DECLARATIONS only: expression classes run their static
          // inits through pendingClassExprInits (below) at the statement
          // that evaluates them. MIXIN instantiations join by their CALL
          // SITE's position instead (below) — their inner class node may
          // even live in another file.
          c.decl &&
          ts.isClassDeclaration(c.decl) &&
          !c.mixinInstance &&
          ts.getSourceFileOfNode(c.decl) === sf &&
          (lowerer.classInitFlags.has(c.def.name) ||
            c.callableBase !== undefined ||
            c.def.baseValueGlobal !== undefined ||
            c.runtimeStatics !== undefined ||
            c.staticFields.length > 0 ||
            (c.staticBlocks?.length ?? 0) > 0 ||
            c.classDecorators !== undefined),
      )
      .map((c) => ({ pos: ts.tokenStartOfNode(c.decl!), info: c }));
    // Statics-bearing MIXIN instantiations whose call evaluates in THIS
    // file: their declaration-time code runs when the call does — the
    // top-level statement lower-mixins recorded. Insertion order is
    // demand order (a nested mixin's base instantiates first, a
    // heritage base before its derived class), so the stable sort keeps
    // JS's evaluation order at equal positions.
    for (const c of lowerer.classes.values()) {
      const ms = c.mixinInstance?.statics;
      if (ms && ms.sf === sf) statics.push({ pos: ms.pos, info: c });
    }
    statics.sort((a, b) => a.pos - b.pos);
    const body = [...header, ...prelude];
    let at = 0;
    for (const stmt of stmts) {
      // `<=`: a mixin instantiation's position IS its statement's start
      // — its statics run mid-statement in JS (the call), before
      // anything the statement's lowering emits. Hoisted class
      // declarations never share a kept statement's start, so `<=`
      // changes nothing for them.
      while (at < statics.length && statics[at]!.pos <= ts.tokenStartOfNode(stmt)) {
        body.push(
          ...withClassInitFlag(
            lowerer,
            statics[at]!.info,
            lowerer.lowerStaticFieldInits(statics[at]!.info),
          ),
        );
        at++;
      }
      // A cycle binding's declaration stays at its position: its
      // initialization flag must be set where the declaration runs.
      const deferred = lowerer.cycleInitDeclarations.has(stmt)
        ? null
        : lowerer.deferredModuleInitializers?.defer(lowerer, stmt);
      const stmtIr = withCycleInitFlags(
        lowerer,
        stmt,
        deferred ? [deferred] : lowerer.lowerStmts([stmt]),
      );
      if (lowerer.sharedInitFlags.size > 0) stmtIr.push(...sharedInitFlagStores(lowerer, stmt));
      // Class EXPRESSIONS inside this statement queued their static
      // inits while it lowered: they land immediately before it — JS's
      // order for the supported whole-initializer positions.
      body.push(...lowerer.pendingClassExprInits.splice(0), ...stmtIr);
    }
    while (at < statics.length) {
      body.push(
        ...withClassInitFlag(
          lowerer,
          statics[at]!.info,
          lowerer.lowerStaticFieldInits(statics[at]!.info),
        ),
      );
      at++;
    }
    for (const { at, g } of unionEntryInits) {
      if (g.type.kind !== "dyn") continue;
      body[at] = {
        kind: "assign",
        localId: g.id,
        value: dynUndefinedExpr(loc0),
        ...(g.initFlag !== undefined ? { initializes: true as const } : {}),
        loc: loc0,
      };
    }
    const moduleRef = cjsModuleRef(lowerer, sf);
    if (moduleRef !== null) {
      const guardedBody = body.splice(guardId !== undefined ? 2 : 0);
      const catchLocal = lowerer.declareHiddenLocal("%moduleError", { kind: "caught" });
      guardedBody.unshift({
        kind: "exprStmt",
        expr: { kind: "libCall", fn: "module.enter", args: [moduleRef], type: VOID, loc: loc0 },
        loc: loc0,
      });
      guardedBody.push({
        kind: "exprStmt",
        expr: { kind: "libCall", fn: "module.finish", args: [moduleRef], type: VOID, loc: loc0 },
        loc: loc0,
      });
      body.push({
        kind: "tryCatch",
        tryBody: guardedBody,
        catchBody: [
          {
            kind: "exprStmt",
            expr: { kind: "libCall", fn: "module.fail", args: [moduleRef], type: VOID, loc: loc0 },
            loc: loc0,
          },
          ...(guardId !== undefined
            ? [
                {
                  kind: "assign" as const,
                  localId: guardId,
                  value: { kind: "boolLit" as const, value: false, type: BOOL, loc: loc0 },
                  loc: loc0,
                },
              ]
            : []),
          { kind: "rethrow", localId: catchLocal.id, loc: loc0 },
        ],
        catchLocalId: catchLocal.id,
        finallyBody: null,
        loc: loc0,
      });
    }
    if (
      moduleRef === null &&
      guardId !== undefined &&
      !isAsync &&
      importRetryModules(lowerer).has(sf)
    ) {
      rememberEvaluationError(lowerer, guardId, body, loc0);
    }
    const loc: SrcLoc = { file: sf.fileName, start: 0, end: 0 };
    return {
      name,
      params: [],
      returnType: VOID,
      locals: lowerer.ctx.locals,
      body,
      ...(isAsync ? { async: true as const } : {}),
      ...(isAsync ? { asyncCacheGlobal: lowerer.modulePromiseOf.get(sf)! } : {}),
      ...(lowerer.asyncCyclePromiseOf.has(sf)
        ? { asyncCycleCacheGlobal: lowerer.asyncCyclePromiseOf.get(sf)! }
        : {}),
      loc,
    };
  } finally {
    lowerer.fnStack.pop();
    markModuleInitFences(lowerer, sf, fencesBefore);
  }
}

/** Program modules whose evaluation can be requested again after it
 * threw: the targets of literal import() sites and their static ES-module
 * dependencies. Node records the evaluation error on the module, and every
 * later import of it (or of a module depending on it) throws that same
 * error again instead of resolving. */
function importRetryModules(lowerer: Lowerer): ReadonlySet<ts.SourceFile> {
  const memo = lowerer.importRetryModules;
  if (memo !== null) return memo;
  const out = new Set<ts.SourceFile>();
  const visit = (sf: ts.SourceFile): void => {
    if (out.has(sf) || sf.fileName.endsWith(".cts") || isCjsJsFile(sf, lowerer.program)) return;
    out.add(sf);
    for (const { dep } of orderedImportsOf(lowerer.program, sf)) {
      if (dep !== null && dep !== sf) visit(dep);
    }
  };
  for (const sf of lowerer.moduleOrder) {
    for (const dep of dynamicProgramImportsOf(lowerer.program, sf)) visit(dep);
  }
  lowerer.importRetryModules = out;
  return out;
}

/** Wraps a guarded module body so a thrown evaluation error is kept and
 * thrown again by every later call of the initializer. The first two
 * statements are the run-once guard and the flag store. */
function rememberEvaluationError(
  lowerer: Lowerer,
  guardId: string,
  body: IrStmt[],
  loc: SrcLoc,
): void {
  const errorId = `${guardId}%error`;
  const failedId = `${guardId}%failed`;
  if (!lowerer.globalsList.some((g) => g.id === errorId)) {
    lowerer.globalsList.push({ id: errorId, name: "%error", type: CAUGHT, mutable: true });
    lowerer.globalsList.push({ id: failedId, name: "%failed", type: BOOL, mutable: true });
  }
  const guarded = body.splice(2);
  const failed: IrExpr = { kind: "varRef", localId: failedId, type: BOOL, loc };
  body[0] = {
    kind: "if",
    cond: { kind: "varRef", localId: guardId, type: BOOL, loc },
    then: [
      {
        kind: "if",
        cond: failed,
        then: [{ kind: "rethrow", localId: errorId, loc }],
        else_: null,
        loc,
      },
      { kind: "return", value: null, loc },
    ],
    else_: null,
    loc,
  };
  const caught = lowerer.declareHiddenLocal("%moduleError", CAUGHT);
  body.push({
    kind: "tryCatch",
    tryBody: guarded,
    catchBody: [
      {
        kind: "assign",
        localId: errorId,
        value: { kind: "varRef", localId: caught.id, type: CAUGHT, loc },
        loc,
      },
      {
        kind: "assign",
        localId: failedId,
        value: { kind: "boolLit", value: true, type: BOOL, loc },
        loc,
      },
      { kind: "rethrow", localId: caught.id, loc },
    ],
    catchLocalId: caught.id,
    finallyBody: null,
    loc,
  });
}

/** %main is just the entry's %init call: Node's whole module evaluation
 * order lives in the init functions themselves — each file's hoisted
 * import header runs its dependencies first (depth-first postorder by
 * nesting), CommonJS require statements call dependency inits inline in
 * their bodies, and the run-once guards turn every revisit (diamonds,
 * re-imports, re-requires) into a cache hit. */
export function buildMain(lowerer: Lowerer): IrFunction {
  const loc: SrcLoc = { file: lowerer.entry.fileName, start: 0, end: 0 };
  const body: IrStmt[] = [
    ...lowerer.mainPrelude,
    ...cjsModuleRegistryPrelude(lowerer, loc),
    ...handleEventReaderPrelude(lowerer, loc),
    ...dateClassOperationPrelude(lowerer, loc),
  ];
  const roots = [lowerer.entry, ...lowerer.forkTargets, ...lowerer.workerTargets];
  const isAsync = roots.some((root) => lowerer.asyncInitFiles.has(root));
  const callRoot = (root: ts.SourceFile): IrStmt[] => {
    const init = lowerer.initNameOf.get(root);
    if (init === undefined) return [];
    const rootAsync = lowerer.asyncInitFiles.has(root);
    const call: IrExpr = {
      kind: "call",
      callee: init,
      args: [],
      type: rootAsync ? { kind: "promise", inner: VOID } : VOID,
      loc,
    };
    return [
      {
        kind: "exprStmt",
        expr: rootAsync ? { kind: "awaitExpr", value: call, type: VOID, loc } : call,
        loc,
      },
    ];
  };
  const locals = [] as IrFunction["locals"];
  if (lowerer.forkTargets.length === 0) {
    body.push(...callRoot(lowerer.entry));
  } else {
    const targetId = "%forkTarget.0";
    locals.push({ id: targetId, name: "%forkTarget", type: F64, mutable: false });
    body.push({
      kind: "varDecl",
      localId: targetId,
      init: {
        kind: "libCall",
        fn: "process.forkTarget",
        args: [{ kind: "numLit", value: lowerer.forkTargets.length, type: F64, loc }],
        type: F64,
        loc,
      },
      loc,
    });
    const selector = (): IrExpr => ({ kind: "varRef", localId: targetId, type: F64, loc });
    let workerBranch: IrStmt[] | null = null;
    for (let id = lowerer.forkTargets.length - 1; id >= 0; id--) {
      workerBranch = [
        {
          kind: "if",
          cond: {
            kind: "bin",
            op: "===",
            left: selector(),
            right: { kind: "numLit", value: id, type: F64, loc },
            type: BOOL,
            loc,
          },
          then: callRoot(lowerer.forkTargets[id]!),
          else_: workerBranch,
          loc,
        },
      ];
    }
    body.push({
      kind: "if",
      cond: {
        kind: "bin",
        op: "<",
        left: selector(),
        right: { kind: "numLit", value: 0, type: F64, loc },
        type: BOOL,
        loc,
      },
      then: callRoot(lowerer.entry),
      else_: workerBranch,
      loc,
    });
  }
  if (lowerer.workerTargets.length > 0) {
    const mainBody = body.splice(0);
    let workerBody: IrStmt[] | null = null;
    for (let id = lowerer.workerTargets.length - 1; id >= 0; id--) {
      workerBody = [
        {
          kind: "if",
          cond: {
            kind: "bin",
            op: "===",
            left: { kind: "libCall", fn: "worker.root", args: [], type: F64, loc },
            right: { kind: "numLit", value: id, type: F64, loc },
            type: BOOL,
            loc,
          },
          then: callRoot(lowerer.workerTargets[id]!),
          else_: workerBody,
          loc,
        },
      ];
    }
    body.push({
      kind: "if",
      cond: { kind: "libCall", fn: "worker.isMainThread", args: [], type: BOOL, loc },
      then: mainBody,
      else_: [...cjsModuleRegistryPrelude(lowerer, loc), ...(workerBody ?? [])],
      loc,
    });
  }
  // Node's startup refusal (a resolution the graph carries that Node
  // rejects — preflight's Node-order resolution walk — or a module-LINK
  // SyntaxError from either named-import checker): the graph is refused
  // before ANY module evaluates, so %main opens with exactly that throw
  // (message and error class both Node's) and the entry init below it
  // never runs. The init still lowers — the program must otherwise
  // compile, exactly like Node parses every module before its
  // fetch/instantiate phases refuse the graph.
  if (lowerer.startupCrash !== null) {
    const crashLoc: SrcLoc = lowerer.startupCrash.loc;
    body.unshift({
      kind: "throw",
      value: {
        kind: "libCall",
        fn: "error.new",
        args: [
          { kind: "strLit", value: lowerer.startupCrash.message, type: STRING, loc: crashLoc },
        ],
        type: { kind: "object", className: lowerer.startupCrash.className },
        loc: crashLoc,
      },
      loc: crashLoc,
    });
  }
  return {
    name: ENTRY_NAME,
    params: [],
    returnType: VOID,
    locals,
    body,
    ...(isAsync ? { async: true as const } : {}),
    loc,
  };
}
