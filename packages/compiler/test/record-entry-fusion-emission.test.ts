import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";

async function emit(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-record-entry-fusion-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    return emitLlvmModule(deserializeModule(await readFile(outPath, "utf8")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a dictionary update over the same bindings reuses the read's entry", async () => {
  const llvm = await emit(`
const counts: Record<string, number> = {};
function count(key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}
count("a");
count("b");
console.log(counts.a, counts.b);
`);
  expect(llvm).toMatch(/recfuse\.hit/);
  expect(llvm).toMatch(/recfuse\.miss/);
});

test("a dictionary update whose value expression can mutate takes both probes", async () => {
  const llvm = await emit(`
const counts: Record<string, number> = {};
function grow(n: number): number {
  for (let i = 0; i < n; i++) counts["g" + i] = i;
  return n;
}
function count(key: string): void {
  counts[key] = (counts[key] ?? 0) + grow(3);
}
count("a");
console.log(counts.a);
`);
  expect(llvm).not.toMatch(/recfuse\.hit/);
});
