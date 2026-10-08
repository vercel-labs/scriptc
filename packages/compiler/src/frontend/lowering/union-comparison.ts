import { BOOL, type IrExpr, type SrcLoc } from "../../ir/ir.js";
import type { Lowerer } from "./lowerer.js";

/** Compare stable operands using their own union tags and payload layouts.
 * No arm is converted merely to make its tag agree with the other operand. */
export function unionComparison(
  lowerer: Lowerer,
  left: IrExpr,
  right: IrExpr,
  compare: (left: IrExpr, right: IrExpr) => IrExpr | null,
  loc: SrcLoc,
): IrExpr | null {
  const input = left.type.kind === "union" ? left : right.type.kind === "union" ? right : null;
  if (!input || input.type.kind !== "union") return compare(left, right);
  const unionId = input.type.unionId;
  const arms = lowerer.unions.get(unionId)?.arms;
  if (!arms?.length) return null;
  let result: IrExpr | null = null;
  for (let tag = arms.length - 1; tag >= 0; tag--) {
    const payload: IrExpr = {
      kind: "unionNarrow",
      unionId,
      tag,
      value: input,
      type: arms[tag]!,
      loc,
    };
    const branch = unionComparison(
      lowerer,
      input === left ? payload : left,
      input === left ? right : payload,
      compare,
      loc,
    );
    if (!branch) return null;
    result =
      result === null
        ? branch
        : {
            kind: "ternary",
            cond: {
              kind: "unionIsTag",
              unionId,
              tag,
              negated: false,
              value: input,
              type: BOOL,
              loc,
            },
            then: branch,
            else_: result,
            type: BOOL,
            loc,
          };
  }
  return result;
}
