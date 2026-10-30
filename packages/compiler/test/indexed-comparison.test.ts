import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../src/index.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";

test("primitive indexed comparisons preserve separate semantic element reads", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-indexed-comparison-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(
      entry,
      [
        "function strings(a: string[], b: string[], i: number): boolean { return a[i] === b[i]; }",
        "function numbers(a: number[], b: number[], i: number): boolean { return a[i] !== b[i]; }",
        "function bools(a: boolean[], b: boolean[], i: number): boolean { return a[i] === b[i]; }",
        "console.log(strings(['a'], ['a'], 0), numbers([1], [2], 0), bools([false], [false], 0));",
      ].join("\n"),
    );
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    expect(validateModule(mod)).toEqual([]);
    for (const name of ["strings", "numbers", "bools"]) {
      const fn = mod.functions.find((item) => item.name === name)!;
      const returned = fn.body[0]!;
      if (returned.kind !== "return" || returned.value?.kind !== "unionEq")
        throw new Error("missing optional-value comparison");
      const comparison = returned.value;
      expect(comparison.sameValue).toBe(false);
      expect(comparison.negated).toBe(name === "numbers");
      for (const [index, read] of [comparison.left, comparison.right].entries()) {
        if (read.kind !== "call") throw new Error("missing semantic element read");
        expect(read.args[0]).toMatchObject({ kind: "varRef", localId: fn.params[index]!.localId });
        expect(read.args[1]).toMatchObject({ kind: "varRef", localId: fn.params[2]!.localId });
        const helper = mod.functions.find((item) => item.name === read.callee)!;
        expect(helper.body[0]).toMatchObject({
          kind: "return",
          value: { kind: "arrayPropertyRead", consume: "value" },
        });
      }
    }
    const llvm = emitLlvmModule(mod);
    // The left Get may replace the right receiver. A raw two-array lookup
    // would evaluate both receivers before either observable property read.
    expect(llvm).not.toContain("@scr_arr_index_eq(");
    expect(llvm.match(/call ptr @scr_arr_property_get\(/g)).toHaveLength(3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
