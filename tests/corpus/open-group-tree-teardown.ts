// A tree class in a program whose group is open keeps the heap path instead
// of the group arena, and a node whose reference fields do not lead the struct
// cannot tear down in the walking loop: it releases one child per node. Those
// releases enter the runtime's depth budget, so this program pins the whole
// teardown path as well as the tree's output.
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

function build(depth: number): Node {
  if (depth === 0) return new Node(0, null, null, null);
  return new Node(depth, build(depth - 1), null, null);
}

function sum(node: Node): number {
  if (node.a === null) return node.value;
  return node.value + sum(node.a);
}

function held(depth: number): number {
  const root = build(depth);
  return sum(root);
}

// The chain holds strings, so its group is open and the node class keeps the
// heap path.
interface Item {
  label: string;
  next: Item | null;
}
function chain(labels: string[], n: number): Item {
  if (n === 0) return { label: labels[0]!, next: null };
  return { label: labels[n % labels.length]!, next: chain(labels, n - 1) };
}

function length(item: Item): number {
  return item.next === null ? item.label.length : item.label.length + length(item.next);
}

const labels = ["a", "bb", "ccc"];
let total = 0;
for (let round = 0; round < 8; round++) total += held(round % 5 + 1) * 10 + length(chain(labels, round + 2));
console.log(total);
