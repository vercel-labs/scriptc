import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";

/** Whether the code in `root` writes a member through, or compares the
 * identity of, the binding `symbol`: the uses a copy of the value would not
 * be seen through. Symbol identity, not the name, so a shadowing
 * declaration of the same name is not mistaken for the binding. */
export function observesIdentity(
  lowerer: Lowerer,
  root: ts.Node,
  symbol: ts.Symbol,
  name: string,
): boolean {
  let found = false;
  const checker = lowerer.checker;
  const isBinding = (node: ts.Expression): boolean => {
    let e = node;
    while (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
    if (!ts.isIdentifier(e) || e.text !== name) return false;
    return checker.getSymbolAtLocation(e) === symbol;
  };
  const rootOf = (node: ts.Expression): ts.Expression => {
    let cur = node;
    for (;;) {
      if (ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur))
        cur = cur.expression;
      else if (ts.isParenthesizedExpression(cur) || ts.isNonNullExpression(cur))
        cur = cur.expression;
      else return cur;
    }
  };
  const writesThrough = (node: ts.Expression): boolean =>
    (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
    isBinding(rootOf(node));
  const isNullish = (node: ts.Expression): boolean =>
    node.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(node) && node.text === "undefined") ||
    ts.isVoidExpression(node);
  const visit = (node: ts.Node): "stop" | "skip" | undefined => {
    if (found) return "stop";
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      if (
        (op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
          op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
          op === ts.SyntaxKind.EqualsEqualsToken ||
          op === ts.SyntaxKind.ExclamationEqualsToken) &&
        (isBinding(node.left) || isBinding(node.right)) &&
        !isNullish(node.left) &&
        !isNullish(node.right)
      ) {
        found = true;
        return "stop";
      }
      if (
        op >= ts.SyntaxKind.FirstAssignment &&
        op <= ts.SyntaxKind.LastAssignment &&
        writesThrough(node.left)
      ) {
        found = true;
        return "stop";
      }
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken) &&
      writesThrough(node.operand)
    ) {
      found = true;
      return "stop";
    }
    if (ts.isDeleteExpression(node) && writesThrough(node.expression)) {
      found = true;
      return "stop";
    }
    return undefined;
  };
  ts.walkPreorder(root, visit);
  return found;
}

/** Whether `name`'s binding in `decl` is written through or identity-
 * compared anywhere in its scope. An annotation that must copy the value
 * loses those writes; a declaration or literal whose contents are not used
 * this way converts without an observable difference. The scan covers the
 * whole scope because a function declared before the binding can still
 * write through it when the program calls the function after the
 * declaration. */
export function observesDeclaration(lowerer: Lowerer, decl: ts.VariableDeclaration): boolean {
  if (!ts.isIdentifier(decl.name) || decl.initializer === undefined) return false;
  const symbol = lowerer.checker.getSymbolAtLocation(decl.name);
  if (!symbol) return false;
  const scope = enclosingScope(decl);
  if (scope === undefined) return false;
  return observesIdentity(lowerer, scope, symbol, decl.name.text);
}

/** The innermost block or source file containing `node`. */
export function enclosingScope(node: ts.Node): ts.Node | undefined {
  let cur = node.parent;
  while (cur !== undefined && !ts.isBlock(cur) && !ts.isSourceFile(cur)) cur = cur.parent;
  return cur;
}
