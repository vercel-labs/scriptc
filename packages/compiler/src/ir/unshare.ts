import type { IrExpr, IrFunction, IrModule, IrStmt } from "./ir.js";
import { reparseExpr, reparseStmt } from "./serialize.js";
import { everyExprChild, everyStmtChild, mapExprChildren, mapStmtChildren } from "./traverse.js";

/** Give every occurrence of an executable node its own object.
 *
 * Lowering helpers may place one node at several sites (a binding's varRef
 * read in a loop condition and in its body, a shared `break`). Analyses key
 * their facts by node identity (integer ranges, int32 write proofs, borrow
 * and lifetime facts), so a shared node carries one fact for all of its
 * sites: integer ranges keep the join, which loses what one site proves. A
 * serialized module gives every occurrence its own node; this makes the
 * in-memory module equivalent, so analyses and emission behave the same on
 * a module lowered in memory and on one read back from its artifact.
 * Functions without a repeated node are kept as they are; the input is
 * never mutated. */
export function unshareNodes(mod: IrModule): IrModule {
  const seen = new Set<IrExpr | IrStmt>();
  const repeated = new Set<IrExpr | IrStmt>();
  const affected = new Set<IrFunction>();
  let current: IrFunction | null = null;
  // A repeated node marks the function holding the later occurrence. Its
  // subtree is walked again, so every node under it is repeated as well.
  const visit = (node: IrExpr | IrStmt): void => {
    if (!seen.has(node)) seen.add(node);
    else {
      repeated.add(node);
      affected.add(current!);
    }
  };
  const findExpr = (node: IrExpr): boolean => {
    visit(node);
    return everyExprChild(node, findExpr, findStmt);
  };
  const findStmt = (node: IrStmt): boolean => {
    visit(node);
    return everyStmtChild(node, findExpr, findStmt);
  };
  for (const fn of mod.functions) {
    current = fn;
    for (const node of fn.body) findStmt(node);
  }
  if (affected.size === 0) return mod;
  // Rebuilding a function copies every node that has children; a repeated
  // childless node gets its own shallow copy at each of its sites there.
  // Both kinds of copy keep sharing the type and location objects.
  const expr = (node: IrExpr): IrExpr => {
    const copy = mapExprChildren(node, expr, stmt);
    return copy !== node || !repeated.has(node) ? copy : copyChildlessExpr(node);
  };
  const stmt = (node: IrStmt): IrStmt => {
    const copy = mapStmtChildren(node, expr, stmt);
    return copy !== node || !repeated.has(node) ? copy : copyChildlessStmt(node);
  };
  return {
    ...mod,
    functions: mod.functions.map((fn) =>
      affected.has(fn) ? { ...fn, body: fn.body.map(stmt) } : fn,
    ),
  };
}

/** A shallow copy of a node that mapExprChildren returns unchanged. Each
 * case spreads one node kind, so the copy is a plain record copy of that
 * kind. Any other kind is copied through the encoding. */
function copyChildlessExpr(node: IrExpr): IrExpr {
  switch (node.kind) {
    case "varRef":
      return { ...node };
    case "strLit":
      return { ...node };
    case "numLit":
      return { ...node };
    case "boolLit":
      return { ...node };
    case "unitLit":
      return { ...node };
    case "closure":
      return { ...node };
    case "moduleNsRef":
      return { ...node };
    case "incDec":
      return { ...node };
    case "chainRecv":
      return { ...node };
    case "regexLit":
      return { ...node };
    case "templateStrings":
      return { ...node };
    case "setNew":
      return { ...node };
    case "mapNew":
      return { ...node };
    case "dynObjLit":
      return { ...node };
    case "selfRef":
      return { ...node };
    case "promiseWithResolvers":
      return { ...node };
    case "classRef":
      return { ...node };
    case "fieldAbsent":
      return { ...node };
    default:
      return reparseExpr(node);
  }
}

/** A shallow copy of a statement that mapStmtChildren returns unchanged,
 * one case per kind as in copyChildlessExpr. */
function copyChildlessStmt(node: IrStmt): IrStmt {
  switch (node.kind) {
    case "break":
      return { ...node };
    case "continue":
      return { ...node };
    case "runtimeFence":
      return { ...node };
    case "rethrow":
      return { ...node };
    default:
      return reparseStmt(node);
  }
}
