import { expect, test, vi } from "vitest";
import {
  F64,
  NULL_T,
  STRING,
  UNDEFINED_T,
  VOID,
  type IrFunction,
  type IrType,
} from "../../ir/ir.js";
import type { Node, Program, SourceFile, Symbol, Type } from "../ts7/adapter.js";
import { Lowerer } from "./lowerer.js";
import { UnionRegistry } from "../type-mapper.js";
import { classMethodValue } from "./class-method-values.js";

const loc = { file: "island.ts", start: 0, end: 1 };
const record = (shapeId: string): IrType => ({ kind: "record", shapeId });
const context = () =>
  new Lowerer({ getTypeChecker: () => ({}) } as Program, { fileName: loc.file } as SourceFile, []);

test("reuses complete copy routes without repeating discriminator planning", () => {
  const lowerer = context();
  const shape = record(lowerer.shapes.intern([{ name: "kind", type: STRING }]));
  const discriminant = { field: "kind", cases: [{ tag: 0, values: ["value"] }] };
  const from = lowerer.unions.intern([shape, UNDEFINED_T], discriminant);
  const to = lowerer.unions.intern([shape, NULL_T], discriminant);
  const plan = vi.spyOn(lowerer, "widthLiftPlan");
  const helper = lowerer.unionRetagHelper(from, to, loc);
  expect(helper).not.toBeNull();
  expect(plan).toHaveBeenCalled();
  plan.mockClear();
  for (let i = 0; i < 20; i++) expect(lowerer.unionRetagHelper(from, to, loc)).toBe(helper);
  expect(plan).not.toHaveBeenCalled();
  expect(lowerer.liftedFns.filter((fn) => fn.name === helper)).toHaveLength(1);
  const recursive = {} as Type;
  lowerer.shapes.recursiveRef(recursive, () => "Recursive");
  lowerer.shapes.finalizeRecursive(recursive, [{ name: "kind", type: STRING }]);
  expect(lowerer.unionRetagHelper(from, to, loc)).toBe(helper);
  expect(plan).toHaveBeenCalled();
});

test("keeps narrowing evidence local to each conversion request", () => {
  const lowerer = context();
  const from = lowerer.unions.intern([F64, STRING, UNDEFINED_T]);
  const to = lowerer.unions.intern([F64, NULL_T]);
  const helper = lowerer.unionRetagHelper(from, to, loc, new Set([1]));
  expect(helper).not.toBeNull();
  expect(lowerer.unionRetagHelper(from, to, loc)).toBeNull();
  expect(lowerer.unionRetagHelper(from, to, loc, new Set([0]))).toBeNull();
  expect(lowerer.unionRetagHelper(from, to, loc, new Set([1]))).toBe(helper);
  expect(lowerer.unionRetagHelper(from, to, loc, new Set([1, 0]))).toBe(helper);
});

test("replans after a recursive union gains its final arms", () => {
  const lowerer = context();
  const recursive = {} as Type;
  const from = lowerer.unions.intern([UNDEFINED_T, NULL_T]);
  const to = lowerer.unions.recursiveRef(recursive, () => "Recursive");
  const trapped = lowerer.unionRetagHelper(from, to, loc);
  expect(trapped).not.toBeNull();
  lowerer.unions.finalizeRecursive(recursive, [UNDEFINED_T]);
  const completed = lowerer.unionRetagHelper(from, to, loc);
  expect(completed).not.toBeNull();
  expect(completed).not.toBe(trapped);
  expect(lowerer.liftedFns.find((fn) => fn.name === completed)?.body).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "if",
        then: expect.arrayContaining([expect.objectContaining({ kind: "return" })]),
      }),
    ]),
  );
});

test("rechecks width conversions after recursive record definitions settle", () => {
  const lowerer = context();
  const recursive = {} as Type;
  const source = record(lowerer.shapes.intern([{ name: "value", type: F64 }]));
  const target = record(lowerer.shapes.recursiveRef(recursive, () => "Recursive"));
  const from = lowerer.unions.intern([source, UNDEFINED_T]);
  const to = lowerer.unions.intern([target, NULL_T]);
  expect(lowerer.unionRetagHelper(from, to, loc)).not.toBeNull();
  lowerer.shapes.finalizeRecursive(recursive, [{ name: "value", type: STRING }]);
  expect(lowerer.unionRetagHelper(from, to, loc)).toBeNull();
});

test("method adapter interning does not inspect unrelated lifted functions", () => {
  const lowerer = context();
  let nameReads = 0;
  for (let i = 0; i < 100; i++) {
    const fn: IrFunction = {
      name: `unrelated.${i}`,
      params: [],
      returnType: VOID,
      locals: [],
      body: [],
      loc,
    };
    Object.defineProperty(fn, "name", {
      get() {
        nameReads++;
        return `unrelated.${i}`;
      },
    });
    lowerer.liftedFns.push(fn);
  }
  const owner = lowerer.classes.get("%Error")!;
  const inherited = lowerer.classes.get("%TypeError")!;
  const first = classMethodValue(lowerer, {} as Node, owner, "toString", loc);
  expect(first).toMatchObject({ kind: "closure" });
  for (let i = 0; i < 20; i++) {
    expect(classMethodValue(lowerer, {} as Node, inherited, "toString", loc)).toEqual(first);
  }
  expect(nameReads).toBe(0);
  expect(lowerer.liftedFns.slice(100)).toHaveLength(2);
});

test("literal ownership is reused across values and rechecked when recursive records close", () => {
  const lowerer = context();
  const shape = record(lowerer.shapes.intern([{ name: "kind", type: STRING }]));
  const union = lowerer.unions.intern([shape, UNDEFINED_T], {
    field: "kind",
    cases: [{ tag: 0, values: ["a", "b"] }],
  });
  const inspect = vi.spyOn(lowerer.shapes, "get");
  expect(lowerer.literalUnionArm(union, ["a"])).toEqual(shape);
  inspect.mockClear();
  for (let i = 0; i < 20; i++) expect(lowerer.literalUnionArm(union, ["b"])).toEqual(shape);
  expect(lowerer.literalUnionArm(union, ["missing"])).toBeNull();
  expect(inspect).not.toHaveBeenCalled();

  const recursive = {} as Type;
  const pendingShape = record(lowerer.shapes.recursiveRef(recursive, () => "Recursive"));
  const pending = lowerer.unions.intern([pendingShape], {
    field: "kind",
    cases: [{ tag: 0, values: ["a"] }],
  });
  expect(lowerer.literalUnionArm(pending, ["a"])).toBeNull();
  lowerer.shapes.finalizeRecursive(recursive, [{ name: "kind", type: STRING }]);
  expect(lowerer.literalUnionArm(pending, ["a"])).toEqual(pendingShape);
  expect(lowerer.literalUnionArm(pending, ["b"])).toBeNull();
});

test("literal ownership sees a recursive union's finalized discriminator", () => {
  const lowerer = context();
  const recursive = {} as Type;
  const union = lowerer.unions.recursiveRef(recursive, () => "Recursive");
  const shape = record(lowerer.shapes.intern([{ name: "kind", type: STRING }]));
  expect(lowerer.literalUnionArm(union, ["ready"])).toBeNull();
  lowerer.unions.finalizeRecursive(recursive, [shape], {
    field: "kind",
    cases: [{ tag: 0, values: ["ready"] }],
  });
  expect(lowerer.literalUnionArm(union, ["ready"])).toEqual(shape);
});

test("removing undefined reuses the discriminator transformation without hiding recursive completion", () => {
  const lowerer = context();
  const a = record(lowerer.shapes.intern([{ name: "kind", type: STRING }]));
  const b = record(
    lowerer.shapes.intern([
      { name: "kind", type: STRING },
      { name: "value", type: F64 },
    ]),
  );
  const union: IrType = {
    kind: "union",
    unionId: lowerer.unions.intern([a, b, UNDEFINED_T], {
      field: "kind",
      cases: [
        { tag: 0, values: ["a"] },
        { tag: 1, values: ["b"] },
      ],
    }),
  };
  const transform = vi.spyOn(lowerer.unions, "transform");
  const stripped = lowerer.stripUndefinedArm(union);
  for (let i = 0; i < 20; i++) expect(lowerer.stripUndefinedArm(union)).toEqual(stripped);
  expect(transform).toHaveBeenCalledTimes(1);
  if (stripped.kind !== "union") throw new Error("expected two remaining arms");
  expect(lowerer.unions.get(stripped.unionId)?.discriminant).toEqual(
    lowerer.unions.get(union.unionId)?.discriminant,
  );

  const recursive = {} as Type;
  const pending: IrType = {
    kind: "union",
    unionId: lowerer.unions.recursiveRef(recursive, () => "Recursive"),
  };
  expect(lowerer.stripUndefinedArm(pending)).toEqual(pending);
  lowerer.unions.finalizeRecursive(recursive, [STRING, UNDEFINED_T]);
  expect(lowerer.stripUndefinedArm(pending)).toEqual(STRING);
  expect(lowerer.stripUndefinedArm(union)).toEqual(stripped);
  expect(transform).toHaveBeenCalledTimes(2);
});

test("adding undefined reuses semantic union transformations and sees recursive completion", () => {
  const lowerer = context();
  const a = record(lowerer.shapes.intern([{ name: "kind", type: STRING }]));
  const b = record(
    lowerer.shapes.intern([
      { name: "kind", type: STRING },
      { name: "value", type: F64 },
    ]),
  );
  const discriminant = {
    field: "kind",
    cases: [
      { tag: 0, values: ["a"] },
      { tag: 1, values: ["b"] },
    ],
  };
  const union: IrType = { kind: "union", unionId: lowerer.unions.intern([a, b], discriminant) };
  const transform = vi.spyOn(lowerer.unions, "transform");
  const added = lowerer.withUndefinedArmOf(union);
  for (let i = 0; i < 20; i++) expect(lowerer.withUndefinedArmOf(union)).toEqual(added);
  expect(transform).toHaveBeenCalledTimes(1);
  if (added?.kind !== "union") throw new Error("expected optional union");
  expect(lowerer.unions.get(added.unionId)?.discriminant).toEqual(discriminant);

  const recursive = {} as Type;
  const pending: IrType = {
    kind: "union",
    unionId: lowerer.unions.recursiveRef(recursive, () => "Recursive"),
  };
  const before = lowerer.withUndefinedArmOf(pending);
  lowerer.unions.finalizeRecursive(recursive, [a, b], discriminant);
  expect(lowerer.withUndefinedArmOf(pending)).toEqual(added);
  expect(lowerer.withUndefinedArmOf(pending)).not.toEqual(before);
  expect(lowerer.withUndefinedArmOf(union)).toEqual(added);
  expect(transform).toHaveBeenCalledTimes(4);
});

test("optional union widening keeps refused and missing contracts current", () => {
  const lowerer = context();
  const recursive = {} as Type;
  const pending: IrType = {
    kind: "union",
    unionId: lowerer.unions.recursiveRef(recursive, () => "Recursive"),
  };
  expect(lowerer.withUndefinedArmOf(pending)).not.toBeNull();
  lowerer.unions.finalizeRecursive(recursive, [{ kind: "promise", inner: F64 }, STRING]);
  expect(lowerer.withUndefinedArmOf(pending)).toBeNull();
  expect(lowerer.withUndefinedArmOf(pending)).toBeNull();

  // Union ids come from their arms, so a fresh registry names the union
  // this one has not interned yet.
  const missing: IrType = { kind: "union", unionId: new UnionRegistry().intern([F64, STRING]) };
  expect(lowerer.withUndefinedArmOf(missing)).toBeNull();
  expect(lowerer.unions.intern([F64, STRING])).toBe(missing.unionId);
  expect(lowerer.withUndefinedArmOf(missing)?.kind).toBe("union");
  expect(lowerer.withUndefinedArmOf(VOID)).toBeNull();
});

test("stdlib provenance is cached by symbol identity, including merged and shadowed declarations", () => {
  const userFile = { fileName: "user.ts" } as SourceFile;
  const library = { fileName: "library.d.ts" } as SourceFile;
  const userDeclaration = { getSourceFile: () => userFile } as Node;
  const libraryDeclaration = { getSourceFile: () => library } as Node;
  let declarationReads = 0;
  const symbolWith = (declarations: readonly Node[]): Symbol =>
    ({
      get declarations() {
        declarationReads++;
        return declarations;
      },
    }) as unknown as Symbol;
  const builtin = symbolWith([userDeclaration, libraryDeclaration]),
    shadow = symbolWith([userDeclaration]);
  const lowerer = new Lowerer({ getTypeChecker: () => ({}) } as unknown as Program, userFile, []);
  vi.spyOn(lowerer, "isStdlibFile").mockImplementation((file) => file === library);
  for (let i = 0; i < 20; i++) {
    expect(lowerer.isStdlibSymbol(builtin)).toBe(true);
    expect(lowerer.isStdlibSymbol(shadow)).toBe(false);
    expect(lowerer.isStdlibSymbol(undefined)).toBe(false);
  }
  expect(declarationReads).toBe(2);
});
