// Recursive builders whose results their callers only read: each tree is a
// group that lives in an arena until the statement (or the loop body that
// holds it) ends.
class TreeNode {
  left: TreeNode | null;
  right: TreeNode | null;
  value: number;
  constructor(left: TreeNode | null, right: TreeNode | null, value: number) {
    this.left = left;
    this.right = right;
    this.value = value;
  }
  sum(): number {
    return this.value + (this.left === null ? 0 : this.left.sum()) + (this.right === null ? 0 : this.right.sum());
  }
  depth(): number {
    return 1 + Math.max(this.left === null ? 0 : this.left.depth(), this.right === null ? 0 : this.right.depth());
  }
}

function build(depth: number, value: number): TreeNode {
  return depth === 0
    ? new TreeNode(null, null, value)
    : new TreeNode(build(depth - 1, value * 2), build(depth - 1, value * 2 + 1), value);
}

let total = 0;
for (let d = 0; d < 12; d++) total += build(d, 1).sum();
console.log("sums", total);

for (let d = 2; d <= 4; d++) {
  const t = build(d, 1);
  console.log("tree", d, t.sum(), t.depth(), t.left!.value, t.right!.right!.value);
}

function deepest(n: number): number {
  let best = 0;
  for (let i = 0; i < n; i++) {
    const t = build(i % 6, i);
    best = Math.max(best, t.depth() * 1000 + (t.sum() % 1000));
  }
  return best;
}
console.log("deepest", deepest(40));

// Record-literal trees: a root call whose result its caller only reads
// builds the whole tree, its root node included, in the group's arena.
interface Node2 {
  left: Node2 | null;
  right: Node2 | null;
  value: number;
}

function buildRecord(depth: number, value: number): Node2 {
  return depth === 0
    ? { left: null, right: null, value }
    : { left: buildRecord(depth - 1, value * 2), right: buildRecord(depth - 1, value * 2 + 1), value };
}

function sumRecord(node: Node2): number {
  return node.value + (node.left === null ? 0 : sumRecord(node.left)) + (node.right === null ? 0 : sumRecord(node.right));
}

let recordTotal = 0;
for (let d = 0; d < 12; d++) recordTotal += sumRecord(buildRecord(d, 1));
console.log("record sums", recordTotal);
for (let d = 1; d <= 3; d++) {
  const t = buildRecord(d, 1);
  console.log("record tree", d, sumRecord(t), t.value, t.left!.value, t.right!.value);
}
