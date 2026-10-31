// Teardown of self-recursive records and classes: shared and immortal
// children, deep chains, weak-collection keys, and trees rebuilt from freed
// blocks.

interface TreeNode {
  left: TreeNode | null;
  right: TreeNode | null;
}

class ListNode {
  next: ListNode | null;
  value: number;
  constructor(next: ListNode | null, value: number) {
    this.next = next;
    this.value = value;
  }
}

class Pair {
  a: Pair | null;
  b: Pair | null;
  constructor(a: Pair | null, b: Pair | null) {
    this.a = a;
    this.b = b;
  }
}

function build(depth: number): TreeNode {
  return depth > 0 ? { left: build(depth - 1), right: build(depth - 1) } : { left: null, right: null };
}

function count(node: TreeNode | null): number {
  if (node === null) return 0;
  return 1 + count(node.left) + count(node.right);
}

// Trees torn down and rebuilt from their freed blocks.
let total = 0;
for (let depth = 0; depth <= 12; depth++) {
  for (let i = 0; i < 4; i++) total += count(build(depth));
}
console.log("trees", total);

// A child shared by two parents survives the first parent's teardown.
const shared = build(3);
let left: TreeNode | null = { left: shared, right: build(2) };
let right: TreeNode | null = { left: build(1), right: shared };
left = null;
console.log("shared after first parent", count(shared), count(right));
right = null;
console.log("shared after second parent", count(shared));

// A node held from outside keeps its subtree when the tree around it dies.
let outer: TreeNode | null = build(6);
const kept = outer.left!.right!;
outer = null;
console.log("kept subtree", count(kept));

// A chain far deeper than any call stack.
let head: ListNode | null = null;
for (let i = 0; i < 2000000; i++) head = new ListNode(head, i);
let sum = 0;
for (let n = head; n !== null; n = n.next) sum += n.value % 7;
head = null;
console.log("chain", sum);

// A list whose middle node is still referenced keeps the tail from it.
let list: ListNode | null = null;
let middle: ListNode | null = null;
for (let i = 0; i < 1000; i++) {
  list = new ListNode(list, i);
  if (i === 500) middle = list;
}
list = null;
let tail = 0;
for (let n = middle; n !== null; n = n.next) tail++;
console.log("tail from middle", tail);
middle = null;

// Nodes used as WeakMap keys: their entries go away when the tree dies.
const weak = new WeakMap<Pair, number>();
let root: Pair | null = new Pair(new Pair(null, null), new Pair(new Pair(null, null), null));
const probe = root.b!;
weak.set(root, 1);
weak.set(root.a!, 2);
weak.set(probe, 3);
root = null;
console.log("weak probe", weak.get(probe), weak.has(probe));

// Immortal leaves shared by many nodes.
const leaf: TreeNode = { left: null, right: null };
let wide: TreeNode | null = { left: leaf, right: leaf };
for (let i = 0; i < 100; i++) wide = { left: wide, right: leaf };
console.log("wide", count(wide));
wide = null;
console.log("leaf", count(leaf));
