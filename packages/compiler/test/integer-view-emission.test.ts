import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";

test("integer loop recurrences reuse converted values on both pointer widths and preserve debug storage", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-integer-views-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    const source = `
function mix(input: number, bytes: Uint32Array): number {
  let state = input;
  for (let i = 0; i < bytes.length; i++) {
    state = i % 2 === 0 ? Math.imul(state, 17) : state ^ bytes[i];
    state = (state << 7) | (state >>> 25);
    bytes[i] = state;
  }
  return state;
}
function floating(input: number, flag: boolean): number {
  return (flag ? input | 0 : input + 0.5) >>> 0;
}
function observedAfter(input: number, count: number): number {
  let value = input;
  for (let i = 0; i < count; i++) value = Math.sqrt(value * value + 0.125);
  return value | 0;
}
console.log(mix(-0, new Uint32Array(3)), floating(1.75, false), observedAfter(1.75, 3));
`;
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    const body = (ll: string, name: string): string =>
      ll.match(
        new RegExp(
          `define internal [^\\n]+ @sc_(?:b)?f_${name}(?:\\.i32)?\\([^\\n]*\\) align 64 #0 \\{([\\s\\S]*?)\\n\\}`,
        ),
      )![1]!;
    for (const pointerBits of [32, 64] as const) {
      const ll = emitLlvmModule(mod, { pointerBits, wasi: pointerBits === 32 });
      const mix = body(ll, "mix");
      expect(mix).toContain("integer view state");
      // The original input is converted once, before entering the loop.
      expect(mix.match(/^uint32\.coerce\.slow\d+:/gm)).toHaveLength(1);
      const loopStart = mix.search(/\nloop\.b[._\d]/);
      expect(loopStart).toBeGreaterThan(0);
      const loop = mix.slice(loopStart);
      expect(loop).not.toContain("uint32.coerce.slow");
      expect(loop).not.toContain(" = fptoui double ");
      expect(loop).toContain(" = mul i32 ");
      expect(loop).toMatch(/store i32 %\w+, ptr %\w+, align 1/);
      expect(body(ll, "floating")).toContain("uint32.coerce.slow");
      expect(body(ll, "observedAfter")).not.toContain("integer view");
    }
    const debug = emitLlvmModule(mod, { debugSources: new Map([[entry, source]]) });
    expect(debug).not.toContain("integer view state");
    expect(debug).toContain("@llvm.dbg.declare");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
