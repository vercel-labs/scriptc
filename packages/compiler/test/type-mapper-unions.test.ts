import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { loadProgram } from "../src/frontend/program-node.js";
import * as ts from "../src/frontend/ts7/adapter.js";
import {
  mapType,
  ShapeRegistry,
  UnionRegistry,
  withUndefinedArm,
  type TypeMapperCtx,
} from "../src/frontend/type-mapper.js";
import { literalUnionArm } from "../src/frontend/union-discriminants.js";
import { typeEquals, type IrType } from "../src/ir/ir.js";

let directory: string;
let load: ReturnType<typeof loadProgram>;
const aliases = new Map<string, ts.Type>();

beforeAll(() => {
  directory = mkdtempSync(
    join(process.platform === "win32" ? tmpdir() : "/tmp", "scriptc-mapper-unions-"),
  );
  const entry = join(directory, "input.ts");
  writeFileSync(
    entry,
    `
    export type Choice = { kind: "a" | "alias"; value: number } | { kind: "b"; text: string };
    export type Other = { kind: "x"; value: number } | { kind: "y"; text: string };
    export type Numeric = { kind: 0; value: number } | { kind: -2.5; text: string };
    export type BooleanChoice = { kind: false; value: number } | { kind: true; text: string };
    export type Tree = { kind: "leaf"; value: number } | { kind: "branch"; children: Tree[] };
    export type OptionalChoice = Choice | undefined;
    export type OptionalOther = Other | undefined;
    export type OptionalNumeric = Numeric | undefined;
    export type OptionalBooleanChoice = BooleanChoice | undefined;
    export type OptionalTree = Tree | undefined;
    export type NullableChoice = Choice | null | undefined;
    export type Plain = { value: number } | { text: string };
    export type OptionalPlain = Plain | undefined;
    enum MixedEnum { Count = 1, Label = "label" }
    export type EnumValue = MixedEnum;
    export type EnumMember = MixedEnum.Count;
    export type PrimitiveText = "value";
    export type PrimitiveNumber = 1;
    export type PrimitiveBoolean = true;
    export type TemplateText<T extends string> = \`value:\${T}\`;
  `,
  );
  load = loadProgram(entry);
  ts.walkPreorder(load.entry, (node) => {
    if (ts.isTypeAliasDeclaration(node))
      aliases.set(node.name.text, load.program.getTypeChecker().getTypeAtLocation(node.type));
  });
});
afterAll(() => {
  load?.dispose();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

function context(): TypeMapperCtx {
  return {
    checker: load.program.getTypeChecker(),
    shapes: new ShapeRegistry(),
    unions: new UnionRegistry(),
    classNamer: (decl) => decl.name?.text ?? "anonymous",
    dynamic: false,
    typeMemo: new Map(),
    isStdlibFile: (sf) => load.program.isSourceFileDefaultLibrary(sf),
    isNpmFile: () => false,
    isExternalTypeFile: () => false,
    isProgramFile: (sf) => load.moduleOrder.includes(sf),
  };
}
function mapped(name: string, ctx: TypeMapperCtx): IrType & { kind: "union" } {
  const result = mapType(aliases.get(name)!, ctx);
  if (result?.kind !== "union") throw new Error(`${name} did not map to a union`);
  return result;
}

test("primitive mapping preserves template widening and mixed enum member domains", () => {
  const ctx = context();
  ctx.canMemoizeType = () => false;
  for (const dynamic of [false, true]) {
    ctx.dynamic = dynamic;
    expect(mapType(aliases.get("PrimitiveText")!, ctx)).toEqual({ kind: "string" });
    expect(mapType(aliases.get("PrimitiveNumber")!, ctx)).toEqual({ kind: "f64" });
    expect(mapType(aliases.get("PrimitiveBoolean")!, ctx)).toEqual({ kind: "bool" });
    expect(mapType(aliases.get("TemplateText")!, ctx)).toEqual({ kind: "string" });
    const enumType = mapped("EnumValue", ctx);
    expect(mapType(aliases.get("EnumMember")!, ctx)).toEqual(enumType);
    expect(ctx.unions.get(enumType.unionId)!.arms).toEqual([{ kind: "f64" }, { kind: "string" }]);
  }
});

describe("checker and synthesized optional union identity", () => {
  for (const order of ["required-first", "optional-first"]) {
    test.each(["Choice", "Other", "Numeric", "BooleanChoice", "Tree"])(`${order}: %s`, (name) => {
      const ctx = context();
      if (order === "required-first") mapped(name, ctx);
      else mapped(`Optional${name}`, ctx);
      const required = mapped(name, ctx);
      const optional = mapped(`Optional${name}`, ctx);
      const synthesized = withUndefinedArm(required, ctx.unions);
      expect(synthesized).toEqual(optional);
      const original = ctx.unions.get(required.unionId)!;
      const definition = ctx.unions.get(optional.unionId)!;
      expect(definition.discriminant?.field).toBe("kind");
      expect(
        ctx.unions.transform(
          definition,
          definition.arms.filter((arm) => arm.kind !== "undefinedT"),
        ),
      ).toBe(required.unionId);
      for (const variant of original.discriminant!.cases) {
        const arm = literalUnionArm(definition, variant.values, (id) => ctx.shapes.get(id));
        expect(arm).toEqual(original.arms[variant.tag]);
      }
      const count = ctx.unions.unions.length;
      for (let iteration = 0; iteration < 4; iteration++) {
        expect(mapType(aliases.get(name)!, ctx)).toEqual(required);
        expect(withUndefinedArm(required, ctx.unions)).toEqual(optional);
      }
      expect(ctx.unions.unions).toHaveLength(count);
    });
  }

  test("null and undefined can be removed independently without losing record cases", () => {
    const ctx = context();
    const required = mapped("Choice", ctx);
    const optional = mapped("OptionalChoice", ctx);
    const nullable = ctx.unions.get(mapped("NullableChoice", ctx).unionId)!;
    expect(
      ctx.unions.transform(
        nullable,
        nullable.arms.filter((arm) => arm.kind !== "nullT"),
      ),
    ).toBe(optional.unionId);
    expect(
      ctx.unions.transform(
        nullable,
        nullable.arms.filter((arm) => arm.kind !== "nullT" && arm.kind !== "undefinedT"),
      ),
    ).toBe(required.unionId);
    expect(nullable.discriminant!.cases.map((entry) => entry.values)).toEqual([
      ["a", "alias"],
      ["b"],
    ]);
  });

  test("identical storage with different literal contracts never shares a canonical union", () => {
    const ctx = context();
    const first = mapped("Choice", ctx),
      second = mapped("Other", ctx);
    const left = ctx.unions.get(first.unionId)!,
      right = ctx.unions.get(second.unionId)!;
    expect(left.arms).toEqual(right.arms);
    expect(typeEquals(first, second)).toBe(false);
    const optionalLeft = withUndefinedArm(first, ctx.unions),
      optionalRight = withUndefinedArm(second, ctx.unions);
    expect(optionalLeft).not.toEqual(optionalRight);
    expect(literalUnionArm(left, ["x"], (id) => ctx.shapes.get(id))).toBeNull();
    expect(literalUnionArm(right, ["a"], (id) => ctx.shapes.get(id))).toBeNull();
  });

  test("a union without a usable discriminator does not gain one from another mapping", () => {
    const ctx = context();
    mapped("Choice", ctx);
    const plain = mapped("Plain", ctx);
    const optional = mapped("OptionalPlain", ctx);
    expect(withUndefinedArm(plain, ctx.unions)).toEqual(optional);
    expect(ctx.unions.get(plain.unionId)!.discriminant).toBeUndefined();
    expect(ctx.unions.get(optional.unionId)!.discriminant).toBeUndefined();
  });

  test("making a recursive root optional does not rewrite its child storage", () => {
    const ctx = context();
    const tree = mapped("Tree", ctx);
    const original = ctx.unions.get(tree.unionId)!;
    const branch = literalUnionArm(original, ["branch"], (id) => ctx.shapes.get(id))!;
    const children = ctx.shapes
      .get(branch.shapeId)!
      .fields.find((field) => field.name === "children")!.type;
    if (children.kind !== "array") throw new Error("missing recursive array field");
    expect(children.elem).toEqual(tree);
    const optional = withUndefinedArm(tree, ctx.unions);
    expect(optional).not.toEqual(tree);
    expect(children.elem).toEqual(tree);
    expect(ctx.unions.get(tree.unionId)).toBe(original);
    expect(original.arms.some((arm) => arm.kind === "undefinedT")).toBe(false);
  });
});
