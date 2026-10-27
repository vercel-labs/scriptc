import type * as ts from "../ts7/adapter.js";
import {
  BOOL,
  DYN,
  F64,
  STRING,
  isUnitType,
  type IrExpr,
  type IrStmt,
  type IrType,
  type SrcLoc,
} from "../../ir/ir.js";
import { numLit, varRef } from "../../ir/build.js";
import type { Lowerer } from "./lowerer.js";

/** A number-keyed string property read whose declared result includes
 * undefined. Unlike charAt, property lookup does not truncate fractions or
 * convert NaN to zero. Capture both operands before testing the index: even
 * a plain receiver variable can be reassigned while evaluating the key. */
export function lowerOptionalStringIndex(
  lowerer: Lowerer,
  receiver: IrExpr,
  index: IrExpr,
  type: IrType,
  loc: SrcLoc,
): IrExpr {
  const textLocal = lowerer.declareHiddenLocal("%indexedString", STRING);
  const indexLocal = lowerer.declareHiddenLocal("%stringIndex", F64);
  const text = varRef(textLocal.id, STRING, loc);
  const key = varRef(indexLocal.id, F64, loc);
  const inBounds: IrExpr = {
    kind: "logical",
    op: "&&",
    left: { kind: "bin", op: ">=", left: key, right: numLit(0, loc), type: BOOL, loc },
    right: {
      kind: "bin",
      op: "<",
      left: key,
      right: { kind: "strIntrinsic", method: "length", receiver: text, args: [], type: F64, loc },
      type: BOOL,
      loc,
    },
    type: BOOL,
    loc,
  };
  const integral: IrExpr = {
    kind: "bin",
    op: "===",
    left: key,
    right: { kind: "libCall", fn: "math.floor", args: [key], type: F64, loc },
    type: BOOL,
    loc,
  };
  const read: IrExpr = {
    kind: "strIntrinsic",
    method: "charAt",
    receiver: text,
    args: [key],
    type: STRING,
    loc,
  };
  return {
    kind: "seqExpr",
    stmts: [
      { kind: "varDecl", localId: textLocal.id, init: receiver, loc },
      { kind: "varDecl", localId: indexLocal.id, init: index, loc },
    ],
    result: {
      kind: "ternary",
      cond: { kind: "logical", op: "&&", left: inBounds, right: integral, type: BOOL, loc },
      then: lowerer.coerceToExpected(read, type),
      else_: lowerer.wrappedUndefined(type, loc)!,
      type,
      loc,
    },
    type,
    loc,
  };
}

/** A number-keyed read of a receiver the checker narrowed to string whose
 * stored value is still a union: an array-derived binding keeps its
 * undefined arm (`const t = tokens[i]`), and a `typeof t === "string"`
 * guard narrows the checker's type without retagging the storage. Both
 * operands are captured first, as for a plain string receiver. A unit arm
 * performs the checked-dynamic keyed read on that unit, which throws Node's
 * "Cannot read properties of undefined (reading '<key>')"; another value
 * arm, which the checker has excluded, fails the checked extraction; the
 * string arm reads like any string receiver. Null when the union has no
 * string arm. */
export function lowerUnionStringIndex(
  lowerer: Lowerer,
  receiver: IrExpr,
  index: IrExpr,
  keyNode: ts.Node,
  type: IrType,
  loc: SrcLoc,
): IrExpr | null {
  if (receiver.type.kind !== "union") return null;
  const unionType = receiver.type;
  const unionId = unionType.unionId;
  const def = lowerer.unions.get(unionId);
  const stringTag = lowerer.armTag(unionId, STRING);
  if (!def || stringTag < 0) return null;
  const receiverLocal = lowerer.declareHiddenLocal("%indexedUnion", unionType);
  const indexLocal = lowerer.declareHiddenLocal("%unionStringIndex", F64);
  const stored = (): IrExpr => varRef(receiverLocal.id, unionType, loc);
  const key = (): IrExpr => varRef(indexLocal.id, F64, loc);
  const stmts: IrStmt[] = [
    { kind: "varDecl", localId: receiverLocal.id, init: receiver, loc },
    { kind: "varDecl", localId: indexLocal.id, init: index, loc },
  ];
  let text: IrExpr;
  if (def.arms.every((arm, tag) => tag === stringTag || isUnitType(arm))) {
    text = { kind: "unionNarrow", unionId, tag: stringTag, value: stored(), type: STRING, loc };
  } else {
    const helper = lowerer.narrowedArmHelper(unionId, STRING, loc);
    if (helper === null) return null;
    text = lowerer.checkedNarrowCall(helper, stored(), STRING, loc);
  }
  let result = lowerOptionalStringIndex(lowerer, text, key(), type, loc);
  for (let tag = def.arms.length - 1; tag >= 0; tag--) {
    const arm = def.arms[tag]!;
    if (!isUnitType(arm)) continue;
    const unit = arm.kind === "nullT" ? "null" : "undefined";
    const thrown: IrExpr = {
      kind: "dynCheck",
      value: {
        kind: "dynKeyGet",
        value: {
          kind: "dynFrom",
          value: { kind: "unitLit", unit, type: arm, loc },
          type: DYN,
          loc,
        },
        key: lowerer.ensureString(key(), keyNode),
        type: DYN,
        loc,
      },
      type: STRING,
      loc,
    };
    result = {
      kind: "ternary",
      cond: { kind: "unionIsTag", unionId, tag, negated: false, value: stored(), type: BOOL, loc },
      then: lowerer.coerceToExpected(thrown, type),
      else_: result,
      type,
      loc,
    };
  }
  return { kind: "seqExpr", stmts, result, type, loc };
}
