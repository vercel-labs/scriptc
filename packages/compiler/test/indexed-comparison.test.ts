import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../src/index.js";
import { emitCModule } from "../src/backend/c/c-emitter.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";

test("primitive indexed comparisons do not allocate optional-union boxes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-indexed-comparison-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(entry, [
      "function strings(a: string[], b: string[], i: number): boolean { return a[i] === b[i]; }",
      "function numbers(a: number[], b: number[], i: number): boolean { return a[i] !== b[i]; }",
      "function bools(a: boolean[], b: boolean[], i: number): boolean { return a[i] === b[i]; }",
      "console.log(strings(['a'], ['a'], 0), numbers([1], [2], 0), bools([false], [false], 0));",
    ].join("\n"));
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok) throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    expect(validateModule(mod)).toEqual([]);
    const visited = new Set<string>();
    function visit(value: unknown): void {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) { value.forEach(visit); return; }
      const node = value as { kind?: string; callee?: string };
      expect(node.kind).not.toBe("unionWrap");
      expect(node.kind).not.toBe("unionEq");
      if (node.kind === "call" && node.callee) visitFunction(node.callee);
      Object.values(value).forEach(visit);
    }
    function visitFunction(name: string): void {
      if (visited.has(name)) return;
      visited.add(name);
      const fn = mod.functions.find((f) => f.name === name);
      expect(fn).toBeDefined();
      visit(fn!.body);
    }
    visitFunction(mod.entry);
    const reachable = { ...mod, functions: mod.functions.filter((f) => visited.has(f.name)) };
    const c = emitCModule(reachable), llvm = emitLlvmModule(reachable);
    expect(c).not.toContain("scr_union_new_");
    expect(llvm).not.toContain("@scr_union_new_");
    expect(c.match(/scr_arr_index_eq\(/g)).toHaveLength(3);
    expect(llvm.match(/call zeroext i1 @scr_arr_index_eq\(/g)).toHaveLength(3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
