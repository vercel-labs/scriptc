import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";
import { findConstantNumericTables } from "../src/ir/constant-tables.js";

test("LLVM uses guarded native constants and retain array initialization", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-constant-tables-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(
      entry,
      `
const table = [3, -0, Infinity];
function lookup(i: number): number { return table[i] * 1; }
const mutated = [4, 5];
mutated[0] = 6;
console.log(lookup(1), mutated[0] * 1);
`,
    );
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    expect([...findConstantNumericTables(mod).values()].map((t) => t.values)).toEqual([
      [3, -0, Infinity],
    ]);

    const llvm = emitLlvmModule(mod);

    expect(llvm).toContain("@sc_const_numbers_0 = private constant [3 x double]");
    expect(llvm).toContain("%initialized = icmp ne ptr %a, null");
    expect(llvm).toContain("%ix0 = fptosi double %i to i64");
    expect(llvm).toContain("%safe = and i1 %initialized, %ix5");
    expect(llvm).toContain("br i1 %safe, label %read, label %fallback");
    expect(llvm).toMatch(/call double @sc_const_numbers_0_get\(/);
    expect(llvm).toContain("call double @scr_arr_get_slot_number(ptr %a, double %i)");
    expect(llvm).toMatch(/call double @scr_arr_push_many\(ptr [^,]+, i64 3, ptr /);
    const wasm = emitLlvmModule(mod, { pointerBits: 32, wasi: true });
    expect(wasm).toContain("%ix0 = fptosi double %i to i64");
    expect(wasm).toContain("ptr @sc_const_numbers_0, i64 0, i64 %ix1");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test.each(["2970-constant-numeric-tables.ts", "2971-constant-table-modules/main.ts"])(
  "%s specializes only immutable nonescaping tables",
  async (fixture) => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-constant-tables-"));
    try {
      const outPath = join(dir, "main.ll");
      const entry = join(import.meta.dirname, "../../../tests/corpus", fixture);
      const result = await compile(entry, { outDir: dir, outPath, outputKind: "llvm" });
      if (!result.ok)
        throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
      const llvm = await readFile(outPath, "utf8");
      expect(llvm).toContain("@sc_const_numbers_0 = private constant");
      expect(llvm).toMatch(/call double @sc_const_numbers_0_get\(/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
