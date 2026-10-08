import { countedFor, varRef } from "../../../ir/build.js";
import {
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
 * a fresh closure for each adapted value. Keep both boxed slots in sync. */
export function buildFunctionAdapter(
  name: string,
  source: IrType & { kind: "func" },
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
