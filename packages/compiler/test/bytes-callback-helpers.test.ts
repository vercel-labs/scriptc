import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../src/index.js";
import type { IrFunction, IrModule, IrStmt } from "../src/ir/ir.js";

async function lower(source: string): Promise<IrModule> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-bytes-callbacks-"));
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

const helpers = (mod: IrModule, method: string): IrFunction[] =>
  mod.functions.filter((f) => f.name.startsWith(`%bytes.${method}.`));

const visitLoop = (fn: IrFunction): IrStmt & { kind: "for" } => {
  const loop = fn.body.find((s): s is IrStmt & { kind: "for" } => s.kind === "for");
  if (!loop) throw new Error(`no loop in ${fn.name}`);
  return loop;
};

test("literal callbacks get helpers of their own; function values share one", async () => {
  const mod = await lower(`
    const a = new Int32Array([1, 2, 3]);
    const double = (v: number): number => v * 2;
    console.log(a.map((v) => v + 1).join(","), a.map((v) => v - 1).join(","));
    console.log(a.map(double).join(","), new Int32Array([4]).map(double).join(","));
  `);
  expect(helpers(mod, "map")).toHaveLength(3);
});

test("typed-array callback loops run on their own counter", async () => {
  const mod = await lower(`
    const a = new Float64Array([1.5, 2.5, 3.5]);
    console.log(a.some((v) => v > 2), a.reduce((s, v) => s + v));
    console.log(a.reduceRight((s, v) => s - v), a.findLastIndex((v) => v < 3));
  `);
  for (const method of ["some", "reduce"]) {
    const loop = visitLoop(helpers(mod, method)[0]!);
    // for (let i = <0 or 1 past reduce's seed>; i < a.length; i = i + 1)
    expect(loop.init).toMatchObject({ kind: "varDecl", localId: "i.0", init: { kind: "numLit" } });
    expect(loop.cond).toMatchObject({
      kind: "bin",
      op: "<",
      right: { kind: "bytesIntrinsic", method: "length" },
    });
  }
  expect(visitLoop(helpers(mod, "reduce")[0]!).init).toMatchObject({ init: { value: 1 } });
  // Backward: from n - 2 past reduceRight's seed, and from n - 1.
  expect(visitLoop(helpers(mod, "reduceRight")[0]!).init).toMatchObject({
    init: { kind: "bin", op: "-", right: { value: 2 } },
  });
  expect(visitLoop(helpers(mod, "findLastIndex")[0]!).init).toMatchObject({
    init: { kind: "bin", op: "-", right: { value: 1 } },
  });
});
