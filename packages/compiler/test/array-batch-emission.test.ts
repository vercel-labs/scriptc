import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, serializeModule, validateModule } from "../src/index.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";

test("batched literals and insertions preserve values across buffer boundaries", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-array-batch-"));
  try {
    const entry = join(dir, "main.ts");
    const output = join(dir, "main.ir.json");
    // Cross two full buffers and a partial tail, for each native slot ABI.
    const values = Array.from({ length: 131 }, (_, i) => i);
    const lists = [
      values.map((i) => String(i)),
      values.map((i) => String(i % 3 === 0)),
      values.map((i) => `"item-${i}"`),
    ];
    const source = lists
      .map(
        (list, i) => `
const a${i} = [${list.join(",")}];
console.log(a${i}.unshift(${list.join(",")}));
console.log(a${i}.push(${list.join(",")}));
console.log(a${i}.join(":"));
`,
      )
      .join("\n");
    writeFileSync(entry, source);
    const lowered = await compile(entry, { outputKind: "ir", outDir: dir, outPath: output });
    if (!lowered.ok) throw new Error(JSON.stringify(lowered.diagnostics));
    const module = deserializeModule(readFileSync(output, "utf8"));
    expect(validateModule(module)).toEqual([]);
    for (const pointerBits of [32, 64] as const) {
      const llvm = emitLlvmModule(deserializeModule(serializeModule(module)), { pointerBits });
      expect(llvm).toContain("alloca [64 x i64]");
      expect(llvm).not.toMatch(/alloca \[(?:131|128) x i64\]/);
      const stackSlots = [...llvm.matchAll(/alloca \[(\d+) x i64\]/g)].reduce(
        (total, match) => total + Number(match[1]),
        0,
      );
      expect(stackSlots).toBeLessThanOrEqual(lists.length * 3 * 64);
      // Public insertions see all arguments at once; only construction batches.
      expect(llvm.match(/call double @scr_arr_unshift_spread\(ptr /g)).toHaveLength(lists.length);
      expect(llvm.match(/call double @scr_arr_push_spread\(ptr /g)).toHaveLength(lists.length);
      expect(llvm).toContain(`declare double @scr_arr_push_many(ptr, i${pointerBits}, ptr)`);
      expect(llvm).toMatch(/zext i1 .* to i64/);
      expect(llvm).toMatch(/ptrtoint ptr .* to i64/);
    }
    const result = await compile(entry, {
      outDir: dir,
      outPath: join(dir, "program"),
      sanitize: process.env["SCRIPTC_SAN"] === "1",
    });
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    const expected = execFileSync(process.execPath, [entry], { encoding: "utf8" });
    const actual = spawnSync(result.binaryPath, [], { encoding: "utf8", timeout: 30_000 });
    expect(actual.error).toBeUndefined();
    expect({
      status: actual.status,
      signal: actual.signal,
      stdout: actual.stdout,
      stderr: actual.stderr,
    }).toEqual({ status: 0, signal: null, stdout: expected, stderr: "" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
