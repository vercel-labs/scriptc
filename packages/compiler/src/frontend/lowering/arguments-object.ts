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
 *
 * Two rules hold for every question here:
 *
 * - A question is asked of the builtin, and a member's name does not say
 *   which function it is. `concat`, `toString`, `call`, `apply` and the rest
 *   are recognized by the declaration the checker resolves them to (the
 *   standard library's, on the interface that owns the builtin), and
 *   `Array`, `Object` and `JSON` by the global binding. A member a program
 *   defines on an object literal or a class, a binding that shadows a
 *   global, and an untyped receiver are not the builtin: such a call is an
 *   ordinary call that passes the list, as everywhere else.
 * - An answer replaces a call's value and never its evaluation. The other
 *   arguments of an answered call are still evaluated, in source order, and
 *   a constant that holds the object is still read (a read before its
 *   declaration throws).
 */
import * as ts from "../ts7/adapter.js";
import { isArgumentsRead, isWritten } from "../arguments-usage.js";
import { withoutParentheses, withoutParenthesesTypeWrappers } from "../outer-expressions.js";
import { locOf } from "../program.js";
import { BOOL, DYN, STRING, type IrExpr, type IrStmt, type SrcLoc } from "../../ir/ir.js";
import type { Lowerer } from "./lowerer.js";

const CONCAT_FEATURE =
  "the arguments object as the receiver or an item of 'concat' (Node keeps it as one element: it is not an array and has no Symbol.isConcatSpreadable, while the compiled argument list is an array and would be spread)";
const CONCAT_HINT =
  "copy the arguments into an array first: Array.prototype.slice.call(arguments), [...arguments] or Array.from(arguments)";
const JSON_FEATURE =
  "JSON.stringify of the arguments object (Node writes an object keyed by index, while the compiled argument list is an array)";
const JSON_HINT = "copy the arguments into an array first, or build the object the caller expects";

/** The standard library interfaces that declare the builtins this module
 * recognizes: `concat` of an array or a string, a method of
 * Array.prototype or Object.prototype, and `call` / `apply` of a function. */
const ARRAY_OWNERS: ReadonlySet<string> = new Set(["Array", "ReadonlyArray"]);
const CONCAT_OWNERS: ReadonlySet<string> = new Set(["Array", "ReadonlyArray", "String"]);
const OBJECT_OWNERS: ReadonlySet<string> = new Set(["Object"]);
const FUNCTION_OWNERS: ReadonlySet<string> = new Set([
  "Function",
  "CallableFunction",
  "NewableFunction",
]);

/** The methods of Array.prototype and Object.prototype that keep a borrowed
 * receiver to themselves: they neither return it (`sort`, `reverse`,
 * `valueOf`) nor hand it to a callback (`forEach`, `map`, `reduce`: the
 * callback's last parameter is the receiver). */
const ARRAY_KEEPING_METHODS: ReadonlySet<string> = new Set([
  "at",
  "includes",
  "indexOf",
  "join",
  "lastIndexOf",
  "pop",
  "push",
  "shift",
  "slice",
  "splice",
  "unshift",
]);
const OBJECT_KEEPING_METHODS: ReadonlySet<string> = new Set([
  "hasOwnProperty",
  "propertyIsEnumerable",
  "toString",
]);

/** Whether `access` names a member the standard library declares on one of
 * `owners`: the builtin by its declaration, not by its name. A member a
 * program defines has its own declaration, and the member of an untyped
 * receiver has none. */
function isBuiltinMember(
  lowerer: Lowerer,
  access: ts.PropertyAccessExpression,
  owners: ReadonlySet<string>,
): boolean {
  const symbol = lowerer.checker.getSymbolAtLocation(access.name);
  if (symbol === undefined || symbol.declarations.length === 0) return false;
  // Every declaration: a member a program adds to or merges with is its own.
  return symbol.declarations.every((declaration) => {
    const owner = declaration.parent;
    return (
      owner !== undefined &&
      ts.isInterfaceDeclaration(owner) &&
      owners.has(owner.name.text) &&
      lowerer.isStdlibFile(ts.getSourceFileOfNode(declaration))
    );
  });
}

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
 * name qualifies: the name `arguments` evaluates nothing, and a constant is
 * read by the answer (heldConstantRead). */
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

/** The read an answer about `operand` keeps: none for the name `arguments`,
 * the constant's own read for a constant that holds the object, because a
 * constant read before its declaration throws. */
function heldConstantRead(lowerer: Lowerer, operand: ts.Expression): IrStmt[] {
  const name = withoutParenthesesTypeWrappers(operand);
  if (ts.isIdentifier(name) && name.text === "arguments") return [];
  return [{ kind: "exprStmt", expr: lowerer.lowerExpr(name), loc: locOf(name) }];
}

/** `answer` once `operand` has been read and `others`, the call's remaining
 * arguments, have been evaluated in source order for their effects. A spread
 * among them iterates: the call is then made as any other call (`ordinary`)
 * and only its answer is replaced. */
function answerAfter(
  lowerer: Lowerer,
  operand: ts.Expression,
  others: readonly ts.Expression[],
  answer: IrExpr,
  loc: SrcLoc,
  ordinary: () => IrExpr,
): IrExpr {
  if (others.some((other) => ts.isSpreadElement(other) || ts.isOmittedExpression(other)))
    return answerOfOrdinaryCall(answer, loc, ordinary);
  const stmts = heldConstantRead(lowerer, operand);
  for (const other of others)
    stmts.push({ kind: "exprStmt", expr: lowerer.lowerExpr(other), loc: locOf(other) });
  return stmts.length === 0
    ? answer
    : { kind: "seqExpr", stmts, result: answer, type: answer.type, loc };
}

/** `answer` in place of the value of the call made as any other call: the
 * call evaluates and checks what it evaluates and checks everywhere else. */
function answerOfOrdinaryCall(answer: IrExpr, loc: SrcLoc, ordinary: () => IrExpr): IrExpr {
  return {
    kind: "seqExpr",
    stmts: [{ kind: "exprStmt", expr: ordinary(), loc }],
    result: answer,
    type: answer.type,
    loc,
  };
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

/** `Object.prototype.toString`, spelled through the prototype or through an
 * empty object literal (which has no member of its own). */
function isObjectPrototypeToString(lowerer: Lowerer, method: ts.PropertyAccessExpression): boolean {
  if (method.name.text !== "toString" || method.questionDotToken !== undefined) return false;
  const holder = withoutParentheses(method.expression);
  if (ts.isObjectLiteralExpression(holder)) return holder.properties.nodes.length === 0;
  return (
    ts.isPropertyAccessExpression(holder) &&
    holder.name.text === "prototype" &&
    lowerer.isStdlibGlobal(holder.expression, "Object") &&
    isBuiltinMember(lowerer, method, OBJECT_OWNERS)
  );
}

/** Whether `method`, borrowed for the arguments object with `call` or
 * `apply`, is a builtin that keeps its receiver to itself: a listed method
 * of Array.prototype or Object.prototype, spelled through the prototype or
 * through a literal (`[].slice`, `{}.toString`). */
function isKeepingBorrowedMethod(lowerer: Lowerer, method: ts.PropertyAccessExpression): boolean {
  if (method.questionDotToken !== undefined) return false;
  const name = method.name.text;
  const holder = withoutParentheses(method.expression);
  if (ts.isArrayLiteralExpression(holder))
    return ARRAY_KEEPING_METHODS.has(name) && isBuiltinMember(lowerer, method, ARRAY_OWNERS);
  if (ts.isObjectLiteralExpression(holder))
    return OBJECT_KEEPING_METHODS.has(name) && holder.properties.nodes.length === 0;
  if (!ts.isPropertyAccessExpression(holder) || holder.name.text !== "prototype") return false;
  if (lowerer.isStdlibGlobal(holder.expression, "Array"))
    return ARRAY_KEEPING_METHODS.has(name) && isBuiltinMember(lowerer, method, ARRAY_OWNERS);
  return (
    lowerer.isStdlibGlobal(holder.expression, "Object") &&
    OBJECT_KEEPING_METHODS.has(name) &&
    isBuiltinMember(lowerer, method, OBJECT_OWNERS)
  );
}

/** Whether a mention of the arguments object reads it or asks one of this
 * module's questions of a builtin, and nothing else. */
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
  // The value asked about is the first argument; a later one is handed on
  // (the receiver `Array.from` gives its callback).
  if (name === "isArray" || name === "from")
    return index === 0 && lowerer.isStdlibGlobal(callee.expression, "Array");
  if (name === "stringify") return index === 0 && lowerer.isStdlibGlobal(callee.expression, "JSON");
  // An item of the builtin `concat`: the question refused below.
  if (name === "concat") return isBuiltinMember(lowerer, callee, CONCAT_OWNERS);
  if (name !== "call" && name !== "apply") return false;
  if (!isBuiltinMember(lowerer, callee, FUNCTION_OWNERS)) return false;
  // The argument list of `apply` is copied into the call.
  if (name === "apply" && index === 1) return true;
  const method = withoutParentheses(callee.expression);
  if (!ts.isPropertyAccessExpression(method)) return false;
  // An item of `concat.call(receiver, ...items)`, refused below.
  if (index > 0)
    return (
      name === "call" &&
      method.name.text === "concat" &&
      isBuiltinMember(lowerer, method, CONCAT_OWNERS)
    );
  // The receiver of a builtin: `concat` (refused below) or a method that
  // keeps the receiver to itself.
  return (
    (method.name.text === "concat" && isBuiltinMember(lowerer, method, CONCAT_OWNERS)) ||
    isKeepingBorrowedMethod(lowerer, method)
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

/** Refuses the builtin `concat` over the arguments object `item`. A function
 * that names `Symbol.isConcatSpreadable` may have made its arguments object
 * spreadable, which is what the list is: it keeps the list's lowering. */
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

/** A call that asks an arguments object what it is, or null for every other
 * call. `ordinary` lowers the call as any other call. The callee's name
 * selects the question before any type is read; the declaration behind the
 * name decides whether it is the builtin's. */
export function lowerArgumentsObjectCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  loc: SrcLoc,
  ordinary: () => IrExpr,
): IrExpr | null {
  const callee = withoutParentheses(expr.expression);
  if (!ts.isPropertyAccessExpression(callee)) return null;
  const name = callee.name.text;
  const args = expr.arguments.nodes;
  const first = args[0];
  if (name === "concat") {
    // The `concat` of an array or of a string (which converts the object to
    // its tag), also through an optional chain.
    const item = args.find((arg) => isArgumentsObject(lowerer, arg));
    if (item !== undefined && isBuiltinMember(lowerer, callee, CONCAT_OWNERS))
      refuseConcat(lowerer, item);
    return null;
  }
  if (expr.questionDotToken !== undefined || callee.questionDotToken !== undefined) return null;
  if (name === "isArray") {
    if (
      first === undefined ||
      !lowerer.isStdlibGlobal(callee.expression, "Array") ||
      !isArgumentsObject(lowerer, first)
    )
      return null;
    // `isArray` reads its first argument only.
    return answerAfter(
      lowerer,
      first,
      args.slice(1),
      { kind: "boolLit", value: false, type: BOOL, loc },
      loc,
      ordinary,
    );
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
    // The builtin `concat` through a function's own `call` or `apply`, not
    // members of those names.
    if (
      item !== undefined &&
      isBuiltinMember(lowerer, callee, FUNCTION_OWNERS) &&
      isBuiltinMember(lowerer, method, CONCAT_OWNERS)
    )
      refuseConcat(lowerer, item);
    return null;
  }
  if (
    first === undefined ||
    method.name.text !== "toString" ||
    !isArgumentsObject(lowerer, first) ||
    !isBuiltinMember(lowerer, callee, FUNCTION_OWNERS) ||
    !isObjectPrototypeToString(lowerer, method) ||
    !argumentsObjectUntouched(lowerer, first)
  )
    return null;
  // The checker types the call as `any`.
  const tag = lowerer.coerceToExpected(
    { kind: "strLit", value: "[object Arguments]", type: STRING, loc },
    DYN,
  );
  // `toString` takes no argument: what follows the receiver of `call` is
  // evaluated and dropped.
  if (name === "call") return answerAfter(lowerer, first, args.slice(1), tag, loc, ordinary);
  // `apply` reads its list before the function runs: an object or nothing,
  // then its length and its elements. A literal list is its elements, and
  // what follows the list is evaluated and dropped; any other list is read
  // by the call made as any other call.
  const list = args[1] === undefined ? undefined : withoutParentheses(args[1]);
  if (list === undefined) return answerAfter(lowerer, first, [], tag, loc, ordinary);
  if (ts.isArrayLiteralExpression(list))
    return answerAfter(
      lowerer,
      first,
      [...list.elements.nodes, ...args.slice(2)],
      tag,
      loc,
      ordinary,
    );
  return answerOfOrdinaryCall(tag, loc, ordinary);
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
  const answer: IrExpr = { kind: "boolLit", value: right.text === "Object", type: BOOL, loc };
  const read = heldConstantRead(lowerer, expr.left);
  return read.length === 0
    ? answer
    : { kind: "seqExpr", stmts: read, result: answer, type: BOOL, loc };
}
