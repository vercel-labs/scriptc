/* Object.entries and Object.values of an open spread value.
 *
 * An object literal that spreads a value with an index signature (or of
 * type `object`) and adds members is typed by the checker by its members
 * alone (`{ ...tags, count:
 * 4 }` is `{ count: number }`), so the checker infers `[string, number][]`
 * for Object.entries of it and `number[]` for Object.values. The object
 * holds every key the spread copied, and the type mapper builds it as the
 * open object it is (dictSpreadLiteralShape): the checked-dynamic object, or
 * a record of the spread's slot type. Its enumeration therefore answers
 * values the checker's element type does not describe.
 *
 * Such an enumeration answers the values as they are, checked-dynamic, to
 * the bindings that take them directly: the parameter of a callback written
 * at an array method of the enumeration, and the binding of a for...of over
 * it. Those bindings hold the checked-dynamic value, so the loop or the
 * callback runs for every key, `typeof` sees what Node sees, and a read
 * that needs the checker's type checks the value there, as every read of a
 * checked-dynamic value does. Every other consumer (a variable, an
 * argument, a return) converts the whole result to the checker's type at
 * once, as before.
 *
 * The decision is made once, before any body is lowered
 * (analyzeOpenEnumerations registers the bindings), from the syntax of the
 * consumer and the checker's types, and the enumeration's own lowering asks
 * the same question of the same nodes. */
import * as ts from "../ts7/adapter.js";
import type { IrExpr, IrType } from "../../ir/ir.js";
import { DYN, STRING, typeEquals } from "../../ir/ir.js";
import { withoutParentheses } from "../outer-expressions.js";
import { isJsSourceFile, locOf } from "../program.js";
import { spreadsDictSource } from "../type-mapper.js";
import { isThisParameter } from "./call-signatures.js";
import type { FileParts } from "./lower-modules.js";
import type { Lowerer } from "./lowerer.js";

/** An enumeration of an open spread value: the call, and the array type it
 * answers to the bindings that take its elements as they are. */
interface OpenEnumeration {
  readonly call: ts.CallExpression;
  readonly member: "entries" | "values";
  readonly type: IrType & { kind: "array" };
}

/** The `[string, unknown]` pair Object.entries answers for an open value. */
function openPair(lowerer: Lowerer): IrType {
  return {
    kind: "record",
    shapeId: lowerer.shapes.intern(
      [
        { name: "0", type: STRING },
        { name: "1", type: DYN },
      ],
      true,
    ),
  };
}

/** Whether `type` is the type of an object literal that spreads a value
 * whose keys its type does not list: an index signature (or another such
 * literal), or the `object` type. Checker types only. */
function spreadsOpenSource(checker: ts.TypeChecker, type: ts.Type): boolean {
  if (spreadsDictSource(checker, type)) return true;
  const symbol = type.getSymbol();
  if (!symbol || (symbol.flags & ts.SymbolFlags.ObjectLiteral) === 0) return false;
  const literal = symbol.declarations.find((d): d is ts.ObjectLiteralExpression =>
    ts.isObjectLiteralExpression(d),
  );
  return (
    literal !== undefined &&
    literal.properties.nodes.some(
      (p) =>
        ts.isSpreadAssignment(p) &&
        (checker.getNonNullableType(checker.getTypeAtLocation(p.expression)).flags &
          ts.TypeFlags.NonPrimitive) !==
          0,
    )
  );
}

/** `expr` as an Object.entries or Object.values call of an open spread
 * value whose values the checker's element type does not describe; null
 * for every other expression. */
function openEnumerationCall(lowerer: Lowerer, expr: ts.Expression): OpenEnumeration | null {
  const call = withoutParentheses(expr);
  if (
    !ts.isCallExpression(call) ||
    call.questionDotToken ||
    !ts.isPropertyAccessExpression(call.expression) ||
    call.expression.questionDotToken
  )
    return null;
  const member = call.expression.name.text;
  if (member !== "entries" && member !== "values") return null;
  const arg = call.arguments.nodes[0];
  if (call.arguments.nodes.length !== 1 || arg === undefined || ts.isSpreadElement(arg))
    return null;
  if (isJsSourceFile(ts.getSourceFileOfNode(call))) return null;
  if (!lowerer.isStdlibGlobal(call.expression.expression, "Object")) return null;
  // Checker types decide first: only a literal that spreads an index
  // signature is mapped here, so every other program maps its types in the
  // order it always did.
  const { checker } = lowerer;
  const type = checker.getNonNullableType(lowerer.typeOf(arg));
  if (!spreadsOpenSource(checker, type) || checker.getIndexInfosOfType(type).length > 0)
    return null;
  const mapped = lowerer.mapTypeOf(type);
  const result = lowerer.mapTypeOf(lowerer.typeOf(call));
  if (mapped === null || result?.kind !== "array") return null;
  // What the checker says one value is: the pair's second slot, or the
  // element.
  let declared: IrType | undefined = result.elem;
  if (member === "entries") {
    const pair = result.elem.kind === "record" ? lowerer.shapes.get(result.elem.shapeId) : null;
    if (!pair?.tuple || pair.fields.length !== 2) return null;
    declared = pair.fields.find((field) => field.name === "1")?.type;
  }
  if (declared === undefined || declared.kind === "dyn") return null;
  if (mapped.kind === "record") {
    const shape = lowerer.shapes.get(mapped.shapeId);
    if (!shape?.indexValue || shape.tuple || shape.fields.length > 0) return null;
    // A slot of exactly the checker's value type holds nothing else.
    if (typeEquals(shape.indexValue, declared) || !lowerer.dynConvertible(mapped)) return null;
  } else if (mapped.kind !== "dyn") return null;
  return {
    call,
    member,
    type: { kind: "array", elem: member === "entries" ? openPair(lowerer) : DYN },
  };
}

/** The array methods whose callback takes elements of its receiver, with
 * the callback parameters that do. */
const ELEMENT_PARAMETERS: ReadonlyMap<string, readonly number[]> = new Map([
  ["every", [0]],
  ["filter", [0]],
  ["find", [0]],
  ["findIndex", [0]],
  ["flatMap", [0]],
  ["forEach", [0]],
  ["map", [0]],
  ["some", [0]],
  ["reduce", [1]],
  ["reduceRight", [1]],
]);

/** The methods above an Object.values list lowers natively (lower-calls.ts
 * VALUE_LIST_METHODS) and an Object.entries pair list binds pair by pair
 * (ENTRY_PAIR_CALLBACK_METHODS). */
const VALUE_METHODS = new Set([
  "every",
  "filter",
  "findIndex",
  "flatMap",
  "forEach",
  "map",
  "reduce",
  "reduceRight",
  "some",
]);
const ENTRY_METHODS = new Set([
  "every",
  "filter",
  "find",
  "findIndex",
  "flatMap",
  "forEach",
  "map",
  "some",
]);

/** The callback literal of `receiver.method(callback)` when `node` is the
 * receiver and the method hands its elements to that callback. */
function elementCallback(
  node: ts.Expression,
  member: "entries" | "values",
): { callback: ts.ArrowFunction | ts.FunctionExpression; elements: readonly number[] } | null {
  let outer: ts.Node = node;
  while (ts.isParenthesizedExpression(outer.parent)) outer = outer.parent;
  const access = outer.parent;
  if (
    !ts.isPropertyAccessExpression(access) ||
    access.expression !== outer ||
    access.questionDotToken
  )
    return null;
  const call = access.parent;
  if (!ts.isCallExpression(call) || call.expression !== access || call.questionDotToken)
    return null;
  const name = access.name.text;
  if (!(member === "entries" ? ENTRY_METHODS : VALUE_METHODS).has(name)) return null;
  const elements = ELEMENT_PARAMETERS.get(name);
  const first = call.arguments.nodes[0];
  if (elements === undefined || first === undefined || ts.isSpreadElement(first)) return null;
  const callback = withoutParentheses(first);
  if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) return null;
  return { callback, elements };
}

/** The for...of statement `node` is the iterable of. */
function iteratingStatement(node: ts.Expression): ts.ForOfStatement | null {
  let outer: ts.Node = node;
  while (ts.isParenthesizedExpression(outer.parent)) outer = outer.parent;
  const statement = outer.parent;
  return ts.isForOfStatement(statement) &&
    statement.expression === outer &&
    !statement.awaitModifier
    ? statement
    : null;
}

/** Whether the enumeration's result goes straight to bindings that take
 * its elements as they are. */
function consumedAsIs(open: OpenEnumeration): boolean {
  return elementCallback(open.call, open.member) !== null || iteratingStatement(open.call) !== null;
}

/** The lowering of an enumeration of an open spread value whose consumer
 * takes its elements as they are: the pairs or the values of the
 * checked-dynamic view of the object, in a native array. Null for every
 * other call, which lowers as before. */
export function lowerOpenEnumeration(lowerer: Lowerer, call: ts.CallExpression): IrExpr | null {
  const open = openEnumerationCall(lowerer, call);
  if (open === null || !consumedAsIs(open)) return null;
  const loc = locOf(call);
  let value = lowerer.coerceToExpected(lowerer.lowerExpr(call.arguments.nodes[0]!), DYN);
  if (value.type.kind !== "dyn") return null;
  // A record of the spread's slot type is walked through its live view,
  // which lists its keys in the object's own order.
  if (value.kind === "dynFrom" && value.value.type.kind === "record")
    value = { ...value, liveRef: true };
  return {
    kind: "libCall",
    fn: open.member === "entries" ? "dyn.objEntryPairs" : "dyn.objValueList",
    args: [value],
    type: open.type,
    loc,
  };
}

/** Registers the bindings that take the elements of an open enumeration as
 * they are: `bind(symbol, type)` for a binding, `bindPattern(pattern, type)`
 * for a destructured one. Runs once, before any body is lowered. */
export function analyzeOpenEnumerations(
  lowerer: Lowerer,
  parts: readonly FileParts[],
  bind: (symbol: ts.Symbol, type: IrType) => void,
  bindPattern: (pattern: ts.Node, type: IrType) => void,
): void {
  const bindElement = (name: ts.BindingName, open: OpenEnumeration): void => {
    if (ts.isIdentifier(name)) {
      const symbol = lowerer.checker.getSymbolAtLocation(name);
      if (symbol) bind(symbol, open.type.elem);
      return;
    }
    // `[key, value]` over pairs: the value is the checked-dynamic slot.
    if (open.member !== "entries" || !ts.isArrayBindingPattern(name)) return;
    const second = name.elements.nodes[1];
    if (
      second === undefined ||
      ts.isOmittedExpression(second) ||
      second.dotDotDotToken ||
      second.initializer ||
      !ts.isIdentifier(second.name)
    )
      return;
    const symbol = lowerer.checker.getSymbolAtLocation(second.name);
    if (!symbol) return;
    bind(symbol, DYN);
    bindPattern(name, open.type.elem);
  };
  for (const { sf } of parts) {
    if (sf.isDeclarationFile || isJsSourceFile(sf)) continue;
    if (!ts.sourceTextIncludes(sf, "...")) continue;
    if (!ts.sourceTextIncludes(sf, "Object.entries") && !ts.sourceTextIncludes(sf, "Object.values"))
      continue;
    ts.walkPreorder(sf, (node) => {
      if (!ts.isCallExpression(node)) return undefined;
      const open = openEnumerationCall(lowerer, node);
      if (open === null) return undefined;
      const called = elementCallback(node, open.member);
      if (called !== null) {
        const parameters = called.callback.parameters.nodes;
        const data =
          parameters.length > 0 && isThisParameter(parameters[0]!)
            ? parameters.slice(1)
            : parameters;
        for (const index of called.elements) {
          const parameter = data[index];
          if (
            parameter === undefined ||
            parameter.type ||
            parameter.initializer ||
            parameter.dotDotDotToken
          )
            continue;
          bindElement(parameter.name, open);
        }
        return undefined;
      }
      const statement = iteratingStatement(node);
      if (statement === null || !ts.isVariableDeclarationList(statement.initializer))
        return undefined;
      const declaration = statement.initializer.declarations.nodes[0];
      if (declaration !== undefined && !declaration.type) bindElement(declaration.name, open);
      return undefined;
    });
  }
}
