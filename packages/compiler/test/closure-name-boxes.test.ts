import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../src/index.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";

test("a closure boxed where it is made takes its name at compile time", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-closure-names-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(
      entry,
      `
function named(): number {
  return 1;
}
const items: unknown = JSON.parse('[1, "a", 2]');
const all = Array.isArray(items) && items.every((item) => typeof item === "number");
const holder: Record<string, unknown> = {};
holder.f = named;
holder.g = () => 2;
console.log(all, holder);
`,
    );
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    expect(validateModule(mod)).toEqual([]);
    const llvm = emitLlvmModule(mod);
    // The callback, `named` and the arrow box with a constant name or null;
    // none of them searches the closure-name table.
    expect(llvm).not.toContain("@sc_closure_name(");
    expect(llvm).not.toMatch(/call ptr @sc_dfu_\d+\(/);
    const boxes = [...llvm.matchAll(/call ptr @sc_dfb_\d+\(ptr %\w+, ptr (null|@\w+)\)/g)];
    const names = boxes.map((m) => m[1]);
    expect(names.filter((name) => name === "null").length).toBeGreaterThanOrEqual(2);
    const constant = names.find((name) => name !== "null");
    expect(constant).toBeDefined();
    expect(llvm).toMatch(new RegExp(`${constant} = [^\\n]*c"named\\\\00"`));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
