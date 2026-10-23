import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

async function emitLlvm(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-array-induction-read-"));
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

const source = `
function sum(values: number[]): number {
  let total = 0;
  for (let i = 0; i < values.length; i++) total += values[i]!;
  return total;
}
function at(values: number[], k: number): number {
  return values[k]!;
}
console.log(sum([1, 2, 3]), sum(process.argv.map((a) => a.length)), at([4, 5], 1));
`;

test("an element read indexed by a loop counter reads above the prefix through the runtime", async () => {
  const llvm = await emitLlvm(source);
  const sum = /^define internal double @sc_bf_sum\([^]*?^}/m.exec(llvm)?.[0] ?? "";
  // No state address (data + cap * 9 - 1 - i) inside the loop: slots at or
  // above the hole-free prefix take scr_arr_get_f64.
  expect(sum).toMatch(/call double @scr_arr_get_f64\(/);
  expect(sum).not.toMatch(/getelementptr inbounds \[9 x i8\], ptr /);
  // The loop bound compares the counter with the i32 length field in 32 bits.
  expect(sum).toMatch(/(%\S+) = trunc i64 %\S+ to i32\n\s*%\S+ = icmp ult i32 \1, %\S+/);
  // Other indices keep the inline state check. `values[k]!` at any index
  // may read a missing element, which is undefined, as for `values[k]`.
  const at = /^define internal [^\n]*@sc_bf_at[.(][^]*?^}/m.exec(llvm)?.[0] ?? "";
  expect(at).toMatch(/getelementptr inbounds \[9 x i8\], ptr /);
});
