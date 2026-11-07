/* The promise resolution procedure, decided per site. Resolving a promise
 * with a value fulfils it, unless the value is a promise or has a callable
 * `then`: JavaScript adopts those. A site whose value's static type proves
 * neither keeps its plain fulfilment and emits no run-time test; every
 * other site asks the value. */
import type { IrType } from "../../ir/ir.js";
import * as ts from "../ts7/adapter.js";
import type { ClassInfo } from "./lower-classes.js";
import type { Lowerer } from "./lowerer.js";

const PRIMITIVE =
  ts.TypeFlags.StringLike |
  ts.TypeFlags.NumberLike |
  ts.TypeFlags.BigIntLike |
  ts.TypeFlags.BooleanLike |
  ts.TypeFlags.ESSymbolLike |
  ts.TypeFlags.Undefined |
  ts.TypeFlags.Void |
  ts.TypeFlags.Null |
  ts.TypeFlags.Never;

/** Whether a class member is, or may be, named `then`. */
function mayBeNamedThen(member: ts.ClassElement): boolean {
  const name = member.name;
  if (name === undefined) return false;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text === "then";
  if (ts.isComputedPropertyName(name)) {
    const key = name.expression;
    return !ts.isStringLiteralLike(key) && !ts.isNumericLiteral(key) ? true : key.text === "then";
  }
  return false;
}

/** Whether the class or one of the program's classes below it declares
 * `then`. The classes above it answer through the checker's member lookup. */
function declaresThenBelow(info: ClassInfo, seen: Set<ClassInfo>): boolean {
  if (seen.has(info)) return false;
  seen.add(info);
  if (info.methods.has("then") || info.fields.has("then")) return true;
  if (info.decl !== null && info.decl.members.nodes.some(mayBeNamedThen)) return true;
  return info.subclasses.some((s) => declaresThenBelow(s, seen));
}

/** Whether a `then` member of the lowered type `t` can hold a function. */
function callableSlot(lowerer: Lowerer, t: IrType): boolean {
  switch (t.kind) {
    case "func":
    case "dyn":
    case "jsval":
      return true;
    case "union":
      return (lowerer.unions.get(t.unionId)?.arms ?? []).some((arm) => callableSlot(lowerer, arm));
    default:
      return false;
  }
}

/** Whether a value of the lowered type `t` can be a promise or carry a
 * callable `then` its static type does not show: a checked-dynamic value, a
 * promise, a module namespace, or an instance of a class with a subclass
 * that declares one. A record holds exactly its declared fields, and a
 * `then` field that cannot hold a function (an AST node's `then` branch)
 * makes no thenable. */
function mayHideThen(lowerer: Lowerer, t: IrType): boolean {
  switch (t.kind) {
    case "dyn":
    case "jsval":
    case "caught":
    case "promise":
    case "moduleNs":
      return true;
    case "union":
      return (lowerer.unions.get(t.unionId)?.arms ?? []).some((arm) => mayHideThen(lowerer, arm));
    case "record": {
      const shape = lowerer.shapes.get(t.shapeId);
      if (shape === undefined) return true;
      return shape.fields.some((f) => f.name === "then" && callableSlot(lowerer, f.type));
    }
    case "object": {
      const info = lowerer.classes.get(t.className);
      return info === undefined || declaresThenBelow(info, new Set());
    }
    default:
      return false;
  }
}

/** Whether a value of static type `type` (a `then` member's) can be called:
 * it has a call signature, or its type does not say (`any`, `unknown`, a
 * type parameter, `Function`). */
function mayBeCallable(lowerer: Lowerer, type: ts.Type): boolean {
  const { checker } = lowerer;
  const open = ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter;
  for (const part of type.isUnionType() ? ts.constituentTypes(type) : [type]) {
    if (part.flags & PRIMITIVE) continue;
    if (part.flags & open || checker.getCallSignatures(part).length > 0) return true;
    if (ts.symbolNameOf(part.getSymbol()) === "Function") return true;
  }
  return false;
}

/** Whether resolving a promise with a value of static type `type` can do
 * anything but fulfil it with that value. */
export function mayResolveThroughThen(lowerer: Lowerer, type: ts.Type): boolean {
  const { checker } = lowerer;
  for (const part of type.isUnionType() ? ts.constituentTypes(type) : [type]) {
    if (part.flags & PRIMITIVE) continue;
    const then = checker.getPropertyOfType(part, "then");
    if (then !== undefined && mayBeCallable(lowerer, checker.getTypeOfSymbol(then))) return true;
    const mapped = lowerer.mapTypeOf(part);
    if (mapped === null || mayHideThen(lowerer, mapped)) return true;
  }
  return false;
}

/** Whether a function value of static type `type` is only ever called with
 * a first argument that fulfils plainly, or with none. */
function receivesPlainValue(lowerer: Lowerer, type: ts.Type): boolean {
  const { checker } = lowerer;
  const absent = ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void;
  for (const part of type.isUnionType() ? ts.constituentTypes(type) : [type]) {
    if (part.flags & absent) continue;
    const signatures = checker.getCallSignatures(part);
    if (signatures.length === 0) return false;
    for (const signature of signatures) {
      const first = signature.getParameters()[0];
      if (first === undefined) continue;
      const declaration = first.valueDeclaration;
      if (declaration === undefined || !ts.isParameter(declaration)) return false;
      let value = checker.getTypeOfSymbol(first);
      if (declaration.dotDotDotToken) {
        // A rest parameter's type lists the arguments: the first element of
        // a tuple (none for the empty tuple), the element of an array.
        if (!checker.isTupleType(value) && !checker.isArrayType(value)) return false;
        const elements = checker.getTypeArguments(value as ts.TypeReference);
        if (elements.length === 0) continue;
        value = elements[0]!;
      }
      // A `never` parameter accepts every function and says nothing of the
      // arguments it is called with.
      if (value.flags & ts.TypeFlags.Never || mayResolveThroughThen(lowerer, value)) return false;
    }
  }
  return true;
}

/** The standard library's scheduling functions, which call their callback
 * with the arguments the call passes from this position on (the ones after
 * the delay), and with none when it passes none. */
const SCHEDULERS: ReadonlyMap<string, number> = new Map([
  ["setTimeout", 2],
  ["setInterval", 2],
  ["setImmediate", 1],
  ["nextTick", 1],
  ["queueMicrotask", 1],
]);

/** For a call of one of those functions with its callback first: the
 * position of the first argument the callback receives. -1 for every other
 * call. */
function scheduledArgumentsIndex(lowerer: Lowerer, call: ts.Expression): number {
  if (!ts.isCallExpression(call)) return -1;
  const callee = call.expression;
  if (ts.isIdentifier(callee)) {
    const symbol = lowerer.checker.getSymbolAtLocation(callee);
    if (symbol === undefined || !lowerer.isStdlibSymbol(symbol)) return -1;
    return SCHEDULERS.get(callee.text) ?? -1;
  }
  if (ts.isPropertyAccessExpression(callee) && lowerer.isStdlibMember(callee))
    return SCHEDULERS.get(callee.name.text) ?? -1;
  return -1;
}

/** Whether the static types prove that the executor of a `new Promise` of a
 * checked-dynamic value never gives its resolve function a promise or a
 * thenable. The executor is a function written in place, and every use of
 * its resolve parameter is a call whose argument's type fulfils plainly, or
 * hands the function to a position whose type says the same of the callers
 * there (`stream.on("finish", resolve)`). Any other use, and an executor
 * that is a value, may resolve with anything. */
export function executorResolvesPlainly(lowerer: Lowerer, executor: ts.Expression): boolean {
  let fn = executor;
  while (ts.isParenthesizedExpression(fn)) fn = fn.expression;
  if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return false;
  const parameter = fn.parameters.nodes[0];
  if (parameter === undefined) return true;
  const name = parameter.name;
  if (!ts.isIdentifier(name) || parameter.dotDotDotToken) return false;
  const { checker } = lowerer;
  const symbol = checker.getSymbolAtLocation(name);
  if (symbol === undefined) return false;
  const ownArguments = ts.isFunctionExpression(fn);
  let plain = true;
  const visit = (node: ts.Node): void => {
    if (!plain) return;
    if (ts.isIdentifier(node)) {
      if (ownArguments && node.text === "arguments") plain = false;
      if (node.text !== name.text || node === name) return;
      // The property name of `x.resolve` and of `{ resolve: v }` is another
      // symbol; `{ resolve }` reads the parameter.
      if (checker.getSymbolAtLocation(node) === symbol) plain = plainUse(node);
      else if (ts.isShorthandPropertyAssignment(node.parent)) plain = false;
      return;
    }
    ts.forEachChild(node, visit);
  };
  const plainUse = (use: ts.Identifier): boolean => {
    let node: ts.Expression = use;
    while (ts.isParenthesizedExpression(node.parent)) node = node.parent;
    const parent = node.parent;
    if (ts.isCallExpression(parent) && parent.expression === node) {
      const first = parent.arguments.nodes[0];
      if (first === undefined) return true;
      if (ts.isSpreadElement(first)) return false;
      return !mayResolveThroughThen(lowerer, lowerer.typeOf(first));
    }
    if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression !== node) {
      const index = parent.arguments?.nodes.indexOf(node) ?? -1;
      // `setTimeout(resolve, ms)`: the callback receives the first argument
      // the call passes after the delay.
      const scheduled = index === 0 ? scheduledArgumentsIndex(lowerer, parent) : -1;
      if (scheduled >= 0) {
        const first = parent.arguments?.nodes[scheduled];
        if (first === undefined) return true;
        if (ts.isSpreadElement(first)) return false;
        return !mayResolveThroughThen(lowerer, lowerer.typeOf(first));
      }
      // The parameter of the overload the call resolved to: the contextual
      // type of an argument is the union over every overload.
      const parameter = checker.getResolvedSignature(parent)?.getParameters()[index];
      const declaration = parameter?.valueDeclaration;
      if (
        parameter === undefined ||
        declaration === undefined ||
        !ts.isParameter(declaration) ||
        declaration.dotDotDotToken
      )
        return false;
      return receivesPlainValue(lowerer, checker.getTypeOfSymbol(parameter));
    }
    return false;
  };
  for (const p of fn.parameters.nodes) if (p.initializer) visit(p.initializer);
  visit(fn.body);
  return plain;
}
