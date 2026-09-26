import { BOOL, F64, type IrExpr, type IrStmt, type IrType, type SrcLoc } from "../../ir/ir.js";
import { numLit, varRef } from "../../ir/build.js";
import { typeKey } from "../type-mapper.js";
import type { Lowerer } from "./lowerer.js";
import { arrayValueStore } from "./array-values.js";

const add = (left: IrExpr, right: IrExpr, loc: SrcLoc): IrExpr => ({ kind: "bin", op: "+", left, right, type: F64, loc });
const sub = (left: IrExpr, right: IrExpr, loc: SrcLoc): IrExpr => ({ kind: "bin", op: "-", left, right, type: F64, loc });
const lt = (left: IrExpr, right: IrExpr, loc: SrcLoc): IrExpr => ({ kind: "bin", op: "<", left, right, type: BOOL, loc });
const eq = (left: IrExpr, right: IrExpr, loc: SrcLoc): IrExpr => ({ kind: "bin", op: "===", left, right, type: BOOL, loc });
const math = (fn: "min" | "max" | "trunc", args: IrExpr[], loc: SrcLoc): IrExpr => ({ kind: "libCall", fn: `math.${fn}`, args, type: F64, loc });
const lengthOf = (arr: IrExpr, loc: SrcLoc): IrExpr => ({ kind: "arrIntrinsic", method: "length", receiver: arr, args: [], type: F64, loc });

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
  const valueType = writeUndefined ? F64 : value!.type;
  const key = "indexed:fill:" + typeKey(arrType.elem) + ":" + typeKey(valueType) + ":" + writeUndefined;
  let name = lowerer.arrHofHelpers.get(key);
  if (!name) {
    name = "%arr.fill." + lowerer.arrHofHelpers.size;
    lowerer.arrHofHelpers.set(key, name);
    const a = varRef("a.0", arrType, loc);
    const n = varRef("n.0", F64, loc);
    const i = varRef("i.0", F64, loc);
    const body: IrStmt[] = writeUndefined
      ? [{ kind: "arraySetUndefined", arr: a, index: i, loc }]
      : [arrayValueStore(lowerer, a, i, varRef("v.0", valueType, loc), arrType.elem, loc)];
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
        { kind: "varDecl", localId: "from.0", init: relativeIndex(varRef("start.0", F64, loc), n, loc), loc },
        { kind: "varDecl", localId: "until.0", init: relativeIndex(varRef("end.0", F64, loc), n, loc), loc },
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
  const valueArg: IrExpr = value && writeUndefined
    ? { kind: "seqExpr", stmts: [{ kind: "exprStmt", expr: value, loc }], result: numLit(0, loc), type: F64, loc }
    : value ?? numLit(0, loc);
  return { kind: "call", callee: name, args: [receiver, valueArg, start, end], type: arrType, loc };
}

export function lowerArrayCopyWithin(
  lowerer: Lowerer,
  receiver: IrExpr,
  target: IrExpr,
  start: IrExpr,
  end: IrExpr,
  arrType: IrType & { kind: "array" },
  loc: SrcLoc,
): IrExpr {
  const key = "indexed:copyWithin:" + typeKey(arrType.elem);
  let name = lowerer.arrHofHelpers.get(key);
  if (!name) {
    name = "%arr.copyWithin." + lowerer.arrHofHelpers.size;
    lowerer.arrHofHelpers.set(key, name);
    const a = varRef("a.0", arrType, loc);
    const n = varRef("n.0", F64, loc);
    const dst = varRef("targetIndex.0", F64, loc);
    const src = varRef("startIndex.0", F64, loc);
    const last = varRef("endIndex.0", F64, loc);
    const remaining = varRef("count.0", F64, loc);
    const step = varRef("direction.0", F64, loc);
    const from = varRef("from.0", F64, loc);
    const to = varRef("to.0", F64, loc);
    const state = varRef("state.0", F64, loc);
    const backwards: IrExpr = {
      kind: "logical", op: "&&", left: lt(src, dst, loc),
      right: lt(dst, add(src, remaining, loc), loc), type: BOOL, loc,
    };
    const offset: IrExpr = {
      kind: "ternary", cond: lt(step, numLit(0, loc), loc),
      then: sub(remaining, numLit(1, loc), loc), else_: numLit(0, loc), type: F64, loc,
    };
    lowerer.liftedFns.push({
      name,
      params: [
        { localId: "a.0", name: "a", type: arrType },
        { localId: "target.0", name: "target", type: F64 },
        { localId: "start.0", name: "start", type: F64 },
        { localId: "end.0", name: "end", type: F64 },
      ],
      returnType: arrType,
      locals: [
        { id: "a.0", name: "a", type: arrType, mutable: true },
        { id: "target.0", name: "target", type: F64, mutable: false },
        { id: "start.0", name: "start", type: F64, mutable: false },
        { id: "end.0", name: "end", type: F64, mutable: false },
        { id: "n.0", name: "n", type: F64, mutable: false },
        { id: "targetIndex.0", name: "targetIndex", type: F64, mutable: false },
        { id: "startIndex.0", name: "startIndex", type: F64, mutable: false },
        { id: "endIndex.0", name: "endIndex", type: F64, mutable: false },
        { id: "count.0", name: "count", type: F64, mutable: true },
        { id: "direction.0", name: "direction", type: F64, mutable: false },
        { id: "from.0", name: "from", type: F64, mutable: true },
        { id: "to.0", name: "to", type: F64, mutable: true },
        { id: "state.0", name: "state", type: F64, mutable: false },
        { id: "value.0", name: "value", type: arrType.elem, mutable: false },
      ],
      body: [
        { kind: "varDecl", localId: "n.0", init: lengthOf(a, loc), loc },
        { kind: "varDecl", localId: "targetIndex.0", init: relativeIndex(varRef("target.0", F64, loc), n, loc), loc },
        { kind: "varDecl", localId: "startIndex.0", init: relativeIndex(varRef("start.0", F64, loc), n, loc), loc },
        { kind: "varDecl", localId: "endIndex.0", init: relativeIndex(varRef("end.0", F64, loc), n, loc), loc },
        {
          kind: "varDecl", localId: "count.0",
          init: {
            kind: "ternary", cond: eq(src, dst, loc), then: numLit(0, loc),
            else_: math("min", [math("max", [sub(last, src, loc), numLit(0, loc)], loc), sub(n, dst, loc)], loc),
            type: F64, loc,
          }, loc,
        },
        { kind: "varDecl", localId: "direction.0", init: { kind: "ternary", cond: backwards, then: numLit(-1, loc), else_: numLit(1, loc), type: F64, loc }, loc },
        { kind: "varDecl", localId: "from.0", init: add(src, offset, loc), loc },
        { kind: "varDecl", localId: "to.0", init: add(dst, offset, loc), loc },
        {
          kind: "while", cond: lt(numLit(0, loc), remaining, loc),
          body: [
            { kind: "varDecl", localId: "state.0", init: { kind: "arrayState", arr: a, index: from, type: F64, loc }, loc },
            {
              kind: "if", cond: eq(state, numLit(0, loc), loc),
              then: [{ kind: "arrayDelete", arr: a, index: to, loc }],
              else_: [{
                kind: "if", cond: eq(state, numLit(2, loc), loc),
                then: [{ kind: "arraySetUndefined", arr: a, index: to, loc }],
                else_: [
                  { kind: "varDecl", localId: "value.0", init: { kind: "arrayGet", arr: a, index: from, type: arrType.elem, loc }, loc },
                  { kind: "arraySet", arr: a, index: to, value: varRef("value.0", arrType.elem, loc), loc },
                ], loc,
              }], loc,
            },
            { kind: "assign", localId: "from.0", value: add(from, step, loc), loc },
            { kind: "assign", localId: "to.0", value: add(to, step, loc), loc },
            { kind: "assign", localId: "count.0", value: sub(remaining, numLit(1, loc), loc), loc },
          ], loc,
        },
        { kind: "return", value: a, loc },
      ],
      loc,
    });
  }
  return { kind: "call", callee: name, args: [receiver, target, start, end], type: arrType, loc };
}
