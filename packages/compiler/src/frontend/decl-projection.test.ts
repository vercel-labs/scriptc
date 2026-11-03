import { describe, expect, test } from "vitest";
import {
  applyEdits,
  collectProjectionTypeQueries,
  isDeclBoundaryFile,
  isDeclBoundaryTypeName,
} from "./decl-projection.js";
import type { Node } from "./ts7/ast-types.js";
import { getTextOfNode } from "./ts7/node-functions.js";
import { closeSourceParser, parseSourceFile } from "./ts7/source-parser-node.js";

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

  test("the type-query batch list is exactly what the walk reads", () => {
    const source = [
      'import { util } from "pkg";',
      "export type Named = util.Thing;",
      "export function make(size: number) { return size; }",
      "const value = make(2);",
      "value.count = util.read();",
      "util?.read();",
      "util.read(value);",
      "for (const item of [value]) make(item);",
    ].join("\n");
    const file = parseSourceFile("input.ts", source, "ts");
    try {
      // The same tree in both worlds: the walk pairs the node at each index
      // with its twin, so the two lists must select the same positions.
      const queries = collectProjectionTypeQueries(file, file);
      const texts = (nodes: readonly Node[]): string[] => nodes.map((node) => getTextOfNode(node));
      expect(queries.decl.length).toBe(queries.js.length);
      queries.decl.forEach((node, index) => expect(node).toBe(queries.js[index]));
      // Read: an identifier, a call and a read expression the gates admit,
      // including declaration and parameter names the walk asks about.
      // Not read: type positions (`util.Thing`), a callee, a write target,
      // a property name, an optional chain link, a bare statement call.
      expect(texts(queries.js)).toEqual([
        "Named",
        "make",
        "size",
        "size",
        "value",
        "make(2)",
        "value",
        "util.read()",
        "util",
        "util",
        "value",
        "item",
        "value",
        "item",
      ]);
    } finally {
      closeSourceParser();
    }
  });
});
