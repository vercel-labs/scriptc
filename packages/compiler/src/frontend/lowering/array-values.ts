import { InternalCompilerError } from "../../errors.js";
import { helperLoc, varRef } from "../../ir/build.js";
import {
  BOOL,
  F64,
  type IrExpr,
  type IrStmt,
  type IrType,
  isIntegerBytesElem,
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
  if (elem.kind === "dyn") return elem;
  return elem.kind === "union"
    ? (lowerer.withUndefinedArmOf(elem) ?? elem)
    : lowerer.withUndefinedArm(elem);
}

/** ToNumber of one stabilized `number[]` element read: a hole, a present
 * undefined and a missing index all read as NaN, which is
 * ToNumber(undefined). Numeric updates use it in place of the optional
 * element value. */
export function arrayNumberRead(arr: IrExpr, index: IrExpr, loc: SrcLoc): IrExpr {
  return { kind: "arrayPropertyRead", arr, index, consume: "number", type: F64, loc };
}

/** Read one stabilized receiver/index pair. Both a hole and present undefined yield undefined. */
export function arrayValueRead(
  lowerer: Lowerer,
  arr: IrExpr,
  index: IrExpr,
  elem: IrType,
  loc: SrcLoc,
): IrExpr {
  return {
    kind: "arrayPropertyRead",
    arr,
    index,
    consume: "value",
    type: arrayValueType(lowerer, elem),
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
      joined.some((arm) => arm.kind === "dyn" || arm.kind === "generator" || arm.kind === "caught"))
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
    const at = helperLoc(loc);
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
          value: arrayValueRead(lowerer, varRef("a.0", arrT, at), varRef("i.0", F64, at), elem, at),
          loc: at,
        },
      ],
      loc: at,
    });
  }
  return { kind: "call", callee: name, args: [arr, index], type: resultT, loc };
}

/** An ordinary typed-array element read `t[i]`: like Node, an index that
 * is not an integer in [0, length) answers undefined (the storage is
 * never touched out of bounds). The result is `number | undefined`, the
 * same optional shape ordinary array reads carry; numeric consumers fuse
 * back to the plain element read (tryLowerNumericIndexRead), where the
 * invalid case reads as NaN — exactly ToNumber(undefined). */
export function lowerSafeBytesRead(
  lowerer: Lowerer,
  receiver: IrExpr,
  index: IrExpr,
  loc: SrcLoc,
): IrExpr {
  const bytesT = receiver.type;
  if (bytesT.kind !== "bytes") throw new InternalCompilerError("typed read requires bytes");
  const resultT = lowerer.withUndefinedArm(F64);
  const key = `bytesIdxOr:${typeKey(bytesT)}`;
  let name = lowerer.arrHofHelpers.get(key);
  if (!name) {
    const at = helperLoc(loc);
    name = `%bytes.idxOr.${lowerer.arrHofHelpers.size}`;
    lowerer.arrHofHelpers.set(key, name);
    const b = varRef("b.0", bytesT, at);
    const i = varRef("i.0", F64, at);
    const cmp = (op: "<" | ">=" | "===", left: IrExpr, right: IrExpr): IrExpr => ({
      kind: "bin",
      op,
      left,
      right,
      type: BOOL,
      loc: at,
    });
    const inRange: IrExpr = {
      kind: "logical",
      op: "&&",
      left: cmp(">=", i, { kind: "numLit", value: 0, type: F64, loc: at }),
      right: {
        kind: "logical",
        op: "&&",
        left: cmp("<", i, {
          kind: "bytesIntrinsic",
          method: "length",
          receiver: b,
          args: [],
          type: F64,
          loc: at,
        }),
        right: cmp("===", { kind: "libCall", fn: "math.trunc", args: [i], type: F64, loc: at }, i),
        type: BOOL,
        loc: at,
      },
      type: BOOL,
      loc: at,
    };
    const read: IrExpr = {
      kind: "bytesIntrinsic",
      method: "get",
      receiver: b,
      args: [i],
      type: F64,
      loc: at,
    };
    if (isIntegerBytesElem(bytesT.elem)) {
      // An integer element is never NaN, so the NaN-for-invalid read
      // decides presence with one inline index check (no separate range
      // and integrality tests).
      const v = varRef("v.0", F64, at);
      lowerer.liftedFns.push({
        name,
        params: [
          { localId: "b.0", name: "b", type: bytesT },
          { localId: "i.0", name: "i", type: F64 },
        ],
        returnType: resultT,
        locals: [
          { id: "b.0", name: "b", type: bytesT, mutable: false },
          { id: "i.0", name: "i", type: F64, mutable: false },
          { id: "v.0", name: "v", type: F64, mutable: false },
        ],
        body: [
          { kind: "varDecl", localId: "v.0", init: { ...read, invalidNaN: true }, loc: at },
          {
            kind: "return",
            value: {
              kind: "ternary",
              cond: { kind: "libCall", fn: "num.isNaN", args: [v], type: BOOL, loc: at },
              then: lowerer.wrappedUndefined(resultT, at)!,
              else_: lowerer.coerceToExpected(v, resultT),
              type: resultT,
              loc: at,
            },
            loc: at,
          },
        ],
        loc: at,
      });
      return { kind: "call", callee: name, args: [receiver, index], type: resultT, loc };
    }
    lowerer.liftedFns.push({
      name,
      params: [
        { localId: "b.0", name: "b", type: bytesT },
        { localId: "i.0", name: "i", type: F64 },
      ],
      returnType: resultT,
      locals: [
        { id: "b.0", name: "b", type: bytesT, mutable: false },
        { id: "i.0", name: "i", type: F64, mutable: false },
      ],
      body: [
        {
          kind: "return",
          value: {
            kind: "ternary",
            cond: inRange,
            then: lowerer.coerceToExpected(read, resultT),
            else_: lowerer.wrappedUndefined(resultT, at)!,
            type: resultT,
            loc: at,
          },
          loc: at,
        },
      ],
      loc: at,
    });
  }
  return { kind: "call", callee: name, args: [receiver, index], type: resultT, loc };
}

/** Whether `operand` is a call of the typed-array read helper. */
function isBytesReadHelperCall(lowerer: Lowerer, operand: IrExpr): boolean {
  if (operand.kind !== "call" || operand.args.length !== 2) return false;
  const receiver = operand.args[0]!;
  return (
    receiver.type.kind === "bytes" &&
    operand.args[1]!.type.kind === "f64" &&
    operand.callee === lowerer.arrHofHelpers.get(`bytesIdxOr:${typeKey(receiver.type)}`)
  );
}

/** Fuse only our own f64-array read helper with immediate ToNumber.
 * Reuse its arguments verbatim so the receiver and index still evaluate
 * exactly once, in order, before the read. Do not specialize user calls,
 * union-element arrays, or optional values stored in locals. */
export function tryLowerNumericIndexRead(
  lowerer: Lowerer,
  operand: IrExpr,
  loc: SrcLoc,
  constructor = false,
): IrExpr | null {
  if (operand.kind === "call" && isBytesReadHelperCall(lowerer, operand)) {
    // The plain element read: an invalid index reads as NaN, which is
    // ToNumber(undefined).
    const [receiver, index] = operand.args;
    return {
      kind: "bytesIntrinsic",
      method: "get",
      receiver: receiver!,
      args: [index!],
      type: F64,
      loc,
      invalidNaN: true,
    };
  }
  if (operand.kind !== "call" || operand.args.length !== 2) return null;
  const [arr, index] = operand.args;
  if (arr?.type.kind !== "array" || index?.type.kind !== "f64") return null;
  const elem = arr.type.elem;
  if (elem.kind !== "f64" && elem.kind !== "string" && elem.kind !== "bool") return null;
  if (operand.callee !== lowerer.arrHofHelpers.get(`idxOr:${typeKey(elem)}`)) return null;
  return {
    kind: "arrayPropertyRead",
    arr,
    index,
    consume: constructor ? "numberConstructor" : "number",
    type: F64,
    loc,
  };
}

/** Fuse our own typed-array read helper with strict equality against a
 * plain number: `t[i] === b` is false when `t[i]` is undefined, and the
 * NaN-for-invalid read is never equal to anything either, so the plain
 * read answers exactly (`!==` is the negation). The other operand must
 * lower to a double that never stands for undefined: a union keeps the
 * box (undefined === undefined is true), and so does a NaN-coded value
 * (nan-coded-reads.ts), which encodes undefined as NaN. The read keeps
 * its arguments, so evaluation order is unchanged. */
export function tryLowerBytesReadNumberEquality(
  lowerer: Lowerer,
  operand: IrExpr,
  other: IrExpr,
  otherNode: ts.Expression,
): IrExpr | null {
  if (other.type.kind !== "f64" || !isBytesReadHelperCall(lowerer, operand)) return null;
  if (lowerer.nanCodedReads?.mayStandForUndefined(otherNode) === true) return null;
  return tryLowerNumericIndexRead(lowerer, operand, operand.loc);
}

/** Consume one property Get with ToBoolean. Promoted getters may return a
 * different runtime type, so truthiness must not pass through ToNumber. */
export function tryLowerIndexTruthiness(
  lowerer: Lowerer,
  operand: IrExpr,
  node: ts.Expression,
  loc: SrcLoc,
): IrExpr | null {
  if (operand.kind !== "call" || operand.args.length !== 2) return null;
  if (isBytesReadHelperCall(lowerer, operand)) {
    // NaN (the invalid read) is falsy exactly like undefined.
    const number = tryLowerNumericIndexRead(lowerer, operand, loc);
    return number ? lowerer.ensureBool(number, node) : null;
  }
  const [arr, index] = operand.args;
  if (arr?.type.kind !== "array" || index?.type.kind !== "f64") return null;
  const elem = arr.type.elem;
  if (elem.kind !== "f64" && elem.kind !== "bool") return null;
  if (operand.callee !== lowerer.arrHofHelpers.get(`idxOr:${typeKey(elem)}`)) return null;
  return { kind: "arrayPropertyRead", arr, index, consume: "boolean", type: BOOL, loc };
}
