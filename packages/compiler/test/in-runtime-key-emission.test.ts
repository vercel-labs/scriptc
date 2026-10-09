import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../src/index.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";

async function emit(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-in-runtime-key-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    expect(validateModule(mod)).toEqual([]);
    return emitLlvmModule(mod);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function body(llvm: string, name: RegExp): string {
  const match = llvm.match(
    new RegExp(`define internal [^\\n]+ @${name.source}\\([^\\n]*\\) #0 \\{([\\s\\S]*?)\\n\\}`),
  );
  expect(match, `${name.source} LLVM function`).not.toBeNull();
  return match![1]!;
}

test("a runtime numeric key over an array asks the array's presence query", async () => {
  const llvm = await emit(`
function count(values: number[], names: string[], n: number): number {
  let c = 0;
  for (let i = 0; i < n; i++) if (i in values && i in names) c++;
  return c;
}
console.log(count([1, 2], ["a"], 4));
`);
  const fn = body(llvm, /sc_b?f_count/);
  expect(fn).toContain("@scr_arr_has(");
  // The checked-dynamic fallback boxed the receiver and materialized it.
  expect(fn).not.toContain("@scr_dyn_new_typed_ref");
  expect(fn).not.toContain("dyn_class_computed");
});

test("a runtime string key over an index-signature record probes the overflow map", async () => {
  const llvm = await emit(`
function has(dict: Record<string, number>, key: string): boolean { return key in dict; }
const d: Record<string, number> = {};
d["a"] = 1;
console.log(has(d, "a"), has(d, "b"));
`);
  const helper = body(llvm, /sc_b?f__x25_rec_haskey_\d+/);
  expect(helper).toContain("@scr_map_has_str(");
  // Not a scan over a fresh key snapshot per probe.
  expect(helper).not.toContain("@scr_map_keys_js_order(");
});
