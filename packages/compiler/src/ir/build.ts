import { BOOL, F64, type IrExpr, type IrStmt, type IrType, STRING, type SrcLoc } from "./nodes.js";

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

/** `for (i.0 = 0; i.0 < bound; i.0++)` over the conventional synthetic
 * index local. The bound expression remains in the condition and is
 * therefore evaluated once per iteration, matching the expanded IR. */
export function countedFor(
  loc: SrcLoc,
  bound: IrExpr,
  body: (index: IrExpr) => IrStmt[],
): IrStmt {
  const index = varRef("i.0", F64, loc);
  return {
    kind: "for",
    init: { kind: "varDecl", localId: "i.0", init: numLit(0, loc), loc },
    cond: { kind: "bin", op: "<", left: index, right: bound, type: BOOL, loc },
    update: {
      kind: "assign",
      localId: "i.0",
      value: { kind: "bin", op: "+", left: index, right: numLit(1, loc), type: F64, loc },
      loc,
    },
    body: body(index),
    loc,
  };
}
