/* The arguments object where a program asks what it is.
 *
 * A compiled function's `arguments` is the list of the call's arguments, an
 * array. Node's is an object that is not one: `Array.isArray` and
 * `instanceof Array` answer false, its tag is "[object Arguments]", its JSON
 * is an object keyed by index, and `Array.prototype.concat` keeps it as one
 * element, as a receiver and as an item, because it is not an array and has
 * no `Symbol.isConcatSpreadable`. The uses that take it as a list (its
 * length, an index, a spread, iteration, `slice.call`, the argument list of
 * `apply`, `Array.from`) agree with Node on the array.
 *
 * Where a value the checker types as the arguments object, the name itself
 * or a constant that holds it, meets one of those questions directly, the
 * type tests answer as Node does and the two that would need the object
 * itself (`concat`, `JSON.stringify`) are refused by name. Nothing a program
 * does makes the object an array, so `Array.isArray` always answers; the
 * prototype and the tag can be changed, so `instanceof` and the tag answer
 * only in a function that keeps the object to itself: one that writes a
 * property of it or hands it to other code keeps the list's answers. An
 * arguments object that has left for an untyped slot (passed on, stored,
 * returned) is the array everywhere else.
 */
import * as ts from "../ts7/adapter.js";
import { isArgumentsRead, isWritten } from "../arguments-usage.js";
import { withoutParentheses, withoutParenthesesTypeWrappers } from "../outer-expressions.js";
import { BOOL, DYN, STRING, type IrExpr, type SrcLoc } from "../../ir/ir.js";
import type { Lowerer } from "./lowerer.js";

const CONCAT_FEATURE =
  "the arguments object as the receiver or an item of 'concat' (Node keeps it as one element: it is not an array and has no Symbol.isConcatSpreadable, while the compiled argument list is an array and would be spread)";
const CONCAT_HINT =
  "copy the arguments into an array first: Array.prototype.slice.call(arguments), [...arguments] or Array.from(arguments)";
const JSON_FEATURE =
  "JSON.stringify of the arguments object (Node writes an object keyed by index, while the compiled argument list is an array)";
const JSON_HINT = "copy the arguments into an array first, or build the object the caller expects";

/** Whether `fn`'s own body assigns `arguments` (sloppy JavaScript only):
 * the name then holds whatever was assigned. */
function assignsArguments(fn: ts.Node): boolean {
  if (fn.body === undefined) return false;
  let assigned = false;
  ts.walkPreorder(fn.body, (node) => {
    if (ts.isTypeNode(node)) return "skip";
    if (ts.isFunctionLike(node) && !ts.isArrowFunction(node)) return "skip";
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      const target = withoutParentheses(node.left);
      if (ts.isIdentifier(target) && target.text === "arguments") {
        assigned = true;
        return "stop";
      }
    }
    return undefined;
  });
  return assigned;
}

/** The nearest function that binds its own `arguments` (arrows inherit). */
function argumentsFunction(node: ts.Node): ts.Node | undefined {
  for (let cur = node.parent; cur !== undefined; cur = cur.parent) {
    if (ts.isFunctionLike(cur) && !ts.isArrowFunction(cur)) return cur;
  }
  return undefined;
}

/** Whether `node` is the arguments object by its type: the name itself or a
 * constant initialized with it, through parentheses and assertions. Only a
 * name qualifies, so answering for it evaluates nothing. */
function isArgumentsObject(lowerer: Lowerer, node: ts.Expression): boolean {
  const operand = withoutParenthesesTypeWrappers(node);
  if (!ts.isIdentifier(operand)) return false;
  const symbol = lowerer.typeOf(operand).getSymbol();
  if (
    symbol === undefined ||
    ts.symbolNameOf(symbol) !== "IArguments" ||
    !lowerer.isStdlibSymbol(symbol)
  )
    return false;
  if (operand.text === "arguments") {
    const owner = argumentsFunction(operand);
    return owner === undefined || !assignsArguments(owner);
  }
  const declaration = lowerer.resolveValueSymbol(operand)?.valueDeclaration;
  return (
    declaration !== undefined &&
    ts.isVariableDeclaration(declaration) &&
    (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) !== 0 &&
    declaration.initializer !== undefined &&
    isArgumentsObject(lowerer, declaration.initializer)
  );
}

/** The name of a constant initialized with a name in `names`, or null. */
function constantHolding(declaration: ts.Node, names: ReadonlySet<string>): string | null {
  if (
    !ts.isVariableDeclaration(declaration) ||
    !ts.isIdentifier(declaration.name) ||
    declaration.initializer === undefined ||
    (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) === 0
  )
    return null;
  const held = withoutParentheses(declaration.initializer);
  return ts.isIdentifier(held) && names.has(held.text) ? declaration.name.text : null;
}

/** Whether a mention of the arguments object reads it or asks one of this
 * module's questions, and nothing else. */
function keepsToItself(
  lowerer: Lowerer,
  mention: ts.Identifier,
  names: ReadonlySet<string>,
): boolean {
  let node: ts.Node = mention;
  while (ts.isParenthesizedExpression(node.parent)) node = node.parent;
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === node)
    return parent.name.text === "length" && !isWritten(parent);
  if (ts.isElementAccessExpression(parent) && parent.expression === node) return !isWritten(parent);
  if (ts.isSpreadElement(parent) || ts.isTypeOfExpression(parent)) return true;
  if (ts.isForOfStatement(parent)) return parent.expression === node;
  if (ts.isVariableDeclaration(parent) && parent.initializer === node)
    return constantHolding(parent, names) !== null;
  if (ts.isBinaryExpression(parent))
    return parent.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword && parent.left === node;
  if (!ts.isCallExpression(parent)) return false;
  const index = parent.arguments.nodes.findIndex((argument) => argument === node);
  if (index < 0) return false;
  const callee = withoutParentheses(parent.expression);
  if (!ts.isPropertyAccessExpression(callee)) return false;
  const name = callee.name.text;
  if (name === "isArray" || name === "from")
    return lowerer.isStdlibGlobal(callee.expression, "Array");
  if (name === "stringify") return lowerer.isStdlibGlobal(callee.expression, "JSON");
  if (name === "concat") return true;
  if (name !== "call" && name !== "apply") return false;
  // The argument list of `apply` is copied into the call.
  if (name === "apply" && index === 1) return true;
  const method = withoutParentheses(callee.expression);
  if (!ts.isPropertyAccessExpression(method)) return false;
  // An item of `concat.call(receiver, ...items)`: the question refused below.
  if (index > 0) return name === "call" && method.name.text === "concat";
  // The receiver of a method of Array.prototype or Object.prototype, spelled
  // through the prototype or through a literal (`[].slice`, `{}.toString`).
  const holder = withoutParentheses(method.expression);
  if (ts.isArrayLiteralExpression(holder) || ts.isObjectLiteralExpression(holder)) return true;
  return (
    ts.isPropertyAccessExpression(holder) &&
    holder.name.text === "prototype" &&
    (lowerer.isStdlibGlobal(holder.expression, "Array") ||
      lowerer.isStdlibGlobal(holder.expression, "Object"))
  );
}

/** Whether the function around `use` keeps its arguments object to itself:
 * every mention of the object there, by its name or through a constant that
 * holds it, reads it or asks one of this module's questions. Then nothing
 * can have changed what the object is. */
function argumentsObjectUntouched(lowerer: Lowerer, use: ts.Node): boolean {
  const owner = argumentsFunction(use);
  if (owner?.body === undefined) return false;
  // The names the object goes by: `arguments`, and the constants that hold
  // it or one another, wherever in the body they are declared.
  const names = new Set(["arguments"]);
  for (let grew = true; grew;) {
    grew = false;
    ts.walkPreorder(owner.body, (node) => {
      if (ts.isTypeNode(node)) return "skip";
      const name = constantHolding(node, names);
      if (name !== null && !names.has(name)) {
        names.add(name);
        grew = true;
      }
      return undefined;
    });
  }
  let untouched = true;
  ts.walkPreorder(owner.body, (node) => {
    if (ts.isTypeNode(node)) return "skip";
    if (!ts.isIdentifier(node) || !names.has(node.text) || !isArgumentsRead(node)) return undefined;
    // A nested function has its own `arguments`; a constant that holds this
    // one is the same object wherever it is mentioned.
    if (node.text === "arguments" && argumentsFunction(node) !== owner) return undefined;
    if (keepsToItself(lowerer, node, names)) return undefined;
    untouched = false;
    return "stop";
  });
  return untouched;
}

/** Refuses `concat` over the arguments object `item`. A function that names
 * `Symbol.isConcatSpreadable` may have made its arguments object spreadable,
 * which is what the list is: it keeps the list's lowering. */
function refuseConcat(lowerer: Lowerer, item: ts.Expression): void {
  const owner = argumentsFunction(item);
  let spreadable = false;
  if (owner?.body !== undefined) {
    ts.walkPreorder(owner.body, (node) => {
      if (ts.isIdentifier(node) && node.text === "isConcatSpreadable") {
        spreadable = true;
        return "stop";
      }
      return undefined;
    });
  }
  if (!spreadable) lowerer.unsupported("SC1090", item, CONCAT_FEATURE, CONCAT_HINT);
}

/** `Object.prototype` or an empty object literal: a receiver whose
 * `toString` is Object.prototype's. */
function isObjectPrototypeLike(lowerer: Lowerer, node: ts.Expression): boolean {
  const receiver = withoutParentheses(node);
  if (ts.isObjectLiteralExpression(receiver)) return receiver.properties.nodes.length === 0;
  return (
    ts.isPropertyAccessExpression(receiver) &&
    receiver.name.text === "prototype" &&
    lowerer.isStdlibGlobal(receiver.expression, "Object")
  );
}

/** A call that asks an arguments object what it is, or null for every other
 * call. The callee's name decides before any type is read. */
export function lowerArgumentsObjectCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  loc: SrcLoc,
): IrExpr | null {
  if (expr.questionDotToken !== undefined) return null;
  const callee = withoutParentheses(expr.expression);
  if (!ts.isPropertyAccessExpression(callee) || callee.questionDotToken !== undefined) return null;
  const name = callee.name.text;
  const args = expr.arguments.nodes;
  const first = args[0];
  if (name === "isArray") {
    if (
      args.length === 1 &&
      first !== undefined &&
      lowerer.isStdlibGlobal(callee.expression, "Array") &&
      isArgumentsObject(lowerer, first)
    )
      return { kind: "boolLit", value: false, type: BOOL, loc };
    return null;
  }
  if (name === "stringify") {
    if (
      first !== undefined &&
      lowerer.isStdlibGlobal(callee.expression, "JSON") &&
      isArgumentsObject(lowerer, first)
    )
      lowerer.unsupported("SC1090", first, JSON_FEATURE, JSON_HINT);
    return null;
  }
  if (name === "concat") {
    // Any receiver: a string's concat converts the object to its tag.
    const item = args.find((arg) => isArgumentsObject(lowerer, arg));
    if (item !== undefined) refuseConcat(lowerer, item);
    return null;
  }
  if (name !== "call" && name !== "apply") return null;
  const method = withoutParentheses(callee.expression);
  if (!ts.isPropertyAccessExpression(method) || method.questionDotToken !== undefined) return null;
  if (method.name.text === "concat") {
    // `concat.call(receiver, ...items)` and `concat.apply(receiver, [items])`.
    // The second argument of `apply` is the list of items, where an
    // arguments object is a list like any other.
    const second = args[1] === undefined ? undefined : withoutParentheses(args[1]);
    const items =
      name === "call"
        ? args
        : [
            ...(first === undefined ? [] : [first]),
            ...(second !== undefined && ts.isArrayLiteralExpression(second)
              ? second.elements.nodes
              : []),
          ];
    const item = items.find((arg) => isArgumentsObject(lowerer, arg));
    if (item !== undefined) refuseConcat(lowerer, item);
    return null;
  }
  if (
    method.name.text === "toString" &&
    first !== undefined &&
    (name === "call" ? args.length === 1 : args.length <= 2) &&
    isObjectPrototypeLike(lowerer, method.expression) &&
    isArgumentsObject(lowerer, first) &&
    argumentsObjectUntouched(lowerer, first)
  ) {
    // The checker types the call as `any`.
    return lowerer.coerceToExpected(
      { kind: "strLit", value: "[object Arguments]", type: STRING, loc },
      DYN,
    );
  }
  return null;
}

/** `arguments instanceof Array` (false) and `arguments instanceof Object`
 * (true), or null for every other test. */
export function lowerArgumentsObjectInstanceOf(
  lowerer: Lowerer,
  expr: ts.BinaryExpression,
  loc: SrcLoc,
): IrExpr | null {
  const right = withoutParentheses(expr.right);
  if (!ts.isIdentifier(right) || (right.text !== "Array" && right.text !== "Object")) return null;
  if (
    !lowerer.isStdlibGlobal(right, right.text) ||
    !isArgumentsObject(lowerer, expr.left) ||
    !argumentsObjectUntouched(lowerer, expr.left)
  )
    return null;
  return { kind: "boolLit", value: right.text === "Object", type: BOOL, loc };
}
