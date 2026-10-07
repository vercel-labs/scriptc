import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";

test("remainder uses integer proofs and preserves floating fallback and signed zero", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-llvm-remainder-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(
      entry,
      `
function remainder(x: number, y: number): number { return x % y; }
function constants(x: number): number {
  let value = x % 8;
  value %= 3;
  return value;
}
function power(x: number, y: number): number { return x ** y; }
function signed(x: number): number { return (x | 0) % -7; }
function maybeZero(x: number, y: number): number { return (x | 0) % (y | 0); }
console.log(remainder(-9.5, 8), constants(17.25), power(2, 3), signed(-7), maybeZero(7, 0));
`,
    );
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    const ll = emitLlvmModule(mod);
    // Four source remainders and three ToUint32 coercion fallbacks stay floating.
    expect(ll.match(/ = frem double /g)).toHaveLength(7);
    expect(ll.match(/ = srem i64 /g)).toHaveLength(1);
    expect(ll).toMatch(/ = select i1 [^\n]+double [^\n]+double /);
    expect(ll).not.toContain("@llvm.fptosi.sat");
    expect(ll).not.toContain("@fmod");
    expect(ll).toContain("call double @pow(");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
