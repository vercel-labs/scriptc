import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { nodeFrontendServices } from "./services-node.js";

const helpers = `var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __create = Object.create;
var __getProtoOf = Object.getPrototypeOf;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
`;

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function lower(source: string, file = "/pkg/dist/index.js") {
  return nodeFrontendServices().lowerEsmInits(source, file);
}

function run(file: string) {
  const result = spawnSync(process.execPath, [file], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function expectSameBehavior(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-esm-inits-"));
  dirs.push(dir);
  const original = join(dir, "original.js");
  const lowered = join(dir, "index.js");
  writeFileSync(original, source);
  const result = lower(source, lowered);
  expect(typeof result).toBe("string");
  writeFileSync(lowered, result as string);
  const oracle = run(original);
  expect(oracle.status).toBe(0);
  expect(run(lowered)).toEqual(oracle);
  return result as string;
}

const lazyModule = `
function helper(x) { COUNT++; return "[" + x + "]"; }
var COUNT;
var init_helper = __esm({
  "src/helper.ts"() {
    console.log("helper init");
    COUNT = 0;
  }
});
var lazy_exports = {};
__export(lazy_exports, {
  VALUE: () => VALUE,
  value: () => value
});
function value() {
  return VALUE + ":" + COUNT + ":" + import_os.default.EOL.length;
}
var path, import_os, VALUE;
var init_lazy = __esm({
  "src/lazy.ts"() {
    path = __toESM(require("path"));
    import_os = __toESM(require("os"));
    init_helper();
    console.log("lazy init");
    VALUE = helper(path.basename("/a/b.txt"));
  }
});
`;

test("initializers run once, at their first call, and namespaces read live bindings", () => {
  const lowered = expectSameBehavior(`"use strict";
${helpers}${lazyModule}
console.log("start");
function load() {
  const lazy = (init_lazy(), __toCommonJS(lazy_exports));
  return lazy.value() + " " + lazy.VALUE;
}
console.log(load());
COUNT = 5;
console.log(load(), (init_lazy(), __toCommonJS(lazy_exports)).value());
`);
  expect(lowered).not.toContain("__esm({");
  expect(lowered).not.toContain("import_os");
  expect(lowered).toContain('(require("os")).EOL');
});

test("calls of exported functions that never read their own `this` still lower", () => {
  const lowered = expectSameBehavior(`${helpers}var t_exports = {};
__export(t_exports, { plain: () => plain, inner: () => inner });
function plain(x) { return "plain " + x; }
function inner() {
  function own() { return typeof this; }
  return "inner " + own.call(1);
}
var init_t = __esm({ "t.ts"() {} });
const t = (init_t(), __toCommonJS(t_exports));
console.log(t.plain(1), (t.plain)(2), t.inner());
`);
  expect(lowered).not.toContain("__toCommonJS(t_exports)");
});

test.each([
  ["a direct call", `NS.who()`],
  ["a parenthesized callee", `(NS.who)()`],
  ["a tagged template", "NS.who`x`"],
  ["a call through a local", `(() => { const m = NS; return m.who(); })()`],
  ["an arrow inside the function", `NS.arrow()()`],
])("%s that passes the namespace as `this` keeps the package refused", (_, use) => {
  const result = lower(`${helpers}var w_exports = {};
__export(w_exports, { who: () => who, arrow: () => arrow });
function who() { return this.__esModule; }
function arrow() { return () => this; }
var init_w = __esm({ "w.ts"() {} });
console.log(${use.replaceAll("NS", "(init_w(), __toCommonJS(w_exports))")});
`);
  expect(result).toEqual({
    degrade: expect.stringContaining(
      "calls only of exported functions that do not read 'this'",
    ) as string,
  });
});

test("an export that reads `this` in a parameter's default value keeps the package refused", () => {
  const result = lower(`${helpers}var p_exports = {};
__export(p_exports, { who: () => who });
function who(value = this.__esModule) { return value; }
var init_p = __esm({ "p.ts"() {} });
console.log((init_p(), __toCommonJS(p_exports)).who());
`);
  expect(result).toEqual({
    degrade: expect.stringContaining(
      "calls only of exported functions that do not read 'this'",
    ) as string,
  });
});

test("minified initializers sharing a var statement lower the same way", () => {
  expectSameBehavior(
    helpers +
      `var x_exports={};__export(x_exports,{v:()=>v});var v,import_path,init_x=__esm({"x.ts"(){"use strict";import_path=__toESM(require("path")),v=import_path.default.sep}});` +
      `console.log((init_x(),__toCommonJS(x_exports)).v);`,
  );
});

test("memoized lazy loaders sharing a var statement lower together", () => {
  const lowered = expectSameBehavior(`${helpers}var a_exports = {};
__export(a_exports, { v: () => v });
var v, init_a = __esm({ "a.ts"() { console.log("a init"); v = 1; } });
var b_exports = {};
__export(b_exports, { default: () => w });
var w, init_b = __esm({ "b.ts"() { console.log("b init"); w = 2; } });
var nsA, loadA = () => nsA ??= (init_a(), __toCommonJS(a_exports)), nsB, loadB = () => nsB ??= __toESM((init_b(), __toCommonJS(b_exports)));
console.log(loadA().v, loadB().default, loadA().v);
`);
  expect(lowered).not.toContain("loadA");
  expect(lowered).not.toContain("loadB");
});

test("calls through a memoized lazy loader keep the receiver rule", () => {
  const source = (use: string): string => `${helpers}var w_exports = {};
__export(w_exports, { who: () => who, plain: () => plain });
function who() { return this.__esModule; }
function plain(x) { return "plain " + x; }
var init_w = __esm({ "w.ts"() {} });
var ns, load = () => ns ??= (init_w(), __toCommonJS(w_exports));
console.log(${use});
`;
  expect(lower(source("load().who()"))).toEqual({
    degrade: expect.stringContaining(
      "calls only of exported functions that do not read 'this'",
    ) as string,
  });
  const lowered = expectSameBehavior(source("load().plain(1), (load().plain)(2)"));
  expect(lowered).not.toContain("load()");
});

test.each([
  ["is asynchronous", `var init_a = __esm({ async "a.ts"() { await 0; } });\ninit_a();`],
  [
    "is used other than as a statement call",
    `var init_a = __esm({ "a.ts"() {} });\nvar r = init_a();`,
  ],
  [
    "reads its factory's receiver",
    `var init_a = __esm({ "a.ts"() { console.log(this); } });\ninit_a();`,
  ],
  [
    "memoized lazy loader 'load' returns the namespace of a bundled ES module as a value",
    `var a_exports = {};\n__export(a_exports, { v: () => v });\nvar v, init_a = __esm({ "a.ts"() { v = 1; } });\nvar ns, load = () => ns ??= __toESM((init_a(), __toCommonJS(a_exports)));\nload();`,
  ],
  [
    "reads the namespace of a bundled ES module ('a_exports')",
    `var a_exports = {};\n__export(a_exports, { v: () => v });\nvar v, init_a = __esm({ "a.ts"() { v = 1; } });\nconsole.log(Object.keys((init_a(), __toCommonJS(a_exports))));`,
  ],
])("an initializer that %s keeps the package refused", (reason, code) => {
  expect(lower(`${helpers}${code}\n`)).toEqual({
    degrade: expect.stringContaining(reason) as string,
  });
});

test("files without __esm initializers and ES-module bundles are left alone", () => {
  expect(lower("exports.x = 1;\n")).toBeNull();
  expect(
    lower(`${helpers}var init_a = __esm({ "a.ts"() {} });\ninit_a();\nexport {};\n`),
  ).toBeNull();
});

test("a class an initializer defines into a module binding becomes a class declaration", () => {
  const lowered = expectSameBehavior(`"use strict";
${helpers}var import_stream, Shout, Loud, Plain;
var init_shout = __esm({
  "src/shout.ts"() {
    "use strict";
    import_stream = require("stream");
    console.log("shout init");
    Shout = class extends import_stream.Transform {
      _transform(chunk, encoding, callback) {
        callback(null, String(chunk).toUpperCase());
      }
    };
    Loud = class Loud extends Shout {
      static of() { return new Loud(); }
    }, Plain = class {
      label() { return "plain"; }
    };
    console.log("after", typeof Shout, Loud.name, new Plain().label());
  }
});
function main() {
  init_shout();
  const s = Loud.of();
  s.on("data", (c) => console.log("data", String(c)));
  s.end("hi");
}
console.log("start");
main();
`);
  expect(lowered).toContain('class Shout extends require("stream").Transform');
  expect(lowered).toContain("class Loud extends Shout");
  expect(lowered).toContain("class Plain ");
  // The bindings' declarators are gone with the interop binding's.
  expect(lowered).not.toMatch(/var [^;=]*\b(?:import_stream|Shout|Loud|Plain)\b/);
});

test("classes whose definition or binding is observable stay assignments", () => {
  const lowered = expectSameBehavior(`${helpers}var A, B, C, D;
var init_m = __esm({
  "src/m.ts"() {
    A = class { static made = console.log("static field runs at definition") };
    B = class extends globalThis.Array {};
    console.log(typeof D);
    D = class {};
    C = class {};
  }
});
console.log(typeof C);
init_m();
console.log(typeof A, typeof B, typeof C, typeof D);
`);
  expect(lowered).toContain("A = class");
  expect(lowered).toContain("B = class");
  expect(lowered).toContain("C = class");
  expect(lowered).toContain("D = class");
});

test("an interop binding a new expression constructs through stays the callee", () => {
  const lowered = expectSameBehavior(`${helpers}function make() {
  return new import_events.EventEmitter();
}
var import_events;
var init_m = __esm({
  "src/m.ts"() {
    import_events = require("events");
  }
});
init_m();
console.log(typeof make().on);
`);
  expect(lowered).toContain('new (require("events")).EventEmitter()');
});

test("a hoisted class may extend a global constructor, past esbuild's export annotation", () => {
  const lowered = expectSameBehavior(`${helpers}var AppError;
var init_errors = __esm({
  "src/errors.ts"() {
    AppError = class extends Error {
      code;
      constructor(message, code) {
        super(message);
        this.code = code;
      }
    };
  }
});
function fail() {
  init_errors();
  throw new AppError("failed", "E1");
}
function main() {
  try {
    fail();
  } catch (err) {
    console.log(err instanceof AppError, err instanceof Error, err.code, err.message);
  }
}
main();
0 && (module.exports = { AppError });
`);
  expect(lowered).toContain("class AppError extends Error");
});

test("an initializer declared last in a shared var statement still hoists its classes", () => {
  const lowered = expectSameBehavior(`"use strict";
${helpers}var BuildError, hints, init_errors = __esm({
  "src/errors.ts"() {
    "use strict";
    BuildError = class extends Error {
      constructor(code) {
        super("failed: " + code);
        this.code = code;
      }
    }, hints = { retry: "try again" };
  }
});
function run() {
  init_errors();
  try {
    throw new BuildError("E2");
  } catch (err) {
    console.log(err instanceof BuildError, err.code, err.message, hints.retry);
  }
}
run();
`);
  expect(lowered).toContain("class BuildError extends Error");
});

test("a minified initializer that ends with its class still hoists it", () => {
  const lowered = expectSameBehavior(
    `${helpers}var Counter,init_counter=__esm({"src/counter.ts"(){console.log("counter init"),Counter=class{n=0;next(){return++this.n}}}});function run(){init_counter();const c=new Counter;c.next();console.log(c.next())}run();`,
  );
  expect(lowered).toContain("class Counter{");
});
