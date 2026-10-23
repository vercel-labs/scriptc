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
  ])("refuses %s", (_what, text) => {
    expect(effectGate(pkg({ "index.js": text })).ok).toBe(false);
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
