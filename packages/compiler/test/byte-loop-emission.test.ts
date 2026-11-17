import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";

test("byte loops remove proved bounds while preserving receiver identity and wide indexes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-byte-loops-"));
  try {
    const entry = join(import.meta.dirname, "../../../tests/corpus/byte-loop-bounds.ts");
    const outPath = join(dir, "bounds.ir.json");
    const result = await compile(entry, { outPath, outDir: dir, outputKind: "ir" });
    if (!result.ok) throw new Error(result.diagnostics.map((d) => d.message).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    for (const pointerBits of [32, 64] as const) {
      const ll = emitLlvmModule(mod, { pointerBits, wasi: pointerBits === 32 });
      const body = (name: string): string =>
        ll.match(
          new RegExp(
            `define internal [^\\n]+ @sc_(?:b)?f_${name}(?:\\.i32)?\\([^\\n]*\\) align 64 #0 \\{([\\s\\S]*?)\\n\\}`,
          ),
        )![1]!;
      for (const name of ["neighbors", "backwards", "strided"]) {
        expect(body(name)).toContain("integer induction i");
        expect(body(name)).not.toContain("bytes.index.invalid");
        expect(body(name)).not.toContain("counted.slow");
      }
      // Similar-looking loops cannot borrow a proof from a different
      // receiver, a stale cached length, or rounded intermediate arithmetic.
      for (const name of ["changedReceiver", "replacedInBody", "shortOutput", "roundedOffset"]) {
        expect(body(name)).toContain("bytes.index.invalid");
      }
      const wide = body("wideIndex");
      expect(wide).toContain("icmp ult i64");
      if (pointerBits === 32) {
        expect(wide).toMatch(
          /icmp ult i64 (%\w+), %\w+[\s\S]*?bytes\.index\.valid[^:]*:\n\s+%\w+ = trunc i64 \1 to i32/,
        );
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
