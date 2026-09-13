import { BOOL, F64, IrExpr, IrStmt, IrType, JSVAL, SrcLoc, UNDEFINED_T, typeEquals } from "../../ir/ir.js";
import { varRef } from "../../ir/build.js";
import type { Lowerer } from "./lowerer.js";
import { dynUndefinedExpr } from "./lowerer.js";

/** The value yielded by a JavaScript array read, independent of its slot's storage type. */
export function arrayValueType(lowerer: Lowerer, elem: IrType): IrType {
  if (elem.kind === "jsval" || elem.kind === "dyn") return elem;
  return elem.kind === "union" ? lowerer.withUndefinedArmOf(elem) ?? elem : lowerer.withUndefinedArm(elem);
}

/** Read one stabilized receiver/index pair. Both a hole and present undefined yield undefined. */
export function arrayValueRead(lowerer: Lowerer, arr: IrExpr, index: IrExpr, elem: IrType, loc: SrcLoc): IrExpr {
  const type = arrayValueType(lowerer, elem);
  const read: IrExpr = { kind: "arrayGet", arr, index, type: elem, loc };
  const missing: IrExpr = type.kind === "jsval"
    ? { kind: "jsOp", op: "undefLit", args: [], type: JSVAL, loc }
    : type.kind === "dyn" ? dynUndefinedExpr(loc) : lowerer.wrappedUndefined(type, loc)!;
  return {
    kind: "ternary",
    cond: {
      kind: "bin", op: "===",
      left: { kind: "arrayState", arr, index, type: F64, loc },
      right: { kind: "numLit", value: 1, type: F64, loc },
      type: BOOL, loc,
    },
    then: typeEquals(elem, type) ? read : lowerer.coerceToExpected(read, type),
    else_: missing,
    type, loc,
  };
}

/** Store a stabilized value without changing the array's element ABI. */
export function arrayValueStore(lowerer: Lowerer, arr: IrExpr, index: IrExpr, value: IrExpr, elem: IrType, loc: SrcLoc): IrStmt {
  if (typeEquals(value.type, elem)) return { kind: "arraySet", arr, index, value, loc };
  if (value.type.kind === "union" && lowerer.armTag(value.type.unionId, UNDEFINED_T) >= 0) {
    // The tag test and the VALUE arm extraction both consume the value. Keep
    // an arbitrary expression (especially an array read or call) single
    // evaluated before branching; this also gives the native emitters one
    // owned union temporary to release on every path.
    const unionId = value.type.unionId;
    let stable = value;
    let prefix: IrStmt[] = [];
    if (value.kind !== "varRef") {
      const temp = lowerer.declareHiddenLocal("%arrayValue", value.type);
      prefix = [{ kind: "varDecl", localId: temp.id, init: value, loc }];
      stable = varRef(temp.id, temp.type, loc);
    }
    const write: IrStmt = {
      kind: "if",
      cond: { kind: "unionIsTag", unionId, tag: lowerer.armTag(unionId, UNDEFINED_T), negated: false, value: stable, type: BOOL, loc },
      then: [{ kind: "arraySetUndefined", arr, index, loc }],
      else_: [{ kind: "arraySet", arr, index, value: lowerer.coerceToExpected(stable, elem), loc }],
      loc,
    };
    if (prefix.length > 0) return { kind: "block", body: [...prefix, write], loc };
    return write;
  }
  return { kind: "arraySet", arr, index, value: lowerer.coerceToExpected(value, elem), loc };
}
