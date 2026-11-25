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
  allowThis = false,
  allowSuper = false,
): void {
  const visit = (node: ts.Node): void => {
    if (
      ts.isFunctionExpression(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isGetAccessor(node) ||
      ts.isSetAccessor(node) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node)
    ) {
      return;
    }
    if (
      (node.kind === ts.SyntaxKind.ThisKeyword && !allowThis) ||
      (node.kind === ts.SyntaxKind.SuperKeyword && !allowSuper)
    ) {
      const keyword = node.kind === ts.SyntaxKind.ThisKeyword ? "this" : "super";
      lowerer.unsupported("SC1090", node, message(keyword));
    }
    ts.forEachChild(node, visit);
  };
  if (includeRoot) visit(root);
  else ts.forEachChild(root, visit);
}

export function hasStaticThis(root: ts.Node): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.ThisKeyword) found = true;
    if (
      (ts.isFunctionLike(node) && !ts.isArrowFunction(node)) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node)
    )
      return;
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(root, visit);
  return found;
}

/** Whether a member's body depends on the class it is read or called
 * through: it reads `this`, or, in a static method or accessor, a `super`
 * member, which runs with the same receiver. Such a member lowers once per
 * receiver class. */
export function usesStaticReceiver(root: ts.Node): boolean {
  const staticMember =
    (ts.isMethodDeclaration(root) || ts.isAccessor(root)) &&
    ts.getModifiers(root)?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword) === true;
  let found = false;
  const visit = (node: ts.Node): void => {
    if (
      node.kind === ts.SyntaxKind.ThisKeyword ||
      (staticMember && node.kind === ts.SyntaxKind.SuperKeyword)
    )
      found = true;
    if (
      (ts.isFunctionLike(node) && !ts.isArrowFunction(node)) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node)
    )
      return;
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(root, visit);
  return found;
}

/** Private names belong to the lexical class, independently of any
 * same-spelled member in a receiver's subclass. */
export function hasLexicalPrivateReference(root: ts.Node): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) return;
    if (ts.isPrivateIdentifier(node)) found = true;
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(root, visit);
  return found;
}
