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
  const inputs = args.map((arg) => {
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
    return value;
  });
  return { kind: "libCall", fn: "dyn.proxyNew", args: inputs, type: DYN, loc };
}
