import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

const program = `const a = new Int32Array(4096);
for (let i = 0; i < a.length; i++) a[i] = (i * 2654435761) | 0;
let s = 0;
for (let r = 0; r < 64; r++) for (let i = 0; i < a.length; i++) s = (s + a[i]!) | 0;
console.log(s);
`;

test.runIf(process.platform === "linux" && process.arch === "x64")(
  "assembly, object and LLVM builds honor the target CPU",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-target-cpu-emit-"));
    const entry = join(dir, "main.ts");
    const emit = async (
      outputKind: "llvm" | "asm" | "obj",
      targetCpu?: "x86-64-v3",
    ): Promise<Buffer> => {
      const outPath = join(dir, `main-${outputKind}-${targetCpu ?? "baseline"}`);
      const result = await compile(entry, {
        outPath,
        outDir: dir,
        outputKind,
        ...(targetCpu === undefined ? {} : { targetCpu }),
      });
      if (!result.ok) throw new Error(result.diagnostics.map((d) => d.message).join("\n"));
      return readFile(outPath);
    };
    try {
      await writeFile(entry, program);
      expect((await emit("llvm")).toString()).not.toContain('"target-cpu"');
      expect((await emit("llvm", "x86-64-v3")).toString()).toContain('"target-cpu"="x86-64-v3"');
      // The v3 build vectorizes the sums with AVX2's 256-bit registers.
      expect((await emit("asm")).toString()).not.toContain("%ymm");
      expect((await emit("asm", "x86-64-v3")).toString()).toContain("%ymm");
      expect((await emit("obj", "x86-64-v3")).equals(await emit("obj"))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  240_000,
);
