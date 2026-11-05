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
import { isJsSourceFile, locOf } from "../program.js";
import { isRelativeSpecifier } from "../workspace-registry.js";
import type { NodeApiMember } from "../node-api-import.js";
import { PoisonError, newFnCtx, type Lowerer } from "./lowerer.js";
import {
  BOOL,
  DYN,
  FOREIGN,
  STRING,
  VOID,
  type IrExpr,
  type IrGlobal,
  type IrLocal,
  type IrStmt,
  type IrType,
  type SrcLoc,
} from "../../ir/ir.js";
import { dynUndefinedExpr, varRef } from "../../ir/build.js";
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
  isForeignType,
  isIslandProgramModule,
  isIslandSubclassDecl,
  markIslandSubclass,
  islandOwnerOfFile,
  type NodeIslandSet,
} from "../../node-islands/boundary.js";
import { stripTypeWrappers } from "./typed-arguments.js";
import { thenReader } from "./checked-promise-all.js";
import { dynCompoundValue } from "./lower-exprs.js";
import { COMPOUND_ASSIGN_OPS } from "./surfaces.js";

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
  lowerer.usesNodeIsland = true;
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
  lowerer.usesNodeIsland = true;
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
function islandModuleGlobal(lowerer: Lowerer, path: string): IslandModuleBinding {
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
 * A program module that runs in an island loads eagerly
 * (`nodeIsland.require`): deciding a deferral means evaluating the module
 * in the build-time probe, and the build never runs the program's own
 * source. */
function deferIslandModule(lowerer: Lowerer, path: string, loc: SrcLoc): IrExpr {
  const islands = lowerer.nodeIslands;
  if (islands !== null && isIslandProgramModule(islands, path))
    return loadIslandModule(lowerer, path, loc);
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
    lowerer.usesNodeIsland = true;
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
  lowerer.usesNodeIsland = true;
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

function islandGet(target: IrExpr, key: string, loc: SrcLoc): IrExpr {
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

/** The island binding an alias chain reaches, or null: a name re-exported
 * by a native module resolves to the island's export symbol itself. */
function islandReexportOf(lowerer: Lowerer, symbol: ts.Symbol | undefined): IslandBinding | null {
  if (symbol === undefined || lowerer.islandReexports.size === 0) return null;
  const seen = new Set<ts.Symbol>();
  let s: ts.Symbol | undefined = symbol;
  while (s !== undefined && !seen.has(s)) {
    seen.add(s);
    const bound = lowerer.islandReexports.get(s);
    if (bound !== undefined) return bound;
    if ((s.flags & ts.SymbolFlags.Alias) === 0) return null;
    s = lowerer.checker.getAliasedSymbol(s);
  }
  return null;
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

function islandBindingOf(lowerer: Lowerer, ident: ts.Identifier): IslandBinding | null {
  const islands = lowerer.nodeIslands;
  if (islands === null) return null;
  const symbol = lowerer.checker.getSymbolAtLocation(ident);
  // A name a native module re-exports from an island package binds the
  // island's own export: the import's alias chain reaches it.
  const reexport = islandReexportOf(lowerer, symbol);
  if (reexport !== null) return reexport;
  const decl = symbol ? symbol.declarations[0] : undefined;
  if (decl === undefined) return null;
  let importDecl: ts.Node | undefined;
  let binding: "namespace" | "default" | { name: string };
  if (ts.isNamespaceImport(decl)) {
    importDecl = decl.parent?.parent;
    binding = "namespace";
  } else if (ts.isImportClause(decl)) {
    importDecl = decl.parent;
    binding = "default";
  } else if (ts.isImportSpecifier(decl)) {
    importDecl = decl.parent?.parent?.parent;
    const name = decl.propertyName?.text ?? decl.name.text;
    binding = name === "default" ? "default" : { name };
  } else {
    // `const { name } = require("pkg")`: a member of module.exports, read
    // at each use (shortcut: not copied once at the declaration).
    const property = requiredPropertyOf(decl);
    if (property !== null && loadsAtStatement(property.declaration)) {
      const spec = requireInitSpecOf(lowerer, property.declaration);
      if (spec === null) return null;
      const file = ts.getSourceFileOfNode(decl).fileName;
      const path = islandModuleFile(islands, file, spec, "require");
      const module = path === null ? undefined : lowerer.islandModules.get(path);
      return module === undefined ? null : { kind: "named", module, name: property.name };
    }
    // `const x = require("pkg")` (a CommonJS module of a native package
    // requiring an island package): x is module.exports. Only at the
    // module's top level: a function's own binding is a local.
    const statement = decl.parent?.parent;
    if (statement === undefined || !ts.isSourceFile(statement.parent)) return null;
    const spec = requireSpecOf(lowerer, decl);
    if (spec === null) return null;
    const path = islandModuleFile(islands, ts.getSourceFileOfNode(decl).fileName, spec, "require");
    const module = path === null ? undefined : lowerer.islandModules.get(path);
    return module === undefined ? null : { kind: "required", module };
  }
  const spec = moduleSpecifierOf(importDecl);
  if (spec === null || importDecl === undefined) return null;
  const path = islandModuleFile(
    islands,
    ts.getSourceFileOfNode(importDecl).fileName,
    spec,
    "import",
  );
  if (path === null) return null;
  const module = lowerer.islandModules.get(path);
  if (module === undefined) return null;
  if (binding === "namespace") return { kind: "namespace", module };
  if (binding === "default") return { kind: "default", module };
  return { kind: "named", module, name: binding.name };
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

/** An island value (dyn) at the declared type of `node`: island handles
 * stay dyn (FOREIGN), primitives and strings meet their declared type
 * through the checked conversion. */
function fromIsland(lowerer: Lowerer, raw: IrExpr, node: ts.Expression): IrExpr {
  const tsType = lowerer.typeOf(node);
  const islands = lowerer.nodeIslands!;
  if (isForeignType(islands, tsType, lowerer.checker)) return raw;
  if ((tsType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) return raw;
  if ((tsType.flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined)) !== 0 && isDiscarded(node))
    return raw;
  const mapped = lowerer.mapTypeOf(tsType);
  if (mapped === null) {
    // An intersection of containers (`Choice[] & GenChoice[]`: the
    // island's array extended by the caller's own type) has no native
    // representation of its own. Where the program only uses it through
    // island operations it stays a handle, like an array the island does
    // not declare.
    if (containerType(lowerer, tsType) && handleUseOk(lowerer, node)) return raw;
    boundaryFail(
      lowerer,
      `an island value of type '${lowerer.checker.typeToString(tsType)}'`,
      node,
    );
  }
  if (mapped.kind === "dyn") return raw;
  if (mapped.kind === "void") return raw;
  // An island promise is the same promise on both sides (the runtime keeps
  // one ScrPromise per V8 promise): PromiseResolve of the dyn value, whose
  // settlement value meets the declared type when it is awaited.
  if (
    mapped.kind === "promise" &&
    (mapped.inner.kind === "dyn" || copiedType(lowerer, mapped.inner))
  ) {
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
  if (!copiedType(lowerer, mapped) && copiedRecordType(lowerer, tsType))
    return lowerer.coerceToExpected(raw, mapped);
  if (!copiedType(lowerer, mapped))
    boundaryFail(
      lowerer,
      `an island value of type '${lowerer.checker.typeToString(tsType)}' (only primitives and strings are copied; objects of types the island does not declare stay handles from NI-5 on)`,
      node,
    );
  return lowerer.coerceToExpected(raw, mapped);
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
    // Buffers and typed arrays share their memory with the V8 view.
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

/** Whether `node` evaluates to an island handle (by its declared type) or
 * is an island namespace binding. */
function isForeignExpr(lowerer: Lowerer, node: ts.Expression): boolean {
  const islands = lowerer.nodeIslands;
  if (islands === null) return false;
  const inner = stripTypeWrappers(node);
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
      isIslandPromisifyCall(lowerer, stripTypeWrappers(decl.initializer))
    )
      return true;
  }
  if (isForeignType(islands, lowerer.typeOf(inner), lowerer.checker)) return true;
  if (ts.isIdentifier(inner)) return islandHandleBinding(lowerer, inner);
  return isIslandHandleExpr(lowerer, inner);
}

/** Whether a value of TypeScript type `type` coming out of an island is
 * an object the island does not declare and the program cannot take by
 * reference natively (arrays, tuples, Maps, Sets): it stays a handle. */
function undeclaredHandleType(lowerer: Lowerer, type: ts.Type): boolean {
  if ((type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) return false;
  if (isForeignType(lowerer.nodeIslands!, type, lowerer.checker)) return false;
  const mapped = lowerer.mapTypeOf(type);
  if (mapped === null || mapped.kind === "dyn" || mapped.kind === "void") return false;
  if (mapped.kind === "promise" || copiedType(lowerer, mapped)) return false;
  return containerType(lowerer, type);
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

/** A member read, call, index or `new` whose receiver or callee is an
 * island value. */
function islandRooted(lowerer: Lowerer, node: ts.Expression): boolean {
  const e = stripTypeWrappers(node);
  if (ts.isCallExpression(e)) {
    if (e.expression.kind === ts.SyntaxKind.ImportKeyword) return false;
    const callee = stripTypeWrappers(e.expression);
    if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee))
      return isForeignExpr(lowerer, callee.expression);
    return isForeignExpr(lowerer, callee);
  }
  if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e) || ts.isNewExpression(e))
    return isForeignExpr(lowerer, e.expression);
  return false;
}

/** An island operation whose result is an undeclared object (a handle). */
function isIslandHandleExpr(lowerer: Lowerer, node: ts.Expression): boolean {
  return islandRooted(lowerer, node) && undeclaredHandleType(lowerer, lowerer.typeOf(node));
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
    const inner = stripTypeWrappers(x);
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
    const c = stripTypeWrappers(callee);
    if (ts.isPropertyAccessExpression(c) || ts.isElementAccessExpression(c))
      return isForeignExpr(lowerer, c.expression);
    return isForeignExpr(lowerer, c);
  };
  if (ts.isCallExpression(p) || ts.isNewExpression(p))
    return p.expression === n || islandCallee(p.expression);
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
function toIsland(lowerer: Lowerer, node: ts.Expression): IrExpr {
  const islands = lowerer.nodeIslands!;
  const inner = stripTypeWrappers(node);
  if (ts.isObjectLiteralExpression(inner) || ts.isArrayLiteralExpression(inner)) {
    return freshLiteral(lowerer, inner);
  }
  if (
    (ts.isIdentifier(inner) && islandHandleBinding(lowerer, inner)) ||
    isIslandHandleExpr(lowerer, inner)
  )
    return lowerer.coerceToExpected(lowerer.lowerExpr(node), DYN);
  const crossing = crossingOf(islands, lowerer.typeOf(node), lowerer.checker);
  switch (crossing) {
    case "copy":
    case "handle":
      return lowerer.coerceToExpected(lowerer.lowerExpr(node), DYN);
    case "dyn":
      // NI-5: the runtime exports dyn objects by reference and copies only
      // primitives, strings and (for now) arrays.
      return lowerer.coerceToExpected(lowerer.lowerExpr(node), DYN);
    case "refused": {
      const type = lowerer.typeOf(node);
      // A type parameter the instance binds to dyn (a generic function
      // over island types, `<T extends TSchema>`): its values are dyn
      // values, and they cross the way `any` values do.
      if (
        (type.flags & ts.TypeFlags.TypeParameter) !== 0 &&
        lowerer.typeParamResolver(type)?.kind === "dyn"
      )
        return lowerer.coerceToExpected(lowerer.lowerExpr(node), DYN);
      // NI-5: closures, promises, records and class instances cross by
      // reference (scr_node_island_export.c): their dyn boxes keep the
      // native referent, and the closure's thunk checks its arguments.
      if (exportedByReference(lowerer, type)) {
        const lowered = lowerer.lowerExpr(node);
        const value = lowerer.coerceToExpected(lowered, DYN);
        return lowered.type.kind === "object"
          ? withClassMethods(lowerer, value, lowered.type.className, node)
          : value;
      }
      return boundaryFail(
        lowerer,
        `a '${lowerer.checker.typeToString(type)}' value (a native object would cross as a copy and lose its identity)`,
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
 * (`ident` is its declaration's name), or null. */
export function classMethodsBuilder(
  lowerer: Lowerer,
  ident: ts.Identifier,
  loc: SrcLoc,
): IrExpr | null {
  const decl = ident.parent;
  if (decl === undefined || !ts.isClassDeclaration(decl)) return null;
  return classMethodsBuilderOf(lowerer, lowerer.classNamer(decl), ident, loc);
}

/** NI-6: `new C(...)` from island code for the class a shared module
 * exports: a function with the constructor's parameters (its dyn thunk
 * checks the island's arguments) that constructs an instance, as a dyn
 * closure, or null when the constructor's shape is not a plain list of
 * parameters (the island's `new` then throws). */
export function classConstructHelper(
  lowerer: Lowerer,
  ident: ts.Identifier,
  loc: SrcLoc,
): IrExpr | null {
  const decl = ident.parent;
  if (decl === undefined || !ts.isClassDeclaration(decl)) return null;
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
      .every(
        (t) =>
          (t.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0 ||
          exportedByReference(lowerer, t),
      );
  if ((type.flags & ts.TypeFlags.Intersection) !== 0)
    return ts
      .constituentTypes(type)
      .every(
        (t) =>
          (t.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0 ||
          exportedByReference(lowerer, t),
      );
  if ((type.flags & ts.TypeFlags.Object) === 0) return false;
  // Arrays and tuples cross as Proxies over the native array (NI-5b).
  void checker;
  const name = type.getSymbol()?.escapedName;
  if (name === "WeakMap" || name === "WeakSet") return false;
  return true;
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
  const e = stripTypeWrappers(node);
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
    const recv = stripTypeWrappers(chain.recv);
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
      const ok = handleUseOk(lowerer, expr);
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
    const target = lowerer.lowerExpr(stripTypeWrappers(expr.expression));
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
    const callee = stripTypeWrappers(expr.expression);
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
      const global = intrinsicErrorClassOf(lowerer, expr.right);
      if (global !== null && !lowerer.islandInstanceofHandled.has(expr)) {
        const name: IrExpr = { kind: "strLit", value: global, type: STRING, loc };
        // An island value (an instance of a native subclass of an island
        // error class, say) answers as in Node.
        if (isForeignExpr(lowerer, expr.left)) {
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
        const left = stripTypeWrappers(expr.left);
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
      const left = stripTypeWrappers(expr.left);
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
        const target = lowerer.lowerExpr(stripTypeWrappers(left.expression));
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
        const result = fromIsland(lowerer, v, expr);
        return { kind: "seqExpr", stmts, result, type: result.type, loc };
      }
      return null;
    }
    const left = stripTypeWrappers(expr.left);
    if (
      op >= ts.SyntaxKind.FirstCompoundAssignment &&
      op <= ts.SyntaxKind.LastCompoundAssignment &&
      (ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left)) &&
      isForeignExpr(lowerer, left.expression)
    ) {
      const cop = COMPOUND_ASSIGN_OPS[op];
      if (cop === undefined)
        boundaryFail(lowerer, "a logical assignment to an island object's member", expr);
      return islandCompoundAssign(lowerer, expr, left, cop, loc);
    }
  }
  return null;
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
    lowerer.coerceToExpected(lowerer.lowerExpr(stripTypeWrappers(left.expression)), DYN),
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
  const result = fromIsland(lowerer, next, expr);
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
  const inner = stripTypeWrappers(receiver);
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
  const t = decl.heritageClauses?.nodes.find((c) => c.token === ts.SyntaxKind.ExtendsKeyword)?.types
    ?.nodes[0];
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
      ctor = lowerer.coerceToExpected(
        lowerer.lowerLambda(m as unknown as ts.MethodDeclaration, true),
        DYN,
      );
    } else if (ts.isMethodDeclaration(m)) {
      if (m.body === undefined) continue;
      methods.push({
        key: key(memberName(m)!),
        value: lowerer.coerceToExpected(lowerer.lowerLambda(m, true), DYN),
      });
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
 * an identifier to a literal require), or null. */
function requireSpecOf(lowerer: Lowerer, decl: ts.Node): string | null {
  if (!ts.isVariableDeclaration(decl) || !ts.isIdentifier(decl.name)) return null;
  // Only a const keeps the module: a let or var can be reassigned.
  const list = decl.parent;
  if (!ts.isVariableDeclarationList(list) || (list.flags & ts.NodeFlags.Const) === 0) return null;
  return requireInitSpecOf(lowerer, decl);
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
 * rather than in the module's %init prelude: `const` declarations binding
 * an identifier or a plain object pattern. Reads before the statement are
 * TDZ errors in Node, so the binding is never observed unassigned. `let`
 * and `var` bindings can be reassigned: they keep the ordinary lowering. */
function loadsAtStatement(decl: ts.VariableDeclaration): boolean {
  const list = decl.parent;
  if (list === undefined || !ts.isVariableDeclarationList(list)) return false;
  if ((list.flags & ts.NodeFlags.Const) === 0) return false;
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
  const spec = requireInitSpecOf(lowerer, decl);
  if (spec === null) return null;
  const path = islandModuleFile(islands, ts.getSourceFileOfNode(decl).fileName, spec, "require");
  const module = path === null ? undefined : lowerer.islandModules.get(path);
  if (path === null || module === undefined) return null;
  const loc = locOf(decl);
  const load = runsAtModuleEvaluation(decl)
    ? deferIslandModule(lowerer, path, loc)
    : loadIslandModule(lowerer, path, loc);
  return { kind: "assign", localId: module.global.id, value: load, loc };
}

/** The specifier of a variable declaration initialized with a literal
 * `require("spec")`, whatever its binding name or pattern, or null. */
function requireInitSpecOf(lowerer: Lowerer, decl: ts.VariableDeclaration): string | null {
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
    lowerer.checker
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
        const spec = requireInitSpecOf(lowerer, decl);
        const path = spec === null ? null : islandModuleFile(islands, sf.fileName, spec, "require");
        if (path !== null) {
          lowerer.usesNodeIsland = true;
          islandModuleGlobal(lowerer, path);
        }
        continue;
      }
      const spec = requireSpecOf(lowerer, decl);
      if (spec === null) continue;
      const path = islandModuleFile(islands, sf.fileName, spec, "require");
      if (path === null) continue;
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
  const inner = stripTypeWrappers(node);
  if (!ts.isIdentifier(inner) || !INTRINSIC_ERRORS.has(inner.text)) return null;
  const decl = lowerer.checker.getSymbolAtLocation(inner)?.declarations[0];
  if (decl === undefined || !ts.getSourceFileOfNode(decl).isDeclarationFile) return null;
  return inner.text;
}

/** `e.message` on a catch binding narrowed to a native type (`if (e
 * instanceof Error)`): the thrown value may be an island object (an
 * instance of a native subclass of an island error class), whose members
 * are island reads; anything else takes the ordinary narrowed read. */
function islandCaughtRead(lowerer: Lowerer, expr: ts.PropertyAccessExpression): IrExpr | null {
  if (lowerer.islandInstanceofHandled.has(expr) || expr.questionDotToken) return null;
  const receiver = stripTypeWrappers(expr.expression);
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
