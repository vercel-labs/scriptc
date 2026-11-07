// A node of a proven tree class takes its bytes from the group arena of the
// tree's root: the builder opens the arena, every node of the tree is carved
// from it, and the drop reclaims the whole subtree when the tree dies, so the
// node is never freed on its own.
class Node {
  left: Node | null;
  right: Node | null;
  constructor(left: Node | null, right: Node | null) {
    this.left = left;
    this.right = right;
  }
}

function bottomUpTree(depth: number): Node {
  if (depth === 0) return new Node(null, null);
  return new Node(bottomUpTree(depth - 1), bottomUpTree(depth - 1));
}

function nodeCount(tree: Node): number {
  if (tree.left === null || tree.right === null) return 1;
  return 1 + nodeCount(tree.left) + nodeCount(tree.right);
}

function treeDepth(tree: Node): number {
  if (tree.left === null || tree.right === null) return 1;
  const left = treeDepth(tree.left);
  const right = treeDepth(tree.right);
  return 1 + (left > right ? left : right);
}

// A tree the statement builds and only reads lives in the arena until the
// statement ends: it is built in one, several times, without being freed
// node by node.
let total = 0;
for (let depth = 2; depth <= 8; depth += 2) {
  for (let i = 0; i < 4; i++) total += nodeCount(bottomUpTree(depth));
}
console.log("loop", total);

// A tree held by a local binding keeps its arena open for the binding's
// scope.
function heldShape(): number {
  const held = bottomUpTree(6);
  return nodeCount(held) * 1000 + treeDepth(held);
}
console.log("held", heldShape());

// A node whose class a method observes keeps its count word and the general
// arena path: dispatch needs a class and the node may be shared with a
// counted owner.
class CountedNode {
  left: CountedNode | null;
  right: CountedNode | null;
  value: number;
  constructor(left: CountedNode | null, right: CountedNode | null, value: number) {
    this.left = left;
    this.right = right;
    this.value = value;
  }
  sum(): number {
    return this.value + (this.left === null ? 0 : this.left.sum()) + (this.right === null ? 0 : this.right.sum());
  }
}

function countedTree(depth: number, value: number): CountedNode {
  if (depth === 0) return new CountedNode(null, null, value);
  return new CountedNode(countedTree(depth - 1, value * 2), countedTree(depth - 1, value * 2 + 1), value);
}

let counted = 0;
for (let depth = 1; depth <= 5; depth++) counted += countedTree(depth, 1).sum();
console.log("counted", counted);
