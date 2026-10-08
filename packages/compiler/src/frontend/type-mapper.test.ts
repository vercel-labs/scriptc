import { describe, expect, test } from "vitest";
import {
  F64,
  NULL_T,
  STRING,
  UNDEFINED_T,
  VOID,
  mapOf,
  setOf,
  type IrType,
  type IrUnionDef,
} from "../ir/ir.js";
import {
  formatIrType,
  genResultRecord,
  ShapeRegistry,
  UnionRegistry,
  withUndefinedArm,
} from "./type-mapper.js";
import type { Type } from "./ts7/adapter.js";

describe("union arm lookup", () => {
  test("indexes large unions while preserving exact equality for colliding function keys", () => {
    const unions = new UnionRegistry();
    const ordinary: IrType = { kind: "func", params: [], ret: VOID };
    const explicit: IrType = { kind: "func", params: [], ret: VOID, argumentsAll: true };
    const arms: IrType[] = [
      ordinary,
      explicit,
      ...Array.from({ length: 12 }, (_, i): IrType => ({ kind: "record", shapeId: `r${i}` })),
    ];
    const union = unions.intern(arms);
    for (let i = 0; i < arms.length; i++) expect(unions.armTag(union, arms[i]!)).toBe(i);
    expect(unions.armTag(union, { kind: "func", params: [], ret: VOID, restAbi: "typed" })).toBe(
      -1,
    );
    expect(unions.armTag(union, STRING)).toBe(-1);
    expect(unions.armTag("missing", STRING)).toBe(-1);
  });

  test("sees finalized recursive arms after a missing lookup", () => {
    const unions = new UnionRegistry();
    const recursive = {} as Type;
    const union = unions.recursiveRef(recursive);
    expect(unions.armTag(union, STRING)).toBe(-1);
    unions.finalizeRecursive(recursive, [
      F64,
      STRING,
      ...Array.from({ length: 10 }, (_, i): IrType => ({ kind: "record", shapeId: `r${i}` })),
    ]);
    expect(unions.armTag(union, STRING)).toBe(1);
    expect(unions.armTag(union, { kind: "record", shapeId: "r9" })).toBe(11);
  });
});

describe("nullable collection union builders", () => {
  test.each([mapOf(STRING, F64), setOf(STRING)])(
    "optional %j fields and generator results share the same union",
    (type) => {
      const shapes = new ShapeRegistry();
      const unions = new UnionRegistry();
      const optional = withUndefinedArm(type, unions);
      expect(optional?.kind).toBe("union");
      if (optional?.kind !== "union") throw new Error("missing union");
      expect(unions.get(optional.unionId)?.arms).toContainEqual(type);
      expect(unions.get(optional.unionId)?.arms).toContainEqual(UNDEFINED_T);
      expect(withUndefinedArm(optional, unions)).toEqual(optional);
      const result = genResultRecord(type, VOID, shapes, unions);
      expect(result).not.toBeNull();
      expect(
        shapes.get(result!.shapeId)?.fields.find((field) => field.name === "value")?.type,
      ).toEqual(optional);
    },
  );

  test.each([
    [mapOf(STRING, F64), STRING],
    [setOf(STRING), F64],
  ])("collection generator results retain each data arm", (yieldT, retT) => {
    const shapes = new ShapeRegistry();
    const unions = new UnionRegistry();
    const result = genResultRecord(yieldT, retT, shapes, unions);
    const value =
      result && shapes.get(result.shapeId)?.fields.find((field) => field.name === "value")?.type;
    expect(value?.kind).toBe("union");
    if (value?.kind !== "union") throw new Error("missing value union");
    expect(unions.get(value.unionId)?.arms).toEqual(
      expect.arrayContaining([yieldT, retT, UNDEFINED_T]),
    );
  });

  test("promise generators retain the data-sibling refusal", () => {
    expect(
      genResultRecord(
        { kind: "promise", inner: STRING },
        F64,
        new ShapeRegistry(),
        new UnionRegistry(),
      ),
    ).toBeNull();
  });
});

describe("IR type diagnostics", () => {
  test("preserves small types, repeated sibling shapes, and array precedence", () => {
    const shapes = new ShapeRegistry();
    const unions = new UnionRegistry();
    const record: IrType = {
      kind: "record",
      shapeId: shapes.intern([{ name: "value", type: F64 }]),
    };
    const union: IrType = { kind: "union", unionId: unions.intern([F64, STRING]) };
    const callback: IrType = { kind: "func", params: [record, record], ret: union };
    expect(formatIrType({ kind: "array", elem: callback }, shapes, unions)).toBe(
      "(({ value: number }, { value: number }) => number | string)[]",
    );
    expect(formatIrType({ kind: "array", elem: union }, shapes, unions)).toBe(
      "(number | string)[]",
    );
    expect(
      formatIrType({ kind: "map", key: STRING, value: { kind: "set", elem: F64 } }, shapes, unions),
    ).toBe("Map<string, Set<number>>");
    expect(
      formatIrType(
        { kind: "generator", async: true, yieldT: record, retT: VOID, nextT: F64 },
        shapes,
        unions,
      ),
    ).toBe("AsyncGenerator<{ value: number }, void, number>");
  });

  test("breaks recursive record/union paths without hiding later siblings", () => {
    const shapes = new ShapeRegistry();
    const unions = new UnionRegistry();
    const record: IrType = { kind: "record", shapeId: shapes.intern([]) };
    const union: IrType = { kind: "union", unionId: unions.intern([record, STRING]) };
    shapes.get(record.shapeId)!.fields.push({ name: "next", type: union });
    const seen = new Set<string>();
    expect(
      formatIrType({ kind: "func", params: [record, record], ret: VOID }, shapes, unions, seen),
    ).toBe("({ next: ... | string }, { next: ... | string }) => void");
    expect(seen.size).toBe(0);
  });

  test("keeps numeric tuple order, accessor spelling, and index signatures", () => {
    const shapes = new ShapeRegistry();
    const unions = new UnionRegistry();
    const tuple = shapes.intern(
      [
        { name: "10", type: STRING },
        { name: "2", type: F64 },
        { name: "0", type: VOID },
      ],
      true,
    );
    expect(formatIrType({ kind: "record", shapeId: tuple }, shapes, unions)).toBe(
      "[void, number, string]",
    );
    const shapeId = shapes.intern(
      [
        { name: "%get:value", type: { kind: "func", params: [], ret: F64 } },
        { name: "%set:value", type: { kind: "func", params: [F64], ret: VOID } },
      ],
      false,
      STRING,
    );
    expect(formatIrType({ kind: "record", shapeId }, shapes, unions)).toBe(
      "{ get value(): number; set value(number); [key: string]: string }",
    );
  });

  test("bounds expansion of a shared acyclic type graph", () => {
    const shapes = new ShapeRegistry();
    const unions = new UnionRegistry();
    let type: IrType = STRING;
    // Only sixteen shapes, but naive expansion repeats the leaf 65,536 times.
    for (let i = 0; i < 16; i++) {
      type = {
        kind: "record",
        shapeId: shapes.intern([
          { name: "left", type },
          { name: "right", type },
        ]),
      };
    }
    const seen = new Set<string>();
    const text = formatIrType(type, shapes, unions, seen);
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(text).toMatch(/^\{ left: \{ left:/);
    expect(text.endsWith("...")).toBe(true);
    expect(seen.size).toBe(0);
    expect(formatIrType(type, shapes, unions, seen)).toBe(text);
  });

  test("bounds deeply nested wrappers without overflowing the stack", () => {
    let type: IrType = STRING;
    for (let i = 0; i < 10_000; i++) type = { kind: "promise", inner: type };
    const text = formatIrType(type, new ShapeRegistry(), new UnionRegistry());
    expect(text.startsWith("Promise<Promise<")).toBe(true);
    expect(text).toContain("...");
    expect(text.length).toBeLessThanOrEqual(4096);
  });

  test("stops visiting wide unions and bounds long names", () => {
    const shapes = new ShapeRegistry();
    const unions = new UnionRegistry();
    const id = unions.intern([]);
    const arms = unions.get(id)!.arms;
    for (let i = 0; i < 2000; i++) arms.push(STRING);
    // Formatting must stop before reaching this arm, not slice a completed string.
    Object.defineProperty(arms, 1999, {
      get() {
        throw new Error("visited after output was full");
      },
    });
    const text = formatIrType({ kind: "union", unionId: id }, shapes, unions);
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(text.endsWith("...")).toBe(true);
    const longName = formatIrType(
      { kind: "object", className: "x".repeat(10_000) },
      shapes,
      unions,
    );
    expect(longName.length).toBeLessThanOrEqual(4096);
    expect(longName.endsWith("...")).toBe(true);
  });
});

describe("union discriminator identity", () => {
  test("equal storage layouts retain independent literal contracts", () => {
    const registry = new UnionRegistry();
    const arms: IrType[] = [
      { kind: "record", shapeId: "empty" },
      { kind: "record", shapeId: "value" },
    ];
    const first = {
      field: "kind",
      cases: [
        { tag: 0, values: ["empty"] },
        { tag: 1, values: ["value"] },
      ],
    };
    const second = {
      field: "kind",
      cases: [
        { tag: 0, values: ["none"] },
        { tag: 1, values: ["some"] },
      ],
    };
    const a = registry.intern(arms, first);
    const b = registry.intern(arms, second);
    const plain = registry.intern(arms);
    expect(a).not.toBe(b);
    expect(a).not.toBe(plain);
    expect(registry.intern(arms, structuredClone(first))).toBe(a);
    expect(registry.get(a)?.discriminant).toEqual(first);
    expect(registry.get(b)?.discriminant).toEqual(second);
    expect(registry.get(plain)?.discriminant).toBeUndefined();
  });

  test("primitive literal kinds are not conflated", () => {
    const registry = new UnionRegistry();
    const arms: IrType[] = [
      { kind: "record", shapeId: "a" },
      { kind: "record", shapeId: "b" },
    ];
    const numeric = registry.intern(arms, {
      field: "tag",
      cases: [
        { tag: 0, values: [1] },
        { tag: 1, values: [2] },
      ],
    });
    const string = registry.intern(arms, {
      field: "tag",
      cases: [
        { tag: 0, values: ["1"] },
        { tag: 1, values: ["2"] },
      ],
    });
    const bool = registry.intern(arms, {
      field: "tag",
      cases: [
        { tag: 0, values: [false] },
        { tag: 1, values: [true] },
      ],
    });
    expect(new Set([numeric, string, bool]).size).toBe(3);
  });
});

describe("canonical optional unions", () => {
  function fixture() {
    const registry = new UnionRegistry();
    const arms: IrType[] = [
      { kind: "record", shapeId: "a" },
      { kind: "record", shapeId: "b" },
    ];
    const id = registry.intern(arms, {
      field: "kind",
      cases: [
        { tag: 0, values: ["empty", "none"] },
        { tag: 1, values: ["value"] },
      ],
    });
    return { registry, arms, id, source: registry.get(id)! };
  }

  test("adding and removing undefined recovers the semantic union identity", () => {
    const { registry, arms, id, source } = fixture();
    const required: IrType = { kind: "union", unionId: id };
    const optional = withUndefinedArm(required, registry);
    if (optional?.kind !== "union") throw new Error("missing optional union");
    const definition = registry.get(optional.unionId)!;
    expect(definition.arms).toEqual([...arms, UNDEFINED_T]);
    expect(definition.discriminant).toEqual(source.discriminant);
    expect(withUndefinedArm(optional, registry)).toBe(optional);
    expect(
      registry.transform(
        definition,
        definition.arms.filter((arm) => arm.kind !== "undefinedT"),
      ),
    ).toBe(id);
    expect(registry.unions).toHaveLength(2);
  });

  test("structural and semantic optional unions stay distinct", () => {
    const { registry, arms, source } = fixture();
    const structural = registry.intern([...arms, UNDEFINED_T]);
    const semantic = registry.transform(source, [...arms, UNDEFINED_T]);
    expect(semantic).not.toBe(structural);
    expect(registry.get(structural)!.discriminant).toBeUndefined();
    expect(registry.get(semantic)!.discriminant).toEqual(source.discriminant);
  });

  test("independent literal contracts retain distinct optional identities", () => {
    const { registry, arms, source } = fixture();
    const otherId = registry.intern(arms, {
      field: "kind",
      cases: [
        { tag: 0, values: ["missing"] },
        { tag: 1, values: ["present"] },
      ],
    });
    const first = registry.transform(source, [...arms, UNDEFINED_T]);
    const second = registry.transform(registry.get(otherId)!, [...arms, UNDEFINED_T]);
    expect(first).not.toBe(second);
    expect(registry.transform(registry.get(second)!, arms)).toBe(otherId);
    expect(registry.transform(registry.get(first)!, arms)).toBe(source.id);
  });

  test("scalar insertion shifts every semantic tag without reassigning aliases", () => {
    const { registry, arms, source } = fixture();
    const wide = registry.transform(source, [F64, NULL_T, ...arms, STRING, UNDEFINED_T]);
    expect(registry.get(wide)!.discriminant).toEqual({
      field: "kind",
      cases: [
        { tag: 2, values: ["empty", "none"] },
        { tag: 3, values: ["value"] },
      ],
    });
    const narrow = registry.transform(registry.get(wide)!, [arms[1]!, UNDEFINED_T]);
    expect(registry.get(narrow)!.discriminant).toEqual({
      field: "kind",
      cases: [{ tag: 0, values: ["value"] }],
    });
    expect(registry.transform(registry.get(wide)!, arms)).toBe(source.id);
  });

  test("adding a record discards an incomplete semantic contract", () => {
    const { registry, arms, source } = fixture();
    const combined = [...arms, { kind: "record" as const, shapeId: "new" }];
    expect(registry.transform(source, combined)).toBe(registry.intern(combined));
    expect(registry.get(registry.transform(source, combined))!.discriminant).toBeUndefined();
  });

  test("transformed case arrays do not alias source metadata", () => {
    const { registry, arms, source } = fixture();
    const transformed = registry.get(registry.transform(source, [...arms, UNDEFINED_T]))!;
    expect(transformed.discriminant).not.toBe(source.discriminant);
    expect(transformed.discriminant!.cases).not.toBe(source.discriminant!.cases);
    expect(transformed.discriminant!.cases[0]!.values).not.toBe(
      source.discriminant!.cases[0]!.values,
    );
  });

  test("plain scalar and undiscriminated record transformations remain plain", () => {
    const registry = new UnionRegistry();
    for (const arms of [
      [F64, STRING],
      [{ kind: "record", shapeId: "a" } as IrType, NULL_T],
    ]) {
      const plain: IrUnionDef = registry.get(registry.intern(arms))!;
      const optional = withUndefinedArm({ kind: "union", unionId: plain.id }, registry);
      if (optional?.kind !== "union") throw new Error("missing optional union");
      expect(registry.get(optional.unionId)!.discriminant).toBeUndefined();
      expect(registry.transform(registry.get(optional.unionId)!, arms)).toBe(plain.id);
    }
  });
});
