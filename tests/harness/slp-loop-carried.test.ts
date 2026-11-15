/* A loop test written as `|dx| + |dy| < eps`: the SLP vectorizer's cost
 * model can call packing the two deltas into one vector a break-even gain,
 * and the vector's insertion and extraction then sit in the loop's carried
 * chain, slower than the scalar comparisons they replace. The helper asks
 * for a positive estimated gain, so the loop stays scalar. */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const repoRoot = join(import.meta.dirname, "../..");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");

async function emittedAsm(name: string, source: string): Promise<string> {
  const key = createHash("sha256").update(source).digest("hex").slice(0, 16);
  const outDir = join(cacheDir, `slp-loop-carried-${key}`);
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${name}.ts`);
  writeFileSync(file, source);
  const result = await compile(file, {
    outPath: join(outDir, name),
    outDir,
    backend: "llvm",
    outputKind: "asm",
  });
  if (!result.ok)
    throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
  return readFileSync(result.artifact.path, "utf8");
}

const program = `const MAX = 4000;
function sample(px: number, py: number): number {
  let x = 0;
  let y = 0;
  let ox = 0;
  let oy = 0;
  let i = 0;
  while (i < MAX) {
    const nx = x * x - y * y + px;
    const ny = 2 * x * y + py;
    ox = x;
    oy = y;
    x = nx;
    y = ny;
    if (Math.abs(x - ox) + Math.abs(y - oy) < 1e-15) break;
    if (x * x + y * y > 4) break;
    i++;
  }
  return i;
}
let sum = 0;
for (let j = 0; j < 2000; j++) sum += sample(-1.5 + j / 2000, -0.5);
console.log(sum);
`;

// Two-lane packed floating-point arithmetic: the SLP vectorizer's output.
// Packed integer operations are not counted; address arithmetic can use them
// without packing a carried value.
const packedArithmetic = (asm: string): number =>
  asm.match(/\b(?:unpcklpd|unpckhpd|addpd|subpd|mulpd|divpd|cmpltpd|cmplepd)\b/g)?.length ?? 0;

test.skipIf(process.arch !== "x64")(
  "a loop's symmetric periodicity test does not get packed into a vector",
  async () => {
    expect(packedArithmetic(await emittedAsm("periodicity", program))).toBe(0);
  },
);
