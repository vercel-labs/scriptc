// `xs[i] += s` on a string[] in statement position is the canonical
// `xs[i] = xs[i] + s` store, whose left operand reads the element inside
// the concat. That operand is a string in every program: where string
// arrays can hold foreign elements (an untyped value stores elements and a
// string[] reaches untyped code), the read still answers a string, and a
// foreign element throws the checked conversion's TypeError as the typed
// read does. The differential case is
// tests/corpus/8815-string-element-append-dynamic-views.ts.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../src/index.js";

type Node = { kind?: string; [key: string]: unknown };
type IrModule = { functions: { name: string; body: unknown }[] };

async function compileToIr(source: string[]): Promise<IrModule> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-string-element-append-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(entry, source.join("\n"));
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const module = deserializeModule(await readFile(outPath, "utf8")) as unknown as IrModule;
    expect(validateModule(module as never)).toEqual([]);
    return module;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Every IR node of `kind` under `root`. */
function nodesOf(root: unknown, kind: string, found: Node[] = []): Node[] {
  if (Array.isArray(root)) for (const item of root) nodesOf(item, kind, found);
  else if (root !== null && typeof root === "object") {
    const node = root as Node;
    if (node.kind === kind) found.push(node);
    for (const value of Object.values(node)) nodesOf(value, kind, found);
  }
  return found;
}

/** The string appends stored into array elements by the function `name`. */
function elementAppends(module: IrModule, name: string): Node[] {
  const fn = module.functions.find((candidate) => candidate.name === name);
  expect(fn, name).toBeDefined();
  return nodesOf(fn!.body, "arraySet")
    .map((store) => store["value"] as Node)
    .filter((value) => value.kind === "strConcat");
}

const APPENDS = [
  "function append(rows: string[], more: string[]): void {",
  "  rows[rows.length - 1] += more[0];",
  "}",
  'const lines = ["a", "b"];',
  'append(lines, ["!"]);',
  "console.log(lines.join());",
];

/** An untyped element store, and a string[] that untyped code sees. */
const DYNAMIC_VIEWS = [
  "function poke(target: any, i: number, v: unknown): void {",
  "  target[i] = v;",
  "}",
  'poke(JSON.parse("[1]"), 0, "x");',
  "const seen: unknown = lines;",
  "console.log(Array.isArray(seen));",
];

test("a string element append reads its element as a string", async () => {
  const module = await compileToIr(APPENDS);
  const appends = elementAppends(module, "append");
  expect(appends).toHaveLength(1);
  const left = appends[0]!["left"] as Node;
  expect((left["type"] as Node).kind).toBe("string");
  expect(nodesOf(left, "arrayGet")).toHaveLength(1);
  expect(JSON.stringify(left)).not.toContain("array.foreignThrow");
});

test("the append's operand stays a string where string arrays can hold foreign elements", async () => {
  const module = await compileToIr([...APPENDS, ...DYNAMIC_VIEWS]);
  const appends = elementAppends(module, "append");
  expect(appends).toHaveLength(1);
  const left = appends[0]!["left"] as Node;
  // The same in-place store, with the foreign element's checked conversion
  // on the miss path.
  expect((left["type"] as Node).kind).toBe("string");
  expect(nodesOf(left, "arrayGet")).toHaveLength(1);
  expect(JSON.stringify(left)).toContain("array.foreignThrow");
  for (const fn of module.functions)
    for (const concat of nodesOf(fn.body, "strConcat"))
      for (const side of ["left", "right"] as const)
        expect(((concat[side] as Node)["type"] as Node).kind, `${fn.name} ${side}`).toBe("string");
});
