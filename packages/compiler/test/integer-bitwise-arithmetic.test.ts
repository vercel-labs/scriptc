import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";

test("bounded integer arithmetic emits integer operations and leaves uncertain numbers alone", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-integer-bits-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(
      entry,
      `
function safe(input: number): number {
  let h = input >>> 0;
  h = h ^ (h << 13);
  h = h + (h << 3);
  return h >>> 0;
}
function unknown(input: number): number { return (input + 1) >>> 0; }
function negativeZero(): number { const x = -0; return x + x; }
console.log(safe(17), unknown(1.5), 1 / negativeZero());
// A fractional argument keeps safe's input arbitrary (no call-site proof).
console.log(safe(0.5));
`,
    );
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));

    const ll = emitLlvmModule(mod);
    const llBody = (name: string): string =>
      ll.match(
        new RegExp(
          `define internal [^\\n]+ @sc_f_${name}(?:\\.i32)?\\([^\\n]*\\) align 64 #0 \\{([\\s\\S]*?)\\n\\}`,
        ),
      )![1]!;
    expect(llBody("safe")).toContain(" = add nsw i64 ");
    // The arbitrary input's slow ToUint32 path is integer arithmetic: no
    // double additions and no `frem` (an `fmod` call LLVM could hoist).
    expect(llBody("safe")).toContain("uint32.coerce.slow");
    expect(llBody("safe")).not.toContain(" = fadd double ");
    expect(llBody("safe")).not.toContain("frem");
    expect(llBody("unknown")).toContain("uint32.coerce.slow");
    expect(llBody("unknown")).toContain(" = fadd double ");
    expect(llBody("negativeZero")).toContain(" = fadd double ");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
