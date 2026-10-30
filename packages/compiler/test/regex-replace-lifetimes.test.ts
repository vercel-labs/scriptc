import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

async function emitLlvm(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-regex-replace-"));
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

function functionBody(llvm: string, name: string): string[] {
  const start = llvm.split("\n").findIndex((l) => l.startsWith("define") && l.includes(name));
  expect(start).toBeGreaterThanOrEqual(0);
  const lines = llvm.split("\n").slice(start);
  return lines.slice(0, lines.indexOf("}"));
}

test("a chain of substitutions releases each intermediate result when the next one returns", async () => {
  const llvm = await emitLlvm(`
function chain(s: string): number {
  return s
    .replace(/a[bc]/g, "<1>")
    .replace(/b[cd]/g, "<2>")
    .replace(/c[de]/g, "<3>")
    .replaceAll(/<[^>]*>/g, "|").length;
}
console.log(chain(process.argv[2] ?? "abcabc"));
`);
  const body = functionBody(llvm, "chain");
  const calls = body
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /call ptr @scr_regex_replace(_all|_with)?\(/.test(line));
  expect(calls).toHaveLength(4);
  const results = calls.map(({ line }) => /^\s*(%[\w.]+) = call/.exec(line)![1]!);
  // Each intermediate result is released after the call that consumes it
  // and before the next substitution starts.
  for (let k = 0; k < 3; k++) {
    const release = body.findIndex(
      (line, index) =>
        index > calls[k + 1]!.index &&
        line.includes("release") &&
        line.includes(`(ptr ${results[k]})`),
    );
    expect(release, `release of ${results[k]}`).toBeGreaterThan(calls[k + 1]!.index);
    if (k + 2 < calls.length) expect(release).toBeLessThan(calls[k + 2]!.index);
  }
});
