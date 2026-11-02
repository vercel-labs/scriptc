import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { locOf } from "../../program.js";
import { newFnCtx } from "../function-context.js";
import { keyedHelperName } from "../stable-names.js";
import { varRef } from "../../../ir/build.js";
import { BOOL, DYN, type IrExpr, type IrType } from "../../../ir/ir.js";

/** Whether `node`'s static type is the standard library's
 * AsyncDisposableStack. */
function isStdlibAsyncDisposableStack(lowerer: Lowerer, node: ts.Expression): boolean {
  const type = lowerer.checker.getBaseTypeOfLiteralType(lowerer.typeOf(node));
  for (const symbol of [type.getSymbol(), type.getAliasSymbol()]) {
    if (
      symbol !== undefined &&
      ts.symbolName(symbol) === "AsyncDisposableStack" &&
      lowerer.isStdlibSymbol(symbol)
    )
      return true;
  }
  return false;
}

/** `new AsyncDisposableStack()`: the native `await using` stack handle
 * (scr_async_disposable_stack.c). Its members — use, adopt, defer, move,
 * disposeAsync and the disposed getter — are function values and getters of
 * the handle, reached through the checked-dynamic method and property paths.
 * Null for other constructors. */
export function lowerAsyncDisposableStackNew(
  lowerer: Lowerer,
  expr: ts.NewExpression,
): IrExpr | null {
  if (!ts.isIdentifier(expr.expression) || expr.expression.text !== "AsyncDisposableStack")
    return null;
  const symbol = lowerer.resolveValueSymbol(expr.expression);
  if (!symbol || !lowerer.isStdlibSymbol(symbol)) return null;
  if ((expr.arguments?.nodes ?? []).length !== 0) return null;
  return { kind: "libCall", fn: "disposable.asyncStackNew", args: [], type: DYN, loc: locOf(expr) };
}

/** `x instanceof AsyncDisposableStack`, or null when the right side is not
 * the standard library's AsyncDisposableStack. */
export function lowerAsyncDisposableStackInstanceOf(
  lowerer: Lowerer,
  expr: ts.BinaryExpression,
): IrExpr | null {
  if (!lowerer.isStdlibGlobal(expr.right, "AsyncDisposableStack")) return null;
  const value = lowerer.coerceInto(expr.left, lowerer.lowerExpr(expr.left), DYN);
  return {
    kind: "libCall",
    fn: "disposable.asyncStackIs",
    args: [value],
    type: BOOL,
    loc: locOf(expr),
  };
}

/** `stack.use(value)` where `value` is a class instance. The dyn view of a
 * class instance has no methods, so the stack receives a function that
 * calls the class's own [Symbol.asyncDispose] — or, when the class has only
 * a synchronous [Symbol.dispose], that one — on the value, exactly as
 * DisposableStack's `use` does (disposable-stack.ts). Other values take the
 * checked-dynamic method path, which reads the value's methods itself. Null
 * when the call is not that form. */
export function lowerAsyncDisposableStackUseCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (call.questionDotToken || access.questionDotToken) return null;
  if (access.name.text !== "use" || call.arguments.nodes.length !== 1) return null;
  const argNode = call.arguments.nodes[0]!;
  if (ts.isSpreadElement(argNode)) return null;
  if (!isStdlibAsyncDisposableStack(lowerer, access.expression)) return null;
  const valueT = lowerer.mapTypeOf(lowerer.typeOf(argNode));
  if (valueT?.kind === "union") {
    const arms = lowerer.unions.get(valueT.unionId)?.arms ?? [];
    if (arms.some((arm) => arm.kind === "object")) {
      lowerer.unsupported(
        "SC1090",
        argNode,
        "AsyncDisposableStack.use on a union with class instances (narrow the value to the class first)",
      );
    }
  }
  if (valueT?.kind !== "object") return null;
  const loc = locOf(call);
  const className = valueT.className;
  const info = lowerer.classes.get(className) ?? lowerer.flushDeferredClass(className);
  // DisposeResources awaits the async method, so a class that has one uses
  // it; a sync-only class takes the specification's synchronous fallback.
  const asyncFound = info ? lowerer.findMethodOn(info, "sym:asyncDispose") : null;
  const syncFound = asyncFound ? null : info ? lowerer.findMethodOn(info, "sym:dispose") : null;
  const found = asyncFound ?? syncFound;
  if (!found) return null;
  const member = asyncFound ? "sym:asyncDispose" : "sym:dispose";
  if (found.sig.params.length !== 0) {
    lowerer.unsupported(
      "SC1090",
      argNode,
      `${asyncFound ? "[Symbol.asyncDispose]" : "[Symbol.dispose]"} methods with parameters`,
    );
  }
  // GetDisposeMethod with the async hint wraps a synchronous [Symbol.dispose]
  // in a promise that answers undefined whatever the method returns, and
  // DisposeResources awaits that wrapper: a promise the sync method happens to
  // return is never awaited. The lifted helper therefore discards the result,
  // so a sync-only resource settles in one hop and never suspends disposal on
  // a promise the method left behind. The async method's answer is awaited as
  // it is.
  const helperRet: IrType = syncFound ? { kind: "void" } : found.sig.ret;
  const stack = lowerer.lowerExpr(access.expression);
  const value = lowerer.lowerExpr(argNode);
  const key = `asyncDisposableStack.use:${className}:${member}`;
  let helper = lowerer.valueHelpers.get(key);
  if (!helper) {
    helper = keyedHelperName(lowerer, "%asyncDisposableStack.use", key);
    lowerer.valueHelpers.set(key, helper);
    const context = newFnCtx(false, null, null, helperRet);
    lowerer.fnStack.push(context);
    try {
      const param = lowerer.declareHiddenLocal("value", valueT);
      const self = varRef(param.id, valueT, loc);
      const callExpr = lowerer.accessorCall(className, member, self, [], found.sig.ret, loc);
      lowerer.liftedFns.push({
        name: helper,
        params: [{ localId: param.id, name: "value", type: valueT }],
        returnType: helperRet,
        locals: context.locals,
        body: [
          syncFound
            ? { kind: "exprStmt", expr: callExpr, loc }
            : { kind: "return", value: callExpr, loc },
        ],
        loc,
      });
    } finally {
      lowerer.fnStack.pop();
    }
  }
  const stackLocal = lowerer.declareHiddenLocal("%asyncDisposableStack", DYN);
  const valueLocal = lowerer.declareHiddenLocal("%asyncDisposableValue", valueT);
  const fnT: IrType = { kind: "func", params: [valueT], ret: helperRet };
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
          fn: "disposable.asyncStackUseCallback",
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
