import { expect, test } from "vitest";
import { BOOL, F64, STRING, VOID, type IrExpr, type IrModule, type IrType } from "../../ir/ir.js";
import { validateModule } from "../../ir/validate.js";
import { emitLlvmModule } from "./emitter.js";

const loc = { file: "intern-tables.ts", start: 0, end: 1 };

function module(body: IrExpr[]): IrModule {
  return {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "main",
    functions: [
      {
        name: "main",
        params: [],
        returnType: VOID,
        locals: [],
        body: body.map((expr) => ({ kind: "exprStmt" as const, expr, loc })),
        loc,
      },
    ],
  };
}

function body(llvm: string, name: string): string {
  const start = llvm.indexOf(`@${name}(`);
  return start < 0 ? "" : llvm.slice(start, llvm.indexOf("\n}", start));
}

const intrinsic = (name: string, args: IrExpr[], type: IrType): IrExpr =>
  ({ kind: "intrinsic", name, args, type, loc }) as IrExpr;
const str = (value: string): IrExpr => ({ kind: "strLit", value, type: STRING, loc });
const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });

test("InternTable's intrinsics call the runtime and read value slots directly", () => {
  const table = intrinsic("itable.open", [str("t"), num(0)], F64);
  const found = intrinsic("itable.find", [table, str("k")], F64);
  const inserted = intrinsic("itable.insert", [table, str("k"), num(2)], F64);
  const calls = [
    intrinsic("itable.value", [found], F64),
    intrinsic("itable.value", [inserted], STRING),
    intrinsic("itable.size", [table], F64),
    intrinsic("itable.find", [intrinsic("itable.open", [str("n"), num(1)], F64), num(1)], F64),
    intrinsic(
      "itable.find",
      [
        intrinsic("itable.open", [str("a"), num(2)], F64),
        {
          kind: "arrayLit",
          elems: [num(1), num(2)],
          type: { kind: "array", elem: F64 },
          loc,
        } as IrExpr,
      ],
      F64,
    ),
  ];
  expect(validateModule(module(calls))).toEqual([]);
  const main = body(emitLlvmModule(module(calls), { pointerBits: 64 }), "sc_f_main");
  expect(main).toMatch(/call ptr @scr_itable_open\(ptr @\S+, i32 %\S+\)/);
  expect(main).toMatch(/call ptr @scr_itable_find_str\(ptr %\S+, ptr @\S+\)/);
  expect(main).toMatch(/call ptr @scr_itable_insert_str\(ptr %\S+, ptr @\S+, i64 %\S+\)/);
  expect(main).toMatch(/call ptr @scr_itable_find_f64\(ptr %\S+, double \S+\)/);
  expect(main).toMatch(/call double @scr_itable_size\(ptr %\S+\)/);
  expect(main).toMatch(/call ptr @scr_itable_find_arr\(ptr %\S+, ptr %\S+\)/);
  // Entry handles reach their load through memory (x86 FastISel folds
  // inttoptr of a bitcast double into the address without moving it out
  // of its XMM register at -O0).
  expect(main).toMatch(
    /store double (%\S+), ptr (%\S+)\n {2}(%\S+) = load i64, ptr \2\n {2}(%\S+) = inttoptr i64 \3 to ptr\n {2}%\S+ = load i64, ptr \4, align 8/,
  );
});

test("the validator checks InternTable intrinsic operands", () => {
  const table = intrinsic("itable.open", [str("t"), num(0)], F64);
  const bad = [
    intrinsic("itable.open", [num(0), num(0)], F64),
    intrinsic("itable.find", [table, { kind: "boolLit", value: true, type: BOOL, loc }], F64),
    intrinsic("itable.insert", [table, str("k")], F64),
    intrinsic("itable.size", [table], STRING),
  ];
  expect(validateModule(module(bad)).map((e) => e.message)).toEqual([
    "in main: itable.open takes a string name and an f64 key kind",
    "in main: itable.find key must be string, f64, or an array of either",
    "in main: itable.insert takes 3 arguments",
    "in main: itable.size has type f64",
  ]);
});
