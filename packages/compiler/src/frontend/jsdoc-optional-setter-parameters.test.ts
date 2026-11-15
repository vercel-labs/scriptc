/* TS1051 on a JavaScript setter parameter whose `?` exists only in the
 * JSDoc a setter documents it with (`/** @param {string | null} [next] *\/`).
 * Node parses the executable parameter, which is mandatory, and never reads
 * the comment, so the preflight admits that comment-only optionality. Every
 * executable spelling of the same mistake keeps tsc's diagnostic. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { blockCommentSpansOf, checkPreflight, loadProgram } from "./program-node.js";

function diagnostics(library: string, extension = "js") {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-jsdoc-setter-"));
  writeFileSync(join(directory, "package.json"), '{"type":"module"}');
  writeFileSync(join(directory, `library.${extension}`), library);
  writeFileSync(
    join(directory, "main.ts"),
    'import * as library from "./library.js"; console.log(library);',
  );
  const load = loadProgram(join(directory, "main.ts"));
  try {
    return checkPreflight(load);
  } finally {
    load.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
}

const CLASS_SETTER = `class Store {
  constructor() { this.stored = null; }
  /** @param {string | null} [next] */
  set value(next) { this.stored = next; }
}`;

const OBJECT_SETTER = `const store = {
  stored: null,
  /** @param {string | null} [next] */
  set value(next) { this.stored = next; },
};`;

test.for([
  ["class", CLASS_SETTER],
  ["object literal", OBJECT_SETTER],
])("a JSDoc-optional setter parameter is admitted for a %s", (row) => {
  expect(diagnostics(row[1]!)).toEqual([]);
});

test("a checked JavaScript file also admits a comment-only setter optionality", () => {
  expect(diagnostics(`// @ts-check\n${CLASS_SETTER}`)).toEqual([]);
});

test.for([
  ["a real optional parameter", "set value(next?) { this.stored = next; }"],
  ["a default parameter", "set value(next = null) { this.stored = next; }"],
  ["a rest parameter", "set value(...next) { this.stored = next; }"],
  ["two parameters", "set value(a, b) { this.stored = a; }"],
])("%s keeps the setter diagnostic", (row) => {
  const result = diagnostics(
    `class Store {\n  constructor() { this.stored = null; }\n  ${row[1]!}\n}`,
  );
  expect(result.some((d) => d.code === "SC0001" && d.message.includes("set' accessor"))).toBe(true);
});

test("a real optional parameter beside a documented one keeps its diagnostic", () => {
  // The comment-only span is admitted by location, not by the code: the
  // executable `?` in the same file is a different span and stays reported.
  const result = diagnostics(`class A {
  /** @param {string | null} [next] */
  set documented(next) { this.stored = next; }
}
class B {
  set executable(next?) { this.stored = next; }
}`);
  const optional = result.filter((d) => d.message.includes("cannot have an optional parameter"));
  expect(optional).toHaveLength(1);
});

test("a TypeScript setter keeps tsc's optional-parameter diagnostic", () => {
  const result = diagnostics(
    "class Store {\n  stored: string | null = null;\n  set value(next?: string | null) { this.stored = next ?? null; }\n}",
    "ts",
  );
  expect(result.some((d) => d.message.includes("cannot have an optional parameter"))).toBe(true);
});

test("a dependency can document many setters", () => {
  const bindings = Array.from(
    { length: 64 },
    (_unused, index) => `class Binding${index} {
  constructor() { this.stored = null; }
  /** @param {string | null} [next] */
  set value(next) { this.stored = next; }
}`,
  ).join("\n");
  expect(diagnostics(bindings)).toEqual([]);
});

test("comment indexing over a large comment-free body stays linear", () => {
  // One documented setter makes preflight index its file's block comments,
  // walking every node's leading trivia. Searching the whole text from each
  // span ran to the next opener or the end of the file, and a comment-free
  // body has a span for every node and no opener: this file took about ten
  // seconds to index. Bounded to the span it takes milliseconds; the bound
  // leaves a slow machine an order of magnitude.
  const body = Array.from(
    { length: 64_000 },
    (_, index) => `const value${index} = ${index} + ${index * 2};`,
  );
  const source = `${CLASS_SETTER}\n${body.join("\n")}`;
  const directory = mkdtempSync(join(tmpdir(), "scriptc-jsdoc-setter-"));
  try {
    writeFileSync(join(directory, "package.json"), '{"type":"module"}');
    writeFileSync(join(directory, "library.js"), source);
    writeFileSync(
      join(directory, "main.ts"),
      'import * as library from "./library.js"; console.log(library);',
    );
    const load = loadProgram(join(directory, "main.ts"));
    try {
      const sf = load.program.getSourceFiles().find((file) => file.fileName.endsWith("library.js"));
      expect(sf).toBeDefined();
      const started = performance.now();
      const spans = blockCommentSpansOf(sf!);
      const elapsed = performance.now() - started;
      expect(spans.map(([start, end]) => source.slice(start, end))).toEqual([
        "/** @param {string | null} [next] */",
      ]);
      expect(elapsed).toBeLessThan(1_000);
    } finally {
      load.dispose();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a JSX snapshot and the lowered program agree on the comment spans", () => {
  // The element rewrite moves every offset after it, so the diagnostic spans
  // of the world over the text as written and the world over the rewritten
  // text differ while both SourceFiles carry the file's name. The comment
  // index is keyed by SourceFile identity for exactly this case.
  const directory = mkdtempSync(join(tmpdir(), "scriptc-jsx-setter-"));
  const file = join(directory, "app.jsx");
  writeFileSync(join(directory, "package.json"), '{"type":"module"}');
  writeFileSync(
    join(directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        allowJs: true,
        checkJs: true,
        strict: true,
        jsx: "react-jsx",
        noEmit: true,
      },
    }),
  );
  writeFileSync(
    join(directory, "jsx-types.d.ts"),
    [
      "declare namespace JSX {",
      "  interface IntrinsicElements { div: any }",
      "}",
      'declare module "react/jsx-runtime" {',
      "  export const jsx: any;",
      "  export const jsxs: any;",
      "  export const Fragment: any;",
      "}",
      "",
    ].join("\n"),
  );
  writeFileSync(
    file,
    [
      '/// <reference path="./jsx-types.d.ts" />',
      'const box = <div className="box" />;',
      "class Store {",
      "  /** @param {string | null} [next] */",
      "  set value(next) { console.log(next); }",
      "}",
      "export { box, Store };",
      "",
    ].join("\n"),
  );
  const load = loadProgram(file);
  try {
    expect(load.jsxSources?.get(file)).toBeDefined();
    expect(checkPreflight(load)).toEqual([]);
  } finally {
    load.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});
