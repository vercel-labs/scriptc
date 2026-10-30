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
  const outDir = await mkdtemp(join(tmpdir(), "scriptc-string-iteration-"));
  directories.push(outDir);
  const entry = join(outDir, "main.ts");
  await writeFile(entry, source);
  const outPath = join(outDir, "program.ll");
  const result = await compile(entry, { entry, outDir, outPath, outputKind: "llvm" });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return readFile(outPath, "utf8");
}

const calls = (llvm: string, symbol: string): string[] =>
  llvm.split("\n").filter((line) => line.includes("call ") && line.includes(`@${symbol}(`));

test("for-of over a string walks a byte cursor", async () => {
  const llvm = await emit(`
function count(s: string): number {
  let n = 0;
  for (const c of s) n += c.length;
  return n;
}
console.log(count(process.argv[1] ?? ""));
`);
  expect(calls(llvm, "sc_str_cp_at_byte")).toHaveLength(1);
  expect(calls(llvm, "scr_str_cp_at")).toHaveLength(0);
  // The helper answers ASCII bytes from the one-character table.
  expect(llvm).toContain("define internal ptr @sc_str_cp_at_byte(ptr %s, i64 %b)");
});

test("spread and Array.from of a string build the array in one call", async () => {
  const llvm = await emit(`
const s = process.argv[1] ?? "";
console.log([...s].length, Array.from(s).length);
`);
  expect(calls(llvm, "scr_str_code_points")).toHaveLength(2);
});
