import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

async function emitLlvm(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-union-scalar-eq-"));
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
function zeros(a: number[], at: number[]): number {
  let n = 0;
  for (const i of at) if (a[i] === 0) n++;
  return n;
}
function flags(a: (boolean | undefined)[]): number {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] === true) n++;
  return n;
}
console.log(zeros([0, 1, 0], [0, 1, 2, 5]), flags([true, undefined, false]));
`;

test("comparing a union with a number or boolean reads its payload inline", async () => {
  const llvm = await emitLlvm(source);
  for (const name of ["zeros", "flags"]) {
    const fn = new RegExp(`^define internal double @sc_bf_${name}\\([^]*?^}`, "m").exec(llvm)?.[0];
    expect(fn, name).toBeDefined();
    // The tag test and the payload load stay in the function, so the
    // union's stack box has no escaping use.
    expect(fn).not.toMatch(/@scr_union_get_(f64|bool)\(/);
    expect(fn).toMatch(/getelementptr inbounds %ScrUnion, ptr %\S+, i64 0, i32 5/);
  }
});
