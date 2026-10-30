import type { IrExpr, IrFunction, IrStmt, IrType } from "../../ir/ir.js";
import { everyExprChild, everyStmtChild } from "../../ir/traverse.js";
import { eachNodeOfKinds, type IrNodeIndex } from "../../ir/node-index.js";

/** Assignment statements: only these rebind a parameter. */
const ASSIGN_KINDS = ["assign"] as const;

/** Parameters that keep the borrowed calling convention although the body
 * rebinds them (`source = (source as LiteralType).regularType`). The
 * incoming value stays the caller's borrow; every value the body assigns is
 * owned through a separate owner slot, which each rebinding releases and
 * replaces and which the function scope releases on every exit. Reads see
 * the parameter slot, so whole-value uses retain as for any binding.
 *
 * Only plain statement assignments qualify: expression-position writes,
 * loop and catch bindings, declarations and captures keep the ordinary
 * owned parameter. Suspending bodies and environments use the owned ABI. */
export function findReboundParameters(
  fn: IrFunction,
  plainReference: (type: IrType) => boolean,
  excluded: ReadonlySet<string>,
  /** The module's node index: a body that assigns no candidate parameter is not walked. */
  nodes?: IrNodeIndex,
): ReadonlySet<string> {
  const result = new Set<string>();
  if (fn.async || fn.generator || fn.captures || fn.classCaptures) return result;
  const locals = new Map(fn.locals.map((local) => [local.id, local]));
  const candidates = new Set(
    fn.params
      .filter((param) => {
        const local = locals.get(param.localId);
        return (
          local !== undefined &&
          !local.boxed &&
          !local.tdz &&
          !excluded.has(param.localId) &&
          plainReference(param.type)
        );
      })
      .map((param) => param.localId),
  );
  if (candidates.size === 0) return result;
  // A parameter is rebound only by an assignment statement to it.
  if (nodes !== undefined) {
    let assigned = false;
    eachNodeOfKinds(fn, nodes.scan(ASSIGN_KINDS), (node) => {
      if (node.kind === "assign" && candidates.has(node.localId)) assigned = true;
      return !assigned;
    });
    if (!assigned) return result;
  }
  const rebound = new Set<string>();
  const invalid = new Set<string>();
  const expr = (e: IrExpr): boolean => {
    switch (e.kind) {
      case "assignExpr":
      case "incDec":
        invalid.add(e.localId);
        break;
      case "closure":
      case "classRef":
        for (const id of e.captures ?? []) invalid.add(id);
        break;
    }
    return everyExprChild(e, expr, (s) => stmt(s, true));
  };
  const stmt = (s: IrStmt, inExpression: boolean): boolean => {
    switch (s.kind) {
      case "assign":
        if (inExpression) invalid.add(s.localId);
        else rebound.add(s.localId);
        break;
      case "varDecl":
      case "forOf":
      case "rethrow":
        invalid.add(s.localId);
        break;
      case "tryCatch":
        if (s.catchLocalId !== null) invalid.add(s.catchLocalId);
        break;
    }
    return everyStmtChild(s, expr, (child) => stmt(child, inExpression));
  };
  for (const s of fn.body) stmt(s, false);
  for (const id of candidates) if (rebound.has(id) && !invalid.has(id)) result.add(id);
  return result;
}
