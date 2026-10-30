import * as ts from "../../ts7/adapter.js";
import { isNodeEsmFile } from "../../program.js";
import type { Lowerer } from "../lowerer.js";

function hasUseStrictDirective(statements: readonly ts.Statement[]): boolean {
  for (const statement of statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression))
      return false;
    if (statement.expression.text === "use strict") return true;
  }
  return false;
}

/** Property refusal follows lexical JavaScript strictness. The checker's
 * forced external-module bit supplies scope isolation, not runtime ESM. */
export function isStrictPropertyOperation(lowerer: Lowerer, node: ts.Node): boolean {
  for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
    if (ts.isClassDeclaration(parent) || ts.isClassExpression(parent)) return true;
    if (
      ts.isFunctionLike(parent) &&
      parent.body &&
      ts.isBlock(parent.body) &&
      hasUseStrictDirective(parent.body.statements)
    )
      return true;
    if (ts.isSourceFile(parent))
      return hasUseStrictDirective(parent.statements) || isNodeEsmFile(parent, lowerer.program);
  }
  return false;
}

export function nativePropertySetOperation(lowerer: Lowerer, node: ts.Node): "set" | "setSloppy" {
  return isStrictPropertyOperation(lowerer, node) ? "set" : "setSloppy";
}
