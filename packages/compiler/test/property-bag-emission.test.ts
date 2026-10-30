import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

async function layouts(body: string, fallback = '"nonobject"', exposed = true): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-property-bag-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ll");
    await writeFile(
      entry,
      `
class Base {
  id: number;
  constructor(id: number) {
    this.id = id;
  }
  describe(): string {
    return "base " + this.id;
  }
}
class Derived extends Base {
  extra: string;
  constructor(id: number) {
    super(id);
    this.extra = "x";
  }
  describe(): string {
    return "derived " + this.extra;
  }
}
function debug(x: unknown): string {
  if (typeof x !== "object" || x === null) return ${fallback};
  ${body}
}
const values: Base[] = [new Base(1), new Derived(2)];
for (const value of values) console.log(${exposed ? "debug(value), " : ""}value.describe());
`,
    );
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "llvm" });
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    const llvm = await readFile(outPath, "utf8");
    return [...llvm.matchAll(/^%sc_o_(?:Base|Derived) = type [^\n]*/gm)].map((m) => m[0]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("instances read through unknown retain their own-property metadata", async () => {
  const types = await layouts(`
  let keys = "";
  for (const key in x) keys += key;
  return keys + Object.keys(x).join(",") + Object.prototype.toString.call(x);`);
  expect(types).toHaveLength(2);
  for (const type of types) expect(type).toContain("%dynProperties");
});

test("unexposed typed class hierarchies keep no property bag", async () => {
  const types = await layouts('return "";', '"nonobject"', false);
  expect(types).toHaveLength(2);
  for (const type of types) expect(type).not.toContain("%dynProperties");
});

test("a dynamic store keeps the property bag of the classes it can reach", async () => {
  const types = await layouts(`
  (x as Record<string, unknown>)[String(Object.keys(x)[0])] = 1;
  return Object.keys(x).join(",");`);
  expect(types).toHaveLength(2);
  for (const type of types) expect(type).toContain("%dynProperties");
});

test("String of unknown retains reachable property bags", async () => {
  const types = await layouts('return "";', "String(x)");
  expect(types).toHaveLength(2);
  for (const type of types) expect(type).toContain("%dynProperties");
});
