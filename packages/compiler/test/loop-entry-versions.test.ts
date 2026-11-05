import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";

test("while loops test their entry values and run integer remainders in the fast copy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-entry-versions-"));
  try {
    const entry = join(import.meta.dirname, "../../../tests/corpus/while-entry-range-versions.ts");
    const outPath = join(dir, "versions.ir.json");
    const result = await compile(entry, { outPath, outDir: dir, outputKind: "ir" });
    if (!result.ok) throw new Error(result.diagnostics.map((d) => d.message).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    const ll = emitLlvmModule(mod, { pointerBits: 64 });
    const body = (name: string): string =>
      ll.match(
        new RegExp(`define internal [^\\n]+ @sc_bf_${name}\\([^\\n]*\\{([\\s\\S]*?)\\n\\}`),
      )![1]!;
    for (const name of ["wrap", "ring", "_x25_Cursor_stripes"]) {
      const fn = body(name);
      const fast = fn.slice(fn.indexOf("\nentry.fast"), fn.indexOf("\nentry.slow"));
      const slow = fn.slice(fn.indexOf("\nentry.slow"));
      // The fast copy adds the dividend's integers; the ordinary copy adds
      // doubles and tests the sum before its integer remainder.
      const adds = (text: string): number => text.split("fadd double").length - 1;
      expect(fast, name).toContain("srem i64");
      expect(adds(fast), name).toBeLessThan(adds(slow));
    }
    // `complement` has no other caller: the fast copy's call keeps it inlined.
    const wrap = body("wrap");
    const fast = wrap.slice(wrap.indexOf("\nentry.fast"), wrap.indexOf("\nentry.slow"));
    expect(fast).toMatch(/call i32 @sc_f_complement\.i32\([^)]*\) alwaysinline/);
    expect(wrap.slice(wrap.indexOf("\nentry.slow"))).not.toContain("alwaysinline");
    // Debug builds keep one copy.
    const debug = emitLlvmModule(mod, {
      pointerBits: 64,
      debugSources: new Map([[entry, await readFile(entry, "utf8")]]),
    });
    expect(debug).not.toContain("entry.fast");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("for loops test the positions they advance and step them as integers in the fast copy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-entry-cursors-"));
  try {
    const entry = join(import.meta.dirname, "../../../tests/corpus/for-entry-range-cursors.ts");
    const outPath = join(dir, "cursors.ir.json");
    const result = await compile(entry, { outPath, outDir: dir, outputKind: "ir" });
    if (!result.ok) throw new Error(result.diagnostics.map((d) => d.message).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    const ll = emitLlvmModule(mod, { pointerBits: 64 });
    const body = (name: string): string =>
      ll.match(
        new RegExp(`define internal [^\\n]+ @sc_bf_${name}\\([^\\n]*\\{([\\s\\S]*?)\\n\\}`),
      )![1]!;
    for (const name of ["lines", "reverse", "find"]) {
      const fn = body(name);
      const fast = fn.slice(fn.indexOf("\nentry.fast"), fn.indexOf("\nentry.slow"));
      const slow = fn.slice(fn.indexOf("\nentry.slow"));
      // The fast copy steps i64 shadows of the positions; the ordinary copy
      // steps their doubles.
      expect(fast, name).toMatch(/= (add|sub) nsw i64 %t\d+, 1\n/);
      expect(fn, name).toMatch(/alloca i64 ; integer [io]\n/);
      expect(slow, name).toMatch(/= f(add|sub) double %t\d+, 0x3FF0000000000000\n/);
    }
    // The initializer writes a position, so the loop has one copy.
    expect(body("restart")).not.toContain("entry.fast");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
