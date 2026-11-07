/* `await` of an island thenable. In a program with Node islands a
 * checked-dynamic value may be an island object with a `then` method (a
 * query builder, a lazy request), which `await` adopts as it adopts any
 * thenable. The native await knows the program's own thenables only
 * (thenables.ts), so the operand of every dynamic await and PromiseResolve
 * first passes through the island unit: V8 adopts an island thenable, and
 * any other value is itself. */
import { DYN, type IrExpr, type IrFunction, type IrLibFn } from "../../ir/ir.js";
import { everyStmt } from "../../ir/traverse.js";
import type { Lowerer } from "./lowerer.js";

/** The library calls that take the operand of a dynamic `await` or
 * PromiseResolve as their first argument. */
const DYN_AWAIT_OPERANDS: ReadonlySet<IrLibFn> = new Set<IrLibFn>([
  "async.awaitDyn",
  "dyn.promiseResolve",
  "child.propsResolve",
]);

/** Routes the operands through `nodeIsland.adoptThenable`, over the final
 * functions, in place. Programs without islands are left as they are. */
export function adoptIslandThenables(lowerer: Lowerer, functions: IrFunction[]): void {
  if (!lowerer.usesNodeIsland) return;
  // A node the IR shares at several places is wrapped once.
  const calls = new Set<IrExpr & { kind: "libCall" }>();
  const visitor = {
    expr: (e: IrExpr): boolean => {
      if (e.kind === "libCall" && DYN_AWAIT_OPERANDS.has(e.fn)) calls.add(e);
      return true;
    },
    stmt: (): boolean => true,
  };
  for (const fn of functions) for (const s of fn.body) everyStmt(s, visitor);
  for (const call of calls) {
    const operand = call.args[0]!;
    call.args[0] = {
      kind: "libCall",
      fn: "nodeIsland.adoptThenable",
      args: [operand],
      type: DYN,
      loc: operand.loc,
    };
  }
}
