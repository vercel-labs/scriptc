import * as ts from "../ts7/adapter.js";
import { isCjsJsFile, isNodeEsmFile } from "../program.js";

function hasUseStrictDirective(statements: readonly ts.Statement[]): boolean {
  for (const statement of statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression))
      return false;
    if (statement.expression.text === "use strict") return true;
  }
  return false;
}

/** Whether `node` runs in strict mode code: inside a class body, a function
 * with a "use strict" directive, a module, or a script that starts with
 * "use strict". CommonJS JavaScript is sloppy otherwise. */
export function isStrictCode(node: ts.Node): boolean {
  for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
    if (ts.isClassDeclaration(parent) || ts.isClassExpression(parent)) return true;
    if (
      ts.isFunctionLike(parent) &&
      parent.body &&
      ts.isBlock(parent.body) &&
      hasUseStrictDirective(parent.body.statements.nodes)
    )
      return true;
    if (ts.isSourceFile(parent)) {
      return (
        hasUseStrictDirective(parent.statements.nodes) ||
        (!isCjsJsFile(parent) && (isNodeEsmFile(parent) || ts.isExternalModule(parent)))
      );
    }
  }
  return false;
}
