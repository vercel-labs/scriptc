import {
  BOOL,
  DYN,
  F64,
  UNDEFINED_T,
  type IrExpr,
  type IrStmt,
  type IrType,
  STRING,
  type SrcLoc,
} from "./ir.js";

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
export function countedFor(loc: SrcLoc, bound: IrExpr, body: (index: IrExpr) => IrStmt[]): IrStmt {
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

/** A readable checked-dynamic binding starts with this undefined value.
 * A null dyn slot is an uninitialized trap, not JavaScript undefined. */
export function dynUndefinedExpr(loc: SrcLoc): IrExpr {
  return {
    kind: "dynFrom",
    value: { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc },
    type: DYN,
    loc,
  };
}

/** An always-throwing Node error with the replaced expression's type.
 * Kinds: 0 Error, 1 TypeError, 2 RangeError, 5 ReferenceError, 6 EvalError. An empty
 * code omits the error code property. */
export function nodeThrowExpr(
  kind: 0 | 1 | 2 | 5 | 6,
  code: string,
  message: string,
  type: IrType,
  loc: SrcLoc,
): IrExpr {
  return {
    kind: "libCall",
    fn: "error.nodeThrow",
    args: [
      { kind: "numLit", value: kind, type: F64, loc },
      { kind: "strLit", value: code, type: STRING, loc },
      { kind: "strLit", value: message, type: STRING, loc },
    ],
    type,
    loc,
  };
}

/** The location for a shared helper the lowering creates from its first
 * use. The helper is compiler code, not that use's source line: without a
 * source position it gets no debug info, so a breakpoint on the line stops
 * only at the use itself. */
export function helperLoc(loc: SrcLoc): SrcLoc {
  return { file: loc.file, start: -1, end: -1 };
}
