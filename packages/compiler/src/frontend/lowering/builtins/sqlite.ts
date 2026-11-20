import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { locOf } from "../../program.js";
import { dynUndefinedExpr, numLit, varRef } from "../../../ir/build.js";
import { BOOL, DYN, type IrExpr } from "../../../ir/ir.js";
import { builtinImportOf } from "./module-bindings.js";

/* node:sqlite's DatabaseSync and StatementSync are native checked-dynamic
 * handles (scr_sqlite.c): both types map to dyn, their getters read through
 * the handle, their methods dispatch through it, and these helpers lower the
 * uses a dyn value cannot answer by itself (construction and instanceof). */

type SqliteClass = "DatabaseSync" | "StatementSync" | "Session";

/** The sqlite class `node` names, in any module spelling. */
export function sqliteClassOf(lowerer: Lowerer, node: ts.Expression): SqliteClass | null {
  // A sqlite member is spelled by the access's own name (builtinMemberOf
  // composes a member only for another module's sub-object), so an access to
  // any other name answers without resolving its receiver's symbol.
  const builtin = ts.isIdentifier(node)
    ? builtinImportOf(lowerer, node)
    : ts.isPropertyAccessExpression(node) &&
        !node.questionDotToken &&
        (node.name.text === "DatabaseSync" ||
          node.name.text === "StatementSync" ||
          node.name.text === "Session")
      ? lowerer.builtinMemberOf(node)
      : null;
  if (builtin?.module !== "sqlite") return null;
  return builtin.member === "DatabaseSync" ||
    builtin.member === "StatementSync" ||
    builtin.member === "Session"
    ? builtin.member
    : null;
}

/** `new DatabaseSync(path[, options])`. StatementSync is not constructible
 * in Node (its constructor throws ERR_ILLEGAL_CONSTRUCTOR), and a compiled
 * program cannot call the class value at all, so that form keeps the
 * class's own fence. */
export function lowerSqliteNew(lowerer: Lowerer, expr: ts.NewExpression): IrExpr | null {
  if (sqliteClassOf(lowerer, expr.expression) !== "DatabaseSync") return null;
  const nodes = expr.arguments?.nodes ?? [];
  if (nodes.some(ts.isSpreadElement)) return null;
  const loc = locOf(expr);
  const path =
    nodes.length > 0 ? lowerer.lowerExprExpecting(nodes[0]!, DYN) : dynUndefinedExpr(loc);
  const options =
    nodes.length > 1 ? lowerer.lowerExprExpecting(nodes[1]!, DYN) : dynUndefinedExpr(loc);
  // Arguments evaluate left to right, and the surplus ones exist only for
  // their effects: with any, every argument lands in a hidden local in
  // source order, then the call reads the two it keeps.
  const surplus = nodes.slice(2).map((arg) => lowerer.lowerExprExpecting(arg, DYN));
  if (surplus.length === 0) {
    return { kind: "libCall", fn: "sqlite.dbNew", args: [path, options], type: DYN, loc };
  }
  const pathLocal = lowerer.declareHiddenLocal("%sqlitePath", DYN);
  const optionsLocal = lowerer.declareHiddenLocal("%sqliteOptions", DYN);
  return {
    kind: "seqExpr",
    stmts: [
      { kind: "varDecl", localId: pathLocal.id, init: path, loc },
      { kind: "varDecl", localId: optionsLocal.id, init: options, loc },
      ...surplus.map((expr) => ({ kind: "exprStmt" as const, expr, loc: expr.loc })),
    ],
    result: {
      kind: "libCall",
      fn: "sqlite.dbNew",
      args: [varRef(pathLocal.id, DYN, loc), varRef(optionsLocal.id, DYN, loc)],
      type: DYN,
      loc,
    },
    type: DYN,
    loc,
  };
}

/** `backup(sourceDb, path[, options])`, the module's one function: the
 * promise of the copy's page count. */
export function lowerSqliteCall(lowerer: Lowerer, call: ts.CallExpression): IrExpr | null {
  if (call.questionDotToken) return null;
  const callee = call.expression;
  let isBackup = false;
  if (ts.isIdentifier(callee)) {
    const builtin = builtinImportOf(lowerer, callee);
    isBackup = builtin?.module === "sqlite" && builtin.member === "backup";
  } else if (
    ts.isPropertyAccessExpression(callee) &&
    !callee.questionDotToken &&
    // The member read spells its name (`sqlite.backup`), so a call to any
    // other member needs no receiver resolution.
    callee.name.text === "backup"
  ) {
    const builtin = lowerer.builtinMemberOf(callee);
    isBackup = builtin?.module === "sqlite" && builtin.member === "backup";
  }
  if (!isBackup) return null;
  if (call.arguments.nodes.some(ts.isSpreadElement)) return null;
  const loc = locOf(call);
  const nodes = call.arguments.nodes;
  const argument = (index: number): IrExpr =>
    index < nodes.length ? lowerer.lowerExprExpecting(nodes[index]!, DYN) : dynUndefinedExpr(loc);
  const source = argument(0);
  const path = argument(1);
  const options = argument(2);
  // Arguments evaluate left to right, and the surplus ones exist only for
  // their effects: with any, every argument lands in a hidden local in
  // source order, then the call reads the three it keeps.
  const surplus = nodes.slice(3).map((arg) => lowerer.lowerExprExpecting(arg, DYN));
  if (surplus.length === 0) {
    return {
      kind: "libCall",
      fn: "sqlite.backup",
      args: [source, path, options],
      type: DYN,
      loc,
    };
  }
  const sourceLocal = lowerer.declareHiddenLocal("%sqliteSource", DYN);
  const pathLocal = lowerer.declareHiddenLocal("%sqliteBackupPath", DYN);
  const optionsLocal = lowerer.declareHiddenLocal("%sqliteBackupOptions", DYN);
  return {
    kind: "seqExpr",
    stmts: [
      { kind: "varDecl", localId: sourceLocal.id, init: source, loc },
      { kind: "varDecl", localId: pathLocal.id, init: path, loc },
      { kind: "varDecl", localId: optionsLocal.id, init: options, loc },
      ...surplus.map((expr) => ({ kind: "exprStmt" as const, expr, loc: expr.loc })),
    ],
    result: {
      kind: "libCall",
      fn: "sqlite.backup",
      args: [
        varRef(sourceLocal.id, DYN, loc),
        varRef(pathLocal.id, DYN, loc),
        varRef(optionsLocal.id, DYN, loc),
      ],
      type: DYN,
      loc,
    },
    type: DYN,
    loc,
  };
}

/** `v instanceof DatabaseSync` / `v instanceof StatementSync`. */
export function lowerSqliteInstanceof(lowerer: Lowerer, expr: ts.BinaryExpression): IrExpr | null {
  const cls = sqliteClassOf(lowerer, expr.right);
  if (cls === null) return null;
  const loc = locOf(expr);
  const value = lowerer.coerceInto(expr.left, lowerer.lowerExpr(expr.left), DYN);
  const kind = cls === "DatabaseSync" ? 0 : cls === "StatementSync" ? 1 : 3;
  return {
    kind: "libCall",
    fn: "sqlite.is",
    args: [value, numLit(kind, loc)],
    type: BOOL,
    loc,
  };
}

/** Reports SC2020 when `access` reads a static member of DatabaseSync or
 * StatementSync (`DatabaseSync.prototype`, `DatabaseSync.name`); null
 * otherwise. A compiled binary holds neither class as a function value, so
 * the read would answer undefined. */
export function fenceSqliteStaticRead(lowerer: Lowerer, access: ts.PropertyAccessExpression): null {
  const cls = sqliteClassOf(lowerer, access.expression);
  if (cls !== null) lowerer.noLowering(`sqlite.${cls}.${access.name.text}`, access);
  return null;
}
