import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";

async function moduleOf(source: string): Promise<ReturnType<typeof deserializeModule>> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-literal-tables-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    return deserializeModule(await readFile(outPath, "utf8"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const count = (text: string, pattern: RegExp): number => text.match(pattern)?.length ?? 0;

test("a long run of number literals is appended from the image in one call", async () => {
  const values = Array.from({ length: 200 }, (_, i) => (i === 7 ? "-0" : String(i * 0.5)));
  const mod = await moduleOf(`
const table: number[] = [${values.join(", ")}];
let sum = 0;
for (const value of table) sum += value;
console.log(sum);
const short: number[] = [${values.slice(0, 64).join(", ")}];
short.push(1);
console.log(short.length);
`);
  const llvm = emitLlvmModule(mod);
  expect(llvm).toMatch(/@sc_data_\d+ = internal constant \[200 x double\] \[double 0x0+, /);
  expect(llvm).toContain("double 0x8000000000000000");
  expect(llvm).toMatch(/call double @scr_arr_push_many\(ptr %t\d+, i64 200, ptr @sc_data_\d+\)/);
  // A literal that fits one batch stores its values in the frame as before.
  expect(count(llvm, /@sc_data_\d+ = /g)).toBe(1);
  expect(llvm).toMatch(/call double @scr_arr_push_many\(ptr %t\d+, i64 64, ptr %t\d+\)/);
});

test("rows of a table are built in a loop over columns in the image", async () => {
  const rows = Array.from(
    { length: 150 },
    (_, i) =>
      `{ id: ${i}, name: "row-${i}", kind: "same", on: ${i % 2 === 0}, tags: ["t${i % 5}"] }`,
  );
  const mod = await moduleOf(`
interface Row { id: number; name: string; kind: string; on: boolean; tags: string[] }
const rows: Row[] = [${rows.join(",\n")}];
console.log(rows.length, rows[3]!.name, rows[4]!.tags[0]);
`);
  const serial = emitLlvmModule(mod);
  // One record constructor call site for 150 rows, not one per row.
  expect(count(serial, /= call ptr @sc_rnew_\w+\(\)/g)).toBe(1);
  expect(serial).toMatch(/@sc_data_\d+ = internal constant \[150 x double\]/);
  expect(serial).toMatch(/@sc_data_\d+ = internal constant \[150 x i32\] \[i32 0, i32 \d+, /);
  // The names share one block of literals, and so do the five tags.
  expect(count(serial, /@sc_data_\d+ = internal global \[\d+ x i8\] c"/g)).toBe(2);
  expect(serial).not.toMatch(/\[8 x i8\] c"row-149\\00"/);
  // Emission in ranges gives the same module, and the wasm target its own.
  expect(emitLlvmModule(mod, { functionChunks: 2 }) === serial).toBe(true);
  const wasm = emitLlvmModule(mod, { pointerBits: 32, wasi: true });
  expect(wasm).toMatch(/@sc_data_\d+ = internal constant \[150 x i32\]/);
  expect(count(wasm, /= call ptr @sc_rnew_\w+\(\)/g)).toBe(1);
});

test("Map seeds and index-signature entries are added in a loop", async () => {
  const pairs = Array.from({ length: 120 }, (_, i) => `["key-${i}", ${i * 2}]`);
  const fields = Array.from({ length: 120 }, (_, i) => `"code-${i}": ${i}`);
  const mod = await moduleOf(`
const pairs = new Map<string, number>([${pairs.join(", ")}]);
const codes: Record<string, number> = { ${fields.join(", ")} };
console.log(pairs.get("key-7"), codes["code-7"], pairs.size);
`);
  const llvm = emitLlvmModule(mod);
  // One insertion site for each table: the Map's and the record's.
  expect(count(llvm, /call void @scr_map_set_str_f64\(/g)).toBe(2);
  expect(count(llvm, /@sc_data_\d+ = internal constant \[120 x double\]/g)).toBe(2);
  expect(count(llvm, /@sc_data_\d+ = internal constant \[120 x i32\]/g)).toBe(2);
});
