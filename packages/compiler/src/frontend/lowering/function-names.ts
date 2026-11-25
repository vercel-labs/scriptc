/* The JavaScript names of methods and of the anonymous functions that
 * initialize class fields.
 *
 * A function boxed into a checked value inside a record, an array or
 * another converted value has no static name at the box, so the backend
 * takes it from the function (LlEmitter.closureNames): its sourceName, or
 * its displayName where the stack-frame name differs. That is a method of
 * an object literal or of a class, a class field's initializer, and the
 * function that stands for a class method read as a value
 * (class-method-values.ts): each is named by the key it is declared
 * under. displayName is set only in modules that box such a function, so
 * other modules lower as before. */
import * as ts from "../ts7/adapter.js";
import type { IrFunction, IrType } from "../../ir/ir.js";
import { typeKey } from "../../ir/ir.js";
import { everyStmtList } from "../../ir/traverse.js";
import type { Lowerer } from "./lowerer.js";

/** The `name` of a function declared under `key`, as Node gives it: an
 * identifier, a string or a private name as written, a number in its
 * canonical spelling, `[Symbol.iterator]` for a well-known symbol. Null
 * for a key computed at run time. */
export function methodJsName(key: ts.PropertyName): string | null {
  if (ts.isIdentifier(key) || ts.isStringLiteral(key) || ts.isPrivateIdentifier(key))
    return key.text;
  if (ts.isNumericLiteral(key)) return String(Number(key.text));
  if (ts.isComputedPropertyName(key)) {
    const expression = key.expression;
    if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression))
      return expression.text;
    if (
      ts.isPropertyAccessExpression(expression) &&
      ts.isIdentifier(expression.expression) &&
      expression.expression.text === "Symbol"
    )
      return `[Symbol.${expression.name.text}]`;
  }
  return null;
}

/** Notes the name of the lifted function `fnName` when `node` is a method
 * of an object literal or of a class, or an anonymous function that
 * initializes a class field (`read = (x) => x + 1` is named "read", as a
 * `const` binding names its initializer), with a static key. */
export function noteObjectMethodName(lowerer: Lowerer, node: ts.Node, fnName: string): void {
  const key = namingKey(node);
  if (key === null) return;
  const name = methodJsName(key);
  if (name !== null) lowerer.objectMethodNames.set(fnName, name);
}

/** The property key that names the function `node` defines; null when no
 * key does. A class field names its initializer only when that is an
 * anonymous function definition, through the parentheses and type
 * assertions JavaScript does not see. */
function namingKey(node: ts.Node): ts.PropertyName | null {
  if (ts.isMethodDeclaration(node)) return node.name;
  if (!ts.isArrowFunction(node) && !(ts.isFunctionExpression(node) && node.name === undefined))
    return null;
  let outer: ts.Node = node;
  for (let p = outer.parent; p !== undefined; p = outer.parent) {
    if (
      !ts.isParenthesizedExpression(p) &&
      !ts.isAsExpression(p) &&
      !ts.isTypeAssertion(p) &&
      !ts.isSatisfiesExpression(p) &&
      !ts.isNonNullExpression(p)
    )
      break;
    outer = p;
  }
  const field = outer.parent;
  return field !== undefined && ts.isPropertyDeclaration(field) && field.initializer === outer
    ? field.name
    : null;
}

/** Gives the noted methods their displayName when the module boxes a
 * function without a static name, or a value that can hold one. */
export function finalizeFunctionNames(lowerer: Lowerer, functions: readonly IrFunction[]): void {
  finalizeHeldFunctionNames(lowerer, functions);
  if (lowerer.objectMethodNames.size === 0) return;
  const seen = new Map<string, boolean>();
  let boxes = false;
  for (const fn of functions) {
    everyStmtList(fn.body, {
      stmt: () => !boxes,
      expr: (e) => {
        // A function boxed on its own with a static name needs none.
        if (
          e.kind === "dynFrom" &&
          (e.value.type.kind === "func"
            ? e.fnName === undefined || e.fnName === ""
            : reachesFunction(lowerer, e.value.type, seen))
        )
          boxes = true;
        return !boxes;
      },
    });
    if (boxes) break;
  }
  if (!boxes) return;
  for (const fn of functions) {
    const name = lowerer.objectMethodNames.get(fn.name);
    if (name !== undefined) fn.displayName = name;
  }
}

/** Gives the function the compiler lifts for a primitive constructor held
 * as a typed value its displayName in a program that prints a function
 * held in a typed slot: the inspector renders such a function through a
 * box without a static name (lower-inspect.ts), which the backend names
 * from the function. A program that prints none keeps its functions as
 * they were. A method read as a value, static or not, is named with the
 * other methods above. */
function finalizeHeldFunctionNames(lowerer: Lowerer, functions: readonly IrFunction[]): void {
  if (lowerer.heldFunctionNames.size === 0) return;
  let prints = false;
  for (const fn of functions) {
    everyStmtList(fn.body, {
      stmt: () => !prints,
      expr: (e) => {
        if (e.kind === "libCall" && (e.fn === "insp.dyn" || e.fn === "insp.dynS")) {
          const boxed = e.args[0];
          if (
            boxed?.kind === "dynFrom" &&
            boxed.value.type.kind === "func" &&
            (boxed.fnName === undefined || boxed.fnName === "")
          )
            prints = true;
        }
        return !prints;
      },
    });
    if (prints) break;
  }
  if (!prints) return;
  for (const fn of functions) {
    const name = lowerer.heldFunctionNames.get(fn.name);
    if (name !== undefined && fn.displayName === undefined) fn.displayName = name;
  }
}

/** Whether a value of `t` can hold a function value. */
function reachesFunction(lowerer: Lowerer, t: IrType, seen: Map<string, boolean>): boolean {
  const key = typeKey(t);
  const known = seen.get(key);
  if (known !== undefined) return known;
  seen.set(key, false);
  let result = false;
  switch (t.kind) {
    case "func":
      result = true;
      break;
    case "record": {
      const shape = lowerer.shapes.get(t.shapeId);
      result =
        (shape?.fields.some((field) => reachesFunction(lowerer, field.type, seen)) ?? false) ||
        (shape?.indexValue !== undefined && reachesFunction(lowerer, shape.indexValue, seen));
      break;
    }
    case "array":
    case "set":
      result = reachesFunction(lowerer, t.elem, seen);
      break;
    case "map":
      result = reachesFunction(lowerer, t.key, seen) || reachesFunction(lowerer, t.value, seen);
      break;
    case "union":
      result = (lowerer.unions.get(t.unionId)?.arms ?? []).some((arm) =>
        reachesFunction(lowerer, arm, seen),
      );
      break;
    case "promise":
      result = reachesFunction(lowerer, t.inner, seen);
      break;
    case "object":
      result = [...(lowerer.classes.get(t.className)?.fields.values() ?? [])].some((field) =>
        reachesFunction(lowerer, field, seen),
      );
      break;
    default:
      result = false;
  }
  seen.set(key, result);
  return result;
}
