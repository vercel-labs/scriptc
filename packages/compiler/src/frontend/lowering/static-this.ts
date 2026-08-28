import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";

/** Walk a static class context for `this`/`super`. Arrows inherit the
 * surrounding receiver and remain transparent; declarations that bind
 * their own receiver (and nested classes) are opaque. */
export function rejectStaticThis(
  lowerer: Lowerer,
  root: ts.Node,
  message: (keyword: "this" | "super") => string,
  includeRoot = false,
): void {
  const visit = (node: ts.Node): void => {
    if (
      ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node) ||
      ts.isGetAccessor(node) || ts.isSetAccessor(node) ||
      ts.isClassDeclaration(node) || ts.isClassExpression(node)
    ) {
      return;
    }
    if (node.kind === ts.SyntaxKind.ThisKeyword || node.kind === ts.SyntaxKind.SuperKeyword) {
      const keyword = node.kind === ts.SyntaxKind.ThisKeyword ? "this" : "super";
      lowerer.unsupported("SC1090", node, message(keyword));
    }
    node.forEachChild(visit);
  };
  if (includeRoot) visit(root);
  else root.forEachChild(visit);
}
