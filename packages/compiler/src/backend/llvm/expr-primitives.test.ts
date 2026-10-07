import { expect, test } from "vitest";
import { BOOL, F64, STRING, VOID, type IrExpr, type IrModule, type IrStmt } from "../../ir/ir.js";
import { emitLlvmModule } from "./emitter.js";

const loc = { file: "bitwise-emission.ts", start: 0, end: 0 };

function fixture(): IrModule {
  const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
  const body: IrStmt[] = (["&", "|", "^", "<<", ">>", ">>>"] as const).map((op) => ({
    kind: "exprStmt",
    expr: { kind: "bin", op, left: num(5), right: num(3), type: F64, loc },
    loc,
  }));
  body.push({
    kind: "exprStmt",
    expr: { kind: "unary", op: "~", operand: num(5), type: F64, loc },
    loc,
  });
  return {
    irVersion: 14,
    sourceFile: loc.file,
    entry: "__main",
    functions: [{ name: "__main", params: [], returnType: VOID, locals: [], body, loc }],
  };
}

test("LLVM emits bitwise number operators as native i32 instructions", () => {
  const llvm = emitLlvmModule(fixture());
  expect(llvm).not.toContain(["@", "scr", "_bit_"].join(""));
  expect(llvm).toMatch(/ = and i32 .*?, .*?$/m);
  expect(llvm).toMatch(/ = or i32 .*?, .*?$/m);
  expect(llvm).toMatch(/ = xor i32 .*?, .*?$/m);
  expect(llvm).toMatch(/ = shl i32 .*?, .*?$/m);
  expect(llvm).toMatch(/ = ashr i32 .*?, .*?$/m);
  expect(llvm).toMatch(/ = lshr i32 .*?, .*?$/m);
  expect(llvm).toMatch(/ = and i32 .*?, 31$/m);
  expect(llvm).toMatch(/ = xor i32 .*?, -1$/m);
  expect(llvm).toMatch(/ = uitofp i32 .*? to double$/m);
  expect(llvm).toMatch(/ = sitofp i32 .*? to double$/m);
});

test.each([32, 64] as const)(
  "string zero-length comparisons use the %i-bit byte count only",
  (bits) => {
    const receiver: IrExpr = { kind: "varRef", localId: "text", type: STRING, loc };
    const length: IrExpr = {
      kind: "strIntrinsic",
      method: "length",
      receiver,
      args: [],
      type: F64,
      loc,
    };
    const mod = fixture();
    mod.functions = [
      { name: "__main", params: [], returnType: VOID, locals: [], body: [], loc },
      ...([0, 1] as const).map((number) => ({
        name: `length_${number}`,
        params: [{ name: "text", localId: "text", type: STRING }],
        returnType: BOOL,
        locals: [{ id: "text", name: "text", type: STRING, mutable: false }],
        loc,
        body: [
          {
            kind: "return" as const,
            loc,
            value: {
              kind: "bin" as const,
              op: "===" as const,
              left: length,
              right: { kind: "numLit" as const, value: number, type: F64, loc },
              type: BOOL,
              loc,
            },
          },
        ],
      })),
    ];
    const llvm = emitLlvmModule(mod, { pointerBits: bits });
    const zero = /^define internal [^\n]*@sc_[bf]+_length_0\([^]*?^}/m.exec(llvm)![0];
    const one = /^define internal [^\n]*@sc_[bf]+_length_1\([^]*?^}/m.exec(llvm)![0];
    expect(zero).toContain(`getelementptr inbounds i${bits}`);
    expect(zero).not.toContain("@scr_str_utf16_len");
    expect(one).toContain("@scr_str_utf16_len");
  },
);
