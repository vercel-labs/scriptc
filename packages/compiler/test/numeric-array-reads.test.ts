import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../src/index.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";

test("ordinary numeric-array arithmetic keeps raw fast paths and one owned property Get", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-numeric-array-reads-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(
      entry,
      [
        "function blend(a: number[], i: number, j: number): number {",
        "  return a[i] + (a[j] - a[i]) * 0.5;",
        "}",
        "console.log(blend([1, 3], 0, 1));",
        "",
      ].join("\n"),
    );
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    expect(validateModule(mod)).toEqual([]);
    const visited = new Set<string>();
    let arrayReads = 0;
    function visit(value: unknown): void {
      if (value === null || typeof value !== "object") return;
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      const node = value as { kind?: string; callee?: string; consume?: string };
      expect(node.kind).not.toBe("unionWrap");
      expect(node.kind).not.toBe("arrayState");
      expect(node.kind).not.toBe("arrayGet");
      if (node.kind === "arrayPropertyRead" && node.consume === "number") arrayReads++;
      if (node.kind === "call" && node.callee) visitFunction(node.callee);
      Object.values(value).forEach(visit);
    }
    function visitFunction(name: string): void {
      if (visited.has(name)) return;
      visited.add(name);
      const fn = mod.functions.find((f) => f.name === name);
      expect(fn, `missing function ${name}`).toBeDefined();
      visit(fn!.body);
    }
    visitFunction(mod.entry);
    expect(arrayReads).toBe(3);
    const reachable = { ...mod, functions: mod.functions.filter((fn) => visited.has(fn.name)) };

    const llvm = emitLlvmModule(reachable);

    expect(llvm.match(/call ptr @scr_arr_property_get\(/g)).toHaveLength(3);
    expect(llvm.match(/call double @scr_dyn_number_coerce\(/g)).toHaveLength(3);
    expect(llvm).toContain("@scr_arr_get_slot_f64");
    expect(llvm).not.toContain("@scr_arr_property_unbox");
    expect(llvm).not.toContain("slot_box");
    expect(llvm).not.toContain("slot_unbox");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
