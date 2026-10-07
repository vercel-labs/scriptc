import { expect, test } from "vitest";
import { F64, STRING, VOID, type IrExpr, type IrModule, type IrType } from "../../ir/ir.js";
import { immutableBoxes } from "./immutable-boxes.js";

const loc = { file: "boxes.ts", start: 0, end: 0 };
const fnType: IrType = { kind: "func", params: [], ret: STRING };
const read = (localId: string): IrExpr => ({ kind: "varRef", localId, type: STRING, loc });

function fixture(childWrites: boolean): IrModule {
  return {
    irVersion: 13,
    sourceFile: loc.file,
    entry: "main",
    functions: [
      {
        name: "main",
        params: [{ name: "label", localId: "label", type: STRING }],
        returnType: VOID,
        locals: [
          { id: "label", name: "label", type: STRING, mutable: true, boxed: true },
          { id: "count", name: "count", type: F64, mutable: true, boxed: true },
        ],
        body: [
          {
            kind: "varDecl",
            localId: "count",
            init: { kind: "numLit", value: 0, type: F64, loc },
            loc,
          },
          {
            kind: "exprStmt",
            expr: {
              kind: "closure",
              fnName: "%child",
              captures: ["label", "count"],
              type: fnType,
              loc,
            },
            loc,
          },
        ],
        loc,
      },
      {
        name: "%child",
        params: [],
        returnType: STRING,
        captures: [
          { name: "label", localId: "label.c", type: STRING },
          { name: "count", localId: "count.c", type: F64 },
        ],
        locals: [
          { id: "label.c", name: "label", type: STRING, mutable: true, boxed: true },
          { id: "count.c", name: "count", type: F64, mutable: true, boxed: true },
        ],
        body: [
          {
            kind: "exprStmt",
            expr: { kind: "incDec", op: "+", prefix: false, localId: "count.c", type: F64, loc },
            loc,
          },
          ...(childWrites
            ? [{ kind: "assign" as const, localId: "label.c", value: read("label.c"), loc }]
            : []),
          { kind: "return", value: read("label.c"), loc },
        ],
        loc,
      },
    ],
  };
}

test("capture groups are immutable only when no member is ever written", () => {
  expect([...immutableBoxes(fixture(false))].sort()).toEqual(["%child\0label.c", "main\0label"]);
  // A write through the child's capture invalidates the declaring box too.
  expect([...immutableBoxes(fixture(true))]).toEqual([]);
});

test("class-captured bindings keep owning reads", () => {
  const mod = fixture(false);
  mod.functions[1]!.classCaptures = [{ name: "label", localId: "label.c", type: STRING, slot: 0 }];
  expect([...immutableBoxes(mod)]).toEqual([]);
});
