import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

async function emitLlvm(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-regex-replacers-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ll");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "llvm" });
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    return await readFile(outPath, "utf8");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("global substitutions of regex literals with literal replacements run a replacer", async () => {
  const llvm = await emitLlvm(`
const s = process.argv[2] ?? "a<b>c";
const rep = process.argv[3] ?? "-";
console.log(
  s.replace(/<[^>]*>/g, "|"),
  s.replaceAll(/a[bc]/g, "<2>"),
  s.replace(/<[^>]*>/g, "|"),
  s.replace(/<[^>]*>/g, "$&$&"),
  s.replace(/<[^>]*>/, "|"),
  s.replace(/<[^>]*>/gy, "|"),
  s.replace(/<[^>]*>/g, rep),
);
`);
  const replacers = llvm.match(/^define internal i32 @sc_rr_\d+\(/gm) ?? [];
  // One replacer per (pattern, flags, replacement): the repeated site shares it.
  expect(replacers).toHaveLength(2);
  expect(llvm.match(/call ptr @scr_regex_replace_with\(/g)).toHaveLength(3);
  // $ patterns, non-global and sticky patterns, and computed replacements
  // keep the runtime's loop.
  expect(llvm.match(/call ptr @scr_regex_replace\(/g)!.length).toBeGreaterThanOrEqual(4);
});
