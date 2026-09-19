import { describe, expect, test } from "vitest";
import { HANDLE_KINDS, POINTER_KINDS, STRING, arrayOf, typeEquals, typeKey } from "./ir.js";

describe("IR kind sets", () => {
  test("keeps procStream as the scalar handle exception", () => {
    expect(HANDLE_KINDS.has("procStream")).toBe(true);
    expect(POINTER_KINDS.has("procStream")).toBe(false);
    for (const kind of HANDLE_KINDS) {
      if (kind !== "procStream") expect(POINTER_KINDS.has(kind)).toBe(true);
    }
  });

  test("distinguishes pointer values from object-like scalars", () => {
    expect(POINTER_KINDS.has("record")).toBe(true);
    expect(POINTER_KINDS.has("date")).toBe(false);
  });

  test("distinguishes typed-rest closure ABIs", () => {
    const packed = arrayOf(STRING);
    const typedRest = {
      kind: "func" as const,
      params: [packed],
      ret: STRING,
      rest: true as const,
      restAbi: "typed" as const,
    };
    const fixed = { kind: "func" as const, params: [packed], ret: STRING };
    expect(typeEquals(typedRest, fixed)).toBe(false);
    expect(typeKey(typedRest)).toBe("func(array<string>,...typed[])=>string");
  });
});
