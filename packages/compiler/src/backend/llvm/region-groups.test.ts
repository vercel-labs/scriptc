import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../../index.js";
import type { IrExpr, IrModule, IrType } from "../../ir/ir.js";
import { analyzeClosedGroups, analyzeRegionGroups, SOURCE_KINDS } from "./region-groups.js";
import { ALLOCATIONS, children, type Node } from "./region-ir.js";

async function moduleFor(source: string): Promise<IrModule> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-region-groups-"));
  try {
    const entry = join(dir, "main.ts"),
      output = join(dir, "main.ir.json");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath: output, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((item) => `${item.code}: ${item.message}`).join("\n"));
    return deserializeModule(await readFile(output, "utf8"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The calls of `callee` in the module, in order. */
function callsOf(mod: IrModule, callee: string): IrExpr[] {
  const out: IrExpr[] = [];
  const visit = (node: Node): void => {
    if (node.kind === "call" && node.callee === callee) out.push(node);
    const kids: Node[] = [];
    children(node, kids);
    for (const k of kids) visit(k);
  };
  for (const fn of mod.functions) for (const s of fn.body) visit(s);
  return out;
}

// Every object and record is an arena type here, and every union a nullable
// pointer to one (the emitter decides both from layouts).
const everyObject = (t: IrType): boolean =>
  t.kind === "object" || t.kind === "record" || t.kind === "union";

const TREE = `
class Node {
  left: Node | null;
  right: Node | null;
  constructor(left: Node | null, right: Node | null) {
    this.left = left;
    this.right = right;
  }
  count(): number {
    return 1 + (this.left === null ? 0 : this.left.count()) + (this.right === null ? 0 : this.right.count());
  }
}
function tree(depth: number): Node {
  return depth === 0 ? new Node(null, null) : new Node(tree(depth - 1), tree(depth - 1));
}
`;

test("a builder whose result its caller only reads is a closed root", async () => {
  const mod = await moduleFor(`${TREE}
let total = 0;
for (let d = 0; d < 4; d++) total += tree(d).count();
console.log(total);
`);
  const groups = analyzeRegionGroups(mod);
  expect(groups.fresh.has("tree")).toBe(true);
  const [root] = callsOf(mod, "tree").filter((c) => groups.roots.has(c));
  expect(root).toBeDefined();
  expect(groups.drops.get(root!)).toBeNull();
  expect(groups.reachable.has("tree")).toBe(true);
  expect(analyzeClosedGroups(mod, groups, everyObject).has(root!)).toBe(true);
});

test("a root in an async function's statement is dropped at that statement", async () => {
  const mod = await moduleFor(`${TREE}
let total = 0;
async function count(): Promise<void> {
  await Promise.resolve();
  total += tree(4).count();
}
await count();
console.log(total);
`);
  const groups = analyzeRegionGroups(mod);
  const [root] = callsOf(mod, "tree").filter((c) => groups.roots.has(c));
  expect(root).toBeDefined();
  expect(groups.drops.get(root!)).toBeNull();
});

test("a root whose statement awaits is no root", async () => {
  const mod = await moduleFor(`${TREE}
let total = 0;
async function count(): Promise<void> {
  total += tree(4).count() + (await Promise.resolve(0));
}
await count();
console.log(total);
`);
  const groups = analyzeRegionGroups(mod);
  expect(callsOf(mod, "tree").some((c) => groups.roots.has(c))).toBe(false);
});

test("a value bound across an await in an async function is no root", async () => {
  const mod = await moduleFor(`${TREE}
let total = 0;
async function count(): Promise<void> {
  const t = tree(4);
  await Promise.resolve();
  total += t.count();
}
await count();
console.log(total);
`);
  const groups = analyzeRegionGroups(mod);
  expect(callsOf(mod, "tree").some((c) => groups.roots.has(c))).toBe(false);
});

test("a root in a generator's statement is dropped at that statement", async () => {
  const mod = await moduleFor(`${TREE}
let total = 0;
function* walk(): Generator<number> {
  total += tree(4).count();
  yield total;
}
console.log([...walk()][0]);
`);
  const groups = analyzeRegionGroups(mod);
  const root = callsOf(mod, "tree").find((c) => groups.roots.has(c));
  expect(root).toBeDefined();
  expect(groups.drops.get(root!)).toBeNull();
});

test("a root whose statement yields is no root", async () => {
  const mod = await moduleFor(`${TREE}
let total = 0;
function* walk(): Generator<number> {
  total += tree(4).count() + (yield 0);
  yield total;
}
const it = walk();
console.log(it.next(0).value, it.next(0).value);
`);
  const groups = analyzeRegionGroups(mod);
  expect(callsOf(mod, "tree").some((c) => groups.roots.has(c))).toBe(false);
});

test("a grouped construction whose operand yields is no root", async () => {
  const mod = await moduleFor(`${TREE}
function* walk(): Generator<number> {
  yield new Node(null, yield 0).count();
}
const it = walk();
console.log(it.next(0).value, it.next(null).value);
`);
  const groups = analyzeRegionGroups(mod);
  expect(groups.roots.size).toBe(0);
});

test("a result kept past its caller's frame is no root", async () => {
  const mod = await moduleFor(`${TREE}
const kept: Node[] = [];
for (let d = 0; d < 4; d++) kept.push(tree(d));
console.log(kept.length);
`);
  const groups = analyzeRegionGroups(mod);
  expect(callsOf(mod, "tree").some((c) => groups.roots.has(c))).toBe(false);
});

test("a function that stores what it allocates in a global is not leak-free", async () => {
  const mod = await moduleFor(`
interface P { x: number }
const seen: P[] = [];
function note(x: number): void {
  seen.push({ x });
}
function sum(n: number): number {
  let s = 0;
  for (let i = 0; i < n; i++) {
    const p = { x: i };
    s += p.x;
  }
  return s;
}
note(1);
console.log(sum(3), seen.length);
`);
  const groups = analyzeRegionGroups(mod);
  expect(groups.leakFree.has("note")).toBe(false);
  expect(callsOf(mod, "note").some((c) => groups.calls.has(c))).toBe(false);
  expect(groups.leakFree.has("sum")).toBe(true);
});

test("a function that keeps a virtual call's result past its frame is not leak-free", async () => {
  const mod = await moduleFor(`
class Item {
  label: string;
  constructor(label: string) {
    this.label = label;
  }
}
class Maker {
  list(n: number): Item[] {
    const out: Item[] = [];
    for (let i = 0; i < n; i++) out.push(new Item("a" + i));
    return out;
  }
}
class OtherMaker extends Maker {
  override list(n: number): Item[] {
    const out: Item[] = [];
    for (let i = 0; i < n; i++) out.push(new Item("b" + i));
    return out;
  }
}
class Holder {
  items: Item[] = [];
}
function keepsElement(m: Maker, h: Holder, n: number): number {
  const all = m.list(n);
  for (const it of all) if (it.label.endsWith("3")) h.items.push(it);
  return all.length;
}
function borrows(m: Maker, n: number): number {
  const all = m.list(n);
  let s = 0;
  for (const it of all) s += it.label.length;
  return s;
}
const makers: Maker[] = [new Maker(), new OtherMaker()];
const holder = new Holder();
let total = 0;
for (const m of makers) total += keepsElement(m, holder, 14) + borrows(m, 14);
console.log(total, holder.items.length);
`);
  const groups = analyzeRegionGroups(mod);
  // The list is one of the group's objects wherever a target is fresh, so
  // the function that receives it answers for where its elements go.
  expect(groups.leakFree.has("keepsElement")).toBe(false);
  expect(callsOf(mod, "keepsElement").some((c) => groups.calls.has(c))).toBe(false);
  // Borrowing the result keeps the call region.
  expect(groups.leakFree.has("borrows")).toBe(true);
  expect(callsOf(mod, "borrows").every((c) => groups.calls.has(c))).toBe(true);
});

test("a leak-free call that returns no reference is a call region", async () => {
  const mod = await moduleFor(`
interface V { x: number; y: number }
function add(a: V, b: V): V {
  return { x: a.x + b.x, y: a.y + b.y };
}
function walk(n: number): number {
  let at: V = { x: 0, y: 0 };
  for (let i = 0; i < n; i++) at = add(at, { x: i, y: 1 });
  return at.x + at.y;
}
console.log(walk(10));
`);
  const groups = analyzeRegionGroups(mod);
  const [region] = callsOf(mod, "walk");
  expect(groups.calls.has(region!)).toBe(true);
});

test("a graph that holds strings or outside objects is not closed", async () => {
  const mod = await moduleFor(`
class Tag {
  name: string;
  constructor(name: string) {
    this.name = name;
  }
}
class Box {
  tag: Tag;
  owner: Tag | null;
  constructor(tag: Tag, owner: Tag | null) {
    this.tag = tag;
    this.owner = owner;
  }
}
const shared = new Tag("shared");
function labelled(n: number): Box {
  let box = new Box(new Tag("t" + n), null);
  for (let i = 0; i < n; i++) box = new Box(new Tag("t" + i), null);
  return box;
}
function owned(n: number): Box {
  let box = new Box(new Tag("x"), shared);
  for (let i = 0; i < n; i++) box = new Box(new Tag("x"), shared);
  return box;
}
let n = 0;
for (let i = 0; i < 3; i++) n += labelled(i).tag.name.length + owned(i).tag.name.length;
console.log(n);
`);
  const groups = analyzeRegionGroups(mod);
  const closed = analyzeClosedGroups(mod, groups, everyObject);
  const labelled = callsOf(mod, "labelled").filter((c) => groups.roots.has(c));
  const owned = callsOf(mod, "owned").filter((c) => groups.roots.has(c));
  expect(labelled.length).toBe(1);
  expect(owned.length).toBe(1);
  expect(closed.has(labelled[0]!)).toBe(false);
  expect(closed.has(owned[0]!)).toBe(false);
});

test("a root bound in a loop body is dropped with that body's local", async () => {
  const mod = await moduleFor(`${TREE}
function run(n: number): number {
  let total = 0;
  for (let i = 0; i < n; i++) {
    const t = tree(i % 4);
    total += t.count();
  }
  return total;
}
console.log(run(10));
`);
  const groups = analyzeRegionGroups(mod);
  const [root] = callsOf(mod, "tree").filter((c) => groups.roots.has(c));
  const run = mod.functions.find((f) => f.name === "run")!;
  const local = groups.drops.get(root!);
  expect(run.locals.find((l) => l.id === local)?.name).toBe("t");
});

test("a root whose value a callee writes into is not closed", async () => {
  const mod = await moduleFor(`${TREE}
function graft(n: Node, extra: Node): void {
  n.left = extra;
}
const spare = new Node(null, null);
let total = 0;
for (let d = 0; d < 3; d++) {
  const t = tree(d);
  graft(t, spare);
  total += t.count();
}
console.log(total);
`);
  const groups = analyzeRegionGroups(mod);
  const closed = analyzeClosedGroups(mod, groups, everyObject);
  for (const root of callsOf(mod, "tree").filter((c) => groups.roots.has(c)))
    expect(closed.has(root)).toBe(false);
});

/** The constructions of `className` in the module, in order. */
function newsOf(mod: IrModule, className: string): IrExpr[] {
  const out: IrExpr[] = [];
  const visit = (node: Node): void => {
    if (node.kind === "new" && node.className === className) out.push(node);
    const kids: Node[] = [];
    children(node, kids);
    for (const k of kids) visit(k);
  };
  for (const fn of mod.functions) for (const s of fn.body) visit(s);
  return out;
}

const ROWS = `
interface Row { n: number }
class Slot {
  held: Row[];
  constructor(held: Row[]) {
    this.held = held;
  }
}
function rows(k: number): Row[] {
  const made: Row[] = [];
  for (let i = 0; i < 4; i++) made.push({ n: k + i });
  return made;
}
`;

test("a value used in place whose reads stay in the statement is a root", async () => {
  const mod = await moduleFor(`${ROWS}
function run(): number {
  return rows(1)[2]!.n + new Slot(rows(3)).held.length;
}
console.log(run());
`);
  const groups = analyzeRegionGroups(mod);
  expect(callsOf(mod, "rows").some((c) => groups.roots.has(c))).toBe(true);
  expect(newsOf(mod, "Slot").every((c) => groups.roots.has(c))).toBe(true);
});

test("a reference read out of a value used in place and kept past the statement makes it no root", async () => {
  const mod = await moduleFor(`${ROWS}
function sameSlot(slot: Slot): Slot {
  return slot;
}
let saved: Row[] = [];
function keep(list: Row[]): number {
  saved = list;
  return list.length;
}
function bound(): number {
  const first = rows(1)[2]!;
  const held = new Slot(rows(3)).held;
  const through = sameSlot(new Slot(rows(5))).held;
  return first.n + held.length + through.length;
}
function returned(): Row[] {
  return new Slot(rows(7)).held;
}
function passed(): number {
  return keep(new Slot(rows(9)).held);
}
console.log(bound(), returned().length, passed(), saved.length);
`);
  const groups = analyzeRegionGroups(mod);
  expect(callsOf(mod, "rows").some((c) => groups.roots.has(c))).toBe(false);
  expect(newsOf(mod, "Slot").some((c) => groups.roots.has(c))).toBe(false);
});

test("a function that stores a reference read out of what it allocates is not leak-free", async () => {
  const mod = await moduleFor(`${ROWS}
let saved: Row[] = [];
let last: Row = { n: 0 };
function stash(): void {
  saved = new Slot(rows(1)).held;
}
function stashElement(): void {
  last = rows(2)[1]!;
}
function count(): number {
  return new Slot(rows(3)).held.length;
}
stash();
stashElement();
console.log(saved.length, last.n, count());
`);
  const groups = analyzeRegionGroups(mod);
  expect(groups.leakFree.has("stash")).toBe(false);
  expect(groups.leakFree.has("stashElement")).toBe(false);
  expect(callsOf(mod, "stash").some((c) => groups.calls.has(c))).toBe(false);
  expect(callsOf(mod, "stashElement").some((c) => groups.calls.has(c))).toBe(false);
  expect(groups.leakFree.has("count")).toBe(true);
});

test("an element removed from a root's array, or copied out of its collection, is read out of it", async () => {
  const mod = await moduleFor(`${ROWS}
function byN(k: number): Map<number, Row> {
  const m = new Map<number, Row>();
  for (let i = 0; i < 4; i++) m.set(i, { n: k + i });
  return m;
}
let last: Row = { n: 0 };
let removed: Row[] = [];
let copy = new Map<number, Row>();
function popped(): number {
  const list = rows(1);
  last = list.pop()!;
  return list.length;
}
function shifted(): number {
  const list = rows(2);
  last = list.shift()!;
  return list.length;
}
function spliced(): number {
  const list = rows(3);
  removed = list.splice(0, 2, { n: 9 });
  return list.length;
}
function copied(): number {
  const m = byN(4);
  copy = new Map(m);
  return m.size;
}
function counted(): number {
  const list = rows(5);
  const top = list.pop()!;
  return list.length + top.n;
}
console.log(popped(), shifted(), spliced(), copied(), counted(), last.n, removed.length, copy.size);
`);
  const groups = analyzeRegionGroups(mod);
  const rootIn = (name: string): boolean => {
    const fn = mod.functions.find((f) => f.name === name)!;
    return [...groups.roots].some((root) => groups.rootFunction.get(root) === fn);
  };
  expect(rootIn("popped")).toBe(false);
  expect(rootIn("shifted")).toBe(false);
  expect(rootIn("spliced")).toBe(false);
  expect(rootIn("copied")).toBe(false);
  expect(rootIn("counted")).toBe(true);
});

test("a list that takes a reference where it is made is no root, and one a splice inserts into is not closed", async () => {
  const mod = await moduleFor(`${ROWS}
function pushed(): number {
  return rows(1).push({ n: 9 });
}
function spliced(): number {
  return rows(2).splice(1, 2, { n: 9 }).length;
}
function local(): number {
  const list = rows(3);
  const cut = list.splice(1, 2, { n: 9 });
  return list.length + cut.length;
}
console.log(pushed(), spliced(), local());
`);
  const groups = analyzeRegionGroups(mod);
  const rootsIn = (name: string): IrExpr[] => {
    const fn = mod.functions.find((f) => f.name === name)!;
    return [...groups.roots].filter((root) => groups.rootFunction.get(root) === fn) as IrExpr[];
  };
  expect(rootsIn("pushed")).toHaveLength(0);
  expect(rootsIn("spliced")).toHaveLength(0);
  const closed = analyzeClosedGroups(mod, groups, everyObject);
  const roots = rootsIn("local");
  expect(roots.length).toBeGreaterThan(0);
  for (const root of roots) expect(closed.has(root)).toBe(false);
});

const ITEMS = `
class Item {
  label: string;
  constructor(label: string) {
    this.label = label;
  }
}
const saved: Item[] = [];
function own(n: number): Item[] {
  const mine: Item[] = [];
  for (let i = 0; i < n; i++) mine.push(new Item("own" + i));
  return mine;
}
function counts(n: number): number {
  const mine = own(n);
  return mine.length;
}
`;

test("a function that resumes a generator is not leak-free", async () => {
  const mod = await moduleFor(`${ITEMS}
function* produce(n: number): Generator<Item, void, undefined> {
  for (let i = 0; i < n; i++) {
    const it = new Item("g" + i);
    if (i % 2 === 0) saved.push(it);
    yield it;
  }
}
function drains(g: Generator<Item, void, undefined>, n: number): number {
  const mine = own(n);
  let c = 0;
  for (const it of g) c += it.label.length;
  return c + mine.length;
}
function steps(g: Generator<Item, void, undefined>, n: number): number {
  const mine = own(n);
  const first = g.next();
  return mine.length + (first.done === true ? 0 : 1);
}
let total = 0;
for (let r = 0; r < 3; r++) {
  const g = produce(5);
  total += drains(g, 5);
  const h = produce(5);
  total += steps(h, 5);
  total += counts(5);
}
console.log(total, saved.length);
`);
  const groups = analyzeRegionGroups(mod);
  // The generator's body runs inside the resumption and keeps what it
  // allocates in a module array: the function that drives it opens no arena.
  for (const name of ["drains", "steps"]) {
    expect(groups.leakFree.has(name)).toBe(false);
    expect(callsOf(mod, name).some((c) => groups.calls.has(c))).toBe(false);
  }
  // The same function without the generator keeps its call region.
  expect(groups.leakFree.has("counts")).toBe(true);
  expect(callsOf(mod, "counts").every((c) => groups.calls.has(c))).toBe(true);
});

test("a function that calls into the library where it can run program code is not leak-free", async () => {
  const mod = await moduleFor(`import { EventEmitter } from "node:events";
${ITEMS}
const em = new EventEmitter();
em.on("item", (i: number) => {
  saved.push(new Item("em" + i));
});
function emits(e: EventEmitter, n: number): number {
  const mine = own(n);
  e.emit("item", n);
  return mine.length;
}
function measures(n: number): number {
  const mine = own(n);
  return mine.length + Math.floor(n / 2) + String(n).length + "abc".indexOf("c");
}
let total = 0;
for (let r = 0; r < 3; r++) {
  total += emits(em, 5);
  total += measures(5);
}
console.log(total, saved.length);
`);
  const groups = analyzeRegionGroups(mod);
  // The listener runs inside `emit` and keeps what it allocates in a
  // module array: the emitting function opens no arena around it.
  expect(groups.leakFree.has("emits")).toBe(false);
  expect(callsOf(mod, "emits").some((c) => groups.calls.has(c))).toBe(false);
  // Library calls that cannot run program code keep the call region.
  expect(groups.leakFree.has("measures")).toBe(true);
  expect(callsOf(mod, "measures").every((c) => groups.calls.has(c))).toBe(true);
});

test("operations proven unable to run program code keep the call region", async () => {
  const mod = await moduleFor(`${ITEMS}
const shared: string[] = ["a", "b"];
function joinsOwn(n: number): number {
  const mine = own(n);
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push("w" + i);
  return mine.length + out.join(" ").length;
}
function joinsShared(n: number): number {
  const mine = own(n);
  return mine.length + shared.join(" ").length;
}
function joinsHanded(n: number, parts: string[]): number {
  const mine = own(n);
  return mine.length + parts.join(" ").length;
}
function joinsAliased(n: number): number {
  const mine = own(n);
  const out: string[] = [];
  const alias = out;
  alias.push("x");
  return mine.length + out.join(" ").length;
}
function joinsCaptured(n: number): number {
  const mine = own(n);
  const out: string[] = [];
  const add = (s: string): void => {
    out.push(s);
  };
  add("x");
  return mine.length + out.join(" ").length;
}
const tally: Record<string, number> = {};
tally["k" + shared.length] = 1;
const sizes: Record<string, { size: number }> = {};
sizes["s" + shared.length] = { size: 2 };
let total = 0;
for (let r = 0; r < 3; r++) {
  total += joinsOwn(5) + joinsShared(5) + joinsHanded(5, shared) + joinsAliased(5) + joinsCaptured(5);
  for (const [key, v] of Object.entries(tally)) total += key.length + v;
  for (const [key, v] of Object.entries(sizes)) total += key.length + v.size;
}
console.log(total, saved.length);
`);
  const groups = analyzeRegionGroups(mod);
  // An array only this function can reach holds no foreign element, so
  // joining it converts nothing through program code.
  expect(groups.leakFree.has("joinsOwn")).toBe(true);
  expect(callsOf(mod, "joinsOwn").every((c) => groups.calls.has(c))).toBe(true);
  // A string array from anywhere else, or one with a second reference, may
  // hold an element a dynamic view wrote: its join can run a \`toString\`.
  for (const name of ["joinsShared", "joinsHanded", "joinsAliased", "joinsCaptured"]) {
    expect(groups.leakFree.has(name)).toBe(false);
    expect(callsOf(mod, name).some((c) => groups.calls.has(c))).toBe(false);
  }
  // \`Object.entries\` of a dictionary reads the key snapshot and the stored
  // values, numbers or references: map lookups and retains only.
  const entries = mod.functions.filter((fn) => fn.name.startsWith("%obj.entries"));
  expect(entries.length).toBe(2);
  for (const fn of entries) expect(groups.leakFree.has(fn.name)).toBe(true);
});

test("the source table names the allocation kinds", () => {
  const allocations = Object.entries(SOURCE_KINDS)
    .filter(([, how]) => how === "allocation")
    .map(([kind]) => kind);
  expect(allocations.sort()).toEqual([...ALLOCATIONS].sort());
});
