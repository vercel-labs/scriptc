import { spawnSync } from "node:child_process";
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
          `define internal [^\\n]+ @sc_(?:b)?f_${name}(?:\\.i32)?\\([^\\n]*\\) #0 \\{([\\s\\S]*?)\\n\\}`,
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

    // An unchecked read can yield undefined. Its property key must remain
    // "undefined", distinct from both a numeric zero and NaN.
    await writeFile(
      entry,
      `
function missing(values: number[], keys: number[], index: number): boolean {
  return Object.hasOwn(values, keys[index]);
}
console.log(missing([1], [], 0));
const values = [1];
Object.defineProperty(values, "undefined", { value: 2 });
console.log(missing(values, [], 0));
`,
    );
    const missing = await compile(entry, {
      outDir: dir,
      outPath: join(dir, "program"),
      sanitize: process.env["SCRIPTC_SAN"] === "1",
    });
    if (!missing.ok) throw new Error(JSON.stringify(missing.diagnostics));
    const oracle = spawnSync(process.execPath, [entry], { encoding: "utf8", timeout: 30_000 });
    const native = spawnSync(missing.binaryPath, { encoding: "utf8", timeout: 30_000 });
    for (const run of [oracle, native]) {
      expect(run.error).toBeUndefined();
      expect(run.signal).toBeNull();
      expect(run.status, run.stderr).toBe(0);
      expect(run.stderr).toBe("");
      expect(run.stdout).toBe("false\ntrue\n");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
