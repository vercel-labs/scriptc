import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { compile } from "../src/index.js";

// A library in the pre-module idiom: guarded namespace declarations, a
// revealing module, an ES5 constructor with prototype methods, and the
// cases that keep an object from being constant.
const packageSource = `
var lib = lib || {};
lib.math = lib.math || {};
lib.math.TAU = 6.283185307179586;
lib.math.half = function (x) { return x / 2; };
lib.text = (function () {
  function upper(s) { return s.toUpperCase(); }
  return { upper: upper };
})();
lib.Point = function (x, y) { this.x = x; this.y = y; };
lib.Point.prototype.norm = function () { return Math.sqrt(this.x * this.x + this.y * this.y); };
lib.counter = { hits: 0 };
lib.bump = function () { lib.counter.hits++; };
lib.cache = { table: null };
lib.lookup = function () { return lib.cache.table || (lib.cache.table = [1, 2, 3]); };
lib.scratch = { a: 1, b: 2 };
delete lib.scratch.b;
lib.shared = { value: 1 };
globalThis.sharedFromLib = lib.shared;
function option(name) { return { name: name }; }
lib.options = { first: option("a"), second: option("b") };
module.exports = { lib };
`;

const mainSource = `
const { lib } = require("ns-fixture");
let total = 0;
for (let i = 0; i < 3; i++) {
  total += lib.math.half(i) + new lib.Point(i, i).norm() + lib.lookup().length;
  lib.bump();
}
console.log(total, lib.text.upper("x"), lib.counter.hits);
`;

let dir: string;
let saved: string | undefined;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "scriptc-constant-graphs-"));
  const pkg = join(dir, "node_modules", "ns-fixture");
  await mkdir(pkg, { recursive: true });
  await writeFile(
    join(pkg, "package.json"),
    JSON.stringify({ name: "ns-fixture", version: "1.0.0", main: "index.js", types: "index.d.ts" }),
  );
  await writeFile(join(pkg, "index.js"), packageSource);
  await writeFile(join(pkg, "index.d.ts"), "declare const lib: any;\nexport { lib };\n");
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ dependencies: { "ns-fixture": "1.0.0" } }),
  );
  await writeFile(join(dir, "main.cjs"), mainSource);
  saved = process.env["SCRIPTC_DEBUG_SHAPES"];
});
afterEach(async () => {
  if (saved === undefined) delete process.env["SCRIPTC_DEBUG_SHAPES"];
  else process.env["SCRIPTC_DEBUG_SHAPES"] = saved;
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

async function report(): Promise<string[]> {
  process.env["SCRIPTC_DEBUG_SHAPES"] = "const";
  const lines: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    for (const l of text.split("\n")) if (l.startsWith("[shapes] ")) lines.push(l.slice(9));
    return true;
  });
  await compile(join(dir, "main.cjs"), {
    outDir: dir,
    outPath: join(dir, "main.ir.json"),
    outputKind: "ir",
    npmStatic: ["ns-fixture"],
  });
  return lines;
}

test("constant graphs: namespaces, revealing modules and prototypes, with near misses", async () => {
  const lines = await report();
  const text = lines.join("\n");
  // The namespace graph: guarded declarations, the revealing module's
  // table, and the constructor function.
  // `lib.math` is stored after `lib` was created, so a read of it may see
  // undefined first; its object is a graph of its own.
  expect(text).toMatch(
    /graph ns-fixture\/index\.js:\d+ \{lib: \{math: undefined\|\{\}@ns-fixture\/index\.js:\d+, text: \{upper: fn\}/,
  );
  expect(text).toMatch(/graph ns-fixture\/index\.js:\d+ \{TAU: number, half: fn\}/);
  // The constructor's prototype object, built by member stores at init.
  expect(text).toMatch(/graph ns-fixture\/index\.js:\d+ \{constructor: \{\}, norm: fn\}/);
  // A field written by a function called from a loop.
  expect(text).toMatch(/near miss ns-fixture\/index\.js:12 \.hits: written-after-init/);
  // A lazily filled cache.
  expect(text).toMatch(/near miss ns-fixture\/index\.js:14 \.table: lazy-cache/);
  // A deleted key, and an object stored into the global object.
  expect(text).toMatch(/near miss ns-fixture\/index\.js:16: reflective-write \(delete/);
  expect(text).toMatch(/near miss ns-fixture\/index\.js:18: escapes/);
  // A factory called from two init sites is analyzed per call site: each
  // call allocates its own constant object.
  expect(text).not.toMatch(/init-factory/);
  // (7 objects without per-site clones: the two options were one.)
  expect(text).toMatch(/ns-fixture: 9 constant objects/);
});

// Functions that one call site runs repeatedly: an ES5 constructor and an
// apply call in a loop, and builtin callbacks that run once per element,
// match or parsed value.
const repeatedSource = `
var lib = {};
lib.newState = { v: 0 };
function bumpNew() { lib.newState.v++; }
bumpNew();
lib.applyState = { v: 0 };
function bumpApply() { lib.applyState.v++; }
bumpApply();
lib.repeat = function () { for (var i = 0; i < 3; i++) { new bumpNew(); bumpApply.apply(null, []); } };
lib.seen = { match: null, pair: null, mapped: null, key: null };
lib.replaced = "a-b".replace(/\\\\w/g, function (m) { lib.seen.match = { m: m }; return m; });
lib.sorted = [3, 1, 2].toSorted(function (a, b) { lib.seen.pair = { a: a }; return a - b; });
lib.mapped = Array.from([1, 2], function (x) { lib.seen.mapped = { x: x }; return x; });
lib.revived = JSON.parse('{"a":{"b":1}}', function (k, v) { lib.seen.key = { k: k }; return v; });
module.exports = { lib };
`;

test("constant graphs: constructors, apply calls and callbacks that one site runs repeatedly", async () => {
  await writeFile(join(dir, "node_modules", "ns-fixture", "index.js"), repeatedSource);
  await writeFile(
    join(dir, "main.cjs"),
    'const { lib } = require("ns-fixture");\nlib.repeat();\nconsole.log(lib.newState.v, lib.applyState.v, lib.replaced, lib.sorted, lib.mapped, lib.revived);\n',
  );
  const text = (await report()).join("\n");
  // `new bumpNew()` and `bumpApply.apply(...)` in a loop write after init.
  expect(text).toMatch(/near miss ns-fixture\/index\.js:3 \.v: written-after-init/);
  expect(text).toMatch(/near miss ns-fixture\/index\.js:6 \.v: written-after-init/);
  // Each callback runs once per match, comparison, element or parsed value.
  for (const field of ["match", "pair", "mapped", "key"])
    expect(text).toMatch(
      new RegExp(`near miss ns-fixture/index\\.js:10 \\.${field}: written-after-init`),
    );
});

// A prototype method stored under a computed key and called on instances.
const computedMethodSource = `
var lib = {};
lib.touched = { count: 0 };
lib.Widget = function () {};
var methodName = ["to", "uch"].join("");
lib.Widget.prototype[methodName] = function () { lib.touched.count++; };
lib.useWidget = function () { new lib.Widget().touch(); };
module.exports = { lib };
`;

test("constant graphs: prototype methods stored under computed keys run on their instances", async () => {
  await writeFile(join(dir, "node_modules", "ns-fixture", "index.js"), computedMethodSource);
  await writeFile(
    join(dir, "main.cjs"),
    'const { lib } = require("ns-fixture");\nfor (let i = 0; i < 3; i++) lib.useWidget();\nconsole.log(lib.touched.count);\n',
  );
  const text = (await report()).join("\n");
  expect(text).toMatch(/near miss ns-fixture\/index\.js:3 \.count: written-after-init/);
});
