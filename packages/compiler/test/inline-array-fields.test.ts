import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

// InlineArray fields (@scriptc/experimental, ir/inline-arrays.ts): the
// elements of a ProgramLifetime class's array field written once from a
// constructor parameter live in the instance, after its fixed fields.

const repoRoot = join(import.meta.dirname, "../../..");

const header = `
import type { ProgramLifetime } from "@scriptc/types";
import type { InlineArray } from "@scriptc/experimental";
`;

async function build(source: string): Promise<{
  ok: boolean;
  codes: string[];
  llvm: string;
  messages: string[];
  warnings: string[];
}> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-inline-array-"));
  try {
    // The workspace's packages, so that the program resolves both imports.
    await symlink(join(repoRoot, "node_modules"), join(dir, "node_modules"));
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ll");
    await writeFile(entry, header + source);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "llvm" });
    const llvm = result.ok ? await readFile(outPath, "utf8") : "";
    return {
      ok: result.ok,
      codes: (result.diagnostics ?? []).map((d) => d.code),
      messages: (result.diagnostics ?? []).map((d) => d.message),
      warnings: (result.ok ? (result.warnings ?? []) : []).map((d) => `${d.code}: ${d.message}`),
      llvm,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const classes = `
class Item implements ProgramLifetime {
  readonly kind: number;
  constructor(kind: number) {
    this.kind = kind;
  }
}
class List implements ProgramLifetime {
  readonly pos: number;
  readonly items: InlineArray<Item>;
  constructor(pos: number, items: readonly Item[]) {
    this.pos = pos;
    this.items = items;
  }
}
class Flagged extends List {
  readonly flags: number;
  constructor(pos: number, items: readonly Item[], flags: number) {
    super(pos, items);
    this.flags = flags;
  }
}
`;

const body = (fn: string, llvm: string): string =>
  new RegExp(`^define internal [^@]+@sc_bf_${fn}\\([^]*?^}`, "m").exec(llvm)?.[0] ?? "";

// The inline layout applies to executables whose compact instances live in
// the low region: Linux, 64-bit.
const lowRegion =
  process.platform === "linux" && (process.arch === "x64" || process.arch === "arm64");

test.runIf(lowRegion)("the elements follow the fixed fields, which keep their count", async () => {
  const { ok, llvm } = await build(
    classes +
      `
const a = new List(1, [new Item(1), new Item(2)]);
const b = new Flagged(2, [new Item(3)], 7);
console.log(a.items.length, b.items.length, b.flags);
`,
  );
  expect(ok).toBe(true);
  // The field's slot is an i32: the header, pos and the count.
  expect(llvm).toMatch(/^%sc_o_List = type \{ i32, i32, i32 \}/m);
  expect(llvm).toMatch(/^%sc_o_Flagged = type \{ i32, i32, i32, i32 \}/m);
  // `new` takes the count and allocates room for the 32-bit references
  // after the largest fixed part in the subtree (Flagged's 16 bytes).
  expect(llvm).toContain("define internal ptr @sc_new_List(i32 %inl.len)");
  expect(llvm).toContain("%inl.size = add nuw nsw i64 %inl.bytes, 16");
  // The constructor copies the argument's elements into the instance.
  expect(llvm).toContain("call void @scr_arr_copy_cref_tail(");
});

test.runIf(lowRegion)("indexing, length and local aliases read the instance", async () => {
  const { ok, llvm } = await build(
    classes +
      `
function sum(list: List): number {
  let s = 0;
  const items = list.items;
  for (let i = 0; i < items.length; i++) s += items[i]!.kind;
  for (const item of list.items) s += item.kind;
  return s + list.items[0]!.kind;
}
const list = new List(0, [new Item(1), new Item(2)]);
console.log(sum(list));
`,
  );
  expect(ok).toBe(true);
  const sum = body("sum", llvm);
  expect(sum).not.toBe("");
  // Elements are 32-bit references loaded from the instance; only the
  // out-of-bounds path makes an array of them, for the runtime getter.
  expect(sum).toMatch(/getelementptr inbounds i32, ptr %\S+, i64 %\S+\n\s*%\S+ = load i32/);
  const hits = sum.split(/\n(?=\S)/).filter((block) => block.startsWith("inl.get.hit"));
  expect(hits.length).toBeGreaterThan(0);
  for (const block of hits) expect(block).not.toContain("scr_arr_view_cref");
  for (const line of sum.split("\n").filter((l) => l.includes("scr_arr_view_cref(")))
    expect(line).not.toContain("scr_arr_get_ref");
});

test.runIf(lowRegion)("for...of tests presence on the instance", async () => {
  const { ok, llvm } = await build(
    classes +
      `
// An array that may have holes: each loop over a list tests each index.
function holed(items: readonly Item[]): Item[] {
  const out: Item[] = new Array<Item>(items.length);
  for (let i = 0; i < items.length; i++) out[i] = items[i]!;
  return out;
}
function kinds(list: List): number {
  let s = 0;
  for (const item of list.items) s += item.kind;
  return s;
}
console.log(kinds(new List(0, holed([new Item(1), new Item(2)]))));
`,
  );
  expect(ok).toBe(true);
  const kinds = body("kinds", llvm);
  expect(kinds).not.toBe("");
  expect(kinds).not.toContain("scr_arr_state");
  // Only an index outside the count makes an array, for the runtime getter.
  for (const block of kinds.split(/\n(?=\S)/).filter((b) => b.includes("scr_arr_view_cref(")))
    expect(block.startsWith("inl.get.miss")).toBe(true);
});

test.runIf(lowRegion)("a read that escapes gives an array of the elements", async () => {
  const { ok, llvm } = await build(
    classes +
      `
function count(items: readonly Item[]): number {
  return items.length;
}
function use(list: List): number {
  return count(list.items) + list.items.indexOf(list.items[0]!);
}
console.log(use(new List(0, [new Item(1)])));
`,
  );
  expect(ok).toBe(true);
  expect(body("use", llvm)).toContain("call ptr @scr_arr_view_cref(");
});

test("writes to the arrays fields hold are refused", async () => {
  for (const write of [
    // Through a read of the field.
    `function grow(list: List): void {
  (list.items as Item[]).push(new Item(5));
}
grow(new List(0, [new Item(1)]));`,
    // Through a parameter and an array element.
    `function clear(items: readonly Item[]): void {
  (items as Item[]).length = 0;
}
const all = [new List(0, [new Item(1)]).items];
clear(all[0]!);`,
    // Through a Map value.
    `const byPos = new Map<number, readonly Item[]>();
const list = new List(0, [new Item(1)]);
byPos.set(list.pos, list.items);
(byPos.get(0)! as Item[])[0] = new Item(2);`,
  ]) {
    const result = await build(classes + write);
    expect(result.ok).toBe(false);
    expect(result.codes).toContain("SC7009");
    expect(result.messages.join("\n")).toContain(
      "writes to an array that may be an InlineArray field's",
    );
  }
});

test("arrays fields hold do not reach unchecked code inside other values", async () => {
  for (const [use, where] of [
    // Inside an array passed through a function value.
    [
      `const cb = (xs: Item[][]): void => {
  xs[0]!.push(new Item(9));
};
const f: (xs: Item[][]) => void = Math.random() < 2 ? cb : () => {};
f([new List(0, [new Item(1)]).items as Item[]]);`,
      "a call through a function value",
    ],
    // In a field of a class instance that becomes a dynamic value.
    [
      `class Box {
  readonly arr: readonly Item[];
  constructor(arr: readonly Item[]) {
    this.arr = arr;
  }
}
const u: unknown = new Box(new List(0, [new Item(1)]).items);
(u as { arr: Item[] }).arr.push(new Item(9));`,
      "a dynamic value",
    ],
  ]) {
    const result = await build(classes + use);
    expect(result.ok, use).toBe(false);
    expect(result.messages.join("\n"), use).toContain(`reaches ${where}`);
  }
});

test("a write names the field read whose array it may reach", async () => {
  const result = await build(
    classes +
      `
function same(items: readonly Item[]): readonly Item[] {
  return items;
}
const list = new List(0, [new Item(1)]);
const all: (readonly Item[])[] = [same(list.items)];
(all[0]! as Item[]).pop();
`,
  );
  expect(result.ok).toBe(false);
  expect(result.messages.join("\n")).toMatch(
    /writes to an array that may be an InlineArray field's \(from main\.ts:\d+:\d+\)/,
  );
});

test("other arrays of the element type stay writable", async () => {
  // Arrays are followed by where they are held, not by type: a helper that
  // returns its argument gives each caller its own array back.
  const result = await build(
    classes +
      `
function same(items: readonly Item[]): readonly Item[] {
  return items;
}
const list = new List(0, [new Item(1)]);
const views: (readonly Item[])[] = [same(list.items)];
const scratch: Item[][] = [[]];
const own = same([new Item(2)]) as Item[];
scratch[0]!.push(new Item(3));
own.push(new Item(4));
console.log(views[0]!.length, scratch[0]!.length, own.length);
`,
  );
  expect(result.messages).toEqual([]);
});

test("a read of the field may reach printing and copies, but no other library call", async () => {
  const reads = await build(
    classes +
      `
const list = new List(0, [new Item(1)]);
console.log(list.items, JSON.stringify(list.items), [...list.items].length);
console.log(new List(1, list.items.slice()).items.length);
`,
  );
  expect(reads.ok).toBe(true);
  const frozen = await build(
    classes +
      `
console.log(Object.isFrozen(new List(0, [new Item(1)]).items));
`,
  );
  expect(frozen.ok).toBe(false);
  expect(frozen.messages.join("\n")).toContain("reaches the library call");
});

test("the constructor is passed an array nothing else keeps", async () => {
  const accepted = [
    // A literal, a copy, and a factory's result.
    `function fresh(n: number): Item[] {
  const out: Item[] = [];
  for (let i = 0; i < n; i++) out.push(new Item(i));
  return out;
}
const a = new List(0, [new Item(1)]);
const b = new List(1, a.items.concat([new Item(2)]));
console.log(a.items.length, b.items.length, new List(2, fresh(3)).items.length);`,
    // A local's last use, after writes in place, in either arm of a
    // conditional, and after an early return.
    `function make(c: boolean): List {
  const items = [new Item(1)];
  items.push(new Item(2));
  if (items.length > 5) return new List(-1, items);
  return c ? new List(0, items) : new List(1, items);
}
console.log(make(true).items.length, make(false).pos);`,
    // A parameter its callers move.
    `function wrap(pos: number, items: Item[]): List {
  items.reverse();
  return new List(pos, items);
}
function build(n: number): List {
  return wrap(n, Array.from({ length: n }, (_, i) => new Item(i)));
}
console.log(build(2).items[0]!.kind);`,
    // An array a field already holds.
    `const a = new List(0, [new Item(1)]);
const shared = a.items;
console.log(new List(1, shared).items.length, new List(2, shared).pos);`,
    // An array that is never written, shared by several constructors.
    `const none: Item[] = [];
function make(items: Item[]): List {
  return new List(0, items.length === 0 ? none : items);
}
const lists: List[] = [];
for (let i = 0; i < 2; i++) lists.push(new List(i, none));
console.log(lists.length, make([]).items.length, make([new Item(1)]).items.length);`,
    // A local that each pass of a loop moves and then replaces.
    `function pairs(n: number): List[] {
  const lists: List[] = [];
  let items: Item[] = [];
  for (let i = 0; i < n; i++) {
    items.push(new Item(i));
    if (i % 2 === 1) {
      lists.push(new List(i, items));
      items = [];
    }
  }
  return lists;
}
console.log(pairs(4).length);`,
    // A top-level array, read elsewhere.
    `const items = [new Item(1), new Item(2)];
function count(): number {
  return items.length;
}
console.log(count());
const list = new List(0, items);
console.log(list.items.length);`,
  ];
  for (const source of accepted) {
    const result = await build(classes + source);
    expect(result.messages).toEqual([]);
  }
  const refused = [
    // Written after the move.
    `const items = [new Item(1)];
const list = new List(0, items);
items.push(new Item(2));
console.log(list.items.length);`,
    // Kept in another variable.
    `const items = [new Item(1)];
const kept = items;
const list = new List(0, items);
kept.push(new Item(2));
console.log(list.items.length);`,
    // A parameter whose caller keeps the array.
    `function wrap(items: Item[]): List {
  return new List(0, items);
}
const items = [new Item(1)];
const list = wrap(items);
items.push(new Item(2));
console.log(list.items.length);`,
    // A parameter of another class's constructor, and of a method.
    `class Section {
  readonly list: List;
  constructor(items: Item[]) {
    this.list = new List(0, items);
  }
}
const items = [new Item(1)];
const section = new Section(items);
items.push(new Item(2));
console.log(section.list.items.length);`,
    `class Maker {
  make(items: Item[]): List {
    return new List(0, items);
  }
}
class FlagMaker extends Maker {
  override make(items: Item[]): List {
    return new Flagged(0, items, 1);
  }
}
function run(maker: Maker): number {
  const items = [new Item(1)];
  const list = maker.make(items);
  items.push(new Item(2));
  return list.items.length;
}
console.log(run(new Maker()), run(new FlagMaker()));`,
    // A shared array written elsewhere.
    `const none: Item[] = [];
const a = new List(0, none);
const b = new List(1, none);
function add(items: Item[]): void {
  items.push(new Item(2));
}
add(none);
console.log(a.items.length, b.items.length);`,
    // A function returning a shared array.
    `const all: Item[] = [new Item(1)];
function current(): Item[] {
  return all;
}
const list = new List(0, current());
all.push(new Item(2));
console.log(list.items.length);`,
  ];
  for (const source of refused) {
    const result = await build(classes + source);
    expect(result.ok).toBe(false);
    expect(result.codes).toContain("SC7009");
    expect(result.messages.join("\n")).toContain("may be kept elsewhere");
  }
});

test("an InlineArray field must keep its contract", async () => {
  const twice = await build(`
class Item implements ProgramLifetime {}
class List implements ProgramLifetime {
  readonly items: InlineArray<Item>;
  constructor(items: readonly Item[], more: readonly Item[]) {
    this.items = items;
    if (more.length > 0) (this as { items: readonly Item[] }).items = more;
  }
}
console.log(new List([new Item()], []).items.length);
`);
  expect(twice.ok).toBe(false);
  expect(twice.codes).toContain("SC7009");

  const mortal = await build(`
class Item implements ProgramLifetime {}
class List {
  readonly items: InlineArray<Item>;
  constructor(items: readonly Item[]) {
    this.items = items;
  }
}
console.log(new List([new Item()]).items.length);
`);
  expect(mortal.ok).toBe(false);
  expect(mortal.codes).toContain("SC7009");
  expect(mortal.messages.join("\n")).toContain("not ProgramLifetime");

  const computed = await build(`
class Item implements ProgramLifetime {}
class List implements ProgramLifetime {
  readonly items: InlineArray<Item>;
  constructor(n: number) {
    const items: Item[] = [];
    for (let i = 0; i < n; i++) items.push(new Item());
    this.items = items;
  }
}
console.log(new List(2).items.length);
`);
  expect(computed.ok).toBe(false);
  expect(computed.codes).toContain("SC7009");
  expect(computed.messages.join("\n")).toContain("constructor parameter");
});

const holder = `
class Holder {
  readonly list: List;
  constructor(list: List) {
    this.list = list;
  }
}
const list = new List(3, [new Item(1), new Item(2)]);
`;

const keeper = `class Keeper {
  readonly arr: readonly Item[];
  readonly list: List;
  constructor(arr: readonly Item[], list: List) {
    this.arr = arr;
    this.list = list;
  }
}
`;

test("a dynamic value that may reach generic reads of the field keeps it an ordinary array", async () => {
  for (const [use, where] of [
    [
      "const u: unknown = new Holder(list);\n(u as { list: { items: Item[] } }).list.items.push(new Item(3));",
      "a checked cast to a structured type",
    ],
    // A record built from the instance's members, one of which is the field.
    [
      "const u: unknown = list;\nconsole.log((u as { pos: number; items: readonly Item[] }).pos);",
      "a checked cast to a structured type",
    ],
    // An array method's callback: what `map` returns, the receiver it gets,
    // a library function, and a receiver's own method.
    [
      "const u: any = [new Holder(list)];\nconst m = u.map((x: any) => x);\nm[0].list.items.push(new Item(5));",
      "the dynamic method call 'push'",
    ],
    [
      "const u: any = [new Holder(list)];\nlet kept: any = [];\nu.forEach((x: any, i: number, all: any) => {\n  kept = all;\n});\nkept.reverse();",
      "the dynamic method call 'reverse'",
    ],
    [
      "const u: any = [list];\nconst g: unknown = (globalThis as any).structuredClone;\nconsole.log(u.map(g).length);",
      "the dynamic method call 'map' with a callback no compiled function reaches",
    ],
    [
      "const u: any = { list, map(f: any) { return f(this.list); } };\nconsole.log(u.map((x: any) => x.pos));",
      "the dynamic method call 'map' on a value that may hold a function",
    ],
    [
      "const u: any = new Holder(list);\nconsole.log(u.list.items === u.list.items);",
      "a keyed read of a member that may be the field",
    ],
    [
      "const u: any = new Holder(list);\nconst key = String(Math.random() < 2 ? 'items' : 'pos');\nconsole.log(u.list[key]);",
      "a keyed read of a member that may be the field",
    ],
    [
      "const u: unknown = new Holder(list);\nconsole.log(Object.entries(u as object).length);",
      "the library call",
    ],
    [
      "const u: unknown[] = [new Holder(list)];\nconst g: (x: unknown) => unknown = (globalThis as any).structuredClone;\nconsole.log(g(u[0]) !== undefined);",
      "a call through a value no compiled function reaches",
    ],
    // An array a field read gave, kept in another field of the instance.
    [
      `${keeper}const k: any = new Keeper(list.items, list);\nk.arr.push(new Item(9));`,
      "the dynamic method call 'push'",
    ],
    [
      `${keeper}const k: any = new Keeper(list.items, list);\nk.arr.length = 0;`,
      "the library call dyn.keySet of an array element or length",
    ],
  ]) {
    const result = await build(classes + holder + use);
    expect(result.messages, use).toEqual([]);
    expect(result.ok, use).toBe(true);
    expect(result.warnings.join("\n"), use).toContain(
      `SC6105: 'List.items' keeps its elements in an ordinary array: an instance, or a value that can hold one, becomes a dynamic value that reaches ${where}`,
    );
    expect(result.warnings.join("\n"), use).toContain("(at ");
    // The constructor stores the array; nothing copies its elements.
    if (lowRegion) expect(result.llvm, use).not.toContain("scr_arr_copy_cref_tail");
  }
});

test("a dynamic value that may hold an instance may be cast back, tested, printed and passed on", async () => {
  for (const use of [
    "const u: unknown = [{ list }];\nconsole.log(u);",
    "const u: unknown = new Map([[1, new Holder(list)]]);\nconsole.log(u, JSON.stringify(u));",
    `function count(u: unknown): number {
  return u instanceof Holder ? u.list.items.length : -1;
}
const values: unknown[] = [new Holder(list), 1, "x"];
for (const value of values) console.log(count(value));`,
    // Calls through an interface several classes implement dispatch on the
    // value's class.
    `interface Positioned {
  readonly label: string;
  pos(): number;
}
class First implements Positioned {
  readonly label = "first";
  constructor(readonly holder: Holder) {}
  pos(): number {
    return this.holder.list.pos;
  }
}
class Second implements Positioned {
  readonly label = "second";
  constructor(readonly list: List) {}
  pos(): number {
    return this.list.items.length;
  }
}
const all: Positioned[] = [new First(new Holder(list)), new Second(list)];
for (const p of all) console.log(p.label, p.pos());`,
    // An untyped value's members are read by name.
    "const u: any = new Holder(list);\nconsole.log(u.list.pos);",
    // A checked cast to a record of scalars and instances reads the members
    // its fields name.
    "const u: unknown = new Holder(list);\nconsole.log((u as { readonly list: { pos: number; flags?: number } }).list.pos);",
    "const u: unknown = new Holder(list);\nconsole.log((u as { list: List }).list.items.length);",
    // A record type that holds itself.
    "type Chain = { pos: number; next?: Chain; all: Chain[] };\nconst u: unknown = list;\nconsole.log((u as Chain).pos);",
    // An array method's compiled callback gets the receiver's elements.
    `const u: any = [list, new Flagged(2, [], 0)];
u.forEach((x: any) => console.log(x.pos));
console.log(u.map((x: List) => x.items.length).join(","));
console.log(u.some((x: any) => x.pos === 3), u.find((x: any) => x.pos === 2).pos);
console.log(u.filter((x: List) => x.items.length > 0).length);`,
  ]) {
    // Every class of the hierarchy is constructed, so each has a constructor.
    const result = await build(
      classes + holder + "console.log(new Flagged(4, [new Item(5)], 1).flags);\n" + use,
    );
    expect(result.messages, use).toEqual([]);
    expect(result.ok, use).toBe(true);
    expect(result.warnings, use).toEqual([]);
  }
});

test.runIf(lowRegion)("printing and JSON.stringify show the field as an array", async () => {
  const { ok, llvm } = await build(
    classes +
      holder +
      "console.log(JSON.stringify({ list }), JSON.stringify(new Holder(list)));\nconsole.log(new Holder(list));",
  );
  expect(ok).toBe(true);
  // The instance's dynamic view reads the field as an array of the elements.
  const views = llvm
    .split(/\n(?=define )/)
    .filter((f) => f.startsWith("define") && f.includes("_materialize("));
  expect(views.some((f) => f.includes("call ptr @scr_arr_view_cref("))).toBe(true);
});

test("the constructor stores the array parameter and does nothing else with it", async () => {
  const result = await build(`
class Item implements ProgramLifetime {}
class List implements ProgramLifetime {
  readonly items: InlineArray<Item>;
  readonly count: number;
  constructor(items: Item[]) {
    items.push(new Item());
    this.items = items;
    this.count = items.length;
  }
}
console.log(new List([new Item()]).count);
`);
  expect(result.ok).toBe(false);
  expect(result.codes).toContain("SC7009");
  expect(result.messages.join("\n")).toContain("besides storing it in the field");
});

test("a read of an InlineArray field is not compared by identity", async () => {
  const result = await build(`
class Item implements ProgramLifetime {}
class List implements ProgramLifetime {
  readonly items: InlineArray<Item>;
  constructor(items: readonly Item[]) {
    this.items = items;
  }
}
const items = [new Item()];
const list = new List(items);
console.log(list.items === items);
`);
  expect(result.ok).toBe(false);
  expect(result.codes).toContain("SC7009");
  expect(result.messages.join("\n")).toContain("compared by identity");
});

test("arrays a field's reads may be are not compared by identity", async () => {
  const program = (use: string) => `
class Item implements ProgramLifetime {}
class List implements ProgramLifetime {
  readonly items: InlineArray<Item>;
  constructor(items: readonly Item[]) {
    this.items = items;
  }
}
const list = new List([new Item()]);
const a = list.items;
const b = list.items;
${use}
`;
  for (const use of [
    "console.log(a === b);",
    "console.log([a].indexOf(b));",
    "console.log(new Set([a]).has(b));",
    "const seen = new Map<readonly Item[], number>();\nseen.set(a, 1);\nconsole.log(seen.get(b));",
    // Set elements from a seed.
    "console.log(new Set([a, b]).size);",
    "const all: (readonly Item[])[] = [];\nall.push(a);\nall.push(b);\nconsole.log(new Set(all).size);",
    "const entries: [readonly Item[], number][] = [[a, 1], [b, 2]];\nconsole.log(new Map(entries).size);",
    "const byId = new Map<number, readonly Item[]>([[1, a], [2, b]]);\nconsole.log(new Set(byId.values()).size);",
  ]) {
    const result = await build(program(use));
    expect(result.ok, use).toBe(false);
    expect(result.messages.join("\n"), use).toContain("is compared by identity");
  }
  // Reading the elements and the length, or a Set of the elements, compares
  // no field arrays.
  const reads = await build(
    program("console.log(a.length === b.length, a[0] === b[0], new Set(a).size);"),
  );
  expect(reads.ok).toBe(true);
});

test("InlineArray is checked on instance fields only", async () => {
  const result = await build(`
class Item implements ProgramLifetime {}
function count(items: InlineArray<Item>): number {
  return items.length;
}
console.log(count([new Item()]));
`);
  expect(result.ok).toBe(false);
  expect(result.codes).toContain("SC7006");
});
