import * as ts from "../ts7/adapter.js";
import { DYN, type IrExpr, type IrType } from "../../ir/ir.js";
import { isJsSourceFile, locOf } from "../program.js";
import type { Lowerer } from "./lowerer.js";
import { bindingNeverReassigned } from "./binding-analysis.js";
import { implicitDefaultInstance } from "./generic-functions.js";
import { type FnSig } from "./call-signatures.js";

/** The JavaScript function declaration (or never-reassigned function
 * expression binding) `new` calls, when it is an ordinary constructor: not
 * a generator or async function. */
function jsConstructorFunctionOf(
  lowerer: Lowerer,
  expr: ts.NewExpression,
): ts.FunctionDeclaration | ts.FunctionExpression | null {
  if (!ts.isIdentifier(expr.expression) || lowerer.peekLocal(expr.expression)) return null;
  // This probe also sees ordinary classes during global collection. Leave
  // their deferred diagnostics for the class declaration's lowering.
  const wasCollecting = lowerer.collecting;
  let symbol: ts.Symbol | null = null;
  lowerer.collecting = true;
  try {
    symbol = lowerer.resolveValueSymbol(expr.expression);
  } finally {
    lowerer.collecting = wasCollecting;
  }
  if (!symbol) return null;
  const owner = symbol.declarations.find(
    (node) =>
      (ts.isFunctionDeclaration(node) && node.body !== undefined) ||
      (ts.isVariableDeclaration(node) &&
        node.initializer &&
        ts.isFunctionExpression(node.initializer)),
  );
  const declaration =
    owner &&
    ts.isVariableDeclaration(owner) &&
    owner.initializer &&
    ts.isFunctionExpression(owner.initializer)
      ? owner.initializer
      : owner && ts.isFunctionDeclaration(owner)
        ? owner
        : null;
  if (
    !owner ||
    !declaration?.body ||
    !bindingNeverReassigned(lowerer, symbol, owner) ||
    !isJsSourceFile(ts.getSourceFileOfNode(declaration)) ||
    declaration.asteriskToken ||
    declaration.modifiers?.nodes.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
  )
    return null;
  return declaration;
}

/** An ordinary constructor's explicit object return replaces its receiver.
 * Without observing this or new.target, it can use the function's call ABI. */
function isObjectFactoryNew(lowerer: Lowerer, expr: ts.NewExpression): boolean {
  const declaration = jsConstructorFunctionOf(lowerer, expr);
  if (!declaration?.body) return false;
  const objectReturn = (expression: ts.Expression): boolean =>
    ts.isObjectLiteralExpression(expression) ||
    ts.isArrayLiteralExpression(expression) ||
    ts.isArrowFunction(expression) ||
    ts.isFunctionExpression(expression) ||
    ts.isNewExpression(expression);
  const last = declaration.body.statements.nodes.at(-1);
  if (!last || !ts.isReturnStatement(last) || !last.expression || !objectReturn(last.expression))
    return false;
  let safe = true;
  const visit = (node: ts.Node, nestedArrow = false): void => {
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      safe = false;
      return;
    }
    if (ts.isFunctionLike(node)) {
      if (!ts.isArrowFunction(node)) return;
      nestedArrow = true;
    }
    if (node.kind === ts.SyntaxKind.ThisKeyword || ts.isMetaProperty(node)) safe = false;
    if (
      !nestedArrow &&
      ts.isReturnStatement(node) &&
      (!node.expression || !objectReturn(node.expression))
    )
      safe = false;
    ts.forEachChild(node, (child) => visit(child, nestedArrow));
  };
  for (const parameter of declaration.parameters.nodes) visit(parameter);
  visit(declaration.body);
  return safe;
}

/** Collection must register the shared result before reaching factory
 * bodies: those bodies can reference later globals in the same module. */
/** The storage of a JavaScript module binding initialized with `new` of an
 * ordinary function: a factory's result and a constructor function's
 * receiver (`const head = new Segment()`) are both checked-dynamic
 * values, which functions declared elsewhere in the module read through
 * the global. */
export function objectFactoryGlobalType(lowerer: Lowerer, expr: ts.NewExpression): IrType | null {
  return jsConstructorFunctionOf(lowerer, expr) !== null ? DYN : null;
}

export function objectFactorySignature(lowerer: Lowerer, expr: ts.NewExpression): FnSig | null {
  if (!ts.isIdentifier(expr.expression) || !isObjectFactoryNew(lowerer, expr)) return null;
  const generic = lowerer.genericFnOf(expr.expression);
  const signature = generic?.implicitParams
    ? implicitDefaultInstance(lowerer, expr, generic)
    : lowerer.fnSigOf(expr.expression);
  return signature && signature.returnType.kind !== "void" ? signature : null;
}

export function lowerObjectFactoryNew(lowerer: Lowerer, expr: ts.NewExpression): IrExpr | null {
  const signature = objectFactorySignature(lowerer, expr);
  if (!signature) return null;
  const loc = locOf(expr);
  lowerer.noteEdge(signature.name);
  return {
    kind: "call",
    callee: signature.name,
    args: lowerer.completeArgs(expr.arguments?.nodes ?? [], signature.params, loc, expr),
    type: signature.returnType,
    loc,
  };
}
