import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../src/index.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";

// The runtime fallbacks of the inline string reads can evict an index
// entry: that resets the published scan receiver (@scr_str_scan) and frees
// its unit array. A memory restriction on those calls would let LLVM keep
// the receiver's units in a register across them and read freed memory.
test("string read fallbacks let scan receiver reads reload after every call", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-string-scan-"));
  try {
    const entry = join(dir, "main.ts"),
      output = join(dir, "main.ir.json");
    await writeFile(
      entry,
      `
function scan(s: string, a: string, b: string): number {
  let sum = 0;
  for (let i = 0; i < s.length; i++) sum += s.charCodeAt(i) + a.length + b.length;
  return sum;
}
function at(s: string, i: number): number {
  return s.charCodeAt(i);
}
console.log(scan("é-é", "ü-ü", "ö-ö"), at("é", 0.5));
`,
    );
    const result = await compile(entry, { outDir: dir, outPath: output, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const module = deserializeModule(await readFile(output, "utf8"));
    expect(validateModule(module)).toEqual([]);
    const llvm = emitLlvmModule(module, { pointerBits: 64 });
    expect(llvm).toContain("@scr_str_scan = external global");
    const fallbacks = llvm
      .split("\n")
      .filter((line) =>
        /call (double|void) @scr_str_(utf16_len|char_code_at|scan_units)\(/.test(line),
      );
    expect(fallbacks.length).toBeGreaterThanOrEqual(3);
    for (const line of fallbacks) expect(line).not.toMatch(/\bmemory\(/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
