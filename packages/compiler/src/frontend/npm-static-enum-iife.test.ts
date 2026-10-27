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

function rewrite(source: string): string | null {
  return nodeFrontendServices().enumIifes(source, "/pkg/index.js");
}

function run(file: string): string {
  const result = spawnSync(process.execPath, [file], { encoding: "utf8" });
  expect(result.status).toBe(0);
  return result.stdout;
}

const probe = `
for (const name of Object.keys(module.exports)) {
  const v = module.exports[name];
  console.log(name, JSON.stringify(v), Object.keys(v ?? {}).join(","));
}
`;

/** The rewritten module exports what the original exports, keys in the
 * same order. */
function expectSameExports(source: string): string {
  const result = rewrite(source);
  expect(typeof result).toBe("string");
  const dir = mkdtempSync(join(tmpdir(), "scriptc-enum-iife-"));
  dirs.push(dir);
  const original = join(dir, "original.cjs");
  const rewritten = join(dir, "rewritten.cjs");
  writeFileSync(original, source + probe);
  writeFileSync(rewritten, result! + probe);
  expect(run(rewritten)).toBe(run(original));
  // Line positions survive the respelling.
  expect(result!.split("\n").length).toBe(source.split("\n").length);
  return result!;
}

test("a TypeScript 5 exported string enum becomes its object literal", () => {
  const out = expectSameExports(`"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Kind = void 0;
var Kind;
(function (Kind) {
    Kind["Identifier"] = "Identifier";
    Kind["Literal"] = "Literal";
})(Kind || (exports.Kind = Kind = {}));
`);
  expect(out).toContain(`var Kind = { "Identifier": "Identifier", "Literal": "Literal" };`);
  expect(out).toContain("exports.Kind = Kind;");
});

test("numeric enums keep their reverse mapping and Node's key order", () => {
  const out = expectSameExports(`"use strict";
var Level;
(function (Level) {
    Level[Level["High"] = 2] = "High";
    Level[Level["Low"] = 0] = "Low";
    Level[Level["Below"] = -1] = "Below";
    Level[Level["Also"] = 2] = "Also";
})(Level = exports.Level || (exports.Level = {}));
`);
  expect(out).toContain(
    `var Level = { 0: "Low", 2: "Also", "High": 2, "Low": 0, "Below": -1, "-1": "Below", "Also": 2 };`,
  );
});

test("an ES module's exported enum keeps its export", () => {
  const source = `export var Kind;
(function (Kind) {
    Kind["Identifier"] = "Identifier";
    Kind[Kind["Zero"] = 0] = "Zero";
})(Kind || (Kind = {}));
`;
  const out = rewrite(source);
  expect(out).toContain(`export var Kind = { 0: "Zero", "Identifier": "Identifier", "Zero": 0 };`);
  const dir = mkdtempSync(join(tmpdir(), "scriptc-enum-iife-"));
  dirs.push(dir);
  writeFileSync(join(dir, "original.mjs"), source);
  writeFileSync(join(dir, "rewritten.mjs"), out!);
  const reader = (file: string) =>
    `import { Kind } from "./${file}"; console.log(JSON.stringify(Kind), Object.keys(Kind).join(","));`;
  writeFileSync(join(dir, "read-original.mjs"), reader("original.mjs"));
  writeFileSync(join(dir, "read-rewritten.mjs"), reader("rewritten.mjs"));
  expect(run(join(dir, "read-rewritten.mjs"))).toBe(run(join(dir, "read-original.mjs")));
  expect(out!.split("\n").length).toBe(source.split("\n").length);
});

test("an enum the module does not export becomes a local object", () => {
  const out = expectSameExports(`"use strict";
var Mode;
(function (Mode) {
    Mode.Fast = "fast";
})(Mode || (Mode = {}));
exports.mode = Mode.Fast;
`);
  expect(out).toContain(`var Mode = { "Fast": "fast" };`);
});

test("merged, computed and otherwise written enums keep their text", () => {
  // A second declaration merges into the first.
  expect(
    rewrite(`var E;
(function (E) { E["A"] = "a"; })(E || (E = {}));
(function (E) { E["B"] = "b"; })(E || (E = {}));
`),
  ).toBeNull();
  // A member referencing another member.
  expect(
    rewrite(`var F;
(function (F) { F[F["A"] = 1] = "A"; F[F["B"] = F.A << 1] = "B"; })(F || (exports.F = F = {}));
`),
  ).toBeNull();
  // A statement other than a member write.
  expect(
    rewrite(`var G;
(function (G) { G["A"] = "a"; console.log("side effect"); })(G || (exports.G = G = {}));
`),
  ).toBeNull();
  // The variable is reassigned later.
  expect(
    rewrite(`var H;
(function (H) { H["A"] = "a"; })(H || (exports.H = H = {}));
H = null;
`),
  ).toBeNull();
});
