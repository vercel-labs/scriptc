import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";

test("record windows keep checked partial paths and scope exact offsets to the guarded loop", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-byte-window-"));
  try {
    const entry = join(import.meta.dirname, "../../../tests/corpus/byte-record-windows.ts");
    const outPath = join(dir, "window.ir.json");
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    const body = (ll: string, name: string): string =>
      ll.match(
        new RegExp(
          `define internal [^\\n]+ @sc_(?:b)?f_${name}\\([^\\n]*\\) #0 \\{([\\s\\S]*?)\\n\\}`,
        ),
      )![1]!;
    for (const pointerBits of [32, 64] as const) {
      const ll = emitLlvmModule(mod, { pointerBits, wasi: pointerBits === 32 });
      for (const name of [
        "compactRecords",
        "changeRecords",
        "advanceFirst",
        "bytePairs",
        "earlyReturn",
      ]) {
        const code = body(ll, name);
        expect(code).toContain("bytes.window.slow");
        expect(code).toContain(`urem i${pointerBits}`);
        const fast = code
          .split(/bytes\.window\.fast\d+:\n/)[1]!
          .split(/bytes\.window\.done\d+:/)[0]!;
        expect(fast).not.toContain("bytes.number.index");
        expect(fast).not.toContain("bytes.index.invalid");
        expect(fast).not.toMatch(/@scr_(?:bytes_(?:read|write)_num|dataview_(?:get|set))\(/);
      }
      for (const name of ["compactRecords", "advanceFirst"]) {
        const code = body(ll, name);
        expect(code).toContain(`udiv i${pointerBits}`);
        expect(code).toMatch(/bitcast double %\w+ to i64/);
        expect(code).toMatch(/icmp eq i64 %\w+, 0/);
        expect(code).toContain("@scr_bytes_write_num");
      }
      const invalid = body(ll, "invalidValue").split(/bytes\.window\.fast\d+:\n/)[1]!;
      expect(invalid).toContain("@scr_bytes_write_num");
      expect(invalid).toContain("fcmp uge double");
      expect(body(ll, "replaced")).not.toContain("bytes.window.fast");
      // The checked version and code after the join retain ordinary number
      // storage; private cursor facts cannot escape into subsequent uses.
      expect(body(ll, "compactRecords")).toMatch(/bytes\.window\.done\d+:[\s\S]*load double/);
    }
    const debug = emitLlvmModule(mod, {
      debugSources: new Map([[entry, await readFile(entry, "utf8")]]),
    });
    expect(debug).not.toContain("bytes.window.fast");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
