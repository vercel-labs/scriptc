import * as ts from "../ts7/adapter.js";
import { isJsSourceFile } from "../program.js";
import type { Lowerer } from "./lowerer.js";
import type { GenericFnInfo } from "./generic-functions.js";
import { stripTypeWrappers } from "./typed-arguments.js";

/** `fn.name` inside generic higher-order functions.
 *
 * Native closures carry no name, but a generic wrapper is instantiated per
 * call site anyway: when its body reads `.name` of a function parameter,
 * the instantiation key also carries the static name of that call's
 * argument (the function declaration's name, a const binding's inferred
 * name, the name of the function a wrapper call returns), and the read
 * folds to that string. A call whose argument's name is only known at run
 * time keeps a precise refusal at the read. */

/** Parameter index → symbol for the parameters whose `.name` the generic
 * body reads (and never reassigns). Computed once per generic. */
export function nameReadParams(lowerer: Lowerer, info: GenericFnInfo): Map<number, ts.Symbol> {
  if (info.nameReadParams) return info.nameReadParams;
  const out = new Map<number, ts.Symbol>();
  // JavaScript generics read function names through the checked-value
  // box, which carries the runtime name already.
  if (isJsSourceFile(ts.getSourceFileOfNode(info.decl))) {
    info.nameReadParams = out;
    return out;
  }
  const bySymbol = new Map<ts.Symbol, number>();
  info.decl.parameters.nodes.forEach((param, i) => {
    if (!ts.isIdentifier(param.name) || param.dotDotDotToken) return;
    if (!functionTypedParameter(lowerer, param)) return;
    const symbol = lowerer.checker.getSymbolAtLocation(param.name);
    if (symbol) bySymbol.set(symbol, i);
  });
  if (bySymbol.size > 0) {
    const written = new Set<ts.Symbol>();
    const read = new Set<ts.Symbol>();
    ts.walkPreorder(info.decl, (node) => {
      if (ts.isTypeNode(node)) return "skip";
      if (
        ts.isPropertyAccessExpression(node) &&
        node.name.text === "name" &&
        ts.isIdentifier(node.expression)
      ) {
        const symbol = lowerer.checker.getSymbolAtLocation(node.expression);
        if (symbol && bySymbol.has(symbol)) read.add(symbol);
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
        ts.isIdentifier(node.left)
      ) {
        const symbol = lowerer.checker.getSymbolAtLocation(node.left);
        if (symbol) written.add(symbol);
      }
      return undefined;
    });
    for (const symbol of read) {
      if (!written.has(symbol)) out.set(bySymbol.get(symbol)!, symbol);
    }
  }
  info.nameReadParams = out;
  return out;
}

/** A parameter declared with a function type, or with a type parameter
 * constrained to one (`fn: F` where `F extends (...args: any) => any`). */
function functionTypedParameter(lowerer: Lowerer, param: ts.ParameterDeclaration): boolean {
  const t = lowerer.typeOf(param.name);
  if (lowerer.checker.getCallSignatures(t).length > 0) return true;
  if (!(t.flags & ts.TypeFlags.TypeParameter)) return false;
  const symbol = t.getSymbol();
  const decl = symbol ? symbol.declarations.find(ts.isTypeParameterDeclaration) : undefined;
  if (!decl?.constraint) return false;
  const constraint = lowerer.checker.getTypeFromTypeNode(decl.constraint);
  return lowerer.checker.getCallSignatures(constraint).length > 0;
}

/** The instantiation key suffix and name bindings of one call of `info`,
 * or null when the body reads no parameter's name. */
export function staticNameBindings(
  lowerer: Lowerer,
  call: ts.CallExpression,
  info: GenericFnInfo,
): { key: string; names: Map<ts.Symbol, string | null> } | null {
  const params = nameReadParams(lowerer, info);
  if (params.size === 0) return null;
  const names = new Map<ts.Symbol, string | null>();
  const parts: string[] = [];
  for (const [index, symbol] of params) {
    const arg = call.arguments.nodes[index];
    const name = arg && !ts.isSpreadElement(arg) ? staticFunctionName(lowerer, arg) : null;
    names.set(symbol, name);
    parts.push(name === null ? "?" : JSON.stringify(name));
  }
  return { key: `@name(${parts.join(",")})`, names };
}

/** The `name` JavaScript gives the function `expr` evaluates to, when it is
 * statically known; null otherwise. */
export function staticFunctionName(lowerer: Lowerer, expr: ts.Expression): string | null {
  return staticNameOf(lowerer, expr, new Set());
}

function staticNameOf(lowerer: Lowerer, expr: ts.Expression, seen: Set<ts.Node>): string | null {
  const e = stripTypeWrappers(expr);
  if (seen.has(e)) return null;
  seen.add(e);
  // An anonymous function as a call argument gets no inferred name.
  if (ts.isFunctionExpression(e) || ts.isArrowFunction(e)) {
    return !ts.isArrowFunction(e) && e.name ? e.name.text : "";
  }
  if (ts.isIdentifier(e)) {
    const symbol = lowerer.resolveValueSymbol(e);
    if (!symbol) return null;
    const bound = lowerer.staticFnNames?.get(symbol);
    if (bound !== undefined) return bound;
    const decl = symbol.valueDeclaration;
    if (decl === undefined) return null;
    if (ts.isFunctionDeclaration(decl)) return decl.name ? decl.name.text : "default";
    if (
      ts.isVariableDeclaration(decl) &&
      ts.isIdentifier(decl.name) &&
      decl.initializer !== undefined &&
      (ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const) !== 0
    ) {
      const init = stripTypeWrappers(decl.initializer);
      // `const f = () => …` / `const f = function () {}`: the binding names
      // an anonymous function definition.
      if (ts.isArrowFunction(init)) return decl.name.text;
      if (ts.isFunctionExpression(init)) return init.name ? init.name.text : decl.name.text;
      return staticNameOf(lowerer, init, seen);
    }
    return null;
  }
  if (ts.isCallExpression(e) && ts.isIdentifier(e.expression)) {
    // A call of a generic higher-order function returns the function its
    // body returns: every `return` names the same anonymous definition or
    // the same local const binding.
    const symbol = lowerer.resolveValueSymbol(e.expression);
    const info = symbol ? lowerer.genericFnsBySymbol.get(symbol) : undefined;
    if (!info) return null;
    return returnedFunctionName(lowerer, info.decl, seen);
  }
  if (ts.isPropertyAccessExpression(e)) {
    const symbol = lowerer.checker.getSymbolAtLocation(e.name);
    const decl = symbol ? symbol.valueDeclaration : undefined;
    if (decl && ts.isMethodDeclaration(decl) && ts.isIdentifier(decl.name)) return decl.name.text;
    return null;
  }
  return null;
}

function returnedFunctionName(
  lowerer: Lowerer,
  decl: GenericFnInfo["decl"],
  seen: Set<ts.Node>,
): string | null {
  const body = decl.body;
  if (body === undefined) return null;
  if (!ts.isBlock(body)) return functionValueName(lowerer, body, seen);
  let name: string | null | undefined;
  let ok = true;
  ts.walkPreorder(body, (node) => {
    if (!ok) return "stop";
    if (ts.isFunctionLike(node)) return "skip";
    if (!ts.isReturnStatement(node)) return undefined;
    const here = node.expression ? functionValueName(lowerer, node.expression, seen) : null;
    if (here === null || (name !== undefined && name !== here)) ok = false;
    else name = here;
    return undefined;
  });
  return ok && name !== undefined ? name : null;
}

/** The name of a returned function value: an anonymous definition returned
 * directly is nameless; a local const binding names its definition. */
function functionValueName(
  lowerer: Lowerer,
  expr: ts.Expression,
  seen: Set<ts.Node>,
): string | null {
  const e = stripTypeWrappers(expr);
  if (ts.isFunctionExpression(e) || ts.isArrowFunction(e)) {
    return !ts.isArrowFunction(e) && e.name ? e.name.text : "";
  }
  if (ts.isIdentifier(e)) return staticNameOf(lowerer, e, seen);
  return null;
}

/** `fn.name` where `fn` is a name-keyed parameter of the generic instance
 * being lowered: the folded name, or a precise refusal when this call
 * site's argument has no static name. Null for every other read. */
export function staticFunctionNameRead(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression,
): string | null {
  const names = lowerer.staticFnNames;
  if (
    names === null ||
    expr.name.text !== "name" ||
    expr.questionDotToken !== undefined ||
    !ts.isIdentifier(expr.expression)
  ) {
    return null;
  }
  const symbol = lowerer.checker.getSymbolAtLocation(expr.expression);
  if (!symbol || !names.has(symbol)) return null;
  const name = names.get(symbol);
  if (name === null || name === undefined) {
    lowerer.unsupported(
      "SC1090",
      expr,
      `reading '${expr.expression.text}.name' when the call passes a function whose name is only known at run time (generic wrappers fold the name of a function declaration, a const-bound function, or a wrapper call's result)`,
    );
  }
  return name;
}
