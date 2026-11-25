/** A require callee: the bare identifier `require`, or the CommonJS module
 * object's own method `module.require` — Node's alias for the same loader,
 * resolving from the module it names. Every module edge, statement
 * lowering, and JSON, builtin, package or program-module require path asks
 * this one question before treating a call as a require. Kept in its own
 * module so the syntactic analyses that only need the shape do not have to
 * reach into the program loader. */
import * as ts from "./ts7/adapter.js";

export function isRequireCallee(expr: ts.Expression): boolean {
  if (ts.isIdentifier(expr)) return expr.text === "require";
  return (
    ts.isPropertyAccessExpression(expr) &&
    !expr.questionDotToken &&
    expr.name.text === "require" &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === "module"
  );
}
