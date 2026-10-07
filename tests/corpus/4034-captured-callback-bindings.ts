type Node = { kind: "leaf"; value: number } | { kind: "pair"; left: Node; right: Node };

function everyChild(node: Node, visit: (child: Node) => boolean): boolean {
  return node.kind === "leaf" || [node.left, node.right].every((child) => visit(child));
}
function every(node: Node, predicate: (node: Node) => boolean): boolean {
  const walk = (child: Node): boolean => predicate(child) && everyChild(child, walk);
  return walk(node);
}

function tree(depth: number, seed: number): Node {
  if (depth === 0) return { kind: "leaf", value: seed % 7 };
  return { kind: "pair", left: tree(depth - 1, seed * 3 + 1), right: tree(depth - 1, seed * 5 + 2) };
}

const root = tree(6, 1);
let leaves = 0;
console.log(every(root, (node) => (node.kind === "leaf" ? (leaves++, true) : true)), leaves);
console.log(every(root, (node) => node.kind !== "leaf" || node.value < 6));

// A captured binding the callback reassigns keeps its shared box.
let label = "first";
const rename = (next: string) => {
  const previous = label;
  label = next;
  return previous;
};
const read = () => label;
console.log(read(), rename("second"), read(), [1, 2].map(() => rename(read() + "!")).join(","), read());

// Captured callbacks remain valid after their declaring frame returns.
function counter(step: number): () => number {
  let total = 0;
  const add = (amount: number) => (total += amount);
  return () => add(step);
}
const tick = counter(4);
tick();
console.log(tick(), tick());
