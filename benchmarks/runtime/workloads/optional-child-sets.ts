// Syntax-tree walks through class nodes whose getters return optional
// children, in a program that also keeps a `Set` of the optional node type.
class TreeNode {
  readonly kind: number;
  private readonly kids: (TreeNode | undefined)[];
  parentNode: TreeNode | undefined;
  constructor(kind: number, kids: (TreeNode | undefined)[]) {
    this.kind = kind;
    this.kids = kids;
    this.parentNode = undefined;
    for (const kid of kids) if (kid !== undefined) kid.parentNode = this;
  }
  get left(): TreeNode | undefined {
    return this.kids[0];
  }
  get right(): TreeNode | undefined {
    return this.kids[1];
  }
  get parent(): TreeNode | undefined {
    return this.parentNode;
  }
}

function build(depth: number, seed: number): TreeNode {
  if (depth === 0) return new TreeNode(seed % 7, [undefined, undefined]);
  const right = seed % 11 === 0 ? undefined : build(depth - 1, seed * 7 + 3);
  return new TreeNode(seed % 7, [build(depth - 1, seed * 5 + 1), right]);
}

function sumKinds(node: TreeNode | undefined): number {
  let total = 0;
  while (node !== undefined) {
    total += node.kind;
    const up = node.parent;
    if (up !== undefined && up.kind === node.kind) total++;
    total += sumKinds(node.right);
    node = node.left;
  }
  return total;
}

const root = build(20, 1);
// The one Set of the optional node type.
const marked = new Set<TreeNode | undefined>([root, root.left, undefined]);
let total = 0;
const rounds = 30 * Number(process.argv[2] ?? "1");
for (let i = 0; i < rounds; i++) total += sumKinds(root);
console.log(total, marked.size, marked.has(root.right));
