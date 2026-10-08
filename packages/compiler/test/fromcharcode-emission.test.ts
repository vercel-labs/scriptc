import { expect, test } from "vitest";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";
import { F64, STRING, VOID, arrayOf, type IrExpr, type IrModule } from "../src/ir/ir.js";
import { validateModule } from "../src/ir/validate.js";

test("scalar fromCharCode avoids a heap argument pack in LLVM", () => {
  const loc = { file: "scalar-char.ts", start: 0, end: 0 };
  const value: IrExpr = { kind: "numLit", value: 65, type: F64, loc };
  const mod: IrModule = {
    irVersion: 15,
    sourceFile: loc.file,
    entry: "__main",
    globals: [],
    functions: [
      {
        name: "__main",
        params: [],
        returnType: VOID,
        locals: [],
        loc,
        body: [
          {
            kind: "exprStmt",
            loc,
            expr: {
              kind: "libCall",
              fn: "string.fromCharCode",
              type: STRING,
              loc,
              args: [{ kind: "arrayLit", elems: [value], type: arrayOf(F64), loc }],
            },
          },
        ],
      },
    ],
  };
  expect(validateModule(mod)).toEqual([]);

  const llvm = emitLlvmModule(mod);

  expect(llvm).toContain("call ptr @scr_str_from_char_code_one(double");

  expect(llvm).not.toContain("call ptr @scr_arr_new(");
});
