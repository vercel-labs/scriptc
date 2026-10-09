import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";

test("JSON.parse casts to plain records and arrays fuse into the schema parser", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-json-schema-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(
      entry,
      `
interface Item { sku: string; qty: number; ok: boolean }
interface Order { id: number; items: Item[]; tags: string[] }
interface Loose { name: string; note?: string }
const text = process.argv[2] ?? "[]";
const orders = JSON.parse(text) as Order[];
const typed: Item = JSON.parse(text);
const loose = JSON.parse(text) as Loose;
const pair = JSON.parse(text) as [string, number];
console.log(orders.length, typed.sku, loose.name, pair[0]);
`,
    );
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));

    const llvm = emitLlvmModule(mod);
    // Order[] and Item (an annotated binding) take the fused path; the
    // record schema lists fields in declaration order with struct offsets.
    expect(llvm.match(/^define internal ptr @sc_jp_\d+\(ptr %text\)/gm)).toHaveLength(2);
    expect(llvm).toContain("call ptr @scr_json_parse_schema(ptr %text, ptr @sc_jsch_");
    expect(llvm).toMatch(
      /@sc_jsch_\d+_fields = internal constant \[3 x \{ ptr, i64, i64, ptr \}\] \[\{ ptr, i64, i64, ptr \} \{ ptr @sc_cs_\d+, i64 3, i64 ptrtoint/,
    );
    // Declining reruns the exact checked-dynamic route.
    expect(llvm).toMatch(
      /%d = call ptr @scr_json_parse\(ptr %text\)\n {2}%bad = icmp eq ptr %d, null/,
    );
    expect(llvm).toMatch(/%v = call ptr @sc_dc_\d+\(ptr %d, ptr null\)/);
    // Optional fields (unions) and tuples keep the checked-dynamic route.
    expect(llvm.match(/call ptr @scr_json_parse\(ptr /g)!.length).toBeGreaterThanOrEqual(4);

    const wasm = emitLlvmModule(mod, { pointerBits: 32, wasi: true });
    expect(wasm).toContain("= internal constant { i32, i32, ptr, ptr, ptr, ptr, ptr }");
    expect(wasm).toMatch(/\{ ptr, i32, i32, ptr \} \{ ptr @sc_cs_\d+, i32 3, i32 ptrtoint/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
