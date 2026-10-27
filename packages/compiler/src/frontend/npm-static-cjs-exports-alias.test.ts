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
  return nodeFrontendServices().cjsFunctionExports(source, "/pkg/index.js");
}

function run(file: string) {
  const result = spawnSync(process.execPath, [file], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** The rewritten module prints what the original prints. */
function expectSameBehavior(source: string): string {
  const result = rewrite(source);
  expect(typeof result).toBe("string");
  const dir = mkdtempSync(join(tmpdir(), "scriptc-cjs-function-exports-"));
  dirs.push(dir);
  const original = join(dir, "original.cjs");
  const rewritten = join(dir, "rewritten.cjs");
  writeFileSync(original, source);
  writeFileSync(rewritten, result as string);
  const oracle = run(original);
  expect(oracle.status).toBe(0);
  expect(run(rewritten)).toEqual(oracle);
  return result as string;
}

const report = `
console.log(typeof module.exports, module.exports === Version, Object.keys(Version).join(","));
`;

test("members of a function export object read and write the function", () => {
  const rewritten = expectSameBehavior(`exports = module.exports = Version;
exports.parse = parse;
module.exports.major = (v) => parse(v)[0];
function Version(v) { return { v }; }
function parse(v) { return v.split(".").map(Number); }
console.log(exports.major("2.1.0"), module.exports.parse("1.2").length);
${report}`);
  expect(rewritten).toContain("Version.parse = parse");
  expect(rewritten).not.toContain("exports = module.exports");
});

test.each([
  ["a parameter", "function inner(Version) { return exports.parse; }"],
  ["a local", "function inner() { const Version = {}; return exports.parse; }"],
  ["a nested function", "function inner() { function Version() {} return exports.parse; }"],
  [
    "a catch binding",
    "function inner() { try { throw 0; } catch (Version) { return exports.parse; } }",
  ],
])("a nested binding of the function's name (%s) keeps the module as it is", (_, inner) => {
  expect(
    rewrite(`exports = module.exports = Version;
exports.parse = parse;
function Version() {}
function parse() {}
${inner}
`),
  ).toBeNull();
});

test("an `exports` shorthand property keeps its key", () => {
  const rewritten = expectSameBehavior(`exports = module.exports = Version;
exports.tag = "v";
function Version() {}
const holder = { exports };
console.log(Object.keys(holder).join(","), holder.exports === Version, holder.exports.tag);
${report}`);
  expect(rewritten).toContain("{ exports: Version }");
});
