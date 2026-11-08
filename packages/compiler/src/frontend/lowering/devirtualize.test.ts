import { expect, test } from "vitest";
import {
  DYN,
  F64,
  VOID,
  type IrExpr,
  type IrFunction,
  type IrStmt,
  type IrType,
  type SrcLoc,
} from "../../ir/ir.js";
import { devirtualizeVirtualCalls } from "./devirtualize.js";
import type { Lowerer } from "./lowerer.js";

const loc: SrcLoc = { file: "bodies.ts", start: 0, end: 1 };
const VARIADIC: IrType = { kind: "func", params: [], ret: DYN, rest: true };
const ARGUMENTS: IrType = { kind: "func", params: [], ret: DYN, rest: true, argumentsAll: true };
const TYPED_REST: IrType = {
  kind: "func",
  params: [{ kind: "array", elem: F64 }],
  ret: DYN,
  rest: true,
  restAbi: "typed",
};
const FIXED: IrType = { kind: "func", params: [F64], ret: DYN };

const read = (type: IrType): IrExpr => ({ kind: "varRef", localId: "callback", type, loc });
/** `argument` handed to a runtime builtin inside a branch: an expression
 * under a statement under a statement. */
const nested = (argument: IrExpr): IrStmt => ({
  kind: "if",
  cond: { kind: "boolLit", value: true, type: { kind: "bool" }, loc },
  then: [
    {
      kind: "exprStmt",
      expr: { kind: "libCall", fn: "dyn.valueOf", args: [argument], type: DYN, loc },
      loc,
    },
  ],
  else_: null,
  loc,
});
const fn = (name: string, body: IrStmt[]): IrFunction => ({
  name,
  body,
  params: [],
  locals: [],
  returnType: VOID,
  loc,
});
/** No body here holds a virtual call, an allocation or a class value, so
 * the pass asks the lowerer nothing. */
const lowerer = {} as unknown as Lowerer;
const facts = {
  reachable: new Set<string>(),
  instantiated: new Set<string>(),
  library: false,
  files: [],
};

test("the pass says whether a body it leaves holds a variadic function", () => {
  const typed = [fn("main", [nested(read(FIXED))]), fn("rest", [nested(read(TYPED_REST))])];
  expect(devirtualizeVirtualCalls(lowerer, typed, facts)).toEqual({ variadicFunctions: false });
  for (const type of [VARIADIC, ARGUMENTS]) {
    const functions = [fn("main", [nested(read(FIXED))]), fn("handler", [nested(read(type))])];
    expect(devirtualizeVirtualCalls(lowerer, functions, facts)).toEqual({
      variadicFunctions: true,
    });
  }
});
