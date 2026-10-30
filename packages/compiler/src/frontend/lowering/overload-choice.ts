import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { typeEquals, type IrType } from "../../ir/ir.js";
import { isJsSourceFile } from "../program.js";
import { isThisParameter } from "./call-signatures.js";
import { hasExplicitJsDocReturn } from "./function-returns.js";
import { hasJsTypeAnnotation } from "./lower-stmts.js";

/** Whether a checked-dynamic argument leaves a JS call's overload
 * undecided.
 *
 * The checker resolves an overloaded call whose argument is `any` (an
 * untyped parameter, a value read from one) to the FIRST overload that
 * argument satisfies, but the value can match any overload at run time:
 * `generateKeyPairSync("ec", options)` answers KeyObjects or encoded
 * strings by the options' contents, `digest(encoding)` a Buffer when the
 * encoding is undefined. When another overload the call could take at
 * run time returns a different type, the resolved overload's return is a
 * guess, and the result is checked-dynamic instead.
 *
 * An overload is reachable when the arguments fit its arity (trailing
 * checked-dynamic or `undefined` arguments may be absent) and every
 * statically typed argument is assignable to its parameter. Generic
 * overloads whose return cannot be mapped without instantiation do not
 * count, so the resolved instantiation stands for them. */
export function dynamicOverloadChoice(
  lowerer: Lowerer,
  expr: ts.CallExpression | ts.NewExpression,
): boolean {
  return cachedAnswer(lowerer, expr, () => computeDynamicOverloadChoice(lowerer, expr));
}

/** Whether a JavaScript value's checker type rests on an undecided
 * overload (dynamicOverloadChoice): the call itself, an awaited one, a
 * call to an unannotated JS function returning such a value, or a read of
 * an unannotated JS binding initialized with one (destructured or not).
 * Such a value is checked-dynamic wherever the checker's inference would
 * otherwise carry the guess into a binding or a return. */
export function guessedOverloadValue(lowerer: Lowerer, expr: ts.Expression): boolean {
  while (ts.isParenthesizedExpression(expr) || ts.isAwaitExpression(expr)) expr = expr.expression;
  if (ts.isCallExpression(expr) || ts.isNewExpression(expr)) {
    if (!isJsSourceFile(ts.getSourceFileOfNode(expr))) return false;
    if (dynamicOverloadChoice(lowerer, expr)) return true;
    const decl = lowerer.checker.getResolvedSignature(expr)?.declaration;
    return (
      decl !== undefined &&
      (ts.isFunctionDeclaration(decl) ||
        ts.isFunctionExpression(decl) ||
        ts.isArrowFunction(decl)) &&
      isJsSourceFile(ts.getSourceFileOfNode(decl)) &&
      returnsGuessedOverloadValue(lowerer, decl)
    );
  }
  return ts.isIdentifier(expr) && guessedOverloadIdentifier(lowerer, expr);
}

/** Whether a JS identifier, as a binding's declared name or as a read,
 * names a guessedOverloadBinding. */
export function guessedOverloadIdentifier(lowerer: Lowerer, node: ts.Identifier): boolean {
  return cachedAnswer(lowerer, node, () => {
    const parent = node.parent;
    if (
      parent !== undefined &&
      (ts.isVariableDeclaration(parent) || ts.isBindingElement(parent)) &&
      parent.name === node
    )
      return guessedOverloadBinding(lowerer, parent);
    const decl = lowerer.checker.getSymbolAtLocation(node)?.valueDeclaration;
    return decl !== undefined && guessedOverloadBinding(lowerer, decl);
  });
}

/** Whether `decl` is an unannotated JS variable or destructured binding
 * whose declaration's initializer is a guessedOverloadValue. */
function guessedOverloadBinding(lowerer: Lowerer, decl: ts.Node): boolean {
  let root: ts.Node | undefined = decl;
  while (root && ts.isBindingElement(root) && root.parent && ts.isBindingPattern(root.parent)) {
    root = root.parent.parent;
  }
  if (!root) return false;
  if (!ts.isVariableDeclaration(root) || !root.initializer || root.type) return false;
  if (!isJsSourceFile(ts.getSourceFileOfNode(root)) || hasJsTypeAnnotation(root)) return false;
  const init = root.initializer;
  return cachedAnswer(lowerer, root, () => guessedOverloadValue(lowerer, init));
}

/** Whether a return of the unannotated JS function `decl` itself is a
 * guessedOverloadValue. */
export function returnsGuessedOverloadValue(
  lowerer: Lowerer,
  decl: ts.SignatureDeclaration,
): boolean {
  if (decl.type || decl.asteriskToken || hasExplicitJsDocReturn(decl)) return false;
  return cachedAnswer(lowerer, decl, () => {
    if (ts.isArrowFunction(decl) && decl.body && !ts.isBlock(decl.body)) {
      return guessedOverloadValue(lowerer, decl.body);
    }
    let found = false;
    const scan = (node: ts.Node): void => {
      if (found || (node !== decl && ts.isFunctionLike(node))) return;
      if (ts.isReturnStatement(node) && node.expression) {
        found = guessedOverloadValue(lowerer, node.expression);
      }
      ts.forEachChild(node, scan);
    };
    scan(decl);
    return found;
  });
}

/** One answer per node; a node asked again while its answer is being
 * computed (recursive functions, self-referencing bindings) answers
 * false. */
function cachedAnswer(lowerer: Lowerer, node: ts.Node, compute: () => boolean): boolean {
  const cached = lowerer.dynamicOverloadAnswers.get(node);
  if (cached !== undefined) return cached;
  lowerer.dynamicOverloadAnswers.set(node, false);
  const answer = compute();
  lowerer.dynamicOverloadAnswers.set(node, answer);
  return answer;
}

function computeDynamicOverloadChoice(
  lowerer: Lowerer,
  expr: ts.CallExpression | ts.NewExpression,
): boolean {
  // TypeScript sources keep the resolved overload: their reads validate
  // the value against it where it is used.
  if (!isJsSourceFile(ts.getSourceFileOfNode(expr))) return false;
  const args = expr.arguments?.nodes ?? [];
  if (args.length === 0 || args.some(ts.isSpreadElement)) return false;
  const dynamic = args.map((arg) => checkedDynamicArgument(lowerer, arg));
  if (!dynamic.includes(true)) return false;
  const checker = lowerer.checker;
  const calleeType = checker.getTypeAtLocation(expr.expression);
  const signatures = ts.isNewExpression(expr)
    ? checker.getConstructSignatures(calleeType)
    : checker.getCallSignatures(calleeType);
  if (signatures.length < 2) return false;
  const resolved = checker.getResolvedSignature(expr);
  if (!resolved) return false;
  const resolvedReturn = lowerer.mapTypeOf(checker.getReturnTypeOfSignature(resolved));
  if (resolvedReturn === null) return false;
  // Arguments that may be absent at run time: the trailing run of
  // checked-dynamic and `undefined` arguments.
  let present = args.length;
  while (present > 0 && (dynamic[present - 1] || isUndefinedArgument(args[present - 1]!))) {
    present--;
  }
  for (const signature of signatures) {
    const decl = signature.declaration;
    if (!decl || decl === resolved.declaration || !ts.isFunctionLike(decl)) continue;
    const generic = signature.getTypeParameters().length > 0;
    const params = decl.parameters.nodes.filter((param) => !isThisParameter(param));
    const required = params.filter(
      (param) => !param.questionToken && !param.initializer && !param.dotDotDotToken,
    ).length;
    const maximum = params.some((param) => param.dotDotDotToken) ? Infinity : params.length;
    if (required > args.length || present > maximum) continue;
    const symbols = signature.getParameters();
    let fits = true;
    for (let i = 0; i < args.length && i < params.length && fits; i++) {
      if (dynamic[i] || generic || params[i]!.dotDotDotToken) continue;
      const symbol = symbols[i];
      if (!symbol) continue;
      fits = checker.isTypeAssignableTo(
        checker.getTypeAtLocation(args[i]!),
        checker.getTypeOfSymbol(symbol),
      );
    }
    if (!fits) continue;
    const candidate = lowerer.mapTypeOf(checker.getReturnTypeOfSignature(signature));
    if (candidate !== null && !holdsResult(resolvedReturn, candidate)) return true;
  }
  return false;
}

/** Whether a value of the resolved overload's mapped return also holds
 * every value of `candidate`: the same type, or a checked-dynamic one (a
 * promise of one fulfills with anything). */
function holdsResult(resolved: IrType, candidate: IrType): boolean {
  if (resolved.kind === "dyn" || typeEquals(resolved, candidate)) return true;
  return (
    resolved.kind === "promise" &&
    candidate.kind === "promise" &&
    holdsResult(resolved.inner, candidate.inner)
  );
}

function checkedDynamicArgument(lowerer: Lowerer, arg: ts.Expression): boolean {
  if (lowerer.checker.getTypeAtLocation(arg).flags & ts.TypeFlags.Any) return true;
  return (lowerer.typeOf(arg).flags & ts.TypeFlags.Any) !== 0;
}

function isUndefinedArgument(arg: ts.Expression): boolean {
  return (ts.isIdentifier(arg) && arg.text === "undefined") || ts.isVoidExpression(arg);
}
