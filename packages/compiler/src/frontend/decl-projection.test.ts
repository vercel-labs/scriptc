import { describe, expect, test } from "vitest";
import { applyEdits, isDeclBoundaryFile, isDeclBoundaryTypeName } from "./decl-projection.js";

describe("decl-projection", () => {
  test("applyEdits closes the wrap that opened last first", () => {
    // `x.y` wrapped from 0 (outer) and from 2 (inner), both closing at 5:
    // closing parts rank by their wrap's negated start.
    const out = applyEdits("x = a.b;", [
      { start: 4, end: 4, text: "(" },
      { start: 7, end: 7, text: " as Outer)", rank: -4 },
      { start: 6, end: 6, text: "(" },
      { start: 7, end: 7, text: " as Inner)", rank: -6 },
    ]);
    expect(out).toBe("x = (a.(b as Inner) as Outer);");
  });

  test("applyEdits keeps the first of overlapping replacements and every line", () => {
    const text = "type A = z.infer<typeof S>;\nconst x = 1;";
    const out = applyEdits(text, [
      { start: 9, end: 26, text: "__scriptc_decl_0" },
      { start: 11, end: 16, text: "nope" },
    ]);
    expect(out).toBe("type A = __scriptc_decl_0;\nconst x = 1;");
  });

  test("names", () => {
    expect(isDeclBoundaryTypeName("__scriptc_decl_3")).toBe(true);
    expect(isDeclBoundaryTypeName("Product")).toBe(false);
    expect(isDeclBoundaryFile("/app/src/__scriptc_decl_boundary__.d.ts")).toBe(true);
    expect(isDeclBoundaryFile("/app/src/types.d.ts")).toBe(false);
  });
});
