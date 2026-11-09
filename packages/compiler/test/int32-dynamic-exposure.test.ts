import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";
import { analyzeFinalFields } from "../src/ir/final-fields.js";
import { analyzeInt32Slots, dynamicFieldStores } from "../src/ir/int32-slots.js";
import type { IrModule } from "../src/ir/ir.js";

// Instances of these classes reach checked-dynamic code (an unknown[] array,
// instanceof, inspection, JSON and string conversion), but the program never
// stores a property through a dynamic value. The helpers the compiler emits
// for those reads (prototype objects, inspection names) store nothing, so the
// classes keep their int32 fields.
const source = `
import { inspect } from "node:util";

class Node {
  kind: number;
  flags = 0;
  constructor(kind: number) {
    this.kind = kind;
  }
}
class Identifier extends Node {
  text = "id";
}
class Type {
  constructor(
    public flags: number,
    public id: number,
  ) {}
}

const values: unknown[] = [new Node(1), new Identifier(2), new Type(4, 7), "s", 3];
let total = 0;
for (const value of values) {
  if (value instanceof Identifier) total += value.kind | value.flags;
  else if (value instanceof Node) total += value.kind;
  else if (value instanceof Type) total += value.flags & 6;
}
console.log(total, values, inspect(new Type(1, 2)));
console.log(JSON.stringify(values), String(values[0]), typeof values[2]);
`;

async function lowered(program = source): Promise<IrModule> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-int32-dynamic-"));
  try {
    const entry = join(dir, "main.ts");
    await writeFile(entry, program);
    const outPath = join(dir, "main.ir.json");
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    return deserializeModule(await readFile(outPath, "utf8"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("classes that only reach dynamic reads keep their int32 fields", async () => {
  const mod = await lowered();
  // Name the functions whose dynamic helpers count as stores that can name
  // any property: such a helper either stores into the value or is missing
  // from the analysis's read-only list (DYN_READ_ONLY in int32-slots.ts).
  const storing = mod.functions
    .filter((fn) => dynamicFieldStores({ ...mod, functions: [fn] }).all)
    .map((fn) => fn.name);
  expect(storing).toEqual([]);
  expect(dynamicFieldStores(mod).names.size).toBe(0);

  const slots = analyzeInt32Slots(mod);
  const className = (jsName: string): string =>
    mod.classes!.find((c) => (c.jsName ?? c.name) === jsName || c.name.endsWith(`.${jsName}`))!
      .name;
  expect([
    slots.isField(className("Node"), "kind"),
    slots.isField(className("Node"), "flags"),
    slots.isField(className("Identifier"), "kind"),
    slots.isField(className("Type"), "flags"),
    slots.isField(className("Type"), "id"),
  ]).toEqual([true, true, true, true, true]);
  // The program reaches the helper that names class prototypes for inspection.
  expect(mod.functions.some((fn) => fn.name.startsWith("%prototype.data."))).toBe(true);
});

// A checked cast of a dynamic value that another holder still references
// adopts the source (dyn.adoptShared): the adoption reads the value it built
// and stores no property, so classes that reach dynamic code keep their int32
// fields.
const adopting = `
class Node {
  kind: number;
  flags = 0;
  constructor(kind: number) {
    this.kind = kind;
  }
}
type Job = { name: string; tags: string[] };

const values: unknown[] = [new Node(1), new Node(2)];
let total = 0;
for (const value of values) if (value instanceof Node) total += value.kind | value.flags;
const raw: unknown = JSON.parse(process.argv[2] ?? '{"name":"a","tags":["t"]}');
const job = raw as Job;
const same = raw as Job;
job.tags.push("u");
console.log(total, values, same.tags.join(","), job.name);
`;

test("adopting checked casts keep int32 fields of dynamically reached classes", async () => {
  const mod = await lowered(adopting);
  const adopts = mod.functions.filter((fn) =>
    JSON.stringify(fn.body).includes('"fn":"dyn.adoptShared"'),
  );
  expect(adopts.length).toBeGreaterThan(0);
  expect(dynamicFieldStores(mod).all).toBe(false);
  const slots = analyzeInt32Slots(mod);
  const node = mod.classes!.find(
    (c) => (c.jsName ?? c.name) === "Node" || c.name.endsWith(".Node"),
  )!;
  expect([slots.isField(node.name, "kind"), slots.isField(node.name, "flags")]).toEqual([
    true,
    true,
  ]);
});

// A weak collection's constructor reads its seed and keeps the identity of
// each key. Owning one stores no property through a dynamic value, so the
// program's classes keep their final fields (reads of them borrow) and their
// int32 fields; a store through a dynamic value still names every field.
const weakOwner = (store: string): string => `
class Item {
  kind: number;
  tags: string[] = [];
  constructor(kind: number) {
    this.kind = kind;
  }
}
const seen = new WeakMap<object, number>();
const marked = new WeakSet<object>([]);
const item = new Item(3);
seen.set(item, 1);
marked.add(item);
item.tags.push("a");
${store}
console.log(item.kind | 0, item.tags.length, seen.get(item), marked.has(item));
`;

test("owning a weak collection is not a dynamic store", async () => {
  const mod = await lowered(weakOwner(""));
  const text = JSON.stringify(mod.functions);
  expect(text).toContain('"fn":"weakMap.new"');
  expect(text).toContain('"fn":"weakSet.new"');
  expect(dynamicFieldStores(mod).all).toBe(false);
  const item = mod.classes!.find(
    (c) => (c.jsName ?? c.name) === "Item" || c.name.endsWith(".Item"),
  )!;
  expect(analyzeFinalFields(mod).isFinal(item.name, "tags")).toBe(true);
  expect(analyzeInt32Slots(mod).isField(item.name, "kind")).toBe(true);

  const stored = await lowered(
    weakOwner('const key: string = process.argv[2] ?? "kind";\n(item as any)[key] = 4;'),
  );
  expect(dynamicFieldStores(stored).all).toBe(true);
  const storedItem = stored.classes!.find(
    (c) => (c.jsName ?? c.name) === "Item" || c.name.endsWith(".Item"),
  )!;
  expect(analyzeFinalFields(stored).isFinal(storedItem.name, "tags")).toBe(false);
});

// Helpers that read a dynamic value and store nothing: `await` of a checked
// value, Object.is, `in` and Object.hasOwn with a computed key, and a string
// replace whose callback has untyped parameters, a DataView over a buffer,
// `instanceof` a built-in error class and Object.values consumed by a loop.
// A program that uses them
// keeps its final fields and int32 fields; one test per helper shows the
// program really lowers to it, and a store through a dynamic value still
// names every field.
const readers = (store: string): string => `
class Item {
  kind: number;
  tags: string[] = [];
  constructor(kind: number) {
    this.kind = kind;
  }
}
const item = new Item(3);
item.tags.push("a");
const values: unknown[] = [item, "kind", 2];
const key: any = values[1];
const target: any = values[0];
async function settle(value: unknown): Promise<number> {
  const settled = await value;
  return settled === item ? 1 : 0;
}
const vars: Record<string, string> = { name: "x" };
const text = "{name}_b".replace(/\\{(\\w+)\\}/g, (_m, name) => vars[name] ?? name);
const same = Object.is(values[0], values[2]);
const has = key in target;
const own = Object.hasOwn(target, key);
const buffer: any = new ArrayBuffer(8);
const view = new DataView(buffer, 2);
const failed = values[0] instanceof TypeError;
let listed = 0;
for (const value of Object.values(target)) listed += value === undefined ? 0 : 1;
${store}
async function main(): Promise<void> {
  const settled = await settle(values[0]);
  console.log(settled, text, same, has, own, item.kind | 0, item.tags.length);
  console.log(view.byteLength, failed, listed);
}
main();
`;

test.each([
  "async.awaitDyn",
  "dyn.sameValue",
  "dyn.hasKeyComputed",
  "dyn.hasOwnComputed",
  "regex.replaceCallback",
  "arrayBuffer.viewDV",
  "dyn.errInstanceof",
  "dyn.objValueList",
])("%s is not a dynamic store", async (fn) => {
  const mod = await lowered(readers(""));
  expect(JSON.stringify(mod.functions)).toContain(`"fn":"${fn}"`);
  // No function of the program holds a call that names every field.
  const storing = mod.functions
    .filter((f) => dynamicFieldStores({ ...mod, functions: [f] }).all)
    .map((f) => f.name);
  expect(storing).toEqual([]);
  const item = mod.classes!.find(
    (c) => (c.jsName ?? c.name) === "Item" || c.name.endsWith(".Item"),
  )!;
  expect(analyzeFinalFields(mod).isFinal(item.name, "tags")).toBe(true);
  expect(analyzeInt32Slots(mod).isField(item.name, "kind")).toBe(true);
});

test("a store through a dynamic value still names every field beside the readers", async () => {
  const stored = await lowered(readers("target[key] = 4;"));
  expect(dynamicFieldStores(stored).all).toBe(true);
  const item = stored.classes!.find(
    (c) => (c.jsName ?? c.name) === "Item" || c.name.endsWith(".Item"),
  )!;
  expect(analyzeFinalFields(stored).isFinal(item.name, "tags")).toBe(false);
});
