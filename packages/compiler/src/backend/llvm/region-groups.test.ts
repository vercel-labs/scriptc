import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../../index.js";
import type { IrExpr, IrModule, IrType } from "../../ir/ir.js";
import { analyzeClosedGroups, analyzeRegionGroups } from "./region-groups.js";
import { children, type Node } from "./region-ir.js";

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
