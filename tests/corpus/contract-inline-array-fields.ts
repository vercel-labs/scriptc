import type { ProgramLifetime } from "@scriptc/types";
import type { InlineArray } from "@scriptc/experimental";

// InlineArray fields (@scriptc/experimental): a ProgramLifetime class whose
// constructor writes an array field once from one of its parameters may keep
// the elements in the instance itself. Reads that index the field, read its
// length or iterate it load the elements from the instance; other reads see
// an array of them. Both runtimes print the same.

abstract class Node implements ProgramLifetime {
  readonly kind: string;
  readonly pos: number;
  constructor(kind: string, pos: number) {
    this.kind = kind;
    this.pos = pos;
  }
  abstract text(): string;
}

class Leaf extends Node {
  readonly value: number;
  constructor(pos: number, value: number) {
    super("leaf", pos);
    this.value = value;
  }
  text(): string {
    return String(this.value);
  }
}

class List implements ProgramLifetime {
  readonly pos: number;
  readonly end: number;
  readonly nodes: InlineArray<Node>;
  constructor(pos: number, end: number, nodes: readonly Node[]) {
    this.pos = pos | 0;
    this.end = end | 0;
    this.nodes = nodes;
  }
  hasTrailingComma(): boolean {
    const nodes = this.nodes;
    return nodes.length > 0 && nodes[nodes.length - 1]!.pos < this.end;
  }
}

// A subclass with the inherited constructor.
class MissingList extends List {}

// A subclass with fields of its own, which passes its parameter through.
class ModifierList extends List {
  readonly flags: number;
  readonly label: string;
  constructor(pos: number, end: number, nodes: readonly Node[], flags: number, label: string) {
    super(pos, end, nodes);
    this.flags = flags;
    this.label = label;
  }
}

class Group extends Node {
  readonly children: List;
  constructor(pos: number, children: List) {
    super("group", pos);
    this.children = children;
  }
  text(): string {
    const parts: string[] = [];
    for (const child of this.children.nodes) parts.push(child.text());
    return `(${parts.join(" ")})`;
  }
}

function leaves(from: number, count: number): Leaf[] {
  const out: Leaf[] = [];
  for (let i = 0; i < count; i++) out.push(new Leaf(from + i, (from + i) * 3));
  return out;
}

// Direct reads: index, length, a local alias, for...of.
function sum(list: List): number {
  let s = 0;
  for (let i = 0; i < list.nodes.length; i++) s += (list.nodes[i] as Leaf).value;
  const nodes = list.nodes;
  for (let i = 0; i < nodes.length; i++) s += nodes[i]!.pos;
  for (const node of list.nodes) s += node.pos * 2;
  return s;
}

// The field read as an array value.
function describe(nodes: readonly Node[]): string {
  return nodes.map((n) => n.text()).join(",");
}

function depth(node: Node): number {
  if (!(node instanceof Group)) return 1;
  let max = 0;
  for (const child of node.children.nodes) max = Math.max(max, depth(child));
  return max + 1;
}

const lengths = [0, 1, 2, 3, 5, 16, 17, 40];
const lists: List[] = [];
for (const n of lengths) lists.push(new List(n, n * 10, leaves(n, n)));
for (const list of lists)
  console.log(
    list.nodes.length,
    sum(list),
    list.hasTrailingComma(),
    describe(list.nodes).slice(0, 40),
  );

// Subclasses share the elements' layout.
const missing = new MissingList(5, 5, []);
const modifiers = new ModifierList(1, 9, leaves(1, 4), 7, "mods");
const lists2: List[] = [missing, modifiers];
for (const list of lists2)
  console.log(
    list instanceof ModifierList ? "ModifierList" : list instanceof MissingList ? "MissingList" : "List",
    list.nodes.length,
    sum(list),
    list.pos,
    list.end,
  );
console.log(modifiers.flags, modifiers.label, modifiers.nodes[3]!.text());

// Array methods over the field's elements, and element identity.
const big = lists[lists.length - 1]!;
const third = big.nodes[2]!;
console.log(big.nodes.indexOf(third), big.nodes.includes(third), big.nodes[2] === third);
console.log(big.nodes.slice(3, 6).map((n) => n.pos).join("|"));
console.log(big.nodes.filter((n) => n.pos % 7 === 0).length);
console.log([...big.nodes].reverse()[0]!.pos, Array.from(big.nodes).length);
console.log(big.nodes.some((n) => n.pos === 77), big.nodes.find((n) => n.pos > 70)?.pos);

// A list built from another list's elements, and from a slice of them.
const copy = new List(0, 0, big.nodes);
const part = new ModifierList(0, 0, big.nodes.slice(10, 13), 1, "part");
console.log(copy.nodes.length, copy.nodes[39] === big.nodes[39], sum(part), part.nodes[0]!.pos);

// Inside a value that becomes dynamic, the field shows as an array.
class Holder {
  readonly list: List;
  constructor(list: List) {
    this.list = list;
  }
}
const shown = new ModifierList(1, 2, leaves(7, 2), 3, "shown");
console.log(JSON.stringify({ shown }));
console.log(JSON.stringify(new Holder(shown)));

// The arguments of `new` run before the instance is made, so an argument
// that adds to the array the list is built from adds to the list.
const growing = leaves(50, 2);
const grown = new List(growing.push(new Leaf(52, 1)), 0, growing);
console.log(grown.pos, grown.nodes.length, grown.nodes[2]!.pos);

// Trees whose groups hold lists.
function tree(level: number, pos: number): Node {
  if (level === 0) return new Leaf(pos, pos);
  const kids: Node[] = [];
  for (let i = 0; i < level + 1; i++) kids.push(tree(level - 1, pos * 4 + i));
  return new Group(pos, new List(pos, pos + kids.length, kids));
}
const root = tree(4, 1);
console.log(depth(root), root.text().length, root.text().slice(0, 60));

// Loops over lists built from arrays that may have holes, in a function that
// only reads: each loop keeps its own array of the elements for the whole
// loop, also while an inner loop makes another.
function holed(nodes: readonly Node[]): Node[] {
  const out: Node[] = new Array<Node>(nodes.length);
  for (let i = 0; i < nodes.length; i++) out[i] = nodes[i]!;
  return out;
}
function leafSum(group: Group): number {
  let n = 0;
  for (const child of group.children.nodes)
    if (child instanceof Group) for (const leaf of child.children.nodes) n += leaf.pos;
  return n;
}
const nested = new Group(
  0,
  new List(0, 2, holed([new Group(1, new List(1, 1, holed(leaves(10, 3)))), new Group(2, new List(2, 2, holed(leaves(20, 3))))])),
);
console.log(leafSum(nested), leafSum(nested));

// Many lists: every read stays on the instance.
let total = 0;
for (let round = 0; round < 2000; round++) {
  const list = new List(round, round + 3, leaves(round, round % 9));
  total += sum(list) + list.nodes.length;
  if (list.nodes.length > 0) total += list.nodes.indexOf(list.nodes[list.nodes.length - 1]!);
}
console.log(total);

// An index that assigns the list local reads the elements of the list the
// field was read off first.
function firstOf(a: List, b: List): number | undefined {
  let list = a;
  return list.nodes[((list = b), 0)]?.pos;
}
const firstA = new List(0, 1, leaves(7, 1));
const firstB = new List(0, 1, leaves(8, 1));
console.log(firstOf(firstA, firstB), firstOf(firstB, firstA));
