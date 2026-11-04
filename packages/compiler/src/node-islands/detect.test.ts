import { afterAll, describe, expect, test } from "vitest";
import { closeSourceParser, parseSourceFile } from "../frontend/ts7/source-parser-node.js";
import { scanModule, scanModuleFacts } from "./detect.js";

afterAll(() => closeSourceParser());

let serial = 0;
/** The markers of one JavaScript module as `rule reason` strings. */
function markers(source: string, ext = "cjs"): string[] {
  const sf = parseSourceFile(`/virtual/m${serial++}.${ext}`, source, "js");
  return scanModule(sf).map((m) => `${m.rule} ${m.reason}`);
}

describe("R1 runtime markers", () => {
  test("R1.1 code from strings", () => {
    // A bare eval() is also a sloppy-mode construct (R2.4 direct-eval).
    expect(markers("eval(code);")).toEqual(["R1.1 code-from-string", "R2.4 direct-eval"]);
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
    // `this` in a plain function is also the conservative sloppy-this marker
    // (decision S2): the file cannot see a call site in another module.
    expect(markers("function Child() { Parent.call(this, 1); }")).toEqual([
      "R2.1 constructor-function",
      "R2.4 sloppy-this",
    ]);
    expect(markers("class C {} const c = new C();")).toEqual([]);
    expect(
      markers("function wrap(fn) { return function () { return fn.apply(this, arguments); }; }"),
    ).toEqual(["R2.4 sloppy-this"]);
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

  test("R2.4 direct eval in sloppy mode", () => {
    expect(markers("eval(code);")).toEqual(["R1.1 code-from-string", "R2.4 direct-eval"]);
    expect(markers("function f() { return eval('x'); }")).toEqual([
      "R1.1 code-from-string",
      "R2.4 direct-eval",
    ]);
    // Indirect, aliased and builtin-object calls read no local scope.
    expect(markers("(0, eval)(code);")).toEqual(["R1.1 code-from-string"]);
    // An aliased eval is not a call the scan recognizes as code-from-string.
    expect(markers("const e = eval; e(code);")).toEqual([]);
    expect(markers("globalThis.eval(code);")).toEqual(["R1.1 code-from-string"]);
    expect(markers("function eval(code) { return code; } eval('x');")).toEqual([]);
    // Strict code's direct eval cannot see the caller's scope: no marker.
    expect(markers("'use strict'; eval(code);")).toEqual(["R1.1 code-from-string"]);
    expect(markers("export function f() { return eval('x'); }", "mjs")).toEqual([
      "R1.1 code-from-string",
    ]);
  });

  test("R2.4 Annex B block functions in sloppy mode", () => {
    // A block-level function declaration also creates a var-like binding in
    // the enclosing function (Annex B.3.2).
    expect(markers("if (x) { function f() {} f(); }")).toEqual(["R2.4 annexb-block-function"]);
    expect(markers("{ function f() {} }")).toEqual(["R2.4 annexb-block-function"]);
    expect(markers("function g() { { function f() {} } }")).toEqual(["R2.4 annexb-block-function"]);
    // A declaration in a function body or at the top level is ordinary, and
    // a strict block declaration is block-scoped.
    expect(markers("function f() {}")).toEqual([]);
    expect(markers("function g() { function f() {} }")).toEqual([]);
    expect(markers("'use strict'; if (x) { function f() {} }")).toEqual([]);
    expect(markers("export function g() { if (x) { function f() {} } }", "mjs")).toEqual([]);
  });

  test("R2.4 'this' in a plain sloppy call (decision S2)", () => {
    // A plain call's `this` is the global object in sloppy mode and
    // undefined in strict mode: the file cannot see its call sites, so any
    // plain function's `this` marks the module.
    expect(markers("function f() { return this; }")).toEqual(["R2.4 sloppy-this"]);
    expect(markers("const f = function () { return this; };")).toEqual(["R2.4 sloppy-this"]);
    expect(markers("function f() { const g = () => this; return g(); }")).toEqual([
      "R2.4 sloppy-this",
    ]);
    expect(markers("function f() { return { m() { return this; } }; }")).toEqual([]);
    // A receiver-carrying call, a class body, a class member initializer,
    // top-level `this` (the exports object) and strict code carry no marker.
    expect(markers("const o = { m() { return this; } }; o.m();")).toEqual([]);
    // A property-assigned function expression is indistinguishable from a
    // bare-call site in another module: conservative marking (S2).
    expect(markers("const o = { m: function () { return this; } };")).toEqual(["R2.4 sloppy-this"]);
    expect(markers("class C { m() { return this; } static s = this; }")).toEqual([]);
    expect(markers("this.x = 1;")).toEqual([]);
    expect(markers("'use strict'; function f() { return this; }")).toEqual([]);
    expect(markers("export function f() { return this; }", "mjs")).toEqual([]);
  });

  test("R2.4 receiver-proven functions stay native (decision S5)", () => {
    const sloppy = (source: string) => markers(source).filter((m) => m.startsWith("R2.4"));
    // Native passes the receiver for both shapes: `new X()` and a
    // `X.prototype.name` method. Marking them would move native passes.
    expect(sloppy("function Ctor() { this.x = 1; } new Ctor();")).toEqual([]);
    expect(sloppy("const Ctor = function () { this.x = 1; }; new Ctor();")).toEqual([]);
    expect(sloppy("function M() {} M.prototype.m = function () { return this; };")).toEqual([]);
    // The name is also called plainly, so the receiver is not proven.
    expect(sloppy("function Ctor() { return this; } new Ctor(); Ctor();")).toEqual([
      "R2.4 sloppy-this",
    ]);
    // A callback's receiver belongs to its callee, which the file cannot
    // see: conservative marking (S2).
    expect(sloppy("function f() { return this; } [1].map(f);")).toEqual(["R2.4 sloppy-this"]);
  });

  test("R2.5 builtin and global patching", () => {
    expect(markers("Array.prototype.last = function () {};")).toEqual(["R2.5 builtin-write"]);
    expect(markers("Promise = Bluebird;")).toEqual(["R2.5 builtin-write"]);
    expect(markers("globalThis.fetch = f;")).toEqual(["R2.5 builtin-write"]);
    expect(markers("const fs = require('fs'); fs.close = patched;")).toEqual([
      "R2.5 builtin-patch",
    ]);
    expect(markers("const p = new Proxy(t, h);")).toEqual(["R2.5 proxy"]);
    // Modeled process state and tuning knobs stay; so do redeclared names.
    expect(
      markers("process.exitCode = 1; process.env.X = 'y'; Error.stackTraceLimit = 50;"),
    ).toEqual([]);
    expect(markers("var Promise = require('bluebird'); Promise.config = {};")).toEqual([]);
  });
});

describe("R2.5 builtin patches (H3.1)", () => {
  /** The markers and the member each builtin patch names. */
  function patches(source: string, ext = "cjs"): string[] {
    const sf = parseSourceFile(`/virtual/p${serial++}.${ext}`, source, "js");
    return scanModuleFacts(sf).markers.map(
      (m) => `${m.reason} ${m.member === undefined ? "-" : m.member}`,
    );
  }

  test("a write through the CommonJS object is a builtin patch", () => {
    expect(patches("const fs = require('fs'); fs.readFileSync = f;")).toEqual([
      "builtin-patch fs.readFileSync",
    ]);
  });

  test("createRequire(), casts and aliases resolve to the same object", () => {
    expect(
      patches(
        "const r = createRequire(import.meta.url); const fs = r('node:fs') as typeof import('fs'); (fs as { readFileSync: unknown }).readFileSync = f;",
        "mjs",
      ),
    ).toEqual(["builtin-patch fs.readFileSync"]);
    expect(
      patches(
        "const r = createRequire(import.meta.url); const fs = r('node:fs') as typeof import('fs'); const m = fs as { readFileSync: unknown }; m.readFileSync = f;",
        "mjs",
      ),
    ).toEqual(["builtin-patch fs.readFileSync"]);
  });

  test("a default import is the CommonJS object", () => {
    expect(patches("import fs from 'node:fs'; fs.writeFileSync = f;", "mjs")).toEqual([
      "builtin-patch fs.writeFileSync",
    ]);
  });

  test.each([
    ["function parameter", "function local(fs) { fs.extra = 1; }"],
    ["arrow parameter", "const local = (fs) => { fs.extra = 1; };"],
    ["destructured parameter", "function local({ fs }) { fs.extra = 1; }"],
    ["rest parameter", "function local(...fs) { fs.extra = 1; }"],
    ["method parameter", "const local = { set(fs) { fs.extra = 1; } };"],
    ["constructor parameter", "class Local { constructor(fs) { fs.extra = 1; } }"],
    ["catch binding", "try {} catch (fs) { fs.extra = 1; }"],
    ["block binding", "{ const fs = {}; fs.extra = 1; }"],
    ["loop binding", "for (const fs of values) { fs.extra = 1; }"],
    ["hoisted var", "function local() { fs.extra = 1; var fs; }"],
    ["function declaration", "function local() { function fs() {} fs.extra = 1; }"],
    ["named expression", "const local = function fs() { fs.extra = 1; };"],
    ["named class", "const local = class fs { static set() { fs.extra = 1; } };"],
  ])("a shadowed %s is not a builtin patch", (_name, source) => {
    expect(patches(`'use strict'; const fs = require('fs'); ${source}`)).toEqual([]);
  });

  test("a default import can be shadowed without hiding later patches", () => {
    expect(
      patches(
        "import fs from 'node:fs'; fs.before = 1; function local(fs) { fs.extra = 1; } fs.after = 1;",
        "mjs",
      ),
    ).toEqual(["builtin-patch fs.before", "builtin-patch fs.after"]);
  });

  test("an alias of a shadowed parameter stays local", () => {
    expect(
      patches(
        "const fs = require('fs'); function local(fs) { const alias = fs; alias.extra = 1; } fs.after = 1;",
      ),
    ).toEqual(["builtin-patch fs.after"]);
  });

  test("sibling scopes keep their own builtin aliases", () => {
    expect(
      patches(
        "function a() { const x = require('fs'); x.extra = 1; } function b() { const x = require('path'); x.extra = 1; } function c() { const x = {}; x.extra = 1; }",
      ),
    ).toEqual(["builtin-patch fs.extra", "builtin-patch path.extra"]);
  });

  test("a closure still patches the captured builtin", () => {
    expect(
      patches("const fs = require('fs'); function local() { return () => { fs.extra = 1; }; }"),
    ).toEqual(["builtin-patch fs.extra"]);
    expect(patches("var fs = require('fs'); var fs; fs.extra = 1;")).toEqual([
      "builtin-patch fs.extra",
    ]);
  });

  test("a recorded loader can be shadowed without hiding captured loader calls", () => {
    expect(
      patches(
        "const { createRequire } = require('module'); const r = createRequire(__filename); function local(r) { const fs = r('fs'); fs.extra = 1; } function captured() { const fs = r('fs'); fs.after = 1; }",
      ),
    ).toEqual(["builtin-patch fs.after"]);
  });

  test("CommonJS wrapper redeclarations retain the existing loader recognition", () => {
    expect(patches("var require; const fs = require('fs'); fs.extra = 1;")).toEqual([
      "builtin-patch fs.extra",
    ]);
    expect(
      patches(
        "if (false) { function require() {} } const fs = require('fs'); fs.extra = 1;",
      ).filter((m) => m.startsWith("builtin-patch")),
    ).toEqual(["builtin-patch fs.extra"]);
  });

  test("all patch forms distinguish a local object from a captured builtin", () => {
    const source =
      "function local(fs) { Object.defineProperty(fs, 'x', { value: 1 }); Object.assign(fs, { y: 1 }); delete fs.z; fs.n++; }";
    expect(
      patches(`const fs = require('fs'); ${source}`).filter((m) => m.startsWith("builtin-patch")),
    ).toEqual([]);
    expect(
      patches(`const fs = require('fs'); ${source} Object.assign(fs, { after: 1 });`).filter((m) =>
        m.startsWith("builtin-patch"),
      ),
    ).toEqual(["builtin-patch fs.after"]);
  });

  test("a var initializer can assign a builtin to a catch binding", () => {
    expect(
      patches(
        "function local() { try { throw null; } catch (fs) { var fs = require('fs'); fs.extra = 1; } }",
      ),
    ).toEqual(["builtin-patch fs.extra"]);
  });

  test.each([
    "const { Module } = require('module'); const r = Module.createRequire(__filename);",
    "const r = module.constructor.createRequire(__filename);",
    "const { Module } = require('module'); const r = new Module(__filename).constructor.createRequire(__filename);",
  ])("property-form createRequire retains genuine patches: %s", (source) => {
    expect(patches(`${source} const fs = r('fs'); fs.extra = 1;`)).toEqual([
      "builtin-patch fs.extra",
    ]);
  });

  test("erased loader declarations do not hide genuine builtin patches", () => {
    expect(
      patches(
        "declare function require(name: string): unknown; const fs = require('fs'); fs.extra = 1;",
        "ts",
      ),
    ).toEqual(["builtin-patch fs.extra"]);
    expect(
      patches(
        "declare const require: (name: string) => unknown; const fs = require('fs'); fs.extra = 1;",
        "ts",
      ),
    ).toEqual(["builtin-patch fs.extra"]);
  });

  test("runtime class heritage retains genuine patches and local shadowing", () => {
    expect(patches("const fs = require('fs'); class C extends (fs.extra = Object) {};")).toEqual([
      "builtin-patch fs.extra",
    ]);
    expect(
      patches(
        "const fs = require('fs'); function local(fs) { return class extends (fs.extra = Object) {}; }",
      ),
    ).toEqual([]);
  });

  test("defineProperty, Object.assign, delete and bind are patches too", () => {
    expect(
      patches("const fs = require('fs'); Object.defineProperty(fs, 'readFileSync', { value: f });"),
    ).toEqual(["builtin-patch fs.readFileSync"]);
    expect(patches("const fs = require('fs'); Object.assign(fs, { readFileSync: f });")).toEqual([
      "builtin-patch fs.readFileSync",
    ]);
    expect(patches("const fs = require('fs'); Object.assign(fs, source);")).toEqual([
      "builtin-patch fs.*",
    ]);
    expect(patches("const fs = require('fs'); delete fs.readFileSync;")).toEqual([
      "builtin-patch fs.readFileSync",
    ]);
    expect(
      patches("const fs = require('fs'); fs.readFileSync = fs.readFileSync.bind(fs);"),
    ).toEqual(["builtin-patch fs.readFileSync"]);
  });

  test("writes Node itself refuses are not patches", () => {
    // A namespace import is not the CommonJS object: Node throws on the
    // write, and the module stays as it is today.
    expect(patches("import * as fs from 'node:fs'; fs.x = 1;", "mjs")).toEqual(["builtin-write -"]);
    expect(patches("import { readFileSync } from 'node:fs'; readFileSync(p);", "mjs")).toEqual([]);
    expect(patches("const fs = { readFileSync: 1 }; fs.readFileSync = 2;")).toEqual([]);
    expect(patches("process.exitCode = 1;")).toEqual([]);
  });
});

test("CommonJS object reads are recorded for the patch check (H3.4)", () => {
  const reads = (source: string, ext = "cjs"): string[] => {
    const sf = parseSourceFile(`/virtual/r${serial++}.${ext}`, source, "js");
    return scanModuleFacts(sf).cjsReads.map((read) => read.member);
  };
  expect(reads("const fs = require('fs'); fs.readFileSync(p);")).toEqual(["fs.readFileSync"]);
  expect(
    reads(
      "const fs = require('fs'); function local(fs) { fs.readFileSync(p); const { readFileSync } = fs; } fs.readFileSync(p);",
    ),
  ).toEqual(["fs.readFileSync"]);
  expect(
    reads(
      "import fs from 'node:fs'; function local(fs) { fs.readFileSync(p); } fs.readFileSync(p);",
      "mjs",
    ),
  ).toEqual(["fs.readFileSync"]);
  expect(reads("import { readFileSync } from 'node:fs'; readFileSync(p);", "mjs")).toEqual([]);
  // A write is not a read; an ES module read through the namespace import
  // is not the CommonJS object either.
  expect(reads("const fs = require('fs'); fs.readFileSync = f;")).toEqual([]);
  expect(reads("import fs from 'node:fs'; fs.readFileSync(p);", "mjs")).toEqual([
    "fs.readFileSync",
  ]);
  expect(reads("import * as fs from 'node:fs'; fs.readFileSync(p);", "mjs")).toEqual([]);
  // Bracket notation: a literal key names the member, a computed one reads
  // a member the scan cannot name.
  expect(reads("const fs = require('fs'); fs['readFileSync'](p);")).toEqual(["fs.readFileSync"]);
  expect(reads("const fs = require('fs'); fs[name](p);")).toEqual(["fs.*"]);
  expect(reads("const fs = require('fs'); fs['readFileSync'] = f;")).toEqual([]);
  // Destructuring reads each property it takes when it runs.
  expect(reads("const { readFileSync } = require('node:fs');")).toEqual(["fs.readFileSync"]);
  expect(reads("const fs = require('fs'); const { readFileSync: read, ...rest } = fs;")).toEqual([
    "fs.readFileSync",
    "fs.*",
  ]);
  expect(reads("const { promises: { readFile } } = require('fs');")).toEqual([
    "fs.promises",
    "fs.promises.readFile",
  ]);
  expect(
    reads("import fs from 'node:fs'; let readFileSync; ({ readFileSync } = fs);", "mjs"),
  ).toEqual(["fs.readFileSync"]);
  // A namespace import is not the CommonJS object.
  expect(reads("import * as fs from 'node:fs'; const { readFileSync } = fs;", "mjs")).toEqual([]);
});

test("class heritage and instantiation values retain builtin reads", () => {
  const reads = (source: string, ext = "cjs"): string[] => {
    const sf = parseSourceFile(
      `/virtual/heritage${serial++}.${ext}`,
      source,
      ext === "ts" ? "ts" : "js",
    );
    return scanModuleFacts(sf).cjsReads.map((read) => read.member);
  };
  expect(
    reads("const events = require('events'); class Sub extends events.EventEmitter {}"),
  ).toEqual(["events.EventEmitter"]);
  expect(
    reads(
      "import events from 'node:events'; const Sub = class extends events.EventEmitter {};",
      "mjs",
    ),
  ).toEqual(["events.EventEmitter"]);
  expect(
    reads(
      "const events = require('events'); function local(events) { return class extends events.EventEmitter {}; }",
    ),
  ).toEqual([]);
  expect(
    reads("const fs = require('fs'); const specialized = fs.readFileSync<string>;", "ts"),
  ).toEqual(["fs.readFileSync"]);
  expect(
    reads(
      "const fs = require('fs'); class C implements fs.Shape {} interface I extends fs.Shape {}",
      "ts",
    ),
  ).toEqual([]);
});

test("global reads are recorded for the implicit-global check (H3.4)", () => {
  const globals = (source: string, ext = "cjs", kind: "js" | "ts" = "js"): string[] => {
    const sf = parseSourceFile(`/virtual/g${serial++}.${ext}`, source, kind);
    return scanModuleFacts(sf).globalReads.map((read) => read.name);
  };
  // A name the module declares nowhere resolves on the global object at
  // run time, where an island's sloppy write can create it.
  expect(globals("counter = 1; console.log(counter);")).toEqual(["counter"]);
  expect(globals("if (typeof flag === 'boolean') flag.run();")).toEqual(["flag"]);
  expect(globals("const o = { counter };")).toEqual(["counter"]);
  expect(globals("for (key in source) {}")).toEqual(["source"]);
  expect(globals("use(value);")).toEqual(["use", "value"]);
  // Declared names, builtins and the CommonJS module scope are not global
  // reads, and property names, labels and write targets are not reads.
  expect(globals("const counter = 1; console.log(counter);")).toEqual([]);
  expect(globals("console.log(process.env.HOME, Buffer.from('x'), globalThis.x);")).toEqual([]);
  expect(globals("const r = require('r'); module.exports = exports;")).toEqual([]);
  expect(
    globals("const o = {}; o.counter = 1; counter = 2; counter++; label: break label;"),
  ).toEqual([]);
  // A TypeScript module's type positions and declaration names are not
  // value reads: only a name used as a value can resolve on the global.
  expect(
    globals(
      "interface Payload { n: number }\nconst p: Payload = { n: 1 };\nconsole.log(p);",
      "ts",
      "ts",
    ),
  ).toEqual([]);
  expect(
    globals("type Id<T> = T;\nfunction id<T>(value: T): T { return value; }\nid(1);", "ts", "ts"),
  ).toEqual([]);
  expect(globals("enum Mode { On }\nconsole.log(Mode.On);", "ts", "ts")).toEqual([]);
});

test("markers come back in source order with their locations", () => {
  const source = "Object.setPrototypeOf(a, b);\neval(x);\n";
  const sf = parseSourceFile(`/virtual/order${serial++}.cjs`, source, "js");
  const found = scanModule(sf);
  expect(found.map((m) => [m.rule, source.slice(m.loc.start, m.loc.end)])).toEqual([
    ["R2.2", "Object.setPrototypeOf(a, b)"],
    ["R1.1", "eval(x)"],
    ["R2.4", "eval(x)"],
  ]);
});

test("computed writes keep the member they write through", () => {
  expect(markers("process.env[key] = value;")).toEqual([]);
  expect(markers("Array.prototype[name] = fn;")).toEqual(["R2.5 builtin-write"]);
});
