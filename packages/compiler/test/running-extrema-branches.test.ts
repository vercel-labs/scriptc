import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

async function emitLlvm(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-running-extrema-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ll");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "llvm" });
    if (!result.ok) throw new Error(result.diagnostics.map((d) => d.message).join("\n"));
    return await readFile(outPath, "utf8");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const RARE =
  /br i1 %\S+, label %if\.t\d+, label %if\.j\d+, !prof !\{!"branch_weights", i32 1, i32 1000\}/;

test("a running maximum's update is weighted as rarely taken", async () => {
  const llvm = await emitLlvm(`
    function argmax(a: Float64Array): number {
      let max = -Infinity;
      let at = -1;
      for (let i = 0; i < a.length; i++) {
        const v = a[i]!;
        if (v > max) { max = v; at = i; }
      }
      return at;
    }
    console.log(argmax(new Float64Array([1, 3, 2])));
  `);
  expect(llvm).toMatch(RARE);
});

test("a callback's update of a captured minimum is weighted", async () => {
  const llvm = await emitLlvm(`
    function least(values: number[]): number {
      let min = Infinity;
      values.forEach((v) => { if (min > v) min = v; });
      return min;
    }
    console.log(least([3, 1, 2]));
  `);
  expect(llvm).toMatch(RARE);
});

test("clamps and saturating sums keep their selects", async () => {
  const llvm = await emitLlvm(`
    function clampSum(a: Float64Array, hi: number): number {
      let s = 0;
      for (let i = 0; i < a.length; i++) {
        let v = a[i]!;
        if (hi < v) v = hi;
        s += v;
      }
      return s;
    }
    function saturate(a: Float64Array, hi: number): number {
      let v = 0;
      for (let i = 0; i < a.length; i++) {
        v += a[i]!;
        if (hi < v) v = hi;
      }
      return v;
    }
    const a = new Float64Array([0.5, 2, 0.25]);
    console.log(clampSum(a, 1), saturate(a, 1));
  `);
  expect(llvm).not.toContain("branch_weights");
});
