import * as ts from "../../ts7/adapter.js";
import {
  BOOL,
  DYN,
  F64,
  STRING,
  VOID,
  isUnitType,
  typeEquals,
  type IrExpr,
  type IrStmt,
  type IrType,
} from "../../../ir/ir.js";
import { varRef } from "../../../ir/build.js";
import { locOf } from "../../program.js";
import type { Lowerer } from "../lowerer.js";
import {
  arrayNumberRead,
  arrayValueRead,
  arrayValueStore,
  elementMayBeForeign,
} from "../array-values.js";
import { fenceNodeModuleMutation } from "../lower-node-module.js";
import { globalSymbolKey } from "./global-symbols.js";
import { tryLowerExpression } from "./try-lower-expression.js";
import {
  type KeyedFieldTarget,
  keyedFieldTarget,
  saveKeyedFieldKey,
} from "./keyed-field-targets.js";
import {
  eventAccessorRead,
  eventAccessorWrite,
  isEventWritableAccessor,
} from "../lower-event-target.js";

/** Element kinds whose present values are never null or undefined. */
const NON_NULLISH_ELEMENTS: ReadonlySet<IrType["kind"]> = new Set([
  "f64",
  "string",
  "bool",
  "bigint",
  "object",
  "array",
]);

/** The reference and its read evaluate once; the write exists only in the
 * selected branch. In particular an accessor setter never runs for a kept value. */
export function lowerShortCircuitAssignment(lowerer: Lowerer, expr: ts.BinaryExpression): IrExpr {
  const nullish = expr.operatorToken.kind === ts.SyntaxKind.QuestionQuestionEqualsToken;
  const and = expr.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken;
  const loc = locOf(expr);
  const prefix: IrStmt[] = [];
  const save = (value: IrExpr, name: string): IrExpr => {
    const local = lowerer.declareHiddenLocal(name, value.type);
    prefix.push({ kind: "varDecl", localId: local.id, init: value, loc: value.loc });
    return varRef(local.id, value.type, value.loc);
  };
  const finish = (result: IrExpr): IrExpr =>
    prefix.length === 0
      ? result
      : { kind: "seqExpr", stmts: prefix, result, type: result.type, loc };
  let target = expr.left;
  while (ts.isParenthesizedExpression(target)) target = target.expression;
  let read: IrExpr;
  let storage: IrType;
  // The right side, when an element fast path already lowered it.
  let rhs: IrExpr | null = null;
  let write: (value: IrExpr) => IrStmt;
  if (ts.isIdentifier(target)) {
    const binding = lowerer.resolveWritable(target);
    if (!binding)
      lowerer.rejectUnresolved(target, "short-circuit assignment to a non-writable binding");
    storage = binding.type;
    read = varRef(binding.id, binding.type, locOf(target));
    write = (value) => ({ kind: "assign", localId: binding.id, value, loc });
  } else if (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) {
    fenceNodeModuleMutation(lowerer, target, "assignment");
    if (target.questionDotToken || target.expression.kind === ts.SyntaxKind.SuperKeyword) {
      lowerer.unsupported(
        "SC1090",
        target,
        "short-circuit assignment through optional or super references",
      );
    }
    const globalKey = ts.isElementAccessExpression(target)
      ? globalSymbolKey(lowerer, target.expression, target.argumentExpression)
      : null;
    if (globalKey) {
      const key = save(globalKey, "%shortCircuitKey");
      storage = DYN;
      read = { kind: "libCall", fn: "dyn.globalSymbolGet", args: [key], type: DYN, loc };
      write = (value) => ({
        kind: "exprStmt",
        expr: { kind: "libCall", fn: "dyn.globalSymbolSet", args: [key, value], type: VOID, loc },
        loc,
      });
    } else if (ts.isPropertyAccessExpression(target) && isEventWritableAccessor(lowerer, target)) {
      // returnValue/cancelBubble on an Event subclass instance: the
      // accessors read and write the event.
      const receiver = save(lowerer.lowerExpr(target.expression), "%shortCircuitReceiver");
      const name = target.name.text;
      storage = BOOL;
      read = eventAccessorRead(receiver, name, lowerer, loc);
      write = (value) => eventAccessorWrite(receiver, name, value, lowerer, loc);
    } else if (ts.isPropertyAccessExpression(target)) {
      const probed = tryLowerExpression(lowerer, target.expression);
      // `value.#x ??= v` on a checked-dynamic value names the brand-checked
      // field (fieldTarget), never a property called "#x".
      if (probed?.type.kind === "dyn" && !ts.isPrivateIdentifier(target.name)) {
        const receiver = save(probed, "%shortCircuitReceiver");
        const key: IrExpr = { kind: "strLit", value: target.name.text, type: STRING, loc };
        storage = DYN;
        read = { kind: "dynKeyGet", key, value: receiver, type: DYN, loc };
        write = (value) => ({
          kind: "exprStmt",
          expr: {
            kind: "libCall",
            fn: "dyn.keySet",
            args: [receiver, key, value],
            type: VOID,
            loc,
          },
          loc,
        });
      } else {
        const field = lowerer.fieldTarget(target);
        if (field) {
          field.obj = save(field.obj, "%shortCircuitReceiver");
          read = lowerer.fieldGetExpr(field, locOf(target), target);
          storage = field.fieldType;
          const blame = target;
          write = (value) => lowerer.fieldSetStmt(field, value, loc, blame);
        } else if (probed?.type.kind === "object" && lowerer.dynConvertible(probed.type)) {
          // Inferred JS fields may live in the instance's property bag.
          // Its checked capsule writes through to the same native object.
          const receiver = save(lowerer.coerceToExpected(probed, DYN), "%shortCircuitReceiver");
          const key: IrExpr = { kind: "strLit", value: target.name.text, type: STRING, loc };
          storage = DYN;
          read = { kind: "dynKeyGet", key, value: receiver, type: DYN, loc };
          write = (value) => ({
            kind: "exprStmt",
            expr: {
              kind: "libCall",
              fn: "dyn.keySet",
              args: [receiver, key, value],
              type: VOID,
              loc,
            },
            loc,
          });
        } else
          lowerer.unsupported(
            "SC1090",
            target,
            "short-circuit assignment to an unsupported property",
          );
      }
    } else {
      const receiver = save(lowerer.lowerExpr(target.expression), "%shortCircuitReceiver");
      let key = lowerer.lowerExpr(target.argumentExpression);
      let keyed: KeyedFieldTarget | null = null;
      if (receiver.type.kind === "dyn") {
        key = save(
          {
            kind: "libCall",
            fn: "dyn.propertyKey",
            args: [lowerer.coerceInto(target.argumentExpression, key, DYN)],
            type: DYN,
            loc,
          },
          "%shortCircuitKey",
        );
        storage = DYN;
        read = { kind: "dynKeyGet", key, value: receiver, type: DYN, loc };
        write = (value) => ({
          kind: "exprStmt",
          expr: {
            kind: "libCall",
            fn: "dyn.keySetComputed",
            args: [receiver, key, value],
            type: VOID,
            loc,
          },
          loc,
        });
      } else if (receiver.type.kind === "array" && key.type.kind === "f64") {
        key = save(key, "%shortCircuitKey");
        storage = receiver.type.elem;
        const element = storage;
        write = (value) => arrayValueStore(lowerer, receiver, key, value, element, loc);
        const elementLoc = locOf(target);
        // A foreign element can be any value, nullish or not.
        if (
          nullish &&
          NON_NULLISH_ELEMENTS.has(element.kind) &&
          !elementMayBeForeign(lowerer, element)
        ) {
          // Only a missing element is nullish: keep the present value or
          // store the right side, without the optional element value.
          rhs = lowerer.lowerExprExpecting(expr.right, element);
          if (typeEquals(rhs.type, element)) {
            const assigned = lowerer.declareHiddenLocal("%shortCircuitValue", element);
            const ref = varRef(assigned.id, element, loc);
            const present: IrExpr = {
              kind: "bin",
              op: "===",
              left: { kind: "arrayState", arr: receiver, index: key, type: F64, loc: elementLoc },
              right: { kind: "numLit", value: 1, type: F64, loc: elementLoc },
              type: BOOL,
              loc: elementLoc,
            };
            return finish({
              kind: "ternary",
              cond: present,
              then: { kind: "arrayGet", arr: receiver, index: key, type: element, loc: elementLoc },
              else_: {
                kind: "seqExpr",
                stmts: [{ kind: "varDecl", localId: assigned.id, init: rhs, loc }, write(ref)],
                result: ref,
                type: element,
                loc,
              },
              type: element,
              loc,
            });
          }
        }
        // `||=` keeps only a truthy number, which is always present; NaN is
        // falsy exactly like the undefined of a missing element.
        read =
          !nullish && !and && element.kind === "f64"
            ? arrayNumberRead(receiver, key, elementLoc)
            : arrayValueRead(lowerer, receiver, key, element, elementLoc);
      } else if (
        receiver.type.kind === "record" &&
        key.type.kind === "string" &&
        pureIndexShapeOf(lowerer, receiver.type.shapeId) !== null
      ) {
        // `timings[phase] ??= v` over a pure index-signature record
        // (`Record<string, number>`): the keyed read answers the value or
        // undefined for a missing key, and the write inserts or replaces
        // the key, exactly the two halves `o[k]` and `o[k] = v` lower to.
        const shapeId = receiver.type.shapeId;
        const indexValue = pureIndexShapeOf(lowerer, shapeId)!;
        key = save(key, "%shortCircuitKey");
        const readType =
          indexValue.kind === "dyn" ? indexValue : lowerer.withUndefinedArmOf(indexValue);
        if (!readType) {
          lowerer.unsupported(
            "SC1090",
            target,
            "short-circuit assignment through this indexed receiver",
          );
        }
        storage = indexValue;
        read = { kind: "recordKeyGet", obj: receiver, shapeId, key, type: readType, loc };
        write = (value) => ({
          kind: "recordKeySet",
          obj: receiver,
          shapeId,
          key,
          value: lowerer.coerceToExpected(value, indexValue),
          loc,
        });
      } else if (
        receiver.type.kind === "record" &&
        (keyed = keyedFieldTarget(lowerer, target, false, { obj: receiver, key }))
      ) {
        // `totals[side] ??= v` through a literal-union key: the read and
        // the write dispatch over the declared fields the key can name.
        const field = keyed;
        saveKeyedFieldKey(field, save);
        storage = field.fieldType;
        read = lowerer.fieldGetExpr(field, locOf(target), target);
        write = (value) => lowerer.fieldSetStmt(field, value, loc, target);
      } else {
        lowerer.unsupported(
          "SC1090",
          target,
          "short-circuit assignment through this indexed receiver",
        );
      }
    }
  } else {
    lowerer.unsupported("SC1090", target, "short-circuit assignment to this reference");
  }
  if (
    nullish &&
    !isUnitType(read.type) &&
    read.type.kind !== "dyn" &&
    (read.type.kind !== "union" || !lowerer.unions.get(read.type.unionId)?.arms.some(isUnitType))
  ) {
    return finish(read);
  }
  const value = rhs ?? lowerer.lowerExprExpecting(expr.right, storage);
  const assigned = lowerer.declareHiddenLocal("%shortCircuitValue", value.type);
  const ref = varRef(assigned.id, value.type, loc);
  const result = lowerer.coerceInto(expr.right, ref, read.type);
  const right: IrExpr = {
    kind: "seqExpr",
    stmts: [{ kind: "varDecl", localId: assigned.id, init: value, loc }, write(ref)],
    result,
    type: result.type,
    loc,
  };
  if (!nullish) {
    // Saving even a bare local matters: the RHS or an accessor setter can
    // change that binding, and the expression must still yield the value
    // selected by the original read or RHS.
    const kept = save(read, "%shortCircuitRead");
    const condition = lowerer.ensureBool(kept, target);
    return finish({
      kind: "ternary",
      cond: condition,
      then: and ? right : kept,
      else_: and ? kept : right,
      type: read.type,
      loc,
    });
  }
  if (isUnitType(read.type)) {
    prefix.push({ kind: "exprStmt", expr: read, loc });
    return finish(right);
  }
  return finish({ kind: "nullish", left: read, right, type: read.type, loc });
}

/** The value type of a pure index-signature record shape (no declared
 * fields, not a tuple), or null. */
function pureIndexShapeOf(lowerer: Lowerer, shapeId: string): IrType | null {
  const shape = lowerer.shapes.get(shapeId);
  if (!shape || shape.tuple || shape.fields.length > 0 || !shape.indexValue) return null;
  return shape.indexValue;
}
