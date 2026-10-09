import { InternalCompilerError } from "../../errors.js";
import { dynUndefinedExpr, varRef } from "../../ir/build.js";
import {
  BOOL,
  F64,
  type IrExpr,
  type IrStmt,
  type IrType,
  JSVAL,
  type SrcLoc,
  UNDEFINED_T,
  typeEquals,
  typeKey,
  unionContainerArmsOk,
} from "../../ir/ir.js";
import type { Lowerer } from "./lowerer.js";
import type * as ts from "../ts7/adapter.js";

/** Test whether one array index contains a value rather than a hole. */
export function arrayIndexPresent(arr: IrExpr, index: IrExpr, loc: SrcLoc): IrExpr {
  return {
    kind: "arrayHas",
    arr,
    index,
    type: BOOL,
    loc,
  };
}

/** Test the conventional `a.0[i.0]` slot used by synthesized array loops. */
export function currentArrayIndexPresent(arrType: IrType, loc: SrcLoc): IrExpr {
  return arrayIndexPresent(varRef("a.0", arrType, loc), varRef("i.0", F64, loc), loc);
}

/** The value yielded by a JavaScript array read, independent of its slot's storage type. */
export function arrayValueType(lowerer: Lowerer, elem: IrType): IrType {
  if (elem.kind === "jsval" || elem.kind === "dyn") return elem;
  return elem.kind === "union"
    ? (lowerer.withUndefinedArmOf(elem) ?? elem)
    : lowerer.withUndefinedArm(elem);
}

/** Read one stabilized receiver/index pair. Both a hole and present undefined yield undefined. */
export function arrayValueRead(
  lowerer: Lowerer,
  arr: IrExpr,
  index: IrExpr,
  elem: IrType,
  loc: SrcLoc,
): IrExpr {
  const type = arrayValueType(lowerer, elem);
  const read: IrExpr = { kind: "arrayGet", arr, index, type: elem, loc };
  const missing: IrExpr =
    type.kind === "jsval"
      ? { kind: "jsOp", op: "undefLit", args: [], type: JSVAL, loc }
      : type.kind === "dyn"
        ? dynUndefinedExpr(loc)
        : lowerer.wrappedUndefined(type, loc)!;
  return {
    kind: "ternary",
    cond: {
      kind: "bin",
      op: "===",
      left: { kind: "arrayState", arr, index, type: F64, loc },
      right: { kind: "numLit", value: 1, type: F64, loc },
      type: BOOL,
      loc,
    },
    then: typeEquals(elem, type) ? read : lowerer.coerceToExpected(read, type),
    else_: missing,
    type,
    loc,
  };
}

/** Read a stabilized union of native arrays without copying either the
 * receiver or its elements. Every arm contributes its missing-value case. */
export function unionArrayValueRead(
  lowerer: Lowerer,
  value: IrExpr,
  index: IrExpr,
  loc: SrcLoc,
): IrExpr | null {
  if (value.type.kind !== "union") return null;
  const unionId = value.type.unionId;
  const arms = lowerer.unions.get(unionId)?.arms;
  if (!arms?.length) return null;
  // Keep the collection's IrType union layout and narrow each element at
  // its use; an inferred array predicate changes the collection's ABI.
  for (const arm of arms) if (arm.kind !== "array") return null;
  const answers = new Map<string, IrType>();
  for (const arm of arms) {
    if (arm.kind !== "array") return null;
    const answer = arrayValueType(lowerer, arm.elem);
    const parts = answer.kind === "union" ? lowerer.unions.get(answer.unionId)!.arms : [answer];
    for (const part of parts) answers.set(typeKey(part), part);
  }
  const joined = [...answers.values()].sort((a, b) => (typeKey(a) < typeKey(b) ? -1 : 1));
  if (
    joined.length > 1 &&
    (!unionContainerArmsOk(joined) ||
      joined.some(
        (arm) =>
          arm.kind === "dyn" ||
          arm.kind === "jsval" ||
          arm.kind === "generator" ||
          arm.kind === "caught",
      ))
  )
    return null;
  const type: IrType =
    joined.length === 1 ? joined[0]! : { kind: "union", unionId: lowerer.unions.intern(joined) };
  let result: IrExpr | null = null;
  for (let tag = arms.length - 1; tag >= 0; tag--) {
    const arm = arms[tag]!;
    if (arm.kind !== "array") return null;
    const receiver: IrExpr = { kind: "unionNarrow", unionId, tag, value, type: arm, loc };
    const read = lowerer.coerceToExpected(
      arrayValueRead(lowerer, receiver, index, arm.elem, loc),
      type,
    );
    result =
      result === null
        ? read
        : {
            kind: "ternary",
            cond: { kind: "unionIsTag", unionId, tag, value, negated: false, type: BOOL, loc },
            then: read,
            else_: result,
            type,
            loc,
          };
  }
  return result;
}

/** Store a stabilized value without changing the array's element ABI. */
export function arrayValueStore(
  lowerer: Lowerer,
  arr: IrExpr,
  index: IrExpr,
  value: IrExpr,
  elem: IrType,
  loc: SrcLoc,
): IrStmt {
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
      cond: {
        kind: "unionIsTag",
        unionId,
        tag: lowerer.armTag(unionId, UNDEFINED_T),
        negated: false,
        value: stable,
        type: BOOL,
        loc,
      },
      then: [{ kind: "arraySetUndefined", arr, index, loc }],
      else_: [{ kind: "arraySet", arr, index, value: lowerer.coerceToExpected(stable, elem), loc }],
      loc,
    };
    if (prefix.length > 0) return { kind: "block", body: [...prefix, write], loc };
    return write;
  }
  return { kind: "arraySet", arr, index, value: lowerer.coerceToExpected(value, elem), loc };
}

/** An ordinary indexed read: values retain their element type, while
 * holes, missing properties, and present undefined yield undefined. */
export function lowerSafeIndexRead(
  lowerer: Lowerer,
  arr: IrExpr,
  index: IrExpr,
  loc: SrcLoc,
): IrExpr | null {
  if (arr.type.kind !== "array") throw new InternalCompilerError("indexed read requires an array");
  const elem = arr.type.elem;
  if (elem.kind === "void") return null;
  const resultT = arrayValueType(lowerer, elem);
  const key = `idxOr:${typeKey(elem)}`;
  let name = lowerer.arrHofHelpers.get(key);
  if (!name) {
    name = `%arr.idxOr.${lowerer.arrHofHelpers.size}`;
    lowerer.arrHofHelpers.set(key, name);
    const arrT = arr.type;
    lowerer.liftedFns.push({
      name,
      params: [
        { localId: "a.0", name: "a", type: arrT },
        { localId: "i.0", name: "i", type: F64 },
      ],
      returnType: resultT,
      locals: [
        { id: "a.0", name: "a", type: arrT, mutable: false },
        { id: "i.0", name: "i", type: F64, mutable: false },
      ],
      body: [
        {
          kind: "return",
          value: arrayValueRead(
            lowerer,
            varRef("a.0", arrT, loc),
            varRef("i.0", F64, loc),
            elem,
            loc,
          ),
          loc,
        },
      ],
      loc,
    });
  }
  return { kind: "call", callee: name, args: [arr, index], type: resultT, loc };
}

/** Fuse only our own f64-array read helper with immediate ToNumber.
 * Reuse its arguments verbatim so the receiver and index still evaluate
 * exactly once, in order, before the read. Do not specialize user calls,
 * union-element arrays, or optional values stored in locals. */
export function tryLowerNumericIndexRead(
  lowerer: Lowerer,
  operand: IrExpr,
  loc: SrcLoc,
): IrExpr | null {
  if (
    operand.kind !== "call" ||
    operand.callee !== lowerer.arrHofHelpers.get(`idxOr:${typeKey(F64)}`)
  )
    return null;
  const [arr, index] = operand.args;
  if (
    operand.args.length !== 2 ||
    arr?.type.kind !== "array" ||
    arr.type.elem.kind !== "f64" ||
    index?.type.kind !== "f64"
  )
    return null;
  // The intrinsic owns the evaluated receiver through index evaluation,
  // then borrows it for one slot lookup. No extra helper parameter or
  // separate state/getter expressions need to retain the array again.
  return {
    kind: "arrIntrinsic",
    method: "getNumber",
    receiver: arr,
    args: [index],
    type: F64,
    loc,
  };
}

/** Fuse our own scalar-array read helper with an immediate ToBoolean, so a
 * condition such as `if (flags[i])` never boxes `T | undefined`. Numbers
 * reuse getNumber: a missing slot reads as NaN, which is falsy exactly like
 * undefined. Booleans test the slot state and then read the value; both
 * operands are evaluated twice, so they must be plain bindings/literals
 * (the same proof the indexed-comparison fusion uses). Returns a BOOL
 * expression with the original evaluation order, or null. */
export function tryLowerIndexTruthiness(
  lowerer: Lowerer,
  operand: IrExpr,
  node: ts.Expression,
  loc: SrcLoc,
): IrExpr | null {
  if (operand.kind !== "call" || operand.args.length !== 2) return null;
  const [arr, index] = operand.args;
  if (arr?.type.kind !== "array" || index?.type.kind !== "f64") return null;
  const elem = arr.type.elem;
  if (elem.kind !== "f64" && elem.kind !== "bool") return null;
  if (operand.callee !== lowerer.arrHofHelpers.get(`idxOr:${typeKey(elem)}`)) return null;
  if (elem.kind === "f64") {
    const number = tryLowerNumericIndexRead(lowerer, operand, loc);
    return number ? lowerer.ensureBool(number, node) : null;
  }
  return tryFuseIndexRead(lowerer, operand, BOOL, (read) => read, {
    kind: "boolLit",
    value: false,
    type: BOOL,
    loc,
  });
}

/** Fuse our own non-union array read helper with its single consumer:
 * `present` receives the strict element read, `missing` answers holes,
 * present undefined, and absent indices. The receiver and index evaluate
 * once more than in the helper form, so both must be plain bindings or
 * numeric literals (nothing can run between the state test and the read). */
export function tryFuseIndexRead(
  lowerer: Lowerer,
  operand: IrExpr,
  type: IrType,
  present: (read: IrExpr) => IrExpr,
  missing: IrExpr,
): IrExpr | null {
  if (operand.kind !== "call" || operand.args.length !== 2) return null;
  const [arr, index] = operand.args;
  if (arr?.type.kind !== "array" || index?.type.kind !== "f64") return null;
  const elem = arr.type.elem;
  if (elem.kind === "union" || elem.kind === "void") return null;
  if (operand.callee !== lowerer.arrHofHelpers.get(`idxOr:${typeKey(elem)}`)) return null;
  if (arr.kind !== "varRef" || (index.kind !== "varRef" && index.kind !== "numLit")) return null;
  const loc = operand.loc;
  return {
    kind: "ternary",
    cond: {
      kind: "bin",
      op: "===",
      left: { kind: "arrayState", arr, index, type: F64, loc },
      right: { kind: "numLit", value: 1, type: F64, loc },
      type: BOOL,
      loc,
    },
    then: present({ kind: "arrayGet", arr, index, type: elem, loc }),
    else_: missing,
    type,
    loc,
  };
}
