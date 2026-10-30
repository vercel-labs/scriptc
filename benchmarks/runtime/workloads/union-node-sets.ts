// Syntax-tree passes over a discriminated union of object literals, the way
// compilers walk their IR: a DAG of shared subexpressions, a `Set` of
// visited nodes, a `Map` from node to its value, and conversions between
// the whole union and the sub-unions passes narrow it to.
type Num = { kind: "num"; value: number };
type Var = { kind: "var"; slot: number };
type Neg = { kind: "neg"; operand: Node };
type Add = { kind: "add"; left: Node; right: Node };
type Mul = { kind: "mul"; left: Node; right: Node };
type Pick = { kind: "pick"; cond: Node; then: Node; else_: Node };
type Leaf = Num | Var;
type Node = Leaf | Neg | Add | Mul | Pick;

function children(node: Node, visit: (child: Node) => void): void {
  switch (node.kind) {
    case "num":
    case "var":
      return;
    case "neg":
      visit(node.operand);
      return;
    case "add":
    case "mul":
      visit(node.left);
      visit(node.right);
      return;
    case "pick":
      visit(node.cond);
      visit(node.then);
      visit(node.else_);
      return;
  }
}

function leafValue(leaf: Leaf, env: number[]): number {
  return leaf.kind === "num" ? leaf.value : env[leaf.slot]!;
}

function evaluate(node: Node, env: number[], memo: Map<Node, number>): number {
  const cached = memo.get(node);
  if (cached !== undefined) return cached;
  let result: number;
  switch (node.kind) {
    case "num":
    case "var":
      result = leafValue(node, env);
      break;
    case "neg":
      result = -evaluate(node.operand, env, memo);
      break;
    case "add":
      result = (evaluate(node.left, env, memo) + evaluate(node.right, env, memo)) % 1000003;
      break;
    case "mul":
      result = (evaluate(node.left, env, memo) * evaluate(node.right, env, memo)) % 1000003;
      break;
    case "pick":
      result =
        evaluate(node.cond, env, memo) % 2 === 0
          ? evaluate(node.then, env, memo)
          : evaluate(node.else_, env, memo);
      break;
  }
  memo.set(node, result);
  return result;
}

function reachable(root: Node): number {
  const seen = new Set<Node>();
  const stack: Node[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (seen.has(node)) continue;
    seen.add(node);
    children(node, (child) => {
      if (!seen.has(child)) stack.push(child);
    });
  }
  return seen.size;
}

function leaves(root: Node): Leaf[] {
  const out: Leaf[] = [];
  const seen = new Set<Node>();
  const walk = (node: Node): void => {
    if (seen.has(node)) return;
    seen.add(node);
    if (node.kind === "num" || node.kind === "var") out.push(node);
    else children(node, walk);
  };
  walk(root);
  return out;
}

let seed = 2463534242;
function next(): number {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return seed >>> 0;
}

function build(size: number): Node {
  const pool: Node[] = [];
  for (let i = 0; i < 64; i++)
    pool.push(i % 2 === 0 ? { kind: "num", value: i * 7 + 1 } : { kind: "var", slot: i % 16 });
  // Operands come from the most recent nodes, so most of the DAG is
  // reachable from the root and many nodes are shared.
  const recent = (): Node => pool[pool.length - 1 - (next() % 48)]!;
  for (let i = 0; i < size; i++) {
    const a = recent();
    const b = recent();
    const r = next() % 10;
    let node: Node;
    if (r < 1) node = { kind: "neg", operand: a };
    else if (r < 5) node = { kind: "add", left: a, right: b };
    else if (r < 8) node = { kind: "mul", left: a, right: b };
    else node = { kind: "pick", cond: a, then: b, else_: recent() };
    pool.push(node);
  }
  return pool[pool.length - 1]!;
}

const scale = Number(process.argv[2] ?? "1");
const rounds = Math.max(1, Math.round(40 * scale));
let checksum = 0;
let nodes = 0;
let leafCount = 0;
for (let round = 0; round < rounds; round++) {
  const root = build(20_000);
  nodes += reachable(root);
  const found = leaves(root);
  leafCount += found.length;
  for (let pass = 0; pass < 4; pass++) {
    const env: number[] = [];
    for (let i = 0; i < 16; i++) env.push((round * 31 + pass * 7 + i) % 97);
    checksum = (checksum + evaluate(root, env, new Map())) % 1000003;
    for (const leaf of found) checksum = (checksum + leafValue(leaf, env)) % 1000003;
  }
}
console.log("rounds", rounds, "nodes", nodes, "leaves", leafCount, "checksum", checksum);
