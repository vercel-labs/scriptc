import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";

test("numeric Math operands borrow stable receivers across calls and preserve replaced inputs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-math-borrow-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(
      entry,
      `
function safe(bytes: Uint8Array, value: number): number {
  bytes[Math.floor(0)] = Math.min(255, Math.max(0, Math.floor(value)));
  return bytes[Math.ceil(0)];
}
function unsafe(value: number): number { return Math.floor(value); }
function throughCall(bytes: Uint8Array, value: number): void { bytes[0] = Math.floor(unsafe(value)); }
function replaced(bytes: Uint8Array, other: Uint8Array): void {
  bytes[0] = Math.floor((bytes = other) ? 7.9 : 0);
}
function readArray(values: number[]): number { return values[Math.floor(0)] * 2; }
const buffer = new Uint8Array(1);
console.log(safe(buffer, 17.9), readArray([4]));
throughCall(buffer, 8.9);
replaced(buffer, new Uint8Array(1));
`,
    );
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));

    const ll = emitLlvmModule(mod);
    const llBody = (name: string, owned = false): string => {
      const match = ll.match(
        new RegExp(
          `define internal [^\\n]+ @sc_${owned ? "" : "(?:b)?"}f_${name}(?:\\.i32)?\\([^\\n]*\\) #0 \\{([\\s\\S]*?)\\n\\}`,
        ),
      );
      expect(match, `${name} LLVM function`).not.toBeNull();
      return match![1]!;
    };
    expect(llBody("safe")).not.toContain("@scr_bytes_retain_v(");
    // The caller owns the buffer through the borrowed body; indirect calls
    // enter the owned adapter and release their input after the body returns.
    expect(llBody("safe")).not.toContain("@scr_bytes_release(");
    expect(llBody("safe", true).match(/call void @scr_bytes_release\(/g)).toHaveLength(1);
    expect(llBody("safe")).toContain("@llvm.floor.f64(");
    expect(llBody("throughCall")).not.toContain("@scr_bytes_retain_v(");
    expect(llBody("replaced")).toContain("@scr_bytes_retain_v(");
    // Semantic Get/coercion can invoke user code even when the numeric index
    // itself is pure. Hold the array through both unwind sites and success.
    const array = llBody("readArray");
    const retains = [...array.matchAll(/(%t\d+) = call ptr @scr_arr_retain_v\(/g)];
    expect(retains).toHaveLength(1);
    const receiver = retains[0]![1]!;
    expect(array).toContain(`@scr_arr_property_get(ptr ${receiver},`);
    expect(array).toContain("@scr_dyn_number_coerce(");
    expect(
      array.match(new RegExp(`call void @scr_arr_release\\(ptr ${receiver}\\)`, "g")),
    ).toHaveLength(3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
