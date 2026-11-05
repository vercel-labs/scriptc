import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";
import { analyzeInt32Slots } from "../src/ir/int32-slots.js";

test("module state proven non-negative takes unsigned remainders", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-int32-globals-"));
  try {
    const entry = join(import.meta.dirname, "../../../tests/corpus/module-state-int32.ts");
    const outPath = join(dir, "state.ir.json");
    const result = await compile(entry, { outPath, outDir: dir, outputKind: "ir" });
    if (!result.ok) throw new Error(result.diagnostics.map((d) => d.message).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    const slots = analyzeInt32Slots(mod);
    expect(slots.hasGlobal("%g.e.seed")).toBe(true);
    expect(slots.hasGlobal("%g.e.ticks")).toBe(true);
    // A negative or fractional write leaves the global a double.
    expect(slots.reasons.get("global:%g.e.balance")).toBe("write in spend is not int32");
    expect(slots.reasons.get("global:%g.e.ratio")).toBe("write in halve is not int32");
    // Read before its declaration runs (a TDZ check): no candidate.
    expect(slots.hasGlobal("%g.e.marker")).toBe(false);
    const ll = emitLlvmModule(mod, { pointerBits: 64 });
    const fill = ll.match(/define internal [^\n]+ @sc_bf_fill\([^\n]*\{([\s\S]*?)\n\}/)![1]!;
    expect(fill).toContain("urem i64");
    expect(fill).not.toContain("srem");
    expect(fill).not.toContain("frem");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
