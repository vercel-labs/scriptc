// A thrown value that holds an object built in a group: the group cannot
// take an arena, because the value outlives it in the catch handler.
class Node {
  label: string;
  weight: number;
  constructor(label: string, weight: number) {
    this.label = label;
    this.weight = weight;
  }
}
class BuildError {
  node: Node;
  constructor(node: Node) {
    this.node = node;
  }
}
function build(n: number, failAt: number): Node[] {
  const out: Node[] = [];
  for (let i = 0; i < n; i++) {
    const node = new Node(`n${i}`, i);
    out.push(node);
    if (i === failAt) throw new BuildError(node);
  }
  return out;
}
let total = 0;
const saved: string[] = [];
for (let r = 0; r < 20; r++) {
  try {
    total += build(50, r % 4 === 0 ? 30 : -1).length;
  } catch (e) {
    const b = e as BuildError;
    saved.push(b.node.label + ":" + b.node.weight);
  }
}
console.log(total, saved.join(","));
