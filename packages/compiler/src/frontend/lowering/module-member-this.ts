/* A module export called through its module binding (`m.f()` where `m` is
 * `const m = require("./x")` or `import * as m from "./x"`): Node passes
 * the module object (the exports object, or the namespace) as `this`. The
 * member call lowers to a direct call of the exported function, which has
 * no module object to pass, so an export that reads `this` refuses instead
 * of seeing another receiver. */
import * as ts from "../ts7/adapter.js";
import { unsupportedDiag, type ScrDiagnostic } from "../../diagnostics/diagnostic.js";
import type { IrModule } from "../../ir/ir.js";
import { moduleShadowsFunctionMember } from "../../ir/runtime-features.js";
import { locOf } from "../program.js";
import type { Lowerer } from "./lowerer.js";
import { bindingNeverReassigned, isWriteTarget } from "./binding-analysis.js";
import { isRebindableFunction } from "./rebindable-functions.js";

/** The value an export declaration or write gives the binding, or undefined
 * where the declaration does not show what the binding holds when it is
 * called: a binding without a value of its own (`export let f;`, a
 * destructured name), one the program assigns again, a compound write. */
function exportedValue(lowerer: Lowerer, decl: ts.Node): ts.Node | undefined {
  if (ts.isPropertyAccessExpression(decl) && decl.parent && ts.isBinaryExpression(decl.parent))
    decl = decl.parent;
  if (ts.isBinaryExpression(decl))
    return decl.operatorToken.kind === ts.SyntaxKind.EqualsToken ? decl.right : undefined;
  if (ts.isVariableDeclaration(decl)) {
    if (!decl.initializer || !ts.isIdentifier(decl.name)) return undefined;
    if (!ts.isVariableDeclarationList(decl.parent)) return undefined;
    if ((decl.parent.flags & ts.NodeFlags.Const) !== 0) return decl.initializer;
    const symbol = lowerer.checker.getSymbolAtLocation(decl.name);
    const stable =
      symbol !== undefined &&
      bindingNeverReassigned(lowerer.bindingScope(), symbol, decl, (ident) =>
        lowerer.checker.getSymbolAtLocation(ident),
      );
    return stable ? decl.initializer : undefined;
  }
  if (ts.isPropertyAssignment(decl)) return decl.initializer;
  // `{ read }`: the binding the shorthand names.
  if (ts.isShorthandPropertyAssignment(decl)) return decl.name;
  if (ts.isExportAssignment(decl)) return decl.expression;
  if (
    ts.isFunctionDeclaration(decl) ||
    ts.isMethodDeclaration(decl) ||
    ts.isClassLikeDeclaration(decl)
  )
    return decl;
  return undefined;
}

const isUndefinedName = (node: ts.Node): boolean =>
  ts.isIdentifier(node) && node.text === "undefined";

/** Whether a value is of a form no function call reaches a `this` through:
 * an arrow function, a class (called without `new` it throws before its
 * body runs), or a literal that is no function at all. */
function holdsNoReceiver(value: ts.Node): boolean {
  return (
    isUndefinedName(value) ||
    ts.isArrowFunction(value) ||
    ts.isClassLikeDeclaration(value) ||
    ts.isObjectLiteralExpression(value) ||
    ts.isArrayLiteralExpression(value) ||
    ts.isStringLiteralLike(value) ||
    ts.isNumericLiteral(value) ||
    value.kind === ts.SyntaxKind.TrueKeyword ||
    value.kind === ts.SyntaxKind.FalseKeyword ||
    value.kind === ts.SyntaxKind.NullKeyword
  );
}

/** What a value does with the `this` it is called with: null when it
 * provably ignores it, "reads" when the function it names reads it, and
 * "may read" for everything the proof cannot follow to a function. */
type ReceiverUse = "reads" | "may read" | null;

const worseUse = (a: ReceiverUse, b: ReceiverUse): ReceiverUse =>
  a === "reads" || b === "reads" ? "reads" : (a ?? b);

/** What the function an export binding holds does with `this`. The one
 * place that names what an export holds: a function, a name or namespace
 * member that holds one, the operands an operator chooses between
 * (`a ? b : c`, `a ?? b`, `a || b`, `a && b`, the last of `a, b`), the
 * argument a standard function returns
 * (`Object.defineProperty(function () {…}, "length", …)`, whatever the call
 * defines), and the call of a program function (`makeRead()`,
 * `inner.makeRead()`), whose result the call's arguments decide. A value
 * of any other form (a member of an object, an element, a binding the
 * program assigns again) names no function, so nothing is proven about it:
 * it may read. The call of any other function is the exception, left
 * unchecked (see there). */
function exportReadsThis(lowerer: Lowerer, value: ts.Node | undefined, depth: number): ReceiverUse {
  if (value === undefined || depth > maxDepth) return "may read";
  while (
    ts.isParenthesizedExpression(value) ||
    ts.isAsExpression(value) ||
    ts.isSatisfiesExpression(value) ||
    ts.isNonNullExpression(value)
  )
    value = value.expression;
  if (holdsNoReceiver(value)) return null;
  if (ts.isFunctionDeclaration(value) || ts.isMethodDeclaration(value))
    return isRebindableFunction(lowerer, value)
      ? "may read"
      : readsOwnThis(lowerer, value)
        ? "reads"
        : null;
  if (ts.isFunctionExpression(value)) return readsOwnThis(lowerer, value) ? "reads" : null;
  if (ts.isConditionalExpression(value))
    return worseUse(
      exportReadsThis(lowerer, value.whenTrue, depth + 1),
      exportReadsThis(lowerer, value.whenFalse, depth + 1),
    );
  if (ts.isBinaryExpression(value)) {
    switch (value.operatorToken.kind) {
      case ts.SyntaxKind.CommaToken:
      case ts.SyntaxKind.EqualsToken:
        return exportReadsThis(lowerer, value.right, depth + 1);
      case ts.SyntaxKind.QuestionQuestionToken:
      case ts.SyntaxKind.BarBarToken:
      case ts.SyntaxKind.AmpersandAmpersandToken:
        return worseUse(
          exportReadsThis(lowerer, value.left, depth + 1),
          exportReadsThis(lowerer, value.right, depth + 1),
        );
    }
    return "may read";
  }
  if (ts.isCallExpression(value)) {
    const returned = returnedArgument(lowerer, value);
    if (returned !== null) return exportReadsThis(lowerer, returned.argument, depth + 1);
    if ((functionOfReference(lowerer, value.expression, noBindings)?.fn ?? null) !== null)
      return ignoresThis(lowerer, value, noBindings, 0) ? null : "may read";
    // The result of a function the proof cannot name (`all.get(1)`, and
    // `partial(0)` where `partial` was itself made by a factory, the
    // partial application a library is full of) is the one form left
    // unchecked: what such a call returns depends on the arguments at run
    // time, and nearly every such export ignores `this`. One of them is
    // `g.bind(o)`, which does while `bind` is the builtin.
    noteBuiltinBind(lowerer, value);
    return null;
  }
  const held = functionOfReference(lowerer, value as ts.Expression, noBindings);
  if (held === null) return "may read";
  if (held.fn !== null) return readsOwnThis(lowerer, held.fn) ? "reads" : null;
  return held.bound ? exportReadsThis(lowerer, held.bound.expr, depth + 1) : "may read";
}

/** `f.bind(…)` of a function a name holds: the bound function runs with the
 * receiver the call names, whatever it is called with later, while `bind`
 * is the builtin. Counted with the forwards, which rest on the same
 * (noteReceiverForwards). */
function noteBuiltinBind(lowerer: Lowerer, call: ts.CallExpression): void {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.questionDotToken) return;
  if (!ts.isIdentifier(callee.name) || callee.name.text !== "bind") return;
  if ((functionOfReference(lowerer, callee.expression, noBindings)?.fn ?? null) !== null)
    forwardsInProof++;
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
// `this`: enough for a wrapper over a factory whose argument another
// factory made, as Effect's `flow(make, …)` over
// `make = fnUntraced(function* () {…})`.
const maxDepth = 16;

/** The `f.call(this, …)` and `f.apply(this, …)` calls the proof in progress
 * read as passing `this` on: reset where a proof starts. */
let forwardsInProof = 0;

/** The export a member read of an ES namespace import names (`ns.member`
 * after `import * as ns`): the namespace binding is immutable, and its
 * member is the exporting module's own binding. */
function namespaceMemberSymbol(lowerer: Lowerer, access: ts.Node): ts.Symbol | undefined {
  if (!ts.isPropertyAccessExpression(access) || access.questionDotToken) return undefined;
  if (!ts.isIdentifier(access.expression) || !ts.isIdentifier(access.name)) return undefined;
  const decls = lowerer.checker.getSymbolAtLocation(access.expression)?.declarations;
  if (decls?.length !== 1 || !ts.isNamespaceImport(decls[0]!)) return undefined;
  return lowerer.checker.getSymbolAtLocation(access.name);
}

/** The argument a call of a standard function returns:
 * `Object.defineProperty(f, "length", …)` and the other functions of
 * `Object` that return their first argument. `keepsCall` is whether the
 * call provably leaves the function's `apply` and `call` as they were: a
 * call that may give the function its own makes `f.call(this, …)` run that
 * property, which the proof does not read. So the properties a call
 * defines must be named in its text, `Object.setPrototypeOf`, which
 * changes where both are found, keeps neither, and nor does a property
 * named `__proto__`, which `Object.assign` sets with the same effect. */
function returnedArgument(
  lowerer: Lowerer,
  call: ts.CallExpression,
): { argument: ts.Expression; keepsCall: boolean } | null {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee)) return null;
  const member = lowerer.stdlibGlobalMember(callee, "Object");
  const args = call.arguments.nodes;
  const argument = args[0];
  if (member === null || argument === undefined || ts.isSpreadElement(argument)) return null;
  switch (member) {
    case "freeze":
    case "preventExtensions":
    case "seal":
      return { argument, keepsCall: true };
    case "defineProperty": {
      const key = args[1];
      const keepsCall =
        key !== undefined &&
        (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)) &&
        keepsApplyAndCall(key.text);
      return { argument, keepsCall };
    }
    case "defineProperties":
      return { argument, keepsCall: args.length === 2 && definesNoApplyOrCall(args[1]) };
    case "assign":
      return {
        argument,
        keepsCall: args.slice(1).every((source) => definesNoApplyOrCall(source)),
      };
    case "setPrototypeOf":
      return { argument, keepsCall: false };
  }
  return null;
}

const keepsApplyAndCall = (key: string): boolean =>
  key !== "apply" && key !== "call" && key !== "__proto__";

/** Whether `node` is an object literal whose every property has a plain
 * name other than `apply`, `call` and `__proto__`. */
function definesNoApplyOrCall(node: ts.Expression | undefined): boolean {
  if (node === undefined || !ts.isObjectLiteralExpression(node)) return false;
  return node.properties.nodes.every((property) => {
    if (ts.isSpreadAssignment(property)) return false;
    const name = property.name;
    return (ts.isIdentifier(name) || ts.isStringLiteral(name)) && keepsApplyAndCall(name.text);
  });
}

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
      // The proof took `apply` and `call` for the builtins here.
      forwardsInProof++;
      visit(node.expression.expression);
      for (const arg of node.arguments.nodes.slice(1)) visit(arg);
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(fn, visit);
  return ignores;
}

type HeldFunction = { fn: ts.Node | null; bound?: { expr: ts.Expression; bindings: Bindings } };

/** The binding a name reads: the variable's, also where the name is a
 * shorthand property (`{ read }`). */
function valueSymbolOfName(lowerer: Lowerer, name: ts.Identifier): ts.Symbol | undefined {
  const parent = name.parent;
  return ts.isShorthandPropertyAssignment(parent) && parent.name === name
    ? lowerer.checker.getShorthandAssignmentValueSymbol(parent)
    : lowerer.checker.getSymbolAtLocation(name);
}

/** The function a reference provably holds: a name, or a member of a
 * namespace import. Null for any other expression. */
function functionOfReference(
  lowerer: Lowerer,
  expr: ts.Expression,
  bindings: Bindings,
): HeldFunction | null {
  if (ts.isIdentifier(expr))
    return functionOfSymbol(lowerer, valueSymbolOfName(lowerer, expr), bindings);
  const member = namespaceMemberSymbol(lowerer, expr);
  return member === undefined ? null : functionOfSymbol(lowerer, member, bindings);
}

/* The function a binding provably holds, following imports and immutable
 * aliases: an immutable binding names what the name or the namespace member
 * it is initialized with names, and any other initializer is handed back
 * for the caller to read. */
function functionOfSymbol(
  lowerer: Lowerer,
  start: ts.Symbol | undefined,
  bindings: Bindings,
): HeldFunction {
  let symbol = start;
  const seen = new Set<ts.Symbol>();
  while (symbol !== undefined && !seen.has(symbol)) {
    seen.add(symbol);
    const bound = bindings.get(symbol);
    if (bound) return { fn: null, bound };
    if ((symbol.flags & ts.SymbolFlags.Alias) !== 0)
      symbol = lowerer.checker.getAliasedSymbol(symbol);
    const decls = symbol.declarations;
    if (decls.length !== 1) return { fn: null };
    const decl = decls[0]!;
    if (ts.isFunctionDeclaration(decl)) {
      const stable = ts.isSourceFile(decl.parent)
        ? !isRebindableFunction(lowerer, decl)
        : bindingNeverReassigned(lowerer.bindingScope(), symbol, decl, (ident) =>
            lowerer.checker.getSymbolAtLocation(ident),
          );
      return { fn: stable ? decl : null };
    }
    if (
      ts.isVariableDeclaration(decl) &&
      decl.initializer &&
      ts.isVariableDeclarationList(decl.parent) &&
      ((decl.parent.flags & ts.NodeFlags.Const) !== 0 ||
        bindingNeverReassigned(lowerer.bindingScope(), symbol, decl, (ident) =>
          lowerer.checker.getSymbolAtLocation(ident),
        ))
    ) {
      let init: ts.Expression = decl.initializer;
      while (ts.isParenthesizedExpression(init)) init = init.expression;
      if (ts.isFunctionExpression(init) || ts.isArrowFunction(init)) return { fn: init };
      if (ts.isCallExpression(init) || isUndefinedName(init))
        return { fn: null, bound: { expr: init, bindings } };
      if (ts.isIdentifier(init)) {
        symbol = lowerer.checker.getSymbolAtLocation(init);
        continue;
      }
      const member = namespaceMemberSymbol(lowerer, init);
      if (member === undefined) return { fn: null, bound: { expr: init, bindings } };
      symbol = member;
      continue;
    }
    break;
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
  // Either function of a conditional.
  if (ts.isConditionalExpression(expr))
    return (
      ignoresThis(lowerer, expr.whenTrue, bindings, depth + 1) &&
      ignoresThis(lowerer, expr.whenFalse, bindings, depth + 1)
    );
  const held = functionOfReference(lowerer, expr, bindings);
  if (held !== null) {
    const { fn, bound } = held;
    if (bound) return ignoresThis(lowerer, bound.expr, bound.bindings, depth + 1);
    if (fn === null) return false;
    if (ts.isArrowFunction(fn)) return true;
    // Preserve outer captures, but the returned function's own arguments
    // come from its eventual caller, not the factory invocation.
    const captured =
      bindings.size === 0
        ? bindings
        : new Map(
            [...bindings].filter(([symbol]) => !symbol.declarations.some((d) => d.parent === fn)),
          );
    return ignoresOwnThis(lowerer, fn, captured, depth + 1);
  }
  // A call of a known function: what it returns, with its parameters bound
  // to this call's arguments.
  if (ts.isCallExpression(expr)) {
    const passed = returnedArgument(lowerer, expr);
    if (passed !== null)
      return passed.keepsCall && ignoresThis(lowerer, passed.argument, bindings, depth + 1);
    const fn = functionOfReference(lowerer, expr.expression, bindings)?.fn ?? null;
    if (fn === null) return false;
    const params = (fn as { parameters?: ts.NodeArray<ts.ParameterDeclaration> }).parameters;
    const inner = new Map(bindings);
    for (const [i, param] of (params?.nodes ?? []).entries()) {
      if (!ts.isIdentifier(param.name)) return false;
      const symbol = lowerer.checker.getSymbolAtLocation(param.name);
      if (symbol === undefined) return false;
      const arg = param.dotDotDotToken ? undefined : expr.arguments.nodes[i];
      // A rest parameter, and a parameter this call passes nothing for,
      // hold no function the proof knows: `this` passed on to one is a
      // read. An enclosing call of the same function may have bound it.
      if (arg === undefined) {
        inner.delete(symbol);
        continue;
      }
      if (ts.isSpreadElement(arg)) return false;
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
  return !ts.isArrowFunction(fn) && !ignoresOwnThis(lowerer, fn, noBindings, 0);
}

/** Whether an exported callable provably ignores the receiver supplied by
 * a member call: the proof behind inline `require(...).f()` and
 * `exports.f()` calls (cjsExportCallIgnoresThis). */
export function moduleExportIgnoresThis(
  lowerer: Lowerer,
  value: ts.Expression | ts.FunctionDeclaration | ts.MethodDeclaration,
): boolean {
  forwardsInProof = 0;
  const ignores =
    ts.isFunctionDeclaration(value) || ts.isMethodDeclaration(value)
      ? !isRebindableFunction(lowerer, value) && !readsOwnThis(lowerer, value)
      : ignoresThis(lowerer, value, noBindings, 0);
  if (ignores) noteReceiverForwards(lowerer, value);
  return ignores;
}

/* A proof that read `f.call(this, …)` or `f.apply(this, …)` as passing the
 * receiver on to `f` holds while both are the builtins. The runtime refuses
 * a function its own `call` or `apply` (SC2020), except in the build a
 * program selects by defining, writing or deleting an inherited member of
 * a function under a name its text spells, or by reading `call` or `bind`
 * as a value (ir/runtime-features.ts, fnMemberProps): there a function
 * holds the `call` the program gives it. Which function such a write
 * reaches is not followed, so the sites whose proof passed `this` on are
 * kept, and all of them are refused once the lowered program selects that
 * build and its text gives a value that can be a function a `call` or an
 * `apply` (refuseForwardsToOwnCall). The sites are kept as text, which a
 * unit's record carries (Lowerer.journalTables). */
function noteReceiverForwards(lowerer: Lowerer, site: ts.Node): void {
  if (forwardsInProof === 0) return;
  const loc = locOf(site);
  lowerer.receiverForwardSites.add(`${loc.start}:${loc.end}:${loc.file}`);
}

/** The members of a function the receiver proofs take for the builtins. */
const isReceiverMember = (name: string): boolean =>
  name === "apply" || name === "bind" || name === "call";

/** The expression a `const` name was initialized with, through other such
 * names; any other expression as it is written. */
function writtenValue(lowerer: Lowerer, expr: ts.Expression): ts.Expression {
  for (let step = 0; step < 8; step++) {
    while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
    if (!ts.isIdentifier(expr)) return expr;
    const decls = lowerer.checker.getSymbolAtLocation(expr)?.declarations;
    const decl = decls?.length === 1 ? decls[0]! : undefined;
    if (
      decl === undefined ||
      !ts.isVariableDeclaration(decl) ||
      !decl.initializer ||
      !ts.isVariableDeclarationList(decl.parent) ||
      (decl.parent.flags & ts.NodeFlags.Const) === 0
    )
      return expr;
    expr = decl.initializer;
  }
  return expr;
}

/** The text a key expression spells: a string literal, or a `const` name
 * initialized with one. Undefined for a key computed at run time, and the
 * empty string for one whose type is a symbol or a number, which names no
 * member at all. */
function spelledKey(lowerer: Lowerer, key: ts.Expression): string | undefined {
  const value = writtenValue(lowerer, key);
  if (ts.isStringLiteralLike(value)) return value.text;
  const named = ts.TypeFlags.ESSymbolLike | ts.TypeFlags.NumberLike;
  return ts.isNumericLiteral(value) || (lowerer.typeOf(key).flags & named) !== 0 ? "" : undefined;
}

/** Whether `target` provably holds something other than a function: an
 * object or array literal (written in place or held by a `const` name), or
 * the `prototype` of a class, which no write replaces. Every other
 * receiver (a parameter, a member, a function) can be one. */
function holdsNoFunction(lowerer: Lowerer, target: ts.Expression): boolean {
  for (let step = 0; step < 8; step++) {
    const value = writtenValue(lowerer, target);
    if (ts.isObjectLiteralExpression(value) || ts.isArrayLiteralExpression(value)) return true;
    if (ts.isCallExpression(value)) {
      // `Object.create(…)` makes an object; `Object.setPrototypeOf({}, …)`
      // and the like return their first argument.
      const callee = value.expression;
      if (
        ts.isPropertyAccessExpression(callee) &&
        lowerer.stdlibGlobalMember(callee, "Object") === "create"
      )
        return true;
      const returned = returnedArgument(lowerer, value);
      if (returned === null) return false;
      target = returned.argument;
      continue;
    }
    if (!ts.isPropertyAccessExpression(value) || !ts.isIdentifier(value.expression)) return false;
    if (!ts.isIdentifier(value.name) || value.name.text !== "prototype") return false;
    const decls = lowerer.checker.getSymbolAtLocation(value.expression)?.declarations;
    return decls?.length === 1 && ts.isClassLikeDeclaration(decls[0]!);
  }
  return false;
}

/** Whether `target` provably holds a function: one written in place, or a
 * name the proofs follow to one. */
function holdsFunction(lowerer: Lowerer, target: ts.Expression): boolean {
  while (ts.isParenthesizedExpression(target)) target = target.expression;
  if (ts.isFunctionExpression(target) || ts.isArrowFunction(target)) return true;
  return (functionOfReference(lowerer, target, noBindings)?.fn ?? null) !== null;
}

/** Whether an access is given a value: assigned or updated, or a target
 * inside a destructuring assignment or the head of a for-in or for-of. */
function isWritten(access: ts.Expression): boolean {
  if (isWriteTarget(access)) {
    let node: ts.Node = access;
    while (ts.isParenthesizedExpression(node.parent)) node = node.parent;
    return !ts.isDeleteExpression(node.parent);
  }
  let node: ts.Node = access;
  for (;;) {
    const parent: ts.Node | undefined = node.parent;
    if (parent === undefined) return false;
    if (
      ts.isParenthesizedExpression(parent) ||
      ts.isArrayLiteralExpression(parent) ||
      ts.isObjectLiteralExpression(parent) ||
      ts.isSpreadElement(parent) ||
      ts.isSpreadAssignment(parent) ||
      (ts.isPropertyAssignment(parent) && parent.initializer === node)
    ) {
      node = parent;
      continue;
    }
    if (ts.isBinaryExpression(parent))
      return parent.left === node && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
    return (ts.isForOfStatement(parent) || ts.isForInStatement(parent)) && parent.initializer === node;
  }
}

/** Whether a write under `key` can give `target` its own `apply`, `bind` or
 * `call`: a key the text spells as one of them, on a receiver that can be
 * a function; a key the text does not spell, on a receiver that provably
 * is one. A key computed at run time on any other receiver is not
 * counted: it is the same write on every other member of every object. */
function writesReceiverMember(
  lowerer: Lowerer,
  target: ts.Expression,
  key: string | undefined,
): boolean {
  return key === undefined
    ? holdsFunction(lowerer, target)
    : isReceiverMember(key) && !holdsNoFunction(lowerer, target);
}

/** The same for the properties an object gives `target`
 * (`Object.assign(g, source)`, `Object.setPrototypeOf(g, source)`): an
 * object literal names its properties, any other source none (a published
 * library copies whole objects onto functions it wrote, and none of them
 * holds such a member). */
function givesReceiverMember(lowerer: Lowerer, target: ts.Expression, source: ts.Expression) {
  const value = writtenValue(lowerer, source);
  if (!ts.isObjectLiteralExpression(value)) return false;
  return value.properties.nodes.some((property) => {
    if (ts.isSpreadAssignment(property)) return false;
    const name = property.name;
    return writesReceiverMember(
      lowerer,
      target,
      ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : undefined,
    );
  });
}

/** `Object.setPrototypeOf(g, { call(…) {…} })`: a function answers a member
 * call of `apply`, `bind` or `call` with what its prototype chain defines,
 * and the native member call runs the builtin. The runtime gives a function
 * the prototype (its other members are read through it), so the call is
 * refused where its text names a prototype with such a member for a value
 * that can be a function. */
export function refuseOwnCallPrototype(lowerer: Lowerer, call: ts.CallExpression): void {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "setPrototypeOf") return;
  const [target, prototype] = call.arguments.nodes;
  if (target === undefined || prototype === undefined) return;
  if (!ts.isObjectLiteralExpression(writtenValue(lowerer, prototype))) return;
  if (!givesReceiverMember(lowerer, target, prototype)) return;
  if (
    lowerer.stdlibGlobalMember(callee, "Object") === null &&
    lowerer.stdlibGlobalMember(callee, "Reflect") === null
  )
    return;
  lowerer.unsupported(
    "SC1090",
    call,
    "giving a value that can be a function a prototype that defines 'apply', 'bind' or 'call' (a member call of that name runs the builtin, where Node runs the prototype's)",
  );
}

/** Whether the program's text gives a function its own `apply`, `bind` or
 * `call`: an assignment to that member (`g.call = f`, `g["apply"] = f`,
 * also as a target of a destructuring), or a definition under that key by
 * a function of `Object` or `Reflect` (`Object.defineProperty(g, "call",
 * …)`, `Object.assign(g, { call })`). */
function programWritesReceiverMember(lowerer: Lowerer): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const key = ts.isPropertyAccessExpression(node)
        ? node.name.text
        : spelledKey(lowerer, node.argumentExpression);
      found = isWritten(node) && writesReceiverMember(lowerer, node.expression, key);
    } else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const callee = node.expression;
      const member =
        lowerer.stdlibGlobalMember(callee, "Object") ??
        lowerer.stdlibGlobalMember(callee, "Reflect");
      const [target, second, ...rest] = node.arguments.nodes;
      if (member !== null && target !== undefined && second !== undefined)
        switch (member) {
          case "defineProperty":
          case "set":
            found = writesReceiverMember(lowerer, target, spelledKey(lowerer, second));
            break;
          case "defineProperties":
          case "assign":
            found = [second, ...rest].some((source) =>
              givesReceiverMember(lowerer, target, source),
            );
            break;
        }
    }
    if (!found) ts.forEachChild(node, visit);
  };
  for (const file of lowerer.moduleOrder) {
    if (found) break;
    if (!file.isDeclarationFile) ts.forEachChild(file, visit);
  }
  return found;
}

/** The diagnostics of those sites, for a program in which a function holds
 * its own `apply`, `bind` or `call`: the replacement would receive the
 * receiver the proof said nobody reads. The lowered module says whether the
 * runtime admits such a property at all, the program's text whether it
 * makes one. */
export function refuseForwardsToOwnCall(lowerer: Lowerer, mod: IrModule): ScrDiagnostic[] {
  if (lowerer.receiverForwardSites.size === 0 || !moduleShadowsFunctionMember(mod)) return [];
  if (!programWritesReceiverMember(lowerer)) return [];
  return Array.from(lowerer.receiverForwardSites, (site) => {
    const first = site.indexOf(":");
    const second = site.indexOf(":", first + 1);
    return unsupportedDiag(
      "SC1090",
      {
        file: site.slice(second + 1),
        start: Number(site.slice(0, first)),
        end: Number(site.slice(first + 1, second)),
      },
      "calling a module export that passes 'this' on with 'call' or 'apply' through its module binding, in a program that gives a function its own 'apply', 'bind' or 'call' (it writes or defines that member on a value that can be a function; the replacement would receive the module object Node passes as 'this', which this call has no value for)",
    );
  });
}

export function refuseModuleMemberThis(
  lowerer: Lowerer,
  call: ts.CallExpression,
  member: ts.Identifier,
): void {
  let symbol = lowerer.resolveValueSymbol(member);
  if (symbol === null) return;
  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0)
    symbol = lowerer.checker.getAliasedSymbol(symbol);
  for (const decl of symbol.declarations) {
    // A declaration file describes code this program does not compile: the
    // call is not a direct call of a function lowered here.
    if (ts.getSourceFileOfNode(decl).isDeclarationFile) continue;
    forwardsInProof = 0;
    // A factory's result reads `this` through the function it returns.
    const reads = exportReadsThis(lowerer, exportedValue(lowerer, decl), 0);
    if (reads === null) {
      noteReceiverForwards(lowerer, call);
      continue;
    }
    lowerer.unsupported(
      "SC1090",
      call,
      `calling a module export that ${reads} 'this' through its module binding ('${member.text}': Node passes the module object as 'this', which this call has no value for)`,
    );
  }
}
