// Collector passes whose candidates mix dead structures with live ones: the
// ring under construction when a pass runs, owners that keep an inner node
// of an otherwise dead ring, trees whose child arrays have holes and sparse
// slots, and a live structure too large for a pass to record. Each dead
// structure is reclaimed whole, and everything still reachable survives
// with its contents intact. The sanitized lane's RC audit fails if anything
// below leaks or is freed while reachable.

class Node {
  next: Node | null = null;
  kids: (Node | undefined)[] = [];
  owner: Node | null = null;
  value: number;
  constructor(value: number) {
    this.value = value;
  }
}

function ring(size: number, base: number): Node {
  const first = new Node(base);
  let last = first;
  for (let i = 1; i < size; i++) {
    const node = new Node(base + i);
    last.next = node;
    last = node;
  }
  last.next = first;
  return first;
}

function tree(depth: number, owner: Node | null, value: number): Node {
  const node = new Node(value);
  node.owner = owner;
  if (depth > 0) for (let i = 0; i < 3; i++) node.kids.push(tree(depth - 1, node, value * 3 + i));
  return node;
}

function total(start: Node): number {
  const seen = new Set<Node>();
  const stack: Node[] = [start];
  let sum = 0;
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (seen.has(node)) continue;
    seen.add(node);
    sum = (sum + node.value) % 1000003;
    if (node.next) stack.push(node.next);
    if (node.owner) stack.push(node.owner);
    for (const kid of node.kids) if (kid) stack.push(kid);
  }
  return sum * 1000 + (seen.size % 1000);
}

// Dead rings dropped while the next one is being built; a few are kept.
let rings = 0;
const kept: Node[] = [];
for (let round = 0; round < 3000; round++) {
  const r = ring(5 + (round % 7), round);
  rings = (rings + r.next!.value) % 1000003;
  if (round % 500 === 0) kept.push(r);
}
console.log("rings", rings, kept.map(total).join(" "));

// Rings whose head is dropped while an owner keeps a node in the middle:
// the ring stays reachable through it and must survive whole.
const anchors: Node[] = [];
for (let round = 0; round < 400; round++) {
  let mid = ring(30, round * 100);
  for (let i = 0; i < 15; i++) mid = mid.next!;
  if (round % 4 === 0) anchors.push(mid);
}
let anchored = 0;
for (const anchor of anchors) anchored = (anchored + total(anchor)) % 1000003;
console.log("anchored", anchors.length, anchored);

// Trees with holes and sparse slots in their child arrays.
let trees = 0;
const shaped: Node[] = [];
for (let round = 0; round < 300; round++) {
  const t = tree(4, null, round);
  if (round % 3 === 0) t.kids.length = 6;
  if (round % 5 === 0) t.kids[200] = tree(2, t, round + 7);
  if (round % 7 === 0) t.kids[0]!.kids.length = 1;
  trees = (trees + total(t)) % 1000003;
  if (round % 60 === 0) shaped.push(t.kids[2]!);
}
console.log("trees", trees, shaped.map(total).join(" "));

// A live tree larger than one pass records, built and read while dead
// structures keep dying around it, then dropped.
const big = tree(10, null, 1);
let churn = 0;
for (let round = 0; round < 200; round++) {
  const r = ring(50, round);
  const branch = big.kids[round % 3]!.kids[(round >> 2) % 3]!;
  branch.next = r;
  churn = (churn + total(r)) % 1000003;
  if (round % 50 === 0) churn = (churn + total(big)) % 1000003;
  branch.next = null;
}
console.log("big", churn, total(big));
