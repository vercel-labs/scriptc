import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { checkPreflight, loadProgram } from "../program-node.js";
import { closeSourceParser } from "../ts7/source-parser-node.js";
import { Lowerer } from "./lowerer.js";
import { cjsExportsReceiverMembers } from "./cjs-exports-receiver.js";

afterAll(closeSourceParser);

/** The receiver members for a call of `name` through the exports object of
 * a CommonJS module with this source. */
function membersOf(
  source: string,
  name: string,
  extra: Record<string, string> = {},
): string[] | null {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-cjs-receiver-"));
  writeFileSync(join(dir, "main.cjs"), source);
  for (const [file, text] of Object.entries(extra)) writeFileSync(join(dir, file), text);
  const load = loadProgram(join(dir, "main.cjs"));
  try {
    checkPreflight(load);
    const lowerer = new Lowerer(load.program, load.entry, load.moduleOrder);
    return cjsExportsReceiverMembers(lowerer, lowerer.entry, name);
  } finally {
    load.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
}

const style = `
exports.plan = function (o) { return exports.waits(o); };
exports.waits = function (o) { return [this.waitFor(0, o), this.waitFor(1, o)]; };
exports.waitFor = function (attempt, o) { return o.base * attempt; };
`;

test("a function that reads only sibling exports through 'this' gets them as its receiver", () => {
  expect(membersOf(style, "waits")).toEqual(["waitFor"]);
});

test("the receiver holds what every function of the module reads through 'this'", () => {
  const source = `
exports.a = function () { return this.b(2); };
exports.b = function (n) { return this.c * n; };
exports.c = 21;
exports.d = 1;
`;
  expect(membersOf(source, "a")).toEqual(["b", "c"]);
  expect(membersOf(source, "b")).toEqual(["b", "c"]);
});

test("exports that call each other through 'this' are followed once", () => {
  const source = `
exports.a = function (n) { return n ? this.b(n - 1) : 0; };
exports.b = function (n) { return this.a(n); };
`;
  expect(membersOf(source, "a")).toEqual(["a", "b"]);
});

test("module.exports members and a require before the first export are part of the style", () => {
  const source = `
var other = require("./other.cjs");
module.exports.scale = 3;
module.exports.times = function (n) { return this.scale * n + other.n; };
`;
  expect(membersOf(source, "times", { "other.cjs": "exports.n = 0;" })).toEqual(["scale"]);
});

test.each([
  [
    "passes the receiver on",
    "exports.f = function () { return count(this); };\nfunction count(o) { return o; }",
  ],
  [
    "writes through the receiver",
    "exports.n = 0;\nexports.f = function () { this.n = 1; return this.n; };",
  ],
  ["updates through the receiver", "exports.n = 0;\nexports.f = function () { return this.n++; };"],
  ["reads a computed member", "exports.n = 0;\nexports.f = function (k) { return this[k]; };"],
  [
    "reads in an arrow function",
    "exports.n = 0;\nexports.f = function () { return () => this.n; };",
  ],
  ["is async", "exports.n = 0;\nexports.f = async function () { return this.n; };"],
  ["is a generator", "exports.n = 0;\nexports.f = function* () { yield this.n; };"],
  [
    "calls an export that passes the receiver on",
    "exports.g = function () { return [this]; };\nexports.f = function () { return this.g(); };",
  ],
  [
    "calls an export that is another function's name",
    "function g() { return this; }\nexports.g = g;\nexports.f = function () { return this.g(); };",
  ],
  [
    "calls a name the module does not export",
    "exports.f = function () { return this.missing(); };",
  ],
])("the refusal stays when the function %s", (_what, source) => {
  expect(membersOf(source, "f")).toBeNull();
});

test.each([
  ["assigns an export inside a function", "exports.set = function (v) { exports.n = v; };"],
  ["replaces module.exports", "module.exports = { n: 1 };"],
  ["uses the exports object as a value", "Object.keys(exports);"],
  ["reads top-level 'this'", "var self = this;"],
  ["updates an export", "exports.n++;"],
  ["deletes an export", "delete exports.n;"],
  ["writes an export through a pattern", "[exports.n] = [1];"],
])("the refusal stays when the module %s", (_what, statement) => {
  const source = `exports.n = 0;\nexports.f = function () { return this.n; };\n${statement}\n`;
  expect(membersOf(source, "f")).toBeNull();
});

test.each([
  [
    "a call before the last export",
    "exports.f = function () { return this.n; };\nvar early = exports.f();\nexports.n = 0;",
  ],
  [
    "a require after the first export",
    'exports.f = function () { return this.n; };\nvar other = require("./other.cjs");\nexports.n = other.n;',
  ],
  [
    "an export computed by a call",
    "exports.f = function () { return this.n; };\nexports.n = Number(1);",
  ],
  [
    "a loop before the last export",
    "exports.f = function () { return this.n; };\nfor (;;) break;\nexports.n = 0;",
  ],
])("the refusal stays when the module's top-level code has %s", (_what, source) => {
  expect(membersOf(source, "f", { "other.cjs": "exports.n = 0;" })).toBeNull();
});

test("top-level code after the last export may run anything", () => {
  const source = `
exports.f = function () { return this.n; };
exports.n = 2;
console.log(exports.f());
`;
  expect(membersOf(source, "f")).toEqual(["n"]);
});

test("a nested function's own 'this' is not the export's", () => {
  const source = `
exports.n = 2;
exports.f = function (list) {
  var base = this.n;
  return list.map(function (x) { return this === undefined ? base : x + base; });
};
`;
  expect(membersOf(source, "f")).toEqual(["n"]);
});
