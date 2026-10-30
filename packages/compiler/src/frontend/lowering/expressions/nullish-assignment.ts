import * as ts from "../../ts7/adapter.js";
import {
  BOOL,
  DYN,
  STRING,
  VOID,
  isUnitType,
  type IrExpr,
  type IrStmt,
  type IrType,
} from "../../../ir/ir.js";
import { varRef } from "../../../ir/build.js";
import { locOf } from "../../program.js";
import type { Lowerer } from "../lowerer.js";
import { arrayValueRead, arrayValueStore } from "../array-values.js";
import { fenceNodeModuleMutation } from "../lower-node-module.js";
import { globalSymbolKey } from "./global-symbols.js";
import { tryLowerExpression } from "./try-lower-expression.js";
import {
  eventAccessorRead,
  eventAccessorWrite,
  isEventWritableAccessor,
} from "../lower-event-target.js";

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
      if (probed?.type.kind === "dyn") {
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
        read = arrayValueRead(lowerer, receiver, key, element, elementLoc);
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
  const value = lowerer.lowerExprExpecting(expr.right, storage);
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
