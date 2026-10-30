import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { effectGate } from "./effect-gate.js";

function pkg(files: Record<string, string>, type?: "module"): string {
  const dir = mkdtempSync(join(tmpdir(), "effect-gate-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify(type ? { type } : {}));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return join(dir, "index.js");
}

describe("effectGate", () => {
  test("admits declarations, pure initializers, exports and relative requires", () => {
    const entry = pkg({
      "index.js": `"use strict";
const path = require("path");
const { join } = require("node:path");
const lib = require("./lib");
const VERSION = "1.0.0", LIMIT = -1;
const KEY = Symbol.for("k");
const TABLE = Object.freeze({ a: 1, [KEY]: true, re: /x+/g });
class Base {}
class Shape extends Base { static count = 0; area() { return 1; } }
function format(v) { console.log(v); return String(v); }
format.default = format;
Shape.prototype.kind = "shape";
Object.defineProperty(exports, "__esModule", { value: true });
Object.defineProperty(exports, "lib", { enumerable: true, get: function () { return lib.x; } });
exports.VERSION = VERSION;
module.exports.Shape = Shape;
exports.sep = path.sep;
exports.join = join;
exports.cache = new Map();
exports.mode = typeof window === "undefined" ? "node" : "browser";
exports.size = LIMIT * 2 + VERSION.length;
exports.label = "v" + VERSION;
var __importDefault = (this && this.__importDefault) || function (m) { return m; };
`,
      "lib.js": `exports.x = 1;\n`,
    });
    const r = effectGate(entry);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.files).toHaveLength(2);
  });

  test("admits ES modules with relative imports", () => {
    const entry = pkg(
      {
        "index.js": `import { x } from "./lib.js";\nexport const ANSWER = 42;\nexport function f() { return x; }\nexport default class {}\nexport * from "./lib.js";\n`,
        "lib.js": `export const x = 1;\n`,
      },
      "module",
    );
    expect(effectGate(entry).ok).toBe(true);
  });

  test.each([
    ["a top-level call", `console.log("hi");`],
    ["a process read", `const debug = process.env.DEBUG;`],
    ["an IIFE", `(function () {})();`],
    ["a call of the package's own function", `function f() {} const x = f();`],
    ["a listener", `process.on("exit", () => {});`],
    ["a global write", `globalThis.x = 1;`],
    ["a builtin write", `require("fs").readFileSync = null;`],
    ["a conditional", `if (true) { exports.x = 1; }`],
    ["an impure builtin", `require("node:sqlite");`],
    ["an unknown global", `const w = window;`],
    ["a static block", `class A { static { console.log(1); } }`],
    ["a getter with effects", `Object.defineProperty(exports, "x", { get() { return 1; } });`],
    ["an increment", "let i = 0; const j = i++;"],
    [
      "a read of a class's static getter",
      `class C { static get x() { return require("fs").readFileSync("/etc/hostname"); } }
const v = C.x;`,
    ],
    [
      "a read through a class expression's static getter",
      `const C = class { static get x() { return 1; } };
const v = C.x;`,
    ],
    [
      "a read through an alias of a class with a static getter",
      `class C { static get x() { return require("fs").readFileSync("/etc/hostname"); } }
const D = (C);
const v = D.x;`,
    ],
    [
      "a computed key that converts an object",
      `module.exports = { [{ toString() { return require("fs").readFileSync("/etc/hostname", "utf8"); } }]: 1 };`,
    ],
    [
      "a computed key of a local object",
      `const k = { toString() { return "k"; } };\nexports.o = { [k]: 1 };`,
    ],
    [
      "a computed method name that converts an object",
      `exports.o = { [{ valueOf() { return 1; } }]() {} };`,
    ],
    [
      "a computed class member name that converts an object",
      `class C { [{ toString() { return "m"; } }]() {} }`,
    ],
    ["a computed key of a let", `let k = "k";\nexports.o = { [k]: 1 };`],
    [
      "a symbol description that converts an object",
      `const s = Symbol({ toString() { return "d"; } });`,
    ],
    [
      "a symbol key that converts an object",
      `const s = Symbol.for({ toString() { return "d"; } });`,
    ],
  ])("refuses %s", (_what, text) => {
    expect(effectGate(pkg({ "index.js": text })).ok).toBe(false);
  });

  test("admits computed keys that are literals or symbols", () => {
    const entry = pkg({
      "index.js": `const kState = Symbol("state");
const kName = "name";
class C { [kState] = 1; [Symbol.iterator]() {} static [kName] = 2; }
exports.C = C;
exports.o = { ["a"]: 1, [kState]: 2, [kName]: 3, [Symbol.for("x")]: 4, [1n]() {} };
`,
    });
    expect(effectGate(entry)).toEqual({ ok: true, files: [entry] });
  });

  test("refuses a destructured computed key that converts an object", () => {
    const entry = pkg({
      "lib.js": `exports.x = 1;`,
      "index.js": `const { [{ toString() { return "x"; } }]: x } = require("./lib");\nexports.x = x;`,
    });
    expect(effectGate(join(entry, "..", "lib.js")).ok).toBe(true);
    expect(effectGate(entry).ok).toBe(false);
  });

  test("refuses a read of a static member that a base class defines with a getter", () => {
    const entry = pkg({
      "base.js": `class Base { static get x() { return require("fs").readFileSync("/etc/hostname"); } }
exports.Base = Base;`,
      "index.js": `const { Base } = require("./base");
class D extends Base {}
const v = D.x;`,
    });
    expect(effectGate(join(entry, "..", "base.js")).ok).toBe(true);
    expect(effectGate(entry).ok).toBe(false);
  });

  test("refuses when a required file is effectful", () => {
    const entry = pkg({
      "index.js": `module.exports = require("./lib");`,
      "lib.js": `console.log(1);`,
    });
    const r = effectGate(entry);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.file.endsWith("lib.js")).toBe(true);
  });
});
