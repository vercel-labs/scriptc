/* Island thenables. In a program with Node islands a checked-dynamic value
 * may be an island object with a `then` method (a query builder, a lazy
 * request), which every promise resolution adopts as it adopts any
 * thenable. The runtime's resolutions know island values in such a program
 * (the Node island build of scr_async_dyn.c: a combinator's entry, an async
 * function's return, a reaction's result). Two forms are emitted without
 * the runtime's resolution and are routed to it here: the operand of a
 * dynamic await, which the native await takes as a plain value unless the
 * program defines thenables itself (thenables.ts), and `Promise.resolve`
 * of a dynamic value, which is emitted as an already fulfilled promise. */
import { DYN, type IrExpr, type IrFunction, type IrLibFn } from "../../ir/ir.js";
import { everyStmt, transformStmtList } from "../../ir/traverse.js";
import type { Lowerer } from "./lowerer.js";

/** The library calls that take the operand of a dynamic `await` or
 * PromiseResolve as their first argument. */
const DYN_AWAIT_OPERANDS: ReadonlySet<IrLibFn> = new Set<IrLibFn>([
  "async.awaitDyn",
  "dyn.promiseResolve",
  "child.propsResolve",
]);

/** `Promise.resolve(v)` of a dynamic value, emitted as an already fulfilled
 * promise of it. */
function resolvesDynamicValue(e: IrExpr): boolean {
  return (
    e.kind === "intrinsic" &&
    e.name === "promise.resolve" &&
    e.args.length === 1 &&
    e.args[0]!.type.kind === "dyn" &&
    e.type.kind === "promise" &&
    e.type.inner.kind === "dyn"
  );
}

/** Routes the operands through `nodeIsland.adoptThenable` and a fulfilled
 * promise of a dynamic value through `nodeIsland.promiseResolve`, over the
 * final functions. Programs without islands are left as they are. */
export function adoptIslandThenables(lowerer: Lowerer, functions: IrFunction[]): void {
  if (!lowerer.usesNodeIsland) return;
  // The fulfilled promises first: a function that has one gets a rewritten
  // body (the typed rewrite never changes a node in place), every other
  // function keeps its own.
  for (const fn of functions) {
    let found = false;
    const finder = {
      expr: (e: IrExpr): boolean => {
        if (resolvesDynamicValue(e)) found = true;
        return !found;
      },
      stmt: (): boolean => !found,
    };
    for (const s of fn.body) if (!everyStmt(s, finder)) break;
    if (!found) continue;
    fn.body = transformStmtList(fn.body, {
      expr: (e: IrExpr): IrExpr =>
        resolvesDynamicValue(e) && e.kind === "intrinsic"
          ? {
              kind: "libCall",
              fn: "nodeIsland.promiseResolve",
              args: [e.args[0]!],
              type: e.type,
              loc: e.loc,
            }
          : e,
      stmt: (s) => s,
    });
  }
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
