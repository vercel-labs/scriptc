import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { nodeFrontendServices } from "./services-node.js";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function rewrite(source: string): string | null {
  return nodeFrontendServices().namespaceDefaults(source, "/pkg/index.js");
}

/** Node prints the same for the original and the rewritten module. */
function expectSameOutput(source: string): void {
  const result = rewrite(source);
  expect(typeof result).toBe("string");
  const dir = mkdtempSync(join(tmpdir(), "scriptc-namespace-defaults-"));
  dirs.push(dir);
  const outputs = [source, result!].map((text, i) => {
    const file = join(dir, `m${i}.cjs`);
    writeFileSync(file, text);
    const r = spawnSync(process.execPath, [file], { encoding: "utf8" });
    expect(r.status).toBe(0);
    return r.stdout;
  });
  expect(outputs[1]).toBe(outputs[0]);
}

test("a guarded namespace declaration becomes its default", () => {
  const source = `var app = app || {};
app.util = app.util || {};
app.util.twice = function (x) { return 2 * x; };
var cfg = cfg ?? { depth: 1 };
console.log(app.util.twice(3), cfg.depth, Object.keys(app).join(","));
`;
  expect(rewrite(source)).toBe(`var app = {};
app.util = app.util || {};
app.util.twice = function (x) { return 2 * x; };
var cfg = { depth: 1 };
console.log(app.util.twice(3), cfg.depth, Object.keys(app).join(","));
`);
  expectSameOutput(source);
});

test("any other write, declaration or earlier mention keeps the text", () => {
  // Redeclared: the second declaration reads the first one's object.
  expect(rewrite("var ns = ns || {};\nvar ns = ns || {};\n")).toBeNull();
  // Assigned elsewhere, updated, or declared as a function.
  expect(rewrite("var ns = ns || {};\nfunction reset() { ns = {}; }\n")).toBeNull();
  expect(rewrite("var n = n || 0;\nn++;\n")).toBeNull();
  // A local of the same name somewhere in the file.
  expect(rewrite("var ns = ns || {};\nfunction f(ns) { return ns; }\n")).toBeNull();
  // Mentioned by an earlier statement.
  expect(rewrite("console.log(typeof ns);\nvar ns = ns || {};\n")).toBeNull();
  // let and const read their own binding in its temporal dead zone.
  expect(rewrite("let ns = ns || {};\n")).toBeNull();
  // Not the declared name on the left.
  expect(rewrite("var ns = other || {};\n")).toBeNull();
  // Written through a destructuring assignment, here by a hoisted function
  // that runs before the declaration.
  expect(
    rewrite("init();\nvar ns = ns || {};\nfunction init() { [ns] = [{ a: 1 }]; }\n"),
  ).toBeNull();
  expect(
    rewrite("init();\nvar ns = ns || {};\nfunction init() { ({ ns } = { ns: { a: 1 } }); }\n"),
  ).toBeNull();
  expect(rewrite("var ns = ns || {};\nfor ([ns] of [[{}]]);\n")).toBeNull();
});

test("a name the CommonJS wrapper defines keeps the text", () => {
  // `exports` is the module's export object here, not undefined.
  const source = "var exports = exports || {};\nexports.answer = 42;\n";
  expect(rewrite(source)).toBeNull();
  expect(rewrite("var module = module || {};\n")).toBeNull();
  expect(rewrite("var require = require || null;\n")).toBeNull();
});
