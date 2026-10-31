import { expect, test } from "vitest";
import type { IntegerCountedForLoop } from "../../ir/integer-loops.js";
import { F64, type IrExpr } from "../../ir/ir.js";
import type { IntegerRange } from "../../ir/integer-ranges.js";
import { BlockBuilder } from "./blocks.js";
import { emitCountedLoopLimit } from "./counted-loops.js";
import type { LlValue, LlvmEmitterContext } from "./expr-context.js";

const loc = { file: "test.ts", start: 0, end: 0 };

/** The endpoint emitCountedLoopLimit answers for a limit that emits as
 * `value` and has the proven `range`, and the lines it writes. */
function endpoint(
  value: LlValue,
  range: IntegerRange,
  step: number,
  inclusive: boolean,
): { endpoint: string; lines: string } {
  const limit: IrExpr = { loc, kind: "varRef", localId: "n", type: F64 };
  const B = new BlockBuilder();
  const host = {
    B,
    integerRanges: new Map([[limit, range]]),
    emitExpr: () => value,
    declare: () => {},
  } as unknown as LlvmEmitterContext;
  const loop = { step, inclusive, limit } as unknown as IntegerCountedForLoop;
  const result = emitCountedLoopLimit(host, loop);
  return { endpoint: result, lines: B.render() };
}

test("a negative int32 limit whose ToUint32 view is a literal keeps its sign", () => {
  // A number literal's value carries its ToUint32 bits as a literal, so -1
  // has the view 4294967295; the endpoint is -1, as in `i > -1`.
  const minusOne: LlValue = { name: "-1.0", type: F64, uint32: "4294967295" };
  expect(endpoint(minusOne, { min: -1, max: -1 }, -1, false).endpoint).toBe("-1");
  const inclusive = endpoint(minusOne, { min: -1, max: -1 }, -1, true);
  expect(inclusive.lines).toContain("add nsw i64 -1, -1");
  const minusTwo: LlValue = { name: "-2.0", type: F64, uint32: "4294967294" };
  expect(endpoint(minusTwo, { min: -2, max: -2 }, 1, false).endpoint).toBe("-2");
  // A uint32 past int32 stays positive.
  const wide: LlValue = { name: "4294967295.0", type: F64, uint32: "4294967295" };
  expect(endpoint(wide, { min: 4294967295, max: 4294967295 }, 1, false).endpoint).toBe(
    "4294967295",
  );
});
