import {
  BOOL,
  DYN,
  F64,
  NULL_T,
  type IrExpr,
  type IrStmt,
  type IrType,
  type SrcLoc,
  typeEquals,
} from "../../ir/ir.js";
import { keyedHelperName } from "./stable-names.js";
import { numLit, varRef } from "../../ir/build.js";
import { typeKey } from "../type-mapper.js";
import type { Lowerer } from "./lowerer.js";
import { arrayValueStore } from "./array-values.js";

const add = (left: IrExpr, right: IrExpr, loc: SrcLoc): IrExpr => ({
  kind: "bin",
  op: "+",
  left,
  right,
  type: F64,
  loc,
});
const lt = (left: IrExpr, right: IrExpr, loc: SrcLoc): IrExpr => ({
  kind: "bin",
  op: "<",
  left,
  right,
  type: BOOL,
  loc,
});
const math = (fn: "min" | "max" | "trunc", args: IrExpr[], loc: SrcLoc): IrExpr => ({
  kind: "libCall",
  fn: `math.${fn}`,
  args,
  type: F64,
  loc,
});
const lengthOf = (arr: IrExpr, loc: SrcLoc): IrExpr => ({
  kind: "arrIntrinsic",
  method: "length",
  receiver: arr,
  args: [],
  type: F64,
  loc,
});

function relativeIndex(position: IrExpr, length: IrExpr, loc: SrcLoc): IrExpr {
  const integer: IrExpr = {
    kind: "ternary",
    cond: { kind: "libCall", fn: "num.isNaN", args: [position], type: BOOL, loc },
    then: numLit(0, loc),
    else_: math("trunc", [position], loc),
    type: F64,
    loc,
  };
  return {
    kind: "ternary",
    cond: lt(integer, numLit(0, loc), loc),
    then: math("max", [add(length, integer, loc), numLit(0, loc)], loc),
    else_: math("min", [integer, length], loc),
    type: F64,
    loc,
  };
}

export function lowerArrayFill(
  lowerer: Lowerer,
  receiver: IrExpr,
  value: IrExpr | null,
  writeUndefined: boolean,
  start: IrExpr,
  end: IrExpr,
  arrType: IrType & { kind: "array" },
  loc: SrcLoc,
): IrExpr {
  if (
    writeUndefined ||
    (value !== null && value.type.kind !== "nullT" && typeEquals(value.type, arrType.elem))
  ) {
    if (writeUndefined && value !== null && value.kind !== "unitLit") {
      // Evaluate a side-effectful undefined expression before both bounds.
      const receiverLocal = lowerer.declareHiddenLocal("%fillReceiver", arrType);
      return {
        kind: "seqExpr",
        stmts: [
          { kind: "varDecl", localId: receiverLocal.id, init: receiver, loc },
          { kind: "exprStmt", expr: value, loc },
        ],
        result: {
          kind: "arrIntrinsic",
          method: "fillUndefined",
          receiver: varRef(receiverLocal.id, arrType, loc),
          args: [start, end],
          type: arrType,
          loc,
        },
        type: arrType,
        loc,
      };
    }
    return {
      kind: "arrIntrinsic",
      method: writeUndefined ? "fillUndefined" : "fill",
      receiver,
      args: writeUndefined ? [start, end] : [value!, start, end],
      type: arrType,
      loc,
    };
  }
  const writeNull = value?.type.kind === "nullT";
  // Unit literals have no parameter ABI. Pass a numeric placeholder and
  // synthesize the unit inside the helper's correctly tagged store.
  const discardValue = writeUndefined || writeNull;
  const valueType = discardValue ? F64 : value!.type;
  const key =
    "indexed:fill:" +
    typeKey(arrType.elem) +
    ":" +
    typeKey(valueType) +
    ":" +
    writeUndefined +
    ":" +
    writeNull;
  let name = lowerer.arrHofHelpers.get(key);
  if (!name) {
    name = keyedHelperName(lowerer, "%arr.fill", key);
    lowerer.arrHofHelpers.set(key, name);
    const a = varRef("a.0", arrType, loc);
    const n = varRef("n.0", F64, loc);
    const i = varRef("i.0", F64, loc);
    const body: IrStmt[] = writeUndefined
      ? [{ kind: "arraySetUndefined", arr: a, index: i, loc }]
      : [
          arrayValueStore(
            lowerer,
            a,
            i,
            writeNull
              ? { kind: "unitLit", unit: "null", type: NULL_T, loc }
              : varRef("v.0", valueType, loc),
            arrType.elem,
            loc,
          ),
        ];
    lowerer.liftedFns.push({
      name,
      params: [
        { localId: "a.0", name: "a", type: arrType },
        { localId: "v.0", name: "v", type: valueType },
        { localId: "start.0", name: "start", type: F64 },
        { localId: "end.0", name: "end", type: F64 },
      ],
      returnType: arrType,
      locals: [
        { id: "a.0", name: "a", type: arrType, mutable: true },
        { id: "v.0", name: "v", type: valueType, mutable: false },
        { id: "start.0", name: "start", type: F64, mutable: false },
        { id: "end.0", name: "end", type: F64, mutable: false },
        { id: "n.0", name: "n", type: F64, mutable: false },
        { id: "from.0", name: "from", type: F64, mutable: false },
        { id: "until.0", name: "until", type: F64, mutable: false },
        { id: "i.0", name: "i", type: F64, mutable: true },
      ],
      body: [
        { kind: "varDecl", localId: "n.0", init: lengthOf(a, loc), loc },
        {
          kind: "varDecl",
          localId: "from.0",
          init: relativeIndex(varRef("start.0", F64, loc), n, loc),
          loc,
        },
        {
          kind: "varDecl",
          localId: "until.0",
          init: relativeIndex(varRef("end.0", F64, loc), n, loc),
          loc,
        },
        {
          kind: "for",
          init: { kind: "varDecl", localId: "i.0", init: varRef("from.0", F64, loc), loc },
          cond: lt(i, varRef("until.0", F64, loc), loc),
          update: { kind: "assign", localId: "i.0", value: add(i, numLit(1, loc), loc), loc },
          body,
          loc,
        },
        { kind: "return", value: a, loc },
      ],
      loc,
    });
  }
  const valueArg: IrExpr = discardValue
    ? value === null || value.kind === "unitLit"
      ? numLit(0, loc)
      : {
          kind: "seqExpr",
          stmts: [{ kind: "exprStmt", expr: lowerer.coerceToExpected(value, DYN), loc }],
          result: numLit(0, loc),
          type: F64,
          loc,
        }
    : (value ?? numLit(0, loc));
  return { kind: "call", callee: name, args: [receiver, valueArg, start, end], type: arrType, loc };
}

export function lowerArrayCopyWithin(
  receiver: IrExpr,
  target: IrExpr,
  start: IrExpr,
  end: IrExpr,
  arrType: IrType & { kind: "array" },
  loc: SrcLoc,
): IrExpr {
  return {
    kind: "arrIntrinsic",
    method: "copyWithin",
    receiver,
    args: [target, start, end],
    type: arrType,
    loc,
  };
}
