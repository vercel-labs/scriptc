/* Calls into Node islands. Milestone NI-1 of the scope-B plan has one kind:
 * the explicit @scriptc/node API, `callSync(specifier, name, ...args)` and
 * `call(...)`, which run an export of a module in Node.js loaded into the
 * program (scr_node_island.c, libnode) and copy JSON data both ways. The
 * libCalls are the only `nodeIsland.*` operations, so a program without
 * them links none of that runtime (the `nodeIsland` runtime feature).
 *
 * Semantics, shared with packages/node/index.js (the Node implementation):
 * the arguments are copied with JSON.stringify of the argument array; the
 * module loads with require() from the calling module, so relative
 * specifiers resolve from it. The specifier is a string literal: the build
 * collects the module and what it loads into the executable
 * (node-islands/modules.ts), and the call names its caller by its path in
 * that tree, never by a path on the build machine. The result crosses as
 * its JSON copy and is
 * checked against the declared result type, like `JSON.parse(s) as T`; a
 * thrown Error crosses as its nearest intrinsic class with its message and
 * string `code`. */
import { readFileSync, realpathSync, statSync } from "node:fs";
import { resolveFrom } from "../../node-islands/resolve.js";
import { dirname, isAbsolute, join, resolve } from "node:path";
import * as ts from "../ts7/adapter.js";
import { fileWritesBinding } from "../binding-writes.js";
import { withoutParenthesesTypeWrappers } from "../outer-expressions.js";
import { isJsSourceFile, locOf } from "../program.js";
import { extendsElementOf } from "../heritage-elements.js";
import { isRelativeSpecifier } from "../workspace-registry.js";
import type { NodeApiMember } from "../node-api-import.js";
import { PoisonError, newFnCtx, type Lowerer } from "./lowerer.js";
import { isOptionalChainTail } from "./expressions/optional-chains.js";
import {
  BOOL,
  DYN,
  DYN_HANDLE_KINDS,
  FOREIGN,
  NULL_T,
  STRING,
  VOID,
  canAdaptDynFuncTo,
  type IrExpr,
  type IrGlobal,
  type IrLocal,
  type IrStmt,
  type IrType,
  type SrcLoc,
} from "../../ir/ir.js";
import { dynUndefinedExpr, varRef } from "../../ir/build.js";
import { islandValueOrigin, ORIGIN_SEPARATOR } from "./decl-origin.js";
import { claimKey } from "./type-claims.js";
import { classMethodValue } from "./class-method-values.js";
import { funcTypeFromParamShapes } from "./call-signatures.js";
import { resolveBareModule } from "../resolve.js";
import {
  nativeSubclassOfIslandDiag,
  nodeIslandBoundaryDiag,
  nodeIslandDataFileDiag,
  nodeIslandModuleDiag,
} from "../../diagnostics/diagnostic.js";
import {
  crossingOf,
  isCopiedTsType,
  isForeignType,
  isIslandDeclared,
  isIslandSubclassDecl,
  markIslandSubclass,
  islandOwnerOfFile,
  type NodeIslandSet,
} from "../../node-islands/boundary.js";
import { thenReader } from "./checked-promise-all.js";
import { dynCompoundValue } from "./lower-exprs.js";
import { COMPOUND_ASSIGN_OPS } from "./surfaces.js";
import { lowerClosedIslandInit } from "./closed-island-init.js";

const JSON_HINT =
  "only JSON data (numbers, strings, booleans, null, arrays, plain objects of those, and unknown) crosses into Node.js in this version";

/** The first part of `t` that is not JSON data, or null. `seen` holds the
 * records and unions already being checked, so a recursive type (a JSON
 * value type that contains arrays or records of itself) ends there. */
function nonJsonPart(lowerer: Lowerer, t: IrType, seen: Set<string>): IrType | null {
  switch (t.kind) {
    case "f64":
    case "string":
    case "bool":
    case "nullT":
    case "undefinedT":
    case "dyn":
      return null;
    case "array":
      return nonJsonPart(lowerer, t.elem, seen);
    case "record": {
      if (seen.has(`record:${t.shapeId}`)) return null;
      seen.add(`record:${t.shapeId}`);
      const shape = lowerer.shapes.get(t.shapeId);
      if (shape === undefined) return t;
      for (const field of shape.fields) {
        const bad = nonJsonPart(lowerer, field.type, seen);
        if (bad !== null) return bad;
      }
      return shape.indexValue === undefined ? null : nonJsonPart(lowerer, shape.indexValue, seen);
    }
    case "union": {
      if (seen.has(`union:${t.unionId}`)) return null;
      seen.add(`union:${t.unionId}`);
      const def = lowerer.unions.get(t.unionId);
      if (def === undefined) return t;
      for (const arm of def.arms) {
        const bad = nonJsonPart(lowerer, arm, seen);
        if (bad !== null) return bad;
      }
      return null;
    }
    default:
      return t;
  }
}

/** The calling module's real path: relative specifiers resolve from it,
 * as Node's own loader resolves them from the real path of the module. */
function callerPath(node: ts.Node): string {
  const file = ts.getSourceFileOfNode(node).fileName;
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
}

export function lowerNodeApiCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  member: NodeApiMember,
): IrExpr {
  const loc = locOf(call);
  const surface = `${member} (@scriptc/node)`;
  const argNodes = call.arguments.nodes;
  if (member === "requireModule") return lowerRequireModule(lowerer, call, surface);
  if (call.questionDotToken || argNodes.length < 2 || argNodes.some(ts.isSpreadElement)) {
    lowerer.noLowering(
      `${surface} without a specifier and an export name, or with spread arguments`,
      call,
      "pass the module specifier, the export name and each argument explicitly",
    );
  }
  const specifierNode = argNodes[0]!;
  if (!ts.isStringLiteral(specifierNode) && !ts.isNoSubstitutionTemplateLiteral(specifierNode)) {
    lowerer.pushDiag(
      nodeIslandModuleDiag(`${surface} with a computed module specifier`, locOf(specifierNode)),
    );
    throw new PoisonError();
  }
  const caller = callerPath(call);
  const problem = lowerer.nodeIslandModules.add(caller, specifierNode.text);
  if (problem !== null) {
    const diag = lowerer.nodeIslandModules.isDataFileProblem(problem)
      ? nodeIslandDataFileDiag
      : nodeIslandModuleDiag;
    lowerer.pushDiag(diag(`${surface}: ${problem}`, locOf(specifierNode)));
    throw new PoisonError();
  }
  lowerer.noteIslandOnWorkerThread(specifierNode.text, call);
  const specifier = lowerer.lowerExprExpecting(specifierNode, STRING);
  // An absolute specifier names a file of the build machine: the call names
  // the shipped copy, relative to the caller inside the tree.
  if (isAbsolute(specifierNode.text) && specifier.kind === "strLit") {
    const target = lowerer.nodeIslandModules.resolvedPath(caller, specifierNode.text);
    if (target !== null) lowerer.nodeIslandSpecifiers.push({ literal: specifier, caller, target });
  }
  const name = lowerer.lowerExprExpecting(argNodes[1]!, STRING);
  const values = argNodes.slice(2).map((arg) => {
    const value = lowerer.lowerExpr(arg);
    const bad = nonJsonPart(lowerer, value.type, new Set());
    if (bad !== null)
      lowerer.noLowering(`passing '${lowerer.fmt(bad)}' values to ${surface}`, arg, JSON_HINT);
    return lowerer.coerceToExpected(value, DYN);
  });
  const declared = lowerer.mapTypeOf(lowerer.typeOf(call));
  const result = member === "call" && declared?.kind === "promise" ? declared.inner : declared;
  if (declared === null || result === null || result === undefined) {
    lowerer.noLowering(`${surface} with an unrepresentable result type`, call, JSON_HINT);
  }
  if (result.kind !== "void") {
    const bad = nonJsonPart(lowerer, result, new Set());
    if (bad !== null)
      lowerer.noLowering(`'${lowerer.fmt(bad)}' results of ${surface}`, call, JSON_HINT);
  }
  lowerer.noteNodeIslandUse(loc.file, surface);
  // The caller's tree path is known once every call is collected (Lowerer).
  const callerLiteral: IrExpr & { kind: "strLit" } = {
    kind: "strLit",
    value: caller,
    type: STRING,
    loc,
  };
  lowerer.nodeIslandCallers.push({ literal: callerLiteral, caller });
  const raw: IrExpr = {
    kind: "libCall",
    fn: member === "call" ? "nodeIsland.call" : "nodeIsland.callSync",
    args: [callerLiteral, specifier, name, { kind: "dynArrLit", elems: values, type: DYN, loc }],
    type: member === "call" ? { kind: "promise", inner: DYN } : DYN,
    loc,
  };
  // A void result is discarded, unchecked like any void call's value.
  if (declared.kind === "void") return raw;
  // The JSON copy meets the declared type through the checked boundary of
  // `JSON.parse(s) as T`: types don't lie, a mismatch throws.
  return lowerer.coerceToExpected(raw, declared);
}

/** requireModule(specifier): Node's require() from the calling module, run
 * in the island; the exports cross by reference (scope-B NI-4: an island
 * handle the program uses as an `any` value). The specifier must be a
 * string literal: it resolves at build time exactly as require.resolve
 * resolves it from the caller, and the island loads that file, shipped
 * with the program (islandLoadPath). */
function lowerRequireModule(lowerer: Lowerer, call: ts.CallExpression, surface: string): IrExpr {
  const loc = locOf(call);
  const argNodes = call.arguments.nodes;
  const arg = argNodes[0];
  if (
    call.questionDotToken ||
    argNodes.length !== 1 ||
    arg === undefined ||
    !ts.isStringLiteral(arg)
  ) {
    lowerer.noLowering(
      `${surface} without exactly one string-literal specifier`,
      call,
      "pass the module specifier as a string literal",
    );
  }
  const from = callerPath(call);
  let path: string;
  try {
    path = resolveFrom(from, arg.text);
  } catch {
    lowerer.noLowering(
      `${surface} of '${arg.text}', which does not resolve from ${from}`,
      call,
      "install the module or fix the specifier",
    );
  }
  lowerer.noteIslandOnWorkerThread(arg.text, call);
  lowerer.noteNodeIslandUse(loc.file, surface);
  const raw: IrExpr = {
    kind: "libCall",
    fn: "nodeIsland.require",
    args: [islandLoadPath(lowerer, path, loc)],
    type: DYN,
    loc,
  };
  const declared = lowerer.mapTypeOf(lowerer.typeOf(call));
  if (declared === null || declared === undefined || declared.kind === "dyn") return raw;
  return lowerer.coerceToExpected(raw, declared);
}

/* ── compiler-managed Node islands (scope-B NI-4) ─────────────────────────
 *
 * A package the build runs in a Node island is never compiled. Its static
 * imports load the island module at the importing module's position
 * (eager evaluation: `nodeIsland.require` in the module's %init prelude,
 * before the body), and their bindings read island values: a named import
 * of an ES module reads the live namespace member at each use; a CommonJS
 * module's named imports are read once after it evaluates, as Node's
 * namespace for CommonJS snapshots them; a default import of CommonJS is
 * module.exports. `require()` of an island package anywhere and `import()`
 * load the same way at the call.
 *
 * Island values are typed by the package's declarations: values of
 * island-declared object types are island handles (FOREIGN, see
 * node-islands/boundary.ts), and member reads, writes, calls and `new` on
 * them become bridge calls whose results meet the declared type through
 * the checked dyn conversion (types don't lie: a mismatch throws). */

/** One island module load: the module global that holds what the import
 * form sees (module.exports for CommonJS, the namespace for ESM). */
export interface IslandModuleBinding {
  global: IrGlobal;
  /** The JavaScript file Node loads. */
  path: string;
  esm: boolean;
  /** CommonJS named imports, snapshotted after evaluation: name -> global. */
  snapshots: Map<string, IrGlobal>;
}

function boundaryFail(lowerer: Lowerer, what: string, node: ts.Node): never {
  lowerer.pushDiag(nodeIslandBoundaryDiag(what, locOf(node)));
  throw new PoisonError();
}

/** Whether the JavaScript file is an ES module by Node's rules. */
export function isEsmFile(file: string): boolean {
  if (file.endsWith(".mjs")) return true;
  if (file.endsWith(".cjs")) return false;
  for (let dir = dirname(file); ;) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
        type?: unknown;
      };
      return pkg.type === "module";
    } catch {
      /* no package.json here */
    }
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/** The file a relative (or absolute) specifier names from `fromFile`, as
 * Node's CommonJS/ESM resolution would find it, or null. Extension fallback
 * and directory indexes only: an island module is a file the program
 * already loaded, and `exports` maps stay Node's job. */
function relativeIslandFile(fromFile: string, spec: string): string | null {
  const base = isAbsolute(spec) ? spec : resolve(dirname(fromFile), spec);
  const candidates = [base];
  if (!/\.[cm]?js$/.test(base)) {
    for (const ext of [".js", ".cjs", ".mjs"]) candidates.push(base + ext);
  }
  for (const ext of [".js", ".cjs", ".mjs"]) candidates.push(join(base, `index${ext}`));
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* the next candidate */
    }
  }
  return null;
}

/** The island module file `spec` names from `fromFile`, or null when the
 * specifier does not resolve into an island package or module. */
export function islandModuleFile(
  islands: NodeIslandSet,
  fromFile: string,
  spec: string,
  kind: "import" | "require",
): string | null {
  let file: string;
  if (isRelativeSpecifier(spec) || isAbsolute(spec)) {
    // A program module the pre-scan put in a Node island (DESIGN.md note 1
    // §3.2): the file itself is the island, resolved as Node would.
    if (islands.modules.size === 0) return null;
    const resolved = relativeIslandFile(fromFile, spec);
    if (resolved === null) return null;
    if (islandOwnerOfFile(islands, resolved) === null) return null;
    file = resolved;
  } else {
    const js = resolveBareModule(fromFile, spec, "js-only", kind);
    if (js === null) return null;
    if (islandOwnerOfFile(islands, js.typesFile) === null) return null;
    file = js.typesFile;
  }
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
}

/** The module global of the island module at `path`, created on first use. */
export function islandModuleGlobal(lowerer: Lowerer, path: string): IslandModuleBinding {
  let binding = lowerer.islandModules.get(path);
  if (binding === undefined) {
    const global: IrGlobal = {
      id: `%g.island.${lowerer.globalsList.length}`,
      name: path.split("/").at(-1) ?? "island",
      type: DYN,
      mutable: true,
    };
    lowerer.globalsList.push(global);
    binding = { global, path, esm: isEsmFile(path), snapshots: new Map() };
    lowerer.islandModules.set(path, binding);
  }
  return binding;
}

/** The path literal of a load of the file at `path`. The build ships the
 * file with the program (node-islands/modules.ts): the literal names it by
 * its path in the shipped tree once lowering ends. A built-in module keeps
 * its name. */
function islandLoadPath(lowerer: Lowerer, path: string, loc: SrcLoc): IrExpr {
  const literal: IrExpr & { kind: "strLit" } = { kind: "strLit", value: path, type: STRING, loc };
  if (!isAbsolute(path)) return literal;
  let real = path;
  try {
    real = realpathSync(path);
  } catch {
    /* the resolved path */
  }
  const problem = lowerer.nodeIslandModules.addLoaded(real);
  if (problem !== null) {
    const diag = lowerer.nodeIslandModules.isDataFileProblem(problem)
      ? nodeIslandDataFileDiag
      : nodeIslandModuleDiag;
    lowerer.pushDiag(diag(problem, loc));
    throw new PoisonError();
  }
  lowerer.nodeIslandLoads.push({ literal, path: real });
  return literal;
}

/** The path literal of a module the program shares with its islands
 * (lower-shared-modules.ts), named by its path in the shipped tree like a
 * load's. */
export function islandSharedPath(lowerer: Lowerer, path: string, loc: SrcLoc): IrExpr {
  const literal: IrExpr & { kind: "strLit" } = { kind: "strLit", value: path, type: STRING, loc };
  lowerer.nodeIslandModules.addProvided(path);
  lowerer.nodeIslandLoads.push({ literal, path });
  return literal;
}

function loadIslandModule(lowerer: Lowerer, path: string, loc: SrcLoc): IrExpr {
  return {
    kind: "libCall",
    fn: "nodeIsland.require",
    args: [islandLoadPath(lowerer, path, loc)],
    type: DYN,
    loc,
  };
}

/** A static import's load: `nodeIsland.defer(path, snapshot)`, which the
 * build decides after lowering (node-islands/snapshot.ts, scope-B NI-7):
 * a module proved effect-free at load keeps it with its interface snapshot
 * and evaluates on first use; any other becomes nodeIsland.require.
 *
 * A program module that runs in an island is decided there too, under a
 * stricter rule: the build evaluates the program's own source only when
 * the static gate proves its top level free of effects. */
function deferIslandModule(lowerer: Lowerer, path: string, loc: SrcLoc): IrExpr {
  return {
    kind: "libCall",
    fn: "nodeIsland.defer",
    args: [islandLoadPath(lowerer, path, loc), { kind: "strLit", value: "", type: STRING, loc }],
    type: DYN,
    loc,
  };
}

/** Whether `node` runs while its module evaluates: no enclosing function,
 * method, accessor, constructor or class member initializer. */
function runsAtModuleEvaluation(node: ts.Node): boolean {
  for (let n = node.parent; n !== undefined; n = n.parent) {
    if (ts.isSourceFile(n)) return true;
    if (ts.isFunctionLike(n) || ts.isClassStaticBlockDeclaration(n) || ts.isPropertyDeclaration(n))
      return false;
  }
  return false;
}

/** The %init statements that run in `stmt`'s place in its file's %init
 * header (Lowerer.islandImportActions). */
function islandStatementActions(lowerer: Lowerer, sf: ts.SourceFile, stmt: ts.Statement): IrStmt[] {
  let byStatement = lowerer.islandImportActions.get(sf);
  if (byStatement === undefined) {
    byStatement = new Map();
    lowerer.islandImportActions.set(sf, byStatement);
  }
  let actions = byStatement.get(stmt);
  if (actions === undefined) {
    actions = [];
    byStatement.set(stmt, actions);
  }
  return actions;
}

/** A static import (or re-export) of an island package: loads the module
 * in the importer's %init header, in the statement's place among the
 * dependencies' %init calls, as Node evaluates it in source order. Returns
 * false when `spec` is not an island module. */
export function collectIslandImport(
  lowerer: Lowerer,
  sf: ts.SourceFile,
  stmt: ts.Statement,
  spec: string,
): boolean {
  const islands = lowerer.nodeIslands;
  if (islands === null) return false;
  const path = islandModuleFile(islands, sf.fileName, spec, "import");
  if (path === null) return false;
  lowerer.noteIslandOnWorkerThread(spec, stmt);
  if (ts.isExportDeclaration(stmt)) {
    // `export { Type } from "typebox"`: the re-exporting module loads the
    // island module and every name it re-exports binds the island's own
    // export, so importers of this module reach it through the alias chain
    // (islandBindingOf). A namespace or star re-export has no name to bind.
    const clause = stmt.exportClause;
    if (stmt.isTypeOnly || clause === undefined || !ts.isNamedExports(clause)) {
      lowerer.pushDiag(
        nodeIslandBoundaryDiag(`re-exporting the Node island module '${spec}'`, locOf(stmt)),
      );
      return true;
    }
    lowerer.noteNodeIslandUse(sf.fileName, `the island module '${spec}'`);
    const exportLoc = locOf(stmt);
    const exported = islandModuleGlobal(lowerer, path);
    const initActions = islandStatementActions(lowerer, sf, stmt);
    initActions.push({
      kind: "assign",
      localId: exported.global.id,
      value: deferIslandModule(lowerer, path, exportLoc),
      loc: exportLoc,
    });
    for (const el of clause.elements.nodes) {
      if (el.isTypeOnly) continue;
      const name = el.propertyName?.text ?? el.name.text;
      // CommonJS named exports are the namespace's snapshot (below).
      if (!exported.esm && name !== "default")
        initActions.push(islandSnapshotAssign(lowerer, exported, name, exportLoc));
      registerIslandReexport(
        lowerer,
        stmt,
        el,
        name === "default"
          ? { kind: "default", module: exported }
          : { kind: "named", module: exported, name },
      );
    }
    return true;
  }
  lowerer.noteNodeIslandUse(sf.fileName, `the island module '${spec}'`);
  const loc = locOf(stmt);
  const binding = islandModuleGlobal(lowerer, path);
  const actions = islandStatementActions(lowerer, sf, stmt);
  actions.push({
    kind: "assign",
    localId: binding.global.id,
    value: deferIslandModule(lowerer, path, loc),
    loc,
  });
  // CommonJS named imports: Node's namespace snapshots them once the
  // module evaluated.
  const clause = ts.isImportDeclaration(stmt) ? stmt.importClause : undefined;
  const named = clause?.namedBindings;
  const snapshotNames: string[] = [];
  if (!binding.esm && named !== undefined && ts.isNamedImports(named)) {
    for (const el of named.elements.nodes) {
      if (el.isTypeOnly) continue;
      snapshotNames.push(el.propertyName?.text ?? el.name.text);
    }
  }
  // A CommonJS namespace import's members are the same snapshot: the
  // members the file reads (`ns.name`).
  if (!binding.esm && named !== undefined && ts.isNamespaceImport(named)) {
    const nsSymbol = lowerer.checker.getSymbolAtLocation(named.name);
    ts.walkPreorder(sf, (node) => {
      if (
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        ts.isIdentifier(node.name) &&
        node.expression.text === named.name.text &&
        lowerer.checker.getSymbolAtLocation(node.expression) === nsSymbol &&
        !snapshotNames.includes(node.name.text)
      )
        snapshotNames.push(node.name.text);
      return undefined;
    });
  }
  for (const name of snapshotNames) {
    if (name === "default") continue;
    actions.push(islandSnapshotAssign(lowerer, binding, name, loc));
  }
  return true;
}

/** A CommonJS island name's snapshot global and the %init action that
 * assigns it once the module evaluated (Node's namespace snapshots named
 * exports). */
function islandSnapshotAssign(
  lowerer: Lowerer,
  binding: IslandModuleBinding,
  name: string,
  loc: SrcLoc,
): IrStmt {
  let g = binding.snapshots.get(name);
  if (g === undefined) {
    g = { id: `%g.island.${lowerer.globalsList.length}`, name, type: DYN, mutable: true };
    lowerer.globalsList.push(g);
    binding.snapshots.set(name, g);
  }
  return {
    kind: "assign",
    localId: g.id,
    value: islandGet(varRef(binding.global.id, DYN, loc), name, loc),
    loc,
  };
}

export function islandGet(target: IrExpr, key: string, loc: SrcLoc): IrExpr {
  return {
    kind: "libCall",
    fn: "nodeIsland.get",
    args: [target, { kind: "strLit", value: key, type: STRING, loc }],
    type: DYN,
    loc,
  };
}

export type IslandBinding =
  | { kind: "required"; module: IslandModuleBinding }
  | { kind: "namespace"; module: IslandModuleBinding }
  | { kind: "default"; module: IslandModuleBinding }
  | { kind: "named"; module: IslandModuleBinding; name: string };

/** Records that `specifier`'s exported name binds `binding`: importers of
 * the re-exporting module reach the island's own export through the alias
 * chain, whatever they spell it (`export { Num as NumberSchema }`). The
 * island's export symbol is the key a chain ends on, so it is registered
 * beside the specifier's own symbol. */
function registerIslandReexport(
  lowerer: Lowerer,
  stmt: ts.ExportDeclaration,
  specifier: ts.ExportSpecifier,
  binding: IslandBinding,
): void {
  const named = lowerer.checker.getSymbolAtLocation(specifier.name);
  if (named !== undefined) lowerer.islandReexports.set(named, binding);
  const moduleSpecifier = stmt.moduleSpecifier;
  if (moduleSpecifier === undefined) return;
  const moduleSymbol = lowerer.checker.getSymbolAtLocation(moduleSpecifier);
  if (moduleSymbol === undefined) return;
  const exported = lowerer.checker.getExportsOfModule(moduleSymbol);
  const found = exported.find(
    (s) => ts.symbolName(s) === (specifier.propertyName?.text ?? specifier.name.text),
  );
  if (found === undefined) return;
  lowerer.islandReexports.set(found, binding);
  if ((found.flags & ts.SymbolFlags.Alias) !== 0)
    lowerer.islandReexports.set(lowerer.checker.getAliasedSymbol(found), binding);
}

/** The island binding an alias chain reaches, or null. The chain is walked
 * one declaration at a time and ends on a name a native module re-exports
 * from an island package (`export { a } from "pkg"`, registered when the
 * module was collected) or on a binding a native module imported from one
 * and passes on (`import { a } from "pkg"; export { a };`, `export default
 * a`): its importers bind the island's own export, whatever they call it.
 * The answer depends only on the program's declarations and on the island
 * modules the collection found, so it is kept per symbol for as long as
 * that collection stands. */
function islandReexportOf(lowerer: Lowerer, symbol: ts.Symbol | undefined): IslandBinding | null {
  if (symbol === undefined) return null;
  const memo = lowerer.islandAliasBindings;
  const collected = lowerer.islandModules.size + lowerer.islandReexports.size;
  if (memo.collected !== collected) {
    memo.collected = collected;
    memo.bySymbol.clear();
  }
  const known = memo.bySymbol.get(symbol);
  if (known !== undefined) return known;
  let found: IslandBinding | null = null;
  const seen = new Set<ts.Symbol>();
  let s: ts.Symbol | undefined = symbol;
  while (s !== undefined && !seen.has(s)) {
    seen.add(s);
    const bound = lowerer.islandReexports.get(s);
    if (bound !== undefined) {
      found = bound;
      break;
    }
    if ((s.flags & ts.SymbolFlags.Alias) === 0) break;
    if (s !== symbol) {
      const passedOn = islandImportOf(lowerer, s);
      if (passedOn !== null) {
        found = passedOn;
        break;
      }
    }
    s = lowerer.checker.getImmediateAliasedSymbol(s);
  }
  memo.bySymbol.set(symbol, found);
  return found;
}

/** The binding of a symbol that is itself an import of an island module
 * (a named, default or namespace import, or a `require` binding), or null. */
function islandImportOf(lowerer: Lowerer, symbol: ts.Symbol | undefined): IslandBinding | null {
  const islands = lowerer.nodeIslands;
  if (islands === null) return null;
  const site = islandImportSite(lowerer.checker, islands, symbol);
  if (site === null) return null;
  const module = lowerer.islandModules.get(site.path);
  if (module === undefined) return null;
  if (site.form === "required") return { kind: "required", module };
  if (site.form === "namespace") return { kind: "namespace", module };
  if (site.form === "default") return { kind: "default", module };
  return { kind: "named", module, name: site.form.name };
}

function moduleSpecifierOf(decl: ts.Node | undefined): string | null {
  return ts.isImportDeclaration(decl) && ts.isStringLiteral(decl.moduleSpecifier)
    ? decl.moduleSpecifier.text
    : null;
}

/** What an identifier binds from an island module, or null. */
/** Whether `ident` names an import of a Node island module: its value
 * comes from the island, whatever the package's declarations say. */
export function isIslandImportBinding(lowerer: Lowerer, ident: ts.Identifier): boolean {
  return islandBindingOf(lowerer, ident) !== null;
}

/** The symbol an identifier in value position binds. A shorthand property's
 * name (`{ compare }`) reads the binding of that name: the checker answers
 * the property for the name itself. */
function bindingSymbolOf(checker: ts.TypeChecker, ident: ts.Identifier): ts.Symbol | undefined {
  const shorthand =
    ident.parent !== undefined &&
    ts.isShorthandPropertyAssignment(ident.parent) &&
    ident.parent.name === ident
      ? checker.getShorthandAssignmentValueSymbol(ident.parent)
      : undefined;
  return shorthand ?? checker.getSymbolAtLocation(ident);
}

/** What a binding's declaration takes from an island module: the module's
 * file and the form of the binding. */
interface IslandImportSite {
  path: string;
  form: "required" | "namespace" | "default" | { name: string };
}

/** The island module a binding's own declaration names, or null: an import
 * (default, named or namespace) or a `require` of one. A pure function of
 * the checker and the island set, so the class protocol index can ask it
 * before any module is lowered; islandBindingOf answers for the modules a
 * lowering loaded. */
function islandImportSite(
  checker: ts.TypeChecker,
  islands: NodeIslandSet,
  symbol: ts.Symbol | undefined,
): IslandImportSite | null {
  const decl = symbol ? symbol.declarations[0] : undefined;
  if (decl === undefined) return null;
  let importDecl: ts.Node | undefined;
  let form: IslandImportSite["form"];
  if (ts.isNamespaceImport(decl)) {
    importDecl = decl.parent?.parent;
    form = "namespace";
  } else if (ts.isImportClause(decl)) {
    importDecl = decl.parent;
    form = "default";
  } else if (ts.isImportSpecifier(decl)) {
    importDecl = decl.parent?.parent?.parent;
    const name = decl.propertyName?.text ?? decl.name.text;
    form = name === "default" ? "default" : { name };
  } else {
    // `const { name } = require("pkg")`: a member of module.exports, read
    // at each use (shortcut: not copied once at the declaration).
    const property = requiredPropertyOf(decl);
    if (property !== null && loadsAtStatement(property.declaration)) {
      const spec = requireInitSpecOf(checker, property.declaration);
      if (spec === null) return null;
      const file = ts.getSourceFileOfNode(decl).fileName;
      const path = islandModuleFile(islands, file, spec, "require");
      if (path === null || !keepsRequiredModule(islands, checker, property.declaration))
        return null;
      return { path, form: { name: property.name } };
    }
    // `const x = require("pkg")` (a CommonJS module of a native package
    // requiring an island package): x is module.exports. Only at the
    // module's top level: a function's own binding is a local.
    const statement = decl.parent?.parent;
    if (statement === undefined || !ts.isSourceFile(statement.parent)) return null;
    if (!ts.isVariableDeclaration(decl)) return null;
    const spec = requireSpecOf(checker, decl);
    if (spec === null) return null;
    const path = islandModuleFile(islands, ts.getSourceFileOfNode(decl).fileName, spec, "require");
    if (path === null || !keepsRequiredModule(islands, checker, decl)) return null;
    return { path, form: "required" };
  }
  const spec = moduleSpecifierOf(importDecl);
  if (spec === null || importDecl === undefined) return null;
  const path = islandModuleFile(
    islands,
    ts.getSourceFileOfNode(importDecl).fileName,
    spec,
    "import",
  );
  return path === null ? null : { path, form };
}

/** Whether `ident` binds a value an island module exports, by its
 * declaration alone: an import or a `require` of an island module, or a
 * name a native module re-exports from one (the alias chain ends at a
 * declaration the island owns). This is the origin the class protocol index
 * marks received types by (class-protocols.ts, markIslandView): the value
 * comes out of the island whatever type the program names for it. */
export function bindsIslandExport(
  checker: ts.TypeChecker,
  islands: NodeIslandSet,
  ident: ts.Identifier,
): boolean {
  const symbol = bindingSymbolOf(checker, ident);
  if (symbol === undefined) return false;
  if (islandImportSite(checker, islands, symbol) !== null) return true;
  if ((symbol.flags & ts.SymbolFlags.Alias) === 0) return false;
  const target = checker.getAliasedSymbol(symbol);
  return target !== symbol && isIslandDeclared(islands, target);
}

export function islandBindingOf(lowerer: Lowerer, ident: ts.Identifier): IslandBinding | null {
  const islands = lowerer.nodeIslands;
  if (islands === null) return null;
  const symbol = bindingSymbolOf(lowerer.checker, ident);
  const imported = islandImportOf(lowerer, symbol);
  if (imported !== null) return imported;
  return islandReexportOf(lowerer, symbol);
}

/** The raw (dyn) value an island import binding reads. */
function islandBindingValue(
  lowerer: Lowerer,
  b: IslandBinding,
  node: ts.Node,
  loc: SrcLoc,
): IrExpr {
  const ns = varRef(b.module.global.id, DYN, loc);
  switch (b.kind) {
    case "required":
      return ns;
    case "namespace":
      if (!b.module.esm)
        boundaryFail(lowerer, "the namespace object of a CommonJS island module as a value", node);
      return ns;
    case "default":
      return b.module.esm ? islandGet(ns, "default", loc) : ns;
    case "named": {
      if (b.module.esm) return islandGet(ns, b.name, loc);
      const g = b.module.snapshots.get(b.name);
      return g === undefined ? islandGet(ns, b.name, loc) : varRef(g.id, DYN, loc);
    }
  }
}

/* The island read whose value `islandUnitComparison` wants as the island
 * answered it, before it meets its declared type. Set for one synchronous
 * lowering of that node. */
let rawIslandRead: ts.Node | null = null;

/** `null` or the global `undefined`, by name. */
function unitLiteralOf(lowerer: Lowerer, node: ts.Expression): "null" | "undefined" | null {
  const inner = withoutParenthesesTypeWrappers(node);
  if (inner.kind === ts.SyntaxKind.NullKeyword) return "null";
  if (!ts.isIdentifier(inner) || inner.text !== "undefined") return null;
  return (lowerer.typeOf(inner).flags & ts.TypeFlags.Undefined) !== 0 ? "undefined" : null;
}

/** `read === undefined`, `read !== null`, `read == null`, `read != null`
 * where `read` is a member read, an index or a call on an island value: the
 * value the island answered decides, before it meets the declared type. A
 * missing key or index reads undefined whatever the declaration says
 * (TypeScript types `table[key]` and `list[i]` as the value type), and the
 * native unit comparison folds an operand whose type has no such arm to a
 * constant, so `table[key] === undefined` answered false for a key the
 * island does not have. */
function islandUnitComparison(
  lowerer: Lowerer,
  expr: ts.BinaryExpression,
  loc: SrcLoc,
): IrExpr | null {
  const op = expr.operatorToken.kind;
  const strict =
    op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    op === ts.SyntaxKind.ExclamationEqualsEqualsToken;
  const loose =
    op === ts.SyntaxKind.EqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken;
  if (!strict && !loose) return null;
  const leftUnit = unitLiteralOf(lowerer, expr.left);
  const rightUnit = unitLiteralOf(lowerer, expr.right);
  if ((leftUnit === null) === (rightUnit === null)) return null;
  const unit = leftUnit ?? rightUnit!;
  const read = withoutParenthesesTypeWrappers(leftUnit === null ? expr.left : expr.right);
  if (
    !ts.isPropertyAccessExpression(read) &&
    !ts.isElementAccessExpression(read) &&
    !ts.isCallExpression(read)
  )
    return null;
  if (!islandRooted(lowerer, read)) return null;
  const saved = rawIslandRead;
  rawIslandRead = read;
  let raw: IrExpr | null;
  try {
    raw = lowerIslandExpr(lowerer, read);
  } finally {
    rawIslandRead = saved;
  }
  // A form that did not end in the read itself (an optional chain, an
  // awaited load) keeps the ordinary comparison.
  if (raw === null || raw.type.kind !== "dyn") return null;
  lowerer.usesNodeIsland = true;
  const negated =
    op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
    op === ts.SyntaxKind.ExclamationEqualsToken;
  const dynNull: IrExpr = {
    kind: "dynFrom",
    value: { kind: "unitLit", unit: "null", type: NULL_T, loc },
    type: DYN,
    loc,
  };
  const equals = (value: IrExpr, which: "null" | "undefined", not: boolean): IrExpr => ({
    kind: "dynScalarEq",
    left: value,
    right: which === "null" ? dynNull : dynUndefinedExpr(loc),
    ...(not ? { negated: true as const } : {}),
    type: BOOL,
    loc,
  });
  if (strict) return equals(raw, unit, negated);
  // `== null` holds for both units: the read is evaluated once.
  const held = lowerer.declareHiddenLocal("%islandUnit", DYN);
  const ref = varRef(held.id, DYN, loc);
  return {
    kind: "seqExpr",
    stmts: [{ kind: "varDecl", localId: held.id, init: raw, loc }],
    result: {
      kind: "logical",
      op: negated ? "&&" : "||",
      left: equals(ref, "null", negated),
      right: equals(ref, "undefined", negated),
      type: BOOL,
      loc,
    },
    type: BOOL,
    loc,
  };
}

/** An island value (dyn) at the declared type of `node`: island handles
 * stay dyn (FOREIGN), primitives and strings meet their declared type
 * through the checked conversion. A coverage analysis also records the
 * package declaration that types the value, for the type-claims report
 * (type-claims.ts); the lowered code is the same either way. */
export function fromIsland(lowerer: Lowerer, raw: IrExpr, node: ts.Expression): IrExpr {
  const out = islandValueAt(lowerer, raw, node);
  if (lowerer.typeClaims) noteIslandClaim(lowerer, out, node, node);
  // The conversion names the declaration that types the value, so its
  // TypeError carries the type patch that would admit it (decl-origin.ts).
  // A declaration no selector reaches (an empty patch range) is left out,
  // as every generic declaration is.
  if (out.kind !== "dynCheck" || out.origin !== undefined || out === raw) return out;
  const origin = islandOriginOf(lowerer, node, node);
  if (origin === null || origin.split(ORIGIN_SEPARATOR)[2] === "") return out;
  return { ...out, origin: lowerer.declOriginIndex(origin) };
}

function islandOriginOf(
  lowerer: Lowerer,
  declaredBy: ts.Node,
  typed: ts.Expression,
  argument?: number,
): string | null {
  try {
    return islandValueOrigin(
      lowerer.checker,
      declaredBy,
      lowerer.typeOf(typed),
      (file) => lowerer.program.isSourceFileDefaultLibrary(file),
      argument,
    );
  } catch {
    return null;
  }
}

/** Coverage's type claims: `value` is an island's, or a function an island
 * calls, typed by the declaration of `declaredBy` (type-claims.ts). */
function noteIslandClaim(
  lowerer: Lowerer,
  value: IrExpr,
  declaredBy: ts.Node,
  typed: ts.Expression,
  argument?: number,
): void {
  const key = claimKey(value.loc);
  if (lowerer.islandClaimOrigins.has(key)) return;
  lowerer.islandClaimOrigins.set(key, islandOriginOf(lowerer, declaredBy, typed, argument) ?? "");
}

function islandValueAt(lowerer: Lowerer, raw: IrExpr, node: ts.Expression): IrExpr {
  if (node === rawIslandRead) return raw;
  const tsType = lowerer.typeOf(node);
  const islands = lowerer.nodeIslands!;
  if (isForeignType(islands, tsType, lowerer.checker)) return raw;
  if ((tsType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) return raw;
  // A conversion whose value nobody reads is never a copy the program can
  // observe: `obj.k = v;` and `void obj.k` (the read itself stays in raw).
  if (isDiscarded(node)) return raw;
  const mapped = lowerer.mapTypeOf(tsType);
  if (mapped === null) {
    // An object whose type has no native representation and that the island
    // does not declare: an intersection of containers (`Choice[] &
    // GenChoice[]`: the island's array extended by the caller's own type),
    // or an interface with methods that the project declares for the
    // island's module and its own code alike (a global interface in the
    // project's .d.ts, named by its `declare module` block). Where the
    // program only uses it through island operations it stays a handle,
    // like an array the island does not declare.
    if (unrepresentedObjectType(lowerer, tsType) && handleUseOk(lowerer, node)) return raw;
    // A function the island declares through a types-only package
    // (`express.json(): NextHandleFunction`): the value is a function object
    // the island made, with no native representation, and the program
    // reaches it through the island (it passes it back, or calls it through
    // the bridge), so it stays the handle of that function.
    if (callableType(lowerer, tsType)) return raw;
    // No native representation, and none is asked for.
    if (onlyTested(lowerer, node) || untypedSlot(lowerer, node)) return raw;
    boundaryFail(
      lowerer,
      `an island value of type '${lowerer.checker.typeToString(tsType)}'`,
      node,
    );
  }
  if (mapped.kind === "void") return raw;
  // A test, a `typeof` or a comparison with a primitive reads nothing a
  // conversion would produce: an object (or a union with an object arm)
  // stays the island's value there, so no copy, adoption or member check
  // runs for it. A primitive keeps its checked copy, so a test of a typed
  // primitive compiles as it always has.
  if (!copiedType(lowerer, mapped) && onlyTested(lowerer, node)) return raw;
  if (mapped.kind === "dyn") {
    refuseUnreceivableMember(lowerer, tsType, node);
    return raw;
  }
  // A timer the island created stays the island's Timeout or Immediate (the
  // program's own handles are numbers): the program clears it, calls its
  // methods and passes it back through the handle.
  if (islandTimerType(lowerer, tsType)) {
    if (handleUseOk(lowerer, node)) return raw;
    boundaryFail(
      lowerer,
      `an island value of type '${lowerer.checker.typeToString(tsType)}' used as a native value (a timer created by island code stays the island's object: keep it in a const, clear it, call its methods or pass it back to the island)`,
      node,
    );
  }
  // An island promise is the same promise on both sides (the runtime keeps
  // one ScrPromise per V8 promise): PromiseResolve of the dyn value, whose
  // settlement value meets the declared type when it is awaited.
  if (
    mapped.kind === "promise" &&
    (mapped.inner.kind === "dyn" || copiedType(lowerer, mapped.inner))
  ) {
    // The value that crosses is the one the promise settles with.
    if (mapped.inner.kind === "dyn")
      refuseUnreceivableMember(lowerer, lowerer.checker.getAwaitedType(tsType) ?? tsType, node);
    const promise: IrExpr = {
      kind: "libCall",
      fn: "dyn.promiseResolve",
      args: [raw, thenReader(lowerer, raw.loc)],
      type: { kind: "promise", inner: DYN },
      loc: raw.loc,
    };
    return mapped.inner.kind === "dyn" ? promise : lowerer.coerceToExpected(promise, mapped);
  }
  // Arrays of copied values (or arrays of those) cross as copies of the
  // island array as an awaited promise's value, and directly where they do
  // not stay handles (below); the checked cast then meets the copy. A
  // native array that crossed in comes back as itself.
  if (mapped.kind === "promise" && copiedArrayType(lowerer, mapped.inner)) {
    const promise: IrExpr = {
      kind: "libCall",
      fn: "nodeIsland.awaitCopy",
      args: [raw],
      type: { kind: "promise", inner: DYN },
      loc: raw.loc,
    };
    return lowerer.coerceToExpected(promise, mapped);
  }
  // NI-5: a native value the program passed in comes back as itself (an
  // export); the checked cast unboxes it, and anything else fails the cast
  // (types don't lie).
  // An array, tuple, Map or Set the island does not declare stays a handle
  // where the program only uses it through island operations (a native
  // array that crossed in and came back answers them too: member
  // operations follow the value).
  if (!copiedType(lowerer, mapped) && containerType(lowerer, tsType) && handleUseOk(lowerer, node))
    return raw;
  // Otherwise an array of copied values is a copy (above).
  if (copyableArrayType(lowerer, mapped)) {
    const copy: IrExpr = {
      kind: "libCall",
      fn: "nodeIsland.copyArrays",
      args: [raw],
      type: DYN,
      loc: raw.loc,
    };
    return lowerer.coerceToExpected(copy, mapped);
  }
  // An island object whose declared type is a program record is a deep
  // checked copy, so identity and the island's later changes are lost (K1).
  // The copy is never implicit: the program states it with structuredClone,
  // keeps the value a handle by declaring the island's type (or unknown/any),
  // or gets SC8010 (SPEC 1b = B). Promises, class instances and closures
  // meet their declared type exactly (an adoption or an unboxing of the same
  // native value) and cross here as they always have.
  if (!copiedType(lowerer, mapped) && copiedRecordType(lowerer, tsType)) {
    if (recordConversion(lowerer, mapped) && !isStructuredCloneArgument(lowerer, node))
      boundaryFail(
        lowerer,
        `an island object typed as the program record '${lowerer.checker.typeToString(tsType)}' (keep the handle by declaring the island's type or 'unknown'/'any', or copy it explicitly with 'structuredClone(v)')`,
        node,
      );
    return lowerer.coerceToExpected(raw, mapped);
  }
  if (!copiedType(lowerer, mapped))
    boundaryFail(
      lowerer,
      `an island value of type '${lowerer.checker.typeToString(tsType)}' (only primitives and strings are copied; objects of types the island does not declare stay handles from NI-5 on)`,
      node,
    );
  return lowerer.coerceToExpected(raw, mapped);
}

/** Whether the program only tests the island value at `node`: its
 * truthiness (a condition, the operand of `!`, an operand of `&&` or `||`
 * that is itself only tested), its `typeof`, or its strict equality with a
 * primitive. JavaScript answers each of those from the value the island
 * handed out, whatever its declarations say, and none looks inside the
 * value, so it stays the island's and no conversion runs: a type with no
 * native representation, or one whose conversion is a copy or a member
 * check, is no obstacle to a test. Every other use meets the declared type. */
function onlyTested(lowerer: Lowerer, node: ts.Expression): boolean {
  let n: ts.Node = node;
  for (;;) {
    const p = n.parent;
    if (p === undefined) return false;
    if (ts.isParenthesizedExpression(p) || ts.isNonNullExpression(p)) {
      n = p;
      continue;
    }
    if (ts.isPrefixUnaryExpression(p)) return p.operator === ts.SyntaxKind.ExclamationToken;
    if (ts.isTypeOfExpression(p)) return true;
    if (ts.isIfStatement(p) || ts.isWhileStatement(p) || ts.isDoStatement(p))
      return p.expression === n;
    if (ts.isForStatement(p)) return p.condition === n;
    if (ts.isConditionalExpression(p)) return p.condition === n;
    if (ts.isBinaryExpression(p)) {
      const op = p.operatorToken.kind;
      if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) {
        n = p;
        continue;
      }
      if (
        op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsEqualsToken
      )
        return primitiveOperand(lowerer, p.left === n ? p.right : p.left);
      return false;
    }
    return false;
  }
}

/** Whether the island value at `node` goes into an untyped slot: the type
 * an assertion gives it (`v as unknown`; `v as unknown as T` is a `T`),
 * else the context's, is `unknown` or `any`. Untyped code takes the
 * island's value as it is. */
function untypedSlot(lowerer: Lowerer, node: ts.Expression): boolean {
  let outer: ts.Node = node;
  let asserted = false;
  for (;;) {
    const p = outer.parent;
    if (p === undefined) break;
    if (ts.isAsExpression(p) || ts.isTypeAssertion(p)) asserted = true;
    else if (
      !ts.isParenthesizedExpression(p) &&
      !ts.isNonNullExpression(p) &&
      !ts.isSatisfiesExpression(p)
    )
      break;
    outer = p;
  }
  const slot = asserted
    ? lowerer.typeOf(outer as ts.Expression)
    : lowerer.checker.getContextualType(outer as ts.Expression);
  return slot !== undefined && (slot.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
}

/** Whether every value of `node`'s type is a string, a number, a boolean,
 * a bigint, null or undefined: strict equality with one compares by value
 * and never looks inside the other operand. */
function primitiveOperand(lowerer: Lowerer, node: ts.Expression): boolean {
  const primitive =
    ts.TypeFlags.StringLike |
    ts.TypeFlags.NumberLike |
    ts.TypeFlags.BooleanLike |
    ts.TypeFlags.BigIntLike |
    ts.TypeFlags.Null |
    ts.TypeFlags.Undefined;
  const type = lowerer.typeOf(node);
  const parts = type.isUnionType() ? ts.constituentTypes(type) : [type];
  return parts.every((part) => (part.flags & primitive) !== 0);
}

/** Refuses (SC8010) an island object received by the live view `type`
 * when a member it can be read through cannot hold what the island put
 * there. A program type that receives island values is a checked-identity
 * view (wave-2 6 = C): the value stays the island's object, and every member
 * read is a checked conversion into the member's native type. Primitives,
 * byte views, functions, promises and other views meet that conversion; an
 * island array, tuple, Map, Set or library object (a Date, a RegExp, an
 * Error) never does, because its native counterpart is a different object,
 * so the read would throw a TypeError in a program whose types are true.
 * The crossing is where the island value takes the program's type, so that
 * is where the member is named. */
function refuseUnreceivableMember(lowerer: Lowerer, type: ts.Type, node: ts.Expression): void {
  const found = unreceivableMember(lowerer, type, "", new Set());
  if (found === null) return;
  boundaryFail(
    lowerer,
    `an island object typed as the program record '${lowerer.checker.typeToString(type)}', whose member '${found.path}' is declared '${lowerer.checker.typeToString(found.type)}' (an island array, tuple, Map, Set or library object has no native counterpart yet; declare the member with the island's type or 'unknown')`,
    node,
  );
}

/** How many member visits the walk below follows before it stops. A type can
 * name itself with an instantiation that grows at every level (`Chain<T>`
 * whose member is declared `Chain<T[]>`): those are distinct types on every
 * visit, so `seen` never repeats one, and a program's own record has no end
 * to its member paths. A real view nests a few levels deep, so the walk ends
 * well past any of them. */
const MAX_VIEW_DEPTH = 32;

/** The first member of the live view `type`, or of a view one of its
 * members is declared with, that an island value cannot be read into
 * (refuseUnreceivableMember); null when there is none, and for a type that
 * is not such a view (`object`, an island-declared type). `seen` ends a
 * type that names itself, and `depth` a type that names itself with a
 * growing instantiation. */
function unreceivableMember(
  lowerer: Lowerer,
  type: ts.Type,
  path: string,
  seen: Set<ts.Type>,
  depth = 0,
): { path: string; type: ts.Type } | null {
  if (depth > MAX_VIEW_DEPTH) return null;
  if (type.isUnionType()) {
    for (const part of ts.constituentTypes(type)) {
      const found = unreceivableMember(lowerer, part, path, seen, depth);
      if (found !== null) return found;
    }
    return null;
  }
  if ((type.flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection)) === 0) return null;
  if (isForeignType(lowerer.nodeIslands!, type, lowerer.checker)) return null;
  if (!lowerer.classImplementedProtocol(type)) return null;
  if (seen.has(type)) return null;
  seen.add(type);
  const member = (name: string, declared: ts.Type): { path: string; type: ts.Type } | null =>
    unreceivableValue(lowerer, declared, path === "" ? name : `${path}.${name}`, seen, depth + 1);
  for (const property of lowerer.checker.getPropertiesOfType(type)) {
    const name = ts.symbolName(property);
    // A symbol-keyed member is read through the object's own descriptor.
    if (name.startsWith("__@")) continue;
    const found = member(name, lowerer.checker.getTypeOfSymbol(property));
    if (found !== null) return found;
  }
  for (const index of lowerer.checker.getIndexInfosOfType(type)) {
    const found = member("[key]", index.type);
    if (found !== null) return found;
  }
  return null;
}

/** unreceivableMember for the value a member (or a promise) holds: the
 * part of `declared` whose native representation an island value never
 * meets, at `path`. `depth` bounds a type that names itself with a growing
 * instantiation. */
function unreceivableValue(
  lowerer: Lowerer,
  declared: ts.Type,
  path: string,
  seen: Set<ts.Type>,
  depth = 0,
): { path: string; type: ts.Type } | null {
  if (depth > MAX_VIEW_DEPTH) return null;
  if (declared.isUnionType()) {
    for (const part of ts.constituentTypes(declared)) {
      const found = unreceivableValue(lowerer, part, path, seen, depth);
      if (found !== null) return found;
    }
    return null;
  }
  // Primitives are copied; `any`, `unknown` and `object` hold the handle.
  if ((declared.flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection)) === 0) return null;
  if (isForeignType(lowerer.nodeIslands!, declared, lowerer.checker)) return null;
  const mapped = lowerer.mapTypeOf(declared);
  // A member with no native representation is refused where it is read.
  if (mapped === null || mapped.kind === "void") return null;
  // Another view (the marking follows members), or a value that stays
  // checked-dynamic for a reason of its own.
  if (mapped.kind === "dyn") return unreceivableMember(lowerer, declared, path, seen, depth + 1);
  // Byte views share their memory, and an island function is called through
  // the bridge behind a native closure.
  if (copiedType(lowerer, mapped) || mapped.kind === "func") return null;
  // An island promise is adopted; what it settles with is received in turn.
  if (mapped.kind === "promise") {
    const settled = lowerer.checker.getAwaitedType(declared);
    if (settled === undefined || settled === declared) return null;
    return unreceivableValue(lowerer, settled, path, seen, depth + 1) === null
      ? null
      : { path, type: declared };
  }
  // A program class instance is the program's own object: an island can
  // only hand back one it was given, which the checked conversion unboxes.
  if (mapped.kind === "object" && programClassInstance(declared)) return null;
  return { path, type: declared };
}

/** An instance of a class the program declares. */
function programClassInstance(type: ts.Type): boolean {
  const symbol = type.getSymbol();
  return (
    symbol !== undefined &&
    (symbol.flags & ts.SymbolFlags.Class) !== 0 &&
    symbol.declarations.some((d) => !ts.getSourceFileOfNode(d).isDeclarationFile)
  );
}

/** An array whose elements are copied values or such arrays. */
function copiedArrayType(lowerer: Lowerer, t: IrType): boolean {
  if (t.kind !== "array") return false;
  return copiedType(lowerer, t.elem) || copiedArrayType(lowerer, t.elem);
}

/** An array of copied values, or a union of one with null and/or
 * undefined (`string[] | undefined`): the copy converts whatever the
 * island value holds (a non-array crosses as itself, so a nullish value
 * stays nullish) and the checked conversion throws on an element of the
 * wrong type. */
function copyableArrayType(lowerer: Lowerer, t: IrType): boolean {
  if (t.kind !== "union") return copiedArrayType(lowerer, t);
  const def = lowerer.unions.get(t.unionId);
  if (def === undefined) return false;
  let arrays = 0;
  for (const arm of def.arms) {
    if (arm.kind === "nullT" || arm.kind === "undefinedT") continue;
    if (!copiedArrayType(lowerer, arm)) return false;
    arrays++;
  }
  return arrays > 0;
}

/** The IR type an island value crosses as when it is a copyable array
 * (`copyableArrayType`), or null when the declared type is not one. */
function copyableCrossing(lowerer: Lowerer, node: ts.Expression): IrType | null {
  const mapped = lowerer.mapTypeOf(lowerer.typeOf(node));
  return mapped !== null && copyableArrayType(lowerer, mapped) ? mapped : null;
}

/** Whether a value of IR type `t` is copied at the boundary: primitives,
 * strings, null/undefined, and unions of those. */
function copiedType(lowerer: Lowerer, t: IrType): boolean {
  switch (t.kind) {
    case "f64":
    case "string":
    case "bool":
    case "bigint":
    case "nullT":
    case "undefinedT":
    // A symbol is the symbol the runtime pairs with the island's.
    case "symbol":
    // Buffers and typed arrays share their memory with the V8 view, and
    // the runtime keeps one view object per island view.
    case "bytes":
      return true;
    case "union": {
      const def = lowerer.unions.get(t.unionId);
      return def !== undefined && def.arms.every((a) => copiedType(lowerer, a));
    }
    default:
      return false;
  }
}

function isDiscarded(node: ts.Node): boolean {
  let n: ts.Node = node;
  while (n.parent && ts.isParenthesizedExpression(n.parent)) n = n.parent;
  return (
    n.parent !== undefined && (ts.isExpressionStatement(n.parent) || ts.isVoidExpression(n.parent))
  );
}

/** Whether `node` is the value argument of a `structuredClone` call, the
 * one place an island object may convert into a program record type: the
 * program states the copy there, and it is exact (Node's structuredClone
 * also yields a fresh object nobody else holds). */
function isStructuredCloneArgument(lowerer: Lowerer, node: ts.Node): boolean {
  let n: ts.Node = node;
  for (;;) {
    const parent = n.parent;
    if (parent === undefined) return false;
    if (
      ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isTypeAssertion(parent) ||
      ts.isSatisfiesExpression(parent) ||
      ts.isNonNullExpression(parent)
    ) {
      n = parent;
      continue;
    }
    if (!ts.isCallExpression(parent) || parent.arguments.nodes[0] !== n) return false;
    const callee = parent.expression;
    return (
      ts.isIdentifier(callee) &&
      callee.text === "structuredClone" &&
      lowerer.isStdlibSymbol(lowerer.resolveValueSymbol(callee) ?? undefined)
    );
  }
}

/** Whether `node` evaluates to an island handle (by its declared type) or
 * is an island namespace binding. */
function isForeignExpr(lowerer: Lowerer, node: ts.Expression): boolean {
  const islands = lowerer.nodeIslands;
  if (islands === null) return false;
  const inner = withoutParenthesesTypeWrappers(node);
  // super(...) and super.m(...) of an island subclass lower on their own.
  if (inner.kind === ts.SyntaxKind.SuperKeyword) return false;
  // `this` in an island subclass member (its checker type is the
  // polymorphic `this` type parameter).
  if (inner.kind === ts.SyntaxKind.ThisKeyword && islandSubclassMember(inner) !== null) return true;
  if (ts.isIdentifier(inner) && islandBindingOf(lowerer, inner) !== null) return true;
  if (isIslandPromisifyCall(lowerer, inner)) return true;
  if (ts.isIdentifier(inner)) {
    // `const f = util.promisify(islandFn)`: f is an island function.
    const decl = lowerer.resolveValueSymbol(inner)?.declarations[0];
    if (
      decl !== undefined &&
      ts.isVariableDeclaration(decl) &&
      decl.initializer !== undefined &&
      (ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const) !== 0 &&
      isIslandPromisifyCall(lowerer, withoutParenthesesTypeWrappers(decl.initializer))
    )
      return true;
  }
  if (isForeignType(islands, lowerer.typeOf(inner), lowerer.checker)) return true;
  if (ts.isIdentifier(inner)) return islandHandleBinding(lowerer, inner);
  return isIslandHandleExpr(lowerer, inner);
}

/** Whether `type` is the Timeout or Immediate of the standard library or
 * @types/node (nullish arms aside). A timer island code created is the
 * island's object: the program's own timer handles are numbers, which it is
 * not, so it stays a handle the program clears, calls methods on and passes
 * back. */
function islandTimerType(lowerer: Lowerer, type: ts.Type): boolean {
  if (type.isUnionType()) {
    const parts = ts
      .constituentTypes(type)
      .filter(
        (t) => (t.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)) === 0,
      );
    return parts.length > 0 && parts.every((t) => islandTimerType(lowerer, t));
  }
  const symbol = type.getAliasSymbol() ?? type.getSymbol();
  if (symbol === undefined) return false;
  const name = ts.symbolName(symbol);
  if (name !== "Timeout" && name !== "Immediate") return false;
  return symbol.declarations.some(
    (d) =>
      (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
      lowerer.isStdlibFile(ts.getSourceFileOfNode(d)),
  );
}

/** Whether `callee` names clearTimeout, clearInterval or clearImmediate: the
 * globals or the node:timers functions. Their argument may be an island's
 * timer, which Node's own function clears (lower-timers.ts). */
function isTimerClearCallee(lowerer: Lowerer, callee: ts.Expression): boolean {
  const c = withoutParenthesesTypeWrappers(callee);
  const clear = (name: string): boolean =>
    name === "clearTimeout" || name === "clearInterval" || name === "clearImmediate";
  if (ts.isPropertyAccessExpression(c)) {
    const member = lowerer.builtinMemberOf(c);
    return member !== null && member.module === "timers" && clear(member.member);
  }
  if (!ts.isIdentifier(c)) return false;
  const imported = lowerer.builtinImportOf(c);
  if (imported) return imported.module === "timers" && clear(imported.member);
  if (!clear(c.text)) return false;
  const declarations = lowerer.checker.getSymbolAtLocation(c)?.declarations ?? [];
  return (
    declarations.length > 0 &&
    declarations.every((d) => ts.getSourceFileOfNode(d).isDeclarationFile)
  );
}

/** Whether a value of TypeScript type `type` coming out of an island is
 * an object the island does not declare and the program cannot take by
 * reference natively (arrays, tuples, Maps, Sets, timers): it stays a
 * handle. */
function undeclaredHandleType(lowerer: Lowerer, type: ts.Type): boolean {
  if ((type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) return false;
  if (isForeignType(lowerer.nodeIslands!, type, lowerer.checker)) return false;
  if (islandTimerType(lowerer, type)) return true;
  const mapped = lowerer.mapTypeOf(type);
  // No native representation at all: the island's object is the only one
  // there is. A function object keeps its own rule (fromIsland).
  if (mapped === null)
    return unrepresentedObjectType(lowerer, type) && !callableType(lowerer, type);
  if (mapped.kind === "dyn" || mapped.kind === "void") return false;
  if (mapped.kind === "promise" || copiedType(lowerer, mapped)) return false;
  return containerType(lowerer, type);
}

/** Whether `type`, which has no native representation (its mapping is
 * null), is the type of objects: every part of a union or an intersection
 * that is not null or undefined is an object type. A type parameter, or a
 * type the mapper refuses for another reason, is not. */
function unrepresentedObjectType(lowerer: Lowerer, type: ts.Type): boolean {
  if (containerType(lowerer, type)) return true;
  const parts =
    type.isUnionType() || (type.flags & ts.TypeFlags.Intersection) !== 0
      ? ts.constituentTypes(type)
      : [type];
  let any = false;
  for (const part of parts) {
    if ((part.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0)
      continue;
    if ((part.flags & ts.TypeFlags.Object) === 0) return false;
    any = true;
  }
  return any;
}

/** Builtin classes whose native representation is not a JavaScript object
 * (URLSearchParams, Headers, Request, …): an island instance of one has no
 * native counterpart to convert into, so it stays a handle. */
const BUILTIN_HANDLE_CLASSES: ReadonlySet<string> = new Set([
  "URL",
  "URLSearchParams",
  "Headers",
  "Request",
  "Response",
  "FormData",
  "Blob",
  "File",
  "AbortController",
  "AbortSignal",
  "ReadableStream",
  "WritableStream",
  "TransformStream",
  "TextEncoder",
  "TextDecoder",
]);

/** Whether `type` is one of BUILTIN_HANDLE_CLASSES as declared by the
 * standard library or @types/node (not a program class of the same name). */
function builtinHandleClass(type: ts.Type): boolean {
  const symbol = type.getSymbol();
  if (symbol === undefined || !BUILTIN_HANDLE_CLASSES.has(String(symbol.escapedName))) return false;
  return (
    symbol.declarations.length > 0 &&
    symbol.declarations.every((d) => ts.getSourceFileOfNode(d).isDeclarationFile)
  );
}

/** Arrays, tuples, Maps and Sets (every arm of a union, nullish arms
 * aside), and the builtin classes of builtinHandleClass: the object types
 * an island hands back without declaring them. An intersection of those
 * (`Choice[] & GenChoice[]`) is a container too: it is a value of each. */
function containerType(lowerer: Lowerer, type: ts.Type): boolean {
  if (type.isUnionType())
    return ts
      .constituentTypes(type)
      .every(
        (t) =>
          (t.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0 ||
          containerType(lowerer, t),
      );
  if ((type.flags & ts.TypeFlags.Intersection) !== 0)
    return ts
      .constituentTypes(type)
      .every(
        (t) =>
          (t.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0 ||
          containerType(lowerer, t),
      );
  if ((type.flags & ts.TypeFlags.Object) === 0) return false;
  if (lowerer.checker.isArrayType(type) || lowerer.checker.isTupleType(type)) return true;
  const name = type.getSymbol()?.escapedName;
  return name === "Map" || name === "Set" || builtinHandleClass(type);
}

/** Whether every non-nullish part of `type` is callable or constructible
 * (at least one is): a function object declared by a types-only package —
 * `express.json()` returns body-parser's `NextHandleFunction` — which the
 * type mapper cannot represent natively. */
function callableType(lowerer: Lowerer, type: ts.Type): boolean {
  const parts =
    type.isUnionType() || (type.flags & ts.TypeFlags.Intersection) !== 0
      ? ts.constituentTypes(type)
      : [type];
  let any = false;
  for (const part of parts) {
    if ((part.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0)
      continue;
    if ((part.flags & ts.TypeFlags.Object) === 0) return false;
    if (
      lowerer.checker.getCallSignatures(part).length === 0 &&
      lowerer.checker.getConstructSignatures(part).length === 0
    )
      return false;
    any = true;
  }
  return any;
}

/** A member read, call, index or `new` whose receiver or callee is an
 * island value. */
export function islandRooted(lowerer: Lowerer, node: ts.Expression): boolean {
  const e = withoutParenthesesTypeWrappers(node);
  if (ts.isCallExpression(e)) {
    if (e.expression.kind === ts.SyntaxKind.ImportKeyword) return false;
    const callee = withoutParenthesesTypeWrappers(e.expression);
    if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee))
      return isForeignExpr(lowerer, callee.expression);
    return isForeignExpr(lowerer, callee);
  }
  if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e) || ts.isNewExpression(e))
    return isForeignExpr(lowerer, e.expression);
  return false;
}

/** Whether `node` is a value a Node island made, as far as the compiler
 * sees it, in a slot where an island object stays the island's (typed `any`,
 * `unknown` or by the island): an island read, call, index or `new`, awaited
 * or not, a `const` initialized with one, or a value whose origin the view
 * marking follows to an island (through the program's own untyped
 * parameters and returns: class-protocols.ts, islandOrigin). The divergence
 * scan asks this of the operand of a checked conversion (SC6007). */
export function islandMadeValue(lowerer: Lowerer, node: ts.Expression, depth = 0): boolean {
  const islands = lowerer.nodeIslands;
  if (islands === null) return false;
  let e = withoutParenthesesTypeWrappers(node);
  const type = lowerer.typeOf(e);
  if (
    (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) === 0 &&
    !isForeignType(islands, type, lowerer.checker)
  )
    return false;
  if (depth === 0 && lowerer.islandOrigin(e)) return true;
  while (ts.isAwaitExpression(e)) e = withoutParenthesesTypeWrappers(e.expression);
  if (ts.isIdentifier(e)) {
    if (depth >= 4) return false;
    const d = (lowerer.resolveValueSymbol(e) ?? lowerer.checker.getSymbolAtLocation(e))
      ?.valueDeclaration;
    return (
      d !== undefined &&
      ts.isVariableDeclaration(d) &&
      ts.isIdentifier(d.name) &&
      d.initializer !== undefined &&
      ts.isVariableDeclarationList(d.parent) &&
      (d.parent.flags & ts.NodeFlags.Const) !== 0 &&
      islandMadeValue(lowerer, d.initializer, depth + 1)
    );
  }
  return islandRooted(lowerer, e);
}

/** Whether `call` calls into a Node island: its callee is an island value. */
export function islandCall(lowerer: Lowerer, call: ts.CallExpression): boolean {
  return lowerer.nodeIslands !== null && islandRooted(lowerer, call);
}

/** An island operation whose result is an undeclared object (a handle). */
function isIslandHandleExpr(lowerer: Lowerer, node: ts.Expression): boolean {
  return islandRooted(lowerer, node) && undeclaredHandleType(lowerer, lowerer.typeOf(node));
}

/** The one function type a slot expects, when the program declares it: the
 * slot's type without its nullish arms. Null for a slot with no type, with
 * several arms, typed `any` or `unknown`, or typed by an island (values of
 * an island's own types stay handles). */
function programFunctionSlot(lowerer: Lowerer, node: ts.Expression): ts.Type | null {
  const slot = lowerer.checker.getContextualType(node);
  if (slot === undefined) return null;
  const nullish = ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void;
  const arms = (slot.isUnionType() ? ts.constituentTypes(slot) : [slot]).filter(
    (arm) => (arm.flags & nullish) === 0,
  );
  const arm = arms.length === 1 ? arms[0]! : null;
  if (arm === null || (arm.flags & ts.TypeFlags.Object) === 0) return null;
  if (lowerer.checker.getCallSignatures(arm).length === 0) return null;
  return isForeignType(lowerer.nodeIslands!, arm, lowerer.checker) ? null : arm;
}

/** A function an island made, read where the program expects a function of
 * its own type (`versions.sort(rcompare)`, `{ order: compare }`, an argument
 * of a program function): the typed view of the island's function at that
 * slot. The value stays the island's one function object — the view is the
 * checked-dynamic function boundary's adapter over the handle, so it shares
 * the function's identity, boxes back to the handle, and each call is the
 * island call a direct call makes. The view takes the slot's parameters
 * (JavaScript passes every argument the caller supplies, whatever the
 * function declares) and answers the function's own declared result, which
 * the checked conversion holds it to as it does for a direct call; a slot
 * that discards the result, or a function whose declaration does not name
 * one result type (overloads, a generic signature, an island type), answers
 * the slot's. Null where the value stays the handle: no such slot, a use
 * through island operations, or a signature the boundary cannot adapt. */
export function islandFunctionView(
  lowerer: Lowerer,
  value: IrExpr,
  node: ts.Expression,
): IrExpr | null {
  if (lowerer.nodeIslands === null || value.type.kind !== "dyn") return null;
  // A receiver or a callee is used through the value itself. Most
  // checked-dynamic expressions are one of the two, so they leave here
  // before any type is asked for.
  const parent = node.parent;
  if (
    parent !== undefined &&
    (ts.isPropertyAccessExpression(parent) ||
      ts.isElementAccessExpression(parent) ||
      ts.isCallExpression(parent) ||
      ts.isNewExpression(parent)) &&
    parent.expression === node
  )
    return null;
  const type = lowerer.typeOf(node);
  if (!lowerer.islandFunctionType(type)) return null;
  const signatures = lowerer.checker.getCallSignatures(type);
  if (handleUseOk(lowerer, node)) return null;
  const slot = programFunctionSlot(lowerer, node);
  if (slot === null) return null;
  const mapped = lowerer.mapTypeOf(slot);
  if (mapped === null || mapped.kind !== "func") return null;
  let view: IrType & { kind: "func" } = mapped;
  const own = signatures.length === 1 ? signatures[0]! : null;
  if (mapped.ret.kind !== "void" && own !== null && !own.declaration?.typeParameters?.nodes) {
    const result = lowerer.mapTypeOf(lowerer.checker.getReturnTypeOfSignature(own));
    if (result !== null && result.kind !== "dyn" && result.kind !== "void")
      view = { ...mapped, ret: result };
  }
  const adaptable = (t: IrType): boolean =>
    canAdaptDynFuncTo(
      t,
      (id) => lowerer.shapes.get(id),
      (id) => lowerer.unions.get(id),
    );
  if (!adaptable(view)) {
    if (view === mapped || !adaptable(mapped)) return null;
    view = mapped;
  }
  return lowerer.coerceToExpected(value, view);
}

/** Whether `name` names a `const` initialized with an undeclared island
 * object (`const files = pkg.list()`): the binding holds the handle, and
 * every use goes through island operations. */
export function islandHandleBinding(lowerer: Lowerer, name: ts.Identifier): boolean {
  if (lowerer.nodeIslands === null) return false;
  const symbol = lowerer.resolveValueSymbol(name) ?? lowerer.checker.getSymbolAtLocation(name);
  if (symbol === undefined || symbol === null) return false;
  const known = lowerer.islandHandleBindings.get(symbol);
  if (known !== undefined) return known;
  lowerer.islandHandleBindings.set(symbol, false);
  const d = symbol.valueDeclaration;
  const result =
    d !== undefined &&
    ts.isVariableDeclaration(d) &&
    ts.isIdentifier(d.name) &&
    d.initializer !== undefined &&
    ts.isVariableDeclarationList(d.parent) &&
    (d.parent.flags & ts.NodeFlags.Const) !== 0 &&
    isIslandHandleExpr(lowerer, d.initializer);
  lowerer.islandHandleBindings.set(symbol, result);
  return result;
}

/** `a === b` / `a !== b` where both sides are island values and one is
 * an undeclared island object (a handle): handle identity. */
function isIslandIdentityTest(lowerer: Lowerer, e: ts.BinaryExpression): boolean {
  const op = e.operatorToken.kind;
  if (
    op !== ts.SyntaxKind.EqualsEqualsEqualsToken &&
    op !== ts.SyntaxKind.ExclamationEqualsEqualsToken
  )
    return false;
  const handle = (x: ts.Expression): boolean => {
    const inner = withoutParenthesesTypeWrappers(x);
    return (
      (ts.isIdentifier(inner) && islandHandleBinding(lowerer, inner)) ||
      isIslandHandleExpr(lowerer, inner)
    );
  };
  return (
    (handle(e.left) || handle(e.right)) &&
    isForeignExpr(lowerer, e.left) &&
    isForeignExpr(lowerer, e.right)
  );
}

/** Whether an island handle at `node` is used only through island
 * operations: as a receiver or callee, an argument of an island call, a
 * spread the island lowering flattens, a handle binding's initializer, or
 * a discarded value. */
function handleUseOk(lowerer: Lowerer, node: ts.Expression): boolean {
  let n: ts.Node = node;
  while (
    n.parent !== undefined &&
    (ts.isParenthesizedExpression(n.parent) ||
      ts.isAsExpression(n.parent) ||
      ts.isNonNullExpression(n.parent) ||
      ts.isSatisfiesExpression(n.parent))
  )
    n = n.parent;
  const p = n.parent;
  if (p === undefined) return false;
  if ((ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) && p.expression === n)
    return true;
  const islandCallee = (callee: ts.Expression): boolean => {
    const c = withoutParenthesesTypeWrappers(callee);
    if (ts.isPropertyAccessExpression(c) || ts.isElementAccessExpression(c))
      return isForeignExpr(lowerer, c.expression);
    return isForeignExpr(lowerer, c);
  };
  if (ts.isCallExpression(p) || ts.isNewExpression(p)) {
    if (p.expression === n || islandCallee(p.expression)) return true;
    // clearTimeout(islandTimer): Node's own clear function clears it.
    return (
      ts.isCallExpression(p) &&
      p.arguments.nodes[0] === n &&
      islandTimerType(lowerer, lowerer.typeOf(node)) &&
      isTimerClearCallee(lowerer, p.expression)
    );
  }
  if (ts.isSpreadElement(p)) {
    const q = p.parent;
    if (ts.isArrayLiteralExpression(q)) return true;
    return (ts.isCallExpression(q) || ts.isNewExpression(q)) && islandCallee(q.expression);
  }
  if (ts.isVariableDeclaration(p) && p.initializer === n && ts.isIdentifier(p.name))
    return islandHandleBinding(lowerer, p.name);
  if (ts.isBinaryExpression(p) && isIslandIdentityTest(lowerer, p)) return true;
  return ts.isExpressionStatement(p) || ts.isVoidExpression(p);
}

/** `util.promisify(f)` (or the named `promisify` import of node:util) of an
 * island function: Node's own promisify runs in the island, so the result
 * is an island function too (custom promisify symbols, callback order). */
export function isIslandPromisifyCall(lowerer: Lowerer, node: ts.Node): node is ts.CallExpression {
  if (lowerer.nodeIslands === null) return false;
  if (!ts.isCallExpression(node) || node.questionDotToken || node.arguments.nodes.length !== 1)
    return false;
  const callee = node.expression;
  const bi = ts.isIdentifier(callee)
    ? lowerer.builtinImportOf(callee)
    : ts.isPropertyAccessExpression(callee)
      ? lowerer.builtinMemberOf(callee)
      : null;
  if (!bi || bi.module !== "util" || bi.member !== "promisify") return false;
  return isForeignExpr(lowerer, node.arguments.nodes[0]!);
}

/** A value crossing INTO the island (an argument or an assigned value), as
 * dyn. */
/** What a value's type says a worker thread cannot pass into its Node
 * island, each of which the runtime refuses by name at the crossing
 * (scr_node_island_handle.c): a function the island would call back, bytes,
 * a promise. Null when the type leaves it open: `any`, or a union with an
 * arm that crosses. */
function workerBoundValueKind(lowerer: Lowerer, type: ts.Type): string | null {
  if (callableType(lowerer, type)) return "a function";
  const parts = type.isUnionType() ? ts.constituentTypes(type) : [type];
  let kind: string | null = null;
  for (const part of parts) {
    if ((part.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0)
      continue;
    const mapped = (part.flags & ts.TypeFlags.Object) !== 0 ? lowerer.mapTypeOf(part) : null;
    const found =
      (part.flags & ts.TypeFlags.ESSymbolLike) !== 0
        ? "a symbol"
        : mapped?.kind === "bytes"
          ? "bytes (a typed array or a Buffer)"
          : mapped?.kind === "promise"
            ? "a promise"
            : mapped?.kind === "func"
              ? "a function"
              : null;
    if (found === null) return null;
    kind ??= found;
  }
  return kind;
}

/** SC8012 for a value a module that runs only on worker threads passes into
 * a Node island, when its type is one a worker thread cannot pass. A value
 * the island made goes back as its handle and is not one. */
function workerOnlyValueFence(lowerer: Lowerer, node: ts.Expression, inner: ts.Expression): void {
  if (lowerer.workerOnlyModules.size === 0) return;
  if (!lowerer.workerOnlyModules.has(ts.getSourceFileOfNode(node))) return;
  if (islandMade(lowerer, inner)) return;
  const kind = workerBoundValueKind(lowerer, lowerer.typeOf(node));
  if (kind !== null) lowerer.refuseIslandWorkerValue(node, kind);
}

function toIsland(lowerer: Lowerer, node: ts.Expression): IrExpr {
  const islands = lowerer.nodeIslands!;
  const inner = withoutParenthesesTypeWrappers(node);
  if (ts.isObjectLiteralExpression(inner) || ts.isArrayLiteralExpression(inner)) {
    return freshLiteral(lowerer, inner);
  }
  // `console` passed into an island is the island's own console: Node's
  // console object, which `require("console")` answers there. Island code
  // then sees `logger === console`, and its calls print through Node's
  // console in the same process. The native console is a handle, which
  // has no by-reference export.
  if (ts.isIdentifier(inner) && lowerer.isStdlibGlobal(inner, "console")) {
    const loc = locOf(node);
    return {
      kind: "libCall",
      fn: "nodeIsland.require",
      args: [{ kind: "strLit", value: "console", type: STRING, loc }],
      type: DYN,
      loc,
    };
  }
  // The value as the dyn box the runtime crosses. A representation the
  // conversion cannot box (a union with a generator arm, an `Iterable<T>`
  // the program holds as one of several native kinds) has no island export:
  // that is the named refusal, where the unboxed value reached the IR
  // validator as an internal error.
  const boxed = (lowered: IrExpr): IrExpr => {
    const value = lowerer.coerceToExpected(lowered, DYN);
    if (value.type.kind !== "dyn")
      boundaryFail(
        lowerer,
        `a '${lowerer.checker.typeToString(lowerer.typeOf(node))}' value (its native representation has no island export)`,
        node,
      );
    return value;
  };
  if (
    (ts.isIdentifier(inner) && islandHandleBinding(lowerer, inner)) ||
    isIslandHandleExpr(lowerer, inner)
  )
    return boxed(lowerer.lowerExpr(node));
  workerOnlyValueFence(lowerer, node, inner);
  const crossing = crossingOf(islands, lowerer.typeOf(node), lowerer.checker);
  switch (crossing) {
    case "copy":
    case "handle":
      return boxed(lowerer.lowerExpr(node));
    case "dyn":
      // NI-5: the runtime exports dyn objects by reference and copies only
      // primitives, strings and (for now) arrays.
      return boxed(lowerer.lowerExpr(node));
    case "refused": {
      const type = lowerer.typeOf(node);
      // A type parameter the instance binds to dyn (a generic function
      // over island types, `<T extends TSchema>`): its values are dyn
      // values, and they cross the way `any` values do.
      if (
        (type.flags & ts.TypeFlags.TypeParameter) !== 0 &&
        lowerer.typeParamResolver(type)?.kind === "dyn"
      )
        return boxed(lowerer.lowerExpr(node));
      const crossByReference = (): IrExpr => {
        const lowered = lowerer.lowerExpr(node);
        const value = boxed(lowered);
        // A function the island calls: the call it is an argument of
        // declares the parameters its thunk checks.
        if (lowerer.typeClaims && lowered.type.kind === "func") {
          const call = node.parent;
          if (call !== undefined && (ts.isCallExpression(call) || ts.isNewExpression(call))) {
            const index = (call.arguments?.nodes ?? []).indexOf(node);
            if (index >= 0) noteIslandClaim(lowerer, value, call, node, index);
          }
        }
        return lowered.type.kind === "object"
          ? withClassMethods(lowerer, value, lowered.type.className, node)
          : value;
      };
      // The crossing follows the value's NATIVE representation: a dyn value
      // (a primitive arm beside an object the checker cannot map, `string |
      // Part[]`) crosses the way `any` values do, and a union of copied
      // values with representations the export table holds crosses arm by
      // arm through its dyn box. The runtime exports objects by reference
      // and copies primitives, so the representation is already exact.
      const mapped = lowerer.mapTypeOf(type);
      // What the export table does not hold is refused first: a WeakMap is a
      // checked-dynamic value natively, so its representation alone would
      // let it through to the runtime's own refusal. A value the island
      // made is its handle and goes back as one.
      const unexported = islandMade(lowerer, inner) ? null : unexportedNative(lowerer, type);
      if (unexported !== null)
        return boundaryFail(
          lowerer,
          unexported === type
            ? `a '${lowerer.checker.typeToString(type)}' value (its native representation has no island export)`
            : `a '${lowerer.checker.typeToString(type)}' value (its '${lowerer.checker.typeToString(unexported)}' arm has no island export)`,
          node,
        );
      if (mapped !== null && crossesByRepresentation(lowerer, mapped)) return crossByReference();
      // NI-5: closures, promises, records and class instances cross by
      // reference (scr_node_island_export.c): their dyn boxes keep the
      // native referent, and the closure's thunk checks its arguments.
      if (exportedByReference(lowerer, type)) return crossByReference();
      const arm = unexportableUnionArm(lowerer, type);
      return boundaryFail(
        lowerer,
        arm === null
          ? `a '${lowerer.checker.typeToString(type)}' value (its native representation has no island export)`
          : `a '${lowerer.checker.typeToString(type)}' value (its '${arm}' arm has no island export)`,
        node,
      );
    }
  }
}

/** Whether an island reads the lowered method `name` by that name: a
 * public, string-keyed prototype method. The constructor, #private methods,
 * accessor halves (`get:x`, `set:x`) and symbol-keyed slots (`sym:iterator`)
 * are not properties an island can name. */
function islandMethodName(name: string): boolean {
  return name !== "constructor" && !name.startsWith("#") && !/^(?:get|set|sym):/.test(name);
}

/** A class instance crossing into an island: its capsule answers island
 * reads of its fields, and its prototype methods come from a table the
 * runtime builds once per class (nodeIsland.classMethods): the unbound
 * method values, whose thunks check the receiver Node calls them on. */
function withClassMethods(
  lowerer: Lowerer,
  value: IrExpr,
  className: string,
  blame: ts.Node,
): IrExpr {
  const builder = classMethodsBuilderOf(lowerer, className, blame, value.loc);
  if (builder === null) return value;
  return {
    kind: "libCall",
    fn: "nodeIsland.classMethods",
    args: [value, builder],
    type: DYN,
    loc: value.loc,
  };
}

/** The builder of a class's method table (a dyn closure answering
 * {name: unbound method value}), or null for a class without methods. */
function classMethodsBuilderOf(
  lowerer: Lowerer,
  className: string,
  blame: ts.Node,
  loc: SrcLoc,
): IrExpr | null {
  const info = lowerer.classes.get(className);
  if (info === undefined || info.def.runtime) return null;
  const names: string[] = [];
  for (
    let c: typeof info | undefined = info;
    c !== undefined;
    c = c.def.base ? lowerer.classes.get(c.def.base) : undefined
  ) {
    for (const m of c.def.methods ?? [])
      if (!names.includes(m) && islandMethodName(m)) names.push(m);
  }
  if (names.length === 0) return null;
  const builder = `%island.methods:${className}`;
  if (!lowerer.classMethodValueHelpers.has(builder)) {
    lowerer.classMethodValueHelpers.add(builder);
    const fields: { key: IrExpr; value: IrExpr }[] = [];
    for (const m of names) {
      const method = classMethodValue(lowerer, blame, info, m, loc);
      if (method === null) continue;
      fields.push({
        key: { kind: "strLit", value: m, type: STRING, loc },
        value: lowerer.coerceToExpected(method, DYN),
      });
    }
    lowerer.liftedFns.push({
      name: builder,
      params: [],
      returnType: DYN,
      locals: [],
      body: [{ kind: "return", value: { kind: "dynObjLit", fields, type: DYN, loc }, loc }],
      loc,
    });
  }
  const closure: IrExpr = {
    kind: "closure",
    fnName: builder,
    captures: [],
    type: funcTypeFromParamShapes([], DYN),
    loc,
  };
  return lowerer.coerceToExpected(closure, DYN);
}

/** NI-6: the method-table builder of the class a shared module exports
 * (`decl` is the class, `ident` the export's name), or null. */
export function classMethodsBuilder(
  lowerer: Lowerer,
  decl: ts.ClassLikeDeclaration,
  ident: ts.Identifier,
  loc: SrcLoc,
): IrExpr | null {
  return classMethodsBuilderOf(lowerer, lowerer.classNamer(decl), ident, loc);
}

/** NI-6: `new C(...)` from island code for the class a shared module
 * exports: a function with the constructor's parameters (its dyn thunk
 * checks the island's arguments) that constructs an instance, as a dyn
 * closure, or null when the constructor's shape is not a plain list of
 * parameters (the island's `new` then throws). */
export function classConstructHelper(
  lowerer: Lowerer,
  decl: ts.ClassLikeDeclaration,
  loc: SrcLoc,
): IrExpr | null {
  const className = lowerer.classNamer(decl);
  const info = lowerer.classes.get(className);
  if (info === undefined || info.def.runtime || info.localClass || info.generic) return null;
  for (let c: typeof info | null = info; c; c = c.base) if (c.def.baseValueGlobal) return null;
  /* A ctor-less Error subclass keeps the builtin base's constructor
   * parameters — the (message?, options?) checked-dynamic pair the
   * synthesized constructor forwards — so its helper constructs exactly
   * what native `new C(...)` does. Only an explicit constructor with
   * another shape falls through the mode check below. */
  const shapes = info.ctorParams;
  if (shapes.some((s) => s.mode !== "required" && s.mode !== "omittable")) return null;
  const name = `%island.new:${className}`;
  if (!lowerer.classMethodValueHelpers.has(name)) {
    lowerer.classMethodValueHelpers.add(name);
    lowerer.noteEdge(`%${className}.constructor`);
    const params = shapes.map((s, i) => ({ localId: `p${i}`, name: `p${i}`, type: s.type }));
    const objectType: IrType = { kind: "object", className };
    lowerer.liftedFns.push({
      name,
      params,
      returnType: objectType,
      locals: params.map((p) => ({ id: p.localId, name: p.name, type: p.type, mutable: false })),
      body: [
        {
          kind: "return",
          value: {
            kind: "new",
            className,
            args: params.map((p) => varRef(p.localId, p.type, loc)),
            type: objectType,
            loc,
          },
          loc,
        },
      ],
      loc,
    });
  }
  const closure: IrExpr = {
    kind: "closure",
    fnName: name,
    captures: [],
    type: funcTypeFromParamShapes(shapes, { kind: "object", className }),
    loc,
  };
  return lowerer.coerceToExpected(closure, DYN);
}

/** Native values NI-5 exports into the island by reference: functions,
 * promises, and object types other than arrays, tuples, Maps and Sets
 * (records, interfaces, class instances). A union qualifies when every
 * arm does or is copied, and an intersection of them qualifies: a merged
 * generic record (`Omit<Base, "k"> & Extras`, the `Type.Object(props)`
 * shape) is one native object, and the island reads the program's own
 * object, not a copy of it. An intersection with a primitive arm
 * (`string & {brand}`) is a primitive value, which the runtime copies. */
function exportedByReference(lowerer: Lowerer, type: ts.Type): boolean {
  const checker = lowerer.checker;
  if (type.isUnionType())
    return ts
      .constituentTypes(type)
      .every((t) => isCopiedTsType(t) || exportedByReference(lowerer, t));
  if ((type.flags & ts.TypeFlags.Intersection) !== 0)
    return ts
      .constituentTypes(type)
      .every((t) => isCopiedTsType(t) || exportedByReference(lowerer, t));
  if ((type.flags & ts.TypeFlags.Object) === 0) return false;
  // Arrays and tuples cross as Proxies over the native array (NI-5b).
  void checker;
  const name = type.getSymbol()?.escapedName;
  if (name === "WeakMap" || name === "WeakSet") return false;
  return true;
}

/** Whether `node` is visibly a value an island made: an island read, call
 * or construction, a name imported from an island module (`import {
 * registry } from "pkg"`: the island's own export), or a `const`
 * initialized with one of those. A slot whose native type is
 * checked-dynamic (a WeakMap's) holds such a value as the island's handle. */
function islandMade(lowerer: Lowerer, node: ts.Expression): boolean {
  if (islandValue(lowerer, node)) return true;
  const name = withoutParenthesesTypeWrappers(node);
  if (!ts.isIdentifier(name)) return false;
  const declaration = lowerer.resolveValueSymbol(name)?.valueDeclaration;
  return (
    declaration !== undefined &&
    ts.isVariableDeclaration(declaration) &&
    declaration.initializer !== undefined &&
    (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) !== 0 &&
    islandValue(lowerer, declaration.initializer)
  );
}

/** Whether `node` reads a value out of an island where it stands: an island
 * read, call or construction, or a name an island module exports. */
function islandValue(lowerer: Lowerer, node: ts.Expression): boolean {
  if (islandRooted(lowerer, node)) return true;
  const name = withoutParenthesesTypeWrappers(node);
  return ts.isIdentifier(name) && islandBindingOf(lowerer, name) !== null;
}

/** The runtime handle tags the island export table holds: `scr_ni_exportable`
 * (scr_node_island_export.c) accepts a handle only with the Map or the Set
 * tag. lower-node-island.test.ts reads that function and fails when the two
 * lists differ, so a handle the runtime starts to export (a class that
 * crosses as a twin, say) is added here, and the build-time refusal below
 * cannot drift from the run-time one. */
export const ISLAND_EXPORTED_HANDLE_TAGS: ReadonlySet<string> = new Set([
  "SCR_DYNH_MAP",
  "SCR_DYNH_SET",
]);

/** The part of `type` whose native value the island export table does not
 * hold, or null: a WeakMap or WeakSet (weak storage has no export), or a
 * stateful I/O handle of DYN_HANDLE_KINDS (a ChildProcess, a socket, a
 * server), whose checked-dynamic box is a runtime handle with a tag the
 * table does not take. The runtime refuses each of them when it crosses
 * (`this native object cannot cross into a Node island yet`); a statically
 * typed one is refused here, by name, alone or as an arm of a union. */
function unexportedNative(lowerer: Lowerer, type: ts.Type): ts.Type | null {
  if (type.isUnionType()) {
    for (const part of ts.constituentTypes(type)) {
      const found = unexportedNative(lowerer, part);
      if (found !== null) return found;
    }
    return null;
  }
  // A refined handle (`ServerResponse & { req: IncomingMessage }`,
  // `ChildProcess & { label: string }`) is the native object of its handle
  // part, so it has that part's missing export.
  if (type.isIntersectionType()) {
    for (const part of ts.constituentTypes(type))
      if (unexportedNative(lowerer, part) !== null) return type;
    return null;
  }
  if ((type.flags & ts.TypeFlags.Object) === 0) return null;
  if (lowerer.weakCollectionNamesOf(type) !== null) return type;
  const handle = DYN_HANDLE_KINDS.get(lowerer.mapTypeOf(type)?.kind ?? "");
  return handle !== undefined && !ISLAND_EXPORTED_HANDLE_TAGS.has(handle.tag) ? type : null;
}

/** Whether a value of native IR type `t` crosses INTO an island by
 * reference: a dyn value (the runtime exports its objects, and copies its
 * primitives), or a union whose arms are all copied values or kinds the
 * export table holds (records, class instances, closures, promises,
 * arrays, Maps, Sets, bytes). */
function crossesByRepresentation(lowerer: Lowerer, t: IrType): boolean {
  if (t.kind === "dyn") return true;
  if (t.kind !== "union") return false;
  const def = lowerer.unions.get(t.unionId);
  if (def === undefined) return false;
  return def.arms.every(
    (arm) =>
      copiedType(lowerer, arm) ||
      arm.kind === "record" ||
      arm.kind === "object" ||
      arm.kind === "func" ||
      arm.kind === "promise" ||
      arm.kind === "array" ||
      arm.kind === "map" ||
      arm.kind === "set" ||
      arm.kind === "bytes",
  );
}

/** The arm of `type` that has no island export, named in the SC8010
 * message: the first arm of a union that is neither copied nor exported by
 * reference (a WeakMap or WeakSet). Null when `type` is not such a union. */
function unexportableUnionArm(lowerer: Lowerer, type: ts.Type): string | null {
  if (!type.isUnionType()) return null;
  for (const arm of ts.constituentTypes(type))
    if (!isCopiedTsType(arm) && !exportedByReference(lowerer, arm))
      return lowerer.checker.typeToString(arm);
  return null;
}

/** A record type an island object crosses OUT into as a deep checked
 * copy: the object types exportedByReference names, and intersections of
 * them — a mapped pair (`{[K in Fg]: V} & {[K in Bg]?: V}`) or a merged
 * generic record (`Omit<Base, "k"> & Extras`) is one record, so the
 * island's object converts into the native one the same way a plain
 * record's does. An intersection with a primitive arm (`string & {brand}`)
 * is a primitive value, which copies as its arm. */
function copiedRecordType(lowerer: Lowerer, type: ts.Type): boolean {
  if ((type.flags & ts.TypeFlags.Intersection) !== 0)
    return ts
      .constituentTypes(type)
      .every(
        (t) =>
          (t.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0 ||
          copiedRecordType(lowerer, t),
      );
  return exportedByReference(lowerer, type);
}

/** Whether meeting the declared type `mapped` builds a native record: the
 * deep checked copy `copiedRecordType` names, or a union of that with null
 * and/or undefined. A promise is adopted, a class instance and a closure
 * unbox their own native value, and a container stays a handle: none of
 * them is a copy, so none is refused (SPEC 1b = B). */
function recordConversion(lowerer: Lowerer, mapped: IrType): boolean {
  if (mapped.kind === "record") return true;
  if (mapped.kind !== "union") return false;
  const def = lowerer.unions.get(mapped.unionId);
  if (def === undefined) return false;
  let records = 0;
  for (const arm of def.arms) {
    if (arm.kind === "nullT" || arm.kind === "undefinedT") continue;
    if (arm.kind !== "record") return false;
    records++;
  }
  return records > 0;
}

/** A fresh object or array literal crosses as a copy (a plain dyn object
 * or array the runtime copies into V8): nothing native can alias it. Its
 * members cross by the same rules (toIsland). */
function freshLiteral(
  lowerer: Lowerer,
  node: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression,
): IrExpr {
  const loc = locOf(node);
  // Spreads, methods, accessors and computed keys: the literal lowers as
  // the program's own object, which crosses by reference (NI-5 exports);
  // nothing else holds it, so that is exact.
  if (!plainLiteral(node))
    return lowerer.coerceToExpected(lowerer.lowerExprExpecting(node, DYN), DYN);
  if (ts.isArrayLiteralExpression(node)) {
    const elems = node.elements.nodes.map((el) => {
      if (ts.isSpreadElement(el) || ts.isOmittedExpression(el))
        boundaryFail(lowerer, "a spread or hole in an array literal", el);
      return toIsland(lowerer, el);
    });
    return { kind: "dynArrLit", elems, type: DYN, loc };
  }
  const fields = node.properties.nodes.map((p) => {
    let key: string;
    let value: IrExpr;
    if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) {
      key = p.name.text;
      value = toIsland(lowerer, p.initializer);
    } else if (ts.isShorthandPropertyAssignment(p)) {
      const name = p.name as ts.Identifier;
      key = name.text;
      value = toIsland(lowerer, name);
    } else {
      return boundaryFail(
        lowerer,
        "a computed key, method, accessor or spread in an object literal",
        p,
      );
    }
    return { key: { kind: "strLit", value: key, type: STRING, loc } as IrExpr, value };
  });
  return { kind: "dynObjLit", fields, type: DYN, loc };
}

/** Whether evaluating an argument runs no code that could change the
 * receiver: literals, names, `this`, functions it creates, object and
 * array literals of those, and operators over those. A unary operator
 * (`+`, `-`, `~`) converts its operand with ToNumber, which calls a
 * user-defined `valueOf`: only a numeric literal operand is inert. */
function inertArgument(node: ts.Expression): boolean {
  const e = withoutParenthesesTypeWrappers(node);
  if (
    ts.isIdentifier(e) ||
    ts.isLiteralExpression(e) ||
    ts.isNoSubstitutionTemplateLiteral(e) ||
    ts.isArrowFunction(e) ||
    ts.isFunctionExpression(e) ||
    e.kind === ts.SyntaxKind.ThisKeyword ||
    e.kind === ts.SyntaxKind.TrueKeyword ||
    e.kind === ts.SyntaxKind.FalseKeyword ||
    e.kind === ts.SyntaxKind.NullKeyword
  )
    return true;
  if (ts.isParenthesizedExpression(e)) return inertArgument(e.expression);
  if (ts.isArrayLiteralExpression(e))
    return e.elements.nodes.every((el) => !ts.isSpreadElement(el) && inertArgument(el));
  if (ts.isObjectLiteralExpression(e))
    return e.properties.nodes.every(
      (p) =>
        ts.isShorthandPropertyAssignment(p) ||
        ts.isMethodDeclaration(p) ||
        (ts.isPropertyAssignment(p) &&
          !ts.isComputedPropertyName(p.name) &&
          inertArgument(p.initializer)),
    );
  if (ts.isPrefixUnaryExpression(e)) {
    // `!x` runs no conversion on its operand. `+`, `-` and `~` convert it
    // with ToNumber, which calls a user-defined `valueOf` on an object:
    // that can replace the method being called, so only a numeric literal
    // is inert.
    if (e.operator === ts.SyntaxKind.ExclamationToken) return inertArgument(e.operand);
    return e.operand.kind === ts.SyntaxKind.NumericLiteral;
  }
  return false;
}

function argsOf(lowerer: Lowerer, args: readonly ts.Expression[], loc: SrcLoc): IrExpr {
  if (args.some((a) => ts.isSpreadElement(a))) return spreadPack(lowerer, args, loc);
  return { kind: "dynArrLit", elems: args.map((a) => toIsland(lowerer, a)), type: DYN, loc };
}

/** A fresh dyn array of `items` with their spreads flattened in order
 * (JavaScript's ArgumentListEvaluation / array literal spread): plain
 * items cross as island arguments, spread sources (native arrays or
 * island iterables) flatten through the runtime's spread walk. */
function spreadPack(lowerer: Lowerer, items: readonly ts.Expression[], loc: SrcLoc): IrExpr {
  const pack = lowerer.declareHiddenLocal("%islandSpread", DYN);
  const ref = varRef(pack.id, DYN, loc);
  const stmts: IrStmt[] = [
    {
      kind: "varDecl",
      localId: pack.id,
      init: { kind: "dynArrLit", elems: [], type: DYN, loc },
      loc,
    },
  ];
  for (const item of items) {
    if (ts.isOmittedExpression(item)) boundaryFail(lowerer, "a hole in an array literal", item);
    const spread = ts.isSpreadElement(item);
    const value = spread
      ? lowerer.coerceToExpected(lowerer.lowerExpr(item.expression), DYN)
      : toIsland(lowerer, item);
    stmts.push({
      kind: "exprStmt",
      expr: {
        kind: "libCall",
        fn: spread ? "dyn.packPushSpreadIter" : "dyn.packPush",
        args: [ref, value],
        type: { kind: "void" },
        loc,
      },
      loc,
    });
  }
  return { kind: "seqExpr", stmts, result: ref, type: DYN, loc };
}

/** Optional-chain dots on island receivers the island lowering is
 * currently lowering the guarded body of. */
const handledDots = new Set<ts.Node>();

/** The outermost unhandled `?.` in `expr`'s access spine whose receiver
 * is an island value: that dot guards the whole chain. */
function islandChainDot(
  lowerer: Lowerer,
  expr: ts.Expression,
): { dot: ts.Expression; recv: ts.Expression } | null {
  let cur: ts.Expression = expr;
  for (;;) {
    if (lowerer.chainRecvByNode.has(cur)) return null;
    if (ts.isNonNullExpression(cur)) {
      cur = cur.expression;
      continue;
    }
    if (
      ts.isCallExpression(cur) ||
      ts.isPropertyAccessExpression(cur) ||
      ts.isElementAccessExpression(cur)
    ) {
      if (cur.questionDotToken && !handledDots.has(cur)) {
        return isForeignExpr(lowerer, cur.expression) ? { dot: cur, recv: cur.expression } : null;
      }
      cur = cur.expression;
      continue;
    }
    return null;
  }
}

/** Whether the nearest `?.` no chain lowering has consumed sits below
 * `expr` in its access spine on a receiver that is not an island value:
 * `expr` is then a tail of that native chain, and a nullish receiver
 * short-circuits the island reads in it as well. */
function nativeGuardBelow(lowerer: Lowerer, expr: ts.Expression): boolean {
  let cur: ts.Expression = expr;
  for (;;) {
    if (lowerer.chainRecvByNode.has(cur)) return false;
    if (ts.isNonNullExpression(cur)) {
      cur = cur.expression;
      continue;
    }
    if (
      ts.isCallExpression(cur) ||
      ts.isPropertyAccessExpression(cur) ||
      ts.isElementAccessExpression(cur)
    ) {
      if (cur.questionDotToken && !handledDots.has(cur) && !lowerer.chainHandled.has(cur))
        return cur !== expr && !isForeignExpr(lowerer, cur.expression);
      cur = cur.expression;
      continue;
    }
    return false;
  }
}

/** An optional chain guarded by an island receiver: the receiver
 * evaluates once; nullish answers undefined, anything else runs the
 * whole chain with the receiver read back from the guard. */
function lowerIslandChain(
  lowerer: Lowerer,
  expr: ts.Expression,
  chain: { dot: ts.Expression; recv: ts.Expression },
  loc: SrcLoc,
): IrExpr {
  lowerer.usesNodeIsland = true;
  const stmts: IrStmt[] = [];
  const run = (lower: () => IrExpr): IrExpr => {
    // `x.m?.()`: the method's receiver evaluates once, before the guard.
    const recv = withoutParenthesesTypeWrappers(chain.recv);
    if (
      ts.isCallExpression(chain.dot) &&
      (ts.isPropertyAccessExpression(recv) || ts.isElementAccessExpression(recv))
    ) {
      const object = lowerer.coerceToExpected(lowerer.lowerExpr(recv.expression), DYN);
      const local = lowerer.declareHiddenLocal("%islandThis", DYN);
      stmts.push({ kind: "varDecl", localId: local.id, init: object, loc });
      return lowerer.withExpressionOverride(recv.expression, varRef(local.id, DYN, loc), lower);
    }
    return lower();
  };
  const value = run(() => {
    const id = lowerer.closureName(loc, "", "chain");
    const receiver = lowerer.coerceToExpected(lowerer.lowerExpr(chain.recv), DYN);
    const ref: IrExpr = { kind: "chainRecv", id, type: DYN, loc };
    handledDots.add(chain.dot);
    let body: IrExpr;
    try {
      body = lowerer.withExpressionOverride(chain.recv, ref, () => lowerer.lowerExpr(expr));
    } finally {
      handledDots.delete(chain.dot);
    }
    return {
      kind: "optChain",
      id,
      receiver,
      body: lowerer.coerceToExpected(body, DYN),
      type: DYN,
      loc,
    };
  });
  const result = fromIsland(lowerer, value, expr);
  return stmts.length > 0 ? { kind: "seqExpr", stmts, result, type: result.type, loc } : result;
}

/** The local an island handle binding reads here: its own binding, retyped
 * checked-dynamic, or, inside a closure, the capture of an enclosing
 * function's binding, which resolveLocal registers. */
function islandHandleLocal(lowerer: Lowerer, ident: ts.Identifier): IrLocal | null {
  const origin = lowerer.peekLocal(ident);
  if (origin === null) return null;
  origin.type = DYN;
  return lowerer.resolveLocal(ident);
}

/** Expressions on island values (the lowerExpr hook; null: not an island
 * expression, the ordinary lowering applies). */
export function lowerIslandExpr(lowerer: Lowerer, expr: ts.Expression): IrExpr | null {
  if (lowerer.nodeIslands === null) return null;
  if (ts.isPropertyAccessExpression(expr) && expr.name.text === "length")
    refuseIslandMethodLength(lowerer, expr);
  // A module-level constant the island evaluates (closed-island-init.ts).
  const closed = lowerClosedIslandInit(lowerer, expr);
  if (closed !== null) return closed;
  const loc = locOf(expr);
  if (ts.isIdentifier(expr)) {
    const subclass = islandSubclassGlobal(lowerer, expr);
    if (subclass !== null) {
      lowerer.usesNodeIsland = true;
      return varRef(subclass.id, DYN, loc);
    }
    const b = islandBindingOf(lowerer, expr);
    if (b === null) {
      if (!islandHandleBinding(lowerer, expr)) return null;
      // The DECLARED type decides the crossing, not the use: an island
      // handle whose type is an array of copied values crosses as a copy of
      // its elements wherever native code needs a native value, and the
      // checked conversion throws on an element of the wrong type. Every
      // other native use stays refused (the value is a handle).
      const ok = handleUseOk(lowerer, expr) || onlyTested(lowerer, expr);
      const copy = ok ? null : copyableCrossing(lowerer, expr);
      if (!ok && copy === null)
        boundaryFail(
          lowerer,
          `an island value of type '${lowerer.checker.typeToString(lowerer.typeOf(expr))}' used as a native value (island arrays, Maps and Sets stay handles: read members, call methods, index or spread them)`,
          expr,
        );
      lowerer.usesNodeIsland = true;
      const slot = lowerer.globalOf(expr) ?? islandHandleLocal(lowerer, expr);
      if (slot === null) return null; // the local is declared dyn
      slot.type = DYN;
      const ref = varRef(slot.id, DYN, loc);
      return copy === null
        ? ref
        : lowerer.coerceToExpected(
            { kind: "libCall", fn: "nodeIsland.copyArrays", args: [ref], type: DYN, loc },
            copy,
          );
    }
    lowerer.usesNodeIsland = true;
    return fromIsland(lowerer, islandBindingValue(lowerer, b, expr, loc), expr);
  }
  if (
    ts.isPropertyAccessExpression(expr) ||
    ts.isElementAccessExpression(expr) ||
    ts.isCallExpression(expr)
  ) {
    const chain = islandChainDot(lowerer, expr);
    if (chain !== null) return lowerIslandChain(lowerer, expr, chain, loc);
    // `holder?.config.flag` with a native `holder` and an island `config`:
    // the native receiver's `?.` guards the island reads above it too, so
    // the chain's own lowering runs them inside its guard.
    if (nativeGuardBelow(lowerer, expr) && isOptionalChainTail(lowerer, expr))
      return lowerer.lowerOptionalChain(expr);
  }
  if (ts.isArrayLiteralExpression(expr)) {
    if (
      !expr.elements.nodes.some(
        (el) => ts.isSpreadElement(el) && isForeignExpr(lowerer, el.expression),
      )
    )
      return null;
    lowerer.usesNodeIsland = true;
    const mapped = lowerer.mapTypeOf(lowerer.typeOf(expr));
    if (mapped === null) boundaryFail(lowerer, "an array literal spreading an island value", expr);
    const pack = spreadPack(lowerer, expr.elements.nodes, loc);
    return mapped.kind === "dyn" ? pack : lowerer.coerceToExpected(pack, mapped);
  }
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.name)) {
    const caughtRead = islandCaughtRead(lowerer, expr);
    if (caughtRead !== null) return caughtRead;
    if (!isForeignExpr(lowerer, expr.expression)) return null;
    lowerer.usesNodeIsland = true;
    const target = islandReceiver(lowerer, expr.expression, expr.name.text, loc);
    if (target.direct !== undefined) return fromIsland(lowerer, target.direct, expr);
    return fromIsland(lowerer, islandGet(target.value, expr.name.text, loc), expr);
  }
  if (ts.isElementAccessExpression(expr)) {
    if (!isForeignExpr(lowerer, expr.expression)) return null;
    lowerer.usesNodeIsland = true;
    // `(p as V)[k]`: an assertion on a handle is a view, never a conversion
    // (the read meets the member's declared type in fromIsland below).
    const target = lowerer.lowerExpr(withoutParenthesesTypeWrappers(expr.expression));
    const key = toIsland(lowerer, expr.argumentExpression);
    return fromIsland(
      lowerer,
      { kind: "libCall", fn: "nodeIsland.getKey", args: [target, key], type: DYN, loc },
      expr,
    );
  }
  if (ts.isCallExpression(expr) && isIslandPromisifyCall(lowerer, expr)) {
    lowerer.usesNodeIsland = true;
    return {
      kind: "libCall",
      fn: "nodeIsland.promisify",
      args: [lowerer.coerceToExpected(lowerer.lowerExpr(expr.arguments.nodes[0]!), DYN)],
      type: DYN,
      loc,
    };
  }
  if (ts.isCallExpression(expr)) {
    const dynamicLoad = lowerIslandLoadCall(lowerer, expr, loc);
    if (dynamicLoad !== undefined) return dynamicLoad;
    const callee = withoutParenthesesTypeWrappers(expr.expression);
    if (expr.questionDotToken && !handledDots.has(expr)) return null;
    const args = expr.arguments.nodes;
    if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) {
      if (!isForeignExpr(lowerer, callee.expression)) return null;
      lowerer.usesNodeIsland = true;
      const target = islandReceiver(lowerer, callee.expression, callee.name.text, loc, true);
      if (target.direct !== undefined) {
        return fromIsland(
          lowerer,
          {
            kind: "libCall",
            fn: "nodeIsland.apply",
            args: [target.direct, argsOf(lowerer, args, loc)],
            type: DYN,
            loc,
          },
          expr,
        );
      }
      const name: IrExpr = { kind: "strLit", value: callee.name.text, type: STRING, loc };
      if (args.every((a) => inertArgument(a))) {
        return fromIsland(
          lowerer,
          {
            kind: "libCall",
            fn: "nodeIsland.invoke",
            args: [target.value, name, argsOf(lowerer, args, loc)],
            type: DYN,
            loc,
          },
          expr,
        );
      }
      // An argument that runs code could replace the method: JavaScript
      // reads the method first, then evaluates the arguments.
      const stmts: IrStmt[] = [];
      const receiver = lowerer.declareHiddenLocal("%islandRecv", target.value.type);
      stmts.push({ kind: "varDecl", localId: receiver.id, init: target.value, loc });
      const recv = varRef(receiver.id, target.value.type, loc);
      const method = lowerer.declareHiddenLocal("%islandMethod", DYN);
      stmts.push({
        kind: "varDecl",
        localId: method.id,
        init: { kind: "libCall", fn: "nodeIsland.get", args: [recv, name], type: DYN, loc },
        loc,
      });
      const call: IrExpr = {
        kind: "libCall",
        fn: "nodeIsland.applyTo",
        args: [varRef(method.id, DYN, loc), recv, argsOf(lowerer, args, loc)],
        type: DYN,
        loc,
      };
      const result = fromIsland(lowerer, call, expr);
      return { kind: "seqExpr", stmts, result, type: result.type, loc };
    }
    if (!isForeignExpr(lowerer, callee)) return null;
    lowerer.usesNodeIsland = true;
    const fn = lowerer.lowerExpr(callee);
    return fromIsland(
      lowerer,
      {
        kind: "libCall",
        fn: "nodeIsland.apply",
        args: [fn, argsOf(lowerer, args, loc)],
        type: DYN,
        loc,
      },
      expr,
    );
  }
  if (ts.isNewExpression(expr)) {
    if (!isForeignExpr(lowerer, expr.expression)) return null;
    lowerer.usesNodeIsland = true;
    const ctor = lowerer.lowerExpr(expr.expression);
    return fromIsland(
      lowerer,
      {
        kind: "libCall",
        fn: "nodeIsland.construct",
        args: [ctor, argsOf(lowerer, expr.arguments?.nodes ?? [], loc)],
        type: DYN,
        loc,
      },
      expr,
    );
  }
  if (ts.isBinaryExpression(expr)) {
    const op = expr.operatorToken.kind;
    if (op === ts.SyntaxKind.InstanceOfKeyword) {
      const errorClass = intrinsicErrorClassOf(lowerer, expr.right);
      const global = errorClass ?? standardClassOf(lowerer, expr.right);
      if (global !== null && !lowerer.islandInstanceofHandled.has(expr)) {
        const name: IrExpr = { kind: "strLit", value: global, type: STRING, loc };
        // An island value (an instance of a native subclass of an island
        // error class, say) answers as in Node. A name takes the pair of
        // tests below instead: a value typed by the island's declarations
        // may be the native error an island error became at the boundary
        // (a callback's parameter), which only the native test knows.
        if (
          errorClass !== null &&
          isForeignExpr(lowerer, expr.left) &&
          !ts.isIdentifier(withoutParenthesesTypeWrappers(expr.left))
        ) {
          lowerer.usesNodeIsland = true;
          const value = lowerer.coerceToExpected(lowerer.lowerExpr(expr.left), DYN);
          return {
            kind: "libCall",
            fn: "nodeIsland.instanceofGlobal",
            args: [value, name],
            type: BOOL,
            loc,
          };
        }
        // A dyn or caught value may hold one: the native test, else Node's.
        const left = withoutParenthesesTypeWrappers(expr.left);
        if (ts.isIdentifier(left)) {
          const probe = lowerer.lowerExpr(left);
          if (probe.type.kind === "dyn" || probe.type.kind === "caught") {
            lowerer.islandInstanceofHandled.add(expr);
            let native: IrExpr;
            try {
              native = lowerer.lowerExpr(expr);
            } finally {
              lowerer.islandInstanceofHandled.delete(expr);
            }
            lowerer.usesNodeIsland = true;
            return {
              kind: "logical",
              op: "||",
              left: native,
              right: {
                kind: "libCall",
                fn: "nodeIsland.instanceofGlobal",
                args: [lowerer.coerceToExpected(probe, DYN), name],
                type: BOOL,
                loc,
              },
              type: BOOL,
              loc,
            };
          }
        }
      }
    }
    if (op === ts.SyntaxKind.InstanceOfKeyword && isForeignExpr(lowerer, expr.right)) {
      lowerer.usesNodeIsland = true;
      const value = lowerer.coerceToExpected(lowerer.lowerExpr(expr.left), DYN);
      const ctor = lowerer.lowerExpr(expr.right);
      return { kind: "libCall", fn: "nodeIsland.instanceof", args: [value, ctor], type: BOOL, loc };
    }
    const unitTest = islandUnitComparison(lowerer, expr, loc);
    if (unitTest !== null) return unitTest;
    if (isIslandIdentityTest(lowerer, expr)) {
      lowerer.usesNodeIsland = true;
      return {
        kind: "dynScalarEq",
        left: lowerer.coerceToExpected(lowerer.lowerExpr(expr.left), DYN),
        right: lowerer.coerceToExpected(lowerer.lowerExpr(expr.right), DYN),
        ...(op === ts.SyntaxKind.ExclamationEqualsEqualsToken ? { negated: true as const } : {}),
        type: BOOL,
        loc,
      };
    }
    if (op === ts.SyntaxKind.EqualsToken) {
      const left = withoutParenthesesTypeWrappers(expr.left);
      if (
        (ts.isPropertyAccessExpression(left) && ts.isIdentifier(left.name)) ||
        ts.isElementAccessExpression(left)
      ) {
        if (!isForeignExpr(lowerer, left.expression)) return null;
        lowerer.usesNodeIsland = true;
        // JavaScript's order: the receiver, then the key, then the value.
        const stmts: IrStmt[] = [];
        const hold = (name: string, init: IrExpr, type: IrType): IrExpr => {
          const local = lowerer.declareHiddenLocal(name, type);
          stmts.push({ kind: "varDecl", localId: local.id, init, loc });
          return varRef(local.id, type, loc);
        };
        // `(p as V).k = v`: write the HANDLE the assertion views, not the
        // asserted record the conversion would build.
        const target = lowerer.lowerExpr(withoutParenthesesTypeWrappers(left.expression));
        const receiver = hold("%islandSetTarget", target, target.type);
        const key = ts.isPropertyAccessExpression(left)
          ? null
          : hold("%islandSetKey", toIsland(lowerer, left.argumentExpression), DYN);
        const v = hold("%islandSet", toIsland(lowerer, expr.right), DYN);
        stmts.push({
          kind: "exprStmt",
          expr:
            key === null
              ? {
                  kind: "libCall",
                  fn: "nodeIsland.set",
                  args: [
                    receiver,
                    {
                      kind: "strLit",
                      value: (left as ts.PropertyAccessExpression).name.text,
                      type: STRING,
                      loc,
                    },
                    v,
                  ],
                  type: { kind: "void" },
                  loc,
                }
              : {
                  kind: "libCall",
                  fn: "nodeIsland.setKey",
                  args: [receiver, key, v],
                  type: { kind: "void" },
                  loc,
                },
          loc,
        });
        // The assignment answers the value the program wrote, at the
        // member's declared type: the program's own, not an island's claim.
        const result = islandValueAt(lowerer, v, expr);
        return { kind: "seqExpr", stmts, result, type: result.type, loc };
      }
      return null;
    }
    const left = withoutParenthesesTypeWrappers(expr.left);
    if (
      op >= ts.SyntaxKind.FirstCompoundAssignment &&
      op <= ts.SyntaxKind.LastCompoundAssignment &&
      (ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left)) &&
      isForeignExpr(lowerer, left.expression)
    ) {
      const cop = COMPOUND_ASSIGN_OPS[op];
      if (cop === undefined) return islandLogicalAssign(lowerer, expr, left, op, loc);
      return islandCompoundAssign(lowerer, expr, left, cop, loc);
    }
  }
  return null;
}

/** `obj.k ??= v`, `obj.k ||= v`, `obj.k &&= v` (and `obj[k] ??= v`, …) on
 * an island object, in JavaScript's order: the receiver and the key
 * evaluate once, the member is read once, and only where the operator
 * selects the right side does that side run and get written (a member that
 * keeps its value is not written at all, which a setter or a proxy in the
 * island observes). The expression answers the value the member kept, or
 * the value written, at the expression's declared type. */
function islandLogicalAssign(
  lowerer: Lowerer,
  expr: ts.BinaryExpression,
  left: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  op: ts.SyntaxKind,
  loc: SrcLoc,
): IrExpr {
  lowerer.usesNodeIsland = true;
  const stmts: IrStmt[] = [];
  const holdIn = (into: IrStmt[], name: string, init: IrExpr): IrExpr => {
    const local = lowerer.declareHiddenLocal(name, DYN);
    into.push({ kind: "varDecl", localId: local.id, init, loc });
    return varRef(local.id, DYN, loc);
  };
  // `(p as V).k ??= v`: the view is erased, so the handle is the receiver.
  const target = holdIn(
    stmts,
    "%islandObj",
    lowerer.coerceToExpected(
      lowerer.lowerExpr(withoutParenthesesTypeWrappers(left.expression)),
      DYN,
    ),
  );
  const key = ts.isPropertyAccessExpression(left)
    ? null
    : holdIn(stmts, "%islandKey", toIsland(lowerer, left.argumentExpression));
  const name: IrExpr | null = ts.isPropertyAccessExpression(left)
    ? { kind: "strLit", value: left.name.text, type: STRING, loc }
    : null;
  const old = holdIn(
    stmts,
    "%islandOld",
    name !== null
      ? { kind: "libCall", fn: "nodeIsland.get", args: [target, name], type: DYN, loc }
      : { kind: "libCall", fn: "nodeIsland.getKey", args: [target, key!], type: DYN, loc },
  );
  // The selected branch: the right side, then the write.
  const writeStmts: IrStmt[] = [];
  const next = holdIn(writeStmts, "%islandNext", toIsland(lowerer, expr.right));
  writeStmts.push({
    kind: "exprStmt",
    expr:
      name !== null
        ? {
            kind: "libCall",
            fn: "nodeIsland.set",
            args: [target, name, next],
            type: { kind: "void" },
            loc,
          }
        : {
            kind: "libCall",
            fn: "nodeIsland.setKey",
            args: [target, key!, next],
            type: { kind: "void" },
            loc,
          },
    loc,
  });
  const write: IrExpr = { kind: "seqExpr", stmts: writeStmts, result: next, type: DYN, loc };
  const unit = (which: "null" | "undefined"): IrExpr => ({
    kind: "dynScalarEq",
    left: old,
    right:
      which === "null"
        ? {
            kind: "dynFrom",
            value: { kind: "unitLit", unit: "null", type: NULL_T, loc },
            type: DYN,
            loc,
          }
        : dynUndefinedExpr(loc),
    type: BOOL,
    loc,
  });
  const truthy: IrExpr = { kind: "dynTest", test: "truthy", value: old, type: BOOL, loc };
  const value: IrExpr =
    op === ts.SyntaxKind.QuestionQuestionEqualsToken
      ? {
          kind: "ternary",
          cond: {
            kind: "logical",
            op: "||",
            left: unit("null"),
            right: unit("undefined"),
            type: BOOL,
            loc,
          },
          then: write,
          else_: old,
          type: DYN,
          loc,
        }
      : op === ts.SyntaxKind.BarBarEqualsToken
        ? { kind: "ternary", cond: truthy, then: old, else_: write, type: DYN, loc }
        : { kind: "ternary", cond: truthy, then: write, else_: old, type: DYN, loc };
  const result = islandValueAt(lowerer, holdIn(stmts, "%islandKept", value), expr);
  return { kind: "seqExpr", stmts, result, type: result.type, loc };
}

/** `obj.k op= v` / `obj[k] op= v` on an island object: the receiver and
 * key evaluate once, then the read, the right side, the operator (with
 * JavaScript's ToPrimitive order, in the runtime) and the write. */
function islandCompoundAssign(
  lowerer: Lowerer,
  expr: ts.BinaryExpression,
  left: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  op: NonNullable<(typeof COMPOUND_ASSIGN_OPS)[ts.SyntaxKind]>,
  loc: SrcLoc,
): IrExpr {
  lowerer.usesNodeIsland = true;
  const stmts: IrStmt[] = [];
  const hold = (name: string, init: IrExpr): IrExpr => {
    const local = lowerer.declareHiddenLocal(name, DYN);
    stmts.push({ kind: "varDecl", localId: local.id, init, loc });
    return varRef(local.id, DYN, loc);
  };
  // `(p as V).k op= v`: the view is erased, so the handle is the receiver.
  const target = hold(
    "%islandObj",
    lowerer.coerceToExpected(
      lowerer.lowerExpr(withoutParenthesesTypeWrappers(left.expression)),
      DYN,
    ),
  );
  const key = ts.isPropertyAccessExpression(left)
    ? null
    : hold("%islandKey", toIsland(lowerer, left.argumentExpression));
  const name: IrExpr | null = ts.isPropertyAccessExpression(left)
    ? { kind: "strLit", value: left.name.text, type: STRING, loc }
    : null;
  const old: IrExpr =
    name !== null
      ? { kind: "libCall", fn: "nodeIsland.get", args: [target, name], type: DYN, loc }
      : { kind: "libCall", fn: "nodeIsland.getKey", args: [target, key!], type: DYN, loc };
  const rhs = lowerer.coerceToExpected(lowerer.lowerExpr(expr.right), DYN);
  const next = hold("%islandNext", dynCompoundValue(op, old, rhs, loc));
  stmts.push({
    kind: "exprStmt",
    expr:
      name !== null
        ? {
            kind: "libCall",
            fn: "nodeIsland.set",
            args: [target, name, next],
            type: { kind: "void" },
            loc,
          }
        : {
            kind: "libCall",
            fn: "nodeIsland.setKey",
            args: [target, key!, next],
            type: { kind: "void" },
            loc,
          },
    loc,
  });
  // The value written is not noted as an island's: where the member's old
  // value flows into it, the claims pass finds that read by itself.
  const result = islandValueAt(lowerer, next, expr);
  return { kind: "seqExpr", stmts, result, type: result.type, loc };
}

/** The receiver of a member operation on an island value. A CommonJS
 * namespace binding's members are module.exports' (and `default` is
 * module.exports itself), answered directly; a call of a member keeps
 * module.exports as its receiver, so it goes through the method call. */
function islandReceiver(
  lowerer: Lowerer,
  receiver: ts.Expression,
  member: string,
  loc: SrcLoc,
  call = false,
): { value: IrExpr; direct?: IrExpr } {
  const inner = withoutParenthesesTypeWrappers(receiver);
  if (ts.isIdentifier(inner)) {
    const b = islandBindingOf(lowerer, inner);
    if (b !== null && b.kind === "namespace" && !b.module.esm) {
      const exports = varRef(b.module.global.id, DYN, loc);
      if (member === "default") return { value: exports, direct: exports };
      const snapshot = b.module.snapshots.get(member);
      if (snapshot !== undefined && !call)
        return { value: exports, direct: varRef(snapshot.id, DYN, loc) };
      return { value: exports };
    }
  }
  // `(p as V).k`: the assertion is a view of `p`'s handle, not a
  // conversion of it (the read meets the member's type in fromIsland).
  return { value: lowerer.coerceToExpected(lowerer.lowerExpr(inner), FOREIGN) };
}

/** Whether `require(spec)` in `file` loads an island module. */
export function isIslandRequireSpec(lowerer: Lowerer, file: string, spec: string): boolean {
  const islands = lowerer.nodeIslands;
  return islands !== null && islandModuleFile(islands, file, spec, "require") !== null;
}

/** `require("<island pkg>")` in a CommonJS module, at a call no other
 * lowering claimed (inside a function, or as a subexpression): the island
 * module loads at the call. Null when the package is not an island. */
export function lowerIslandRequireCall(lowerer: Lowerer, call: ts.CallExpression): IrExpr | null {
  if (lowerer.nodeIslands === null) return null;
  return lowerIslandLoadCall(lowerer, call, locOf(call)) ?? null;
}

/** `require("pkg")` (the global require, anywhere) and `import("pkg")` of
 * an island module: load it at the call. Undefined: not such a call. */
function lowerIslandLoadCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  loc: SrcLoc,
): IrExpr | undefined {
  const islands = lowerer.nodeIslands!;
  const arg = expr.arguments.nodes[0];
  if (expr.arguments.nodes.length !== 1 || arg === undefined || !ts.isStringLiteralLike(arg))
    return undefined;
  const isImport = expr.expression.kind === ts.SyntaxKind.ImportKeyword;
  const isRequire =
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === "require" &&
    !lowerer.checker
      .getSymbolAtLocation(expr.expression)
      ?.declarations.some((d) => !ts.getSourceFileOfNode(d).isDeclarationFile);
  if (!isImport && !isRequire) return undefined;
  const file = ts.getSourceFileOfNode(expr).fileName;
  const path = islandModuleFile(islands, file, arg.text, isImport ? "import" : "require");
  if (path === null) return undefined;
  lowerer.noteIslandOnWorkerThread(arg.text, expr);
  lowerer.usesNodeIsland = true;
  if (isImport) {
    return {
      kind: "libCall",
      fn: "nodeIsland.import",
      args: [islandLoadPath(lowerer, path, loc)],
      type: { kind: "promise", inner: DYN },
      loc,
    };
  }
  // A require() the module's own evaluation runs (not inside a function or
  // class body) loads the island exactly when a static import would: it is
  // deferred the same way (scope-B NI-7d), so a native package's top-level
  // `const x = require("<island>")` does not start Node at boot.
  const load = runsAtModuleEvaluation(expr)
    ? deferIslandModule(lowerer, path, loc)
    : loadIslandModule(lowerer, path, loc);
  return fromIsland(lowerer, load, expr);
}

/* ── native classes extending island classes (scope-B NI-5b) ───────────
 * `class Sub extends IslandBase { ... }` at module top level: the class is
 * a JavaScript constructor (nodeIsland.subclass) whose instances
 * Reflect.construct makes through the island base, so island code sees an
 * instance of the base and `instanceof` holds on both sides. Its
 * constructor, field initializers, methods and accessors are native
 * closures (receivers read through dyn.this); `Sub` and its instances are
 * island values (boundary.ts marks the declaration foreign), so member
 * operations on them, `this.x` included, are island operations. */

/** The extends clause of a top-level class whose base is an island class
 * (or another such subclass), or null. */
export function islandSubclassHeritage(
  lowerer: Lowerer,
  decl: ts.ClassDeclaration,
): ts.ExpressionWithTypeArguments | null {
  const islands = lowerer.nodeIslands;
  if (islands === null || decl.name === undefined || !ts.isSourceFile(decl.parent)) return null;
  const t = extendsElementOf(decl);
  if (t === undefined) return null;
  if (!isForeignType(islands, lowerer.typeOf(t.expression), lowerer.checker)) return null;
  return t;
}

/** Registers a top-level island subclass (splitFiles, before any type
 * maps): true when `decl` is one. */
export function noteIslandSubclass(lowerer: Lowerer, decl: ts.ClassDeclaration): boolean {
  if (isIslandSubclassDecl(decl)) return true;
  if (islandSubclassHeritage(lowerer, decl) === null) return false;
  markIslandSubclass(decl);
  return true;
}

function islandSubclassGlobal(lowerer: Lowerer, ident: ts.Identifier): IrGlobal | null {
  const symbol = lowerer.resolveValueSymbol(ident);
  const decl = symbol?.declarations.find(ts.isClassDeclaration);
  if (decl === undefined || !isIslandSubclassDecl(decl)) return null;
  return lowerer.globalsByDeclNode.get(decl) ?? null;
}

function memberName(m: ts.ClassElement): string | null {
  const name = m.name;
  if (name === undefined) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return null;
}

/** What NI-5b does not build yet, or null. */
function islandSubclassRefusal(decl: ts.ClassDeclaration): { node: ts.Node; what: string } | null {
  for (const m of decl.members.nodes) {
    if (ts.isSemicolonClassElement(m)) continue;
    const mods = m.modifiers?.nodes ?? [];
    if (mods.some((x) => x.kind === ts.SyntaxKind.StaticKeyword))
      return { node: m, what: "static members" };
    if (mods.some((x) => x.kind === ts.SyntaxKind.Decorator))
      return { node: m, what: "decorators" };
    if (ts.isConstructorDeclaration(m)) {
      if (m.parameters.nodes.some((p) => (p.modifiers?.nodes.length ?? 0) > 0))
        return { node: m, what: "constructor parameter properties" };
      continue;
    }
    if (ts.isIndexSignatureDeclaration(m)) continue;
    if (
      ts.isMethodDeclaration(m) ||
      ts.isPropertyDeclaration(m) ||
      ts.isGetAccessorDeclaration(m) ||
      ts.isSetAccessorDeclaration(m)
    ) {
      if (memberName(m) === null) return { node: m, what: "private or computed member names" };
      continue;
    }
    return { node: m, what: "this kind of member" };
  }
  return null;
}

/** A closure over a fresh native function whose body `build` makes, with
 * `this` read from the call's receiver (dyn.this). */
function receiverFn(
  lowerer: Lowerer,
  name: string,
  loc: SrcLoc,
  build: (self: IrExpr) => IrStmt[],
): IrExpr {
  const type = funcTypeFromParamShapes([], VOID);
  const ctx = newFnCtx(true, null, type, VOID);
  lowerer.fnStack.push(ctx);
  try {
    const self = lowerer.declareThis(DYN);
    const body: IrStmt[] = [
      {
        kind: "varDecl",
        localId: self.id,
        init: { kind: "libCall", fn: "dyn.this", args: [], type: DYN, loc },
        loc,
      },
      ...build(varRef(self.id, DYN, loc)),
      { kind: "return", value: null, loc },
    ];
    lowerer.liftedFns.push({
      name,
      params: [],
      returnType: VOID,
      locals: ctx.locals,
      captures: ctx.captures!,
      body,
      loc,
    });
    return { kind: "closure", fnName: name, captures: ctx.captureSources, type, loc };
  } finally {
    lowerer.fnStack.pop();
  }
}

/** Whether the checker types a function's result as an island value: an
 * instance of a class an island declares, or of a program class that
 * extends one (both are island objects wherever they go). */
export function returnsIslandValue(lowerer: Lowerer, node: ts.SignatureDeclaration): boolean {
  const islands = lowerer.nodeIslands;
  if (islands === null) return false;
  const signature = lowerer.checker.getSignatureFromDeclaration(node);
  if (signature === undefined) return false;
  const result = lowerer.checker.getReturnTypeOfSignature(signature);
  if (isForeignType(islands, result, lowerer.checker)) return true;
  const decl = result.getSymbol()?.declarations.find(ts.isClassDeclaration);
  return decl !== undefined && isIslandSubclassDecl(decl);
}

/** `method.length` where the method belongs to a class that extends an
 * island class and has a default or rest parameter: the read is answered
 * from the method's parameter count, where Node stops counting at that
 * parameter. Refused by name (the class's own `length` is its
 * constructor's, as in Node). */
function refuseIslandMethodLength(lowerer: Lowerer, expr: ts.PropertyAccessExpression): void {
  const receiver = lowerer.typeOf(expr.expression);
  if ((receiver.flags & ts.TypeFlags.Object) === 0) return;
  for (const signature of lowerer.checker.getCallSignatures(receiver)) {
    const declaration = signature.declaration;
    if (
      declaration !== undefined &&
      ts.isMethodDeclaration(declaration) &&
      isIslandSubclassDecl(declaration.parent) &&
      declaration.parameters.nodes.some((p) => p.initializer !== undefined || p.dotDotDotToken)
    )
      boundaryFail(
        lowerer,
        `the 'length' of '${memberName(declaration) ?? "a method"}', a method with a default or rest parameter of a class that extends an island class,`,
        expr,
      );
  }
}

/** A constructor or method as the checked-dynamic function the JavaScript
 * class calls. The box reports its parameter count as its `length`; Node
 * stops counting at the first default or rest parameter, so a member with
 * one carries the length Node reports (the host gives the class its
 * constructor's). */
function boxedMember(lowerer: Lowerer, member: ts.MethodDeclaration): IrExpr {
  const lambda = lowerer.lowerLambda(member, true);
  const boxed = lowerer.coerceToExpected(lambda, DYN);
  if (boxed.kind !== "dynFrom" || lambda.type.kind !== "func") return boxed;
  const params = member.parameters.nodes.filter(
    (p) => !(ts.isIdentifier(p.name) && p.name.text === "this"),
  );
  const stop = params.findIndex((p) => p.initializer !== undefined || p.dotDotDotToken);
  const length = stop === -1 ? params.length : stop;
  const counted = lambda.type.params.length - (lambda.type.restAbi === "typed" ? 1 : 0);
  return length === counted ? boxed : { ...boxed, fnLength: length };
}

/** The statement that creates the class: its module global assigned the
 * JavaScript constructor. */
export function lowerIslandSubclass(lowerer: Lowerer, decl: ts.ClassDeclaration): IrStmt {
  const loc = locOf(decl);
  const heritage = islandSubclassHeritage(lowerer, decl)!;
  const global = lowerer.globalsByDeclNode.get(decl);
  const refusal = islandSubclassRefusal(decl);
  if (refusal !== null || global === undefined) {
    lowerer.pushDiag(
      nativeSubclassOfIslandDiag(
        locOf(refusal?.node ?? heritage),
        refusal?.what ?? "this declaration form",
      ),
    );
    throw new PoisonError();
  }
  lowerer.usesNodeIsland = true;
  const className = decl.name!.text;
  const base = lowerer.coerceToExpected(lowerer.lowerExpr(heritage.expression), DYN);
  const methods: { key: IrExpr; value: IrExpr }[] = [];
  const getters: { key: IrExpr; value: IrExpr }[] = [];
  const setters: { key: IrExpr; value: IrExpr }[] = [];
  const fields: ts.PropertyDeclaration[] = [];
  let ctor: IrExpr = dynUndefinedExpr(loc);
  const key = (name: string): IrExpr => ({ kind: "strLit", value: name, type: STRING, loc });
  for (const m of decl.members.nodes) {
    if (ts.isConstructorDeclaration(m)) {
      if (m.body === undefined) continue;
      ctor = boxedMember(lowerer, m as unknown as ts.MethodDeclaration);
    } else if (ts.isMethodDeclaration(m)) {
      if (m.body === undefined) continue;
      methods.push({ key: key(memberName(m)!), value: boxedMember(lowerer, m) });
    } else if (ts.isGetAccessorDeclaration(m)) {
      if (m.body === undefined) continue;
      getters.push({
        key: key(memberName(m)!),
        value: lowerer.coerceToExpected(lowerer.lowerLambda(m, true), DYN),
      });
    } else if (ts.isSetAccessorDeclaration(m)) {
      if (m.body === undefined) continue;
      setters.push({
        key: key(memberName(m)!),
        value: lowerer.coerceToExpected(lowerer.lowerLambda(m, true), DYN),
      });
    } else if (ts.isPropertyDeclaration(m)) {
      const mods = m.modifiers?.nodes ?? [];
      if (mods.some((x) => x.kind === ts.SyntaxKind.DeclareKeyword)) continue;
      fields.push(m);
    }
  }
  const fieldsFn: IrExpr =
    fields.length === 0
      ? dynUndefinedExpr(loc)
      : lowerer.coerceToExpected(
          receiverFn(lowerer, `%island.fields:${className}`, loc, (self) =>
            fields.map((f) => ({
              kind: "exprStmt",
              expr: {
                kind: "libCall",
                fn: "nodeIsland.defineField",
                args: [
                  self,
                  key(memberName(f)!),
                  f.initializer !== undefined
                    ? toIsland(lowerer, f.initializer)
                    : dynUndefinedExpr(locOf(f)),
                ],
                type: VOID,
                loc: locOf(f),
              },
              loc: locOf(f),
            })),
          ),
          DYN,
        );
  const obj = (entries: { key: IrExpr; value: IrExpr }[]): IrExpr => ({
    kind: "dynObjLit",
    fields: entries,
    type: DYN,
    loc,
  });
  return {
    kind: "assign",
    localId: global.id,
    value: {
      kind: "libCall",
      fn: "nodeIsland.subclass",
      args: [base, key(className), ctor, fieldsFn, obj(methods), obj(getters), obj(setters)],
      type: DYN,
      loc,
    },
    loc,
  };
}

/** The function whose `this` an expression inside a class member sees,
 * when that class is an island subclass. */
function islandSubclassMember(node: ts.Node): ts.FunctionLikeDeclaration | null {
  let n: ts.Node | undefined = node.parent;
  while (n !== undefined && ts.isArrowFunction(n)) n = n.parent;
  while (n !== undefined && !ts.isFunctionLike(n)) {
    n = n.parent;
    while (n !== undefined && ts.isArrowFunction(n)) n = n.parent;
  }
  if (n === undefined || !ts.isClassDeclaration(n.parent!) || !isIslandSubclassDecl(n.parent))
    return null;
  return n as ts.FunctionLikeDeclaration;
}

/** super(...) in an island subclass's constructor: the instance comes from
 * the island base (Reflect.construct with the subclass as new.target) and
 * becomes `this`. */
export function lowerIslandSuperCall(lowerer: Lowerer, call: ts.CallExpression): IrExpr | null {
  if (lowerer.nodeIslands === null) return null;
  const member = islandSubclassMember(call);
  if (member === null || !ts.isConstructorDeclaration(member)) return null;
  const self = lowerer.resolveThis(call);
  if (self === null) return null;
  (self as { mutable: boolean }).mutable = true;
  const loc = locOf(call);
  const value: IrExpr = {
    kind: "libCall",
    fn: "nodeIsland.superConstruct",
    args: [varRef(self.id, DYN, loc), argsOf(lowerer, call.arguments.nodes, loc)],
    type: DYN,
    loc,
  };
  return {
    kind: "seqExpr",
    stmts: [{ kind: "assign", localId: self.id, value, loc }],
    result: varRef(self.id, DYN, loc),
    type: DYN,
    loc,
  };
}

/** super.name(...) in an island subclass member: the base prototype's
 * method on this instance. */
export function lowerIslandSuperMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (lowerer.nodeIslands === null || !ts.isIdentifier(access.name)) return null;
  const member = islandSubclassMember(call);
  if (member === null) return null;
  const heritage = islandSubclassHeritage(lowerer, member.parent as ts.ClassDeclaration);
  const self = lowerer.resolveThis(call);
  if (heritage === null || self === null) return null;
  const loc = locOf(call);
  const raw: IrExpr = {
    kind: "libCall",
    fn: "nodeIsland.superMethod",
    args: [
      lowerer.coerceToExpected(lowerer.lowerExpr(heritage.expression), DYN),
      varRef(self.id, DYN, loc),
      { kind: "strLit", value: access.name.text, type: STRING, loc },
      argsOf(lowerer, call.arguments.nodes, loc),
    ],
    type: DYN,
    loc,
  };
  return fromIsland(lowerer, raw, call);
}

/** A literal freshLiteral copies member by member: identifier or string
 * keys with values, shorthand properties, array elements without spreads
 * or holes. */
function plainLiteral(node: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression): boolean {
  if (ts.isArrayLiteralExpression(node))
    return node.elements.nodes.every(
      (el) => !ts.isSpreadElement(el) && !ts.isOmittedExpression(el),
    );
  return node.properties.nodes.every(
    (p) =>
      (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) ||
      ts.isShorthandPropertyAssignment(p),
  );
}

/** The specifier of `x = require("spec")` (a variable declaration binding
 * an identifier to a literal require), or null. Whether the binding keeps
 * the module is keepsRequiredModule's question, asked once the specifier
 * names an island module. */
function requireSpecOf(checker: ts.TypeChecker, decl: ts.VariableDeclaration): string | null {
  if (!ts.isIdentifier(decl.name) || !ts.isVariableDeclarationList(decl.parent)) return null;
  return requireInitSpecOf(checker, decl);
}

/** Whether the names `decl` binds hold the required module for good, so
 * each is the module (or its member) at every use: a `const`, or a `let` or
 * `var` that nothing in its file writes again (binding-writes.ts: an
 * assignment, an update, a loop target or a second initializing
 * declaration). ES5-style CommonJS declares every require with `var`. A
 * binding that is written keeps the ordinary lowering.
 *
 * Shortcut: a read of such a `var` before its statement runs (a hoisted
 * function called above the declaration) finds the module global unassigned
 * and stops the program, where Node reads undefined; a `const` stops there
 * in Node too. */
function keepsRequiredModule(
  islands: NodeIslandSet,
  checker: ts.TypeChecker,
  decl: ts.VariableDeclaration,
): boolean {
  const list = decl.parent;
  if (!ts.isVariableDeclarationList(list)) return false;
  if ((list.flags & ts.NodeFlags.Const) !== 0) return true;
  const file = ts.getSourceFileOfNode(decl);
  const names = ts.isIdentifier(decl.name)
    ? [decl.name]
    : ts.isObjectBindingPattern(decl.name)
      ? decl.name.elements.nodes.map((e) => e.name)
      : [];
  if (names.length === 0) return false;
  for (const name of names) {
    if (name === undefined || !ts.isIdentifier(name)) return false;
    const symbol = checker.getSymbolAtLocation(name);
    if (symbol === undefined) return false;
    const answers = (islands.bindingsNeverWritten ??= new Map<object, boolean>());
    let unwritten = answers.get(symbol);
    if (unwritten === undefined) {
      unwritten = !fileWritesBinding(symbol, file, (ident) => bindingSymbolOf(checker, ident));
      answers.set(symbol, unwritten);
    }
    if (!unwritten) return false;
  }
  return true;
}

/** The property a destructured CommonJS require binds: `name` in
 * `const { name } = require("spec")` or `const { name: local } = …`, with
 * the declaration. Rest elements, defaults and nested patterns are null. */
function requiredPropertyOf(
  decl: ts.Node,
): { name: string; declaration: ts.VariableDeclaration } | null {
  if (!ts.isBindingElement(decl) || decl.dotDotDotToken || decl.initializer) return null;
  if (!ts.isIdentifier(decl.name)) return null;
  const pattern = decl.parent;
  if (pattern === undefined || !ts.isObjectBindingPattern(pattern)) return null;
  const declaration = pattern.parent;
  if (declaration === undefined || !ts.isVariableDeclaration(declaration)) return null;
  const key = decl.propertyName;
  const name =
    key === undefined
      ? decl.name.text
      : ts.isIdentifier(key) || ts.isStringLiteral(key)
        ? key.text
        : null;
  return name === null ? null : { name, declaration };
}

/** Whether every element of `const { … } = require("<island>")` binds a
 * plain member (requiredPropertyOf): only then do the names read the
 * module global; other patterns keep the ordinary lowering. */
function islandPatternBindable(pattern: ts.ObjectBindingPattern): boolean {
  return pattern.elements.nodes.every((e) => requiredPropertyOf(e) !== null);
}

/** Whether the top-level declaration `decl` of a JavaScript module loads
 * its island module at the statement (lowerIslandRequireAtStatement)
 * rather than in the module's %init prelude: declarations binding an
 * identifier or a plain object pattern, when the binding keeps the module
 * (keepsRequiredModule, which every caller asks once the specifier names an
 * island module). Reads of a `const` before the statement are TDZ errors in
 * Node, so that binding is never observed unassigned. */
function loadsAtStatement(decl: ts.VariableDeclaration): boolean {
  const list = decl.parent;
  if (list === undefined || !ts.isVariableDeclarationList(list)) return false;
  if (!isJsSourceFile(ts.getSourceFileOfNode(decl))) return false;
  if (ts.isIdentifier(decl.name)) return true;
  return ts.isObjectBindingPattern(decl.name) && islandPatternBindable(decl.name);
}

/** The top-level statement `const x = require("<island>")` or `const { a,
 * b: c } = require("<island>")` of a JavaScript module: assigns the island
 * module (deferred like any top-level require) to its module global at the
 * statement's position, so writes before it (`process.env.NODE_ENV = …`)
 * are visible to the module's evaluation, as in Node; `x` is the module,
 * `a` and `c` read its members at each use (shortcut: not copied once at
 * the declaration). Null for any other declaration. */
export function lowerIslandRequireAtStatement(
  lowerer: Lowerer,
  decl: ts.VariableDeclaration,
): IrStmt | null {
  const islands = lowerer.nodeIslands;
  if (islands === null || !loadsAtStatement(decl)) return null;
  const spec = requireInitSpecOf(lowerer.checker, decl);
  if (spec === null) return null;
  const path = islandModuleFile(islands, ts.getSourceFileOfNode(decl).fileName, spec, "require");
  const module = path === null ? undefined : lowerer.islandModules.get(path);
  if (path === null || module === undefined) return null;
  if (!keepsRequiredModule(islands, lowerer.checker, decl)) return null;
  const loc = locOf(decl);
  const load = runsAtModuleEvaluation(decl)
    ? deferIslandModule(lowerer, path, loc)
    : loadIslandModule(lowerer, path, loc);
  return { kind: "assign", localId: module.global.id, value: load, loc };
}

/** The specifier of a variable declaration initialized with a literal
 * `require("spec")`, whatever its binding name or pattern, or null. */
function requireInitSpecOf(checker: ts.TypeChecker, decl: ts.VariableDeclaration): string | null {
  if (decl.initializer === undefined) return null;
  let init: ts.Expression = decl.initializer;
  while (ts.isParenthesizedExpression(init)) init = init.expression;
  if (
    !ts.isCallExpression(init) ||
    !ts.isIdentifier(init.expression) ||
    init.expression.text !== "require" ||
    init.arguments.nodes.length !== 1
  )
    return null;
  // The global require, not a function of the program named require.
  if (
    checker
      .getSymbolAtLocation(init.expression)
      ?.declarations.some((d) => !ts.getSourceFileOfNode(d).isDeclarationFile)
  )
    return null;
  const arg = init.arguments.nodes[0]!;
  return ts.isStringLiteralLike(arg) ? arg.text : null;
}

/** Top-level `const x = require("pkg")` statements of island packages in a
 * compiled module (a native package requiring an island package): load the
 * island module in the module's %init prelude (shortcut: before the body,
 * not at the statement; JavaScript `const` declarations load at the
 * statement instead, loadsAtStatement), deferred exactly like a static import (scope-B
 * NI-7d: the build decides from the probe, stubs stand in until first use). */
export function collectIslandRequires(lowerer: Lowerer, sf: ts.SourceFile): void {
  const islands = lowerer.nodeIslands;
  if (islands === null) return;
  for (const stmt of sf.statements.nodes) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations.nodes) {
      // JavaScript `const` requires: the module global exists from
      // here on; the statement itself loads the module at its position
      // (lowerIslandRequireAtStatement).
      if (loadsAtStatement(decl)) {
        const spec = requireInitSpecOf(lowerer.checker, decl);
        const path = spec === null ? null : islandModuleFile(islands, sf.fileName, spec, "require");
        if (path !== null && keepsRequiredModule(islands, lowerer.checker, decl)) {
          lowerer.noteIslandOnWorkerThread(spec!, decl);
          lowerer.usesNodeIsland = true;
          islandModuleGlobal(lowerer, path);
        }
        continue;
      }
      const spec = requireSpecOf(lowerer.checker, decl);
      if (spec === null) continue;
      const path = islandModuleFile(islands, sf.fileName, spec, "require");
      if (path === null || !keepsRequiredModule(islands, lowerer.checker, decl)) continue;
      lowerer.noteIslandOnWorkerThread(spec, decl);
      lowerer.usesNodeIsland = true;
      const loc = locOf(decl);
      const binding = islandModuleGlobal(lowerer, path);
      const actions = lowerer.jsonInitActions.get(sf) ?? [];
      lowerer.jsonInitActions.set(sf, actions);
      actions.push({
        kind: "assign",
        localId: binding.global.id,
        value: deferIslandModule(lowerer, path, loc),
        loc,
      });
    }
  }
}

/* `x instanceof Error` for values that may be island objects (NI-5c). */
const INTRINSIC_ERRORS = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "EvalError",
  "URIError",
  "AggregateError",
]);

/** The name of the builtin Error class an expression names (the global, not
 * a shadowing binding), or null. */
function intrinsicErrorClassOf(lowerer: Lowerer, node: ts.Expression): string | null {
  const inner = withoutParenthesesTypeWrappers(node);
  if (!ts.isIdentifier(inner) || !INTRINSIC_ERRORS.has(inner.text)) return null;
  const decl = lowerer.checker.getSymbolAtLocation(inner)?.declarations[0];
  if (decl === undefined || !ts.getSourceFileOfNode(decl).isDeclarationFile) return null;
  return inner.text;
}

/** The name of the standard library class an expression names (`Array`,
 * `Map`, `Date`, …: the global, not a shadowing binding or an import), or
 * null. An island's instance of one is an island object, which only Node
 * can test against its own global of that name. */
function standardClassOf(lowerer: Lowerer, node: ts.Expression): string | null {
  const inner = withoutParenthesesTypeWrappers(node);
  if (!ts.isIdentifier(inner) || !lowerer.isStdlibGlobal(inner, inner.text)) return null;
  const type = lowerer.checker.getTypeAtLocation(inner);
  return lowerer.checker.getConstructSignatures(type).length > 0 ? inner.text : null;
}

/** `e.message` on a catch binding narrowed to a native type (`if (e
 * instanceof Error)`): the thrown value may be an island object (an
 * instance of a native subclass of an island error class), whose members
 * are island reads; anything else takes the ordinary narrowed read. */
function islandCaughtRead(lowerer: Lowerer, expr: ts.PropertyAccessExpression): IrExpr | null {
  if (lowerer.islandInstanceofHandled.has(expr) || expr.questionDotToken) return null;
  const receiver = withoutParenthesesTypeWrappers(expr.expression);
  if (!ts.isIdentifier(receiver)) return null;
  const caught = lowerer.caughtLocalOf(receiver);
  if (caught === null || isForeignExpr(lowerer, receiver)) return null;
  const tsType = lowerer.typeOf(expr);
  const mapped = lowerer.mapTypeOf(tsType);
  if (mapped === null || !copiedType(lowerer, mapped)) return null;
  lowerer.islandInstanceofHandled.add(expr);
  let ordinary: IrExpr;
  try {
    ordinary = lowerer.lowerExpr(expr);
  } finally {
    lowerer.islandInstanceofHandled.delete(expr);
  }
  const loc = locOf(expr);
  const value: IrExpr = {
    kind: "caughtToDyn",
    value: varRef(caught.id, caught.type, loc),
    type: DYN,
    loc,
  };
  lowerer.usesNodeIsland = true;
  return {
    kind: "ternary",
    cond: { kind: "libCall", fn: "nodeIsland.isHandle", args: [value], type: BOOL, loc },
    then: lowerer.coerceToExpected(islandGet(value, expr.name.text, loc), ordinary.type),
    else_: ordinary,
    type: ordinary.type,
    loc,
  };
}
