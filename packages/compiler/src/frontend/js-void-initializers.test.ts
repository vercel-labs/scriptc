import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, expect, test } from "vitest";
import type { ScrDiagnostic } from "../diagnostics/diagnostic.js";
import { renderDiagnostic } from "../diagnostics/render.js";
import { nodeFrontendServices } from "./services-node.js";
import {
  resetVoidInitializerCasts,
  voidInitializerInsertions,
  voidInitializerShadow,
  withInsertedSpans,
} from "./js-void-initializers.js";

const CAST = "/** @type {any} */ (void 0)";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => resetVoidInitializerCasts());

function casts(source: string, path = "/pkg/index.js") {
  return nodeFrontendServices().voidInitializerCasts(source, path);
}

/** The text the shadow serves for `source`, or undefined when it keeps it. */
function shadow(source: string, path = "/pkg/index.js"): string | undefined {
  return voidInitializerShadow(path, source, (text, file) => casts(text, file));
}

/** Node prints the same for the original and the served module. */
function expectSameOutput(source: string, ext = "cjs"): string {
  const served = shadow(source);
  expect(typeof served).toBe("string");
  const dir = mkdtempSync(join(tmpdir(), "scriptc-void-initializers-"));
  dirs.push(dir);
  const outputs = [source, served!].map((text, i) => {
    const file = join(dir, `m${i}.${ext}`);
    writeFileSync(file, text);
    const r = spawnSync(process.execPath, [file], { encoding: "utf8" });
    expect(r.stderr).toBe("");
    return r.stdout;
  });
  expect(outputs[1]).toBe(outputs[0]);
  return served!;
}

test("a var and a let initialized with void 0 are served as casts", () => {
  const source = `"use strict";
function pick(fn) {
  var val = void 0;
  let other = void 0;
  try { val = fn(1); other = [val]; } catch (err) { return "caught"; }
  return val + "/" + other.length;
}
console.log(pick(function (n) { return "value " + n; }), pick(function () { throw new Error("x"); }));
`;
  const served = expectSameOutput(source);
  expect(served).toBe(
    source
      .replace("var val = void 0;", `var val = ${CAST};`)
      .replace("let other = void 0;", `let other = ${CAST};`),
  );
});

test("every such declarator of a statement, and a for statement's head", () => {
  const source = `var a = void 0, b = 1, c = void 0, d = void "x";
for (var i = void 0, n = 2; (i = (i || 0) + 1) < n; ) a = i;
for (let j = void 0; j !== 1; j = 1) c = "set";
console.log(a, b, c, d, i);
`;
  const served = expectSameOutput(source);
  expect(served.split("\n")[0]).toBe(
    `var a = ${CAST}, b = 1, c = ${CAST}, d = /** @type {any} */ (void "x");`,
  );
  expect(served.split("\n")[1]).toContain(`for (var i = ${CAST}, n = 2;`);
  expect(served.split("\n")[2]).toContain(`for (let j = ${CAST};`);
});

test("the line count never changes and the spans name what was inserted", () => {
  const source = `var a = void 0; var b = 2;\n\nlet c = void 0, d = void 0;\n`;
  const result = casts(source)!;
  expect(result.text.split("\n").length).toBe(source.split("\n").length);
  // Without the spans, the served text is the file as written.
  let written = result.text;
  for (const [start, length] of [...result.inserted].reverse())
    written = written.slice(0, start) + written.slice(start + length);
  expect(written).toBe(source);
  expect(
    result.inserted.map(([start, length]) => result.text.slice(start, start + length)),
  ).toEqual([
    "/** @type {any} */ (",
    ")",
    "/** @type {any} */ (",
    ")",
    "/** @type {any} */ (",
    ")",
  ]);
});

test("the declarators that keep their text", () => {
  for (const source of [
    // const and using are never written again
    `const a = void 0;`,
    // annotated: the annotation types the binding
    `/** @type {string | undefined} */\nvar a = void 0;`,
    `var b = 1, /** @type {string | undefined} */ a = void 0;`,
    // a statement's annotation speaks for its declarators, as in the lowering
    `/** @type {number | undefined} */ var a = void 0, b = void 0;`,
    // patterns and defaults
    `var { a = void 0 } = {};`,
    `var [a = void 0] = [];`,
    `function f(a = void 0) { return a; }`,
    // not an initializer of a declarator
    `var a; a = void 0;`,
    `var o = { a: void 0 };`,
    // parenthesized, and the cast itself
    `var a = (void 0);`,
    `var a = /** @type {any} */ (void 0);`,
    // void of something that is not a literal
    `var a = void f();`,
    `var a = void b;`,
    // the operand on another line
    `var a = void\n0;`,
  ]) {
    expect(casts(source), source).toBeNull();
  }
});

test("a written cast of an earlier declarator annotates no later one", () => {
  const source = `var a = /** @type {any} */ (void 0), b = void 0;`;
  expect(casts(source)!.text).toBe(`var a = /** @type {any} */ (void 0), b = ${CAST};`);
});

test("serving is idempotent: the served text holds no further declarator", () => {
  const served = shadow(`var a = void 0, b = void 0;\nlet c = void 0;\n`)!;
  expect(casts(served)).toBeNull();
});

test("only JavaScript files are served", () => {
  const source = `var a = void 0;\n`;
  for (const path of ["/p/a.ts", "/p/a.tsx", "/p/a.mts", "/p/a.cts", "/p/a.d.ts", "/p/a.json"])
    expect(shadow(source, path), path).toBeUndefined();
  for (const path of ["/p/a.js", "/p/a.cjs", "/p/a.mjs", "/p/a.jsx"])
    expect(shadow(source, path), path).toBe(`var a = ${CAST};\n`);
});

test("a byte order mark is not part of the served text", () => {
  expect(shadow("﻿var a = void 0;")).toBe(`var a = ${CAST};`);
});

test("a diagnostic after a cast on its line is reported at the column as written", () => {
  const file = "/pkg/index.js";
  const source = `function f(g) {\n  var val = void 0; val = g(); return val.missing;\n}\nlet later = void 0;\n`;
  const served = shadow(source, file)!;
  const texts = new Map([[file, served]]);
  const start = served.indexOf("val.missing");
  const diag: ScrDiagnostic = {
    code: "SC2020",
    message: "not supported",
    loc: { file, start, end: start + "val.missing".length },
  };
  const [located] = withInsertedSpans([diag], texts);
  // The frame's lines hold both casts: the diagnostic's line and the line after the next.
  expect(located!.inserted!.length).toBe(2);
  expect(located!.loc).toEqual(diag.loc);
  expect(renderDiagnostic(located!, { text: served })).toBe(
    [
      `${file}:2:39 - error SC2020: not supported`,
      "",
      "  1 | function f(g) {",
      "  2 |   var val = void 0; val = g(); return val.missing;",
      `    | ${" ".repeat(38)}^~~~~~~~~~~`,
      "  3 | }",
    ].join("\n"),
  );
  expect(source.split("\n")[1]!.indexOf("val.missing") + 1).toBe(39);
  // A diagnostic on the cast itself points at the initializer as written.
  const at = served.indexOf("(void 0)");
  const [onCast] = withInsertedSpans(
    [{ ...diag, loc: { file, start: at, end: at + "(void 0)".length } }],
    texts,
  );
  expect(renderDiagnostic(onCast!, { text: served }).split("\n").slice(0, 5)).toEqual([
    `${file}:2:13 - error SC2020: not supported`,
    "",
    "  1 | function f(g) {",
    "  2 |   var val = void 0; val = g(); return val.missing;",
    "    |             ^~~~~~",
  ]);
});

test("a diagnostic of another text of the file keeps its offsets", () => {
  const file = "/pkg/index.js";
  const served = shadow(`var a = void 0; a.b;\n`, file)!;
  const diag: ScrDiagnostic = {
    code: "SC2020",
    message: "not supported",
    loc: { file, start: 3, end: 4 },
  };
  // A text another rewrite made of the file has its own offsets.
  expect(withInsertedSpans([diag], new Map([[file, served + "// more\n"]]))).toEqual([diag]);
  expect(voidInitializerInsertions(file, served)).toHaveLength(2);
  // Files without casts, and lines far from one.
  expect(withInsertedSpans([diag], new Map([["/pkg/other.js", served]]))).toEqual([diag]);
  const far = shadow(`var a = void 0;\n\n\n\nconsole.log(a.b);\n`, "/pkg/far.js")!;
  const farDiag = {
    ...diag,
    loc: { file: "/pkg/far.js", start: far.indexOf("a.b"), end: far.length },
  };
  expect(withInsertedSpans([farDiag], new Map([["/pkg/far.js", far]]))).toEqual([farDiag]);
});
