import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { compile } from "../src/index.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function emit(source: string): Promise<string> {
  const outDir = await mkdtemp(join(tmpdir(), "scriptc-regex-"));
  directories.push(outDir);
  const entry = join(outDir, "main.ts");
  await writeFile(entry, source);
  const outPath = join(outDir, "program.ll");
  const result = await compile(entry, { entry, outDir, outPath, outputKind: "llvm" });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return readFile(outPath, "utf8");
}

const calls = (llvm: string, symbol: string): string[] =>
  llvm.split("\n").filter((line) => line.includes(`call `) && line.includes(`@${symbol}(`));

test("captures only compared or converted to numbers stay spans", async () => {
  const llvm = await emit(`
const line = /^(\\w+) (\\d+) (\\w+)$/;
let total = 0;
for (const s of ["GET 200 a", "PUT 404 b"]) {
  const m = line.exec(s);
  if (m === null) continue;
  if (m[1] === "GET") total += Number(m[2]) + parseInt(m[2], 16);
  console.log(m[3]);
}
console.log(total);
`);
  // Captures 1 and 2 are lazy (6); capture 3 is read as a string (mask 14).
  const exec = calls(llvm, "scr_regex_exec_spans");
  expect(exec).toHaveLength(1);
  expect(exec[0]).toContain("double 0x402C000000000000, double 0x4018000000000000");
  expect(calls(llvm, "scr_regex_group_eq")).toHaveLength(1);
  expect(calls(llvm, "scr_regex_group_number")).toHaveLength(1);
  expect(calls(llvm, "scr_regex_group_parse_int")).toHaveLength(1);
});

test("a capture read as a string, or a result captured by a closure, keeps strings", async () => {
  const llvm = await emit(`
const kv = /(\\w+)=(\\w+)/;
const a = kv.exec("x=1");
if (a !== null) console.log(a[2] === "1", a[2]);
const b = kv.exec("y=2");
if (b !== null) {
  const later = (): boolean => b[1] === "y";
  console.log(later(), Number(b[2]));
}
`);
  expect(calls(llvm, "scr_regex_exec_spans")).toHaveLength(0);
  expect(calls(llvm, "scr_regex_exec_groups")).toHaveLength(2);
  expect(calls(llvm, "scr_regex_group_eq")).toHaveLength(0);
});

test("match results read by constant indices take the group masks", async () => {
  const llvm = await emit(`
for (const s of ["v1.2", "x"]) {
  const m = s.match(/^v(\\d+)\\.(\\d+)$/);
  if (m !== null) console.log(Number(m[1]), m[2]);
}
`);
  const match = calls(llvm, "scr_regex_match_groups");
  expect(match).toHaveLength(1);
  // Read captures 1 and 2 (6); capture 1 is lazy (2).
  expect(match[0]).toContain("double 0x4018000000000000, double 0x4000000000000000");
  expect(calls(llvm, "scr_regex_match")).toHaveLength(0);
});

test("numeric capture reads keep ordinary property access after the result escapes", async () => {
  const llvm = await emit(`
function read(): void {
  const match = /(\\d+)/.exec("12");
  if (match !== null) {
    const alias = match;
    console.log(alias[1]);
    console.log(Number(match[1]));
  }
}
read();
`);
  expect(calls(llvm, "scr_regex_exec_spans")).toHaveLength(0);
  expect(calls(llvm, "scr_regex_group_number")).toHaveLength(0);
  expect(calls(llvm, "scr_arr_property_get").length).toBeGreaterThan(0);
});

test("lazy numeric captures retain the absent-slot property read", async () => {
  const llvm = await emit(`
function read(): void {
  const match = /(a)?b/.exec("b");
  if (match !== null) console.log(Number(match[1]), Number(match[5]));
}
read();
`);
  expect(calls(llvm, "scr_regex_exec_spans")).toHaveLength(1);
  expect(calls(llvm, "scr_regex_group_number")).toHaveLength(2);
  expect(calls(llvm, "scr_arr_has")).toHaveLength(2);
  expect(calls(llvm, "scr_arr_property_get").length).toBeGreaterThanOrEqual(2);
});

test("chains of one-character global replacements fuse into one pass", async () => {
  const llvm = await emit(`
function escape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}
function ordered(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/a/g, "A");
}
console.log(escape('<a href="x">&</a>'), ordered("a&b"));
`);
  expect(calls(llvm, "scr_str_replace_chars")).toHaveLength(1);
  // A later step that matches an earlier replacement keeps both steps.
  expect(calls(llvm, "scr_regex_replace")).toHaveLength(2);
});
