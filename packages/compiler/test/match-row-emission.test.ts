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
  const outDir = await mkdtemp(join(tmpdir(), "scriptc-match-rows-"));
  directories.push(outDir);
  const entry = join(outDir, "main.ts");
  await writeFile(entry, source);
  const outPath = join(outDir, "program.ll");
  const result = await compile(entry, { entry, outDir, outPath, outputKind: "llvm" });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return readFile(outPath, "utf8");
}

const calls = (llvm: string, symbol: string): number =>
  llvm.split("\n").filter((line) => line.includes("call ") && line.includes(`@${symbol}(`)).length;

test("rows read only through their elements carry no match metadata", async () => {
  const llvm = await emit(`
const text = "k1=v1; k2=v2;";
const re = /(?<key>k\\d)=(?<val>v\\d);/g;
for (const m of text.matchAll(re)) console.log(m.index, m[1], m.groups!.val, 1 in m);
console.log([...text.matchAll(re)].map((m) => m[2]).join(","));
console.log([...text.matchAll(re)].filter((m) => m.length > 2).find((m) => m[1] === "k2")?.[2]);
console.log(Array.from(text.matchAll(re), ({ groups }) => groups!.key).join(","));
const rows = [...text.matchAll(re)];
for (const row of rows.slice(1)) console.log(row[0]);
`);
  expect(calls(llvm, "scr_regex_match_all_captures_into")).toBe(1);
  expect(calls(llvm, "scr_regex_match_all_captures")).toBe(4);
  expect(calls(llvm, "scr_regex_match_all")).toBe(0);
  expect(calls(llvm, "scr_regex_match_all_into")).toBe(0);
});

test("rows whose properties are read or that escape keep match metadata", async () => {
  const llvm = await emit(`
const text = "k1=v1; k2=v2;";
const re = /(?<key>k\\d)=(?<val>v\\d);/g;
for (const m of text.matchAll(re)) console.log(m.input.length);
console.log([...text.matchAll(re)].map((m) => m.index).join(","));
function first(m: RegExpExecArray): string {
  return m[1]!;
}
console.log([...text.matchAll(re)].map(first).join(","));
console.log([...text.matchAll(re)].map((m) => m)[0]![1]);
`);
  expect(calls(llvm, "scr_regex_match_all_into")).toBe(1);
  expect(calls(llvm, "scr_regex_match_all")).toBe(3);
  expect(calls(llvm, "scr_regex_match_all_captures")).toBe(0);
  expect(calls(llvm, "scr_regex_match_all_captures_into")).toBe(0);
});

test(".index and .input on a match slice read its match source", async () => {
  const llvm = await emit(`
const rows = [..."a1b2".matchAll(/[a-z](\\d)/g)];
console.log(rows[1]!.index, rows[0]!.input);
const m = /b/.exec("ab")!;
console.log(m.index);
`);
  expect(calls(llvm, "scr_regex_result_prop")).toBe(3);
});
