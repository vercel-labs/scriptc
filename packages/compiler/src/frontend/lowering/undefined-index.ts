import * as ts from "../ts7/adapter.js";
import { BOOL, DYN, F64, UNDEFINED_T, type IrExpr, type IrStmt, type SrcLoc } from "../../ir/ir.js";
import { varRef } from "../../ir/build.js";
import type { Lowerer } from "./lowerer.js";
import { lowerOptionalNumber } from "./lower-exprs.js";
import { keyedHelperName } from "./stable-names.js";

/** An element index the checker types as a number can be undefined at run
 * time (an element read from a holey array). JavaScript then names the
 * property "undefined", not "NaN". */

/** The array element index `operand` (the lowered index of `node`) as a
 * number. An undefined index is the runtime's "undefined" key
 * (`array.undefinedKey`, a NaN the array's property table spells
 * "undefined"); other values convert with ToNumber, as lowerOptionalNumber
 * does. */
export function lowerOptionalIndex(
  lowerer: Lowerer,
  operand: IrExpr,
  loc: SrcLoc,
  node: ts.Expression,
): IrExpr {
  const split = splitUndefinedIndex(lowerer, operand, node, loc);
  if (split === null) return lowerOptionalNumber(lowerer, operand, loc, node);
  return {
    kind: "seqExpr",
    stmts: split.stmts,
    result: {
      kind: "ternary",
      cond: split.isUndefined,
      then: { kind: "libCall", fn: "array.undefinedKey", args: [], type: F64, loc },
      else_: split.index,
      type: F64,
      loc,
    },
    type: F64,
    loc,
  };
}

/** A typed-array element index that can be undefined: `stmts` evaluate it
 * once, `isUndefined` tests it, and `index` is the number a defined index
 * converts to. */
export interface SplitIndex {
  stmts: IrStmt[];
  isUndefined: IrExpr;
  index: IrExpr;
}

/** Splits `raw`, the lowered index of `node`, when it is a number that can
 * be undefined; null otherwise. */
export function splitUndefinedIndex(
  lowerer: Lowerer,
  raw: IrExpr,
  node: ts.Expression,
  loc: SrcLoc,
): SplitIndex | null {
  if (raw.type.kind !== "union") return null;
  const undefinedTag = lowerer.armTag(raw.type.unionId, UNDEFINED_T);
  if (undefinedTag < 0) return null;
  const local = lowerer.declareHiddenLocal("%elementIndex", raw.type);
  const stable = varRef(local.id, raw.type, loc);
  const index = lowerOptionalNumber(lowerer, stable, loc, node);
  if (index.type.kind !== "f64") return null;
  return {
    stmts: [{ kind: "varDecl", localId: local.id, init: raw, loc }],
    isUndefined: {
      kind: "unionIsTag",
      unionId: raw.type.unionId,
      tag: undefinedTag,
      negated: false,
      value: stable,
      type: BOOL,
      loc,
    },
    index,
  };
}

/** A typed array has no property named "undefined" to store into: the
 * store throws the catchable SC1090 error when it runs. A call, so that it
 * can sit among an expression's statements. */
export function undefinedTypedArrayKeyFence(lowerer: Lowerer, node: ts.Node, loc: SrcLoc): IrStmt {
  const line = ts.getLineAndCharacterOfPosition(ts.getSourceFileOfNode(node), loc.start).line + 1;
  const message = `typed array properties named 'undefined' (an element index that is undefined) are not supported yet [SC1090 at ${loc.file}:${line}]`;
  const key = `index.undefinedFence:${message}`;
  let name = lowerer.arrHofHelpers.get(key);
  if (name === undefined) {
    name = keyedHelperName(lowerer, "%index.undefinedFence", key);
    lowerer.arrHofHelpers.set(key, name);
    lowerer.liftedFns.push({
      name,
      params: [],
      locals: [],
      returnType: DYN,
      body: [{ kind: "runtimeFence", code: "SC1090", message, loc }],
      loc,
    });
  }
  return { kind: "exprStmt", expr: { kind: "call", callee: name, args: [], type: DYN, loc }, loc };
}
