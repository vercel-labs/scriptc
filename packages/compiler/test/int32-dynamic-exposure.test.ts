import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";
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
