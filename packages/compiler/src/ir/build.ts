import { BOOL, F64, type IrExpr, type IrType, STRING, type SrcLoc } from "./nodes.js";

export function varRef(localId: string, type: IrType, loc: SrcLoc): IrExpr {
  return { kind: "varRef", localId, type, loc };
}

export function numLit(value: number, loc: SrcLoc): IrExpr {
  return { kind: "numLit", value, type: F64, loc };
}

export function strLit(value: string, loc: SrcLoc): IrExpr {
  return { kind: "strLit", value, type: STRING, loc };
}

export function boolLit(value: boolean, loc: SrcLoc): IrExpr {
  return { kind: "boolLit", value, type: BOOL, loc };
}
