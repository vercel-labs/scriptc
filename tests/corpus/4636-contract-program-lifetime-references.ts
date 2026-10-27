import type { ProgramLifetime } from "@scriptc/types";

// ProgramLifetime classes that refer to each other through fields: plain,
// optional (undefined) and nullable (null) references, chains and cycles,
// references inherited from a base class and added by subclasses, beside
// fields of every other kind. Reads, writes, compound and logical
// assignment, optional chaining, identity, Map and Set keys, closures,
// inspection, JSON and unknown values see the same objects.

abstract class Item implements ProgramLifetime {
  readonly id: number;
  next: Item | undefined = undefined;
  owner: Group | null = null;
  label: string;
  constructor(id: number, label: string) {
    this.id = id;
    this.label = label;
  }
  abstract describe(): string;
}

class Leaf extends Item {
  weight = 1;
  twin: Leaf | undefined = undefined;
  describe(): string {
    return `Leaf(${this.id}:${this.label}, w=${this.weight}, twin=${this.twin?.id ?? "-"})`;
  }
}

class Group extends Item {
  first: Item | undefined = undefined;
  last: Item | undefined = undefined;
  readonly root: Root;
  count = 0;
  flagged = false;
  constructor(id: number, label: string, root: Root) {
    super(id, label);
    this.root = root;
  }
  add(item: Item): void {
    item.owner = this;
    if (this.last === undefined) this.first = item;
    else this.last.next = item;
    this.last = item;
    this.count++;
  }
  describe(): string {
    const parts: string[] = [];
    for (let at = this.first; at !== undefined; at = at.next) parts.push(at.describe());
    return `Group(${this.id}:${this.label} [${parts.join(", ")}])`;
  }
}

class Root implements ProgramLifetime {
  readonly name: string;
  top: Group | undefined = undefined;
  self: Root;
  readonly groups: Group[] = [];
  readonly byLabel = new Map<string, Item>();
  constructor(name: string) {
    this.name = name;
    this.self = this;
  }
}

class Pair implements ProgramLifetime {
  left: Pair | undefined;
  right: Pair | null;
  readonly tag: string;
  constructor(left: Pair | undefined, right: Pair | null, tag: string) {
    this.left = left;
    this.right = right;
    this.tag = tag;
  }
}

// A mortal class holding program-lifetime references.
class Cursor {
  at: Item | undefined;
  steps = 0;
  constructor(at: Item | undefined) {
    this.at = at;
  }
  advance(): boolean {
    if (this.at === undefined) return false;
    this.at = this.at.next;
    this.steps++;
    return this.at !== undefined;
  }
}

const root = new Root("root");
let id = 0;
for (let g = 0; g < 3; g++) {
  const group = new Group(id++, `g${g}`, root);
  root.groups.push(group);
  root.byLabel.set(group.label, group);
  for (let i = 0; i < 3 + g; i++) {
    const leaf = new Leaf(id++, `l${g}.${i}`);
    leaf.weight = g * 10 + i;
    group.add(leaf);
    root.byLabel.set(leaf.label, leaf);
  }
}
root.top = root.groups[0];
root.groups[0]!.add(root.groups[1]!);
root.groups[1]!.add(root.groups[2]!);

console.log(root.top?.describe());
console.log(root.self === root, root.self.self.name, root.top?.root === root);

// Reads through chains and the owner back references.
const deep = root.byLabel.get("l2.4");
console.log(deep?.owner?.owner?.owner?.label, deep?.owner?.root.name, deep?.next?.id ?? "end");
let hops = 0;
for (let at: Item | null = deep ?? null; at !== null; at = at.owner) hops++;
console.log("hops", hops);

// Writes: replace, clear and relink.
const g1 = root.groups[1]!;
const firstOfG1 = g1.first!;
g1.first = firstOfG1.next;
firstOfG1.next = undefined;
firstOfG1.owner = null;
console.log(g1.describe());
console.log(firstOfG1.owner === null, firstOfG1.next === undefined, firstOfG1.describe());

// Logical and conditional assignment.
const twins: Leaf[] = [];
for (const label of ["l0.0", "l0.1", "l0.2"]) {
  const leaf = root.byLabel.get(label);
  if (leaf instanceof Leaf) twins.push(leaf);
}
twins[0]!.twin ??= twins[1];
twins[0]!.twin ??= twins[2];
twins[1]!.twin ||= twins[0];
twins[2]!.twin = twins[2]!.twin ?? twins[2];
twins[2]!.twin &&= twins[1];
console.log(twins.map((t) => t.describe()).join(" | "));

// Identity: Map and Set keys, ===, and arrays of references.
const seen = new Set<Item>();
const visits = new Map<Item, number>();
for (let round = 0; round < 3; round++) {
  for (let at = root.groups[0]!.first; at !== undefined; at = at.next) {
    seen.add(at);
    visits.set(at, (visits.get(at) ?? 0) + 1);
  }
}
console.log(seen.size, [...visits.values()].join(","), seen.has(root.groups[1]!), seen.has(firstOfG1));
console.log(root.groups.indexOf(g1), root.groups.some((g) => g === firstOfG1));

// A mortal cursor and closures that capture program-lifetime objects.
const cursor = new Cursor(root.groups[2]!.first);
while (cursor.advance()) {}
console.log("steps", cursor.steps, cursor.at === undefined);
const readers: (() => string)[] = [];
for (const g of root.groups) readers.push(() => g.last?.label ?? "none");
root.groups[2]!.last = root.groups[2]!.first;
console.log(readers.map((r) => r()).join(","));

// A cycle through null and undefined arms.
const a = new Pair(undefined, null, "a");
const b = new Pair(a, null, "b");
a.right = b;
a.left = a;
const c = new Pair(b, a, "c");
console.log(c.left?.left?.right?.tag, c.right?.left?.tag, b.right, a.left === a);
const pairs = [a, b, c];
pairs.sort((x, y) => (x.right?.tag ?? "").localeCompare(y.right?.tag ?? ""));
console.log(pairs.map((p) => `${p.tag}<${p.left?.tag ?? "u"},${p.right?.tag ?? "n"}>`).join(" "));

// Inspection, JSON and references boxed into unknown.
const solo = new Leaf(100, "solo");
const other = new Leaf(101, "other");
solo.twin = other;
console.log(solo);
console.log(JSON.stringify(other));
console.log(JSON.stringify(new Pair(new Pair(undefined, null, "inner"), null, "outer")));
console.log(Object.keys(solo).join(","));
const boxed: unknown[] = [solo, solo.twin, solo.next, solo.owner];
console.log(boxed.map((v) => typeof v).join(","), boxed[0] === solo, boxed[1] === other);
console.log(boxed.indexOf(other), boxed.includes(undefined), boxed.includes(null));

// Many objects with references to their neighbours.
let chain: Leaf | undefined = undefined;
let total = 0;
for (let i = 0; i < 20000; i++) {
  const leaf: Leaf = new Leaf(i, "n");
  leaf.twin = chain;
  leaf.weight = i % 7;
  chain = leaf;
}
for (let at = chain; at !== undefined; at = at.twin) total += at.weight;
console.log("chain", total, chain?.twin?.twin?.id);
