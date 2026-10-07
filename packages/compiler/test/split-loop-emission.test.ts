import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, serializeModule, validateModule } from "../src/index.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";

test("private split loops keep dense bindings and target-sized snapshot cursors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-split-loops-"));
  try {
    const entry = join(dir, "main.ts"),
      output = join(dir, "main.ir.json");
    await writeFile(
      entry,
      `
function direct(input: string, limit: number): string {
  let result = "";
  for (const piece of input.split(",", limit)) result += piece;
  return result;
}
function stored(input: string, limit: number): string {
  const pieces = input.split(",", limit);
  input += ",changed";
  let result = "";
  for (let pass = 0; pass < 2; pass++) {
    for (const piece of pieces) result += piece;
  }
  return result;
}
function observed(input: string): string {
  const pieces = input.split(",");
  pieces.push("extra");
  let result = "";
  for (const piece of pieces) result += piece;
  return result;
}
function captured(input: string): string {
  const pieces = input.split(",");
  const use = (): number => pieces.length;
  let result = "";
  for (const piece of pieces) result += piece;
  return result + String(use());
}
async function suspended(input: string): Promise<string> {
  let result = "";
  for (const piece of input.split(",")) { await Promise.resolve(); result += piece; }
  return result;
}
function lookup(input: string, values: Map<string, number>): number {
  let result = 0;
  for (const key of input.split(",")) result += values.get(key) ?? 0;
  return result;
}
function materialized(input: string, values: Map<string, string>): string {
  let result = "";
  for (const key of input.split(",")) {
    const value = values.get(key);
    if (value === undefined) values.set(key, key + "!");
    result += key;
  }
  return result;
}
function capturedKey(input: string, values: Map<string, number>): string {
  let result = "";
  for (const key of input.split(",")) {
    const read = (): string => key;
    result += String(values.get(key)) + read();
  }
  return result;
}
console.log(lookup("a,b", new Map<string, number>()), materialized("a,b", new Map<string, string>()), capturedKey("a,b", new Map<string, number>()));
console.log(direct("a,b", 2), stored("a,b", 2), observed("a,b"), captured("a,b"));
suspended("a,b").then(console.log);
`,
    );
    const result = await compile(entry, {
      outDir: dir,
      outPath: output,
      outputKind: "ir",
      dynamic: false,
    });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const module = deserializeModule(await readFile(output, "utf8"));
    expect(validateModule(module)).toEqual([]);
    const body = (llvm: string, name: string): string => {
      const definition = new RegExp(
        `^define internal [^\\n]*@sc_(?:bf|f)_${name}\\([^]*?^}`,
        "m",
      ).exec(llvm);
      expect(definition, name).not.toBeNull();
      return definition![0];
    };
    for (const pointerBits of [32, 64] as const) {
      const llvm = emitLlvmModule(deserializeModule(serializeModule(module)), { pointerBits });
      for (const name of ["direct", "stored"]) {
        const work = body(llvm, name);
        expect(work).toContain(`alloca { i${pointerBits}, i32, i32 }`);
        expect(work).toContain("@scr_str_split_cursor_next");
        expect(work).not.toContain("@scr_str_split_limit");
        expect(work).not.toContain("@scr_arr_get_ref");
        expect(work).not.toContain("@scr_union_wrap");
      }
      const lookup = body(llvm, "lookup");
      expect(lookup).toContain("@scr_str_split_cursor_span");
      expect(lookup).toContain("@scr_map_get_span_f64");
      expect(lookup).not.toContain("@scr_str_split_materialize");
      expect(lookup).not.toContain("@scr_str_split_cursor_next");
      const materialized = body(llvm, "materialized");
      expect(materialized).toContain("@scr_map_get_span_ref");
      expect(materialized).toContain(`@scr_str_split_materialize(ptr`);
      expect(materialized).toContain("split.ready");
      expect(body(llvm, "capturedKey")).not.toContain("@scr_str_split_cursor_span");
      const stored = body(llvm, "stored");
      expect(stored.indexOf("@scr_to_uint32")).toBeLessThan(stored.indexOf("@scr_str_concat"));
      expect(stored.indexOf("@scr_str_concat")).toBeLessThan(
        stored.indexOf("@scr_str_split_cursor_init"),
      );
      for (const name of ["observed", "captured", "suspended"]) {
        const work = body(llvm, name);
        expect(work).toContain("@scr_str_split_limit");
        expect(work).not.toContain("@scr_str_split_cursor_next");
      }
      const debug = emitLlvmModule(deserializeModule(serializeModule(module)), {
        pointerBits,
        debugSources: new Map([[entry, await readFile(entry, "utf8")]]),
      });
      for (const name of ["direct", "stored", "lookup", "materialized"]) {
        expect(body(debug, name)).toContain("@scr_str_split_limit");
        expect(body(debug, name)).not.toContain("@scr_str_split_cursor_next");
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
