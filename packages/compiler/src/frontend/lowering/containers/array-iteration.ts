import { varRef } from "../../../ir/build.js";
import {
  BOOL,
  DYN,
  F64,
  type IrExpr,
  type IrLocal,
  type IrParam,
  type IrStmt,
  type IrType,
  type SrcLoc,
} from "../../../ir/ir.js";

/** The shared frame of helpers that call a prefix of (value, index, array).
 * Keep the local order stable; individual loops decide how to handle holes,
 * length snapshots, short-circuit returns and callback mutation.
 *
 * `withThis` adds the thisArg slot (`t.0`, a checked-dynamic value) that a
 * helper carrying the method's second argument passes as the callback's
 * call-site receiver — the only shape in which a callback's `this` is the
 * caller's thisArg rather than the ambient one. Helpers without it keep
 * exactly the two-parameter frame they always had. */
export function arrayCallbackParams(
  arrayType: IrType,
  callbackType: IrType,
  withThis = false,
): IrParam[] {
  const params: IrParam[] = [
    { localId: "a.0", name: "a", type: arrayType },
    { localId: "f.0", name: "f", type: callbackType },
  ];
  if (withThis) params.push({ localId: "t.0", name: "t", type: DYN });
  return params;
}

export function arrayCallbackLocals(
  arrayType: IrType,
  callbackType: IrType,
  withThis = false,
): IrLocal[] {
  const locals: IrLocal[] = [
    { id: "a.0", name: "a", type: arrayType, mutable: true },
    { id: "f.0", name: "f", type: callbackType, mutable: true },
    { id: "n.0", name: "n", type: F64, mutable: false },
    { id: "i.0", name: "i", type: F64, mutable: true },
  ];
  if (withThis) locals.push({ id: "t.0", name: "t", type: DYN, mutable: false });
  return locals;
}

/** `f(value, index, array)` with the helper's optional thisArg slot as the
 * call-site receiver: `callValue`'s receiver is what the callee reads as
 * `this` (the same ambient slot a method call fills), so a callback sees
 * the caller's thisArg exactly as the specification passes it. */
export function callArrayCallback(
  arrayType: IrType,
  callbackType: IrType,
  returnType: IrType,
  arity: number,
  value: IrExpr,
  loc: SrcLoc,
  withThis = false,
): IrExpr {
  return {
    kind: "callValue",
    callee: varRef("f.0", callbackType, loc),
    args: [value, varRef("i.0", F64, loc), varRef("a.0", arrayType, loc)].slice(0, arity),
    ...(withThis ? { receiver: varRef("t.0", DYN, loc) as IrExpr } : {}),
    type: returnType,
    loc,
  };
}

/** `n = a.length` — the once-up-front length read every array HOF loop
 * starts with (locals a.0/n.0 by convention). */
export function arrayLengthDeclaration(arrT: IrType, loc: SrcLoc): IrStmt {
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

/** `a[i]` inside a HOF loop (locals a.0/i.0 by convention). */
export function arrayElementRead(arrT: IrType, elem: IrType, loc: SrcLoc): IrExpr {
  return {
    kind: "arrayGet",
    arr: { kind: "varRef", localId: "a.0", type: arrT, loc },
    index: { kind: "varRef", localId: "i.0", type: F64, loc },
    type: elem,
    loc,
  };
}

/** `for (i = n - 1; i >= 0; i--) { ...body }` over the conventional locals
 * — countedFor walked backwards (the findLast pair's descending
 * index walk). */
export function reverseArrayLoop(loc: SrcLoc, body: IrStmt[]): IrStmt {
  const i: IrExpr = { kind: "varRef", localId: "i.0", type: F64, loc };
  const one: IrExpr = { kind: "numLit", value: 1, type: F64, loc };
  return {
    kind: "for",
    init: {
      kind: "varDecl",
      localId: "i.0",
      init: {
        kind: "bin",
        op: "-",
        left: { kind: "varRef", localId: "n.0", type: F64, loc },
        right: one,
        type: F64,
        loc,
      },
      loc,
    },
    cond: {
      kind: "bin",
      op: ">=",
      left: i,
      right: { kind: "numLit", value: 0, type: F64, loc },
      type: BOOL,
      loc,
    },
    update: {
      kind: "assign",
      localId: "i.0",
      value: { kind: "bin", op: "-", left: i, right: one, type: F64, loc },
      loc,
    },
    body,
    loc,
  };
}
