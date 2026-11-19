import * as ts from "./ts7/adapter.js";
import { withoutParenthesesTypeWrappers } from "./outer-expressions.js";

/** Fold string literals, concatenations and const initializers for module
 * resolution and namespace member selection. Return null for dynamic keys. */
export function staticString(
  owner: { checker: ts.TypeChecker },
  node: ts.Expression | undefined,
  depth = 0,
): string | null {
  if (node === undefined || depth > 8) return null;
  const value = withoutParenthesesTypeWrappers(node);
  if (ts.isStringLiteralLike(value)) return value.text;
  if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticString(owner, value.left, depth + 1);
    if (left === null) return null;
    const right = staticString(owner, value.right, depth + 1);
    return right === null ? null : left + right;
  }
  if (ts.isIdentifier(value)) {
    const decl = owner.checker.getSymbolAtLocation(value)?.valueDeclaration;
    if (
      decl !== undefined &&
      ts.isVariableDeclaration(decl) &&
      decl.initializer !== undefined &&
      decl.initializer !== value &&
      ts.isVariableDeclarationList(decl.parent) &&
      (decl.parent.flags & ts.NodeFlags.Const) !== 0
    )
      return staticString(owner, decl.initializer, depth + 1);
  }
  return null;
}
