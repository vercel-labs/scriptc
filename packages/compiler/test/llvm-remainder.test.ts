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
    const fn = (name: string): string =>
      new RegExp(`^define internal [^\\n]*@sc_[bf]+_${name}\\([^]*?^}`, "m").exec(ll)![0];
    // Four source remainders keep a floating fallback behind a runtime
    // integer check; three ToUint32 coercion fallbacks stay floating.
    expect(ll.match(/ = frem double /g)).toHaveLength(7);
    expect(ll.match(/ = srem i64 /g)).toHaveLength(5);
    expect(ll).toMatch(/ = select i1 [^\n]+double [^\n]+double /);
    // Unproven operands: both round-trip checks, the 2^53 dividend bound,
    // and a nonzero divisor guard the integer path.
    const unproven = fn("remainder");
    expect(unproven.match(/ = freeze i64 /g)).toHaveLength(2);
    expect(unproven).toMatch(/ = add i64 [^\n]+, 9007199254740992$/m);
    expect(unproven).toMatch(/ = icmp ule i64 [^\n]+, 18014398509481984$/m);
    expect(unproven).toMatch(/ = icmp ne i64 [^\n]+, 0$/m);
    expect(unproven).toContain("@llvm.expect.i1(");
    expect(unproven).toContain("rem.float");
    // A constant divisor needs only the dividend check.
    const constant = fn("constants");
    expect(constant).toMatch(/ = srem i64 [^\n]+, 8$/m);
    expect(constant).not.toMatch(/ = icmp ne i64 [^\n]+, 0$/m);
    // Proven integers with a nonzero divisor need no check or fallback.
    const signed = fn("signed");
    expect(signed).not.toContain("freeze");
    expect(signed).not.toContain("rem.float");
    // Proven integers whose divisor may be zero check only for zero.
    const maybeZero = fn("maybeZero");
    expect(maybeZero).not.toContain("freeze");
    expect(maybeZero).toMatch(/ = icmp ne i64 [^\n]+, 0$/m);
    expect(maybeZero).toContain("rem.float");
    expect(ll).not.toContain("@llvm.fptosi.sat");
    expect(ll).not.toContain("@fmod");
    expect(ll).toContain("call double @pow(");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
