import { countedFor, varRef } from "../../../ir/build.js";
import {
  DYN,
  F64,
  type IrExpr,
  type IrFunction,
  type IrLocal,
  type IrParam,
  type IrStmt,
  type IrType,
  type SrcLoc,
} from "../../../ir/ir.js";

/** Convert a native array into a fresh result. The input length is captured
 * after result initialization and before any element conversion runs. */
export function buildArrayConversion(
  name: string,
  source: IrType & { kind: "array" },
  initial: IrExpr,
  append: (element: IrExpr, index: IrExpr, result: IrExpr) => IrExpr,
  loc: SrcLoc,
  // Statements that run before each element is read.
  check: (index: IrExpr) => IrStmt[] = () => [],
): IrFunction {
  const input = varRef("a.0", source, loc);
  const result = varRef("out.0", initial.type, loc);
  return {
    name,
    params: [{ localId: "a.0", name: "a", type: source }],
    returnType: initial.type,
    locals: [
      { id: "a.0", name: "a", type: source, mutable: true },
      { id: "out.0", name: "out", type: initial.type, mutable: false },
      { id: "n.0", name: "n", type: F64, mutable: false },
      { id: "i.0", name: "i", type: F64, mutable: true },
    ],
    body: [
      { kind: "varDecl", localId: "out.0", init: initial, loc },
      {
        kind: "varDecl",
        localId: "n.0",
        init: { kind: "arrIntrinsic", method: "length", receiver: input, args: [], type: F64, loc },
        loc,
      },
      countedFor(loc, varRef("n.0", F64, loc), (index) => [
        ...check(index),
        {
          kind: "exprStmt",
          expr: append(
            { kind: "arrayGet", arr: input, index, type: source.elem, loc },
            index,
            result,
          ),
          loc,
        },
      ]),
      { kind: "return", value: result, loc },
    ],
    loc,
  };
}

/** The implementation captures the original function; the factory creates
 * a fresh closure for each adapted value. Keep both boxed slots in sync.
 * `source` is the original's type: a function type, or the checked-dynamic
 * type for an adapter that calls a boxed function (a checked adapter, whose
 * box is that function again). */
export function buildFunctionAdapter(
  name: string,
  source: (IrType & { kind: "func" }) | (IrType & { kind: "dyn" }),
  target: IrType & { kind: "func" },
  params: IrParam[],
  locals: IrLocal[],
  body: IrStmt[],
  loc: SrcLoc,
): IrFunction[] {
  const implementation = `${name}.impl`;
  return [
    {
      name: implementation,
      params,
      returnType: target.ret,
      captures: [{ localId: "f.0", name: "f", type: source }],
      locals: [
        { id: "f.0", name: "f", type: source, mutable: false, boxed: true },
        ...params.map((param) => ({
          id: param.localId,
          name: param.name,
          type: param.type,
          mutable: false,
        })),
        ...locals,
      ],
      body,
      loc,
    },
    {
      name,
      params: [{ localId: "f.0", name: "f", type: source }],
      returnType: target,
      locals: [{ id: "f.0", name: "f", type: source, mutable: false, boxed: true }],
      body: [
        {
          kind: "return",
          value: {
            kind: "closure",
            fnName: implementation,
            captures: ["f.0"],
            adapts: true,
            type: target,
            loc,
          },
          loc,
        },
      ],
      loc,
    },
  ];
}

/** The variadic adapter: two functions whose implementation calls the
 * source dynamically (a `dynCall` on the box in `boxLocal`) and whose
 * factory boxes the source once and closes over both values. The closure
 * is marked `adapts`, so its first capture — the function itself, the box
 * `viewSource` reads — is what a consumer that passes more arguments than
 * the slot's type names reaches (function-views.ts), and what a box of it
 * stands for where the program boxes that type (boxesSource). */
export function buildDynCallingAdapter(
  name: string,
  source: IrType & { kind: "func" },
  target: IrType & { kind: "func" },
  params: IrParam[],
  locals: IrLocal[],
  body: IrStmt[],
  /** The local of the implementation that holds the boxed source. */
  boxLocal: string,
  loc: SrcLoc,
): IrFunction[] {
  const implementation = `${name}.impl`;
  return [
    {
      name: implementation,
      params,
      returnType: target.ret,
      captures: [
        { localId: "f.0", name: "f", type: source },
        { localId: boxLocal, name: boxLocal, type: DYN },
      ],
      locals: [
        { id: "f.0", name: "f", type: source, mutable: false, boxed: true },
        { id: boxLocal, name: boxLocal, type: DYN, mutable: false, boxed: true },
        ...params.map((param) => ({
          id: param.localId,
          name: param.name,
          type: param.type,
          mutable: false,
        })),
        ...locals,
      ],
      body,
      loc,
    },
    {
      name,
      params: [{ localId: "f.0", name: "f", type: source }],
      returnType: target,
      locals: [
        { id: "f.0", name: "f", type: source, mutable: false, boxed: true },
        { id: boxLocal, name: boxLocal, type: DYN, mutable: false, boxed: true },
      ],
      body: [
        {
          kind: "varDecl",
          localId: boxLocal,
          init: {
            kind: "dynFrom",
            value: { kind: "varRef", localId: "f.0", type: source, loc },
            type: DYN,
            loc,
          },
          loc,
        },
        {
          kind: "return",
          value: {
            kind: "closure",
            fnName: implementation,
            captures: ["f.0", boxLocal],
            adapts: true,
            type: target,
            loc,
          },
          loc,
        },
      ],
      loc,
    },
  ];
}
