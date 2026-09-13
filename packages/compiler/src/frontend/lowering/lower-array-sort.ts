import {
  BOOL,
  BYTES_U8,
  F64,
  IrExpr,
  IrFunction,
  IrLocal,
  IrParam,
  IrStmt,
  IrType,
  JSVAL,
  SrcLoc,
  arrayOf,
  funcOf,
} from "../../ir/ir.js";
import { numLit, varRef } from "../../ir/build.js";

function readArrayLength(arrT: IrType, loc: SrcLoc): IrStmt {
  return {
    kind: "varDecl",
    localId: "n.0",
    init: {
      kind: "arrIntrinsic",
      method: "length",
      receiver: { kind: "varRef", localId: "a.0", type: arrT, loc },
      args: [],
      type: F64,
      loc,
    },
    loc,
  };
}

/** A stable bottom-up merge sort built from existing IR nodes.
 *
 * The first implementation used insertion sort because it was compact and
 * made the stable tie rule obvious. Its worst case was quadratic, though,
 * which made an ordinary descending input unusable. This implementation
 * snapshots the receiver, merges runs between two buffers, and copies the
 * final snapshot back into the receiver. The boundary check skips a merge
 * when adjacent runs are already ordered, so naturally ordered inputs use
 * only a linear number of comparator calls; the buffer copies still do
 * O(n log n) data movement. Arbitrary inputs have an O(n log n) bound.
 *
 * The snapshot is also important for sort mutation behavior: comparator
 * calls see the values captured before sorting starts, while the final copy
 * preserves Array.sort receiver identity. toSorted starts by copying the
 * receiver and therefore leaves that receiver untouched. The merge schedule
 * intentionally differs from V8 TimSort, so exact comparator call order and
 * count parity is not claimed; stable results, comparator exceptions, and
 * mutations of referenced values still follow the normal IR call/ownership
 * rules. */
export function buildArraySortFn(
  name: string,
  elem: IrType,
  arity: number,
  copyFirst: boolean,
  undefinedTag: number | null,
  loc: SrcLoc,
): IrFunction {
  const arrT = arrayOf(elem);
  const fnT = funcOf([elem, elem].slice(0, arity), F64);

  const a = varRef("a.0", arrT, loc);
  const snapshot = varRef("snapshot.0", arrT, loc);
  const src = varRef("src.0", arrT, loc);
  const dst = varRef("dst.0", arrT, loc);
  const n = varRef("n.0", F64, loc);
  const valueCount = varRef("valueCount.0", F64, loc);
  const undefinedCount = varRef("undefinedCount.0", F64, loc);
  const width = varRef("width.0", F64, loc);
  const start = varRef("start.0", F64, loc);
  const mid = varRef("mid.0", F64, loc);
  const right = varRef("right.0", F64, loc);
  const left = varRef("left.0", F64, loc);
  const r = varRef("r.0", F64, loc);
  const k = varRef("k.0", F64, loc);
  const i = varRef("i.0", F64, loc);
  const j = varRef("j.0", F64, loc);
  const state = varRef("state.0", F64, loc);
  const add = (left: IrExpr, right: IrExpr): IrExpr => ({ kind: "bin", op: "+", left, right, type: F64, loc });
  const sub = (left: IrExpr, right: IrExpr): IrExpr => ({ kind: "bin", op: "-", left, right, type: F64, loc });
  const mul = (left: IrExpr, right: IrExpr): IrExpr => ({ kind: "bin", op: "*", left, right, type: F64, loc });
  const lt = (left: IrExpr, right: IrExpr): IrExpr => ({ kind: "bin", op: "<", left, right, type: BOOL, loc });
  const eq = (left: IrExpr, right: IrExpr): IrExpr => ({ kind: "bin", op: "===", left, right, type: BOOL, loc });
  const not = (value: IrExpr): IrExpr => ({ kind: "unary", op: "!", operand: value, type: BOOL, loc });
  const at = (index: IrExpr): IrExpr => ({ kind: "arrayGet", arr: src, index, type: elem, loc });
  const snapshotAt = (index: IrExpr): IrExpr => ({ kind: "arrayGet", arr: snapshot, index, type: elem, loc });
  const stateAt = (index: IrExpr): IrExpr => ({ kind: "arrayState", arr: snapshot, index, type: F64, loc });
  const stateIs = (value: number): IrExpr => eq(state, numLit(value, loc));
  const isUndefined = (value: IrExpr): IrExpr | null => {
    if (elem.kind === "union" && undefinedTag !== null) {
      return {
        kind: "unionIsTag",
        unionId: elem.unionId,
        tag: undefinedTag,
        negated: false,
        value,
        type: BOOL,
        loc,
      };
    }
    if (elem.kind === "jsval") {
      return {
        kind: "jsOp",
        op: "eq",
        args: [
          value,
          { kind: "jsOp", op: "undefLit", args: [], type: JSVAL, loc },
        ],
        type: BOOL,
        loc,
      };
    }
    return null;
  };
  const shouldTakeRight = (leftValue: IrExpr, rightValue: IrExpr): IrExpr => {
    const compareGreater: IrExpr = {
      kind: "bin",
      op: ">",
      left: {
        kind: "callValue",
        callee: varRef("f.0", fnT, loc),
        args: [leftValue, rightValue].slice(0, arity),
        type: F64,
        loc,
      },
      right: numLit(0, loc),
      type: BOOL,
      loc,
    };
    const leftUndefined = isUndefined(leftValue);
    const rightUndefined = isUndefined(rightValue);
    return leftUndefined !== null && rightUndefined !== null
      ? {
          kind: "ternary",
          cond: leftUndefined,
          then: not(rightUndefined),
          else_: {
            kind: "ternary",
            cond: rightUndefined,
            then: { kind: "boolLit", value: false, type: BOOL, loc },
            else_: compareGreater,
            type: BOOL,
            loc,
          },
          type: BOOL,
          loc,
        }
      : compareGreater;
  };
  const copyRange: IrStmt = {
    kind: "while",
    cond: lt(k, right),
    body: [
      { kind: "varDecl", localId: "v.0", init: at(k), loc },
      { kind: "arraySet", arr: dst, index: k, value: varRef("v.0", elem, loc), loc },
      { kind: "assign", localId: "k.0", value: add(k, numLit(1, loc)), loc },
    ],
    loc,
  };
  const mergeBody: IrStmt[] = [
    {
      kind: "while",
      cond: {
        kind: "logical",
        op: "&&",
        left: lt(left, mid),
        right: lt(r, right),
        type: BOOL,
        loc,
      },
      body: [
        { kind: "varDecl", localId: "vL.0", init: at(left), loc },
        { kind: "varDecl", localId: "vR.0", init: at(r), loc },
        {
          kind: "if",
          cond: shouldTakeRight(varRef("vL.0", elem, loc), varRef("vR.0", elem, loc)),
          then: [
            { kind: "arraySet", arr: dst, index: k, value: varRef("vR.0", elem, loc), loc },
            { kind: "assign", localId: "r.0", value: add(r, numLit(1, loc)), loc },
          ],
          else_: [
            { kind: "arraySet", arr: dst, index: k, value: varRef("vL.0", elem, loc), loc },
            { kind: "assign", localId: "left.0", value: add(left, numLit(1, loc)), loc },
          ],
          loc,
        },
        { kind: "assign", localId: "k.0", value: add(k, numLit(1, loc)), loc },
      ],
      loc,
    },
    {
      kind: "while",
      cond: lt(left, mid),
      body: [
        { kind: "varDecl", localId: "v.0", init: at(left), loc },
        { kind: "arraySet", arr: dst, index: k, value: varRef("v.0", elem, loc), loc },
        { kind: "assign", localId: "left.0", value: add(left, numLit(1, loc)), loc },
        { kind: "assign", localId: "k.0", value: add(k, numLit(1, loc)), loc },
      ],
      loc,
    },
    {
      kind: "while",
      cond: lt(r, right),
      body: [
        { kind: "varDecl", localId: "v.0", init: at(r), loc },
        { kind: "arraySet", arr: dst, index: k, value: varRef("v.0", elem, loc), loc },
        { kind: "assign", localId: "r.0", value: add(r, numLit(1, loc)), loc },
        { kind: "assign", localId: "k.0", value: add(k, numLit(1, loc)), loc },
      ],
      loc,
    },
  ];
  const boundaryLeft = varRef("boundaryL.0", elem, loc);
  const boundaryRight = varRef("boundaryR.0", elem, loc);
  const mergeOrCopy: IrStmt = {
    kind: "if",
    cond: lt(mid, right),
    then: [
      { kind: "varDecl", localId: "boundaryL.0", init: at(sub(mid, numLit(1, loc))), loc },
      { kind: "varDecl", localId: "boundaryR.0", init: at(mid), loc },
      {
        kind: "if",
        cond: shouldTakeRight(boundaryLeft, boundaryRight),
        then: mergeBody,
        else_: [copyRange],
        loc,
      },
    ],
    else_: [copyRange],
    loc,
  };
  const mergePass: IrStmt = {
    kind: "for",
    init: { kind: "varDecl", localId: "start.0", init: numLit(0, loc), loc },
    cond: lt(start, valueCount),
    update: { kind: "assign", localId: "start.0", value: add(start, add(width, width)), loc },
    body: [
      {
        kind: "varDecl",
        localId: "mid.0",
        init: {
          kind: "ternary",
          cond: lt(add(start, width), valueCount),
          then: add(start, width),
          else_: valueCount,
          type: F64,
          loc,
        },
        loc,
      },
      {
        kind: "varDecl",
        localId: "right.0",
        init: {
          kind: "ternary",
          cond: lt(add(add(start, width), width), valueCount),
          then: add(add(start, width), width),
          else_: valueCount,
          type: F64,
          loc,
        },
        loc,
      },
      { kind: "varDecl", localId: "left.0", init: start, loc },
      { kind: "varDecl", localId: "r.0", init: mid, loc },
      { kind: "varDecl", localId: "k.0", init: start, loc },
      mergeOrCopy,
    ],
    loc,
  };
  const collect: IrStmt = {
    kind: "for",
    init: { kind: "varDecl", localId: "i.0", init: numLit(0, loc), loc },
    cond: lt(i, n),
    update: { kind: "assign", localId: "i.0", value: add(i, numLit(1, loc)), loc },
    body: [
      { kind: "varDecl", localId: "state.0", init: stateAt(i), loc },
      {
        kind: "if",
        cond: stateIs(1),
        then: [
          { kind: "varDecl", localId: "v.0", init: snapshotAt(i), loc },
          { kind: "arraySet", arr: src, index: valueCount, value: varRef("v.0", elem, loc), loc },
          { kind: "assign", localId: "valueCount.0", value: add(valueCount, numLit(1, loc)), loc },
        ],
        else_: [
          {
            kind: "if",
            cond: stateIs(2),
            then: [{ kind: "assign", localId: "undefinedCount.0", value: add(undefinedCount, numLit(1, loc)), loc }],
            else_: null,
            loc,
          },
        ],
        loc,
      },
    ],
    loc,
  };
  const writeValues: IrStmt = {
    kind: "for",
    init: { kind: "varDecl", localId: "i.0", init: numLit(0, loc), loc },
    cond: lt(i, valueCount),
    update: { kind: "assign", localId: "i.0", value: add(i, numLit(1, loc)), loc },
    body: [
      { kind: "varDecl", localId: "v.0", init: at(i), loc },
      { kind: "arraySet", arr: a, index: i, value: varRef("v.0", elem, loc), loc },
    ],
    loc,
  };
  const writeUndefined: IrStmt = {
    kind: "for",
    init: { kind: "varDecl", localId: "j.0", init: valueCount, loc },
    cond: lt(j, copyFirst ? n : add(valueCount, undefinedCount)),
    update: { kind: "assign", localId: "j.0", value: add(j, numLit(1, loc)), loc },
    body: [{ kind: "arraySetUndefined", arr: a, index: j, loc }],
    loc,
  };
  const deleteRemaining: IrStmt = {
    kind: "for",
    init: { kind: "varDecl", localId: "j.0", init: add(valueCount, undefinedCount), loc },
    cond: lt(j, n),
    update: { kind: "assign", localId: "j.0", value: add(j, numLit(1, loc)), loc },
    body: [{ kind: "arrayDelete", arr: a, index: j, loc }],
    loc,
  };
  const body: IrStmt[] = [
    ...(copyFirst
      ? [{
          kind: "assign" as const,
          localId: "a.0",
          value: {
            kind: "arrIntrinsic" as const,
            method: "slice" as const,
            receiver: varRef("a.0", arrT, loc),
            args: [],
            type: arrT,
            loc,
          },
          loc,
        }]
      : []),
    readArrayLength(arrT, loc),
    { kind: "varDecl", localId: "snapshot.0", init: { kind: "arrIntrinsic", method: "slice", receiver: a, args: [], type: arrT, loc }, loc },
    { kind: "varDecl", localId: "src.0", init: { kind: "arrayLit", elems: [], type: arrT, loc }, loc },
    { kind: "varDecl", localId: "valueCount.0", init: numLit(0, loc), loc },
    { kind: "varDecl", localId: "undefinedCount.0", init: numLit(0, loc), loc },
    collect,
    { kind: "varDecl", localId: "dst.0", init: { kind: "arrayLit", elems: [], type: arrT, loc }, loc },
    { kind: "varDecl", localId: "width.0", init: numLit(1, loc), loc },
    {
      kind: "while",
      cond: lt(width, valueCount),
      body: [
        mergePass,
        { kind: "varDecl", localId: "tmp.0", init: src, loc },
        { kind: "assign", localId: "src.0", value: dst, loc },
        { kind: "assign", localId: "dst.0", value: varRef("tmp.0", arrT, loc), loc },
        { kind: "assign", localId: "width.0", value: mul(width, numLit(2, loc)), loc },
      ],
      loc,
    },
    writeValues,
    writeUndefined,
    ...(copyFirst ? [] : [deleteRemaining]),
    { kind: "return", value: a, loc },
  ];
  return {
    name,
    params: [
      { localId: "a.0", name: "a", type: arrT },
      { localId: "f.0", name: "f", type: fnT },
    ],
    returnType: arrT,
    locals: [
      { id: "a.0", name: "a", type: arrT, mutable: true },
      { id: "f.0", name: "f", type: fnT, mutable: true },
      { id: "n.0", name: "n", type: F64, mutable: false },
      { id: "snapshot.0", name: "snapshot", type: arrT, mutable: false },
      { id: "src.0", name: "src", type: arrT, mutable: true },
      { id: "dst.0", name: "dst", type: arrT, mutable: true },
      { id: "valueCount.0", name: "valueCount", type: F64, mutable: true },
      { id: "undefinedCount.0", name: "undefinedCount", type: F64, mutable: true },
      { id: "state.0", name: "state", type: F64, mutable: false },
      { id: "width.0", name: "width", type: F64, mutable: true },
      { id: "start.0", name: "start", type: F64, mutable: true },
      { id: "mid.0", name: "mid", type: F64, mutable: true },
      { id: "right.0", name: "right", type: F64, mutable: true },
      { id: "left.0", name: "left", type: F64, mutable: true },
      { id: "r.0", name: "r", type: F64, mutable: true },
      { id: "k.0", name: "k", type: F64, mutable: true },
      { id: "i.0", name: "i", type: F64, mutable: true },
      { id: "j.0", name: "j", type: F64, mutable: true },
      { id: "tmp.0", name: "tmp", type: arrT, mutable: true },
      { id: "v.0", name: "v", type: elem, mutable: false },
      { id: "vL.0", name: "vL", type: elem, mutable: false },
      { id: "vR.0", name: "vR", type: elem, mutable: false },
      { id: "boundaryL.0", name: "boundaryL", type: elem, mutable: false },
      { id: "boundaryR.0", name: "boundaryR", type: elem, mutable: false },
    ],
    body,
    loc,
  };
}

export function buildBytesSortFn(
  name: string,
  arity: number,
  hasComparator: boolean,
  loc: SrcLoc,
): IrFunction {
  const bytesT = BYTES_U8;
  const fnT = funcOf([F64, F64].slice(0, arity), F64);
  const a = varRef("a.0", bytesT, loc);
  const src = varRef("src.0", bytesT, loc);
  const dst = varRef("dst.0", bytesT, loc);
  const n = varRef("n.0", F64, loc);
  const width = varRef("width.0", F64, loc);
  const start = varRef("start.0", F64, loc);
  const mid = varRef("mid.0", F64, loc);
  const right = varRef("right.0", F64, loc);
  const left = varRef("left.0", F64, loc);
  const r = varRef("r.0", F64, loc);
  const k = varRef("k.0", F64, loc);
  const add = (left: IrExpr, right: IrExpr): IrExpr => ({ kind: "bin", op: "+", left, right, type: F64, loc });
  const sub = (left: IrExpr, right: IrExpr): IrExpr => ({ kind: "bin", op: "-", left, right, type: F64, loc });
  const mul = (left: IrExpr, right: IrExpr): IrExpr => ({ kind: "bin", op: "*", left, right, type: F64, loc });
  const lt = (left: IrExpr, right: IrExpr): IrExpr => ({ kind: "bin", op: "<", left, right, type: BOOL, loc });
  const at = (receiver: IrExpr, index: IrExpr): IrExpr => ({
    kind: "bytesIntrinsic",
    method: "get",
    receiver,
    args: [index],
    type: F64,
    loc,
  });
  const shouldTakeRight = (leftValue: IrExpr, rightValue: IrExpr): IrExpr => ({
    kind: "bin",
    op: ">",
    left: hasComparator
      ? {
          kind: "callValue",
          callee: varRef("f.0", fnT, loc),
          args: [leftValue, rightValue].slice(0, arity),
          type: F64,
          loc,
        }
      : {
          kind: "bin",
          op: "-",
          left: leftValue,
          right: rightValue,
          type: F64,
          loc,
        },
    right: numLit(0, loc),
    type: BOOL,
    loc,
  });
  const copyRange: IrStmt = {
    kind: "while",
    cond: lt(k, right),
    body: [
      { kind: "varDecl", localId: "v.0", init: at(src, k), loc },
      { kind: "bytesSet", arr: dst, index: k, value: varRef("v.0", F64, loc), loc },
      { kind: "assign", localId: "k.0", value: add(k, numLit(1, loc)), loc },
    ],
    loc,
  };
  const mergeBody: IrStmt[] = [
    {
      kind: "while",
      cond: {
        kind: "logical",
        op: "&&",
        left: lt(left, mid),
        right: lt(r, right),
        type: BOOL,
        loc,
      },
      body: [
        { kind: "varDecl", localId: "vL.0", init: at(src, left), loc },
        { kind: "varDecl", localId: "vR.0", init: at(src, r), loc },
        {
          kind: "if",
          cond: shouldTakeRight(varRef("vL.0", F64, loc), varRef("vR.0", F64, loc)),
          then: [
            { kind: "bytesSet", arr: dst, index: k, value: varRef("vR.0", F64, loc), loc },
            { kind: "assign", localId: "r.0", value: add(r, numLit(1, loc)), loc },
          ],
          else_: [
            { kind: "bytesSet", arr: dst, index: k, value: varRef("vL.0", F64, loc), loc },
            { kind: "assign", localId: "left.0", value: add(left, numLit(1, loc)), loc },
          ],
          loc,
        },
        { kind: "assign", localId: "k.0", value: add(k, numLit(1, loc)), loc },
      ],
      loc,
    },
    {
      kind: "while",
      cond: lt(left, mid),
      body: [
        { kind: "varDecl", localId: "v.0", init: at(src, left), loc },
        { kind: "bytesSet", arr: dst, index: k, value: varRef("v.0", F64, loc), loc },
        { kind: "assign", localId: "left.0", value: add(left, numLit(1, loc)), loc },
        { kind: "assign", localId: "k.0", value: add(k, numLit(1, loc)), loc },
      ],
      loc,
    },
    {
      kind: "while",
      cond: lt(r, right),
      body: [
        { kind: "varDecl", localId: "v.0", init: at(src, r), loc },
        { kind: "bytesSet", arr: dst, index: k, value: varRef("v.0", F64, loc), loc },
        { kind: "assign", localId: "r.0", value: add(r, numLit(1, loc)), loc },
        { kind: "assign", localId: "k.0", value: add(k, numLit(1, loc)), loc },
      ],
      loc,
    },
  ];
  const mergeOrCopy: IrStmt = {
    kind: "if",
    cond: lt(mid, right),
    then: [
      { kind: "varDecl", localId: "boundaryL.0", init: at(src, sub(mid, numLit(1, loc))), loc },
      { kind: "varDecl", localId: "boundaryR.0", init: at(src, mid), loc },
      {
        kind: "if",
        cond: shouldTakeRight(varRef("boundaryL.0", F64, loc), varRef("boundaryR.0", F64, loc)),
        then: mergeBody,
        else_: [copyRange],
        loc,
      },
    ],
    else_: [copyRange],
    loc,
  };
  const mergePass: IrStmt = {
    kind: "for",
    init: { kind: "varDecl", localId: "start.0", init: numLit(0, loc), loc },
    cond: lt(start, n),
    update: { kind: "assign", localId: "start.0", value: add(start, add(width, width)), loc },
    body: [
      {
        kind: "varDecl",
        localId: "mid.0",
        init: {
          kind: "ternary",
          cond: lt(add(start, width), n),
          then: add(start, width),
          else_: n,
          type: F64,
          loc,
        },
        loc,
      },
      {
        kind: "varDecl",
        localId: "right.0",
        init: {
          kind: "ternary",
          cond: lt(add(add(start, width), width), n),
          then: add(add(start, width), width),
          else_: n,
          type: F64,
          loc,
        },
        loc,
      },
      { kind: "varDecl", localId: "left.0", init: start, loc },
      { kind: "varDecl", localId: "r.0", init: mid, loc },
      { kind: "varDecl", localId: "k.0", init: start, loc },
      mergeOrCopy,
    ],
    loc,
  };
  const params: IrParam[] = [
    { localId: "a.0", name: "a", type: bytesT },
    ...(hasComparator ? [{ localId: "f.0", name: "f", type: fnT }] : []),
  ];
  const locals: IrLocal[] = [
    { id: "a.0", name: "a", type: bytesT, mutable: true },
    ...(hasComparator ? [{ id: "f.0", name: "f", type: fnT, mutable: true }] : []),
    { id: "n.0", name: "n", type: F64, mutable: false },
    { id: "src.0", name: "src", type: bytesT, mutable: true },
    { id: "dst.0", name: "dst", type: bytesT, mutable: true },
    { id: "width.0", name: "width", type: F64, mutable: true },
    { id: "start.0", name: "start", type: F64, mutable: true },
    { id: "mid.0", name: "mid", type: F64, mutable: true },
    { id: "right.0", name: "right", type: F64, mutable: true },
    { id: "left.0", name: "left", type: F64, mutable: true },
    { id: "r.0", name: "r", type: F64, mutable: true },
    { id: "k.0", name: "k", type: F64, mutable: true },
    { id: "i.0", name: "i", type: F64, mutable: true },
    { id: "tmp.0", name: "tmp", type: bytesT, mutable: true },
    { id: "v.0", name: "v", type: F64, mutable: false },
    { id: "vL.0", name: "vL", type: F64, mutable: false },
    { id: "vR.0", name: "vR", type: F64, mutable: false },
    { id: "boundaryL.0", name: "boundaryL", type: F64, mutable: false },
    { id: "boundaryR.0", name: "boundaryR", type: F64, mutable: false },
  ];
  const slice = (receiver: IrExpr): IrExpr => ({
    kind: "bytesIntrinsic",
    method: "slice",
    receiver,
    args: [],
    type: bytesT,
    loc,
  });
  const body: IrStmt[] = [
    { kind: "assign", localId: "a.0", value: slice(a), loc },
    { kind: "varDecl", localId: "n.0", init: { kind: "bytesIntrinsic", method: "length", receiver: a, args: [], type: F64, loc }, loc },
    { kind: "varDecl", localId: "src.0", init: slice(a), loc },
    { kind: "varDecl", localId: "dst.0", init: slice(a), loc },
    { kind: "varDecl", localId: "width.0", init: numLit(1, loc), loc },
    {
      kind: "while",
      cond: lt(width, n),
      body: [
        mergePass,
        { kind: "varDecl", localId: "tmp.0", init: src, loc },
        { kind: "assign", localId: "src.0", value: dst, loc },
        { kind: "assign", localId: "dst.0", value: varRef("tmp.0", bytesT, loc), loc },
        { kind: "assign", localId: "width.0", value: mul(width, numLit(2, loc)), loc },
      ],
      loc,
    },
    {
      kind: "for",
      init: { kind: "varDecl", localId: "i.0", init: numLit(0, loc), loc },
      cond: lt(varRef("i.0", F64, loc), n),
      update: { kind: "assign", localId: "i.0", value: add(varRef("i.0", F64, loc), numLit(1, loc)), loc },
      body: [
        { kind: "varDecl", localId: "v.0", init: at(src, varRef("i.0", F64, loc)), loc },
        { kind: "bytesSet", arr: a, index: varRef("i.0", F64, loc), value: varRef("v.0", F64, loc), loc },
      ],
      loc,
    },
    { kind: "return", value: a, loc },
  ];
  return { name, params, returnType: bytesT, locals, body, loc };
}
