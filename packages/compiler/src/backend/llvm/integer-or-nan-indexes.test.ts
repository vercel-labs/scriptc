import { expect, test } from "vitest";
import { F64, arrayOf, bytesOf, type IrExpr, type IrModule, type IrStmt } from "../../ir/ir.js";
import { emitLlvmModule } from "./emitter.js";

const loc = { file: "integer-or-nan-indexes.ts", start: 0, end: 0 };
const nums = arrayOf(F64);
const u8 = bytesOf("u8");
const ref = (localId: string, type: IrExpr["type"]): IrExpr => ({
  kind: "varRef",
  localId,
  type,
  loc,
});
const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
/** `t[i]!`: the element, or NaN for an index that misses. */
const byteRead = (index: IrExpr): IrExpr => ({
  kind: "bytesIntrinsic",
  method: "get",
  receiver: ref("t", u8),
  args: [index],
  type: F64,
  loc,
  invalidNaN: true,
});

function module(body: IrStmt[]): IrModule {
  return {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "__main",
    unions: [],
    functions: [
      { name: "__main", params: [], returnType: F64, locals: [], body: [], loc },
      {
        name: "read",
        params: [
          { name: "a", localId: "a", type: nums },
          { name: "t", localId: "t", type: u8 },
          { name: "i", localId: "i", type: F64 },
        ],
        returnType: F64,
        locals: [
          { id: "a", name: "a", type: nums, mutable: false },
          { id: "t", name: "t", type: u8, mutable: false },
          { id: "i", name: "i", type: F64, mutable: false },
          { id: "c", name: "c", type: F64, mutable: true },
        ],
        body,
        loc,
      },
    ],
  };
}

function body(llvm: string): string {
  return /^define internal [^\n]*@sc_bf_read(?:\.i32)?\([^]*?^}/m.exec(llvm)![0];
}

const count = (text: string, pattern: RegExp): number => text.match(pattern)?.length ?? 0;

test("an index bound to a byte read that may miss checks only that it is ordered", () => {
  const llvm = emitLlvmModule(
    module([
      { kind: "varDecl", localId: "c", init: byteRead(ref("i", F64)), loc },
      {
        kind: "return",
        value: {
          kind: "bin",
          op: "+",
          left: { kind: "arrayGet", arr: ref("a", nums), index: ref("c", F64), type: F64, loc },
          right: {
            kind: "bytesIntrinsic",
            method: "get",
            receiver: ref("t", u8),
            args: [{ kind: "bin", op: "+", left: ref("c", F64), right: num(1), type: F64, loc }],
            type: F64,
            loc,
            invalidNaN: true,
          },
          type: F64,
          loc,
        },
        loc,
      },
    ]),
  );
  const fn = body(llvm);
  // Only the parameter index `i` round-trips through a double.
  expect(count(fn, /fcmp oeq double/g)).toBe(1);
  expect(count(fn, /fcmp ord double/g)).toBe(2);
});

test("a local also written an ordinary number keeps the exact index check", () => {
  const llvm = emitLlvmModule(
    module([
      { kind: "varDecl", localId: "c", init: byteRead(ref("i", F64)), loc },
      { kind: "assign", localId: "c", value: ref("i", F64), loc },
      {
        kind: "return",
        value: { kind: "arrayGet", arr: ref("a", nums), index: ref("c", F64), type: F64, loc },
        loc,
      },
    ]),
  );
  const fn = body(llvm);
  expect(count(fn, /fcmp oeq double/g)).toBe(2);
  expect(fn).not.toContain("fcmp ord double");
});

test("a local whose writes grow from its own value keeps the exact index check", () => {
  const llvm = emitLlvmModule(
    module([
      { kind: "varDecl", localId: "c", init: byteRead(ref("i", F64)), loc },
      {
        kind: "assign",
        localId: "c",
        value: { kind: "bin", op: "+", left: ref("c", F64), right: num(1), type: F64, loc },
        loc,
      },
      {
        kind: "return",
        value: { kind: "arrayGet", arr: ref("a", nums), index: ref("c", F64), type: F64, loc },
        loc,
      },
    ]),
  );
  const fn = body(llvm);
  expect(count(fn, /fcmp oeq double/g)).toBe(2);
  expect(fn).not.toContain("fcmp ord double");
});
