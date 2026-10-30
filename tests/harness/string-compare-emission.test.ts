/* String comparison emission: the runtime calls behind a relational string
 * operator only read the two strings, so LLVM merges the comparisons of one
 * pair. A three-way comparator (`a < b ? -1 : a > b ? 1 : 0`) then compares
 * its strings once, as a comparator that tests one operator does. */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const repoRoot = join(import.meta.dirname, "../..");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");

async function emittedAsm(name: string, source: string, target: string): Promise<string> {
  const key = createHash("sha256").update(target).update(source).digest("hex").slice(0, 16);
  const outDir = join(cacheDir, `string-compare-${key}`);
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${name}.ts`);
  writeFileSync(file, source);
  const saved = process.env["SCRIPTC_TARGET"];
  if (target === "host") delete process.env["SCRIPTC_TARGET"];
  else process.env["SCRIPTC_TARGET"] = target;
  const result = await compile(file, {
    outPath: join(outDir, name),
    outDir,
    backend: "llvm",
    outputKind: "asm",
  }).finally(() => {
    if (saved === undefined) delete process.env["SCRIPTC_TARGET"];
    else process.env["SCRIPTC_TARGET"] = saved;
  });
  if (!result.ok)
    throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
  return readFileSync(result.artifact.path, "utf8");
}

const program = (body: string): string => `function order(a: string, b: string): number {
  return ${body};
}
const words = process.argv.slice(2);
words.sort(order);
console.log(words.join(","));
`;

// Calls to the comparison runtime: `call`/`callq` on x86-64 and `bl` on
// AArch64, with Mach-O's leading underscore on macOS.
const compareCalls = (asm: string): number =>
  asm.match(/\b(?:call[a-z]*|bl)\s+_?(?:sc_str_cmp_u16|scr_str_cmp_u16_bytes|scr_str_cmp)\b/g)
    ?.length ?? 0;

// The host's assembly, and two other targets' so that every host checks the
// x86-64, AArch64 and Mach-O spellings.
test.each(["host", "aarch64-linux-gnu", "x86_64-macos"])(
  "a three-way string comparator compares its pair once (%s)",
  async (target) => {
    const once = compareCalls(await emittedAsm("once", program("a < b ? -1 : 1"), target));
    const both = compareCalls(
      await emittedAsm("both", program("a < b ? -1 : a > b ? 1 : 0"), target),
    );
    expect(once).toBeGreaterThan(0);
    expect(both).toBe(once);
  },
);
