import { expect, test } from "vitest";
import {
  F64,
  NULL_T,
  UNDEFINED_T,
  type IrModule,
  type IrType,
  type IrUnionDef,
} from "../../ir/ir.js";
import { isObjectArm, isPointerIdentityArm, NullableUnions } from "./nullable-unions.js";

const loc = { file: "nullable-unions.ts", start: 0, end: 0 };
const a: IrType = { kind: "record", shapeId: "a" };
const b: IrType = { kind: "record", shapeId: "b" };
const c: IrType = { kind: "record", shapeId: "c" };

function module(unions: IrUnionDef[], extra: Partial<IrModule> = {}): IrModule {
  return {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "main",
    records: ["a", "b", "c"].map((id) => ({ id, fields: [{ name: id, type: F64 }] })),
    unions,
    functions: [],
    ...extra,
  };
}

test("unions of two or more records become shape unions", () => {
  const unions = new NullableUnions(
    module([
      { id: "ab", arms: [a, b] },
      { id: "abu", arms: [a, UNDEFINED_T, b] },
      { id: "abnu", arms: [a, b, NULL_T, UNDEFINED_T] },
      { id: "af", arms: [a, F64] },
      { id: "au", arms: [a, UNDEFINED_T] },
    ]),
  );
  expect(unions.shapes("ab")).toMatchObject({ unitTag: -1, nullTag: -1 });
  expect(unions.shapes("abu")).toMatchObject({ unitTag: 1, nullTag: -1 });
  expect(unions.shapes("abnu")).toMatchObject({ unitTag: 3, nullTag: 2 });
  expect(unions.shapes("abnu")?.arms).toEqual([
    { tag: 0, shapeId: "a" },
    { tag: 1, shapeId: "b" },
  ]);
  // A scalar arm keeps the box; one record arm is a single-arm nullable.
  expect(unions.get("af")).toBeNull();
  expect(unions.single("au")).not.toBeNull();
  expect(unions.shapes("au")).toBeNull();
  // Tagged shapes number from 2 and move their fields after the word.
  expect([unions.shapeNumber("a"), unions.shapeNumber("b"), unions.shapeNumber("c")]).toEqual([
    2, 3, 0,
  ]);
  expect([unions.fieldBase("a"), unions.fieldBase("c")]).toEqual([2, 1]);
  expect(unions.boxedUnions(new Map([["af", { id: "af", arms: [a, F64] }]])).size).toBe(1);
});

test("records of runtime-inspected unions keep every union over them boxed", () => {
  const set: IrType = { kind: "set", elem: { kind: "union", unionId: "abf" } };
  const unions = new NullableUnions(
    module(
      [
        { id: "abf", arms: [a, b, F64] },
        { id: "ab", arms: [a, b] },
        { id: "abu", arms: [a, b, UNDEFINED_T] },
        { id: "bc", arms: [b, c] },
        { id: "ac", arms: [a, c] },
      ],
      { globals: [{ id: "%g.s", name: "s", type: set, mutable: false }] },
    ),
  );
  expect(unions.get("abf")).toBeNull();
  expect(unions.get("ab")).toBeNull();
  expect(unions.get("abu")).toBeNull();
  expect(unions.get("bc")).toBeNull();
  expect(unions.get("ac")).toBeNull();
  expect(unions.shapeNumber("c")).toBe(0);
});

test("unions of records alone stay shape unions as Map keys and Set elements", () => {
  const set: IrType = { kind: "set", elem: { kind: "union", unionId: "ab" } };
  const map: IrType = { kind: "map", key: { kind: "union", unionId: "abc" }, value: F64 };
  const unions = new NullableUnions(
    module(
      [
        { id: "ab", arms: [a, b] },
        { id: "abc", arms: [a, b, c] },
        { id: "ba", arms: [b, a] },
        { id: "abu", arms: [a, b, UNDEFINED_T] },
      ],
      {
        globals: [
          { id: "%g.s", name: "s", type: set, mutable: false },
          { id: "%g.m", name: "m", type: map, mutable: false },
        ],
      },
    ),
  );
  expect(unions.shapes("ab")).not.toBeNull();
  expect(unions.shapes("abc")).not.toBeNull();
  expect(unions.shapes("abu")).not.toBeNull();
  // Unions over the same records share one release and trace helper.
  expect(unions.helperOwner("ba")).toBe("ab");
  expect(unions.helperOwner("abu")).toBe("ab");
  expect(unions.helperOwner("abc")).toBe("abc");
});

test("library, lifetime-region and debug builds keep record unions boxed", () => {
  const unions = [{ id: "ab", arms: [a, b] }];
  expect(new NullableUnions(module(unions), false).get("ab")).toBeNull();
  expect(new NullableUnions(module(unions, { lifetimeRegions: true })).get("ab")).toBeNull();
  expect(new NullableUnions(module(unions)).shapes("ab")).not.toBeNull();
});

test("function arms are nullable pointers compared by identity root", () => {
  const fn: IrType = { kind: "func", params: [F64], ret: F64 };
  const unions = new NullableUnions(
    module([
      { id: "fu", arms: [fn, UNDEFINED_T] },
      { id: "fnu", arms: [NULL_T, fn, UNDEFINED_T] },
      { id: "ff", arms: [fn, F64] },
    ]),
  );
  expect(unions.single("fu")).toMatchObject({ refTag: 0, unitTag: 1, nullTag: -1, arm: fn });
  expect(unions.single("fnu")).toMatchObject({ refTag: 1, unitTag: 2, nullTag: 0 });
  expect(unions.get("ff")).toBeNull();
  const single = unions.single("fu")!;
  // Always truthy, but `===` compares adapters by the function they adapt.
  expect(isObjectArm(single)).toBe(true);
  expect(isPointerIdentityArm(single)).toBe(false);
  expect(unions.armTypes().get("fu")).toEqual(fn);
});

test("typed array arms are nullable pointers compared by identity", () => {
  const i32: IrType = { kind: "bytes", elem: "i32" };
  const unions = new NullableUnions(
    module([
      { id: "iu", arms: [i32, UNDEFINED_T] },
      { id: "nin", arms: [NULL_T, i32, UNDEFINED_T] },
      { id: "if", arms: [i32, F64] },
    ]),
  );
  expect(unions.single("iu")).toMatchObject({ refTag: 0, unitTag: 1, nullTag: -1, arm: i32 });
  expect(unions.single("nin")).toMatchObject({ refTag: 1, unitTag: 2, nullTag: 0, arm: i32 });
  expect(unions.get("if")).toBeNull();
  expect(isObjectArm(unions.single("iu")!)).toBe(true);
  expect(isPointerIdentityArm(unions.single("iu")!)).toBe(true);
});
