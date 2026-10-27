import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../src/index.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";

test("tuple iteration retains one computed receiver without allocating an array snapshot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-tuple-forof-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(
      entry,
      `
let calls = 0;
function pair(): [number, number] { calls++; return [2, 3]; }
let total = 0;
for (const n of pair()) total += n;
console.log(total, calls);
`,
    );
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok) throw new Error(result.diagnostics.map((d) => d.message).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    expect(validateModule(mod)).toEqual([]);
    const llvm = emitLlvmModule(mod);
    // The receiver is computed once: an ordinary call, or (when the loop
    // only reads elements) the result-slot entry filling frame storage.
    const calls =
      (llvm.match(/call ptr @sc_f_pair\(/g) ?? []).length +
      (llvm.match(/call void @sc_\w*into_pair\(ptr %s\d+\)/g) ?? []).length;
    expect(calls).toBe(1);
    expect(llvm).not.toContain("@scr_arr_new");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
