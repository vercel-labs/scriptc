import * as ts from "../../ts7/adapter.js";
import type { Lowerer } from "../lowerer.js";
import { identifiersNamed } from "../identifier-uses.js";
import { bindingNeverReassigned } from "../binding-analysis.js";
import { matchCallbackParamGroupsOf, matchResultNamedGroupsOf } from "../lower-exprs.js";

/** Whether the rows a matchAll drain produces are read only through their
 * elements: element reads and `in` tests with number keys, `.length`, the compile-time
 * `.groups` projection, `{ groups }` destructuring and, on a for-of binding
 * over the drain itself (`companion`), the companion-index `.index`. Rows
 * reach these reads through for-of loops, spreads, `Array.from`, stored
 * const bindings, `filter`/`slice`/`toReversed` copies, `find`/`findLast`/
 * `at` picks and inline callbacks of the array methods below. No such read
 * can observe a row's `index`, `input` or `groups` properties, so the
 * drain leaves them out. False for any other use. */
export function matchAllRowsReadByElements(
  lowerer: Lowerer,
  drain: ts.Expression,
  companion: boolean,
): boolean {
  const parent = outerValue(drain).parent;
  if (
    ts.isCallExpression(parent) &&
    parent.arguments.nodes[0] === outerValue(drain) &&
    ts.isPropertyAccessExpression(parent.expression) &&
    parent.expression.name.text === "from" &&
    lowerer.isStdlibGlobal(parent.expression.expression, "Array")
  ) {
    const mapper = parent.arguments.nodes[1];
    if (mapper === undefined) return rowsReadByElements(lowerer, parent, 0);
    return parent.arguments.nodes.length === 2 && callbackReadsByElements(lowerer, mapper, 2);
  }
  if (ts.isForOfStatement(parent) && parent.expression === outerValue(drain))
    return forOfReadsByElements(lowerer, parent, companion);
  return rowsReadByElements(lowerer, drain, 0);
}

/** matchAllRowsReadByElements for a stored drain, `const rows =
 * s.matchAll(re)`: a const-binding for-of loop over `rows` in the same
 * function walks the companion indices, so its binding may also read
 * `.index`. */
export function storedMatchAllRowsReadByElements(
  lowerer: Lowerer,
  decl: ts.VariableDeclaration,
): boolean {
  const scope = enclosingFunction(decl);
  return constBindingReadsByElements(lowerer, decl, (use) => {
    const parent = outerValue(use).parent;
    if (
      ts.isForOfStatement(parent) &&
      parent.expression === outerValue(use) &&
      ts.isVariableDeclarationList(parent.initializer) &&
      (parent.initializer.flags & ts.NodeFlags.Const) !== 0 &&
      enclosingFunction(parent) === scope
    )
      return forOfReadsByElements(lowerer, parent, true);
    return rowsReadByElements(lowerer, use, 1);
  });
}

function enclosingFunction(node: ts.Node): ts.Node | undefined {
  let at = node.parent;
  while (at !== undefined && !ts.isFunctionLike(at)) at = at.parent;
  return at;
}

/** Array methods whose first argument is a callback over the rows. */
const ROW_CALLBACK_METHODS = new Set([
  "map",
  "forEach",
  "filter",
  "some",
  "every",
  "find",
  "findLast",
  "findIndex",
  "findLastIndex",
  "flatMap",
]);

/** Array methods whose result holds rows of the receiver. */
const ROW_SUBSET_METHODS = new Set(["filter", "slice", "toReversed"]);

/** Array methods that return one row of the receiver. */
const ROW_PICK_METHODS = new Set(["find", "findLast", "at"]);

/** Bounds the walk through stored bindings and copies. */
const MAX_DEPTH = 8;

function outerValue(node: ts.Node): ts.Node {
  let ref = node;
  while (ts.isParenthesizedExpression(ref.parent) || ts.isNonNullExpression(ref.parent))
    ref = ref.parent;
  return ref;
}

/** `node` evaluates to an array of rows. */
function rowsReadByElements(lowerer: Lowerer, node: ts.Node, depth: number): boolean {
  if (depth > MAX_DEPTH) return false;
  const ref = outerValue(node);
  const parent = ref.parent;
  if (ts.isSpreadElement(parent)) {
    const literal = parent.parent;
    return (
      ts.isArrayLiteralExpression(literal) &&
      literal.elements.nodes.length === 1 &&
      rowsReadByElements(lowerer, literal, depth + 1)
    );
  }
  if (ts.isForOfStatement(parent) && parent.expression === ref)
    return forOfReadsByElements(lowerer, parent, false);
  if (ts.isVariableDeclaration(parent) && parent.initializer === ref)
    return constBindingReadsByElements(lowerer, parent, (use) =>
      rowsReadByElements(lowerer, use, depth + 1),
    );
  if (ts.isElementAccessExpression(parent) && parent.expression === ref)
    return numberKeyRead(lowerer, parent) && rowReadByElements(lowerer, parent, depth + 1);
  if (!ts.isPropertyAccessExpression(parent) || parent.expression !== ref) return false;
  if (parent.questionDotToken !== undefined || !lowerer.isStdlibMember(parent)) return false;
  const method = parent.name.text;
  const call = parent.parent;
  if (!ts.isCallExpression(call) || call.expression !== parent)
    return method === "length" && isValueRead(parent);
  if (ROW_CALLBACK_METHODS.has(method)) {
    if (
      call.arguments.nodes.length !== 1 ||
      !callbackReadsByElements(lowerer, call.arguments.nodes[0]!, 2)
    )
      return false;
  } else if (ROW_SUBSET_METHODS.has(method) || ROW_PICK_METHODS.has(method)) {
    if (call.arguments.nodes.some((a) => ts.isSpreadElement(a))) return false;
  } else {
    return false;
  }
  if (ROW_SUBSET_METHODS.has(method)) return rowsReadByElements(lowerer, call, depth + 1);
  if (ROW_PICK_METHODS.has(method)) return rowReadByElements(lowerer, call, depth + 1);
  return true;
}

/** `node` evaluates to one row. */
function rowReadByElements(lowerer: Lowerer, node: ts.Node, depth: number): boolean {
  if (depth > MAX_DEPTH) return false;
  const ref = outerValue(node);
  const parent = ref.parent;
  if (ts.isExpressionStatement(parent)) return true;
  if (ts.isElementAccessExpression(parent) && parent.expression === ref)
    return numberKeyRead(lowerer, parent);
  // `1 in m`: a number key tests an element.
  if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.InKeyword &&
    parent.right === ref
  )
    return lowerer.mapTypeOf(lowerer.typeOf(parent.left))?.kind === "f64";
  if (ts.isPropertyAccessExpression(parent) && parent.expression === ref) {
    if (parent.questionDotToken !== undefined || !isValueRead(parent)) return false;
    if (parent.name.text === "length") return true;
    return parent.name.text === "groups" && groupsProjected(lowerer, ref as ts.Expression);
  }
  if (ts.isVariableDeclaration(parent) && parent.initializer === ref) {
    if (ts.isObjectBindingPattern(parent.name))
      return groupsPattern(parent.name) && groupsProjected(lowerer, ref as ts.Expression);
    return constBindingReadsByElements(lowerer, parent, (use) =>
      rowReadByElements(lowerer, use, depth + 1),
    );
  }
  return false;
}

/** A for-of loop over rows: its binding is read by elements, or by its
 * companion `.index` when the loop walks the drain itself. */
function forOfReadsByElements(
  lowerer: Lowerer,
  loop: ts.ForOfStatement,
  companion: boolean,
): boolean {
  const list = loop.initializer;
  if (!ts.isVariableDeclarationList(list) || list.declarations.nodes.length !== 1) return false;
  const decl = list.declarations.nodes[0]!;
  if (!ts.isIdentifier(decl.name)) return false;
  const symbol = lowerer.resolveValueSymbol(decl.name);
  if (!symbol || !bindingNeverReassigned(lowerer, symbol, decl)) return false;
  return usesOf(lowerer, decl.name, symbol).every((use) => {
    const parent = outerValue(use).parent;
    if (
      companion &&
      ts.isPropertyAccessExpression(parent) &&
      parent.name.text === "index" &&
      parent.questionDotToken === undefined &&
      isValueRead(parent)
    )
      return true;
    return rowReadByElements(lowerer, use, 1);
  });
}

/** An inline callback whose first parameter (a row) is read by elements.
 * The callback may name at most `maxParams` parameters, which keeps the
 * array argument (the rows themselves) out of reach. */
function callbackReadsByElements(
  lowerer: Lowerer,
  node: ts.Expression,
  maxParams: number,
): boolean {
  let fn: ts.Node = node;
  while (ts.isParenthesizedExpression(fn)) fn = fn.expression;
  if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return false;
  if (fn.parameters.nodes.length > maxParams) return false;
  const param = fn.parameters.nodes[0];
  if (param === undefined) return true;
  if (param.dotDotDotToken !== undefined || param.initializer !== undefined) return false;
  if (ts.isObjectBindingPattern(param.name))
    return groupsPattern(param.name) && groupsProjectedParam(lowerer, param);
  if (!ts.isIdentifier(param.name)) return false;
  const symbol = lowerer.checker.getSymbolAtLocation(param.name);
  if (!symbol || !bindingNeverReassigned(lowerer, symbol, param)) return false;
  return usesOf(lowerer, param.name, symbol).every((use) => rowReadByElements(lowerer, use, 1));
}

/** Every use of a non-exported const binding satisfies `read`. */
function constBindingReadsByElements(
  lowerer: Lowerer,
  decl: ts.VariableDeclaration,
  read: (use: ts.Identifier) => boolean,
): boolean {
  if (
    !ts.isIdentifier(decl.name) ||
    decl.type !== undefined ||
    !ts.isVariableDeclarationList(decl.parent) ||
    (decl.parent.flags & ts.NodeFlags.Const) === 0
  )
    return false;
  const statement = decl.parent.parent;
  if (
    ts.isVariableStatement(statement) &&
    statement.modifiers?.nodes.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  )
    return false;
  const symbol = lowerer.resolveValueSymbol(decl.name);
  if (!symbol) return false;
  return usesOf(lowerer, decl.name, symbol).every(read);
}

function usesOf(lowerer: Lowerer, name: ts.Identifier, symbol: ts.Symbol): ts.Identifier[] {
  return identifiersNamed(lowerer, ts.getSourceFileOfNode(name), name.text).filter(
    (use) => use !== name && lowerer.resolveValueSymbol(use) === symbol,
  );
}

/** `rows[i]` or `rows?.[i]` with a number key, read and not written. */
function numberKeyRead(lowerer: Lowerer, access: ts.ElementAccessExpression): boolean {
  if (!isValueRead(access)) return false;
  const key = lowerer.mapTypeOf(lowerer.typeOf(access.argumentExpression));
  return key?.kind === "f64";
}

/** `m.groups` lowers to the compile-time projection over the row's
 * elements (lowerMatchGroupsRead). */
function groupsProjected(lowerer: Lowerer, row: ts.Expression): boolean {
  const groups = matchResultNamedGroupsOf(lowerer, row);
  return groups !== null && groups.length > 0;
}

/** `({ groups }) => ...` lowers through the same projection. */
function groupsProjectedParam(lowerer: Lowerer, param: ts.ParameterDeclaration): boolean {
  const groups = matchCallbackParamGroupsOf(lowerer, param);
  return groups !== null && groups.length > 0;
}

/** An object pattern that binds only `groups`. */
function groupsPattern(pattern: ts.ObjectBindingPattern): boolean {
  return (
    pattern.elements.nodes.length > 0 &&
    pattern.elements.nodes.every((el) => {
      if (el.dotDotDotToken !== undefined) return false;
      const prop = el.propertyName;
      if (prop === undefined) return ts.isIdentifier(el.name) && el.name.text === "groups";
      return (ts.isIdentifier(prop) || ts.isStringLiteral(prop)) && prop.text === "groups";
    })
  );
}

/** A read whose value is only consumed: not an assignment, update or
 * delete target. */
function isValueRead(access: ts.Expression): boolean {
  const ref = outerValue(access);
  const parent = ref.parent;
  if (
    ts.isBinaryExpression(parent) &&
    parent.left === ref &&
    parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  )
    return false;
  return !(
    (ts.isPrefixUnaryExpression(parent) &&
      (parent.operator === ts.SyntaxKind.PlusPlusToken ||
        parent.operator === ts.SyntaxKind.MinusMinusToken)) ||
    ts.isPostfixUnaryExpression(parent) ||
    ts.isDeleteExpression(parent)
  );
}
