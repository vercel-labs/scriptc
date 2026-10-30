import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../src/index.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";
import { type IrModule } from "../src/ir/ir.js";

async function lower(source: string): Promise<IrModule> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-bytes-header-"));
  try {
    const entry = join(dir, "main.ts"),
      output = join(dir, "main.ir.json");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath: output, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((item) => `${item.code}: ${item.message}`).join("\n"));
    const module = deserializeModule(await readFile(output, "utf8"));
    expect(validateModule(module)).toEqual([]);
    return module;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function body(llvm: string, symbol: string): string {
  const found = new RegExp(`^define internal [^\\n]*@${symbol}(?:\\.i32)?\\([^]*?^}`, "m").exec(
    llvm,
  );
  expect(found, symbol).not.toBeNull();
  return found![0];
}

const INVARIANT_HEADER = /load (?:i64|i32|ptr), ptr [^\n]*, !tbaa !\d+, !invariant\.load !\{\}$/m;

test("a typed array's length read as a value is an ordinary load; access bounds stay invariant", async () => {
  const module = await lower(`
class Table {
  slots: Int32Array = new Int32Array(4);
  swap(): number {
    const slots = this.slots;
    this.slots = new Int32Array(1);
    return slots.length + slots.byteLength;
  }
}
function sum(values: Float64Array, scale: number): number {
  let total = 0;
  for (let i = 0; i < values.length; i++) total += values[i]! * scale;
  return total;
}
const table = new Table();
console.log(table.swap(), sum(new Float64Array([1, 2]), 2));
`);
  const llvm = emitLlvmModule(module);
  // The length outlives the view: the release must not be crossed.
  const swap = body(llvm, "sc_bf__x25_Table_swap");
  expect(swap).toMatch(/load i64, ptr [^\n]*, !tbaa !\d+$/m);
  expect(swap).not.toContain("!invariant.load");
  expect(body(llvm, "sc_bf_sum")).toMatch(INVARIANT_HEADER);
});
