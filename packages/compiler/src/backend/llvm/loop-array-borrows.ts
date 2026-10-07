import { isRefCounted, type IrExpr, type IrFunction, type IrStmt } from "../../ir/ir.js";
import { everyStmtList } from "../../ir/traverse.js";
import type { CallLifetimes } from "./call-lifetimes.js";
import type { ReferenceEffects } from "./reference-effects.js";
import type { OptionalArrayReads } from "./local-array-reads.js";

/** Limit a borrow to a loop whose complete iteration preserves heap edges.
 * Initialization and unrelated work elsewhere in the function may mutate.
 * The array remains owned by its unchanged local or global binding; the
 * iteration binding can only project it or forward it to proven consumers.
 * Callbacks, suspension, capture, reference writes, and escaping uses keep
 * the ordinary owned read. Missing elements retain the runtime's checks. */
export function findLoopArrayBorrows(
  fn: IrFunction,
  lifetimes: CallLifetimes,
  effects: ReferenceEffects,
  optionalReads?: OptionalArrayReads,
): ReadonlySet<IrStmt> {
  const result = new Set<IrStmt>();
  if (fn.async || fn.generator) return result;
  const projected = lifetimes.locals.get(fn.name);
  if (!projected?.size) return result;
  const bindings = lifetimes.bindings.get(fn.name);
  const parameters = new Set(fn.params.map((param) => param.localId));
  const locals = new Map(fn.locals.map((local) => [local.id, local]));
  const stableSource = (value: IrExpr): boolean => {
    if (value.kind !== "varRef") return false;
    const local = locals.get(value.localId);
    // Globals cannot be rebound while a completely preserving loop runs.
    return (
      !local ||
      (!local.boxed && !local.tdz && (bindings?.has(local.id) || parameters.has(local.id)))
    );
  };
  everyStmtList(fn.body, {
    expr: () => true,
    stmt: (loop) => {
      if (loop.kind === "forOf") {
        const local = locals.get(loop.localId);
        if (
          loop.iterable.type.kind === "array" &&
          isRefCounted(loop.iterable.type.elem) &&
          local &&
          !local.boxed &&
          !local.tdz &&
          projected?.has(loop.localId) &&
          bindings?.has(loop.localId) &&
          effects.preservesScope(loop.body) &&
          effects.preserves(loop.iterable)
        )
          result.add(loop);
        return true;
      }
      if (loop.kind !== "for" && loop.kind !== "while" && loop.kind !== "doWhile") return true;
      if (
        !effects.preservesScope(loop.body) ||
        (loop.cond && !effects.preserves(loop.cond)) ||
        (loop.kind === "for" && loop.update && !effects.preservesScope([loop.update]))
      )
        return true;
      everyStmtList(loop.body, {
        expr: () => true,
        stmt: (stmt) => {
          if (
            stmt.kind !== "varDecl" ||
            !stmt.init ||
            !isRefCounted(stmt.init.type) ||
            !projected?.has(stmt.localId) ||
            !bindings?.has(stmt.localId)
          )
            return true;
          const source =
            stmt.init.kind === "arrayGet" ? stmt.init.arr : optionalReads?.get(stmt.init)?.array;
          if (source && stableSource(source)) result.add(stmt);
          return true;
        },
      });
      return true;
    },
  });
  return result;
}
