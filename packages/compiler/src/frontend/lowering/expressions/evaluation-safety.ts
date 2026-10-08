import type { IrExpr } from "../../../ir/ir.js";

/**
 * Whether an expression is safe to evaluate more than once. These are plain reads whose evaluation has no observable side effects.
 */
export function isSafeToRepeat(expr: IrExpr): boolean {
  if (expr.kind === "varRef") return true;
  if (expr.kind === "recordGet" || expr.kind === "fieldGet") return isSafeToRepeat(expr.obj);
  // The trust-the-checker narrowing bridges over a pure read: extraction
  // and downcast are reads too (the +1 on ref payloads is RC bookkeeping,
  // not an observable effect — each emission owns its own copy).
  if (expr.kind === "unionNarrow" || expr.kind === "downcast") return isSafeToRepeat(expr.value);
  return false;
}

/**
 * Whether evaluating an expression is unobservable, so the expression may be discarded.
 */
export function isSafeToDiscard(expr: IrExpr): boolean {
  switch (expr.kind) {
    case "numLit":
    case "strLit":
    case "boolLit":
    case "unitLit":
      return true;
    case "bin":
      return isSafeToDiscard(expr.left) && isSafeToDiscard(expr.right);
    case "unary":
      return isSafeToDiscard(expr.operand);
    case "logical":
      return isSafeToDiscard(expr.left) && isSafeToDiscard(expr.right);
    case "ternary":
      return (
        isSafeToDiscard(expr.cond) && isSafeToDiscard(expr.then) && isSafeToDiscard(expr.else_)
      );
    case "strConcat":
      return isSafeToDiscard(expr.left) && isSafeToDiscard(expr.right);
    case "toBool":
      return isSafeToDiscard(expr.operand);
    case "unionIsTag":
    case "unionWrap":
      return isSafeToDiscard(expr.value);
    case "recordHas":
      return isSafeToDiscard(expr.obj);
    case "fieldAbsent":
      return true;
    // Fresh allocations are unobservable too — only their pieces can
    // carry effects (a spread re-reads its source: pure; element and
    // field initializers recurse).
    case "arrayLit":
      return expr.elems.every(isSafeToDiscard);
    case "recordLit":
      return expr.fields.every((field) => isSafeToDiscard(field.value));
    case "recordClone":
      return (
        isSafeToDiscard(expr.source) &&
        expr.overrides.every((field) => isSafeToDiscard(field.value))
      );
    case "closure":
      return true;
    default:
      return isSafeToRepeat(expr);
  }
}

/**
 * Whether a condition may be evaluated earlier without changing observable behavior.
 */
export function isSafeToMoveConditionEarlier(expr: IrExpr): boolean {
  if (expr.kind === "boolLit") return true;
  if (expr.kind === "toBool") return isSafeToRepeat(expr.operand);
  if (expr.kind === "unionIsTag" || expr.kind === "dynTest") return isSafeToRepeat(expr.value);
  if (expr.kind === "unary" && expr.op === "!") return isSafeToMoveConditionEarlier(expr.operand);
  if (expr.kind === "logical") {
    return isSafeToMoveConditionEarlier(expr.left) && isSafeToMoveConditionEarlier(expr.right);
  }
  if (expr.kind === "jsOp" && (expr.op === "truthy" || expr.op === "not")) {
    return expr.args.every(isSafeToRepeat);
  }
  return isSafeToRepeat(expr);
}
