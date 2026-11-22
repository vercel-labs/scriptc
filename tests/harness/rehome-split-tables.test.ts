import { describe, expect, it } from "vitest";
import {
  assertTableName,
  assertTablePath,
  CHAPTER_NAME,
  EVIDENCE_MODULE,
  PREFIX_NAME,
  splitStatic,
} from "../../scripts/rehome-split-tables.mjs";

// The old single-file shape, one entry per line as the rehome script parses it.
const OLD = `{
  "schemaVersion": 1,
  "chapterPolicies": {
    "http": "unreviewed"
  },
  "evidenceByManifestPrefix": {
    "node-builtin.http": ["tests/corpus/a.ts"]
  },
  "features": [
    { "chapter": "http", "symbols": ["http.request"], "status": "partial", "evidence": ["tests/corpus/a.ts"] }
  ],
  "dedicated": [
    { "symbols": ["writeStream.cursorTo"], "status": "supported", "evidence": ["tests/corpus/b.ts"] }
  ]
}`;

describe("splitStatic names", () => {
  it("splits a normal snapshot into per-module parts", () => {
    const parts = splitStatic(OLD, "test");
    expect([...parts.keys()]).toEqual(
      expect.arrayContaining([
        "static-support/chapter-policies.json",
        "static-support/evidence/http.json",
        "static-support/features/http.json",
        "static-support/dedicated/_unassigned.json",
      ]),
    );
  });

  it("refuses a chapter that would leave the table directory", () => {
    const evil = OLD.replace('"chapter": "http"', '"chapter": "../../../../tmp/evil"');
    expect(() => splitStatic(evil, "test")).toThrow(/unsafe chapter name/);
  });

  it("refuses a chapter with a path separator", () => {
    const evil = OLD.replace('"chapter": "http"', '"chapter": "features/http"');
    expect(() => splitStatic(evil, "test")).toThrow(/unsafe chapter name/);
  });

  it("refuses an evidence prefix that is not one plain segment", () => {
    const evil = OLD.replace('"node-builtin.http"', '"node-builtin.../evil"');
    expect(() => splitStatic(evil, "test")).toThrow(/unsafe evidence module name/);
  });

  it("accepts the real chapter, prefix and module shapes", () => {
    expect(CHAPTER_NAME.test("single-executable-applications")).toBe(true);
    expect(CHAPTER_NAME.test("async_hooks")).toBe(true);
    expect(PREFIX_NAME.test("nodeIsland")).toBe(true);
    expect(PREFIX_NAME.test("mkdtempResult")).toBe(true);
    expect(EVIDENCE_MODULE.test("fs-promises")).toBe(true);
    expect(EVIDENCE_MODULE.test("async_hooks")).toBe(true);
    expect(EVIDENCE_MODULE.test("child_process")).toBe(true);
  });

  it("refuses names with a separator or a parent segment", () => {
    expect(() => assertTableName("chapter", "../http", CHAPTER_NAME)).toThrow(/unsafe/);
    expect(() => assertTableName("chapter", "http/../x", CHAPTER_NAME)).toThrow(/unsafe/);
    expect(() => assertTableName("builtin prefix", "../../x", PREFIX_NAME)).toThrow(/unsafe/);
  });
});

describe("assertTablePath", () => {
  it("accepts the table's own paths", () => {
    expect(assertTablePath("internal/compatibility/static-support/features/http.json")).toBe(
      "internal/compatibility/static-support/features/http.json",
    );
    expect(assertTablePath("packages/compiler/src/ir/builtin-signatures/fs.ts")).toBe(
      "packages/compiler/src/ir/builtin-signatures/fs.ts",
    );
  });

  it("refuses traversal, absolute paths and sibling files", () => {
    expect(() =>
      assertTablePath("internal/compatibility/static-support/features/../../../../tmp/x.json"),
    ).toThrow(/outside the table/);
    expect(() => assertTablePath("/tmp/x.json")).toThrow(/outside the table/);
    expect(() => assertTablePath("packages/compiler/src/ir/builtin-signatures/../ir.ts")).toThrow(
      /outside the table/,
    );
    expect(() => assertTablePath("package.json")).toThrow(/outside the table/);
  });
});
