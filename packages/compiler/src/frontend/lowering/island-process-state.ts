/* `process.exitCode` in a program with Node islands. The program and its
 * island code are one process, so the property is one value: once Node is
 * loaded it is Node's own `process.exitCode`, which island code reads and
 * writes directly, and the program's native reads and writes go to it
 * through the island unit (scr_node_island_events.c). Until Node is loaded
 * the island unit answers from the runtime's own value, as the calls it
 * replaces do. `process.chdir` goes the same way: the directory is the
 * process's, and Node is told to drop its cached `process.cwd()`. */
import type { IrExpr, IrFunction, IrLibFn } from "../../ir/ir.js";
import { everyStmt } from "../../ir/traverse.js";
import type { Lowerer } from "./lowerer.js";

/** The runtime's exit-code calls and their island counterparts. Both
 * writes record the assignment: island code may read the code even when
 * the program's own sources never do. */
const EXIT_CODE_CALLS: ReadonlyMap<IrLibFn, IrLibFn> = new Map<IrLibFn, IrLibFn>([
  ["process.setExitCode", "nodeIsland.setExitCode"],
  ["process.setExitCodeTracked", "nodeIsland.setExitCode"],
  ["process.currentExitCode", "nodeIsland.exitCode"],
  ["process.hasExitCode", "nodeIsland.hasExitCode"],
  // The working directory is the process's too, and Node caches its answer
  // to process.cwd(): the program's change tells Node to read it again.
  ["process.chdir", "nodeIsland.chdir"],
]);

/** Routes the exit-code calls and process.chdir through the island unit,
 * over the final functions, in place. Programs without islands are left as
 * they are. */
export function shareIslandProcessState(lowerer: Lowerer, functions: IrFunction[]): void {
  if (!lowerer.usesNodeIsland) return;
  const visitor = {
    expr: (e: IrExpr): boolean => {
      if (e.kind === "libCall") {
        const island = EXIT_CODE_CALLS.get(e.fn);
        if (island !== undefined) e.fn = island;
      }
      return true;
    },
    stmt: (): boolean => true,
  };
  for (const fn of functions) for (const s of fn.body) everyStmt(s, visitor);
}
