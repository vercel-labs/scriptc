import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { nodeFrontendServices } from "./services-node.js";
import { rewriteBundlerCjsExports } from "./npm-static-rewrite.js";
import type { BundledChunkSplit } from "./npm-static-bundled-chunks.js";

const keyedHelper = `var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
`;

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function split(source: string, file = "/pkg/dist/index.js") {
  return nodeFrontendServices().splitCjsChunks(source, file);
}

function run(file: string) {
  const result = spawnSync(process.execPath, [file], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Runs the original bundle and its split modules side by side. */
function expectSameBehavior(source: string): BundledChunkSplit {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-chunks-"));
  dirs.push(dir);
  const original = join(dir, "original.js");
  writeFileSync(original, source);
  const bundle = join(dir, "index.js");
  const result = split(source, bundle);
  expect(result).not.toBeNull();
  expect(result).not.toHaveProperty("degrade");
  const answer = result as BundledChunkSplit;
  writeFileSync(bundle, answer.text);
  for (const chunk of answer.chunks) writeFileSync(chunk.path, chunk.source);
  // Respelled calls and blanked declarations keep the line structure.
  expect(answer.text.split("\n")).toHaveLength(source.split("\n").length);
  const oracle = run(original);
  expect(oracle.status).toBe(0);
  expect(run(bundle)).toEqual(oracle);
  return answer;
}

test("chunks run once, at their first require, with shared module instances", () => {
  const answer = expectSameBehavior(`"use strict";
${keyedHelper}
var require_b = __commonJS({
  "b.js"(exports2, module2) {
    console.log("b init");
    module2.exports = { n: 1 };
  }
});
var require_a = __commonJS({
  "a.js"(exports2) {
    console.log("a init");
    var b = require_b();
    exports2.value = b.n + 1;
    exports2.keys = Object.keys({ exports2 });
  }
});
console.log("start");
console.log(require_a().value, require_a().value, require_b().n, require_a().keys);
`);
  expect(answer.chunks.map((c) => basename(c.path))).toEqual([
    "index.js.require_b.cjs",
    "index.js.require_a.cjs",
  ]);
  expect(answer.text).not.toContain("require_a()");
});

test("the arrow helper form and minified spellings split the same way", () => {
  expectSameBehavior(
    `var __commonJS=(cb,mod)=>()=>(mod||cb((mod={exports:{}}).exports,mod),mod.exports);` +
      `var require_x=__commonJS((exports,module)=>{module.exports={v:"x"}});` +
      `console.log(require_x().v,require_x()===require_x());`,
  );
});

test("esbuild 0.11's Object.keys spelling is recognized", () => {
  expectSameBehavior(`var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[Object.keys(cb)[0]])((mod = {exports: {}}).exports, mod), mod.exports;
};
var require_y = __commonJS({
  "y.js"(exports) {
    exports.y = 3;
  }
});
console.log(require_y().y);
`);
});

test("pure helpers a chunk reads travel with it", () => {
  const answer = expectSameBehavior(`${keyedHelper}var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });
var require_named = __commonJS({
  "named.js"(exports2, module2) {
    module2.exports = __name(function () {}, "renamed");
  }
});
console.log(require_named().name);
`);
  const chunk = answer.chunks[0]!.source;
  expect(chunk).toContain("var __name =");
  expect(chunk).toContain("var __defProp = Object.defineProperty;");
});

test("a helper travels with a chunk whose nested scopes declare its name", () => {
  const answer = expectSameBehavior(`${keyedHelper}function label(n) {
  return "label " + n;
}
function wrap(n) {
  function inner() {
    var label = "inner";
    return label;
  }
  return label(n) + " " + inner();
}
var require_e = __commonJS({
  "e.js"(exports2, module2) {
    function nested() {
      var label = "nested";
      return label;
    }
    var seen = [];
    for (let label of ["loop"]) seen.push(label);
    try {
      throw "caught";
    } catch (label) {
      seen.push(label);
    }
    {
      const label = "block";
      seen.push(label);
    }
    module2.exports = { outer: label(1), indirect: (0, label)(3), wrapped: wrap(2), nested: nested(), seen };
  }
});
var e = require_e();
console.log(e.outer, e.indirect, e.wrapped, e.nested, e.seen.join(","));
`);
  const chunk = answer.chunks[0]!.source;
  expect(chunk).toContain("function label(n)");
  expect(chunk).toContain("function wrap(n)");
});

test("a named function expression that only calls itself travels with a chunk", () => {
  const answer = expectSameBehavior(`${keyedHelper}var fact = function self(n) {
  return n <= 1 ? 1 : n * self(n - 1);
};
var kind = function self(self) {
  return typeof self;
};
var outer = function self() {
  var self = 2;
  return self;
};
var require_g = __commonJS({
  "g.js"(exports2, module2) {
    module2.exports = [fact(5), kind(1), outer()];
  }
});
console.log(require_g().join(","));
`);
  const chunk = answer.chunks[0]!.source;
  expect(chunk).toContain("var fact = function self(n)");
});

test("a helper a parameter default reads travels with a chunk whose body declares its name", () => {
  const answer = expectSameBehavior(`${keyedHelper}var ten = function () {
  return 10;
};
var add = function (n, base = ten()) {
  var ten = 1;
  return n + base + ten;
};
var require_g = __commonJS({
  "g.js"(exports2, module2) {
    module2.exports = add(1);
  }
});
console.log(require_g());
`);
  const chunk = answer.chunks[0]!.source;
  expect(chunk).toContain("var ten = function ()");
});

test.each([
  ["exports it", `function tally() {}`, `module2.exports = { tally };`],
  ["reads its properties", `function tally() {}`, `exports2.calls = tally.calls;`],
  ["constructs it", `function tally() {}`, `exports2.made = new tally();`],
  ["stores an arrow helper", `var tally = () => 1;`, `exports2.fn = tally;`],
  [
    "calls a function that reads its own name as a value",
    `var tally = function self() { self.n = (self.n || 0) + 1; return self.n; };`,
    `exports2.count = tally();`,
  ],
  [
    "calls a function whose parameter default reads its own name",
    `var tally = function self(box = self) { box.n = (box.n || 0) + 1; return box.n; };`,
    `exports2.count = tally();`,
  ],
  [
    "calls a function whose parameter default reads its own name past a body var of that name",
    `var tally = function self(box = self) { var self = 0; box.n = (box.n || 0) + 1; return box.n + self; };`,
    `exports2.count = tally();`,
  ],
])("a chunk that %s keeps the package refused", (_, declaration, statement) => {
  const result = split(`${keyedHelper}${declaration}
var require_f = __commonJS({
  "f.js"(exports2, module2) {
    ${statement}
  }
});
require_f();
`);
  expect(result).toEqual({
    degrade: expect.stringContaining(
      "uses the bundle's top-level function 'tally' as a value",
    ) as string,
  });
});

test.each([
  ["reads its factory's receiver", `console.log(this);`],
  ["reads its factory's arguments object", `console.log(arguments.length);`],
  ["returns from its top level", `if (exports2) return;`],
  ["uses its module object beyond module.exports", `console.log(module2.id);`],
  ["reads __filename", `console.log(__filename);`],
  ["rebinds its module parameters", `function f(module2) { return module2; }`],
  ["reads the bundle's top-level binding 'state'", `console.log(state);`],
])("a chunk that %s keeps the package refused", (reason, statement) => {
  const result = split(`${keyedHelper}var state = { n: 1 };
var require_c = __commonJS({
  "c.js"(exports2, module2) {
    ${statement}
  }
});
require_c();
`);
  expect(result).toEqual({ degrade: expect.stringContaining(reason) as string });
});

test("a factory used other than as a direct call keeps the package refused", () => {
  const result =
    split(`${keyedHelper}var require_d = __commonJS({ "d.js"(exports2) { exports2.d = 1; } });
var load = require_d;
load();
`);
  expect(result).toEqual({
    degrade: expect.stringContaining("used other than as a direct call") as string,
  });
});

test("an unrecognized helper body keeps the package refused", () => {
  const result =
    split(`var __commonJS = (cb, mod) => () => (mod || cb((mod = { exports: {} }).exports, mod), mod);
var require_e = __commonJS((exports) => { exports.e = 1; });
require_e();
`);
  expect(result).toEqual({ degrade: expect.stringContaining("__commonJS helper") as string });
});

test("files without chunks and ES-module bundles are left alone", () => {
  expect(split("exports.x = 1;\n")).toBeNull();
  expect(
    split(`${keyedHelper}var require_f = __commonJS({ "f.js"(e) { e.f = 1; } });
export default require_f();
`),
  ).toBeNull();
});

test("an identifier-minified bundle splits through its helper's shape", () => {
  // esbuild --minify output: the helper shape survives, its name does not.
  const answer = expectSameBehavior(
    `var c=(r,e)=>()=>(e||r((e={exports:{}}).exports,e),e.exports);` +
      `var x=c((t,m)=>{m.exports={v:1}});var y=c(t=>{t.w=x().v+1});` +
      `console.log(x().v,y().w,x()===x());`,
  );
  expect(answer.chunks.map((c) => basename(c.path))).toEqual(["index.js.x.cjs", "index.js.y.cjs"]);
});

test("an ES-module bundle of CommonJS chunks names the chunk interop", () => {
  const result = rewriteBundlerCjsExports(
    `${keyedHelper}var __toESM = (mod) => mod;
var require_g = __commonJS({ "g.js"(exports) { exports.g = 1; } });
var import_g = __toESM(require_g());
export const g = import_g.g;
`,
    "/pkg/dist/index.js",
  );
  expect(result).toEqual({
    degrade: expect.stringContaining("bundled CommonJS modules") as string,
  });
});

test("a chunk that only re-exports a builtin module becomes that module", () => {
  const answer = expectSameBehavior(`${keyedHelper}var require_stream = __commonJS({
  "lib/stream.js"(exports2, module2) {
    module2.exports = require("stream");
  }
});
var require_user = __commonJS({
  "lib/user.js"(exports2) {
    var Stream = require_stream();
    exports2.same = Stream === require("stream");
  }
});
console.log(typeof require_stream().PassThrough, require_user().same);
`);
  expect(answer.chunks.map((c) => basename(c.path))).toEqual(["index.js.require_user.cjs"]);
  expect(answer.text).toContain('typeof require("stream").PassThrough');
});

test("chunks of polyfill packages that are Node builtins become the builtins", () => {
  const key = (name: string, version: string, file: string) =>
    `node_modules/.pnpm/${name}@${version}/node_modules/${name}/${file}`;
  const answer = expectSameBehavior(`${keyedHelper}var require_isarray = __commonJS({
  "${key("isarray", "1.0.0", "index.js")}"(exports2, module2) {
    var toString = {}.toString;
    module2.exports = Array.isArray || function(arr) {
      return toString.call(arr) == "[object Array]";
    };
  }
});
var require_inherits = __commonJS({
  "${key("inherits", "2.0.4", "inherits.js")}"(exports2, module2) {
    module2.exports = require("util").inherits;
  }
});
var require_old = __commonJS({
  "${key("isarray", "3.0.0", "index.js")}"(exports2, module2) {
    module2.exports = function isArray() { return "own"; };
  }
});
var require_user = __commonJS({
  "lib/user.js"(exports2) {
    var isArray = require_isarray();
    var inherits = require_inherits();
    exports2.same = isArray === Array.isArray && inherits === require("util").inherits;
  }
});
console.log(require_user().same, require_isarray()([1]), require_old()());
`);
  expect(answer.chunks.map((c) => basename(c.path))).toEqual([
    "index.js.require_old.cjs",
    "index.js.require_user.cjs",
  ]);
  expect(answer.text).toContain("Array.isArray([1])");
  const user = answer.chunks.find((c) => c.path.endsWith("require_user.cjs"))!;
  expect(user.source).toContain("var isArray = Array.isArray;");
  expect(user.source).toContain('var inherits = require("util").inherits;');
});

test("a polyfill chunk keeps its module when the bundle declares the builtin's global", () => {
  const key =
    "node_modules/.pnpm/process-nextick-args@2.0.1/node_modules/process-nextick-args/index.js";
  const answer = expectSameBehavior(`${keyedHelper}var require_pna = __commonJS({
  "${key}"(exports2, module2) {
    module2.exports = process;
  }
});
var require_user = __commonJS({
  "lib/user.js"(exports2) {
    var process = { local: true };
    var pna = require_pna();
    exports2.same = pna === globalThis.process && process.local;
  }
});
console.log(require_user().same);
`);
  expect(answer.chunks.map((c) => basename(c.path))).toEqual([
    "index.js.require_pna.cjs",
    "index.js.require_user.cjs",
  ]);
  const user = answer.chunks.find((c) => c.path.endsWith("require_user.cjs"))!;
  expect(user.source).not.toContain("var pna = process;");
});

test("a readable-stream 2.x entry chunk follows its uses", () => {
  const key = (file: string) =>
    `node_modules/.pnpm/readable-stream@2.3.8/node_modules/readable-stream/${file}`;
  const chunk = (name: string, file: string, body: string) =>
    `var ${name} = __commonJS({\n  "${key(file)}"(exports2, module2) {\n    ${body}\n  }\n});\n`;
  const result =
    split(`${keyedHelper}${chunk("require_readable", "readable.js", 'module2.exports = require("stream").Readable;')}${chunk("require_transform", "transform.js", "module2.exports = require_readable().Transform;")}
var members = require_readable();
console.log(members.Readable, members.Writable);
var value = require_readable();
console.log(value.from);
var { Duplex } = require_readable();
console.log(require_transform());
`);
  const answer = result as BundledChunkSplit;
  expect(answer.chunks).toEqual([]);
  expect(answer.text).toContain('var members = require("stream");');
  expect(answer.text).toContain('var value = require("stream").Readable;');
  expect(answer.text).toContain('var { Duplex } = require("stream");');
  expect(answer.text).toContain('console.log(require("stream").Transform);');
  // A use the alias cannot answer keeps the package's own module for
  // every call site of that chunk.
  const mixed =
    split(`${keyedHelper}${chunk("require_readable", "readable.js", 'module2.exports = require("stream").Readable;')}
var members = require_readable();
console.log(members.Readable);
var mixed = require_readable();
console.log(mixed.Readable, mixed.from);
`) as BundledChunkSplit;
  expect(mixed.chunks.map((c) => basename(c.path))).toEqual(["index.js.require_readable.cjs"]);
  expect(mixed.text).toContain('var members = require("./index.js.require_readable.cjs");');
  expect(mixed.text).toContain('var mixed = require("./index.js.require_readable.cjs");');
});

test("a bundled copy of a shimmed package's main file requires the package shim", () => {
  const key = (version: string, file: string) =>
    `node_modules/.pnpm/fs-extra@${version}/node_modules/fs-extra/${file}`;
  const result = split(`${keyedHelper}var require_lib = __commonJS({
  "${key("9.0.0", "lib/index.js")}"(exports2, module2) {
    module2.exports = { readFile() { return "bundled"; } };
  }
});
var require_old = __commonJS({
  "${key("7.0.1", "lib/index.js")}"(exports2, module2) {
    module2.exports = { readFile() { return "old"; } };
  }
});
console.log(require_lib().readFile(), require_old().readFile());
`) as BundledChunkSplit;
  const forwarder = result.chunks.find((c) => c.path.endsWith(".shim.d.ts"));
  expect(forwarder?.path).toBe("/pkg/dist/index.js.require_lib.shim.d.ts");
  expect(forwarder?.source).toMatch(/export \* from ".*shims\/fs-extra\/index\.ts";/);
  expect(forwarder?.source).toMatch(/export \{ default \} from ".*shims\/fs-extra\/index\.ts";/);
  expect(result.text).toContain('require("./index.js.require_lib.shim").readFile()');
  // fs-extra 7 has no shim: its chunk stays a module.
  expect(result.chunks.map((c) => basename(c.path))).toContain("index.js.require_old.cjs");
});
