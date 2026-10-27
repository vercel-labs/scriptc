import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

async function emitLlvm(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-index-product-"));
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
function at(a: number[], x: number, y: number, k: number): number | undefined {
  return a[x * y + k];
}
function cancel(a: number[], p: number, q: number, r: number, s: number): number | undefined {
  return a[p * q - r * s];
}
const a = [1, 2, 3];
const v = process.argv.length;
console.log(at(a, v | 0, (v + 1) | 0, -v | 0), cancel(a, v | 0, v | 0, v | 0, v | 0));
`;

function body(llvm: string, name: string): string {
  return new RegExp(`^define [^@]*@sc_\\w+?_${name}(\\.i32)?\\([^]*?^}`, "m").exec(llvm)?.[0] ?? "";
}

test("an int32 product plus an int32 indexes as an exact i64 without a round trip", async () => {
  const llvm = await emitLlvm(source);
  // The int32 entry: the index is the i64 product and sum, compared with
  // the array's counts; the double goes only to the slow path's runtime call.
  const at = /^define [^@]*@sc_bf_at\.i32\([^]*?^}/m.exec(llvm)?.[0] ?? "";
  const product = /(%\S+) = mul nsw i64 %\S+, %\S+/.exec(at)?.[1];
  expect(product).toBeDefined();
  expect(at).toContain(`= add nsw i64 ${product}, `);
  expect(at).not.toMatch(/fptosi double %\S+ to i64/);
});

test("a difference of two int32 products keeps the double's round trip", async () => {
  const llvm = await emitLlvm(source);
  // Each product may pass 2^53, where its double rounds before the
  // difference: the index keeps the exactness test of the double.
  const cancel = body(llvm, "cancel");
  expect(cancel).toMatch(/fptosi double %\S+ to i64/);
  expect(cancel).toMatch(/fcmp oeq double/);
});
