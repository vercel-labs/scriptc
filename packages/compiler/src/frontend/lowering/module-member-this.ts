/* A module export called through its module binding (`m.f()` where `m` is
 * `const m = require("./x")` or `import * as m from "./x"`): Node passes
 * the module object (the exports object, or the namespace) as `this`. The
 * member call lowers to a direct call of the exported function, which has
 * no module object to pass, so an export that reads `this` refuses instead
 * of seeing another receiver. */
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";

/** The function an export binding holds, when its declaration shows it. */
function exportedFunction(decl: ts.Node): ts.Node | null {
  let node: ts.Node | undefined = decl;
  if (ts.isPropertyAccessExpression(node) && node.parent && ts.isBinaryExpression(node.parent))
    node = node.parent;
  if (ts.isBinaryExpression(node)) node = node.right;
  else if (ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node)) node = node.initializer;
  while (node !== undefined && ts.isParenthesizedExpression(node)) node = node.expression;
  if (node === undefined) return null;
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isMethodDeclaration(node)
  )
    return node;
  return null;
}

/** Whether `node` is `f.apply(this, ...)` or `f.call(this, ...)`, which
 * passes the receiver on to `f`. */
function forwardsThis(node: ts.Node): node is ts.CallExpression & {
  expression: ts.PropertyAccessExpression;
} {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.name)) return false;
  if (callee.name.text !== "apply" && callee.name.text !== "call") return false;
  return node.arguments.nodes[0]?.kind === ts.SyntaxKind.ThisKeyword;
}

/* The arguments a call gave a function's parameters, while the analysis
 * follows the call into the function: each with the bindings of its own
 * scope. */
type Bindings = ReadonlyMap<ts.Symbol, { expr: ts.Expression; bindings: Bindings }>;
const noBindings: Bindings = new Map();

// How many calls and functions deep the analysis follows a forwarded
// `this`: enough for a wrapper over a function factory, as Effect's
// `dual(3, body).apply(this, arguments)`.
const maxDepth = 6;

/** Whether `fn`'s own body uses `this` only to pass it on with `.apply` or
 * `.call` to functions that ignore it (and so also when it doesn't use
 * `this` at all). */
function ignoresOwnThis(lowerer: Lowerer, fn: ts.Node, bindings: Bindings, depth: number): boolean {
  let ignores = true;
  const visit = (node: ts.Node): void => {
    if (!ignores) return;
    if (node.kind === ts.SyntaxKind.ThisKeyword) {
      ignores = false;
      return;
    }
    if ((ts.isFunctionLike(node) && !ts.isArrowFunction(node)) || ts.isClassLikeDeclaration(node))
      return;
    if (forwardsThis(node)) {
      if (!ignoresThis(lowerer, node.expression.expression, bindings, depth + 1)) {
        ignores = false;
        return;
      }
      visit(node.expression.expression);
      for (const arg of node.arguments.nodes.slice(1)) visit(arg);
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(fn, visit);
  return ignores;
}

/** The function `name` provably holds: a function declaration, a const
 * initialized with a function, or an import of one. */
function functionOfName(
  lowerer: Lowerer,
  name: ts.Identifier,
  bindings: Bindings,
): { fn: ts.Node | null; bound?: { expr: ts.Expression; bindings: Bindings } } {
  let symbol = lowerer.checker.getSymbolAtLocation(name);
  if (symbol === undefined) return { fn: null };
  const bound = bindings.get(symbol);
  if (bound) return { fn: null, bound };
  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0)
    symbol = lowerer.checker.getAliasedSymbol(symbol);
  const decls = symbol.declarations;
  if (decls.length !== 1) return { fn: null };
  const decl = decls[0]!;
  if (ts.isFunctionDeclaration(decl)) return { fn: decl };
  if (
    ts.isVariableDeclaration(decl) &&
    decl.initializer &&
    ts.isVariableDeclarationList(decl.parent) &&
    (decl.parent.flags & ts.NodeFlags.Const) !== 0
  ) {
    let init: ts.Expression = decl.initializer;
    while (ts.isParenthesizedExpression(init)) init = init.expression;
    if (ts.isFunctionExpression(init) || ts.isArrowFunction(init)) return { fn: init };
  }
  return { fn: null };
}

/**
 * Whether `fn` (with its nested functions) may change what its parameter
 * `param` holds: an assignment, update, destructuring or for-in/for-of
 * target that writes it, a declaration of the same name, a write to an
 * element of `arguments` (which aliases parameters outside strict mode), or
 * a call of `eval`.
 */
function mayRebind(lowerer: Lowerer, fn: ts.Node, param: ts.Identifier): boolean {
  const symbol = lowerer.checker.getSymbolAtLocation(param);
  const refersTo = (node: ts.Node): boolean =>
    ts.isIdentifier(node) &&
    (node.text === param.text || lowerer.checker.getSymbolAtLocation(node) === symbol);
  // Whether writing `target` writes the parameter: the name itself, or the
  // name inside a destructuring pattern.
  const writes = (target: ts.Node): boolean => {
    while (ts.isParenthesizedExpression(target)) target = target.expression;
    if (refersTo(target)) return true;
    if (
      ts.isElementAccessExpression(target) &&
      ts.isIdentifier(target.expression) &&
      target.expression.text === "arguments"
    )
      return true;
    if (ts.isArrayLiteralExpression(target)) return target.elements.nodes.some(writes);
    if (ts.isObjectLiteralExpression(target))
      return target.properties.nodes.some((p) =>
        ts.isShorthandPropertyAssignment(p)
          ? refersTo(p.name)
          : ts.isPropertyAssignment(p)
            ? writes(p.initializer)
            : ts.isSpreadAssignment(p) && writes(p.expression),
      );
    if (ts.isSpreadElement(target)) return writes(target.expression);
    // A default in a pattern: `[body = other] = values`.
    if (ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.EqualsToken)
      return writes(target.left);
    return false;
  };
  const declaresName = (node: ts.Node): boolean => {
    const name = (node as { name?: ts.Node }).name;
    return name !== undefined && ts.isIdentifier(name) && name.text === param.text;
  };
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      (ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
        writes(node.left)) ||
      ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken ||
          node.operator === ts.SyntaxKind.MinusMinusToken) &&
        writes(node.operand)) ||
      ((ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
        !ts.isVariableDeclarationList(node.initializer) &&
        writes(node.initializer)) ||
      ((ts.isVariableDeclaration(node) ||
        ts.isBindingElement(node) ||
        ts.isParameter(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node)) &&
        declaresName(node)) ||
      (ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "eval")
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  // The function's own parameters declare the name; their defaults can write it.
  const params = (fn as { parameters?: ts.NodeArray<ts.ParameterDeclaration> }).parameters;
  for (const p of params?.nodes ?? []) if (p.initializer) visit(p.initializer);
  const body = (fn as { body?: ts.Node }).body;
  if (body !== undefined) visit(body);
  return found;
}

/** The expressions `fn` returns from its own body. */
function returnedExpressions(fn: ts.Node): ts.Expression[] | null {
  const body = (fn as { body?: ts.Node }).body;
  if (body === undefined) return null;
  if (!ts.isBlock(body)) return [body as ts.Expression];
  const result: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) || ts.isClassLikeDeclaration(node)) return;
    if (ts.isReturnStatement(node) && node.expression) result.push(node.expression);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(body, visit);
  return result;
}

/** Whether the function `expr` evaluates to provably ignores the `this`
 * it is called with. */
function ignoresThis(
  lowerer: Lowerer,
  expr: ts.Expression,
  bindings: Bindings,
  depth: number,
): boolean {
  if (depth > maxDepth) return false;
  while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
  if (ts.isArrowFunction(expr)) return true;
  if (ts.isFunctionExpression(expr)) return ignoresOwnThis(lowerer, expr, bindings, depth);
  if (ts.isIdentifier(expr)) {
    const { fn, bound } = functionOfName(lowerer, expr, bindings);
    if (bound) return ignoresThis(lowerer, bound.expr, bound.bindings, depth + 1);
    if (fn === null) return false;
    return ts.isArrowFunction(fn) || ignoresOwnThis(lowerer, fn, noBindings, depth + 1);
  }
  // A call of a known function: what it returns, with its parameters bound
  // to this call's arguments.
  if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) {
    const { fn } = functionOfName(lowerer, expr.expression, bindings);
    if (fn === null) return false;
    const params = (fn as { parameters?: ts.NodeArray<ts.ParameterDeclaration> }).parameters;
    const inner = new Map(bindings);
    for (const [i, param] of (params?.nodes ?? []).entries()) {
      if (!ts.isIdentifier(param.name) || param.dotDotDotToken) return false;
      const arg = expr.arguments.nodes[i];
      const symbol = lowerer.checker.getSymbolAtLocation(param.name);
      if (arg === undefined || ts.isSpreadElement(arg) || symbol === undefined) return false;
      // The parameter holds the argument for as long as the function runs.
      if (mayRebind(lowerer, fn, param.name)) return false;
      inner.set(symbol, { expr: arg, bindings });
    }
    const returned = returnedExpressions(fn);
    return returned !== null && returned.every((r) => ignoresThis(lowerer, r, inner, depth + 1));
  }
  return false;
}

/** Whether calling `fn` with another `this` than Node's can change what it
 * does: it reads `this`, or passes it on to a function that may. */
function readsOwnThis(lowerer: Lowerer, fn: ts.Node): boolean {
  return !ignoresOwnThis(lowerer, fn, noBindings, 0);
}

export function refuseModuleMemberThis(
  lowerer: Lowerer,
  call: ts.CallExpression,
  member: ts.Identifier,
): void {
  let symbol = lowerer.checker.getSymbolAtLocation(member);
  if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0)
    symbol = lowerer.checker.getAliasedSymbol(symbol);
  if (symbol === undefined) return;
  for (const decl of symbol.declarations) {
    const fn = exportedFunction(decl);
    if (fn === null || !readsOwnThis(lowerer, fn)) continue;
    lowerer.unsupported(
      "SC1090",
      call,
      `calling a module export that reads 'this' through its module binding ('${member.text}': Node passes the module object as 'this', which this call has no value for)`,
    );
  }
}
