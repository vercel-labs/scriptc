import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../src/index.js";
import type { IrModule } from "../src/ir/ir.js";

async function lower(source: string): Promise<IrModule> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-class-static-reflection-"));
  try {
    const entry = join(dir, "main.ts");
    const output = join(dir, "main.ir.json");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath: output, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((item) => `${item.code}: ${item.message}`).join("\n"));
    const module = deserializeModule(await readFile(output, "utf8"));
    expect(validateModule(module)).toEqual([]);
    return module;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a class value's table boxes a static whose parameters complete", async () => {
  // `make` declares an optional parameter: its value form cannot spell a
  // native ABI for the table's checked-dynamic entry, so it is boxed there
  // rather than escaping lowering as a refusal the class never asked for.
  const module = await lower(`
class Field {
  #value = "x";
  get value(): string { return this.#value; }
  static make(name: string, extra?: string): string { return name + (extra ?? ""); }
}
function read(el: any) {
  return Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value");
}
const field = new Field();
console.log(typeof read(field), Field.make("a"));
`);
  expect(module.functions.some((fn) => fn.name === "%dyn.class.statics.Field")).toBe(true);
});

test("a prototype view still lowers a member whose body refuses the dynamic receiver", async () => {
  // Lowering the view runs the setter's body a second time over a dynamic
  // receiver, where `this.item` has no static type and cannot be a Map key.
  // That statement fences at run time; it must not fail the build of a
  // program that only asked for the prototype's descriptors.
  const module = await lower(`
class Item {
  name = "it";
}
const seen: Map<Item, number> = new Map();
class Timer {
  readonly item: Item;
  constructor(item: Item) { this.item = item; }
  set currentTime(ms: number) { const state = seen.get(this.item); console.log(state ?? ms); }
}
function descriptorOf(o: any) {
  return Object.getOwnPropertyDescriptor(Object.getPrototypeOf(o), "currentTime");
}
const timer = new Timer(new Item());
console.log(descriptorOf(timer) !== undefined);
`);
  expect(module.functions.length).toBeGreaterThan(0);
});
