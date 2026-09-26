import { BOOL, type IrExpr, type SrcLoc, typeEquals, typeKey } from "../../ir/ir.js";
import type { Lowerer } from "./lowerer.js";

/** Fuse strict equality of two primitive array reads without optional-union
 * boxes. The arguments must be plain reads/literals: evaluating the right
 * receiver/index earlier must never mutate or invalidate the left value. */
export function tryLowerIndexedComparison(
  lowerer: Lowerer, left: IrExpr, right: IrExpr, negated: boolean, loc: SrcLoc,
): IrExpr | null {
  function indexed(expr: IrExpr) {
    if (expr.kind !== "call" || expr.args.length !== 2) return null;
    const [arr, index] = expr.args;
    if (arr?.type.kind !== "array" || index?.type.kind !== "f64") return null;
    const elem = arr.type.elem;
    if (elem.kind !== "f64" && elem.kind !== "string" && elem.kind !== "bool") return null;
    if (expr.callee !== lowerer.arrHofHelpers.get(`idxOr:${typeKey(elem)}`)) return null;
    if (arr.kind !== "varRef" || (index.kind !== "varRef" && index.kind !== "numLit")) return null;
    return { arr, index, elem };
  }
  const l = indexed(left), r = indexed(right);
  if (!l || !r || !typeEquals(l.elem, r.elem)) return null;
  const equal: IrExpr = {
    kind: "arrIntrinsic", method: "indexEq", receiver: l.arr,
    args: [l.index, r.arr, r.index], type: BOOL, loc,
  };
  return negated ? { kind: "unary", op: "!", operand: equal, type: BOOL, loc } : equal;
}
