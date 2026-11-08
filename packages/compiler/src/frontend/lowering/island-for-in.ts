/* for-in over an island value. In a program with Node islands a
 * checked-dynamic value may be an object that lives in the island, and
 * for-in over it visits what Node visits: the enumerable string keys of the
 * object and of its prototype chain, in Node's order, less the keys that
 * are gone when the loop reaches them. The loop over a dynamic receiver
 * (lowerForInReceiver) takes its key snapshot from `dyn.forInKeyStrings`
 * and rechecks each key through `%dyn.class.forInHasKey`; the runtime
 * units every program links answer both for native values only. Here the
 * two questions are routed to the island unit's entries, which ask Node
 * for an island value and the same native entries for every other. */
import type { IrExpr, IrFunction, IrLibFn } from "../../ir/ir.js";
import { everyStmt } from "../../ir/traverse.js";
import type { Lowerer } from "./lowerer.js";

/** The key snapshots of a for-in over a dynamic receiver, and the island
 * unit's entry for each. */
const ISLAND_SNAPSHOTS: ReadonlyMap<IrLibFn, IrLibFn> = new Map<IrLibFn, IrLibFn>([
  ["dyn.forInKeys", "nodeIsland.forInKeys"],
  ["dyn.forInKeyStrings", "nodeIsland.forInKeyStrings"],
]);

/** The helper that rechecks a key before its visit (classForInHasKey). */
const RECHECK_HELPER = "%dyn.class.forInHasKey";

/** Routes the key snapshots through `nodeIsland.forInKeys` and
 * `nodeIsland.forInKeyStrings`, and the recheck of a key through
 * `nodeIsland.forInHas`, over the final functions. Programs without
 * islands are left as they are. */
export function walkIslandForIn(lowerer: Lowerer, functions: IrFunction[]): void {
  if (!lowerer.usesNodeIsland) return;
  // A node the IR shares at several places is renamed once.
  const calls = new Set<IrExpr & { kind: "libCall" }>();
  let recheck = false;
  const visitor = {
    expr: (e: IrExpr): boolean => {
      if (e.kind !== "libCall") return true;
      if (ISLAND_SNAPSHOTS.has(e.fn) || (recheck && e.fn === "dyn.hasKey")) calls.add(e);
      return true;
    },
    stmt: (): boolean => true,
  };
  for (const fn of functions) {
    recheck = fn.name === RECHECK_HELPER;
    for (const s of fn.body) everyStmt(s, visitor);
  }
  for (const call of calls) call.fn = ISLAND_SNAPSHOTS.get(call.fn) ?? "nodeIsland.forInHas";
}
