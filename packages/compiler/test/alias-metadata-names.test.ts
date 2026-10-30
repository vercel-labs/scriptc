import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";

async function emit(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-alias-names-"));
  try {
    const entry = join(dir, "main.ts"),
      output = join(dir, "main.ir.json");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath: output, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((item) => `${item.code}: ${item.message}`).join("\n"));
    return emitLlvmModule(deserializeModule(await readFile(output, "utf8")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The alias type names that a function's tagged loads and stores use, in order. */
function aliasNames(llvm: string, symbol: string): string[] {
  const found = new RegExp(`^define [^\\n]*@${symbol}\\([^]*?^}`, "m").exec(llvm);
  expect(found, symbol).not.toBeNull();
  const node = (id: string) => new RegExp(`^!${id} = !\\{(.*)\\}$`, "m").exec(llvm)?.[1] ?? "";
  return [...found![0].matchAll(/!tbaa !(\d+)/g)].map((tag) => {
    const type = /^!(\d+),/.exec(node(tag[1]!))?.[1] ?? "";
    return /^!"([^"]*)"/.exec(node(type))?.[1] ?? "";
  });
}

const points = `
class Point {
  x: number;
  y: number;
  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }
}
function sum(points: Point[]): number {
  let total = 0;
  for (const p of points) total += p.x * p.y;
  return total;
}
`;

test("alias type nodes are named by category, so a field added earlier leaves the others' names", async () => {
  const before = await emit(
    `${points}const all = [new Point(1, 2), new Point(3, 4)];\nconsole.log(sum(all));\n`,
  );
  // A class whose field the module uses before Point's.
  const after = await emit(`
class Weight {
  grams: number;
  constructor(grams: number) {
    this.grams = grams;
  }
}
function heaviest(weights: Weight[]): number {
  let most = 0;
  for (const w of weights) most = Math.max(most, w.grams);
  return most;
}
console.log(heaviest([new Weight(5), new Weight(7)]));
${points}const all = [new Point(1, 2), new Point(3, 4)];
console.log(sum(all));
`);
  const names = aliasNames(before, "sc_b?f_sum");
  expect(names.length).toBeGreaterThan(0);
  expect(names.every((name) => name !== "" && !/^field\.\d+$/.test(name))).toBe(true);
  expect(aliasNames(after, "sc_b?f_sum")).toEqual(names);
});
