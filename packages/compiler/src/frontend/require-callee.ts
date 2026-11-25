/** A require callee: the bare identifier `require`, or the CommonJS module
 * object's own method `module.require` — Node's alias for the same loader,
 * resolving from the module it names. Every module edge, statement
 * lowering, and JSON, builtin, package or program-module require path asks
 * this one question before treating a call as a require. Kept in its own
 * module so the syntactic analyses that only need the shape do not have to
 * reach into the program loader.
 *
 * `module.require` is only the global loader when `module` IS the CommonJS
 * module global: a parameter or local named `module` (a permission-checking
 * loader handed in, say) keeps its own method call. Pass a checker wherever
 * one is in hand so that distinction is made by binding; the syntactic
 * answer accepts the spelling and is only for the passes that over-approximate
 * candidates before a bound decision is made. */
import * as ts from "./ts7/adapter.js";

export function isCjsModuleReceiver(expr: ts.Expression, checker?: ts.TypeChecker): boolean {
  if (!ts.isIdentifier(expr) || expr.text !== "module") return false;
  if (checker === undefined) return true;
  const symbol = checker.getSymbolAtLocation(expr);
  if (symbol === undefined) return true;
  return symbol.declarations.every((decl) => ts.getSourceFileOfNode(decl).isDeclarationFile);
}

export function isRequireCallee(expr: ts.Expression, checker?: ts.TypeChecker): boolean {
  if (ts.isIdentifier(expr)) return expr.text === "require";
  return (
    ts.isPropertyAccessExpression(expr) &&
    !expr.questionDotToken &&
    expr.name.text === "require" &&
    isCjsModuleReceiver(expr.expression, checker)
  );
}
