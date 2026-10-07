import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../src/index.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";

test("numeric array own keys avoid dynamic conversion and preserve writable receivers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-array-own-keys-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(
      entry,
      `
function present(values: number[], key: number): boolean { return Object.hasOwn(values, key); }
function replaced(values: number[]): boolean { return Object.hasOwn(values, (values = [], 0)); }
console.log(present([1], 0), replaced([1]));
`,
    );
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    expect(validateModule(mod)).toEqual([]);
    const llvm = emitLlvmModule(mod);
    const body = (name: string): string => {
      const match = llvm.match(
        new RegExp(
          `define internal [^\\n]+ @sc_(?:b)?f_${name}\\([^\\n]*\\) #0 \\{([\\s\\S]*?)\\n\\}`,
        ),
      );
      expect(match, `${name} LLVM function`).not.toBeNull();
      return match![1]!;
    };
    expect(body("present")).toContain("@scr_arr_has(");
    expect(body("present")).not.toContain("@scr_arr_retain_v(");
    expect(body("present")).not.toContain("@scr_dyn_");
    expect(body("replaced")).toContain("@scr_arr_has(");
    expect(body("replaced")).toContain("@scr_arr_retain_v(");

    // An unchecked read is statically number but may evaluate to undefined.
    // Keep its existing refusal instead of turning the key into NaN or zero.
    await writeFile(
      entry,
      `
function missing(values: number[], keys: number[], index: number): boolean {
  return Object.hasOwn(values, keys[index]);
}
console.log(missing([1], [], 0));
`,
    );
    const missing = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    expect(missing.ok).toBe(false);
    expect(missing.diagnostics.some((d) => d.code === "SC2020")).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
