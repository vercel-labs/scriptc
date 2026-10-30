import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../../index.js";
import { validateModule } from "../../ir/validate.js";
import { emitLlvmModule } from "./emitter.js";

async function llvmFor(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-shape-union-tags-"));
  try {
    const entry = join(dir, "main.ts"),
      output = join(dir, "main.ir.json");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath: output, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((item) => `${item.code}: ${item.message}`).join("\n"));
    const module = deserializeModule(await readFile(output, "utf8"));
    expect(validateModule(module)).toEqual([]);
    return emitLlvmModule(module);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function tagHelpers(ir: string): string[] {
  return [...ir.matchAll(/^define internal i32 @sc_stag\.[^\n]*\{[^]*?^}/gm)].map(
    (match) => match[0],
  );
}

test("a union whose arms span few shape numbers switches on the shape word", async () => {
  const ir = await llvmFor(`
type Num = { kind: "num"; value: number };
type Neg = { kind: "neg"; operand: Node };
type Add = { kind: "add"; left: Node; right: Node };
type Node = Num | Neg | Add;
function evaluate(node: Node): number {
  switch (node.kind) {
    case "num": return node.value;
    case "neg": return -evaluate(node.operand);
    case "add": return evaluate(node.left) + evaluate(node.right);
  }
}
const one: Node = { kind: "num", value: 1 };
console.log(evaluate({ kind: "add", left: one, right: { kind: "neg", operand: one } }));
`);
  expect(ir).not.toMatch(/@sc_stagtab\./);
  const helpers = tagHelpers(ir);
  expect(helpers.length).toBeGreaterThan(0);
  for (const helper of helpers) expect(helper).toMatch(/switch i32 %w/);
});

test("a union whose arms span many shape numbers reads the arm from its table", async () => {
  const arms = Array.from({ length: 40 }, (_, i) => i);
  const ir = await llvmFor(`
${arms.map((i) => `type K${i} = { kind: "k${i}"; v${i}: number };`).join("\n")}
type Any = ${arms.map((i) => `K${i}`).join(" | ")};
function value(item: Any): number {
  switch (item.kind) {
${arms.map((i) => `    case "k${i}": return item.v${i};`).join("\n")}
  }
}
const items: Any[] = [${arms.map((i) => `{ kind: "k${i}", v${i}: ${i} }`).join(", ")}];
let total = 0;
for (const item of items) total += value(item);
console.log(total);
`);
  // One byte per shape number from the arms' lowest to highest; 255 names no arm.
  const table =
    /^(@sc_stagtab\.\S+) = private unnamed_addr constant \[(\d+) x i8\] \[([^\]]*)\]$/m.exec(ir);
  expect(table, "arm table").not.toBeNull();
  const entries = table![3]!.split(", ").map((entry) => Number(entry.replace("i8 ", "")));
  expect(entries).toHaveLength(Number(table![2]));
  expect(entries.filter((entry) => entry !== 255).sort((a, b) => a - b)).toEqual(arms);
  const helper = tagHelpers(ir).find((text) => text.includes(table![1]!));
  expect(helper, "tag helper").toBeDefined();
  expect(helper).toContain(`getelementptr inbounds [${table![2]} x i8], ptr ${table![1]}`);
  expect(helper).not.toMatch(/switch i32 %w/);
});
