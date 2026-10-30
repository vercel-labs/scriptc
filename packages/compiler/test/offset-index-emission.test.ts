import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

function functionBody(llvm: string, name: string): string {
  const start = llvm.indexOf(name);
  return llvm.slice(start, llvm.indexOf("\n}\n", start));
}

async function emitLlvm(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-offset-index-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ll");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "llvm" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    return await readFile(outPath, "utf8");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("typed array accesses at a number base plus an integer convert the base, not the sum", async () => {
  const llvm = await emitLlvm(`
function window(values: Float64Array, at: number): number {
  return values[at + 0]! + values[at + 1]! + values[2 + at]! + values[at - 1]!;
}
const values = new Float64Array([1, 2, 3, 4, 5, 6]);
console.log(window(values, Number(process.argv[2] ?? "1")));
`);
  const body = functionBody(llvm, "@sc_bf_window(");
  const sums = new Set([...body.matchAll(/(%t\d+) = fadd double/g)].map((m) => m[1]));
  // Each access converts the base and adds its offset as an integer. Only
  // a fractional base reaches the exact check of the sum itself.
  const fast = body
    .split(/\n(?=[\w.]+:)/)
    .filter((block) => !block.startsWith("bytes.index.sum"))
    .join("\n");
  const converted = [...fast.matchAll(/fptosi double (%[\w.]+) to i64/g)].map((m) => m[1]);
  expect(converted.length).toBeGreaterThanOrEqual(4);
  expect(converted.filter((name) => sums.has(name))).toEqual([]);
  for (const offset of [1, 2, -1])
    expect(body).toMatch(new RegExp(`= add i64 %t\\d+, ${offset}\\n`));
});

test("a typed array write converts the base its index sum read, before the right-hand side", async () => {
  const llvm = await emitLlvm(`
function rebase(values: Int32Array, at: number): number {
  values[at + 1] = ((at = 5), 31);
  return at;
}
const values = new Int32Array(8);
console.log(rebase(values, Number(process.argv[2] ?? "2")), values.join(","));
`);
  const body = functionBody(llvm, "@sc_bf_rebase(");
  const base = /= fadd double (%[\w.]+), /.exec(body)?.[1];
  expect(base).toBeDefined();
  expect(body).toContain(`fptosi double ${base} to i64`);
});
