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
import { bindingNeverReassigned } from "./binding-analysis.js";
import { isRebindableFunction } from "./rebindable-functions.js";

/** The value an export declaration or write assigns. */
function exportedValue(decl: ts.Node): ts.Node | undefined {
  let node: ts.Node | undefined = decl;
  if (ts.isPropertyAccessExpression(node) && node.parent && ts.isBinaryExpression(node.parent))
    node = node.parent;
  if (ts.isBinaryExpression(node)) node = node.right;
  else if (ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node)) node = node.initializer;
  while (node !== undefined && ts.isParenthesizedExpression(node)) node = node.expression;
  return node;
}

/** Whether the function an export binding holds reads `this`, as far as the
 * binding's value names that function in a form the proof below follows: a
 * function, a name or namespace member that holds one, either arm of a
 * conditional, the argument a standard function returns
 * (`Object.defineProperty(function () {…}, "length", …)`, whatever the call
 * defines), and the call of a program function (`makeRead()`,
 * `inner.makeRead()`), whose result the call's arguments decide: that one
 * "may read" unless the proof shows otherwise. A value of any other form
 * (a member of an object, the result of a function the program does not
 * define) names no function here and is not checked. */
function exportReadsThis(
  lowerer: Lowerer,
  value: ts.Node,
  depth: number,
): "reads" | "may read" | null {
  if (depth > maxDepth) return "may read";
  while (ts.isParenthesizedExpression(value)) value = value.expression;
  if (
    ts.isFunctionDeclaration(value) ||
    ts.isFunctionExpression(value) ||
    ts.isMethodDeclaration(value)
  )
    return readsOwnThis(lowerer, value) ? "reads" : null;
  if (ts.isConditionalExpression(value))
    return (
      exportReadsThis(lowerer, value.whenTrue, depth + 1) ??
      exportReadsThis(lowerer, value.whenFalse, depth + 1)
    );
  if (ts.isCallExpression(value)) {
    const returned = returnedArgument(lowerer, value);
    if (returned !== null) return exportReadsThis(lowerer, returned.argument, depth + 1);
    if ((functionOfReference(lowerer, value.expression, noBindings)?.fn ?? null) === null)
      return null;
    return ignoresThis(lowerer, value, noBindings, 0) ? null : "may read";
  }
  const held = functionOfReference(lowerer, value as ts.Expression, noBindings);
  if (held === null) return null;
  if (held.fn !== null) return readsOwnThis(lowerer, held.fn) ? "reads" : null;
  return held.bound ? exportReadsThis(lowerer, held.bound.expr, depth + 1) : null;
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
      if (ts.isCallExpression(init)) return { fn: null, bound: { expr: init, bindings } };
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
 * holds whatever `call` the program gives it, under a spelled key or a
 * computed one. Which function such a write reaches is not followed, so
 * the sites whose proof passed `this` on are kept, and all of them are
 * refused once the lowered program selects that build
 * (refuseForwardsToOwnCall). The sites are kept as text, which a unit's
 * record carries (Lowerer.journalTables). */
function noteReceiverForwards(lowerer: Lowerer, site: ts.Node): void {
  if (forwardsInProof === 0) return;
  const loc = locOf(site);
  lowerer.receiverForwardSites.add(`${loc.start}:${loc.end}:${loc.file}`);
}

/** The diagnostics of those sites, for a program in which a function can
 * hold its own `call` or `apply`: the replacement would receive the
 * receiver the proof said nobody reads. */
export function refuseForwardsToOwnCall(lowerer: Lowerer, mod: IrModule): ScrDiagnostic[] {
  if (lowerer.receiverForwardSites.size === 0 || !moduleShadowsFunctionMember(mod)) return [];
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
      "calling a module export that passes 'this' on with 'call' or 'apply' through its module binding, in a program whose functions can hold their own 'call' or 'apply' (it defines, writes, deletes or reads as a value an inherited member of a function; a replacement would receive the module object Node passes as 'this', which this call has no value for)",
    );
  });
}

export function refuseModuleMemberThis(
  lowerer: Lowerer,
  call: ts.CallExpression,
  member: ts.Identifier,
): void {
  const symbol = lowerer.resolveValueSymbol(member);
  if (symbol === null) return;
  for (const decl of symbol.declarations) {
    const value = exportedValue(decl);
    if (value === undefined) continue;
    forwardsInProof = 0;
    // A factory's result reads `this` through the function it returns.
    const reads = exportReadsThis(lowerer, value, 0);
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
