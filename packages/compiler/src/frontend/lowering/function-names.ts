/* The JavaScript names of object literals' methods.
 *
 * A function boxed into a checked value inside a record, an array or
 * another converted value has no static name at the box, so the backend
 * takes it from the function (LlEmitter.closureNames): its sourceName, or
 * for an object literal's method, whose stack-frame name differs, its
 * displayName. displayName is set only in modules that box such a
 * function, so other modules lower as before. */
import * as ts from "../ts7/adapter.js";
import type { IrFunction, IrType } from "../../ir/ir.js";
import { typeKey } from "../../ir/ir.js";
import { everyStmtList } from "../../ir/traverse.js";
import type { Lowerer } from "./lowerer.js";

/** Notes the name of the lifted function `fnName` when `node` is a method
 * of an object literal with a static key. */
export function noteObjectMethodName(lowerer: Lowerer, node: ts.Node, fnName: string): void {
  if (!ts.isMethodDeclaration(node) || !ts.isObjectLiteralExpression(node.parent)) return;
  const name = node.name;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name))
    lowerer.objectMethodNames.set(fnName, name.text);
  else if (ts.isNumericLiteral(name))
    lowerer.objectMethodNames.set(fnName, String(Number(name.text)));
}

/** Gives the noted methods their displayName when the module boxes a
 * function without a static name, or a value that can hold one. */
export function finalizeFunctionNames(lowerer: Lowerer, functions: readonly IrFunction[]): void {
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
