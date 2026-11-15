import * as ts from "../ts7/adapter.js";
import type { IrType } from "../../ir/ir.js";
import { typeEquals } from "../../ir/ir.js";
import { bodyReadsArguments } from "../arguments-usage.js";
import { isJsSourceFile } from "../program.js";
import { isThisParameter, type ParamShape } from "./call-signatures.js";
import type { Lowerer } from "./lowerer.js";

/** What the slot a function literal is written into passes to it and
 * takes back. */
export interface SlotSignature {
  /** The types of the arguments the slot passes, by position. */
  params: readonly IrType[];
  /** The slot's result, or null when the slot takes the literal's own. */
  ret: IrType | null;
  /** Whether the literal receives every parameter (a function-typed
   * destination: calls through it pass them all) or only the ones it
   * declares (an array method's callback: the method's loop passes what the
   * callback declares). */
  passesAll: boolean;
}

/** A function literal lowered with the parameter list of the slot it is
 * written into (`each(xs, (x) => …)` where `each` takes `(x, i) => void`).
 * The literal is used only at that slot, so its one body takes the slot's
 * signature as its ABI and the value needs no adapter closure: no second
 * allocation and no second indirect call per invocation. */
export interface SlotAdoption {
  /** The literal's ABI and its value's type: the slot's function type. */
  funcType: IrType & { kind: "func" };
  /** The literal's own parameters. One the slot passes at another type
   * carries that type as `slotType`, and its prologue converts. */
  shapes: ParamShape[];
  /** The slot's parameters after the literal's own: received and ignored. */
  extras: readonly IrType[];
  /** The literal's own `length`, when the slot's parameter count is not it. */
  length: number | undefined;
}

/** Whether the parameter's annotation spells `any`, by itself or inside
 * the type it writes (`Outcome<any>`, `{ detail: any }`). */
function spellsAny(decl: ts.ParameterDeclaration): boolean {
  if (decl.type === undefined) return false;
  let found = false;
  ts.walkPreorder(decl.type, (node) => {
    if (node.kind !== ts.SyntaxKind.AnyKeyword) return undefined;
    found = true;
    return "stop";
  });
  return found;
}

/** The adoption of `slot` by the literal `node`, whose own signature is
 * `shapes` and `funcType`; null when the literal keeps its own signature
 * and the slot's coercion adapts the value as before.
 *
 * The adoption is all or nothing: afterwards the literal's type IS the
 * slot's type. Parameters are observable, so only the forms whose behaviour
 * the adapter already defined exactly are taken:
 * - the literal declares no more parameters than the slot passes, none of
 *   them a rest parameter, and its body does not read `arguments` (a
 *   function expression's `arguments` holds what the caller passed);
 * - each declared parameter has the slot's type, or is a plain required
 *   name whose type the slot's value converts to the way the adapter
 *   converted it (coerceToExpected over a mechanical value conversion or a
 *   record width plan), with no default or pattern anywhere in the list: a
 *   conversion at entry would otherwise interleave with the default
 *   initializers the adapter ran it before;
 * - no parameter that converts is declared at `any` in a function-typed
 *   destination: that literal is an untyped function behind a typed slot,
 *   and stays one (spellsAny);
 * - the result already has the slot's type (lambdaSignature adopts the
 *   slot's result where it can), unless the slot takes the literal's own.
 * A named function expression can call itself with its own parameter list,
 * a `this` parameter types a receiver the slot does not declare, and a
 * generator binds its parameters at the first resume: those keep the
 * adapter. So does JavaScript source, whose function values cross the
 * checked-dynamic boundary instead. */
export function slotSignatureAdoption(
  lowerer: Lowerer,
  node: ts.SignatureDeclaration,
  shapes: readonly ParamShape[],
  funcType: IrType & { kind: "func" },
): SlotAdoption | null {
  const slot = lowerer.slotSignatures.get(node);
  if (slot === undefined) return null;
  if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) return null;
  if (isJsSourceFile(ts.getSourceFileOfNode(node))) return null;
  if (node.asteriskToken !== undefined || node.typeParameters?.nodes.length) return null;
  if (ts.isFunctionExpression(node) && (node.name !== undefined || bodyReadsArguments(node)))
    return null;
  if (
    lowerer.typedArgumentsLambdas.has(node) ||
    lowerer.dynParamLambdas.has(node) ||
    lowerer.errorFirstLiterals.has(node)
  )
    return null;
  const decls = node.parameters.nodes;
  if (decls.some(isThisParameter) || decls.length !== shapes.length) return null;
  if (funcType.rest === true) return null;
  if (funcType.params.length !== shapes.length || shapes.length > slot.params.length) return null;
  if (slot.ret !== null && !typeEquals(funcType.ret, slot.ret)) return null;
  const plain = (i: number): boolean => {
    const decl = decls[i]!;
    const shape = shapes[i]!;
    return (
      shape.mode === "required" &&
      shape.bodyType === undefined &&
      shape.entryNarrow === undefined &&
      shape.restTuple !== true &&
      ts.isIdentifier(decl.name) &&
      decl.initializer === undefined &&
      decl.questionToken === undefined &&
      decl.dotDotDotToken === undefined
    );
  };
  const adopted: ParamShape[] = [];
  let converts = false;
  for (let i = 0; i < shapes.length; i++) {
    const shape = shapes[i]!;
    if (shape.mode !== "required" && shape.mode !== "omittable") return null;
    const passed = slot.params[i]!;
    if (typeEquals(shape.type, passed)) {
      adopted.push(shape);
      continue;
    }
    // The conversions the slot's own coercion applies with coerceToExpected:
    // funcCoerceAdapter's for a function-typed destination (a mechanical
    // value conversion or a record width plan), the array callback's
    // otherwise (a mechanical value conversion only).
    const converted =
      lowerer.coercibleValue(passed, shape.type) ||
      (slot.passesAll && lowerer.widthLiftPlan(passed, shape.type) !== null);
    if (!plain(i) || !converted) return null;
    // A parameter the literal declares at `any` where the slot names a
    // type: the literal keeps its own signature. The slot's value can be
    // held without the slot's type later, and such a caller reaches the
    // function as it is declared (function-views.ts); a literal compiled
    // at the slot's parameter type would check that caller's argument
    // against a type the function never named. An array method's loop is
    // the only caller of its callback.
    if (slot.passesAll && spellsAny(decls[i]!)) return null;
    converts = true;
    adopted.push({ ...shape, slotType: passed });
  }
  if (converts && !shapes.every((_, i) => plain(i))) return null;
  const extras = slot.passesAll ? slot.params.slice(shapes.length) : [];
  if (!converts && extras.length === 0) return null;
  // Function.length counts the parameters before the first default.
  const firstDefault = decls.findIndex((decl) => decl.initializer !== undefined);
  const length = firstDefault < 0 ? decls.length : firstDefault;
  const params = [...slot.params.slice(0, shapes.length), ...extras];
  return {
    funcType: { kind: "func", params, ret: funcType.ret },
    shapes: adopted,
    extras,
    length: length === params.length ? undefined : length,
  };
}
