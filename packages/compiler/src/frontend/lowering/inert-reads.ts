/* Name and property reads that declaration-time code emitted ahead of them
 * cannot be observed by (class-statics-position.ts InertRead).
 *
 * A class's static initializers and static blocks lower at the top-level
 * statement whose evaluation is the class's own. When the class is built in
 * an argument position, JavaScript evaluates the callee and the earlier
 * arguments first, so the emitted code may run ahead of them only when they
 * run no code and read nothing that code could write. A read qualifies when:
 *
 * - it is a name whose binding nothing in the program writes after its
 *   declaration. A module's own bindings are written only in their file
 *   (imports are read-only); a global (a script file's top level, or an
 *   ambient declaration) may be written from any file, so every program
 *   file is scanned;
 * - or it is a property read (`a.b`) of such a read whose property resolves
 *   to declarations none of which is an accessor (a getter runs code), and
 *   whose name the program never assigns, updates or deletes on any
 *   receiver.
 *
 * Anything else (a call, an element access, a read through `any`) is not
 * inert. */
import * as ts from "../ts7/adapter.js";
import { bindingNeverReassigned, fileWritesBinding } from "../binding-writes.js";
import { withoutParentheses } from "../outer-expressions.js";
import type { InertRead } from "../class-statics-position.js";
import type { Lowerer } from "./lowerer.js";

/** The InertRead the statics position walk takes, over `lowerer`. */
export function inertReadOf(lowerer: Lowerer): InertRead {
  return (expression) => inertRead(lowerer, expression);
}

function inertRead(lowerer: Lowerer, expression: ts.Expression): boolean {
  const e = withoutParentheses(expression);
  if (ts.isIdentifier(e)) return bindingNeverWritten(lowerer, e);
  if (ts.isPropertyAccessExpression(e)) {
    if (!ts.isIdentifier(e.name) || !inertRead(lowerer, e.expression)) return false;
    const symbol = lowerer.checker.getSymbolAtLocation(e.name);
    if (
      symbol === undefined ||
      symbol.declarations.length === 0 ||
      symbol.declarations.some(
        (d) => ts.isGetAccessorDeclaration(d) || ts.isSetAccessorDeclaration(d),
      )
    )
      return false;
    return !propertyNameWritten(lowerer, e.name.text);
  }
  return false;
}

function bindingNeverWritten(lowerer: Lowerer, ident: ts.Identifier): boolean {
  const symbol = lowerer.resolveValueSymbol(ident);
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations[0];
  if (!symbol || !declaration) return false;
  const home = ts.getSourceFileOfNode(declaration);
  if (!home.isDeclarationFile && ts.isExternalModule(home))
    return bindingNeverReassigned(lowerer.bindingScope(), symbol, declaration);
  const name = ts.symbolName(symbol);
  const resolve = (id: ts.Identifier): ts.Symbol | null | undefined =>
    lowerer.resolveValueSymbol(id);
  for (const file of lowerer.program.getImplementationSourceFiles()) {
    if (file.isDeclarationFile || !lowerer.facts.maySpellIdentifier(file, name)) continue;
    if (fileWritesBinding(symbol, file, resolve)) return false;
  }
  return true;
}

/** Whether a program file assigns, updates or deletes a property spelled
 * `name` on any receiver, a destructuring assignment target included. */
function propertyNameWritten(lowerer: Lowerer, name: string): boolean {
  let written = false;
  const namesProperty = (n: ts.Node): boolean =>
    (ts.isPropertyAccessExpression(n) && n.name.text === name) ||
    (ts.isElementAccessExpression(n) &&
      ts.isStringLiteralLike(n.argumentExpression) &&
      n.argumentExpression.text === name);
  const scanPattern = (n: ts.Node): void => {
    if (written) return;
    if (namesProperty(n)) written = true;
    else ts.forEachChild(n, scanPattern);
  };
  const visit = (n: ts.Node): void => {
    if (written) return;
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      n.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      const target = withoutParentheses(n.left);
      if (namesProperty(target)) written = true;
      else if (ts.isArrayLiteralExpression(target) || ts.isObjectLiteralExpression(target))
        scanPattern(target);
    } else if (
      (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
      (n.operator === ts.SyntaxKind.PlusPlusToken ||
        n.operator === ts.SyntaxKind.MinusMinusToken) &&
      namesProperty(withoutParentheses(n.operand))
    )
      written = true;
    else if (ts.isDeleteExpression(n) && namesProperty(withoutParentheses(n.expression)))
      written = true;
    else if (
      (ts.isForOfStatement(n) || ts.isForInStatement(n)) &&
      !ts.isVariableDeclarationList(n.initializer)
    )
      scanPattern(n.initializer);
    ts.forEachChild(n, visit);
  };
  for (const file of lowerer.program.getImplementationSourceFiles()) {
    if (file.isDeclarationFile || !lowerer.facts.maySpellIdentifier(file, name)) continue;
    ts.forEachChild(file, visit);
    if (written) return true;
  }
  return false;
}
