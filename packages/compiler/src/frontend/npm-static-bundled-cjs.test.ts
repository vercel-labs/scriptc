import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { rewriteBundlerCjsExports } from "./npm-static-rewrite.js";

const fixture = readFileSync(
  new URL(
    "../../../../tests/fixtures/npm-static/node_modules/bundled-function/index.js",
    import.meta.url,
  ),
  "utf8",
);

function rewritten(source: string): string {
  const result = rewriteBundlerCjsExports(source, "/example/node_modules/bundle/index.js");
  expect(typeof result).toBe("string");
  return result as string;
}

function run(source: string) {
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
    encoding: "utf8",
  });
  expect(result.error).toBeUndefined();
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("preserves function identity, anonymous names, regexp allocation, and source locations", () => {
  const source =
    fixture +
    '\nconsole.log(same(), first.default.name, matches("aaa"), matches("xyz"), first.default() === second.default());';
  const result = rewritten(source);
  expect(result.length).toBe(source.length);
  expect([...result.matchAll(/\r?\n/g)].map((m) => m.index)).toEqual(
    [...source.matchAll(/\r?\n/g)].map((m) => m.index),
  );
  const oracle = run(source);
  expect(oracle.status).toBe(0);
  expect(run(result)).toEqual(oracle);
  expect(result).not.toContain("Object.create");
  expect(result).not.toContain("WeakMap");
});

test("keeps shared helper dependencies live", () => {
  const source = fixture + '\nconsole.log(__getOwnPropNames({a:1}).join(","));';
  const result = rewritten(source);
  expect(result).toContain("var __getOwnPropNames = Object.getOwnPropertyNames;");
  expect(run(result)).toEqual(run(source));
});

test("matches comments and equivalent string escapes without changing bundle behavior", () => {
  const source =
    fixture
      .replaceAll('"default"', "'de\\u0066ault'")
      .replace("var __create =", "var /* binding */ __create =") +
    '\nconsole.log(same(), matches("aa"));';
  expect(run(rewritten(source))).toEqual(run(source));
});

test.each([
  [
    "factory effects",
    (s: string) =>
      s.replace("module.exports = () =>", 'console.log("initializing"); module.exports = () =>'),
  ],
  ["factory capture", (s: string) => s.replace("() => /a+/g", "() => module.exports")],
  ["receiver", (s: string) => s.replace("() => /a+/g", "function () { return this; }")],
  ["arguments", (s: string) => s.replace("() => /a+/g", "() => arguments")],
  ["helper drift", (s: string) => s.replace("return to;", 'console.log("effect"); return to;')],
  ["return line terminator", (s: string) => s.replace("return to;", "return\nto;")],
  ["return comment terminator", (s: string) => s.replace("return to;", "return/*\n*/to;")],
  [
    "arrow line terminator",
    (s: string) => s.replace("(mod, isNodeMode, target) =>", "(mod, isNodeMode, target)\n=>"),
  ],
  ["helper operator drift", (s: string) => s.replace("mod != null", "mod !== null")],
  ["helper dependency drift", (s: string) => s.replace("Object.create", "Object.freeze")],
  ["namespace escape", (s: string) => s + "\nconsole.log(first === second);"],
  ["named property", (s: string) => s + "\nconsole.log(first.name);"],
  ["default assignment", (s: string) => s + "\n(first.default) = () => /b/;"],
  ["default destructuring", (s: string) => s + "\n({x: first.default} = {x: () => /b/});"],
  ["helper reassignment", (s: string) => s + "\n__create = () => ({});"],
  ["intrinsic shadow", (s: string) => s + "\nvar Object;"],
  ["intrinsic mutation", (s: string) => s + "\nObject.create = () => ({});"],
  ["direct eval", (s: string) => s + '\nconsole.log(eval("require_pattern()"));'],
  [
    "exported factory",
    (s: string) => s.replace("var require_pattern =", "export var require_pattern ="),
  ],
  ["exported namespace", (s: string) => s.replace("var first =", "export var first =")],
  [
    "late helper",
    (s: string) =>
      s.replace("var __create = Object.create;", "") + "\nvar __create = Object.create;",
  ],
  ["factory escape", (s: string) => s + "\nexport { require_pattern };"],
  ["factory reassignment", (s: string) => s + "\nrequire_pattern = () => () => /b/;"],
  ["namespace shadow", (s: string) => s + "\nfunction shadow(first) { return first.default; }"],
  ["non-node mode", (s: string) => s.replace("require_pattern(), 1", "require_pattern(), 0")],
  [
    "early factory call",
    (s: string) =>
      s.replace(
        "var require_pattern =",
        "var early = __toESM(require_pattern(), 1);\nvar require_pattern =",
      ),
  ],
] as const)("refuses %s", (_name, change) => {
  expect(
    rewriteBundlerCjsExports(change(fixture), "/example/node_modules/bundle/index.js"),
  ).toEqual({ degrade: expect.stringContaining("__toESM") });
});

test("a bare-package star re-export keeps its spread", () => {
  // A bare specifier cannot be resolved by the relative star probe, so its
  // names are not known to be empty: the table must keep the spread.
  const source = `"use strict";
var __exportStar = (m, exports2) => { for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports2, p)) Object.defineProperty(exports2, p, { enumerable: true, get: function () { return m[p]; } }); };
Object.defineProperty(exports, "__esModule", { value: true });
__exportStar(require("dep-kit"), exports);
`;
  expect(rewritten(source)).toContain('...require("dep-kit")');
});

test("an unresolved star target keeps its spread", () => {
  // Only a target that RESOLVES and has no names is statically empty; a
  // JSON, .mjs or absolute target the probe cannot follow keeps its spread.
  for (const spec of ["./data.json", "./mod.mjs", "/abs/data.cjs"]) {
    const source = `"use strict";
var __exportStar = (m, exports2) => { for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports2, p)) Object.defineProperty(exports2, p, { enumerable: true, get: function () { return m[p]; } }); };
Object.defineProperty(exports, "__esModule", { value: true });
__exportStar(require(${JSON.stringify(spec)}), exports);
`;
    expect(rewritten(source), spec).toContain(`...require(${JSON.stringify(spec)})`);
  }
});

test("a forwarding or ES-module star target is not provably empty", () => {
  const dir = mkdtempSync(join(tmpdir(), "star-forward-"));
  try {
    const pkg = join(dir, "node_modules", "forward-kit", "dist");
    mkdirSync(pkg, { recursive: true });
    // A target whose names come from a bare package the probe cannot follow.
    writeFileSync(
      join(pkg, "forward.js"),
      `"use strict";
var __exportStar = (m, exports2) => { for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports2, p)) Object.defineProperty(exports2, p, { enumerable: true, get: function () { return m[p]; } }); };
__exportStar(require("dep-unprobed"), exports);
`,
    );
    // A target that is an ES module: the CommonJS lexer cannot enumerate it.
    writeFileSync(join(pkg, "esm.js"), "export const x = 1;\n");
    // Compact ES-module spellings a line-based guard would miss.
    writeFileSync(join(pkg, "compact.js"), "const a=1;export{a};\n");
    writeFileSync(join(pkg, "star.js"), 'export*from"./none.js";\n');
    writeFileSync(join(pkg, "default.js"), "export default 1;\n");
    const index = (spec: string) => `"use strict";
var __exportStar = (m, exports2) => { for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports2, p)) Object.defineProperty(exports2, p, { enumerable: true, get: function () { return m[p]; } }); };
Object.defineProperty(exports, "__esModule", { value: true });
__exportStar(require(${JSON.stringify(spec)}), exports);
`;
    for (const spec of ["./forward.js", "./esm.js", "./compact.js", "./star.js", "./default.js"]) {
      const file = join(pkg, "index.js");
      writeFileSync(file, index(spec));
      const result = rewriteBundlerCjsExports(readFileSync(file, "utf8"), file);
      expect(typeof result, spec).toBe("string");
      expect(result as string, spec).toContain(`...require(${JSON.stringify(spec)})`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
