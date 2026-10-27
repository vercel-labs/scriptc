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

function unwrap(source: string): string | null {
  return nodeFrontendServices().umdFactory(source, "/pkg/index.js");
}

/** TypeScript's UMD wrapper around `body`. */
function umd(body: string, params = "require, exports"): string {
  return `(function (factory) {
    if (typeof module === "object" && typeof module.exports === "object") {
        var v = factory(require, exports);
        if (v !== undefined) module.exports = v;
    }
    else if (typeof define === "function" && define.amd) {
        define(["require", "exports"], factory);
    }
})(function (${params}) {
${body}
});
`;
}

const probe = `
console.log(JSON.stringify(module.exports), Object.keys(module.exports).join(","));
`;

function run(file: string): string {
  const result = spawnSync(process.execPath, [file], { encoding: "utf8" });
  expect(result.status).toBe(0);
  return result.stdout;
}

/** The unwrapped module exports what the original exports. */
function expectSameModule(source: string): string {
  const result = unwrap(source);
  expect(typeof result).toBe("string");
  const dir = mkdtempSync(join(tmpdir(), "scriptc-umd-"));
  dirs.push(dir);
  const original = join(dir, "original.cjs");
  const unwrapped = join(dir, "unwrapped.cjs");
  writeFileSync(original, source + probe);
  writeFileSync(unwrapped, result! + probe);
  const answer = run(original);
  expect(run(unwrapped)).toBe(answer);
  return result!;
}

test("the factory body runs at the top level with its positions kept", () => {
  const source = umd(`    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.twice = twice;
    const path = require("path");
    exports.sep = path.sep;
    function twice(n) {
        return n * 2;
    }`);
  const result = expectSameModule(source);
  expect(result.length).toBe(source.length);
  expect(result.split("\n").length).toBe(source.split("\n").length);
  expect(result.indexOf("exports.twice = twice;")).toBe(source.indexOf("exports.twice = twice;"));
  expect(result).not.toContain("define.amd");
  expect(result).not.toContain("factory");
});

test("TypeScript's helper probes of this keep their fallback", () => {
  expectSameModule(
    umd(`    "use strict";
    var __importDefault = (this && this.__importDefault) || function (mod) {
        return (mod && mod.__esModule) ? mod : { "default": mod };
    };
    Object.defineProperty(exports, "__esModule", { value: true });
    const os_1 = __importDefault(require("os"));
    exports.eol = os_1.default.EOL;`),
  );
});

test("nested functions keep their own return, arguments and this", () => {
  expectSameModule(
    umd(`    "use strict";
    exports.first = function () { return arguments[0]; };
    exports.self = { get() { return this; } };
    exports.arrow = () => { return 1; };`),
  );
});

test("other shapes keep the original text", () => {
  // `export =` returns the module value from the factory.
  expect(unwrap(umd(`    "use strict";\n    return { a: 1 };`))).toBeNull();
  // The body's own `this` and `arguments` differ from the module's.
  expect(unwrap(umd(`    exports.self = this;`))).toBeNull();
  expect(unwrap(umd(`    exports.count = arguments.length;`))).toBeNull();
  // Other factory parameters.
  expect(unwrap(umd(`    exports.a = 1;`, "require, exports, module"))).toBeNull();
  expect(unwrap(umd(`    exports.a = 1;`, "req, exp"))).toBeNull();
  // Code after the wrapper.
  expect(unwrap(umd(`    exports.a = 1;`) + "exports.b = 2;\n")).toBeNull();
  // Other statements in the wrapper, which unwrapping would drop.
  const wrapped = umd(`    exports.a = 1;`);
  const call = "        var v = factory(require, exports);\n";
  expect(unwrap(wrapped.replace(call, call + "        exports.b = 2;\n"))).toBeNull();
  expect(unwrap(wrapped.replace(call, "        exports.b = 2;\n" + call))).toBeNull();
  expect(unwrap(wrapped.replace("    }\n})(", "    }\n    exports.b = 2;\n})("))).toBeNull();
  expect(
    unwrap(wrapped.replace("define.amd) {", "define.amd) {\n        exports.b = 2;")),
  ).toBeNull();
  expect(
    unwrap(wrapped.replace("define(", "exports.b = 2;\n    }\n    else {\n        define(")),
  ).toBeNull();
  // Not a UMD wrapper.
  expect(unwrap(`exports.a = 1;\n`)).toBeNull();
});
