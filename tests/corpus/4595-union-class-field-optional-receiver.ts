// A tree walker passes array elements (which may be holes) to helpers that
// narrow a base-class parameter to several subclasses with `instanceof`,
// test a shared field, and then read and write it again.
class Node {
  kind: string;
  constructor(kind: string) {
    this.kind = kind;
  }
}

class Block extends Node {
  label: string | undefined;
  statements: Node[];
  constructor(label: string | undefined, statements: Node[]) {
    super("Block");
    this.label = label;
    this.statements = statements;
  }
}

class Loop extends Node {
  depth: number;
  label: string | undefined;
  constructor(label: string | undefined) {
    super("Loop");
    this.depth = 2;
    this.label = label;
  }
}

function labelOf(node: Node): string {
  if (!(node instanceof Block || node instanceof Loop)) return "none";
  if (node.label === undefined) return "unlabeled";
  return node.label + ":" + node.label.length;
}

function relabel(node: Node, label: string): boolean {
  if (!(node instanceof Block || node instanceof Loop)) return false;
  if (node.label === label) return false;
  node.label = label;
  return true;
}

const nodes: Node[] = [new Block(undefined, []), new Loop("outer"), new Loop("l2"), new Node("Empty")];
for (let i = 0; i < nodes.length; i++) {
  const node = nodes[i];
  console.log(node.kind, labelOf(node), relabel(node, "l" + i), labelOf(node));
}
console.log(relabel(nodes[2], "l2"), labelOf(nodes[2]));

// A hole read where the checker sees a Node: the walker never calls the
// helpers with it, so only present elements reach the narrowed reads.
const sparse: Node[] = [new Loop(undefined)];
sparse[2] = new Block("late", []);
for (const node of sparse) {
  if (node === undefined) console.log("hole");
  else console.log(node.kind, labelOf(node));
}
