import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";
import { findConstantNumericTables } from "../src/ir/constant-tables.js";

test("LLVM uses guarded native constants and retain array initialization", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-constant-tables-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(
      entry,
      `
const table = [3, -0, Infinity];
function lookup(i: number): number { return table[i] * 1; }
const mutated = [4, 5];
mutated[0] = 6;
console.log(lookup(1), mutated[0] * 1);
`,
    );
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    expect([...findConstantNumericTables(mod).values()].map((t) => t.values)).toEqual([
      [3, -0, Infinity],
    ]);

    const llvm = emitLlvmModule(mod);

    expect(llvm).toContain("@sc_const_numbers_0 = private constant [3 x double]");
    expect(llvm).toContain("%initialized = icmp ne ptr %a, null");
    expect(llvm).toContain("%ix0 = fptosi double %i to i64");
    expect(llvm).toContain("%safe = and i1 %initialized, %ix5");
    expect(llvm).toContain("br i1 %safe, label %read, label %fallback");
    expect(llvm).toMatch(/call double @sc_const_numbers_0_get\(/);
    expect(llvm).toContain("call double @scr_arr_get_number(ptr %a, double %i)");
    expect(llvm).toMatch(/call double @scr_arr_push_many\(ptr [^,]+, i64 3, ptr /);
    const wasm = emitLlvmModule(mod, { pointerBits: 32, wasi: true });
    expect(wasm).toContain("%ix0 = fptosi double %i to i64");
    expect(wasm).toContain("ptr @sc_const_numbers_0, i64 0, i64 %ix1");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test.each(["2970-constant-numeric-tables.ts", "2971-constant-table-modules/main.ts"])(
  "%s specializes only immutable nonescaping tables",
  async (fixture) => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-constant-tables-"));
    try {
      const outPath = join(dir, "main.ll");
      const entry = join(import.meta.dirname, "../../../tests/corpus", fixture);
      const result = await compile(entry, { outDir: dir, outPath, outputKind: "llvm" });
      if (!result.ok)
        throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
      const llvm = await readFile(outPath, "utf8");
      expect(llvm).toContain("@sc_const_numbers_0 = private constant");
      expect(llvm).toMatch(/call double @sc_const_numbers_0_get\(/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("a large immutable table is the array's own storage in the program image", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-static-tables-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ll");
    const table = Array.from({ length: 20 }, (_, i) => i * 3).join(", ");
    await writeFile(
      entry,
      `
const table = [${table}];
function lookup(i: number): number { return table[i] * 1; }
const doubles = [${Array.from({ length: 18 }, (_, i) => i + 0.5).join(", ")}];
function half(i: number): number { return doubles[i] * 2; }
console.log(lookup(3), half(1));
`,
    );
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "llvm" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const llvm = await readFile(outPath, "utf8");
    // The elements and the header both stay in the image: no allocation, no
    // per-element construction, no copy, and initialization stores nothing.
    expect(llvm).toMatch(/@sc_arr_const_\d+ = internal constant \[20 x i32\] \[ i32 0, i32 3, /);
    expect(llvm).toMatch(/@sc_arr_const_\d+ = internal constant \[18 x double\]/);
    expect(llvm).toMatch(
      /@sc_arr_const_\d+_h = internal global %ScrArr \{ i64 -1, i32 20, i32 20, i8 7, i8 0, i16 0, i32 20, ptr @sc_arr_const_\d+ \}/,
    );
    expect(llvm).toMatch(
      /@sc_arr_const_\d+_h = internal global %ScrArr \{ i64 -1, i32 18, i32 18, i8 0, i8 0, i16 0, i32 18, ptr @sc_arr_const_\d+ \}/,
    );
    expect(llvm).not.toMatch(/%ScrArr zeroinitializer/);
    expect(llvm).not.toMatch(/call double @scr_arr_push_f64\(/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("static table elements keep their exact bits in chunked emission", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-static-tables-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    // The values JSON cannot carry as numbers: NaN and the infinities
    // become null, and negative zero becomes zero.
    const edges = ["NaN", "Infinity", "-Infinity", "-0", "5e-324", "1e21", "0.1", "-2.5"];
    const rest = Array.from({ length: 12 }, (_, i) => String(i + 0.5));
    await writeFile(
      entry,
      `
const table = [${[...edges, ...rest].join(", ")}];
function at(i: number): number { return table[i] * 1; }
console.log(at(0), at(1), at(4));
`,
    );
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const ir = await readFile(outPath, "utf8");
    const serial = emitLlvmModule(deserializeModule(ir));
    expect(serial).toContain(
      "[20 x double] [ double 0x7FF8000000000000, double 0x7FF0000000000000, " +
        "double 0xFFF0000000000000, double 0x8000000000000000, double 0x0000000000000001, ",
    );
    // A chunk's result crosses JSON (emit-module.ts); the emitted table is
    // the serial text.
    const chunked = emitLlvmModule(deserializeModule(ir), { functionChunks: 2 });
    expect(chunked === serial).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("each static table is its own array, even with equal elements", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-static-tables-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ll");
    const table = Array.from({ length: 18 }, (_, i) => i + 1).join(", ");
    await writeFile(
      entry,
      `
const first = [${table}];
const second = [${table}];
function at(i: number): number { return first[i] * second[i]; }
console.log(at(3));
`,
    );
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "llvm" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const llvm = await readFile(outPath, "utf8");
    const headers = [
      ...llvm.matchAll(
        /@(sc_arr_const_\d+)_h = internal global %ScrArr \{ [^}]*ptr @(sc_arr_const_\d+) \}/g,
      ),
    ];
    expect(headers).toHaveLength(2);
    expect(new Set(headers.map((m) => m[1])).size).toBe(2);
    expect(new Set(headers.map((m) => m[2])).size).toBe(2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
