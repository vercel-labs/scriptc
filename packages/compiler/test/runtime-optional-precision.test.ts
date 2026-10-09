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
      dynamic: false,
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
    new RegExp(`^define internal [^\\n]*@${symbol}\\([^]*?^}`, "m").exec(llvm);
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

test("an unchanged captured parameter is borrowed and boxed only where a closure is built", async () => {
  const module = await lower(`${ITEM}
function heavier(item: Item, limits: number[]): boolean {
  if (limits.length === 0) return false;
  return limits.some((limit) => weigh(item) > limit);
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
  const heavier = body(emitLlvmModule(module), "heavier");
  expect(heavier.slice(0, heavier.indexOf("scr_closure_new"))).not.toContain("@scr_box_new");
  // A path that built no environment skips the box release.
  expect(heavier).toMatch(/icmp ne ptr %t\d+, null\n\s+br i1 %t\d+, label %lazy\.release/);
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
