import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { locOf } from "../../program.js";
import { builtinCalleeName, refuseWrittenBuiltin } from "../lower-calls.js";
import { BOOL, DYN, STRING, type IrExpr, type IrStmt } from "../../../ir/ir.js";
import { numLit } from "../../../ir/build.js";

/* AbortSignal as a value. Node's global is a constructor whose `new` throws
 * the ERR_ILLEGAL_CONSTRUCTOR TypeError, and the signals the runtime hands
 * out are native checked-dynamic handles (scr_abort.c). `value instanceof
 * AbortSignal` is therefore the handle's tag test: a signal answers true and
 * every other value — undefined, a controller, a plain object — answers
 * false, which is what Node's prototype chain answers for the interface's
 * real instances. */

/** Whether `node` names the standard library's AbortSignal global. */
export function isAbortSignalGlobal(lowerer: Lowerer, node: ts.Expression): boolean {
  return lowerer.isStdlibGlobal(node, "AbortSignal");
}

/** `value instanceof AbortSignal`, or null when the right side is something
 * else. Both operands evaluate left to right; the left value reaches the
 * runtime as a checked-dynamic value, which is how every non-signal answers
 * false. */
export function lowerAbortSignalInstanceOf(
  lowerer: Lowerer,
  expr: ts.BinaryExpression,
): IrExpr | null {
  if (!isAbortSignalGlobal(lowerer, expr.right)) return null;
  const loc = locOf(expr);
  return {
    kind: "libCall",
    fn: "abort.signalIs",
    args: [lowerer.lowerExprExpecting(expr.left, DYN)],
    type: BOOL,
    loc,
  };
}

/** `new AbortSignal()`: Node's constructor is not callable with `new` (its
 * internal constructor throws ERR_ILLEGAL_CONSTRUCTOR), so the expression
 * evaluates its arguments — a call's arguments run before the constructor
 * throws — and then throws Node's TypeError. Null for other constructors. */
export function lowerAbortSignalNew(lowerer: Lowerer, expr: ts.NewExpression): IrExpr | null {
  if (!isAbortSignalGlobal(lowerer, expr.expression)) return null;
  const named = builtinCalleeName(lowerer, expr);
  if (named === null) return null;
  const symbol = lowerer.resolveValueSymbol(named);
  if (!symbol || !lowerer.isStdlibSymbol(symbol)) return null;
  refuseWrittenBuiltin(lowerer, expr, named);
  const args = expr.arguments?.nodes ?? [];
  if (args.some((argument) => ts.isSpreadElement(argument))) return null;
  const loc = locOf(expr);
  const stmts: IrStmt[] = args.map((argument) => ({
    kind: "exprStmt",
    expr: lowerer.lowerExpr(argument),
    loc: locOf(argument),
  }));
  const thrown: IrExpr = {
    kind: "libCall",
    fn: "error.nodeThrow",
    args: [
      numLit(1, loc),
      { kind: "strLit", value: "ERR_ILLEGAL_CONSTRUCTOR", type: STRING, loc },
      { kind: "strLit", value: "Illegal constructor", type: STRING, loc },
    ],
    type: DYN,
    loc,
  };
  if (stmts.length === 0) return thrown;
  return { kind: "seqExpr", stmts, result: thrown, type: DYN, loc };
}
