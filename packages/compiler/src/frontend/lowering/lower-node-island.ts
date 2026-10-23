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
 * specifiers resolve from it; the result crosses as its JSON copy and is
 * checked against the declared result type, like `JSON.parse(s) as T`; a
 * thrown Error crosses as its nearest intrinsic class with its message and
 * string `code`. */
import { readFileSync, realpathSync } from "node:fs";
import { resolveFrom } from "../../node-islands/resolve.js";
import { dirname, join } from "node:path";
import * as ts from "../ts7/adapter.js";
import { locOf } from "../program.js";
import type { NodeApiMember } from "../node-api-import.js";
import { PoisonError, type Lowerer } from "./lowerer.js";
import {
  BOOL,
  DYN,
  FOREIGN,
  STRING,
  type IrExpr,
  type IrGlobal,
  type IrStmt,
  type IrType,
  type SrcLoc,
} from "../../ir/ir.js";
import { varRef } from "../../ir/build.js";
import { resolveBareModule } from "../resolve.js";
import { nodeIslandBoundaryDiag } from "../../diagnostics/diagnostic.js";
import {
  crossingOf,
  isForeignType,
  islandPackageOfFile,
  type NodeIslandSet,
} from "../../node-islands/boundary.js";
import { stripTypeWrappers } from "./typed-arguments.js";
import { thenReader } from "./checked-promise-all.js";

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
  const specifier = lowerer.lowerExprExpecting(argNodes[0]!, STRING);
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
  const raw: IrExpr = {
    kind: "libCall",
    fn: member === "call" ? "nodeIsland.call" : "nodeIsland.callSync",
    args: [
      { kind: "strLit", value: callerPath(call), type: STRING, loc },
      specifier,
      name,
      { kind: "dynArrLit", elems: values, type: DYN, loc },
    ],
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
 * resolves it from the caller, and the island loads that absolute path. */
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
    args: [{ kind: "strLit", value: path, type: STRING, loc }],
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
function isEsmFile(file: string): boolean {
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

/** The island module file `spec` names from `fromFile`, or null when the
 * specifier does not resolve into an island package. */
export function islandModuleFile(
  islands: NodeIslandSet,
  fromFile: string,
  spec: string,
  kind: "import" | "require",
): string | null {
  const js = resolveBareModule(fromFile, spec, "js-only", kind);
  if (js === null) return null;
  if (islandPackageOfFile(islands, js.typesFile) === null) return null;
  try {
    return realpathSync(js.typesFile);
  } catch {
    return js.typesFile;
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

function loadIslandModule(path: string, loc: SrcLoc): IrExpr {
  return {
    kind: "libCall",
    fn: "nodeIsland.require",
    args: [{ kind: "strLit", value: path, type: STRING, loc }],
    type: DYN,
    loc,
  };
}

/** A static import (or re-export) of an island package: loads the module
 * in the importer's %init prelude. Returns false when `spec` is not an
 * island module. */
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
    lowerer.pushDiag(
      nodeIslandBoundaryDiag(`re-exporting the Node island module '${spec}'`, locOf(stmt)),
    );
    return true;
  }
  lowerer.usesNodeIsland = true;
  const loc = locOf(stmt);
  const binding = islandModuleGlobal(lowerer, path);
  const actions = lowerer.jsonInitActions.get(sf) ?? [];
  lowerer.jsonInitActions.set(sf, actions);
  actions.push({
    kind: "assign",
    localId: binding.global.id,
    value: loadIslandModule(path, loc),
    loc,
  });
  // CommonJS named imports: Node's namespace snapshots them once the
  // module evaluated.
  const clause = ts.isImportDeclaration(stmt) ? stmt.importClause : undefined;
  const named = clause?.namedBindings;
  if (!binding.esm && named !== undefined && ts.isNamedImports(named)) {
    for (const el of named.elements.nodes) {
      if (el.isTypeOnly) continue;
      const name = el.propertyName?.text ?? el.name.text;
      if (name === "default") continue;
      let g = binding.snapshots.get(name);
      if (g === undefined) {
        g = {
          id: `%g.island.${lowerer.globalsList.length}`,
          name,
          type: DYN,
          mutable: true,
        };
        lowerer.globalsList.push(g);
        binding.snapshots.set(name, g);
      }
      actions.push({
        kind: "assign",
        localId: g.id,
        value: islandGet(varRef(binding.global.id, DYN, loc), name, loc),
        loc,
      });
    }
  }
  return true;
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

type IslandBinding =
  | { kind: "namespace"; module: IslandModuleBinding }
  | { kind: "default"; module: IslandModuleBinding }
  | { kind: "named"; module: IslandModuleBinding; name: string };

function moduleSpecifierOf(decl: ts.Node | undefined): string | null {
  return ts.isImportDeclaration(decl) && ts.isStringLiteral(decl.moduleSpecifier)
    ? decl.moduleSpecifier.text
    : null;
}

/** What an identifier binds from an island module, or null. */
function islandBindingOf(lowerer: Lowerer, ident: ts.Identifier): IslandBinding | null {
  const islands = lowerer.nodeIslands;
  if (islands === null) return null;
  const symbol = lowerer.checker.getSymbolAtLocation(ident);
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
    return null;
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
  if (mapped === null)
    boundaryFail(
      lowerer,
      `an island value of type '${lowerer.checker.typeToString(tsType)}'`,
      node,
    );
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
  if (!copiedType(lowerer, mapped))
    boundaryFail(
      lowerer,
      `an island value of type '${lowerer.checker.typeToString(tsType)}' (only primitives and strings are copied; objects of types the island does not declare stay handles from NI-5 on)`,
      node,
    );
  return lowerer.coerceToExpected(raw, mapped);
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
  if (ts.isIdentifier(inner) && islandBindingOf(lowerer, inner) !== null) return true;
  return isForeignType(islands, lowerer.typeOf(inner), lowerer.checker);
}

/** A value crossing INTO the island (an argument or an assigned value), as
 * dyn. */
function toIsland(lowerer: Lowerer, node: ts.Expression): IrExpr {
  const islands = lowerer.nodeIslands!;
  const inner = stripTypeWrappers(node);
  if (ts.isObjectLiteralExpression(inner) || ts.isArrayLiteralExpression(inner)) {
    return freshLiteral(lowerer, inner);
  }
  const crossing = crossingOf(islands, lowerer.typeOf(node), lowerer.checker);
  switch (crossing) {
    case "copy":
    case "handle":
      return lowerer.coerceToExpected(lowerer.lowerExpr(node), DYN);
    case "dyn":
    case "refused":
      return boundaryFail(
        lowerer,
        `a '${lowerer.checker.typeToString(lowerer.typeOf(node))}' value (a native object would cross as a copy and lose its identity)`,
        node,
      );
  }
}

/** A fresh object or array literal crosses as a copy (a plain dyn object
 * or array the runtime copies into V8): nothing native can alias it. Its
 * members cross by the same rules (toIsland). */
function freshLiteral(
  lowerer: Lowerer,
  node: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression,
): IrExpr {
  const loc = locOf(node);
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

function argsOf(lowerer: Lowerer, args: readonly ts.Expression[], loc: SrcLoc): IrExpr {
  for (const a of args) if (ts.isSpreadElement(a)) boundaryFail(lowerer, "spread arguments", a);
  return { kind: "dynArrLit", elems: args.map((a) => toIsland(lowerer, a)), type: DYN, loc };
}

/** Expressions on island values (the lowerExpr hook; null: not an island
 * expression, the ordinary lowering applies). */
export function lowerIslandExpr(lowerer: Lowerer, expr: ts.Expression): IrExpr | null {
  if (lowerer.nodeIslands === null) return null;
  const loc = locOf(expr);
  if (ts.isIdentifier(expr)) {
    const b = islandBindingOf(lowerer, expr);
    if (b === null) return null;
    lowerer.usesNodeIsland = true;
    return fromIsland(lowerer, islandBindingValue(lowerer, b, expr, loc), expr);
  }
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.name)) {
    if (!isForeignExpr(lowerer, expr.expression)) return null;
    if (expr.questionDotToken)
      boundaryFail(lowerer, "an optional member read on an island value", expr);
    lowerer.usesNodeIsland = true;
    const target = islandReceiver(lowerer, expr.expression, expr.name.text, loc);
    if (target.direct !== undefined) return fromIsland(lowerer, target.direct, expr);
    return fromIsland(lowerer, islandGet(target.value, expr.name.text, loc), expr);
  }
  if (ts.isElementAccessExpression(expr)) {
    if (!isForeignExpr(lowerer, expr.expression)) return null;
    if (expr.questionDotToken)
      boundaryFail(lowerer, "an optional member read on an island value", expr);
    lowerer.usesNodeIsland = true;
    const target = lowerer.lowerExpr(expr.expression);
    const key = toIsland(lowerer, expr.argumentExpression);
    return fromIsland(
      lowerer,
      { kind: "libCall", fn: "nodeIsland.getKey", args: [target, key], type: DYN, loc },
      expr,
    );
  }
  if (ts.isCallExpression(expr)) {
    const dynamicLoad = lowerIslandLoadCall(lowerer, expr, loc);
    if (dynamicLoad !== undefined) return dynamicLoad;
    const callee = stripTypeWrappers(expr.expression);
    if (expr.questionDotToken) return null;
    const args = expr.arguments.nodes;
    if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) {
      if (!isForeignExpr(lowerer, callee.expression)) return null;
      if (callee.questionDotToken)
        boundaryFail(lowerer, "an optional call on an island value", expr);
      lowerer.usesNodeIsland = true;
      const target = islandReceiver(lowerer, callee.expression, callee.name.text, loc);
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
      return fromIsland(
        lowerer,
        {
          kind: "libCall",
          fn: "nodeIsland.invoke",
          args: [
            target.value,
            { kind: "strLit", value: callee.name.text, type: STRING, loc },
            argsOf(lowerer, args, loc),
          ],
          type: DYN,
          loc,
        },
        expr,
      );
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
    if (op === ts.SyntaxKind.InstanceOfKeyword && isForeignExpr(lowerer, expr.right)) {
      lowerer.usesNodeIsland = true;
      const value = lowerer.coerceToExpected(lowerer.lowerExpr(expr.left), DYN);
      const ctor = lowerer.lowerExpr(expr.right);
      return { kind: "libCall", fn: "nodeIsland.instanceof", args: [value, ctor], type: BOOL, loc };
    }
    if (op === ts.SyntaxKind.EqualsToken) {
      const left = stripTypeWrappers(expr.left);
      if (
        (ts.isPropertyAccessExpression(left) && ts.isIdentifier(left.name)) ||
        ts.isElementAccessExpression(left)
      ) {
        if (!isForeignExpr(lowerer, left.expression)) return null;
        lowerer.usesNodeIsland = true;
        const target = lowerer.lowerExpr(left.expression);
        const value = toIsland(lowerer, expr.right);
        const tmp = lowerer.declareHiddenLocal("%islandSet", DYN);
        const stmts: IrStmt[] = [{ kind: "varDecl", localId: tmp.id, init: value, loc }];
        const v = varRef(tmp.id, DYN, loc);
        stmts.push({
          kind: "exprStmt",
          expr: ts.isPropertyAccessExpression(left)
            ? {
                kind: "libCall",
                fn: "nodeIsland.set",
                args: [target, { kind: "strLit", value: left.name.text, type: STRING, loc }, v],
                type: { kind: "void" },
                loc,
              }
            : {
                kind: "libCall",
                fn: "nodeIsland.setKey",
                args: [target, toIsland(lowerer, left.argumentExpression), v],
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
      boundaryFail(lowerer, "a compound assignment to an island object's member", expr);
    }
  }
  return null;
}

/** The receiver of a member operation on an island value. A CommonJS
 * namespace binding's members are module.exports' (and `default` is
 * module.exports itself), answered directly. */
function islandReceiver(
  lowerer: Lowerer,
  receiver: ts.Expression,
  member: string,
  loc: SrcLoc,
): { value: IrExpr; direct?: IrExpr } {
  const inner = stripTypeWrappers(receiver);
  if (ts.isIdentifier(inner)) {
    const b = islandBindingOf(lowerer, inner);
    if (b !== null && b.kind === "namespace" && !b.module.esm) {
      const exports = varRef(b.module.global.id, DYN, loc);
      if (member === "default") return { value: exports, direct: exports };
      return { value: exports };
    }
  }
  return { value: lowerer.coerceToExpected(lowerer.lowerExpr(receiver), FOREIGN) };
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
  const pathLit: IrExpr = { kind: "strLit", value: path, type: STRING, loc };
  if (isImport) {
    return {
      kind: "libCall",
      fn: "nodeIsland.import",
      args: [pathLit],
      type: { kind: "promise", inner: DYN },
      loc,
    };
  }
  return fromIsland(lowerer, loadIslandModule(path, loc), expr);
}
