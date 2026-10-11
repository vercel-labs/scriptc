import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../src/index.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";
import type { IrModule } from "../src/ir/ir.js";

async function lower(source: string): Promise<IrModule> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-trunc-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    expect(validateModule(mod)).toEqual([]);
    return mod;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("Math.trunc is inline on x86-64 and the intrinsic elsewhere", async () => {
  const mod = await lower(
    "const x: number = process.argv.length + 0.5;\nconsole.log(Math.trunc(x), Math.trunc(-x));\n",
  );
  const x86 = emitLlvmModule(mod, { targetTriple: "x86_64-unknown-linux-gnu", pointerBits: 64 });
  expect(x86).not.toContain("@llvm.trunc.f64(double");
  expect(x86).toContain("@llvm.copysign.f64");
  const arm = emitLlvmModule(mod, { targetTriple: "arm64-apple-darwin", pointerBits: 64 });
  expect(arm).toContain("call double @llvm.trunc.f64(double");
});

test("integer typed-array reads decide presence without a truncation", async () => {
  const mod = await lower(
    "const t = new Uint16Array(4);\nconst i: number = process.argv.length + 0.5;\nconsole.log(t[i], t[1]);\n",
  );
  const helper = mod.functions.find((f) => f.name.startsWith("%bytes.idxOr"));
  expect(helper).toBeDefined();
  expect(JSON.stringify(helper!.body)).not.toContain("math.trunc");
  expect(JSON.stringify(helper!.body)).toContain("num.isNaN");
});
