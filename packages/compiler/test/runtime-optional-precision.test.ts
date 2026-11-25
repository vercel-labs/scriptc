import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../src/index.js";
import { analyzeCallLifetimes } from "../src/backend/llvm/call-lifetimes.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";
import { type IrModule, type IrType } from "../src/ir/ir.js";

async function lower(source: string): Promise<IrModule> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-optional-precision-"));
  try {
    const entry = join(dir, "main.ts"),
      output = join(dir, "main.ir.json");
    await writeFile(entry, source);
    const result = await compile(entry, {
      outDir: dir,
      outPath: output,
      outputKind: "ir",
    });
    if (!result.ok)
      throw new Error(result.diagnostics.map((item) => `${item.code}: ${item.message}`).join("\n"));
    const module = deserializeModule(await readFile(output, "utf8"));
    expect(validateModule(module)).toEqual([]);
    return module;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** `name(param, ...): result` with union arms spelled out. */
function signature(module: IrModule, name: string): string {
  const fn = module.functions.find((candidate) => candidate.name === name);
  expect(fn, name).toBeDefined();
  const unions = new Map((module.unions ?? []).map((union) => [union.id, union]));
  const spell = (type: IrType): string =>
    type.kind === "object"
      ? type.className
      : type.kind === "union"
        ? unions.get(type.unionId)!.arms.map(spell).join("|")
        : type.kind === "undefinedT"
          ? "undefined"
          : type.kind;
  return `${name}(${fn!.params.map((param) => spell(param.type)).join(", ")}): ${spell(fn!.returnType)}`;
}

/** The emitted body of a function, under its body or entry symbol. */
function body(llvm: string, name: string): string {
  const find = (symbol: string): RegExpExecArray | null =>
    new RegExp(`^define internal [^\\n]*@${symbol}(?:\\.i32)?\\([^]*?^}`, "m").exec(llvm);
  const found = find(`sc_bf_${name}`) ?? find(`sc_f_${name}`);
  expect(found, name).not.toBeNull();
  return found![0];
}

const ITEM = `class Item {
  weight: number;
  constructor(weight: number) {
    this.weight = weight;
  }
}
function weigh(item: Item): number {
  return item.weight;
}
`;

test("callbacks over arrays that never hold undefined keep annotated parameters", async () => {
  const module = await lower(`${ITEM}
function check(item: Item): Item {
  weigh(item);
  return item;
}
const items: Item[] = [new Item(2)];
items.push(new Item(3));
console.log(items.map((item) => check(item)).length, items.some((item) => weigh(item) > 2));
console.log(items.filter(check).length);
`);
  expect(signature(module, "weigh")).toBe("weigh(Item): f64");
  expect(signature(module, "check")).toBe("check(Item): Item");
});

test("an undefined store, a hole for the find family, or a spread of holes widens the callee", async () => {
  const stored = await lower(`${ITEM}
const empty: Item[] = [];
const items: Item[] = [new Item(1)];
items.push(empty[4]);
console.log(items.map((item) => weigh(item)).join(","));
`);
  expect(signature(stored, "weigh")).toBe("weigh(Item|undefined): f64");
  const holes = await lower(`${ITEM}
const items: Item[] = [new Item(1)];
items[3] = new Item(2);
console.log(items.findIndex((item) => weigh(item) > 1));
`);
  expect(signature(holes, "weigh")).toBe("weigh(Item|undefined): f64");
  const spread = await lower(`${ITEM}
const items: Item[] = [new Item(1)];
items.length = 3;
const copy = [...items];
console.log(copy.map((item) => weigh(item)).join(","));
`);
  expect(signature(spread, "weigh")).toBe("weigh(Item|undefined): f64");
});

test("Promise.all results hold undefined only where an entry can be a hole or undefined", async () => {
  const LOAD = `${ITEM}
async function load(item: Item, skip: boolean): Promise<Item> {
  if (skip) return item;
  return new Item(item.weight + (await Promise.resolve(1)));
}
`;
  const settled = await lower(`${LOAD}
async function main(): Promise<void> {
  let items: Item[] = [new Item(1), new Item(2)];
  items = await Promise.all(items.map((item) => load(item, item.weight > 1)));
  console.log(items.map((item) => weigh(item)).join(","));
}
void main();
`);
  expect(signature(settled, "weigh")).toBe("weigh(Item): f64");
  const missing = await lower(`${LOAD}
async function main(): Promise<void> {
  const pending: Promise<Item>[] = [];
  pending[2] = load(new Item(1), false);
  const items = await Promise.all(pending);
  console.log(items.map((item) => weigh(item)).join(","));
}
void main();
`);
  expect(signature(missing, "weigh")).toBe("weigh(Item|undefined): f64");
});

test("holes stored through a dynamic view widen callbacks over the arrays it views", async () => {
  const viewed = await lower(`${ITEM}
const items: Item[] = [new Item(1)];
const view: unknown[] = items;
view[3] = new Item(2);
console.log(items.findIndex((item) => weigh(item) > 1));
`);
  expect(signature(viewed, "weigh")).toBe("weigh(Item|undefined): f64");
  // A dynamic store cannot reach an element type no dynamic value views.
  const other = await lower(`${ITEM}
const items: Item[] = [new Item(1)];
const values: unknown[] = [1];
values[3] = 2;
console.log(items.findIndex((item) => weigh(item) > 1));
`);
  expect(signature(other, "weigh")).toBe("weigh(Item): f64");
  // A view without stores that leave holes keeps the parameters.
  const read = await lower(`${ITEM}
const items: Item[] = [new Item(1)];
const view: unknown[] = items;
console.log(view.length, items.findIndex((item) => weigh(item) > 1));
`);
  expect(signature(read, "weigh")).toBe("weigh(Item): f64");
  // Standard library functions that take arrays as `any` only read them.
  const readers = await lower(`${ITEM}
const items: Item[] = [new Item(1)];
console.log(items.length, JSON.stringify(items));
const values: unknown[] = [1];
values[3] = 2;
console.log(items.findIndex((item) => weigh(item) > 1));
`);
  expect(signature(readers, "weigh")).toBe("weigh(Item): f64");
  // A store through a Record type is not a store through a view.
  const record = await lower(`${ITEM}
const items: Item[] = [new Item(1)];
const view: unknown = items;
const bag: Record<string, unknown> = {};
bag["3"] = view;
console.log(items.findIndex((item) => weigh(item) > 1));
`);
  expect(signature(record, "weigh")).toBe("weigh(Item): f64");
  // An unknown[] that only holds the array its declaration creates is never
  // a view, so stores past its end leave the viewed arrays alone.
  const fresh = await lower(`${ITEM}
class Slots {
  readonly states: unknown[] = [];
}
const slots = new Slots();
const items: Item[] = [new Item(1)];
const view: unknown = items;
const states = slots.states;
states[3] = view;
console.log(items.findIndex((item) => weigh(item) > 1));
`);
  expect(signature(fresh, "weigh")).toBe("weigh(Item): f64");
  // A mutable property every assignment of which is a fresh array is fresh
  // storage too.
  const reassigned = await lower(`${ITEM}
class Facts {
  private facts: unknown[] = [];
  begin(): void {
    this.facts = [];
  }
  add(fact: unknown): void {
    this.facts[3] = fact;
  }
}
const items: Item[] = [new Item(1)];
const facts = new Facts();
facts.begin();
facts.add(items);
console.log(items.findIndex((item) => weigh(item) > 1));
`);
  expect(signature(reassigned, "weigh")).toBe("weigh(Item): f64");
});

test("holes that only their owning slot can observe stay out of callbacks", async () => {
  const module = await lower(`${ITEM}
class Cache {
  private readonly slots: Item[];
  constructor(size: number) {
    this.slots = new Array<Item>(size);
  }
  get(index: number): Item {
    if (Object.hasOwn(this.slots, index)) return this.slots[index]!;
    const item = new Item(index);
    this.slots[index] = item;
    return item;
  }
}
const cache = new Cache(4);
const picked = [cache.get(2), cache.get(1)];
console.log(picked.find((item) => weigh(item) === 1)?.weight);
`);
  expect(signature(module, "weigh")).toBe("weigh(Item): f64");
});

test("a dominating guard keeps an unchecked read from widening its callee", async () => {
  const module = await lower(`${ITEM}
const items: Item[] = [new Item(1)];
function first(index: number): number {
  const item = items[index];
  if (item === undefined) return -1;
  return weigh(item);
}
function either(index: number): boolean {
  const item = items[index];
  return item !== undefined && weigh(item) > 0;
}
console.log(first(0), first(3), either(0), either(5));
`);
  expect(signature(module, "weigh")).toBe("weigh(Item): f64");
});

test("a rebound binding keeps its widening after a guard", async () => {
  const module = await lower(`${ITEM}
const items: Item[] = [new Item(1)];
function later(index: number): number {
  let item = items[index];
  if (item === undefined) return -1;
  item = items[index + 1];
  return weigh(item);
}
console.log(later(0));
`);
  expect(signature(module, "weigh")).toBe("weigh(Item|undefined): f64");
});

test("an unchanged captured parameter is borrowed and copied where a closure is built", async () => {
  const module = await lower(`${ITEM}
function heavier(item: Item, limits: number[]): boolean {
  if (limits.length === 0) return false;
  // A closure value: a closure literal at the call would run as a loop.
  const over = (limit: number): boolean => weigh(item) > limit;
  return limits.some(over);
}
function replaced(item: Item, other: Item): number {
  const read = () => item.weight;
  item = other;
  return read();
}
console.log(heavier(new Item(3), []), heavier(new Item(3), [1]), replaced(new Item(1), new Item(2)));
`);
  const facts = analyzeCallLifetimes(new Map(module.functions.map((fn) => [fn.name, fn])));
  expect(facts.borrowed.get("heavier")?.has(0)).toBe(true);
  expect(facts.borrowed.get("replaced")?.has(0) ?? false).toBe(false);
  const llvm = emitLlvmModule(module);
  // The closure holds its own reference to the item: no box on any path.
  const heavier = body(llvm, "heavier");
  expect(heavier).toContain("scr_closure_new_values");
  expect(heavier).not.toContain("@scr_box_new");
  expect(heavier).not.toContain("lazy.release");
  // A rebound parameter keeps its box.
  expect(body(llvm, "replaced")).toContain("@scr_box_new");
});

test("pop truncates union arrays and boxes nothing when its result is unused", async () => {
  const module = await lower(`
class Circle { radius = 1; }
class Square { side = 2; }
const shapes: (Circle | Square)[] = [new Circle(), new Square()];
const counts: number[] = [1, 2, 3];
function drop(): number {
  shapes.pop();
  counts.pop();
  return shapes.length + counts.length;
}
function take(): Circle | Square | undefined {
  return shapes.pop();
}
console.log(drop(), take(), take(), shapes.length);
`);
  const llvm = emitLlvmModule(module);
  const drop = body(llvm, "drop");
  expect(drop).not.toContain("@scr_union_new");
  expect(drop).not.toContain("@scr_arr_splice");
  expect(drop).not.toContain("_state(");
  expect(body(llvm, "take")).not.toContain("@scr_arr_splice");
});

test("asserted values forward undefined only where no proof shows them present", async () => {
  const proven = await lower(`${ITEM}
const items: Item[] = [new Item(1), new Item(2)];
let total = 0;
for (let i = 0; i < items.length; i++) total += weigh(items[i]!);
function guarded(item: Item | undefined): number {
  if (item === undefined) return 0;
  return weigh(item!);
}
console.log(total, guarded(items[0]), guarded(undefined));
`);
  expect(signature(proven, "weigh")).toBe("weigh(Item): f64");
  const unproven = await lower(`${ITEM}
const items: Item[] = [new Item(1)];
function describe(item: Item): string {
  return item === undefined ? "none" : String(item.weight);
}
console.log(describe(items[4]!));
`);
  expect(signature(unproven, "describe")).toBe("describe(Item|undefined): string");
});

test("a type assertion keeps an unchecked read from widening its callee", async () => {
  const module = await lower(`
function hot(n: number): number {
  return (n * 2) | 0;
}
function cold(xs: number[]): number {
  let s = 0;
  for (let i = 0; i < xs.length; i++) s = (s + hot(xs[i] as number)) | 0;
  return s;
}
function drain(stack: number[]): number {
  let s = 0;
  while (stack.length > 0) s = (s + hot(stack.pop() as number)) | 0;
  return s;
}
function lookup(m: Map<string, number>): number {
  return hot(<number>m.get("a"));
}
console.log(cold([1, 2, 3]), drain([4, 5]), lookup(new Map([["a", 6]])));
`);
  expect(signature(module, "hot")).toBe("hot(f64): f64");
  const llvm = emitLlvmModule(module);
  for (const caller of ["cold", "drain", "lookup"])
    expect(body(llvm, caller)).not.toContain("@scr_union_new");
});

/** The instances of a generic function, by the element type of their
 * first parameter, with whether the body tests an element's state. */
function instanceReads(module: IrModule, name: string): Record<string, boolean> {
  const reads: Record<string, boolean> = {};
  for (const fn of module.functions) {
    if (!fn.name.startsWith(`${name}%`)) continue;
    const first = fn.params[0]!.type;
    const element = first.kind === "array" ? first.elem : first;
    const key = element.kind === "object" ? element.className : element.kind;
    reads[key] = JSON.stringify(fn.body).includes('"kind":"arrayState"');
  }
  return reads;
}

test("a generic loop is judged with each instance's element type", async () => {
  // Item arrays can hold a hole; string arrays cannot.
  const module = await lower(`${ITEM}
function total<T>(xs: readonly T[], measure: (x: T) => number): number {
  let sum = 0;
  for (const x of xs) sum += x === undefined ? 0 : measure(x);
  return sum;
}
const items: Item[] = [];
items[2] = new Item(3);
const words: string[] = ["a", "bc"];
console.log(total(items, weigh), total(words, (word) => word.length));
`);
  expect(instanceReads(module, "total")).toEqual({ Item: true, string: false });
});

test("a generic loop over arrays that never hold undefined reads elements directly", async () => {
  const module = await lower(`${ITEM}
function total<T>(xs: readonly T[], measure: (x: T) => number): number {
  let sum = 0;
  for (const x of [...xs, ...xs.slice()]) sum += measure(x);
  const copy = xs.slice();
  for (const x of copy) sum += measure(x);
  return sum;
}
const items: Item[] = [new Item(2), new Item(3)];
const words: string[] = ["a", "bc"];
console.log(total(items, weigh), total(words, (word) => word.length));
`);
  expect(instanceReads(module, "total")).toEqual({ Item: false, string: false });
});

test("an array a generic function builds carries its argument's holes", async () => {
  // The copy holds the holes as present undefined elements, so what visits
  // it takes the element or undefined. An arrow written at the call is no
  // function of the module once the loop has taken its body (nothing else
  // reaches it), so the loop's own read tells; a named function stays, and
  // its parameter tells.
  const visits = (fill: string): Promise<string[]> =>
    lower(`${ITEM}
function clone<T>(xs: readonly T[]): T[] {
  return [...xs];
}
function tally(item: Item): number {
  return item === undefined ? 0 : weigh(item);
}
const items: Item[] = [];
${fill}
const copy = clone(items);
let sum = 0;
copy.forEach((item) => {
  sum += item === undefined ? 0 : weigh(item);
});
console.log(sum, copy.map(tally).join(","));
`).then((module) => [
      signature(module, "tally"),
      ...module.functions
        .filter((fn) => fn.name.startsWith("%arr.loop."))
        .map((fn) =>
          JSON.stringify(fn.body).includes('"kind":"arrayState"')
            ? "the loop tests the element's state"
            : "the loop reads the element directly",
        ),
      ...module.functions
        .filter(
          (fn) =>
            fn.params.length === 1 &&
            fn.returnType.kind === "void" &&
            !fn.name.startsWith("%") &&
            !fn.name.startsWith("clone"),
        )
        .map((fn) => signature(module, fn.name).replace(/^[^(]*/, "callback")),
    ]);
  // Whichever holds the arrow's body: the loop, or the arrow itself.
  const holed = await visits("items[2] = new Item(3);");
  expect(holed[0]).toBe("tally(Item|undefined): f64");
  expect(holed.slice(1)).toSatisfy(
    (seen: string[]) =>
      seen.length > 0 &&
      seen.every(
        (item) =>
          item === "the loop tests the element's state" ||
          item === "callback(Item|undefined): void",
      ),
  );
  const dense = await visits("items.push(new Item(3));");
  expect(dense[0]).toBe("tally(Item): f64");
  expect(dense.slice(1)).toSatisfy(
    (seen: string[]) =>
      seen.length > 0 &&
      seen.every(
        (item) => item === "the loop reads the element directly" || item === "callback(Item): void",
      ),
  );
});
