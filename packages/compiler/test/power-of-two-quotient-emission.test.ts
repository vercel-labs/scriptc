import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";

test("a quotient by Math.pow(2, n) multiplies by the divisor's reciprocal power of two", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-pow2-quotient-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(
      entry,
      `
function scaled(x: number, n: number): number { return x / Math.pow(2, n); }
function plain(x: number, d: number): number { return x / d; }
function other(x: number, n: number): number { return x / Math.pow(3, n); }
console.log(scaled(3, 4), plain(3, 16), other(3, 4));
`,
    );
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    const ll = emitLlvmModule(mod);
    const fn = (name: string): string =>
      new RegExp(`^define internal [^\\n]*@sc_[bf]+_${name}(?:\\.i32)?\\([^]*?^}`, "m").exec(
        ll,
      )![0];
    // The reciprocal's bits are 0x7FE0000000000000 minus the divisor's; a
    // divisor that is not a power of two from 2^-1022 to 2^1022 divides.
    const quotient = fn("scaled");
    expect(quotient).toContain(`sub i64 ${0x7fe0000000000000n}, `);
    expect(quotient).toMatch(/fmul double %\w+, %\w+/);
    expect(quotient).toMatch(/icmp ult i64 %\w+, 2045/);
    expect(quotient).toMatch(/select i1 %\w+, double %\w+, double %\w+/);
    expect(quotient.match(/ = fdiv double /g)).toHaveLength(1);
    for (const name of ["plain", "other"]) {
      expect(fn(name)).not.toContain(`${0x7fe0000000000000n}`);
      expect(fn(name)).toMatch(/fdiv double/);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
