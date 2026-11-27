import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

// A dynamic dictionary read keeps its missing key as undefined (#4192). A
// non-null asserted read (`record[key]!`) asserts presence and `!` performs
// no check, so a numeric use coerces the direct value with ToNumber (one
// js.toNumberOrNaN): a present number unboxes in place and a missing key
// answers NaN, exactly what `undefined + n` computes. The validated
// number | undefined union and its scalar-union helper cost the
// record-untyped-writes workload 4.9x its v0.4.17 time; a checked extraction
// (js.toF64) would throw for the missing key where Node computes NaN.
test("a non-null asserted dictionary read lowers to the direct number", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-asserted-dict-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir");
    await writeFile(
      entry,
      `
function bump(target: unknown, key: string, by: number): void {
  const record = target as Record<string, number>;
  record[key] = record[key]! + by;
}
bump({ a: 1 }, "a", 2);
`,
    );
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    const ir = await readFile(outPath, "utf8");
    expect(ir).toContain('"fn":"js.toNumberOrNaN"');
    expect(ir).not.toContain('"fn":"js.toF64"');
    expect(ir).not.toContain("%number.scalar");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
