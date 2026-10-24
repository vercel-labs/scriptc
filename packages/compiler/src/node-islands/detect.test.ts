import { afterAll, describe, expect, test } from "vitest";
import { closeSourceParser, parseSourceFile } from "../frontend/ts7/source-parser-node.js";
import { scanModule } from "./detect.js";

afterAll(() => closeSourceParser());

let serial = 0;
/** The markers of one JavaScript module as `rule reason` strings. */
function markers(source: string, ext = "cjs"): string[] {
  const sf = parseSourceFile(`/virtual/m${serial++}.${ext}`, source, "js");
  return scanModule(sf).map((m) => `${m.rule} ${m.reason}`);
}

describe("R1 runtime markers", () => {
  test("R1.1 code from strings", () => {
    expect(markers("eval(code);")).toEqual(["R1.1 code-from-string"]);
    expect(markers("(0, eval)(code);")).toEqual(["R1.1 code-from-string"]);
    expect(markers("const f = new Function('a', 'return a');")).toEqual(["R1.1 code-from-string"]);
    expect(markers("const f = Function('a', body);")).toEqual(["R1.1 code-from-string"]);
    expect(markers("const vm = require('node:vm');")).toEqual(["R1.1 vm"]);
    expect(markers("import vm from 'vm';", "mjs")).toEqual(["R1.1 vm"]);
  });

  test("R1.1 exceptions: the global-object idiom and a capability probe in try", () => {
    expect(markers("const g = Function('return this')();")).toEqual([]);
    expect(markers("let ok; try { new Function(''); ok = true; } catch { ok = false; }")).toEqual(
      [],
    );
  });

  test("R1.2 dynamic module loading", () => {
    expect(markers("require(name);")).toEqual(["R1.2 dynamic-require"]);
    expect(markers("import(`./${x}.js`);", "mjs")).toEqual(["R1.2 dynamic-import"]);
    expect(markers("const r = createRequire(import.meta.url); r(spec);", "mjs")).toEqual([
      "R1.2 dynamic-require",
    ]);
    expect(markers("require('./a' + '.js'); require.resolve(name); import('./b.js');")).toEqual([]);
  });

  test("R1.3 native addons", () => {
    expect(markers("require('./build/addon.node');")).toEqual(["R1.3 native-addon"]);
    expect(markers("const b = require('bindings')('addon');")).toEqual(["R1.3 native-addon"]);
    expect(markers("process.dlopen(module, path);")).toEqual(["R1.3 native-addon"]);
  });

  test("R1.4 loader and require hooks", () => {
    expect(markers("require.extensions['.coffee'] = compile;")).toEqual(["R1.4 loader-hook"]);
    expect(markers("delete require.cache[key];")).toEqual(["R1.4 loader-hook"]);
    expect(markers("const Module = require('module'); Module._load = load;")).toEqual([
      "R1.4 loader-hook",
    ]);
    expect(markers("const m = require('node:module'); m.registerHooks({});")).toEqual([
      "R1.4 loader-hook",
    ]);
    expect(markers("require('require-in-the-middle');")).toEqual(["R1.4 loader-hook"]);
  });

  test("R1.5 engine internals", () => {
    expect(markers("process.binding('fs');")).toEqual(["R1.5 engine-internal"]);
    expect(markers("const v8 = require('v8'); v8.setFlagsFromString('--x');")).toEqual([
      "R1.5 engine-internal",
    ]);
    expect(markers("global.gc();")).toEqual(["R1.5 engine-internal"]);
  });

  test("R1.6 runtime-only globals", () => {
    expect(markers("const r = new WeakRef(o);")).toEqual(["R1.6 weak-ref"]);
    expect(markers("const f = new FinalizationRegistry(cb);")).toEqual(["R1.6 weak-ref"]);
    expect(markers("if (typeof WeakRef !== 'undefined') {}")).toEqual([]);
    expect(markers("const o = { WeakRef: 1 }; o.WeakRef;")).toEqual([]);
  });
});

describe("R2 object-model markers", () => {
  test("R2.1 constructor functions", () => {
    expect(markers("function F() {} const f = new F();")).toEqual(["R2.1 constructor-function"]);
    expect(markers("function F() {} F.prototype.m = function () {};")).toEqual([
      "R2.1 constructor-function",
    ]);
    expect(markers("const util = require('util'); util.inherits(A, B);")).toEqual([
      "R2.1 constructor-function",
    ]);
    expect(markers("function Child() { Parent.call(this, 1); }")).toEqual([
      "R2.1 constructor-function",
    ]);
    expect(markers("class C {} const c = new C();")).toEqual([]);
    expect(
      markers("function wrap(fn) { return function () { return fn.apply(this, arguments); }; }"),
    ).toEqual([]);
  });

  test("R2.2 prototype mutation", () => {
    expect(markers("Object.setPrototypeOf(a, b);")).toEqual(["R2.2 prototype-write"]);
    expect(markers("o.__proto__ = p;")).toEqual(["R2.2 prototype-write"]);
    expect(markers("const o = { __proto__: base };")).toEqual(["R2.2 prototype-write"]);
    // The transpiled-Error idiom and null-prototype dictionaries stay.
    expect(
      markers(
        "class E extends Error { constructor() { super(); Object.setPrototypeOf(this, E.prototype); } }",
      ),
    ).toEqual([]);
    expect(markers("const d = { __proto__: null };")).toEqual([]);
  });

  test("R2.3 shape mutation outside the checker's view", () => {
    expect(markers("Object.defineProperty(o, 'k', { get() { return 1; } });")).toEqual([
      "R2.3 define-property",
    ]);
    expect(markers("class C {} C.prototype.extra = 1;")).toEqual(["R2.3 define-property"]);
    // Module objects and interop helpers build module records.
    expect(markers("Object.defineProperty(exports, '__esModule', { value: true });")).toEqual([]);
    expect(
      markers(
        "var __createBinding = function (o, m, k) { Object.defineProperty(o, k, { enumerable: true, get: function () { return m[k]; } }); };",
      ),
    ).toEqual([]);
  });

  test("R2.4 sloppy-mode semantics", () => {
    expect(markers("with (o) { x; }")).toEqual(["R2.4 with"]);
    expect(markers("function f(a) { arguments[0] = 1; return a; }")).toEqual([
      "R2.4 sloppy-arguments",
    ]);
    expect(markers("function f(a) { a = 2; return arguments[0]; }")).toEqual([
      "R2.4 sloppy-arguments",
    ]);
    expect(markers("function f() { return arguments.callee; }")).toEqual(["R2.4 sloppy-arguments"]);
    expect(markers("var n = 010;")).toEqual(["R2.4 sloppy-mode"]);
    expect(markers("var x = 1; delete x;")).toEqual(["R2.4 sloppy-mode"]);
    // Strict code: a prologue, an ES module, a class body.
    expect(markers("'use strict'; function f(a) { a = 2; return arguments[0]; }")).toEqual([]);
    expect(markers("export function f(a) { a = 2; return arguments[0]; }", "mjs")).toEqual([]);
    expect(markers("class C { m(a) { a = 2; return arguments[0]; } }")).toEqual([]);
  });

  test("R2.5 builtin and global patching", () => {
    expect(markers("Array.prototype.last = function () {};")).toEqual(["R2.5 builtin-write"]);
    expect(markers("Promise = Bluebird;")).toEqual(["R2.5 builtin-write"]);
    expect(markers("globalThis.fetch = f;")).toEqual(["R2.5 builtin-write"]);
    expect(markers("const fs = require('fs'); fs.close = patched;")).toEqual([
      "R2.5 builtin-write",
    ]);
    expect(markers("const p = new Proxy(t, h);")).toEqual(["R2.5 proxy"]);
    // Modeled process state and tuning knobs stay; so do redeclared names.
    expect(
      markers("process.exitCode = 1; process.env.X = 'y'; Error.stackTraceLimit = 50;"),
    ).toEqual([]);
    expect(markers("var Promise = require('bluebird'); Promise.config = {};")).toEqual([]);
  });
});

test("markers come back in source order with their locations", () => {
  const source = "Object.setPrototypeOf(a, b);\neval(x);\n";
  const sf = parseSourceFile(`/virtual/order${serial++}.cjs`, source, "js");
  const found = scanModule(sf);
  expect(found.map((m) => [m.rule, source.slice(m.loc.start, m.loc.end)])).toEqual([
    ["R2.2", "Object.setPrototypeOf(a, b)"],
    ["R1.1", "eval(x)"],
  ]);
});

test("computed writes keep the member they write through", () => {
  expect(markers("process.env[key] = value;")).toEqual([]);
  expect(markers("Array.prototype[name] = fn;")).toEqual(["R2.5 builtin-write"]);
});
