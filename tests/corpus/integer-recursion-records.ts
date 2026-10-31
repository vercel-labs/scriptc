// Pure integer recursion over record graphs: counts and sums read from
// fields, sums that leave the int32 range, number fields that are not
// int32s, boolean fields, null tests and narrows, endless recursion, and
// records that view another record.

interface Tree {
  left: Tree | null;
  right: Tree | null;
}

function build(depth: number): Tree {
  return depth > 0 ? { left: build(depth - 1), right: build(depth - 1) } : { left: null, right: null };
}

// The binary-trees check: an accumulating self call after a nested one.
function count(node: Tree): number {
  if (node.left === null || node.right === null) return 1;
  return 1 + count(node.left) + count(node.right);
}

// The same with the calls in the other order and a ternary.
function countRight(node: Tree): number {
  return node.left === null || node.right === null ? 1 : count(node.right) + countRight(node.left) + 1;
}

interface Item {
  weight: number;
  heavy: boolean;
  next: Item | null;
}

function list(weights: number[]): Item | null {
  let head: Item | null = null;
  for (let i = weights.length - 1; i >= 0; i--) head = { weight: weights[i]!, heavy: weights[i]! > 100, next: head };
  return head;
}

// A sum of number fields: int32 fields stay integers; a fraction, NaN, -0
// or a sum past the int32 range takes the ordinary path.
function total(item: Item): number {
  if (item.next === null) return item.weight;
  return item.weight + total(item.next);
}

// Boolean fields and a count of the items they select.
function heavyCount(item: Item): number {
  const here = item.heavy ? 1 : 0;
  return item.next === null ? here : here + heavyCount(item.next);
}

function anyHeavy(item: Item): boolean {
  if (item.heavy) return true;
  return item.next === null ? false : anyHeavy(item.next);
}

// The first weight above 1000, or -1.
function firstAbove(item: Item): number {
  if (item.weight > 1000) return item.weight;
  return item.next === null ? -1 : firstAbove(item.next);
}

// The length of a list: a cycle overflows the stack.
function length(item: Item): number {
  return item.next === null ? 1 : 1 + length(item.next);
}

// A plain tail call around a cycle until a weight is found.
function find(item: Item, weight: number, steps: number): number {
  if (item.weight === weight) return steps;
  return steps > 100 ? -1 : find(item.next!, weight, steps + 1);
}

interface Pair {
  a: number;
  b: number;
}

function sumPair(p: Pair): number {
  return p.a + p.b;
}

// A record parameter next to number parameters, and mutual recursion.
function evenWeight(item: Item, depth: number): number {
  return item.next === null ? depth : oddWeight(item.next, depth + item.weight);
}
function oddWeight(item: Item, depth: number): number {
  return item.next === null ? -depth : evenWeight(item.next, depth - item.weight);
}

// An optional field (`next?:`) and a class instance stay on the ordinary path.
interface Link {
  value: number;
  next?: Link;
}
function linkSum(link: Link): number {
  return link.next === undefined ? link.value : link.value + linkSum(link.next);
}
class Node {
  readonly value: number;
  readonly next: Node | null;
  constructor(value: number, next: Node | null) {
    this.value = value;
    this.next = next;
  }
}
function nodeSum(node: Node): number {
  return node.next === null ? node.value : node.value + nodeSum(node.next);
}

// A record converted from an untyped value into a narrower record type is
// a view of the original: its fields are the original's.
type Measured = { label: string; hi: number; open: boolean; lo: number };
type Span = { lo: number; hi: number };
function spanSum(span: Span, n: number): number {
  return n === 0 ? span.lo : span.hi + spanSum(span, n - 1);
}

function attempt(label: string, run: () => number | boolean): void {
  try {
    console.log(label, run());
  } catch (e) {
    console.log(label, e instanceof TypeError, e instanceof RangeError, (e as Error).message);
  }
}

for (const depth of [0, 1, 4, 10, 16]) {
  const tree = build(depth);
  console.log("tree", depth, count(tree), countRight(tree));
}

const cases: [string, number[]][] = [
  ["small", [1, 2, 3, 4, 5]],
  ["negative", [-5, 7, -2147483648, 2147483647]],
  ["past int32", [2147483647, 1, 2]],
  ["below int32", [-2147483648, -1]],
  ["large", [1e9, 1e9, 1e9, 1e9]],
  ["fraction", [1, 2.5, 3]],
  ["nan", [1, NaN, 2]],
  ["infinity", [1, Infinity, -Infinity]],
  ["minus zero", [-0]],
  ["minus zero sum", [-0, -0]],
  ["zero sum", [5, -5]],
  ["beyond int32 field", [4294967296, -4294967295]],
  ["heavy", [150, 20, 300, 1001]],
];
for (const [label, weights] of cases) {
  const head = list(weights)!;
  const t = total(head);
  console.log(label, t, Object.is(t, -0), heavyCount(head), anyHeavy(head), evenWeight(head, 0), firstAbove(head));
}

const shallow = list(new Array<number>(500).fill(3))!;
console.log("shallow", length(shallow), total(shallow));

const ring: Item = { weight: 1, heavy: false, next: null };
let tail = ring;
for (let i = 2; i <= 10; i++) {
  const item: Item = { weight: i, heavy: false, next: null };
  tail.next = item;
  tail = item;
}
tail.next = ring;
console.log("find", find(ring, 7, 0), find(ring, 11, 0));
attempt("ring length", () => length(ring));
attempt("ring total", () => total(ring));

console.log("pair", sumPair({ a: 2147483647, b: 1 }), sumPair({ a: 3, b: 4 }), sumPair({ a: 0.5, b: 0.25 }));
console.log("link", linkSum({ value: 1, next: { value: 2, next: { value: 3 } } }));
console.log("node", nodeSum(new Node(1, new Node(2, new Node(2147483647, null)))));
const measured: Measured = { label: "m", hi: 2, open: true, lo: 7 };
const untyped: unknown = measured;
const span = untyped as Span;
span.hi = 3;
console.log("view", spanSum(span, 4), measured.hi, spanSum({ lo: 1, hi: 1 }, 3));
