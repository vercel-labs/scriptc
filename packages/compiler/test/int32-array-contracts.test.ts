import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";

const repoRoot = join(import.meta.dirname, "../../..");

const source = `
import type { Int32 } from "@scriptc/types";
function make(n: number): Int32[] {
  const out: Int32[] = [];
  for (let i = 0; i < n; i++) out.push((i * 7) & 255);
  return out;
}
function sum(a: Int32[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s = (s + a[i]) | 0;
  return s;
}
function xorAll(a: Int32[]): number {
  let h = 0;
  for (let i = 0; i < a.length; i++) h = h ^ a[i];
  return h;
}
function plainSum(a: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s = (s + a[i]) | 0;
  return s;
}
function first(a: Int32[]): number {
  return a.length > 0 ? a[0] : -1;
}
const xs = make(100);
const floats = [0.5, 1.5];
console.log(sum(xs), xorAll(xs), plainSum(floats), plainSum([1, 2]), first(xs));
`;

const body = (ll: string, name: string): string =>
  ll.match(
    new RegExp(
      `define internal [^\\n]+ @sc_(?:b)?f_${name}(?:\\.i32)?\\([^\\n]*\\) align 64 #0 \\{ ;([\\s\\S]*?)\\n\\}`,
    ),
  )![1]!;

test("Int32[] element reads compute integer kernels in 32 bits", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-int32-arrays-"));
  try {
    await symlink(join(repoRoot, "node_modules"), join(dir, "node_modules"));
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    const facts = mod.contracts?.int32Elements ?? [];
    expect(facts).toContain("l:sum\0a.0");
    expect(facts).toContain("l:xorAll\0a.0");
    expect(facts).toContain("r:make");
    // The unannotated function also receives a float array: no fact.
    expect(facts).not.toContain("l:plainSum\0a.0");

    const ll = emitLlvmModule(mod, { pointerBits: 64, wasi: false });
    // (s + a[i]) | 0 over an Int32[] element: a wrapping i32 add that
    // selects 0 when the read found no value (NaN), with no ToInt32 slow
    // path on the loop-carried accumulator.
    const sum = body(ll, "sum");
    expect(sum).toMatch(/ = add i32 /);
    expect(sum).toMatch(/ = fcmp ord double /);
    expect(sum).not.toContain("uint32.coerce.slow");
    // h ^ a[i]: the element's ToInt32 is its low 32 bits, or 0 for NaN.
    const xor = body(ll, "xorAll");
    expect(xor).toMatch(/ = select i1 %\w+, i32 %\w+, i32 0/);
    expect(xor).not.toContain("uint32.coerce.slow");
    // A number[] that may hold fractions keeps the full conversion.
    expect(body(ll, "plainSum")).toContain("uint32.coerce.slow");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
