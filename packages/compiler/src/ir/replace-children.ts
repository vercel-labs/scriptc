import type { IrExpr, IrStmt } from "./ir.js";
import { replaceChildExpr } from "./fields.generated.js";
import { everyExprChild, everyStmtChild } from "./traverse.js";

/** Replaces each node of `replacements` found under `body` through the node
 * that holds it (replaceChildExpr), and the nodes under a replacement in
 * turn. A node is never rewritten into another kind in place: the compiler
 * compiles its own passes, and a node it builds keeps its kind's fields.
 * Returns how many replacements were made. */
export function replaceThroughParents(
  body: readonly IrStmt[],
  replacements: ReadonlyMap<IrExpr, IrExpr>,
): number {
  if (replacements.size === 0) return 0;
  let replaced = 0;
  const children = (parent: IrExpr | IrStmt) => ({
    expr: (child: IrExpr): boolean => {
      const to = replacements.get(child);
      if (to !== undefined && replaceChildExpr(parent, child, to)) replaced++;
      visitExpr(to ?? child);
      return true;
    },
    stmt: (child: IrStmt): boolean => {
      visitStmt(child);
      return true;
    },
  });
  function visitExpr(node: IrExpr): void {
    const { expr, stmt } = children(node);
    everyExprChild(node, expr, stmt);
  }
  function visitStmt(node: IrStmt): void {
    const { expr, stmt } = children(node);
    everyStmtChild(node, expr, stmt);
  }
  for (const stmt of body) visitStmt(stmt);
  return replaced;
}
