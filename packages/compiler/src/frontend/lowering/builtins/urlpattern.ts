import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { locOf } from "../../program.js";
import { BOOL, DYN, type IrExpr } from "../../../ir/ir.js";
import { dynUndefinedExpr } from "../../../ir/build.js";

/* The global URLPattern class. Node's URLPattern compiles a pattern string
 * (or a component record) into one regular expression per URL component at
 * construction, then matches canonicalized input URLs against them. The
 * value is a checked-dynamic handle (the runtime's scr_urlpattern.c): the
 * lowering covers construction and instanceof, and the handle's members —
 * `exec`, `test`, the eight component pattern strings and
 * `hasRegExpGroups` — dispatch at run time. */

/** Whether `node` names the standard library's URLPattern global. */
export function isUrlPatternGlobal(lowerer: Lowerer, node: ts.Expression): boolean {
  return lowerer.isStdlibGlobal(node, "URLPattern");
}

/** `value instanceof URLPattern`: only the runtime's pattern handles are. */
export function lowerUrlPatternInstanceOf(
  lowerer: Lowerer,
  expr: ts.BinaryExpression,
): IrExpr | null {
  if (!isUrlPatternGlobal(lowerer, expr.right)) return null;
  const loc = locOf(expr);
  return {
    kind: "libCall",
    fn: "urlpattern.is",
    args: [lowerer.lowerExprExpecting(expr.left, DYN)],
    type: BOOL,
    loc,
  };
}

/** `new URLPattern([input[, baseURL]][, options])`: the arguments evaluate in
 * source order and reach the runtime as checked-dynamic values, which
 * coerce and validate them as Node does (a bad pattern or regexp throws a
 * catchable TypeError). */
export function lowerUrlPatternNew(lowerer: Lowerer, expr: ts.NewExpression): IrExpr | null {
  if (!isUrlPatternGlobal(lowerer, expr.expression)) return null;
  const args = expr.arguments?.nodes ?? [];
  if (args.length > 3 || args.some(ts.isSpreadElement)) {
    lowerer.noLowering(
      `URLPattern constructor with ${args.length} arguments`,
      expr,
      "use new URLPattern(input[, baseURL][, options])",
    );
  }
  const loc = locOf(expr);
  const lowered: IrExpr[] = [];
  for (let i = 0; i < 3; i++) {
    const arg = args[i];
    lowered.push(arg === undefined ? dynUndefinedExpr(loc) : lowerer.lowerExprExpecting(arg, DYN));
  }
  return { kind: "libCall", fn: "urlpattern.new", args: lowered, type: DYN, loc };
}
