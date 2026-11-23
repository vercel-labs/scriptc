/* A CommonJS module's real `module.exports` object, for the modules whose
 * object some code needs as a value.
 *
 * A compiled CommonJS table module has no exports object: each export is a
 * module global (collectGlobals), and requirers read the globals directly.
 * When code takes the object itself (`const lib = require("./lib")` used as
 * a value, `require("./lib")` in a value position, the module's own
 * `module.exports` handed somewhere), Node answers an ordinary extensible
 * object whose properties appear in the order the module wrote them, which
 * every require of the module answers, and which a `module.exports = {...}`
 * statement replaces. This file is the one place that object comes from:
 *
 *  - cjsExportsObjectModules decides, once per lowering pass, which modules
 *    need it (one syntax-and-symbol scan, registered in program-facts.ts);
 *  - each such module gets one checked-dynamic global, `%exportsObj`, that
 *    holds its current `module.exports` (set at the top of the module's
 *    %init and replaced by a top-level `module.exports = {...}` table);
 *  - cjsExportsObjectWrites mirrors every export write of the module into
 *    that object as an ordinary data property, in execution order, beside
 *    the export global the typed paths keep reading;
 *  - cjsExportsObjectMember answers the static member reads, calls and
 *    writes of such a module through the object, so a write that dynamic
 *    code makes through the object is what every later read sees.
 *
 * A module no code takes the object of has no `%exportsObj`, and every
 * function here answers null or nothing for it: its IR is unchanged. */
import * as ts from "../ts7/adapter.js";
import { PoisonError, type Lowerer } from "./lowerer.js";
import {
  cjsExportAssignmentOf,
  cjsExportDiscardReason,
  isCjsJsFile,
  isEsModuleStamp,
  locOf,
} from "../program.js";
import {
  cjsConditionalWholeExportTargetsOf,
  cjsExportValueByName,
  cjsNamespaceModule,
  cjsNamespaceTargetOf,
  cjsTableExportNamesInOrder,
  inlineNamespaceRequireOf,
  inlineProgramRequireOf,
  withRequireInit,
  type InlineRequire,
} from "./cjs-inline-require.js";
import { isCjsExportsIdentifier, isCjsModuleExports } from "./cjs-exports-object.js";
import { usesCjsTopLevelThis } from "./lower-node-module.js";
import { v8CalleeText } from "./expressions/narrowing.js";
import { DYN, VOID, type IrExpr, type IrGlobal, type IrStmt } from "../../ir/ir.js";
import type { SrcLoc } from "../../ir/ir.js";
import { dynUndefinedExpr, strLit, varRef } from "../../ir/build.js";

/** The modules whose `module.exports` object some code takes as a value, by
 * their export table's own file (the target a forwarding
 * `module.exports = require("./base")` resolves to). A module whose export
 * writes this file cannot mirror keeps the namespace view
 * (moduleNamespaceDynValue). */
export function cjsExportsObjectModules(lowerer: Lowerer): Set<ts.SourceFile> {
  const needed = new Set<ts.SourceFile>();
  const exportNames = new Map<ts.SourceFile, ReadonlySet<string>>();
  /** The members a module exports, for deciding whether a property access
   * is a static export read. A module whose writes do not form a static
   * table (a bundler's `__export` getter table) answers the checker's
   * export list, the surface its named imports and reads type against. */
  const tableNames = (file: ts.SourceFile): readonly string[] | null => {
    const table = cjsTableExportNamesInOrder(lowerer, file);
    if (table !== null && table.length > 0) return table;
    const moduleSym = lowerer.checker.getSymbolAtLocation(file);
    if (moduleSym === undefined) return table;
    const names = lowerer.checker
      .getExportsOfModule(moduleSym)
      .map((symbol) => ts.symbolName(symbol))
      .filter((name) => name !== "export=");
    return names.length > 0 ? names : table;
  };
  const namesOf = (target: ts.SourceFile): ReadonlySet<string> => {
    let names = exportNames.get(target);
    if (names === undefined) {
      const collected = new Set(tableNames(target) ?? []);
      // A conditional whole-export wrapper's members are the union its
      // tables export: a static read of any of them answers through the
      // wrapper's slots, so it is not a use of the object itself.
      const conditional = cjsConditionalWholeExportTargetsOf(lowerer, target);
      if (conditional !== null)
        for (const entry of conditional)
          for (const name of tableNames(entry.req.dep) ?? []) collected.add(name);
      names = collected;
      exportNames.set(target, names);
    }
    return names;
  };
  /** Record that `node` names `target`'s whole export as a value. A
   * conditional whole-export wrapper has no object of its own: Node hands
   * out the chosen table's object, so the tables are the modules that need
   * one. */
  const addValueUse = (node: ts.Expression, target: ts.SourceFile): void => {
    if (!valueUse(node, target)) return;
    // A conditional wrapper's module.exports IS the chosen table's object,
    // so the wrapper needs its own slot too: reads and writes through its
    // binding must reach the same live object, not the per-member slots a
    // mutation through the object would leave stale.
    needed.add(target);
    const conditional = cjsConditionalWholeExportTargetsOf(lowerer, target);
    if (conditional === null) return;
    for (const entry of conditional)
      needed.add(cjsNamespaceTargetOf(lowerer, entry.req.dep) ?? entry.req.dep);
  };
  /** Whether `node` (a module binding or an inline require of `target`)
   * is used other than as the receiver of a static export's member. */
  const valueUse = (node: ts.Expression, target: ts.SourceFile): boolean => {
    let outer: ts.Node = node;
    while (outer.parent !== undefined && ts.isParenthesizedExpression(outer.parent))
      outer = outer.parent;
    const parent = outer.parent;
    if (parent === undefined) return false;
    // `module.exports = m` forwards the table (cjsNamespaceTargetOf) and a
    // `...require("./m")` entry of an exported table is star re-export
    // plumbing: neither reads the object.
    if (
      ts.isBinaryExpression(parent) &&
      parent.right === outer &&
      parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      isCjsModuleExports(lowerer, parent.left)
    )
      return false;
    if (ts.isSpreadAssignment(parent)) return false;
    if (
      ts.isPropertyAccessExpression(parent) &&
      parent.expression === outer &&
      ts.isIdentifier(parent.name) &&
      !parent.questionDotToken
    ) {
      if (
        !namesOf(target).has(parent.name.text) &&
        lowerer.cjsModuleExportSymbol(target, parent.name.text) === undefined
      )
        return true;
      // A plain write of an export (`lib.name = v`) changes the object
      // every requirer shares, so it is answered through the object too.
      let access: ts.Node = parent;
      while (access.parent !== undefined && ts.isParenthesizedExpression(access.parent))
        access = access.parent;
      const user = access.parent;
      return (
        user !== undefined &&
        ts.isBinaryExpression(user) &&
        user.left === access &&
        user.operatorToken.kind === ts.SyntaxKind.EqualsToken
      );
    }
    return true;
  };
  for (const sf of lowerer.program.getImplementationSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    // The bindings a file declares from a require() call of a program
    // module, and the default and namespace import bindings of one: only
    // identifiers that resolve to one of these symbols can name a module
    // binding. The use site decides whether the binding is really a CommonJS
    // module binding (an ESM import of an ES module is not one).
    const bindings = new Set<ts.Symbol>();
    // The names those bindings have here: the identifier walk checks the
    // name before asking the checker, so a file with one import binding does
    // not pay a symbol lookup for every identifier in it.
    const bindingNames = new Set<string>();
    const addBinding = (name: ts.Identifier): void => {
      const symbol = lowerer.checker.getSymbolAtLocation(name);
      if (symbol === undefined) return;
      bindings.add(symbol);
      bindingNames.add(name.text);
    };
    ts.walkPreorder(sf, (node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer !== undefined &&
        inlineProgramRequireOf(lowerer, node.initializer) !== null
      ) {
        addBinding(node.name);
      } else if (ts.isImportDeclaration(node)) {
        const clause = node.importClause;
        if (clause?.name !== undefined) addBinding(clause.name);
        const named = clause?.namedBindings;
        if (named !== undefined && ts.isNamespaceImport(named)) addBinding(named.name);
      }
      return undefined;
    });
    ts.walkPreorder(sf, (node) => {
      if (ts.isCallExpression(node)) {
        const req = inlineNamespaceRequireOf(lowerer, node);
        if (req === null) return undefined;
        // The initializer of a module binding is the binding, not a value.
        let outer: ts.Node = node;
        while (outer.parent !== undefined && ts.isParenthesizedExpression(outer.parent))
          outer = outer.parent;
        if (ts.isVariableDeclaration(outer.parent!) && outer.parent.initializer === outer)
          return undefined;
        if (ts.isExpressionStatement(outer.parent!)) return undefined;
        // `module.exports = require("./m")` forwards the module's table and
        // `l = require("./m")` binds a split or conditional alias: both read
        // through their own static machinery (cjsNamespaceTargetOf,
        // cjsConditionalAliasOf), not through a value.
        if (
          ts.isBinaryExpression(outer.parent!) &&
          outer.parent.right === outer &&
          outer.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          (ts.isIdentifier(outer.parent.left) || isCjsModuleExports(lowerer, outer.parent.left))
        )
          return undefined;
        const target = cjsNamespaceTargetOf(lowerer, req.dep);
        if (target !== null) addValueUse(node, target);
        return undefined;
      }
      if (!ts.isIdentifier(node) || !bindingNames.has(node.text)) return undefined;
      const parent = node.parent;
      if (parent === undefined) return undefined;
      if (ts.isVariableDeclaration(parent) && parent.name === node) return undefined;
      // The import binding's own name is its declaration, not a use.
      if ((ts.isImportClause(parent) || ts.isNamespaceImport(parent)) && parent.name === node)
        return undefined;
      if (ts.isPropertyAccessExpression(parent) && parent.name === node) return undefined;
      const symbol = lowerer.checker.getSymbolAtLocation(node);
      if (symbol === undefined || !bindings.has(symbol)) return undefined;
      if (!lowerer.cjsLocalModuleBindingOf(node)) return undefined;
      const dep = lowerer.cjsModuleBindingDepOf(node);
      if (dep === null || !cjsNamespaceModule(lowerer, dep)) return undefined;
      addValueUse(node, dep);
      return undefined;
    });
  }
  for (const target of [...needed]) {
    if (mirrorable(lowerer, target)) continue;
    // A conditional wrapper's object is the chosen table's own, so it can
    // answer whenever every table can.
    const conditional = cjsConditionalWholeExportTargetsOf(lowerer, target);
    if (
      conditional !== null &&
      conditional.every((entry) =>
        mirrorable(lowerer, cjsNamespaceTargetOf(lowerer, entry.req.dep) ?? entry.req.dep),
      )
    )
      continue;
    needed.delete(target);
  }
  return needed;
}

/** Whether every write the module makes to its exports is one the object
 * can follow: `exports.<name> = v` / `module.exports.<name> = v` plain
 * assignments, and top-level `module.exports = { ... }` tables of named
 * entries. Anything else (compound writes, `Object.defineProperty(exports,
 * …)`, top-level `this`, rebinding `exports`) keeps the namespace view. */
function mirrorable(lowerer: Lowerer, sf: ts.SourceFile): boolean {
  if (sf.isDeclarationFile || !isCjsJsFile(sf, lowerer.program)) return false;
  if (usesCjsTopLevelThis(lowerer, sf)) return false;
  let ok = true;
  ts.walkPreorder(sf, (node) => {
    if (!ok) return "stop";
    if (!ts.isExpression(node)) return undefined;
    if (!isCjsExportsIdentifier(lowerer, node) && !isCjsModuleExports(lowerer, node))
      return undefined;
    let outer: ts.Node = node;
    while (outer.parent !== undefined && ts.isParenthesizedExpression(outer.parent))
      outer = outer.parent;
    const parent = outer.parent!;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === outer) {
      // A member read, or a plain `=` write of a named member.
      let access: ts.Node = parent;
      while (access.parent !== undefined && ts.isParenthesizedExpression(access.parent))
        access = access.parent;
      const user = access.parent;
      if (user !== undefined && ts.isBinaryExpression(user) && user.left === access) {
        const op = user.operatorToken.kind;
        if (op >= ts.SyntaxKind.FirstAssignment && op <= ts.SyntaxKind.LastAssignment) {
          if (op !== ts.SyntaxKind.EqualsToken || !ts.isIdentifier(parent.name)) ok = false;
        }
      }
      if (
        user !== undefined &&
        (ts.isPrefixUnaryExpression(user) || ts.isPostfixUnaryExpression(user)) &&
        (user.operator === ts.SyntaxKind.PlusPlusToken ||
          user.operator === ts.SyntaxKind.MinusMinusToken)
      )
        ok = false;
      if (user !== undefined && ts.isDeleteExpression(user)) ok = false;
      return "skip";
    }
    if (ts.isBinaryExpression(parent) && parent.left === outer) {
      const op = parent.operatorToken.kind;
      if (op < ts.SyntaxKind.FirstAssignment || op > ts.SyntaxKind.LastAssignment) return "skip";
      // `module.exports = { ... }` as its own top-level statement.
      if (!ts.isIdentifier(node) && op === ts.SyntaxKind.EqualsToken) {
        const stmt = parent.parent;
        const table =
          stmt !== undefined && ts.isExpressionStatement(stmt) && stmt.parent === sf
            ? cjsExportAssignmentOf(stmt)
            : null;
        if (table?.kind === "table" && table.obj !== null && tableEntriesNamed(table.obj))
          return "skip";
      }
      ok = false;
      return "skip";
    }
    // `typeof exports` and identity comparisons answer without the object;
    // any other use of it as a value (`Object.defineProperty(exports, …)`
    // included) writes or exposes it where the mirror cannot follow.
    if (ts.isTypeOfExpression(parent)) return "skip";
    // tsc's `Object.defineProperty(exports, "__esModule", { value: true })`
    // stamp, mirrored by cjsEsModuleStampObjectWrite.
    if (
      ts.isCallExpression(parent) &&
      ts.isExpressionStatement(parent.parent!) &&
      parent.parent.parent === sf &&
      isEsModuleStamp(parent)
    )
      return "skip";
    if (
      ts.isBinaryExpression(parent) &&
      (parent.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        parent.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
        parent.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken ||
        parent.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken)
    )
      return "skip";
    ok = false;
    return "skip";
  });
  return ok;
}

/** Whether every entry of an exported table literal is a named property,
 * shorthand or method (no spread, accessor or computed name). */
function tableEntriesNamed(table: ts.ObjectLiteralExpression): boolean {
  return table.properties.nodes.every((prop) => tableEntryName(prop) !== null);
}

function tableEntryName(prop: ts.ObjectLiteralElementLike): string | null {
  if (ts.isShorthandPropertyAssignment(prop)) return (prop.name as ts.Identifier).text ?? null;
  if (!ts.isPropertyAssignment(prop) && !ts.isMethodDeclaration(prop)) return null;
  const name = prop.name;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return null;
}

/** The `%exportsObj` global of `sf`, or null when no code needs the
 * module's object. */
export function cjsExportsObjectOf(lowerer: Lowerer, sf: ts.SourceFile): IrGlobal | null {
  return lowerer.cjsExportsObjects.get(sf) ?? null;
}

/** The module's exports object as a value (+ nothing else: the caller runs
 * the module's %init first), or null when the module has none. */
export function cjsExportsObjectRef(
  lowerer: Lowerer,
  sf: ts.SourceFile,
  loc: SrcLoc,
): IrExpr | null {
  const target = cjsNamespaceTargetOf(lowerer, sf) ?? sf;
  const g = cjsExportsObjectOf(lowerer, target);
  return g === null ? null : varRef(g.id, DYN, loc);
}

/** `obj[key] = value` on the module's object as a statement. */
function keySet(g: IrGlobal, key: string, value: IrExpr, loc: SrcLoc): IrStmt {
  return {
    kind: "exprStmt",
    expr: {
      kind: "libCall",
      fn: "dyn.keySet",
      args: [varRef(g.id, DYN, loc), strLit(key, loc), value],
      type: VOID,
      loc,
    },
    loc,
  };
}

/** Mirrors one export write the module just performed into its object:
 * `value` is the stored value (typed), `node` the expression it came from.
 * Empty when the module has no object. */
export function cjsExportsObjectWrites(
  lowerer: Lowerer,
  sf: ts.SourceFile,
  key: string,
  node: ts.Node,
  value: IrExpr,
  loc: SrcLoc,
): IrStmt[] {
  const g = cjsExportsObjectOf(lowerer, sf);
  if (g === null) return [];
  return [keySet(g, key, lowerer.coerceInto(node, value, DYN), loc)];
}

/** The mirror statements that follow a top-level export statement
 * (lowerCjsExportStatement): a `module.exports = { ... }` table replaces
 * the object with a fresh one holding its entries in source order; an
 * `exports.a = exports.b = v` chain sets each member, innermost first,
 * reading back what the statement stored. Empty when the module has no
 * object. */
export function cjsExportStatementObjectWrites(lowerer: Lowerer, stmt: ts.Statement): IrStmt[] {
  const sf = ts.getSourceFileOfNode(stmt);
  const g = cjsExportsObjectOf(lowerer, sf);
  if (g === null) return [];
  const cjs = cjsExportAssignmentOf(stmt);
  if (cjs === null) return [];
  // A statement Node discards writes onto the exports object a
  // `module.exports =` assignment replaced: the module's object no longer
  // names that one, so there is nothing to mirror.
  if (cjsExportDiscardReason(stmt) !== null) return [];
  const loc = locOf(cjs.expr);
  const out: IrStmt[] = [];
  /** The value the statement stored under `key`, checked-dynamic; `source`
   * is the expression the value came from (its function name inference). */
  const readBack = (key: string, blame: ts.Node, source: ts.Node = blame): IrExpr => {
    const diagsBefore = lowerer.diags.length;
    try {
      const value = cjsExportValueByName(lowerer, sf, key, blame);
      if (value === null) {
        lowerer.unsupported(
          "SC1090",
          blame,
          `the export '${key}' as a property of its module's exports object (the member has no static value)`,
        );
      }
      return lowerer.coerceInto(source, value, DYN);
    } catch (err) {
      if (!(err instanceof PoisonError)) throw err;
      const fence = lowerer.deferToRuntimeFence(diagsBefore, blame, { kind: "statement" });
      if (!fence) throw err;
      out.push(fence);
      return dynUndefinedExpr(loc);
    }
  };
  if (cjs.kind === "table") {
    if (cjs.obj === null) return [];
    out.push({
      kind: "assign",
      localId: g.id,
      value: { kind: "dynObjLit", fields: [], type: DYN, loc },
      loc,
    });
    for (const prop of cjs.obj.properties.nodes) {
      const key = tableEntryName(prop);
      if (key === null) continue;
      out.push(keySet(g, key, readBack(key, prop), loc));
    }
    return out;
  }
  // The chain's members, outermost first, and the value they all take.
  const names: ts.Identifier[] = [];
  let cur: ts.Expression = cjs.expr;
  for (;;) {
    while (ts.isParenthesizedExpression(cur)) cur = cur.expression;
    if (!ts.isBinaryExpression(cur) || cur.operatorToken.kind !== ts.SyntaxKind.EqualsToken) break;
    const left = cur.left;
    if (!ts.isPropertyAccessExpression(left) || !ts.isIdentifier(left.name)) break;
    const recv = left.expression;
    if (!isCjsExportsIdentifier(lowerer, recv) && !isCjsModuleExports(lowerer, recv)) break;
    names.push(left.name);
    cur = cur.right;
  }
  // tsc's `exports.a = exports.b = void 0` preamble creates the members with
  // undefined; the real assignment later fills them.
  const preamble =
    cur.kind === ts.SyntaxKind.VoidExpression || (ts.isIdentifier(cur) && cur.text === "undefined");
  for (let i = names.length - 1; i >= 0; i--) {
    const name = names[i]!;
    out.push(
      keySet(g, name.text, preamble ? dynUndefinedExpr(loc) : readBack(name.text, name, cur), loc),
    );
  }
  return out;
}

/** A named member of a module's exports object: the object, the member's
 * key, and the inline require that names the module (null for a binding or
 * the module's own `module.exports`). */
interface CjsExportsObjectMember {
  object: IrExpr;
  key: string;
  req: InlineRequire | null;
}

/** The exports object behind the receiver of `access` when `access` is a
 * named member of a module that has one: a module binding, an inline
 * require of the module, or the module's own `module.exports` (and
 * `exports` while the module keeps its original object). The member
 * lowerings read, call and write through the object instead of the export
 * global, so a write dynamic code made through the object is seen. */
export function cjsExportsObjectMember(
  lowerer: Lowerer,
  access: ts.PropertyAccessExpression,
): CjsExportsObjectMember | null {
  if (lowerer.cjsExportsObjects.size === 0) return null;
  if (access.questionDotToken || !ts.isIdentifier(access.name)) return null;
  // Any program file may read a module binding's member through the live
  // object; the module's own `exports`/`module.exports` receivers resolve
  // only inside a CommonJS file (their predicates say so themselves).
  const sf = ts.getSourceFileOfNode(access);
  if (sf.isDeclarationFile) return null;
  let recv: ts.Expression = access.expression;
  while (ts.isParenthesizedExpression(recv)) recv = recv.expression;
  const loc = locOf(access);
  const key = access.name.text;
  if (isCjsModuleExports(lowerer, recv) || isCjsExportsIdentifier(lowerer, recv)) {
    const g = cjsExportsObjectOf(lowerer, sf);
    if (g === null) return null;
    // After a `module.exports = { ... }` table, `exports` still names the
    // discarded original object; only `module.exports` follows the table.
    if (
      ts.isIdentifier(recv) &&
      sf.statements.nodes.some((s) => cjsExportAssignmentOf(s)?.kind === "table")
    )
      return null;
    return { object: varRef(g.id, DYN, loc), key, req: null };
  }
  if (ts.isIdentifier(recv)) {
    if (!lowerer.cjsLocalModuleBindingOf(recv)) return null;
    const dep = lowerer.cjsModuleBindingDepOf(recv);
    if (dep === null) return null;
    const g = cjsExportsObjectOf(lowerer, dep);
    if (g === null) return null;
    return { object: varRef(g.id, DYN, loc), key, req: null };
  }
  const req = inlineNamespaceRequireOf(lowerer, recv);
  if (req === null) return null;
  const target = cjsNamespaceTargetOf(lowerer, req.dep);
  const g = target === null ? null : cjsExportsObjectOf(lowerer, target);
  if (g === null) return null;
  return { object: varRef(g.id, DYN, loc), key, req };
}

/** `value` after the module's %init when the member's receiver is an inline
 * require (the require evaluates where it sits). */
function afterInit(lowerer: Lowerer, member: CjsExportsObjectMember, value: IrExpr): IrExpr {
  return member.req === null ? value : withRequireInit(lowerer, member.req, value);
}

/** A member read through the module's exports object (checked-dynamic), or
 * null when `access` is not such a member. */
export function lowerCjsExportsObjectRead(
  lowerer: Lowerer,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  const member = cjsExportsObjectMember(lowerer, access);
  if (member === null) return null;
  const loc = locOf(access);
  const read: IrExpr = {
    kind: "dynKeyGet",
    key: strLit(member.key, loc),
    value: member.object,
    type: DYN,
    loc,
  };
  return afterInit(lowerer, member, read);
}

/** A member call through the module's exports object: the member is read
 * from the object and called with the object as `this`, as Node calls it.
 * Null when the callee is not such a member. */
export function lowerCjsExportsObjectCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
): IrExpr | null {
  let callee: ts.Expression = call.expression;
  while (ts.isParenthesizedExpression(callee)) callee = callee.expression;
  if (!ts.isPropertyAccessExpression(callee) || call.questionDotToken) return null;
  const member = cjsExportsObjectMember(lowerer, callee);
  if (member === null) return null;
  if (call.arguments.nodes.some((arg) => ts.isSpreadElement(arg))) return null;
  const loc = locOf(call);
  const args = call.arguments.nodes.map((arg) => lowerer.lowerExprExpecting(arg, DYN));
  const value: IrExpr = {
    kind: "dynCall",
    callee: {
      kind: "dynKeyGet",
      key: strLit(member.key, loc),
      value: member.object,
      type: DYN,
      loc,
    },
    receiver: member.object,
    calleeName: v8CalleeText(callee),
    args,
    type: DYN,
    loc,
  };
  return afterInit(lowerer, member, value);
}

/** `<module>.<name> = value` through the module's exports object: the
 * object takes the value, and a write the module makes to its own export
 * also keeps the export global it stores (the typed reads of other paths).
 * Answers the assigned value; null when `target` is not such a member. */
export function lowerCjsExportsObjectWrite(
  lowerer: Lowerer,
  target: ts.PropertyAccessExpression,
  rhs: ts.Expression,
  global: IrGlobal | null,
): IrExpr | null {
  const member = cjsExportsObjectMember(lowerer, target);
  if (member === null) return null;
  const loc = locOf(target);
  const type = global?.type ?? DYN;
  const value = lowerer.lowerExprExpecting(rhs, type);
  const tmp = lowerer.declareHiddenLocal("%exportValue", value.type);
  const stored = varRef(tmp.id, value.type, loc);
  const stmts: IrStmt[] = [{ kind: "varDecl", localId: tmp.id, init: value, loc }];
  if (global !== null) {
    stmts.push({ kind: "assign", localId: global.id, value: stored, loc });
    // A conditional whole export that selected this table follows the write.
    if (lowerer.hasCjsConditionalExportMirrors(global.id))
      stmts.push(...lowerer.cjsConditionalExportMirrorStmts(global.id, stored, rhs, loc));
  }
  stmts.push({
    kind: "exprStmt",
    expr: {
      kind: "libCall",
      fn: "dyn.keySet",
      args: [member.object, strLit(member.key, loc), lowerer.coerceInto(rhs, stored, DYN)],
      type: VOID,
      loc,
    },
    loc,
  });
  const result: IrExpr = { kind: "seqExpr", stmts, result: stored, type: value.type, loc };
  return afterInit(lowerer, member, result);
}

/** tsc's top-level `Object.defineProperty(exports, "__esModule", { value:
 * true })` in a module that has an exports object: the object takes Node's
 * non-enumerable, non-writable `__esModule` property. Null when the module
 * has no object (the stamp lowers to nothing, as before). */
export function cjsEsModuleStampObjectWrite(
  lowerer: Lowerer,
  stmt: ts.ExpressionStatement,
): IrStmt | null {
  const g = cjsExportsObjectOf(lowerer, ts.getSourceFileOfNode(stmt));
  if (g === null || !ts.isSourceFile(stmt.parent!)) return null;
  const loc = locOf(stmt);
  return {
    kind: "exprStmt",
    expr: {
      kind: "libCall",
      fn: "dyn.defineProperty",
      args: [
        varRef(g.id, DYN, loc),
        { kind: "dynFrom", value: strLit("__esModule", loc), type: DYN, loc },
        {
          kind: "dynObjLit",
          fields: [
            {
              key: strLit("value", loc),
              value: {
                kind: "dynFrom",
                value: { kind: "boolLit", value: true, type: { kind: "bool" }, loc },
                type: DYN,
                loc,
              },
            },
          ],
          type: DYN,
          loc,
        },
      ],
      type: DYN,
      loc,
    },
    loc,
  };
}
