import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

async function emitLlvm(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-periodic-guards-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ll");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "llvm" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    return await readFile(outPath, "utf8");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a counted loop with a check every fourth iteration asks LLVM to unroll it by 4", async () => {
  const llvm = await emitLlvm(`
function escape(c: number): number {
  let z = 0;
  let m = 0;
  for (let j = 0; j < 50; j++) {
    z = z * z + c;
    m = z * z;
    if ((j & 3) === 3 && !(m <= 4)) break;
  }
  return m;
}
console.log(escape(Number(process.argv[2] ?? "0.25")));
`);
  expect(llvm).toMatch(/br label %loop\.c\d+, !llvm\.loop !1000004/);
  expect(llvm).toContain(`!1000004 = distinct !{!1000004, !{!"llvm.loop.unroll.count", i32 4}}`);
});

test("a loop without a periodic guard has no loop metadata", async () => {
  const llvm = await emitLlvm(`
function sum(n: number): number {
  let s = 0;
  for (let j = 0; j < n; j++) {
    s += j;
    if (s > 1000) break;
  }
  return s;
}
console.log(sum(Number(process.argv[2] ?? "10")));
`);
  expect(llvm).not.toContain("!llvm.loop");
});
