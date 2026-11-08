import * as ts from "./ts7/adapter.js";

/** Whether an identifier in a function body reads the runtime arguments object. */
function isArgumentsRead(id: ts.Identifier): boolean {
  const parent = id.parent;
  // A shorthand object property reads its value, but other `name` positions
  // declare a binding or spell a property (including `o.arguments`).
  if (ts.isShorthandPropertyAssignment(parent)) return true;
  if ((parent as ts.Node & { name?: ts.Node }).name === id) return false;
  if (ts.isBindingElement(parent) && parent.propertyName === id) return false;
  if (ts.isLabeledStatement(parent) && parent.label === id) return false;
  if ((ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) && parent.label === id)
    return false;
  return true;
}

/** Does this function's own body read `arguments`? Nested plain functions and
 * methods own theirs; arrows inherit the enclosing one. */
export function bodyReadsArguments(fn: ts.Node): boolean {
  if (fn.body === undefined) return false;
  let found = false;
  // Iterative walking preserves the frontend's nesting fence on deep trees.
  ts.walkPreorder(fn.body, (node) => {
    if (ts.isTypeNode(node)) return "skip";
    if (ts.isIdentifier(node) && node.text === "arguments" && isArgumentsRead(node)) {
      found = true;
      return "stop";
    }
    if (ts.isFunctionLike(node) && !ts.isArrowFunction(node) && node !== fn) {
      return "skip";
    }
    return undefined;
  });
  return found;
}

/** Whether an expression is assigned, updated or deleted. */
function isWritten(expr: ts.Node): boolean {
  let node = expr;
  while (ts.isParenthesizedExpression(node.parent)) node = node.parent;
  const parent = node.parent;
  if (ts.isBinaryExpression(parent))
    return (
      parent.left === node &&
      parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    );
  if (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent))
    return (
      parent.operator === ts.SyntaxKind.PlusPlusToken ||
      parent.operator === ts.SyntaxKind.MinusMinusToken
    );
  if (ts.isForInStatement(parent) || ts.isForOfStatement(parent))
    return parent.initializer === node;
  if (
    ts.isArrayLiteralExpression(parent) ||
    ts.isSpreadElement(parent) ||
    ts.isShorthandPropertyAssignment(parent) ||
    (ts.isPropertyAssignment(parent) && parent.initializer === node)
  )
    return isWritten(parent);
  if (ts.isObjectLiteralExpression(parent) || ts.isSpreadAssignment(parent))
    return isWritten(parent);
  return ts.isDeleteExpression(parent);
}

/** Whether an identifier assigns its binding where it declares it: a
 * `var` with an initializer or in a for-in/for-of head, a destructured
 * element, or a function declaration's name. A redeclared parameter keeps
 * its binding, so each of these writes the parameter. */
function isDeclarationWrite(id: ts.Identifier): boolean {
  const parent = id.parent;
  if (ts.isVariableDeclaration(parent) && parent.name === id) {
    if (parent.initializer !== undefined) return true;
    const head = parent.parent?.parent;
    return (
      (ts.isForInStatement(head) || ts.isForOfStatement(head)) && head.initializer === parent.parent
    );
  }
  if (ts.isBindingElement(parent)) return parent.name === id;
  return ts.isFunctionDeclaration(parent) && parent.name === id;
}

/** Whether sloppy-mode `arguments` in `fn`'s own body behaves exactly like
 * an unmapped copy of the call's arguments. A mapped arguments object
 * aliases the named parameters, so it differs from a copy only when one
 * side is written after the other is read: reading `arguments.length`
 * never observes the aliasing, and element reads cannot observe it while
 * nothing writes an element or a parameter. The object itself must not
 * escape, since another holder could write through it. */
export function argumentsAliasingUnobservable(fn: ts.SignatureDeclaration): boolean {
  if (fn.body === undefined) return false;
  let elementReads = false;
  let escapes = false;
  ts.walkPreorder(fn.body, (node) => {
    if (ts.isTypeNode(node)) return "skip";
    if (ts.isFunctionLike(node) && !ts.isArrowFunction(node) && node !== fn) return "skip";
    if (!ts.isIdentifier(node) || node.text !== "arguments" || !isArgumentsRead(node))
      return undefined;
    const parent = node.parent;
    if (
      ts.isPropertyAccessExpression(parent) &&
      parent.expression === node &&
      parent.name.text === "length" &&
      !isWritten(parent)
    )
      return undefined;
    if (ts.isElementAccessExpression(parent) && parent.expression === node && !isWritten(parent)) {
      elementReads = true;
      return undefined;
    }
    escapes = true;
    return "stop";
  });
  if (escapes) return false;
  if (!elementReads) return true;
  const names = new Set<string>();
  for (const p of fn.parameters.nodes) {
    if (!ts.isIdentifier(p.name)) return false;
    names.add(p.name.text);
  }
  // Any write to a parameter's name, including from nested closures and
  // shadowing bindings, conservatively counts as a parameter write.
  let paramWritten = false;
  ts.walkPreorder(fn.body, (node) => {
    if (ts.isTypeNode(node)) return "skip";
    if (
      ts.isIdentifier(node) &&
      names.has(node.text) &&
      (isWritten(node) || isDeclarationWrite(node))
    ) {
      paramWritten = true;
      return "stop";
    }
    return undefined;
  });
  return !paramWritten;
}
