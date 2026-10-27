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
  let value = x % 10;
  value %= 3;
  return value;
}
function powers(x: number): number {
  return (x % 8) + (x % -(2 ** 32)) + (x % 1) + (x % 0.5);
}
function hash(s: number, x: number): number { return (s * 31 + x) % 65536; }
function power(x: number, y: number): number { return x ** y; }
function signed(x: number): number { return (x | 0) % -7; }
function maybeZero(x: number, y: number): number { return (x | 0) % (y | 0); }
console.log(remainder(-9.5, 8), constants(17.25), power(2, 3), signed(-7), maybeZero(7, 0));
console.log(powers(-9.75), hash(-3.5, 7));
// Fractional arguments keep the parameters arbitrary (no call-site proof).
console.log(remainder(5, 2.5), signed(-7.5), maybeZero(7.5, 2.5));
`,
    );
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    // A target with a rounding instruction; x86-64 is checked below.
    const ll = emitLlvmModule(mod, { targetTriple: "aarch64-unknown-linux-gnu" });
    const fnIn = (module: string, name: string): string =>
      new RegExp(`^define internal [^\\n]*@sc_[bf]+_${name}(?:\\.i32)?\\([^]*?^}`, "m").exec(
        module,
      )![0];
    const fn = (name: string): string => fnIn(ll, name);
    // Five source remainders keep a floating fallback: four behind a
    // runtime integer check and the one by 0.5. ToUint32 coercion
    // fallbacks use integer arithmetic.
    expect(ll.match(/ = frem double /g)).toHaveLength(5);
    expect(ll).toContain("uint32.coerce.slow");
    expect(ll.match(/ = srem i64 /g)).toHaveLength(5);
    expect(ll).toMatch(/ = select i1 [^\n]+double [^\n]+double /);
    // Unproven operands: both round-trip checks, the 2^62 dividend bound,
    // and a nonzero divisor guard the integer path.
    const unproven = fn("remainder");
    expect(unproven.match(/ = freeze i64 /g)).toHaveLength(2);
    expect(unproven).toMatch(/ = add i64 [^\n]+, 4611686018427387904$/m);
    expect(unproven).toMatch(/ = icmp sge i64 [^\n]+, 0$/m);
    expect(unproven).toMatch(/ = icmp ne i64 [^\n]+, 0$/m);
    expect(unproven).toContain("@llvm.expect.i1(");
    expect(unproven).toContain("rem.float");
    // A constant divisor needs only the dividend check.
    const constant = fn("constants");
    expect(constant).toMatch(/ = srem i64 [^\n]+, 10$/m);
    expect(constant).not.toMatch(/ = icmp ne i64 [^\n]+, 0$/m);
    // Power-of-two divisors of at least 1 subtract the truncated multiple,
    // with no integer check; the divisor's sign is dropped and 0.5 keeps
    // frem.
    const powers = fn("powers");
    expect(powers).not.toContain("freeze");
    expect(powers).not.toContain("srem");
    expect(powers.match(/ = fdiv double [^\n]+, 0x/g)).toHaveLength(3);
    expect(powers).toMatch(/ = fdiv double [^\n]+, 0x4020000000000000$/m);
    expect(powers).toMatch(/ = fdiv double [^\n]+, 0x41F0000000000000$/m);
    expect(powers).toMatch(/ = fdiv double [^\n]+, 0x3FF0000000000000$/m);
    expect(
      powers.match(/ = call double @llvm.copysign.f64\(double 0x0000000000000000, /g),
    ).toHaveLength(3);
    expect(powers).toMatch(/ = frem double [^\n]+, 0x3FE0000000000000$/m);
    expect(fn("hash")).toMatch(/ = fdiv double [^\n]+, 0x40F0000000000000$/m);
    expect(ll).not.toContain("rem.pow2");
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
    expect(ll).toContain("call double @scr_math_pow(");

    // Where truncation is an integer round trip, a dividend below 2^62 takes
    // the i64 remainder by the power of two and adds back its fraction; a
    // computed dividend first tries the plain integer remainder, then one
    // conditional subtraction below twice the divisor. Larger, infinite and
    // NaN dividends keep the double sequence.
    const x86 = emitLlvmModule(mod, { targetTriple: "x86_64-unknown-linux-gnu" });
    const x86Powers = fnIn(x86, "powers");
    expect(x86Powers.match(/ = srem i64 [^\n]+, (?:8|4294967296|1)$/gm)).toHaveLength(3);
    expect(x86Powers.match(/^rem\.pow2\.frac\d*:/gm)).toHaveLength(3);
    expect(x86Powers).not.toContain("rem.pow2.int");
    expect(x86Powers).not.toContain("rem.int");
    expect(x86Powers.match(/ = fdiv double [^\n]+, 0x/g)).toHaveLength(3);
    expect(x86Powers).toMatch(/ = fcmp olt double [^\n]+, 0x43D0000000000000$/m);
    expect(x86Powers).toMatch(/ = frem double [^\n]+, 0x3FE0000000000000$/m);
    const x86Hash = fnIn(x86, "hash");
    expect(x86Hash.match(/^rem\.pow2\.int\d*:/gm)).toHaveLength(1);
    expect(x86Hash.match(/ = srem i64 [^\n]+, 65536$/gm)).toHaveLength(2);
    // |x| < 2 * 65536 subtracts copysign(65536, x) at most once.
    expect(x86Hash.match(/^rem\.pow2\.small\d*:/gm)).toHaveLength(1);
    expect(x86Hash.match(/^rem\.pow2\.keep\d*:/gm)).toHaveLength(1);
    expect(x86Hash).toMatch(/ = fcmp olt double [^\n]+, 0x4100000000000000$/m);
    expect(x86Hash).toMatch(/ = fcmp olt double [^\n]+, 0x40F0000000000000$/m);
    expect(x86Hash).toMatch(/ = call double @llvm.copysign.f64\(double 0x40F0000000000000, /);
    expect(x86Hash).not.toContain("frem");
    expect(x86Hash).not.toContain("rem.int");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
