/* The promise resolution procedure, decided per site. Resolving a promise
 * with a value fulfils it, unless the value is a promise or has a callable
 * `then`: JavaScript adopts those. A site whose value's static type proves
 * neither keeps its plain fulfilment and emits no run-time test; a site
 * whose value's static type has a promise arm tests that arm (the second
 * half of this file); every other site asks the value. */
import { varRef } from "../../ir/build.js";
import {
  BOOL,
  UNDEFINED_T,
  VOID,
  sortArms,
  typeEquals,
  typeKey,
  type IrExpr,
  type IrParam,
  type IrStmt,
  type IrType,
  type SrcLoc,
} from "../../ir/ir.js";
import { InternalCompilerError } from "../../errors.js";
import { withoutParentheses } from "../outer-expressions.js";
import { isJsSourceFile } from "../program.js";
import * as ts from "../ts7/adapter.js";
import { buildFunctionAdapter } from "./coercions/builders.js";
import { newFnCtx } from "./function-context.js";
import type { ClassInfo } from "./lower-classes.js";
import type { Lowerer } from "./lowerer.js";
import { nonPromiseArmsAs, promiseArmedUnionOf } from "./maybe-promise.js";
import { keyedHelperName } from "./stable-names.js";

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

/** The type of the callback parameter at `index` in the first overload of
 * the callee that the call's other arguments select, or null. A callee picks
 * what it passes to a listener by those arguments (`on("finish", listener)`
 * passes what the "finish" event carries), whatever parameters the listener
 * declares; the overload the checker resolved also had to fit the listener,
 * so for a listener with one parameter it is the catch-all one. */
function selectedCallbackType(
  lowerer: Lowerer,
  call: ts.CallExpression,
  index: number,
): ts.Type | null {
  const { checker } = lowerer;
  const args = call.arguments.nodes;
  for (const signature of checker.getCallSignatures(lowerer.typeOf(call.expression))) {
    const parameters = signature.getParameters();
    if (parameters.length < args.length) continue;
    let selected = true;
    for (let i = 0; i < args.length && selected; i++) {
      const declaration = parameters[i]!.valueDeclaration;
      if (declaration === undefined || !ts.isParameter(declaration) || declaration.dotDotDotToken)
        selected = false;
      else if (i !== index)
        selected =
          !ts.isSpreadElement(args[i]!) &&
          checker.isTypeAssignableTo(
            lowerer.typeOf(args[i]!),
            checker.getTypeOfSymbol(parameters[i]!),
          );
    }
    if (selected) return checker.getTypeOfSymbol(parameters[index]!);
  }
  return null;
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
      const selected = ts.isCallExpression(parent)
        ? selectedCallbackType(lowerer, parent, index)
        : null;
      if (selected !== null) return receivesPlainValue(lowerer, selected);
      // Otherwise the parameter of the overload the call resolved to: the
      // contextual type of an argument is the union over every overload.
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

/* ── a typed promise resolved with a value whose type has a promise arm ──
 * `new Promise<T>((resolve) => resolve(v))` with `v: T | Promise<T>` or
 * `v: Promise<T>`. The static type says the value may be a promise, so
 * nothing asks the value. At each use of the executor's resolve parameter
 * that gives it such a value, the parameter reads as a function of
 * `T | Promise<T>` over the promise's own fulfilling closure: it tests the
 * union's promise arm, hands that arm to the runtime's adoption
 * (promise.adopt) and fulfils with every other arm. That covers a call in
 * the executor or in a closure it creates, a scheduling call that passes
 * the value on, and the function stored in or handed to a position whose
 * type lets its callers pass a promise. Every other use reads the
 * fulfilling closure as before, and an executor with no such use keeps the
 * code it had. */

/** Whether `type` is the library's Promise or PromiseLike, or a union with
 * such an arm. */
function hasPromiseArm(lowerer: Lowerer, type: ts.Type): boolean {
  for (const part of type.isUnionType() ? ts.constituentTypes(type) : [type]) {
    const symbol = part.getSymbol();
    if (symbol === undefined) continue;
    const name = ts.symbolNameOf(symbol);
    if ((name === "Promise" || name === "PromiseLike") && lowerer.isStdlibSymbol(symbol))
      return true;
  }
  return false;
}

/** Whether a function value of static type `type` may be called with a
 * first argument whose type has a promise arm. */
function receivesPromiseArm(lowerer: Lowerer, type: ts.Type): boolean {
  const { checker } = lowerer;
  for (const part of type.isUnionType() ? ts.constituentTypes(type) : [type]) {
    for (const signature of checker.getCallSignatures(part)) {
      const first = signature.getParameters()[0];
      if (first === undefined) continue;
      const declaration = first.valueDeclaration;
      let value = checker.getTypeOfSymbol(first);
      if (declaration !== undefined && ts.isParameter(declaration) && declaration.dotDotDotToken) {
        if (!checker.isTupleType(value) && !checker.isArrayType(value)) continue;
        const elements = checker.getTypeArguments(value as ts.TypeReference);
        if (elements.length === 0) continue;
        value = elements[0]!;
      }
      if (hasPromiseArm(lowerer, value)) return true;
    }
  }
  return false;
}

/** The use `use` of a resolve parameter, with the parentheses around it. */
function resolveUseSite(use: ts.Identifier): {
  node: ts.Expression;
  parent: ts.Node | undefined;
} {
  let node: ts.Expression = use;
  while (ts.isParenthesizedExpression(node.parent)) node = node.parent;
  return { node, parent: node.parent };
}

/** Whether the use `use` of an executor's resolve parameter gives the
 * function a value whose static type has a promise arm: a call with such
 * an argument, a scheduling call that passes one on, or the function
 * handed to a position whose type lets its callers pass one. */
function resolveUseTakesPromise(lowerer: Lowerer, use: ts.Identifier): boolean {
  const { node, parent } = resolveUseSite(use);
  if (ts.isCallExpression(parent) && parent.expression === node) {
    const first = parent.arguments.nodes[0];
    return (
      first !== undefined &&
      !ts.isSpreadElement(first) &&
      hasPromiseArm(lowerer, lowerer.typeOf(first))
    );
  }
  if (ts.isCallExpression(parent) && parent.arguments.nodes[0] === node) {
    // `setTimeout(resolve, ms, value)`: the callback receives the first
    // argument the call passes after the delay.
    const scheduled = scheduledArgumentsIndex(lowerer, parent);
    if (scheduled >= 0) {
      const first = parent.arguments.nodes[scheduled];
      return (
        first !== undefined &&
        !ts.isSpreadElement(first) &&
        hasPromiseArm(lowerer, lowerer.typeOf(first))
      );
    }
  }
  if (
    ts.isBinaryExpression(parent) &&
    parent.left === node &&
    ts.isAssignmentOperator(parent.operatorToken.kind)
  )
    return false;
  const slot = lowerer.checker.getContextualType(node);
  return slot !== undefined && receivesPromiseArm(lowerer, slot);
}

/** The symbol of the executor's resolve parameter when some use of it
 * gives it a value with a promise arm (resolveUseTakesPromise), else null.
 * Null as well for a parameter the body assigns: the binding no longer
 * names the promise's own function. */
function promiseTakingResolve(
  lowerer: Lowerer,
  fn: ts.ArrowFunction | ts.FunctionExpression,
): ts.Symbol | null {
  const parameter = fn.parameters.nodes[0];
  if (parameter === undefined) return null;
  const name = parameter.name;
  if (
    !ts.isIdentifier(name) ||
    parameter.dotDotDotToken ||
    parameter.initializer ||
    parameter.questionToken
  )
    return null;
  const { checker } = lowerer;
  const symbol = checker.getSymbolAtLocation(name);
  if (symbol === undefined) return null;
  let takes = false;
  let assigned = false;
  const visit = (node: ts.Node): void => {
    if (assigned) return;
    if (ts.isIdentifier(node)) {
      // The property name of `x.resolve` and of `{ resolve: v }` is another
      // symbol.
      if (node.text !== name.text || node === name) return;
      if (checker.getSymbolAtLocation(node) !== symbol) return;
      const site = resolveUseSite(node);
      if (
        ts.isBinaryExpression(site.parent) &&
        site.parent.left === site.node &&
        ts.isAssignmentOperator(site.parent.operatorToken.kind)
      )
        assigned = true;
      else if (!takes && resolveUseTakesPromise(lowerer, node)) takes = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(fn.body);
  return takes && !assigned ? symbol : null;
}

/** `T | Promise<T>` for a promise of the lowered type `inner`, as the type
 * mapper lays that union out: the arms of T beside one promise arm. Null
 * for a T with no such union (a function, a value that can be a thenable,
 * a checked-dynamic value, a regular expression, a generator). */
function valueOrPromiseUnion(
  lowerer: Lowerer,
  construction: ts.NewExpression,
  inner: IrType,
): IrType | null {
  const { checker } = lowerer;
  // A data arm that declares `then` beside the promise arm would be a
  // thenable the union's tag cannot see (the type mapper's rule).
  const promised = checker.getTypeArguments(lowerer.typeOf(construction) as ts.TypeReference)[0];
  if (promised === undefined) return null;
  const absent = ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Null;
  for (const part of promised.isUnionType() ? ts.constituentTypes(promised) : [promised]) {
    if (part.flags & absent) continue;
    if (checker.getPropertyOfType(part, "then") !== undefined) return null;
  }
  const home = (arm: IrType): boolean => {
    switch (arm.kind) {
      case "void":
      case "union":
      case "regex":
      case "generator":
      case "dyn":
      case "jsval":
      case "caught":
      case "moduleNs":
      case "func":
      case "promise":
        return false;
      default:
        return true;
    }
  };
  const promise: IrType = { kind: "promise", inner };
  if (inner.kind === "union") {
    const def = lowerer.unions.get(inner.unionId);
    if (def === undefined || def.arms.length === 0 || !def.arms.every(home)) return null;
    return {
      kind: "union",
      unionId: lowerer.unions.transform(def, sortArms([...def.arms, promise])),
    };
  }
  const data = inner.kind === "void" ? UNDEFINED_T : inner;
  if (!home(data)) return null;
  return { kind: "union", unionId: lowerer.unions.intern(sortArms([data, promise])) };
}

/** For `new Promise<T>(executor)` with a typed T whose executor is written
 * in place and gives its resolve parameter a value with a promise arm: that
 * parameter's symbol and the type it reads as at those uses, `(value: T |
 * Promise<T>) => void`. Null for every other construction, whose resolve
 * function only fulfils. */
export function adoptingResolveType(
  lowerer: Lowerer,
  construction: ts.NewExpression,
  inner: IrType,
): { parameter: ts.Symbol; resolve: IrType & { kind: "func" } } | null {
  if (inner.kind === "dyn" || isJsSourceFile(ts.getSourceFileOfNode(construction))) return null;
  const first = construction.arguments?.nodes[0];
  if (first === undefined) return null;
  const fn = withoutParentheses(first);
  if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return null;
  if (fn.asteriskToken !== undefined || fn.typeParameters?.nodes.length) return null;
  const parameter = promiseTakingResolve(lowerer, fn);
  if (parameter === null) return null;
  const union = valueOrPromiseUnion(lowerer, construction, inner);
  if (union === null) return null;
  return { parameter, resolve: { kind: "func", params: [union], ret: VOID } };
}

/** The read of `use`, a local holding the fulfilling closure `fulfil`, when
 * it is the resolve parameter of an executor adoptingResolveType answered
 * for and this use gives it a value with a promise arm: the function that
 * adopts that arm. Null for every other read. */
export function adoptingResolveUse(
  lowerer: Lowerer,
  use: ts.Identifier,
  fulfil: IrExpr,
): IrExpr | null {
  const symbol = lowerer.checker.getSymbolAtLocation(use);
  const resolve = symbol === undefined ? undefined : lowerer.adoptingResolves.get(symbol);
  if (resolve === undefined || fulfil.type.kind !== "func") return null;
  if (!resolveUseTakesPromise(lowerer, use)) return null;
  return adoptingResolveClosure(lowerer, fulfil, resolve, fulfil.loc);
}

/** A closure of type `resolve` over `fulfil`, the fulfilling closure of a
 * promise whose construction carries `resolves`. Given the union's promise
 * arm it hands the promise to the runtime, which adopts it (and from then
 * on ignores both resolving functions); given any other arm it fulfils. */
function adoptingResolveClosure(
  lowerer: Lowerer,
  fulfil: IrExpr,
  resolve: IrType & { kind: "func" },
  loc: SrcLoc,
): IrExpr {
  const native = fulfil.type;
  const union = resolve.params[0]!;
  const armed = promiseArmedUnionOf(lowerer, union);
  if (native.kind !== "func" || armed === null)
    throw new InternalCompilerError(
      "lowerer bug: adopting resolve function over a non-promise union",
    );
  const inner = armed.promise.inner;
  const key = `promise.resolving:${typeKey(native)}:${typeKey(resolve)}`;
  let name = lowerer.arrHofHelpers.get(key);
  if (name === undefined) {
    name = keyedHelperName(lowerer, "%promise.resolving", key);
    lowerer.arrHofHelpers.set(key, name);
    lowerer.freshClosureAdapters.add(name);
    const params: IrParam[] = [{ localId: "a.0", name: "a0", type: union }];
    const value = varRef("a.0", union, loc);
    const target = varRef("f.0", native, loc);
    const context = newFnCtx(false, null, null, VOID);
    let body: IrStmt[];
    lowerer.fnStack.push(context);
    try {
      const plain =
        inner.kind === "void" ? null : nonPromiseArmsAs(lowerer, armed, value, inner, loc);
      if (inner.kind !== "void" && (plain === null || !typeEquals(plain.type, inner)))
        throw new InternalCompilerError(
          "lowerer bug: an arm of a value-or-promise union is not the value",
        );
      body = [
        {
          kind: "if",
          cond: {
            kind: "unionIsTag",
            unionId: armed.def.id,
            tag: armed.promiseTag,
            negated: false,
            value,
            type: BOOL,
            loc,
          },
          then: [
            {
              kind: "exprStmt",
              expr: {
                kind: "libCall",
                fn: "promise.adopt",
                args: [
                  target,
                  {
                    kind: "unionNarrow",
                    unionId: armed.def.id,
                    tag: armed.promiseTag,
                    value,
                    type: armed.promise,
                    loc,
                  },
                ],
                type: VOID,
                loc,
              },
              loc,
            },
          ],
          else_: [
            {
              kind: "exprStmt",
              expr: {
                kind: "callValue",
                callee: target,
                args: plain === null ? [] : [plain],
                type: VOID,
                loc,
              },
              loc,
            },
          ],
          loc,
        },
        { kind: "return", value: null, loc },
      ];
    } finally {
      lowerer.fnStack.pop();
    }
    lowerer.liftedFns.push(
      ...buildFunctionAdapter(name, native, resolve, params, context.locals, body, loc),
    );
  }
  return { kind: "call", callee: name, args: [fulfil], type: resolve, loc };
}
