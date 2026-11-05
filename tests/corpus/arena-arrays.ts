// Groups with arrays: child lists that grow past their first storage,
// back references to parents and siblings, and lists of lists.
class Node {
  parent: Node | undefined = undefined;
  children: Node[] = [];
  sibling: Node | undefined = undefined;
  weight: number;
  constructor(weight: number) {
    this.weight = weight;
  }
}

function wide(depth: number, fan: number, parent: Node | undefined, weight: number): Node {
  const node = new Node(weight);
  node.parent = parent;
  if (depth > 0) {
    for (let i = 0; i < fan; i++) node.children.push(wide(depth - 1, fan, node, weight * 3 + i));
    for (let i = 0; i < fan; i++) node.children[i]!.sibling = node.children[(i + 1) % fan]!;
  }
  return node;
}

function weigh(node: Node): number {
  let total = node.weight;
  for (const child of node.children) total += weigh(child);
  return total % 1000003;
}

let w = 0;
for (let round = 0; round < 30; round++) w = (w + weigh(wide(2 + (round % 3), 3 + (round % 20), undefined, round))) % 1000003;
console.log("weights", w);

function grid(rows: number, cols: number): number[][] {
  const out: number[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: number[] = [];
    for (let c = 0; c < cols; c++) row.push(r * cols + c);
    out.push(row);
  }
  return out;
}
let cells = 0;
for (let k = 1; k < 40; k++) {
  const g = grid(k, 70);
  cells += g.length + g[k - 1]![69]! + g[0]!.length;
}
console.log("cells", cells);
const t = wide(2, 4, undefined, 1);
console.log(t.children.length, t.children[1]!.parent === t, t.children[3]!.sibling === t.children[0], t.children[2]!.children[3]!.weight);
