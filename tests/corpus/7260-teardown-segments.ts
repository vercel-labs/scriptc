// Teardowns that hand their blocks back in order.
//
// A typed teardown of a type with children of its own type keeps the blocks
// it frees in one segment and frees the segment when the chain's first
// teardown returns, so the next structure built of that type reuses them in
// order. This program rebuilds structures of such types for many
// generations and reads every value of each generation before dropping it:
// a block handed out twice, or one freed while still in use, shows up as a
// wrong checksum. The shapes cover the ways a segment is put together:
// record literals (allocated before their fields) and constructors whose
// arguments build the children first, lists built by prepending and by
// appending, trees far deeper than one direct teardown chain and lists
// longer than the runtime's whole depth budget (whose tails wait in its
// queue), subtrees still owned elsewhere when their parent goes, records of
// one type holding records of another, and nodes of a cycle-capable class
// that are still candidates of the cycle collector when the last reference
// goes, and rings of them that only the collector frees.

interface Node {
  left: Node | null;
  right: Node | null;
  value: number;
}

function literalTree(depth: number, value: number): Node {
  return depth === 0
    ? { left: null, right: null, value }
    : { left: literalTree(depth - 1, value * 2), right: literalTree(depth - 1, value * 2 + 1), value };
}

function sum(node: Node | null): number {
  return node === null ? 0 : node.value + sum(node.left) + sum(node.right);
}

class Branch {
  readonly left: Branch | null;
  readonly right: Branch | null;
  readonly label: string;
  constructor(left: Branch | null, right: Branch | null, label: string) {
    this.left = left;
    this.right = right;
    this.label = label;
  }
}

function classTree(depth: number, label: string): Branch {
  return depth === 0
    ? new Branch(null, null, label)
    : new Branch(classTree(depth - 1, label + "l"), classTree(depth - 1, label + "r"), label);
}

function labels(branch: Branch | null): number {
  return branch === null ? 0 : branch.label.length + labels(branch.left) + labels(branch.right);
}

interface Cell {
  next: Cell | null;
  n: number;
}

function prepended(count: number, base: number): Cell | null {
  let head: Cell | null = null;
  for (let i = 0; i < count; i++) head = { next: head, n: base + i };
  return head;
}

function appended(count: number, base: number): Cell | null {
  if (count === 0) return null;
  const head: Cell = { next: null, n: base };
  let tail = head;
  for (let i = 1; i < count; i++) {
    const cell: Cell = { next: null, n: base + i };
    tail.next = cell;
    tail = cell;
  }
  return head;
}

function cells(head: Cell | null): [number, number] {
  let count = 0;
  let total = 0;
  for (let cell = head; cell !== null; cell = cell.next) {
    count++;
    total += cell.n;
  }
  return [count, total];
}

// Generations of literal trees: shallow, one chain deep, and several chains
// deep. Each generation is checked against the sum the shape must have.
for (const depth of [0, 1, 5, 16, 17, 18]) {
  let ok = true;
  for (let generation = 0; generation < 6; generation++) {
    const tree = literalTree(depth, 1);
    const expected = ((2 ** (depth + 1)) * (2 ** (depth + 1) - 1)) / 2;
    if (sum(tree) !== expected) ok = false;
  }
  console.log(`literal trees of depth ${depth}: ${ok}`);
}

// Generations of class trees built children first.
for (const depth of [3, 12, 17]) {
  let total = 0;
  for (let generation = 0; generation < 4; generation++) total += labels(classTree(depth, "t"));
  console.log(`class trees of depth ${depth}: ${total}`);
}

// Lists both ways, alternating, so each reuses the other's blocks; the long
// ones outlast the runtime's depth budget.
for (const count of [1, 15, 16, 17, 1000, 3000, 40000]) {
  const seen: string[] = [];
  for (let generation = 0; generation < 4; generation++) {
    const list = generation % 2 === 0 ? prepended(count, generation) : appended(count, generation);
    const [length, total] = cells(list);
    seen.push(`${length}/${total}`);
  }
  console.log(`lists of ${count}: ${seen.join(" ")}`);
}

// Subtrees owned elsewhere survive their parent's teardown, and the blocks
// freed around them are not handed out while they live.
const kept: Node[] = [];
for (let generation = 0; generation < 5; generation++) {
  const tree = literalTree(10, generation + 1);
  if (tree.left !== null && tree.left.right !== null) kept.push(tree.left.right);
  if (tree.right !== null) kept.push(tree.right);
  // Building the next tree reuses the dropped blocks.
  literalTree(10, 7);
}
console.log(`kept subtrees: ${kept.length} ${kept.map(sum).join(",")}`);

// A record of one type holding trees of another: the outer teardown frees
// its own blocks as before and tears each inner tree down as a segment.
interface Forest {
  first: Node;
  second: Node | null;
  rest: Forest | null;
}

function forest(count: number): Forest | null {
  let out: Forest | null = null;
  for (let i = 0; i < count; i++) out = { first: literalTree(4, i), second: i % 3 === 0 ? null : literalTree(2, i), rest: out };
  return out;
}

let forestTotal = 0;
for (let generation = 0; generation < 3; generation++) {
  for (let f = forest(500); f !== null; f = f.rest) forestTotal += sum(f.first) + sum(f.second);
}
console.log(`forests: ${forestTotal}`);

// A cycle-capable class: releases of shared links make nodes candidates of
// the cycle collector, which are then torn down while still buffered, and
// the peer links close some rings, which the collector frees.
class Ring {
  next: Ring | null = null;
  peer: Ring | null = null;
  id: number;
  constructor(id: number) {
    this.id = id;
  }
}

let ringTotal = 0;
for (let generation = 0; generation < 3; generation++) {
  let head: Ring | null = null;
  const peers: Ring[] = [];
  for (let i = 0; i < 2000; i++) {
    const ring: Ring = new Ring(i);
    ring.next = head;
    if (i % 7 === 0) peers.push(ring);
    head = ring;
  }
  for (let r = head; r !== null; r = r.next) if (r.id % 5 === 0) r.peer = peers[r.id % peers.length] ?? null;
  for (const peer of peers) ringTotal += peer.id;
  peers.length = 0;
  for (let r = head; r !== null; r = r.next) ringTotal += r.peer === null ? 0 : r.peer.id;
}
console.log(`rings: ${ringTotal}`);
