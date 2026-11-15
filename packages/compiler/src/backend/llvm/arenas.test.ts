import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../../index.js";

async function llvmFor(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-arenas-"));
  try {
    const entry = join(dir, "main.ts"),
      output = join(dir, "main.ll");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath: output, outputKind: "llvm" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((item) => `${item.code}: ${item.message}`).join("\n"));
    return await readFile(output, "utf8");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** One emitted function, from its definition line through the closing brace. */
function functionBody(llvm: string, name: string): string {
  return new RegExp(`^define [^\\n]*@${name}\\([^\\n]*\\n[\\s\\S]*?^}`, "m").exec(llvm)?.[0] ?? "";
}

/** The bodies of the module's arena-aware constructors. */
function arenaConstructors(llvm: string): string[] {
  return [...llvm.matchAll(/^define internal ptr @[^(]*\.r\(\)[^\n]*\n[\s\S]*?^}/gm)].map(
    (m) => m[0],
  );
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
interface Leaf {
  left: Leaf | null;
  right: Leaf | null;
}
function leaves(depth: number): Leaf {
  return depth === 0 ? { left: null, right: null } : { left: leaves(depth - 1), right: leaves(depth - 1) };
}
function size(leaf: Leaf): number {
  return leaf.left === null || leaf.right === null ? 1 : 1 + size(leaf.left) + size(leaf.right);
}
`;

test("when every arena is closed, arena-aware constructors take no dispose list", async () => {
  const llvm = await llvmFor(`${TREE}
let total = 0;
for (let d = 0; d < 4; d++) total += tree(d).count() + size(leaves(d));
console.log(total);
`);
  expect(llvm).toMatch(/@scr_arena_open\(ptr %[\w.]+, i32 1\)/);
  expect(llvm).not.toMatch(/@scr_arena_open\(ptr %[\w.]+, i32 0\)/);
  const constructors = arenaConstructors(llvm);
  expect(constructors.length).toBe(2);
  for (const body of constructors) {
    expect(body).not.toContain("ScrArena.closed");
    expect(body).not.toContain("@scr_arena_disposal");
  }
  // A record literal stores every field, and no dispose entry reads them:
  // the record's constructor does not clear the object. A class constructor
  // may leave fields unset, so the class's does.
  const record = constructors.find((body) => body.includes("@sc_rnew_"))!;
  const cls = constructors.find((body) => !body.includes("@sc_rnew_"))!;
  expect(record).not.toContain("@llvm.memset");
  expect(cls).toContain("@llvm.memset");
});

test("record literals in an arena that is not closed keep the clear their dispose entries need", async () => {
  // The items hold outside strings, so their groups are not closed.
  const llvm = await llvmFor(`
interface Item {
  label: string;
  next: Item | null;
}
function chain(labels: string[], n: number): Item {
  return n === 0 ? { label: labels[0]!, next: null } : { label: labels[n % labels.length]!, next: chain(labels, n - 1) };
}
function length(item: Item): number {
  return item.next === null ? item.label.length : item.label.length + length(item.next);
}
const labels = ["a", "bb", "ccc"];
let total = 0;
for (let round = 0; round < 4; round++) total += length(chain(labels, 10 + round));
console.log(total);
`);
  expect(llvm).toMatch(/@scr_arena_open\(ptr %[\w.]+, i32 0\)/);
  const items = arenaConstructors(llvm).filter((body) => body.includes("@sc_rnew_"));
  expect(items.length).toBe(1);
  expect(items[0]).toContain(".dispose");
  expect(items[0]).toContain("@llvm.memset");
});

test("an arena that is not closed keeps the dispose list in every arena-aware constructor", async () => {
  // The rings hold strings and outside categories, so their groups are not closed.
  const llvm = await llvmFor(`${TREE}
class Category {
  name: string;
  constructor(name: string) {
    this.name = name;
  }
}
class Member {
  next: Member | undefined = undefined;
  category: Category;
  label: string;
  constructor(category: Category, label: string) {
    this.category = category;
    this.label = label;
  }
}
function ring(categories: Category[], size: number, seed: number): Member {
  const first = new Member(categories[seed % categories.length]!, \`m\${seed}\`);
  let last = first;
  for (let i = 1; i < size; i++) {
    const member = new Member(categories[(seed + i) % categories.length]!, \`m\${seed}-\${i}\`);
    last.next = member;
    last = member;
  }
  last.next = first;
  return first;
}
const categories = [new Category("a"), new Category("b")];
let total = 0;
for (let round = 0; round < 4; round++) {
  const r = ring(categories, 30, round);
  total += r.next!.label.length + r.category.name.length + tree(round).count();
}
console.log(total);
`);
  expect(llvm).toMatch(/@scr_arena_open\(ptr %[\w.]+, i32 1\)/);
  expect(llvm).toMatch(/@scr_arena_open\(ptr %[\w.]+, i32 0\)/);
  const withFields = arenaConstructors(llvm).filter((body) => body.includes(".dispose"));
  expect(withFields.length).toBeGreaterThan(0);
  for (const body of withFields) expect(body).toContain("ScrArena.closed");
});

/** A tree class (no methods, so dispatch cannot observe it) and its builders. */
const TREE_NODES = `
class Node {
  left: Node | null;
  right: Node | null;
  constructor(left: Node | null, right: Node | null) {
    this.left = left;
    this.right = right;
  }
}
function build(depth: number): Node {
  if (depth === 0) return new Node(null, null);
  return new Node(build(depth - 1), build(depth - 1));
}
function nodes(tree: Node): number {
  if (tree.left === null || tree.right === null) return 1;
  return 1 + nodes(tree.left) + nodes(tree.right);
}
`;

test("a proven tree class's nodes are reclaimed by the group arena", async () => {
  const llvm = await llvmFor(`${TREE_NODES}
let total = 0;
for (let depth = 0; depth < 4; depth++) total += nodes(build(depth));
console.log(total);
`);
  // Sixteen bytes: two children and no count word.
  expect(llvm).toContain("%sc_o_Node = type { ptr, ptr }");
  // The drop frees every node of the subtree, so the destroy has nothing to
  // walk and nothing to free.
  expect(llvm).toContain("; destroy Node (its nodes are the arena's)");
  expect(llvm).toMatch(/@sc_release_Node_destroy\(ptr %o\)[^{]*\{[^}]*\n  ret void/);
  // Every node comes from the arena: the constructor has no heap copy to
  // fall back to, and a miss stops instead of leaking a node no release
  // could free.
  expect(llvm).toMatch(/@sc_new_Node\.r\(\)/);
  expect(llvm).toMatch(/\nmiss:\n[^}]*scr_trap/);
  expect(llvm).not.toMatch(/label %heap/);
  // Every group is closed, so no open arena caps its bytes and sends a node
  // to the heap.
  expect(llvm).toMatch(/@scr_arena_open\(ptr %[\w.]+, i32 1\)/);
  expect(llvm).not.toMatch(/@scr_arena_open\(ptr %[\w.]+, i32 0\)/);
});

test("a tree class whose group is open keeps the heap path", async () => {
  // The chain holds outside strings, so its group is open and its arena
  // caps its bytes: a node that fell back to the heap would have nothing
  // to free it. The class keeps its headerless layout, but not the arena.
  const llvm = await llvmFor(`${TREE_NODES}
interface Item {
  label: string;
  next: Item | null;
}
function chain(labels: string[], n: number): Item {
  if (n === 0) return { label: labels[0]!, next: null };
  return { label: labels[n % labels.length]!, next: chain(labels, n - 1) };
}
function length(item: Item): number {
  if (item.next === null) return item.label.length;
  return item.label.length + length(item.next);
}
const labels = ["a", "bb", "ccc"];
let total = 0;
for (let round = 0; round < 4; round++) total += length(chain(labels, 10 + round)) + nodes(build(3));
console.log(total);
`);
  expect(llvm).toContain("%sc_o_Node = type { ptr, ptr }");
  expect(llvm).toMatch(/@scr_arena_open\(ptr %[\w.]+, i32 0\)/);
  expect(llvm).not.toContain("its nodes are the arena's");
  expect(llvm).not.toMatch(/@sc_new_Node\.r\(\)/);
  // The teardown frees the segment it built, which ends with the block the
  // last node freed, so the free list takes the chain's result rather than
  // the head this iteration began with.
  const destroy = functionBody(llvm, "sc_release_Node_destroy_it");
  expect(destroy).toMatch(/^it\.done:\n {2}%sgf\.none = icmp eq ptr %it\.leaf\.h, null/m);
  expect(destroy.slice(destroy.indexOf("it.done:"))).not.toContain("%it.ha");
});

test("a one-child heap tree chains its last freed block into the segment it frees", async () => {
  // A cell holds one nullable child, so its destroy walks the subtree without
  // the worklist a two-child node needs. The string chain keeps the group
  // open, so the class keeps the heap path and the walking teardown.
  const llvm = await llvmFor(`
class Cell {
  next: Cell | null;
  constructor(next: Cell | null) {
    this.next = next;
  }
}
function cell(n: number): Cell {
  if (n === 0) return new Cell(null);
  return new Cell(cell(n - 1));
}
function cells(c: Cell): number {
  if (c.next === null) return 1;
  return 1 + cells(c.next);
}
interface Item {
  label: string;
  next: Item | null;
}
function chain(labels: string[], n: number): Item {
  if (n === 0) return { label: labels[0]!, next: null };
  return { label: labels[n % labels.length]!, next: chain(labels, n - 1) };
}
function length(item: Item): number {
  if (item.next === null) return item.label.length;
  return item.label.length + length(item.next);
}
const labels = ["a", "bb"];
let total = 0;
for (let i = 0; i < 4; i++) total += cells(cell(i + 1)) + length(chain(labels, 5 + i));
console.log(total);
`);
  // Eight bytes: one child and no count word.
  expect(llvm).toContain("%sc_o_Cell = type { ptr }");
  const destroy = functionBody(llvm, "sc_release_Cell_destroy_it");
  expect(destroy).toMatch(/^it\.done:\n {2}%sgf\.none = icmp eq ptr %it\.ch\.h, null/m);
  expect(destroy.slice(destroy.indexOf("it.done:"))).not.toContain("%it.ha");
  // The walking teardown never recurses, so the release calls it directly
  // and pays no runtime depth budget.
  const release = functionBody(llvm, "sc_release_Cell");
  expect(release).toContain("call void @sc_release_Cell_destroy(ptr %o)");
  expect(release).not.toContain("scr_rc_destroy");
});

test("a heap tree torn down one node at a time enters the runtime depth budget", async () => {
  // A node whose reference fields do not lead the struct cannot use the
  // walking teardown: its destroy releases each child through the child's
  // public release, which recurses one destructor per node. The string
  // chain keeps the group open, so the class keeps the heap path, and the
  // release has to enter the runtime's depth budget instead of recursing
  // on the native stack. An adopted tree is exempt: its destroy is empty.
  const llvm = await llvmFor(`
class Node {
  value: number;
  a: Node | null;
  b: Node | null;
  c: Node | null;
  constructor(value: number, a: Node | null, b: Node | null, c: Node | null) {
    this.value = value;
    this.a = a;
    this.b = b;
    this.c = c;
  }
}
function build(n: number): Node {
  if (n === 0) return new Node(0, null, null, null);
  return new Node(n, build(n - 1), null, null);
}
function probe(n: number): number {
  const root = build(n);
  return root.value + 1;
}
interface Item {
  label: string;
  next: Item | null;
}
function chain(labels: string[], n: number): Item {
  if (n === 0) return { label: labels[0]!, next: null };
  return { label: labels[n % labels.length]!, next: chain(labels, n - 1) };
}
function length(item: Item): number {
  if (item.next === null) return item.label.length;
  return item.label.length + length(item.next);
}
const labels = ["a", "bb"];
let total = 0;
for (let i = 0; i < 4; i++) total += length(chain(labels, 5 + i)) + probe(i + 1);
console.log(total);
`);
  // The headerless layout, on the heap: the value leads, so the class keeps
  // the recursive teardown.
  expect(llvm).toContain("%sc_o_Node = type { i32, ptr, ptr, ptr }");
  expect(llvm).toContain("@scr_arena_open(");
  expect(llvm).not.toContain("its nodes are the arena's");
  const destroy = functionBody(llvm, "sc_release_Node_destroy");
  expect(destroy).not.toContain("%it.");
  expect(destroy).toContain("call void @sc_release_Node(ptr %v0)");
  const release = functionBody(llvm, "sc_release_Node");
  expect(release).toContain("call void @scr_rc_destroy(ptr %o, ptr @sc_release_Node_destroy)");
  expect(llvm).toContain("declare void @scr_rc_destroy(ptr, ptr)");
});

test("a node a function builds inside a temporary expression keeps the counted layout", async () => {
  // `b.value = build(2).left` moves a node no local ever named. The class has
  // to keep the counted layout rather than reach the lowering, which has no
  // record of a transfer there.
  const llvm = await llvmFor(`
class Node {
  left: Node | null;
  right: Node | null;
  constructor(left: Node | null, right: Node | null) {
    this.left = left;
    this.right = right;
  }
}
function build(depth: number): Node {
  if (depth === 0) return new Node(null, null);
  return new Node(build(depth - 1), build(depth - 1));
}
class Box {
  value: unknown;
  constructor(value: unknown) {
    this.value = value;
  }
}
function probe(): number {
  const b = new Box(0);
  b.value = build(2).left;
  return 1;
}
console.log(probe());
`);
  expect(llvm).toContain("%sc_o_Node = type { i64, ptr, ptr }");
  expect(llvm).not.toContain("(no count: a tree)");
});

test("a class a method can observe keeps its count word in the arena", async () => {
  // `count()` dispatches on the class, so the node is observed: it keeps its
  // count word and the general arena path, which frees a drained node.
  const llvm = await llvmFor(`${TREE}
let total = 0;
for (let d = 0; d < 4; d++) total += tree(d).count();
console.log(total);
`);
  expect(llvm).toContain("%sc_o_Node = type { i64, ptr, ptr }");
  expect(llvm).not.toContain("its nodes are the arena's");
  const cls = arenaConstructors(llvm).find((body) => !body.includes("@sc_rnew_"))!;
  expect(cls).toContain("store i64 536870912, ptr %o");
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
`;

/** The emitted bodies of source function `name` (it and its clones) that open an arena. */
function arenaBodies(llvm: string, name: string): string[] {
  return [...llvm.matchAll(new RegExp(`^define [^\\n]*@sc_f_${name}[^\\n]*\\n[\\s\\S]*?^}`, "gm"))]
    .map((m) => m[0])
    .filter((body) => body.includes("@scr_arena_open"));
}

test("a group made from another group's members is dropped before it", async () => {
  // `notes(xs)` holds members of `parts(n)` and releases them when its arena
  // is dropped (a note's text is a string of its own, so the group is not
  // closed): the scope has to drop it first.
  const llvm = await llvmFor(`${PARTS}
interface Note { item: Part; text: string }
function notes(xs: Part[]): Note[] {
  const out: Note[] = [];
  for (const x of xs) out.push({ item: x, text: x.label + "!" });
  return out;
}
function work(n: number): string {
  const xs = parts(n);
  const ys = notes(xs);
  return ys[1]!.item.label + ys[1]!.text + String(xs.length);
}
console.log(work(5));
`);
  const bodies = arenaBodies(llvm, "work");
  expect(bodies.length).toBeGreaterThan(0);
  for (const body of bodies) {
    const opens = [...body.matchAll(/@scr_arena_open\(ptr (%t\d+),/g)].map((m) => m[1]);
    const drops = [...body.matchAll(/@scr_arena_drop\(ptr (%t\d+)\)/g)].map((m) => m[1]);
    expect(opens.length).toBe(2);
    expect(drops.slice(0, 2)).toEqual([opens[1], opens[0]]);
  }
});

test("a group whose members a cycle on the heap can hold takes no arena", async () => {
  // The two links hold each other, so the collector frees them some time
  // after `work` returned: the parts they hold must still be there.
  const llvm = await llvmFor(`${PARTS}
class Link {
  item: Part;
  next: Link | null;
  constructor(item: Part) {
    this.item = item;
    this.next = null;
  }
}
function ring(xs: Part[]): Link {
  const a = new Link(xs[0]!);
  const b = new Link(xs[1]!);
  a.next = b;
  b.next = a;
  return a;
}
function work(n: number): string {
  const xs = parts(n);
  const r = ring(xs);
  return r.next!.item.label + String(xs.length);
}
console.log(work(5));
`);
  expect(arenaBodies(llvm, "work")).toEqual([]);
});

const TIE = `${PARTS}
class Link {
  items: Part[] | null = null;
  next: Link | null = null;
}
function tie(xs: Part[], cb: (x: Part[]) => Link): Link {
  return cb(xs);
}
`;

test("a group whose members a callback can tie into a cycle takes no arena", async () => {
  // `tie` allocates nothing itself: the ring is made by the callback it
  // calls, and the collector frees it some time after `work` returned.
  const llvm = await llvmFor(`${TIE}
function work(n: number): string {
  const xs = parts(n);
  const r = tie(xs, (x) => {
    const a = new Link();
    a.next = a;
    a.items = x;
    return a;
  });
  return r.items![1]!.label + String(xs.length);
}
console.log(work(5));
`);
  expect(arenaBodies(llvm, "work")).toEqual([]);
});

test("a call region that reaches a callback's cycle on the heap takes no arena", async () => {
  // The call of `tie` runs with the arena suspended, so the ring is a heap
  // object that holds the region's list.
  const llvm = await llvmFor(`${TIE}
function count(n: number): number {
  const xs = parts(n);
  let s = xs.length;
  for (let i = 0; i < 2; i++) {
    s += tie(xs, (x) => {
      const a = new Link();
      a.next = a;
      a.items = x;
      return a;
    }).items!.length;
  }
  return s;
}
function work(rounds: number): number {
  let s = 0;
  for (let r = 0; r < rounds; r++) s += count(5 + r);
  return s;
}
console.log(work(5));
`);
  expect(arenaBodies(llvm, "work")).toEqual([]);
  expect(arenaBodies(llvm, "count")).toEqual([]);
});
