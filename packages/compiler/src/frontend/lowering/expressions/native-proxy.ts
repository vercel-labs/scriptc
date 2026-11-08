import * as ts from "../../ts7/adapter.js";
import { isJsSourceFile, locOf } from "../../program.js";
import { DYN, type IrExpr } from "../../../ir/ir.js";
import type { Lowerer } from "../lowerer.js";

/** These values must stay checked-native instead of being copied into the
 * target's inferred record layout, including hoisted and module bindings. */
export function isNativeProxyInitializer(
  lowerer: Lowerer,
  expression: ts.Expression | undefined,
): boolean {
  if (!expression) return false;
  while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
  return (
    ts.isNewExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "Proxy" &&
    lowerer.isStdlibSymbol(lowerer.resolveValueSymbol(expression.expression) ?? undefined)
  );
}

export function lowerNativeProxy(lowerer: Lowerer, expr: ts.NewExpression): IrExpr {
  const loc = locOf(expr);
  const args = expr.arguments?.nodes ?? [];
  if (args.length !== 2 || args.some(ts.isSpreadElement))
    lowerer.noLowering("new Proxy with this argument list", expr);
  const handler = args[1]!;
  if (isJsSourceFile(ts.getSourceFileOfNode(expr)) && ts.isObjectLiteralExpression(handler)) {
    for (const prop of handler.properties.nodes) {
      const callback = ts.isMethodDeclaration(prop)
        ? prop
        : ts.isPropertyAssignment(prop) &&
            (ts.isFunctionExpression(prop.initializer) || ts.isArrowFunction(prop.initializer))
          ? prop.initializer
          : null;
      if (!callback) continue;
      if (!callback.type) lowerer.runtimeOptionalFunctionReturns.set(callback, DYN);
      // The native trap ABI passes live checked values. Contextual
      // ProxyHandler types include symbols, which this boundary
      // explicitly refuses; they must not force a copying record
      // parameter or an unboxable string|symbol closure signature.
      for (const param of callback.parameters.nodes) {
        if (ts.isIdentifier(param.name) && !param.type && !param.dotDotDotToken)
          lowerer.checkedCallbackParams.add(param);
      }
    }
  }
  const inputs = args.map((arg, index) => {
    let value = ts.isObjectLiteralExpression(arg)
      ? lowerer.lowerExprExpecting(arg, DYN)
      : lowerer.lowerExpr(arg);
    if (value.type.kind !== "dyn" && lowerer.dynConvertible(value.type))
      value = lowerer.coerceToExpected(value, DYN);
    if (value.type.kind !== "dyn") {
      lowerer.unsupported(
        "SC1090",
        arg,
        "Proxy targets and handlers outside checked-native object storage",
      );
    }
    // The runtime's Proxy constructor takes an untyped object as the handler,
    // and an untyped object, a function or a plain record as the target. A
    // handler that reaches it as a reference to typed storage (dynFrom's
    // typed capsule: a record boxed with liveRef, or any class instance), and
    // a target that is a class instance or an array, are refused every time
    // the construction runs, so they are refused here. Other typed targets
    // (a union of records, say) are decided by the value at run time.
    const typed = value.kind === "dynFrom" ? value.value.type : null;
    if (typed !== null) {
      if (
        index === 1 &&
        ((value.kind === "dynFrom" && value.liveRef === true && typed.kind === "record") ||
          typed.kind === "object")
      )
        lowerer.unsupported(
          "SC1090",
          arg,
          "Proxy handlers whose traps have typed signatures",
          "declare each trap's parameters and result as 'any', for example get(target: any, key: string | symbol): any, so the handler is built as an untyped object",
        );
      if (index === 0 && (typed.kind === "object" || typed.kind === "array"))
        lowerer.unsupported(
          "SC1090",
          arg,
          "a Proxy over a class instance or an array",
          "proxy a plain object: an object literal, or a value typed 'any'",
        );
    }
    return value;
  });
  return { kind: "libCall", fn: "dyn.proxyNew", args: inputs, type: DYN, loc };
}
