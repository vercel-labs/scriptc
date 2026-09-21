import { expect, test } from "vitest";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";
import { F64, VOID, type IrExpr, type IrModule, type IrNumBinOp } from "../src/ir/ir.js";
import { validateModule } from "../src/ir/validate.js";

const loc = { file: "bitwise.ts", start: 0, end: 0 };
const ref = (localId: string): IrExpr => ({ kind: "varRef", localId, type: F64, loc });

function fixture(expr: IrExpr): IrModule {
  return {
    irVersion: 10,
    sourceFile: loc.file,
    entry: "__main",
    functions: [
      { name: "__main", params: [], returnType: VOID, locals: [], body: [], loc },
      {
        name: "bits",
        params: [
          { localId: "a", name: "a", type: F64 },
          { localId: "b", name: "b", type: F64 },
        ],
        returnType: F64,
        locals: [
          { id: "a", name: "a", type: F64, mutable: false },
          { id: "b", name: "b", type: F64, mutable: false },
        ],
        body: [{ kind: "return", value: expr, loc }],
        loc,
      },
    ],
  };
}

test.each([
  ["&", "and"], ["|", "or"], ["^", "xor"],
  ["<<", "shl"], [">>", "ashr"], [">>>", "lshr"],
] as const)("emits integer %s without out-of-line bitwise helpers", (op, instruction) => {
  const mod = fixture({ kind: "bin", op: op as IrNumBinOp, left: ref("a"), right: ref("b"), type: F64, loc });
  validateModule(mod);
  const llvm = emitLlvmModule(mod);
  expect(llvm).not.toContain("@scr_bit_");
  expect(llvm).toMatch(new RegExp(`= ${instruction} i32 `));
  expect(llvm).toContain(op === ">>>" ? "uitofp i32" : "sitofp i32");
  if (op === "<<" || op === ">>" || op === ">>>") {
    expect(llvm).toMatch(/= and i32 %\w+, 31/);
  }
  // Conversion stays guarded and keeps the modular/nonfinite slow path;
  // an unconditional fptosi would turn valid JS inputs into LLVM poison.
  expect(llvm).toContain("fcmp oge double");
  expect(llvm).toContain("fcmp ole double");
  expect(llvm).toContain("frem double");
  expect(llvm).toContain("bytes.coerce.nonfinite");
});

test("emits bitwise not as an integer xor with signed numeric result", () => {
  const mod = fixture({ kind: "unary", op: "~", operand: ref("a"), type: F64, loc });
  validateModule(mod);
  const llvm = emitLlvmModule(mod);
  expect(llvm).not.toContain("@scr_bit_");
  expect(llvm).toMatch(/= xor i32 %\w+, -1/);
  expect(llvm).toContain("sitofp i32");
});
