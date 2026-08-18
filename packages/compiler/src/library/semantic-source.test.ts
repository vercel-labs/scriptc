import { expect, test } from "vitest";
import { rebaseSourceLocations, semanticallyEqualSource, semanticSourceDigest } from "./semantic-source.js";

test("ordinary TypeScript comments and formatting preserve semantic identity", () => {
  const before = "// old note\nexport function value(): number { return 1; }\n";
  const after = "/* a longer replacement note */\n\nexport function value(): number { return 1; }\n";
  expect(semanticallyEqualSource("entry.ts", before, after)).toBe(true);
  expect(semanticSourceDigest("entry.ts", before)).toBe(semanticSourceDigest("entry.ts", after));
});

test("directives, pure annotations, JavaScript comments, and tokens remain semantic", () => {
  expect(semanticallyEqualSource(
    "entry.ts",
    "// @ts-expect-error\nconst x: number = 'x';\n",
    "// harmless\nconst x: number = 'x';\n",
  )).toBe(false);
  expect(semanticallyEqualSource(
    "entry.ts",
    "const x = /* @__PURE__ */ make();\n",
    "const x = /* ordinary */ make();\n",
  )).toBe(false);
  expect(semanticallyEqualSource(
    "entry.js",
    "/** @returns {number} */\nexport function value() { return 1; }\n",
    "/* ordinary */\nexport function value() { return 1; }\n",
  )).toBe(false);
  expect(semanticallyEqualSource("entry.ts", "return 1;\n", "return 2;\n")).toBe(false);
});

test("line breaks introduced by comments retain ASI-sensitive identity", () => {
  expect(semanticallyEqualSource(
    "entry.ts",
    "function f() { return /* same line */ value; }\n",
    "function f() { return /* split\nline */ value; }\n",
  )).toBe(false);
});

test("source locations rebase across changed comment trivia", () => {
  const before = "// old\nexport function value() { return 1; }\n";
  const after = "/* much longer\n * note\n */\nexport function value() { return 1; }\n";
  const oldStart = before.indexOf("return");
  const oldEnd = oldStart + "return 1".length;
  const payload = { loc: { file: "/entry.ts", start: oldStart, end: oldEnd } };
  rebaseSourceLocations(payload, new Map([["/entry.ts", before]]), new Map([["/entry.ts", after]]));
  expect(payload.loc.start).toBe(after.indexOf("return"));
  expect(payload.loc.end).toBe(after.indexOf("return") + "return 1".length);
});

test("comment markers inside strings, templates, and regex literals are tokens", () => {
  for (const [before, after] of [
    ['const value = "/* old */";\n', 'const value = "/* new */";\n'],
    ["const value = `// old`;\n", "const value = `// new`;\n"],
    ["const value = /a\\/\\/*old/;\n", "const value = /a\\/\\/*new/;\n"],
  ] as const) {
    expect(semanticallyEqualSource("entry.ts", before, after)).toBe(false);
  }
});
