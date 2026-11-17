import { expect, test } from "vitest";
import { F64, VOID, type IrExpr, type IrModule, type IrStmt, type IrType } from "../../ir/ir.js";
import { emitLlvmModule } from "./emitter.js";

const loc = { file: "integer-induction.ts", start: 0, end: 0 };
const i32s: IrType = { kind: "bytes", elem: "i32" };
const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
const ref = (localId: string, type: IrType = F64): IrExpr => ({
  kind: "varRef",
  localId,
  type,
  loc,
});
const bin = (op: string, left: IrExpr, right: IrExpr): IrExpr =>
  ({ kind: "bin", op, left, right, type: F64, loc }) as IrExpr;
const get = (arr: IrExpr, index: IrExpr): IrExpr => ({
  kind: "bytesIntrinsic",
  method: "get",
  receiver: arr,
  args: [index],
  invalidNaN: true,
  type: F64,
  loc,
});

/** `let i = <start>; i = i + 1; return b[i]` */
function kernel(start: IrExpr): IrModule {
  const body: IrStmt[] = [
    { kind: "varDecl", localId: "i", init: start, loc },
    { kind: "assign", localId: "i", value: bin("+", ref("i"), num(1)), loc },
    { kind: "return", value: get(ref("b", i32s), ref("i")), loc },
  ];
  return {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "__main",
    functions: [
      { name: "__main", params: [], returnType: VOID, locals: [], body: [], loc },
      {
        name: "kernel",
        params: [
          { name: "a", localId: "a", type: i32s },
          { name: "b", localId: "b", type: i32s },
        ],
        returnType: F64,
        locals: [
          { id: "a", name: "a", type: i32s, mutable: false },
          { id: "b", name: "b", type: i32s, mutable: false },
          { id: "i", name: "i", type: F64, mutable: true },
        ],
        body,
        loc,
      },
    ],
  };
}

function body(start: IrExpr): string {
  const llvm = emitLlvmModule(kernel(start));
  return /^define internal [^\n]*@sc_bf_kernel[^]*?^}/m.exec(llvm)![0];
}

test("a counter stepped from a typed-array element indexes without an exactness round trip", () => {
  // The element read is an exact integer or NaN, and a ±1 step keeps that
  // fact, so the next index tests only for NaN and converts once instead of
  // converting back and comparing the double.
  const fn = body(get(ref("a", i32s), num(0)));
  expect(fn).toContain("fcmp ord double");
  expect(fn).not.toContain("fcmp oeq double");
});

test("a counter started from a fraction keeps the exactness round trip", () => {
  const fn = body(num(0.5));
  expect(fn).toContain("fcmp oeq double");
});
