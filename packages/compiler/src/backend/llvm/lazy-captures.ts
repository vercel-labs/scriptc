import type { IrExpr, IrFunction, IrStmt } from "../../ir/ir.js";
import { everyStmtList } from "../../ir/traverse.js";

/** The local a node rebinds. Writes through the bound reference, such as a
 * field store or an array push, leave the binding unchanged. Catch bindings
 * and rethrow targets are conservatively treated as rebinding. */
function rebound(node: IrStmt | IrExpr): string | null {
  switch (node.kind) {
    case "varDecl":
    case "assign":
    case "forOf":
    case "rethrow":
    case "assignExpr":
    case "incDec":
      return node.localId;
    case "tryCatch":
      return node.catchLocalId;
    default:
      return null;
  }
}

/** A captured parameter that no code rebinds holds its entry value for the
 * whole call, so every environment may observe a box created when the first
 * closure is built instead of on function entry. Paths that never create a
 * closure then allocate no box. The proof follows each capture into nested
 * function bodies; class environments keep the eager box. */
export class LazyCaptures {
  private readonly unchanged = new Map<string, boolean>();

  constructor(private readonly functions: ReadonlyMap<string, IrFunction>) {}

  parameters(fn: IrFunction): Set<string> {
    const result = new Set<string>();
    if (fn.async || fn.generator) return result;
    const locals = new Map(fn.locals.map((local) => [local.id, local]));
    for (const param of fn.params) {
      const local = locals.get(param.localId);
      if (local?.boxed && !local.tdz) result.add(param.localId);
    }
    if (result.size === 0) return result;
    for (const id of this.rebindings(fn, result)) result.delete(id);
    return result;
  }

  /** The subset of `ids` rebound in `fn` or in any function that captures
   * one of them, directly or through further nesting. */
  private rebindings(fn: IrFunction, ids: ReadonlySet<string>): Set<string> {
    const changed = new Set<string>();
    const nested: { target: string; local: string; source: string }[] = [];
    const visit = (node: IrStmt | IrExpr): boolean => {
      const target = rebound(node);
      if (target !== null && ids.has(target)) changed.add(target);
      if (node.kind === "classRef") {
        for (const id of node.captures ?? []) if (ids.has(id)) changed.add(id);
      } else if (node.kind === "closure") {
        const callee = this.functions.get(node.fnName);
        node.captures.forEach((id, index) => {
          if (!ids.has(id)) return;
          const capture = callee?.captures?.[index];
          if (!capture) changed.add(id);
          else nested.push({ target: node.fnName, local: capture.localId, source: id });
        });
      }
      return true;
    };
    everyStmtList(fn.body, { stmt: visit, expr: visit });
    for (const edge of nested) {
      if (!changed.has(edge.source) && !this.isUnchanged(edge.target, edge.local))
        changed.add(edge.source);
    }
    return changed;
  }

  private isUnchanged(fnName: string, localId: string): boolean {
    const key = `${fnName}\0${localId}`;
    const known = this.unchanged.get(key);
    if (known !== undefined) return known;
    // Capture chains follow lexical nesting and cannot cycle; the
    // provisional entry only bounds work on malformed input.
    this.unchanged.set(key, false);
    const fn = this.functions.get(fnName);
    const result = fn !== undefined && this.rebindings(fn, new Set([localId])).size === 0;
    this.unchanged.set(key, result);
    return result;
  }
}
