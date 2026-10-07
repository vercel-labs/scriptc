import { expect, test } from "vitest";
import {
  BOOL,
  F64,
  STRING,
  VOID,
  type IrExpr,
  type IrModule,
  type IrStmt,
  type IrType,
} from "../../ir/ir.js";
import { discriminantTags, recordFieldWrites } from "./discriminant-dispatch.js";
import { emitLlvmModule } from "./emitter.js";

const loc = { file: "discriminants.ts", start: 0, end: 0 };
const shape: IrType = { kind: "union", unionId: "u0" };
const string = (value: string): IrExpr => ({ kind: "strLit", value, type: STRING, loc });
const read: IrExpr = {
  kind: "unionDisc",
  unionId: "u0",
  field: "kind",
  value: { kind: "varRef", localId: "s", type: shape, loc },
  type: STRING,
  loc,
};

/** Arms: r0 owns "circle", r1 owns "square", r2 shares "point"/"origin". */
function module(body: IrStmt[], returnType: IrType, extra: IrStmt[] = []): IrModule {
  const record = (id: string): IrType => ({ kind: "record", shapeId: id });
  return {
    irVersion: 13,
    sourceFile: loc.file,
    entry: "main",
    records: [
      {
        id: "r0",
        fields: [
          { name: "kind", type: STRING },
          { name: "radius", type: F64 },
        ],
      },
      {
        id: "r1",
        fields: [
          { name: "kind", type: STRING },
          { name: "side", type: F64 },
        ],
      },
      {
        id: "r2",
        fields: [
          { name: "kind", type: STRING },
          { name: "x", type: F64 },
        ],
      },
    ],
    unions: [
      {
        id: "u0",
        arms: [record("r0"), record("r1"), record("r2")],
        discriminant: {
          field: "kind",
          cases: [
            { tag: 0, values: ["circle"] },
            { tag: 1, values: ["square"] },
            { tag: 2, values: ["origin", "point"] },
          ],
        },
      },
    ],
    functions: [
      { name: "main", params: [], returnType: VOID, locals: [], body: extra, loc },
      {
        name: "classify",
        params: [{ name: "s", localId: "s", type: shape }],
        returnType,
        locals: [{ id: "s", name: "s", type: shape, mutable: false }],
        body,
        loc,
      },
    ],
  };
}

const classify = (llvm: string) =>
  /^define internal [^\n]*@sc_bf_classify\([^]*?^}/m.exec(llvm)![0];

test("fixed discriminant arms compare by tag and shared arms read the field", () => {
  const llvm = classify(
    emitLlvmModule(
      module(
        [
          {
            kind: "return",
            value: {
              kind: "strEq",
              negated: false,
              left: read,
              right: string("point"),
              type: BOOL,
              loc,
            },
            loc,
          },
        ],
        BOOL,
      ),
    ),
  );
  expect(llvm).toContain("switch i32");
  expect(llvm).toMatch(/phi i1 \[ true, %ude\.t\d+ \], \[ false, %ude\.f\d+ \]/);
  // Only the shared arm reads and compares its string.
  expect(llvm.match(/@scr_str_eq/g)).toHaveLength(1);
  expect(llvm).not.toContain("@scr_str_retain");
});

test("discriminant switches branch fixed arms directly in source order", () => {
  const ret = (value: number): IrStmt => ({
    kind: "return",
    value: { kind: "numLit", value, type: F64, loc },
    loc,
  });
  const llvm = classify(
    emitLlvmModule(
      module(
        [
          {
            kind: "switch",
            disc: read,
            cases: [
              { test: string("square"), body: [ret(1)] },
              { test: string("point"), body: [ret(2)] },
              { test: string("square"), body: [ret(3)] },
              { test: null, body: [ret(4)] },
            ],
            loc,
          },
          ret(0),
        ],
        F64,
      ),
    ),
  );
  // The shared arm compares each literal test; fixed arms branch directly.
  expect(llvm.match(/@scr_str_eq/g)).toHaveLength(3);
  expect(llvm).not.toContain("@scr_str_retain");
});

test("written discriminant fields and keyed writes keep their string reads", () => {
  const write = (stmt: IrStmt) =>
    discriminantTags(
      module([], VOID, [stmt]).unions![0]!,
      "kind",
      (id) => module([], VOID).records!.find((shape) => shape.id === id)!,
      recordFieldWrites(module([], VOID, [stmt])),
    );
  const target: IrExpr = {
    kind: "varRef",
    localId: "r",
    type: { kind: "record", shapeId: "r0" },
    loc,
  };
  expect(
    write({
      kind: "recordSet",
      obj: target,
      shapeId: "r0",
      field: "kind",
      value: string("circle"),
      loc,
    }),
  ).toEqual([null, "square", null]);
  expect(
    write({
      kind: "recordKeySet",
      obj: target,
      shapeId: "r1",
      key: target,
      value: string("x"),
      loc,
    }),
  ).toEqual(["circle", null, null]);
  expect(
    write({
      kind: "recordSet",
      obj: target,
      shapeId: "r0",
      field: "radius",
      value: string("x"),
      loc,
    }),
  ).toEqual(["circle", "square", null]);
});
