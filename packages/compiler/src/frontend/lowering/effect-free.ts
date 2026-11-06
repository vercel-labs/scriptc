import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import type { IrType } from "../../ir/ir.js";
import { shapeHasAccessorSlots } from "../../ir/ir.js";

/** A reference whose evaluation has no effects: an identifier, `this`, or a
 * property chain of stored data fields over one. A property read that can
 * run an accessor, or that checks a deferred-initialization slot, has
 * effects, so a chain through one is not pure. */
export function isPureReference(lowerer: Lowerer, node: ts.Expression): boolean {
  if (ts.isIdentifier(node) || node.kind === ts.SyntaxKind.ThisKeyword) return true;
  if (!ts.isPropertyAccessExpression(node) || node.questionDotToken) return false;
  return isPureReference(lowerer, node.expression) && isStoredFieldRead(lowerer, node);
}

/** `node` reads a stored data field: its receiver is a class instance whose
 * chain declares no method, accessor or deferred-initialization slot under
 * the name, or a record holding the field, so the read runs no program code
 * and cannot throw. */
export function isStoredFieldRead(lowerer: Lowerer, node: ts.PropertyAccessExpression): boolean {
  const name = node.name.text;
  let t: IrType | null;
  try {
    t = lowerer.mapTypeOf(lowerer.typeOf(node.expression));
  } catch {
    return false;
  }
  if (t?.kind === "record") {
    const shape = lowerer.shapes.get(t.shapeId);
    return (
      shape !== undefined &&
      !shapeHasAccessorSlots(shape) &&
      shape.fields.some((field) => field.name === name)
    );
  }
  if (t?.kind !== "object") return false;
  const info = lowerer.classes.get(t.className);
  if (info === undefined) return false;
  return (
    info.fields.has(name) &&
    !info.deferredInitFields?.has(name) &&
    lowerer.findMethodOn(info, name) === null &&
    lowerer.findMethodOn(info, `get:${name}`) === null &&
    lowerer.findMethodOn(info, `set:${name}`) === null
  );
}
