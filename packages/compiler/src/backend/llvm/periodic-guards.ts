/* Counted loops with a periodic guard: a branch on the counter's low bits,
 * such as `if ((j & 3) === 3 && ...)` (a check every fourth iteration).
 * LLVM checks such a guard on every iteration, and when the guarded
 * condition is cheap it speculates the condition into the loop. The loop's
 * back edge asks LLVM to unroll it by the guard's period
 * (`llvm.loop.unroll.count`): in each unrolled copy the counter's low bits
 * are known, so the guard folds to a constant, and only one copy in each
 * period keeps the check. The metadata changes how LLVM compiles the loop,
 * not what it computes. */
import type { IrExpr, IrStmt } from "../../ir/ir.js";
import { everyExprChild, everyStmtChild } from "../../ir/traverse.js";

/** The most IR nodes a loop body may have, times the period, for the loop
 * to be unrolled: a larger body gains less than its unrolled copies cost. */
const UNROLLED_BODY_NODES = 4096;

/** The loop IDs, one per period (2, 4 and 8). A loop ID is a distinct
 * node whose first operand is itself; loops with the same period share
 * one, as the copies of an inlined loop do. */
const loopIds = new Map<number, number>([
  [2, 1_000_002],
  [4, 1_000_004],
  [8, 1_000_008],
]);

/** The guard period of `loop`, a counted loop on `counter` that starts at
 * `start` and steps by `step`, or null. The period is M + 1 where the body
 * has an `if` whose condition is, or starts with an `&&` of,
 * `(counter & M) === C` (or `==`, `!==`, `!=`, either operand order) with
 * M one of 1, 3 and 7 and C an integer from 0 to M. The loop steps by 1
 * from a multiple of the period, so that the counter's low bits are known
 * in each unrolled copy, and its body has no nested loop. */
export function periodicGuardPeriod(
  loop: IrStmt & { kind: "for" },
  counter: string,
  start: IrExpr,
  step: number,
): number | null {
  if (step !== 1 || start.kind !== "numLit") return null;
  let period: number | null = null;
  let nodes = 0;
  let plain = true;
  const expr = (e: IrExpr): boolean => {
    nodes++;
    return everyExprChild(e, expr, stmt);
  };
  const stmt = (s: IrStmt): boolean => {
    nodes++;
    if (s.kind === "for" || s.kind === "while" || s.kind === "doWhile" || s.kind === "forOf") {
      plain = false;
      return false;
    }
    if (s.kind === "if" && period === null) period = guardPeriod(s.cond, counter);
    return everyStmtChild(s, expr, stmt);
  };
  for (const s of loop.body) if (!stmt(s)) break;
  if (!plain || period === null) return null;
  if (start.value % period !== 0 || nodes * period > UNROLLED_BODY_NODES) return null;
  return period;
}

function guardPeriod(cond: IrExpr, counter: string): number | null {
  let test = cond;
  while (test.kind === "logical" && test.op === "&&") test = test.left;
  if (test.kind !== "bin" || !["===", "==", "!==", "!="].includes(test.op)) return null;
  const masked = (e: IrExpr, other: IrExpr): number | null => {
    if (e.kind !== "bin" || e.op !== "&" || other.kind !== "numLit") return null;
    const [ref, mask] = e.left.kind === "varRef" ? [e.left, e.right] : [e.right, e.left];
    if (ref.kind !== "varRef" || ref.localId !== counter || mask.kind !== "numLit") return null;
    const m = mask.value;
    if (m !== 1 && m !== 3 && m !== 7) return null;
    const c = other.value;
    return Number.isInteger(c) && c >= 0 && c <= m ? m + 1 : null;
  };
  return masked(test.left, test.right) ?? masked(test.right, test.left);
}

/** The attachment that asks LLVM to unroll a loop by `period`, for its
 * back edge. */
export function loopUnrollAttachment(period: number): string {
  return `, !llvm.loop !${loopIds.get(period)!}`;
}

/** The loop ID nodes that the module's text `lines` refer to. */
export function loopUnrollMetadata(lines: readonly string[]): string[] {
  const used = new Set<number>();
  for (const line of lines) {
    if (!line.includes("!llvm.loop !")) continue;
    for (const [period, id] of loopIds) if (line.includes(`!llvm.loop !${id}`)) used.add(period);
  }
  return [...used]
    .sort((a, b) => a - b)
    .map((period) => {
      const id = loopIds.get(period)!;
      return `!${id} = distinct !{!${id}, !{!"llvm.loop.unroll.count", i32 ${period}}}`;
    });
}
