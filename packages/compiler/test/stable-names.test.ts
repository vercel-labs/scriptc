import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, type IrModule } from "../src/index.js";

/** Lowers each source in turn as the same file, so names that include the
 * file's path compare equal. */
async function lower(...sources: string[]): Promise<IrModule[]> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-stable-names-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    const modules: IrModule[] = [];
    for (const source of sources) {
      await writeFile(entry, source);
      const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
      if (!result.ok)
        throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
      modules.push(deserializeModule(await readFile(outPath, "utf8")));
    }
    return modules;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function names(mod: IrModule): string[] {
  return [
    ...mod.records.map((record) => record.id),
    ...mod.unions.map((union) => union.id),
    ...mod.functions.map((fn) => fn.name),
    ...mod.classes.map((cls) => cls.name),
  ].sort();
}

const recursive = `
type Tree = { value: number; children: Tree[]; parent: Tree | null };
function total(tree: Tree): number {
  let sum = tree.value;
  for (const child of tree.children) sum += total(child);
  return sum;
}
const root: Tree = { value: 1, children: [], parent: null };
root.children.push({ value: 2, children: [], parent: root });
console.log(total(root));
`;

test("recursive record and union ids do not depend on the code above the type", async () => {
  const [before, after] = await lower(
    recursive,
    `// A comment above the type.\n\ntype Unrelated = { name: string };\n\n${recursive}`,
  );
  expect(before.records.some((record) => record.fields.some((f) => f.name === "children"))).toBe(
    true,
  );
  expect(names(after)).toEqual(names(before));
});

test("recursive instantiations that print alike get distinct placeholders", async () => {
  const [mod] = await lower(`
namespace A {
  export class Item {
    a = 1;
  }
}
namespace B {
  export class Item {
    b = "b";
  }
}
type Chain<T> = { item: T; next: Chain<T> | null };
const first: Chain<A.Item> = { item: new A.Item(), next: null };
const second: Chain<B.Item> = { item: new B.Item(), next: null };
first.next = { item: new A.Item(), next: null };
second.next = { item: new B.Item(), next: null };
console.log(first.next.item.a, second.next.item.b);
`);
  const chains = mod.records.filter((record) => record.fields.some((f) => f.name === "next"));
  expect(new Set(chains.map((record) => record.id)).size).toBe(chains.length);
  expect(chains.length).toBeGreaterThanOrEqual(2);
});

test("a getter and a setter of one name keep their local classes apart", async () => {
  const [mod] = await lower(`
class Box {
  private v = 0;
  get value(): number {
    class Local {
      n(): number {
        return 1;
      }
    }
    return new Local().n() + this.v;
  }
  set value(x: number) {
    class Local {
      n(): number {
        return 2;
      }
    }
    this.v = x * new Local().n();
  }
}
const box = new Box();
box.value = 5;
console.log(box.value);
`);
  const locals = mod.classes.filter((cls) => cls.name.includes("Local"));
  expect(locals).toHaveLength(2);
  expect(locals[0]!.name).not.toBe(locals[1]!.name);
});

test("names do not depend on the directory the program sits in", async () => {
  // Each call lowers in its own temporary directory.
  const [first] = await lower(recursive);
  const [second] = await lower(recursive);
  expect(names(second!)).toEqual(names(first!));
});

/** Lowers a program of several files; `main.ts` is the entry. */
async function lowerFiles(files: Record<string, string>): Promise<IrModule> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-stable-names-"));
  try {
    for (const [name, source] of Object.entries(files)) await writeFile(join(dir, name), source);
    const outPath = join(dir, "main.ir.json");
    const result = await compile(join(dir, "main.ts"), { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    return deserializeModule(await readFile(outPath, "utf8"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a module's names do not depend on the modules loaded before it", async () => {
  const shapes = `
export class Box {
  constructor(private value: number) {}
  scaled(by: number): number { return this.value * by; }
}
export function boxes(count: number): number[] {
  return Array.from({ length: count }, (_, i) => new Box(i).scaled(2));
}
`;
  const before = await lowerFiles({
    "shapes.ts": shapes,
    "main.ts": `import { boxes } from "./shapes";\nconsole.log(boxes(3).join(","));\n`,
  });
  const after = await lowerFiles({
    "offsets.ts": `export function offset(x: number): number { return x + 1; }\n`,
    "shapes.ts": shapes,
    "main.ts": `import { offset } from "./offsets";\nimport { boxes } from "./shapes";\nconsole.log(offset(1), boxes(3).join(","));\n`,
  });
  // The class, its methods, the function and the closure it lifts.
  const ofShapes = (mod: IrModule) =>
    names(mod).filter((name) => /Box|boxes/.test(name) || name.startsWith("%fn."));
  expect(ofShapes(before).length).toBeGreaterThanOrEqual(4);
  expect(ofShapes(after)).toEqual(ofShapes(before));
});
