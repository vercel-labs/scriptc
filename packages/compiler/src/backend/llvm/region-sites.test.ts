import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../../index.js";
import type { IrExpr, IrModule } from "../../ir/ir.js";
import { analyzeRegionGroups } from "./region-groups.js";
import { children, type Node } from "./region-ir.js";
import { planRegionSites } from "./region-sites.js";

async function moduleFor(source: string): Promise<IrModule> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-region-sites-"));
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

/** The nodes in function `fn` matching `pick`, in order. */
function nodesIn(mod: IrModule, fn: string, pick: (e: IrExpr) => boolean): IrExpr[] {
  const out: IrExpr[] = [];
  const visit = (node: Node): void => {
    if (pick(node as IrExpr)) out.push(node as IrExpr);
    const kids: Node[] = [];
    children(node, kids);
    for (const k of kids) visit(k);
  };
  for (const s of mod.functions.find((f) => f.name === fn)!.body) visit(s);
  return out;
}

const calls = (callee: string) => (e: IrExpr) => e.kind === "call" && e.callee === callee;
const records = (e: IrExpr) => e.kind === "recordLit";

function plan(mod: IrModule) {
  const groups = analyzeRegionGroups(mod);
  const sites = planRegionSites(mod, groups);
  return { groups, sites };
}

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

test("a recursive builder's root takes an arena for every node", async () => {
  const mod = await moduleFor(`${TREE}
let total = 0;
for (let d = 0; d < 4; d++) total += tree(d).count();
console.log(total);
`);
  const { groups, sites } = plan(mod);
  const roots = nodesIn(mod, "%init.0", calls("tree")).filter((c) => groups.roots.has(c));
  expect(roots.length).toBe(1);
  for (const n of nodesIn(mod, "tree", (e) => e.kind === "new"))
    expect(sites.arenaSites.has(n)).toBe(true);
  for (const c of nodesIn(mod, "tree", calls("tree"))) expect(sites.arenaSites.has(c)).toBe(true);
});

test("a builder of a bounded number of objects is no root", async () => {
  const mod = await moduleFor(`
interface V { x: number; y: number }
function add(a: V, b: V): V {
  return { x: a.x + b.x, y: a.y + b.y };
}
let at: V = { x: 0, y: 0 };
let sum = 0;
for (let i = 0; i < 10; i++) {
  const step = add(at, { x: i, y: 1 });
  sum += step.x;
}
console.log(sum, at.y);
`);
  const { groups } = plan(mod);
  expect(groups.roots.size).toBe(0);
  expect(groups.calls.size).toBe(0);
  expect(groups.reachable.size).toBe(0);
});

test("a list a builder appends to in a loop takes the arena", async () => {
  const mod = await moduleFor(`
interface Row { id: number; score: number }
function rows(n: number): Row[] {
  const out: Row[] = [];
  for (let i = 0; i < n; i++) {
    const row: Row = { id: i, score: i * 2 };
    out.push(row);
  }
  return out;
}
let total = 0;
for (let k = 0; k < 3; k++) total += rows(10 + k).length;
console.log(total);
`);
  const { groups, sites } = plan(mod);
  expect(nodesIn(mod, "%init.0", calls("rows")).some((c) => groups.roots.has(c))).toBe(true);
  const [row] = nodesIn(mod, "rows", records);
  expect(sites.arenaSites.has(row!)).toBe(true);
  const [out] = nodesIn(mod, "rows", (e) => e.kind === "arrayLit");
  expect(sites.arenaSites.has(out!)).toBe(true);
});

test("values that replace elements or die in the loop take the heap", async () => {
  const mod = await moduleFor(`
interface V { x: number; y: number }
function vec(x: number, y: number): V {
  return { x, y };
}
function add(a: V, b: V): V {
  return { x: a.x + b.x, y: a.y + b.y };
}
function simulate(n: number, steps: number): number {
  const points: V[] = [];
  for (let i = 0; i < n; i++) points.push(vec(i, i));
  for (let s = 0; s < steps; s++)
    for (let i = 0; i < n; i++) points[i] = add(points[i]!, vec(0, 1));
  let sum = 0;
  for (const p of points) sum += p.x + p.y;
  return sum;
}
console.log(simulate(100, 10));
`);
  const { groups, sites } = plan(mod);
  // The list's elements are replaced, so it keeps nothing: no group grows.
  expect(groups.calls.size).toBe(0);
  expect(groups.roots.size).toBe(0);
  expect(sites.arenaSites.size).toBe(0);
});

test("a value reassigned in a loop and returned takes the heap", async () => {
  const mod = await moduleFor(`
class C {
  re: number;
  im: number;
  constructor(re: number, im: number) {
    this.re = re;
    this.im = im;
  }
  times(o: C): C {
    return new C(this.re * o.re - this.im * o.im, this.re * o.im + this.im * o.re);
  }
}
function power(c: C, n: number): C {
  let z = new C(1, 0);
  for (let i = 0; i < n; i++) z = z.times(c);
  return z;
}
let s = 0;
for (let k = 0; k < 5; k++) s += power(new C(0.5, 0.5), k).re;
console.log(s);
`);
  const { groups } = plan(mod);
  expect(nodesIn(mod, "%init.0", calls("power")).some((c) => groups.roots.has(c))).toBe(false);
});

test("calls in an arena-aware function whose values die take the heap", async () => {
  const mod = await moduleFor(`
interface P { x: number; next: P | null }
function weight(p: P): number {
  return p.x * 2;
}
function probe(x: number): P {
  return { x, next: null };
}
function chain(n: number): P {
  let head: P = { x: 0, next: null };
  const first = head;
  for (let i = 1; i < n; i++) {
    const node: P = { x: weight(probe(i)), next: null };
    head.next = node;
    head = node;
  }
  return first;
}
let total = 0;
for (let k = 0; k < 3; k++) total += chain(5).x;
console.log(total);
`);
  const { groups, sites } = plan(mod);
  expect(nodesIn(mod, "%init.0", calls("chain")).some((c) => groups.roots.has(c))).toBe(true);
  const [probe] = nodesIn(mod, "chain", calls("probe"));
  expect(sites.arenaSites.has(probe!)).toBe(false);
  expect(sites.heapCalls.has(probe!)).toBe(true);
  for (const node of nodesIn(mod, "chain", records)) expect(sites.arenaSites.has(node)).toBe(true);
});

test("a root assigned in a loop to a local declared outside it is no root", async () => {
  const mod = await moduleFor(`${TREE}
function run(n: number): number {
  let t = tree(1);
  let total = t.count();
  for (let d = 0; d < n; d++) {
    t = tree(d);
    total += t.count();
  }
  return total;
}
console.log(run(6));
`);
  const { groups } = plan(mod);
  const [first, inLoop] = nodesIn(mod, "run", calls("tree"));
  expect(groups.roots.has(first!)).toBe(true);
  expect(groups.roots.has(inLoop!)).toBe(false);
});

const PARTS = `
class Part {
  id: number;
  label: string;
  constructor(id: number, label: string) {
    this.id = id;
    this.label = label;
  }
}
function parts(n: number): Part[] {
  const out: Part[] = [];
  for (let i = 0; i < n; i++) out.push(new Part(i, "part" + String(i * 3)));
  return out;
}
function firstOf(xs: Part[]): Part[] {
  const out: Part[] = [];
  if (xs.length > 0) out.push(xs[0]!);
  return out;
}
`;

test("a call that keeps a root's members in its result runs with the arena suspended", async () => {
  const mod = await moduleFor(`${PARTS}
function work(n: number): string {
  const xs = parts(n);
  const ys = firstOf(xs);
  return String(ys.length) + ys[0]!.label;
}
console.log(work(5));
`);
  const { groups, sites } = plan(mod);
  const [root] = nodesIn(mod, "work", calls("parts"));
  const [holder] = nodesIn(mod, "work", calls("firstOf"));
  expect(groups.roots.has(root!)).toBe(true);
  // The holder would be an object of the arena around `work(5)`, which is
  // dropped after the root's.
  expect(groups.roots.has(holder!)).toBe(false);
  expect([...groups.holders(root!)]).toEqual([holder]);
  expect(sites.heldCalls.has(holder!)).toBe(true);
  expect(sites.heapCalls.has(holder!)).toBe(true);
  expect(sites.arenaSites.has(holder!)).toBe(false);
});

test("the holder of a root used in place is suspended around the root", async () => {
  const mod = await moduleFor(`${PARTS}
function work(n: number): string {
  const ys = firstOf(parts(n));
  return String(ys.length) + ys[0]!.label;
}
console.log(work(5));
`);
  const { groups, sites } = plan(mod);
  const [root] = nodesIn(mod, "work", calls("parts"));
  const [holder] = nodesIn(mod, "work", calls("firstOf"));
  expect(groups.roots.has(root!)).toBe(true);
  expect(sites.heldCalls.has(holder!)).toBe(true);
});

test("a holder that opens an arena of its own keeps it", async () => {
  const mod = await moduleFor(`${PARTS}
interface Slot { item: Part; rank: number }
function wrapAll(xs: Part[]): Slot[] {
  const out: Slot[] = [];
  for (const x of xs) out.push({ item: x, rank: x.id * 2 });
  return out;
}
function work(n: number): string {
  const xs = parts(n);
  const ys = wrapAll(xs);
  return ys[1]!.item.label + String(ys.length) + String(xs.length);
}
console.log(work(5));
`);
  const { groups, sites } = plan(mod);
  const [root] = nodesIn(mod, "work", calls("parts"));
  const [holder] = nodesIn(mod, "work", calls("wrapAll"));
  expect(groups.roots.has(root!)).toBe(true);
  expect(groups.roots.has(holder!)).toBe(true);
  expect(groups.holders(root!).has(holder!)).toBe(true);
  expect(sites.heldCalls.size).toBe(0);
});

test("a call that only reads a root's value holds nothing", async () => {
  const mod = await moduleFor(`${PARTS}
function widest(xs: Part[]): number {
  let best = 0;
  for (const x of xs) if (x.label.length > best) best = x.label.length;
  return best;
}
function work(n: number): string {
  const xs = parts(n);
  return String(widest(xs)) + xs[0]!.label;
}
console.log(work(5));
`);
  const { groups, sites } = plan(mod);
  const [root] = nodesIn(mod, "work", calls("parts"));
  expect(groups.roots.has(root!)).toBe(true);
  expect(groups.holders(root!).size).toBe(0);
  expect(sites.heldCalls.size).toBe(0);
});

test("a holder is suspended in a function that runs in no arena too", async () => {
  // `work` keeps what it allocates (the journal entry), so no caller's arena
  // surrounds it; the arena open at the holder is `build`'s, whose value
  // outlives the statement that drops `parts(n)`.
  const mod = await moduleFor(`${PARTS}
const journal: number[][] = [];
function build(k: number): Part[] {
  const out: Part[] = [];
  for (let i = 0; i < k; i++) out.push(new Part(i, "built" + String(i)));
  return out;
}
function work(n: number): string {
  journal.push([n]);
  const w = build(firstOf(parts(n)).length + 2);
  return w[1]!.label + String(journal.length);
}
console.log(work(5));
`);
  const { groups, sites } = plan(mod);
  const [root] = nodesIn(mod, "work", calls("parts"));
  const [holder] = nodesIn(mod, "work", calls("firstOf"));
  expect(groups.reachable.has("work")).toBe(false);
  expect(groups.roots.has(root!)).toBe(true);
  expect(sites.heldCalls.has(holder!)).toBe(true);
});
