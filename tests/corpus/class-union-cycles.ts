// Cycles through class-union fields: a union whose arms include a class
// that can reach itself is cycle-capable, so every arm carries the cycle
// collector's header, including arms that hold only numbers. Graphs are
// built, linked into cycles, rewired and dropped across many rounds.
class Leaf {
  readonly value: number;
  constructor(value: number) {
    this.value = value;
  }
}

class Branch {
  left: Tree;
  right: Tree;
  parent: Tree | undefined = undefined;
  constructor(left: Tree, right: Tree) {
    this.left = left;
    this.right = right;
  }
}

class Ref {
  target: Tree | null = null;
  readonly label: string;
  constructor(label: string) {
    this.label = label;
  }
}

type Tree = Leaf | Branch | Ref;

function sum(t: Tree | null, depth: number): number {
  if (t === null || depth > 40) return 0;
  if (t instanceof Leaf) return t.value;
  if (t instanceof Ref) return 1 + sum(t.target, depth + 1);
  return sum(t.left, depth + 1) + sum(t.right, depth + 1);
}

function build(depth: number, seed: number): Tree {
  if (depth === 0) return new Leaf(seed % 5);
  const b = new Branch(build(depth - 1, seed * 7 + 1), build(depth - 1, seed + 3));
  if (b.left instanceof Branch) b.left.parent = b;
  if (b.right instanceof Branch) b.right.parent = b;
  return b;
}

let checksum = 0;
const kept: Tree[] = [];
for (let round = 0; round < 300; round++) {
  const tree = build(5, round);
  const ref = new Ref(`r${round}`);
  // A cycle: the tree reaches the ref, and the ref reaches the tree.
  if (tree instanceof Branch) {
    tree.right = ref;
    ref.target = tree;
  }
  checksum += sum(tree, 0);
  if (round % 50 === 0) kept.push(tree);
  // Rewire: drop the cycle on some rounds and keep it on others.
  if (round % 3 === 0) ref.target = new Leaf(round);
}
console.log(checksum, kept.length, kept.map((t) => sum(t, 0)).join(" "));

// A self-referential ref and a two-ref ring, dropped.
for (let i = 0; i < 100; i++) {
  const self = new Ref("self");
  self.target = self;
  const a = new Ref("a");
  const b = new Ref("b");
  a.target = b;
  b.target = a;
  checksum += sum(a, 30) + sum(self, 35);
}
console.log(checksum);

// Union values in arrays and maps that form cycles with their holders.
class Holder {
  readonly items: Tree[] = [];
  readonly named = new Map<string, Tree>();
}
let held = 0;
for (let i = 0; i < 50; i++) {
  const h = new Holder();
  const ref = new Ref(`h${i}`);
  h.items.push(new Leaf(i), ref, build(2, i));
  h.named.set("ref", ref);
  const branch = new Branch(ref, new Leaf(1));
  ref.target = branch;
  branch.parent = h.items[2]!;
  h.items.push(branch);
  held += h.items.length + h.named.size + sum(h.items[3]!, 0);
}
console.log(held);
