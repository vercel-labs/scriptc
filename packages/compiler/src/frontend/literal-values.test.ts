import { describe, expect, test } from "vitest";
import { literalValues } from "./literal-values.js";
import { SemanticSnapshot } from "./ts7/semantic-model.js";
import {
  SemanticTypeFlags as TypeFlags,
  type SemanticTypeData,
} from "./ts7/semantic-schema.generated.js";

function harness() {
  const members = new Map<number, SemanticTypeData[]>();
  const reply = (method: string, payload: string) => {
    const query = JSON.parse(payload) as { objectId: number };
    if (method !== "getTypesOfType" || !members.has(query.objectId))
      throw new Error(`unexpected request: ${method}`);
    return JSON.stringify(members.get(query.objectId));
  };
  const snapshot = new SemanticSnapshot(1, {
    text: reply,
    binary: (method, payload) => new TextEncoder().encode(reply(method, payload)),
  });
  const project = snapshot.addProject("literal-values", () => undefined);
  let id = 0;
  const type = (flags: number, value?: string | number | boolean) =>
    project.type({
      id: ++id,
      flags,
      ...(value === undefined ? {} : { value }),
    });
  const union = (parts: SemanticTypeData[]) => {
    parts.forEach((part) => project.type(part));
    const unionId = 1000 + id++;
    members.set(unionId, parts);
    return project.type({ id: unionId, flags: TypeFlags.Union });
  };
  return { type, union };
}

describe("checker literal values", () => {
  test.each(["", "plain", "constructor", "__proto__", "\u0000", "line\nfeed", "é😀"])(
    "retains string %j exactly",
    (value) => {
      const { type } = harness();
      expect(literalValues(type(TypeFlags.StringLiteral, value))).toEqual([value]);
    },
  );

  test.each([0, -0, -2.5, Number.MAX_VALUE, Number.MIN_VALUE])(
    "retains finite number %s",
    (value) => {
      const { type } = harness();
      const result = literalValues(type(TypeFlags.NumberLiteral, value));
      expect(result).toEqual([value]);
      expect(Object.is(result![0], value)).toBe(true);
    },
  );

  test.each([true, false])("retains boolean %s without truthiness conversion", (value) => {
    const { type } = harness();
    expect(literalValues(type(TypeFlags.BooleanLiteral, value))).toEqual([value]);
  });

  test.each([NaN, Infinity, -Infinity])("refuses nonfinite number %s", (value) => {
    const { type } = harness();
    expect(literalValues(type(TypeFlags.NumberLiteral, value))).toBeNull();
  });

  test.each([
    TypeFlags.String,
    TypeFlags.Number,
    TypeFlags.Boolean,
    TypeFlags.BigInt,
    TypeFlags.Any,
    TypeFlags.Unknown,
    TypeFlags.Never,
    TypeFlags.Void,
    TypeFlags.Null,
    TypeFlags.Undefined,
    TypeFlags.ESSymbol,
    TypeFlags.Object,
    TypeFlags.TypeParameter,
    TypeFlags.TemplateLiteral,
  ])("refuses nonliteral flag %s", (flags) => {
    const { type } = harness();
    expect(literalValues(type(flags))).toBeNull();
  });

  test("preserves each scalar kind in a finite union", () => {
    const { union } = harness();
    const type = union([
      { id: 1, flags: TypeFlags.StringLiteral, value: "1" },
      { id: 2, flags: TypeFlags.NumberLiteral, value: 1 },
      { id: 3, flags: TypeFlags.BooleanLiteral, value: false },
      { id: 4, flags: TypeFlags.StringLiteral, value: "false" },
    ]);
    expect(literalValues(type)).toEqual(["1", 1, false, "false"]);
    expect(literalValues(type)).toEqual(["1", 1, false, "false"]);
  });

  test("refuses an empty union instead of claiming a known variant", () => {
    expect(literalValues(harness().union([]))).toBeNull();
  });

  test.each([
    TypeFlags.String,
    TypeFlags.Number,
    TypeFlags.Undefined,
    TypeFlags.Unknown,
    TypeFlags.Object,
  ])("one nonliteral union member (%s) invalidates the complete candidate set", (flags) => {
    const { union } = harness();
    expect(
      literalValues(
        union([
          { id: 1, flags: TypeFlags.StringLiteral, value: "first" },
          { id: 2, flags },
          { id: 3, flags: TypeFlags.StringLiteral, value: "last" },
        ]),
      ),
    ).toBeNull();
  });

  test("does not return the finite prefix before an infinite member", () => {
    const { union } = harness();
    expect(
      literalValues(
        union([
          { id: 1, flags: TypeFlags.NumberLiteral, value: 1 },
          { id: 2, flags: TypeFlags.NumberLiteral, value: Infinity },
        ]),
      ),
    ).toBeNull();
  });

  test("excludes bigint literals from the scalar discriminator ABI", () => {
    const { type } = harness();
    expect(
      literalValues(type(TypeFlags.BigIntLiteral, "123456789012345678901234567890")),
    ).toBeNull();
  });
});
