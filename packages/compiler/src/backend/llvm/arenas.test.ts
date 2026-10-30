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
