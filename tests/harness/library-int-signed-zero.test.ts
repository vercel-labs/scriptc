import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { compileLibrary } from "@scriptc/compiler";

const repoRoot = join(import.meta.dirname, "../..");
const flavor = process.env["SCRIPTC_SAN"] === "1" ? "san" : "plain";
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests/library-int-signed-zero", flavor);

interface SignedZeroCase {
  name: string;
  body: string;
  samples: { input: number; output: number }[];
}

const CASES: SignedZeroCase[] = [
  {
    name: "positive-reciprocal",
    body: `if (z === 0) return Math.trunc(Math.min(1 / z, 1));
return 0;`,
    samples: [{ input: 0, output: 1 }, { input: -0, output: -Infinity }],
  },
  {
    name: "negative-reciprocal",
    body: `if (z === 0) return Math.trunc(Math.max(-1 / z, -1));
return 0;`,
    samples: [{ input: 0, output: -1 }, { input: -0, output: Infinity }],
  },
  ...[-1, -3].map((exponent): SignedZeroCase => ({
    name: `negative-odd-power-${-exponent}`,
    body: `if (z === 0) return Math.trunc(Math.min(z ** (${exponent}), 1));
return 0;`,
    samples: [{ input: 0, output: 1 }, { input: -0, output: -Infinity }],
  })),
  {
    name: "trunc-produces-negative-zero",
    body: `if (z >= -0.5 && z <= 0) {
  const zero = Math.trunc(z);
  return Math.trunc(Math.min(1 / zero, 1));
}
return 0;`,
    samples: [{ input: 0, output: 1 }, { input: -0.25, output: -Infinity }],
  },
];

// Exercise actual TypeScript lowering and profile-declared return slots.
// These programs must refuse before native emission: zero equality and
// rounded interval endpoints cannot distinguish +0 from -0, and a one-sided
// clamp cannot make both signs of the resulting infinity integer-safe.
describe.each(["i64", "u64"] as const)("signed-zero %s return refusals", (cls) => {
  test.each(CASES)("$name", async (c) => {
    // Execute exactly the same body in Node to pin the concrete witness.
    // This also covers -0 produced by arithmetic from a nonzero input.
    const oracle = new Function("z", c.body) as (z: number) => number;
    for (const { input, output } of c.samples) expect(oracle(input)).toBe(output);

    const outDir = join(cacheDir, `${cls}-${c.name}`);
    mkdirSync(outDir, { recursive: true });
    const entry = join(outDir, "lib.ts");
    const source = `export function f(z: number): number {\n${c.body}\n}\n`;
    writeFileSync(entry, source);
    const profilePath = join(outDir, "profile.json");
    writeFileSync(profilePath, JSON.stringify({
      profile_format: 1,
      name: "signed-zero",
      entry,
      emission: "llvm",
      abi: {
        prefix: "sz_",
        init_symbol: "sz_init",
        sink_register_symbol: "sz_set_panic_sink",
        collect_symbol: null,
        result_reset_symbol: null,
      },
      exports: [{ export: "f", symbol: "sz_f", params: ["f64"], returns: cls }],
    }, null, 2));

    const result = await compileLibrary({ profilePath, outDir });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.sourceTexts.get(entry)).toBe(source);
    expect(result.diagnostics.map((d) => d.code)).toEqual(["SC4023"]);
    const diagnostic = result.diagnostics[0]!;
    expect(diagnostic.message).toContain("'exports.f.return'");
    expect(diagnostic.message).toContain("range failed");
    expect(diagnostic.message).toContain("Infinity");
    expect(diagnostic.hint).toBeTruthy();
  });
});
