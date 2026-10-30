/* Speculative integer loops (behavior is in the differential corpus, 7757):
 * the locals that hold hoisted calls are numbered per function, so a
 * function's text does not depend on the functions emitted before it (the
 * native compiler's function workers each emit a share of the module). */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const repoRoot = join(import.meta.dirname, "../..");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");

async function emittedLlvm(name: string, source: string): Promise<string> {
  const key = createHash("sha256").update(source).digest("hex").slice(0, 16);
  const outDir = join(cacheDir, `spec-leaves-${key}`);
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${name}.ts`);
  writeFileSync(file, source);
  const result = await compile(file, {
    outPath: join(outDir, name),
    outDir,
    backend: "llvm",
    outputKind: "llvm",
  });
  if (!result.ok)
    throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
  return readFileSync(result.artifact.path, "utf8");
}

function body(llvm: string, name: string): string {
  const start = llvm.search(new RegExp(`^define internal [^\\n]*@${name}[.(]`, "m"));
  expect(start).toBeGreaterThanOrEqual(0);
  return llvm.slice(start, llvm.indexOf("\n}\n", start));
}

test("hoisted speculative leaves are numbered per function", async () => {
  const llvm = await emittedLlvm(
    "leaves",
    `let calls = 0;
function noisy(x: number): number {
  calls++;
  return x % 5 === 0 ? x / 2 : x * 2;
}
function first(n: number): number {
  let acc = 1;
  for (let i = 0; i < n; i++) acc = (acc * 7 + noisy(i)) % 1000003;
  return acc;
}
function second(n: number): number {
  let acc = 3;
  for (let i = 0; i < n; i++) acc = (acc * 5 + noisy(i)) % 1000003;
  return acc;
}
console.log(first(20), second(20), calls);
`,
  );
  for (const name of ["sc_f_first", "sc_f_second"]) {
    const leaves = body(llvm, name).match(/%\w*spec_leaf_\d+ = alloca double/g) ?? [];
    expect(leaves).toHaveLength(1);
    expect(leaves[0]).toMatch(/_spec_leaf_0 = /);
  }
});
