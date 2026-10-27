import { keyedHelperName } from "../stable-names.js";
import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { locOf } from "../../program.js";
import { newFnCtx } from "../function-context.js";
import { BOOL, DYN, VOID, type IrExpr, type IrType } from "../../../ir/ir.js";
import { varRef } from "../../../ir/build.js";

/** Whether `node`'s static type is the standard library's DisposableStack. */
function isStdlibDisposableStack(lowerer: Lowerer, node: ts.Expression): boolean {
  const type = lowerer.checker.getBaseTypeOfLiteralType(lowerer.typeOf(node));
  for (const symbol of [type.getSymbol(), type.getAliasSymbol()]) {
    if (
      symbol !== undefined &&
      ts.symbolName(symbol) === "DisposableStack" &&
      lowerer.isStdlibSymbol(symbol)
    )
      return true;
  }
  return false;
}

/** `new DisposableStack()`: a native stack handle (scr_symbol.c). Its
 * members are function values and getters of the handle, reached through
 * the checked-dynamic method and property paths. Null for other
 * constructors. */
export function lowerDisposableStackNew(lowerer: Lowerer, expr: ts.NewExpression): IrExpr | null {
  if (!ts.isIdentifier(expr.expression) || expr.expression.text !== "DisposableStack") return null;
  const symbol = lowerer.resolveValueSymbol(expr.expression);
  if (!symbol || !lowerer.isStdlibSymbol(symbol)) return null;
  if ((expr.arguments?.nodes ?? []).length !== 0) return null;
  return { kind: "libCall", fn: "disposable.stackNew", args: [], type: DYN, loc: locOf(expr) };
}

/** `x instanceof DisposableStack`, or null when the right side is not the
 * standard library's DisposableStack. */
export function lowerDisposableStackInstanceOf(
  lowerer: Lowerer,
  expr: ts.BinaryExpression,
): IrExpr | null {
  if (!lowerer.isStdlibGlobal(expr.right, "DisposableStack")) return null;
  const value = lowerer.coerceInto(expr.left, lowerer.lowerExpr(expr.left), DYN);
  return { kind: "libCall", fn: "disposable.stackIs", args: [value], type: BOOL, loc: locOf(expr) };
}

/** `stack.use(value)` where `value` is a class instance. The dyn view of a
 * class instance has no methods, so the stack receives a function that
 * calls the class's [Symbol.dispose] method on the value, and the call
 * answers the value at its static type. Other values take the
 * checked-dynamic method path, which reads the value's [Symbol.dispose].
 * Null when the call is not that form. */
export function lowerDisposableStackUseCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (call.questionDotToken || access.questionDotToken) return null;
  if (access.name.text !== "use" || call.arguments.nodes.length !== 1) return null;
  const argNode = call.arguments.nodes[0]!;
  if (ts.isSpreadElement(argNode)) return null;
  if (!isStdlibDisposableStack(lowerer, access.expression)) return null;
  const valueT = lowerer.mapTypeOf(lowerer.typeOf(argNode));
  if (valueT?.kind === "union") {
    const arms = lowerer.unions.get(valueT.unionId)?.arms ?? [];
    if (arms.some((arm) => arm.kind === "object")) {
      lowerer.unsupported(
        "SC1090",
        argNode,
        "DisposableStack.use on a union with class instances (narrow the value to the class first)",
      );
    }
  }
  if (valueT?.kind !== "object") return null;
  const loc = locOf(call);
  const className = valueT.className;
  const info = lowerer.classes.get(className) ?? lowerer.flushDeferredClass(className);
  const found = info ? lowerer.findMethodOn(info, "sym:dispose") : null;
  if (!found) return null;
  if (found.sig.params.length !== 0) {
    lowerer.unsupported("SC1090", argNode, "[Symbol.dispose] methods with parameters");
  }
  const stack = lowerer.lowerExpr(access.expression);
  const value = lowerer.lowerExpr(argNode);
  const key = `disposableStack.use:${className}`;
  let helper = lowerer.valueHelpers.get(key);
  if (!helper) {
    helper = keyedHelperName(lowerer, "%disposableStack.use", key);
    lowerer.valueHelpers.set(key, helper);
    const context = newFnCtx(false, null, null, VOID);
    lowerer.fnStack.push(context);
    try {
      const param = lowerer.declareHiddenLocal("value", valueT);
      const self = varRef(param.id, valueT, loc);
      lowerer.liftedFns.push({
        name: helper,
        params: [{ localId: param.id, name: "value", type: valueT }],
        returnType: VOID,
        locals: context.locals,
        body: [
          {
            kind: "exprStmt",
            expr: lowerer.accessorCall(className, "sym:dispose", self, [], found.sig.ret, loc),
            loc,
          },
        ],
        loc,
      });
    } finally {
      lowerer.fnStack.pop();
    }
  }
  const stackLocal = lowerer.declareHiddenLocal("%disposableStack", DYN);
  const valueLocal = lowerer.declareHiddenLocal("%disposableValue", valueT);
  const fnT: IrType = { kind: "func", params: [valueT], ret: VOID };
  const dispose: IrExpr = { kind: "closure", fnName: helper, captures: [], type: fnT, loc };
  return {
    kind: "seqExpr",
    stmts: [
      { kind: "varDecl", localId: stackLocal.id, init: stack, loc },
      { kind: "varDecl", localId: valueLocal.id, init: value, loc },
      {
        kind: "exprStmt",
        expr: {
          kind: "libCall",
          fn: "disposable.stackUseCallback",
          args: [
            varRef(stackLocal.id, DYN, loc),
            lowerer.coerceToExpected(varRef(valueLocal.id, valueT, loc), DYN),
            lowerer.coerceToExpected(dispose, DYN),
          ],
          type: BOOL,
          loc,
        },
        loc,
      },
    ],
    result: varRef(valueLocal.id, valueT, loc),
    type: valueT,
    loc,
  };
}
