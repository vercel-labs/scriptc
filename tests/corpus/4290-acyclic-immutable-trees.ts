// Classes and records whose reference fields are only written during
// construction can never be part of a cycle: a new object can only point to
// objects that already existed. scriptc allocates them without the cycle
// collector's header and never buffers them as cycle candidates. This pins
// the behavior that layout must preserve: shared subtrees (a DAG, not a
// tree), deep chains torn down without recursion overflow, nullable and
// optional self references, derived classes initializing inherited fields
// through super(), constructor field reads, and records built by literals
// and spreads. The sanitized lane asserts every object is freed.
class TreeNode {
  readonly left: TreeNode | null;
  readonly right: TreeNode | null;
  constructor(left: TreeNode | null, right: TreeNode | null) {
    this.left = left;
    this.right = right;
  }
  check(): number {
    return 1 + (this.left === null ? 0 : this.left.check()) + (this.right === null ? 0 : this.right.check());
  }
}
function build(depth: number): TreeNode {
  return depth === 0 ? new TreeNode(null, null) : new TreeNode(build(depth - 1), build(depth - 1));
}
let checks = 0;
for (let i = 0; i < 200; i++) checks += build(6).check();
console.log("trees", checks);

// Shared subtrees: one child reachable twice, released exactly once.
function shared(depth: number): TreeNode {
  let node = new TreeNode(null, null);
  for (let i = 0; i < depth; i++) node = new TreeNode(node, node);
  return node;
}
console.log("dag", shared(20).check());

// A long chain: teardown of the head must not recurse once per node.
class Cons {
  readonly head: number;
  readonly tail: Cons | undefined;
  constructor(head: number, tail?: Cons) {
    this.head = head;
    this.tail = tail;
  }
}
let list: Cons | undefined;
for (let i = 0; i < 200000; i++) list = new Cons(i, list);
let sum = 0;
let length = 0;
for (let cur = list; cur !== undefined; cur = cur.tail) {
  sum += cur.head;
  length++;
}
console.log("chain", length, sum);
list = undefined;
console.log("chain released", list === undefined);

// Derived constructors initialize inherited and own fields after super().
abstract class Shape {
  readonly parent: Shape | null;
  constructor(parent: Shape | null) {
    this.parent = parent;
  }
  abstract area(): number;
  depth(): number {
    return this.parent === null ? 0 : 1 + this.parent.depth();
  }
}
class Square extends Shape {
  readonly side: number;
  readonly sibling: Shape | null;
  constructor(parent: Shape | null, side: number, sibling: Shape | null) {
    super(parent);
    this.side = side;
    this.sibling = sibling;
  }
  area(): number {
    return this.side * this.side + (this.sibling === null ? 0 : this.sibling.area());
  }
}
class Circle extends Shape {
  readonly r: number;
  constructor(parent: Shape | null, r: number) {
    super(parent);
    this.r = r;
  }
  area(): number {
    return Math.round(Math.PI * this.r * this.r);
  }
}
let shape: Shape = new Circle(null, 1);
for (let i = 0; i < 50; i++) shape = i % 2 === 0 ? new Square(shape, i, new Circle(shape, i)) : new Circle(shape, i);
console.log("shapes", shape.depth(), shape.area());

// A constructor reading its own fields while initializing others.
class Pair {
  readonly first: Pair | null;
  readonly second: Pair | null;
  constructor(first: Pair | null) {
    this.first = first;
    this.second = this.first;
  }
}
let pair = new Pair(null);
for (let i = 0; i < 1000; i++) pair = new Pair(pair);
let pairs = 0;
for (let cur: Pair | null = pair; cur !== null; cur = cur.second) pairs++;
console.log("pairs", pairs, pair.first === pair.second);

// Records: literals and spreads only ever point at older records.
interface Link {
  value: number;
  next?: Link;
  meta: { label: string; prev: Link | null };
}
let chain: Link = { value: 0, meta: { label: "root", prev: null } };
for (let i = 1; i < 2000; i++) chain = { value: i, next: chain, meta: { label: `n${i}`, prev: chain.next ?? null } };
const copy: Link = { ...chain, value: -1 };
let total = 0;
for (let cur: Link | undefined = copy; cur !== undefined; cur = cur.next) total += cur.value;
console.log("records", total, copy.next === chain.next, copy.meta.label);

// Long-lived immutable structure alongside churn.
const keep = build(10);
for (let i = 0; i < 50; i++) build(8);
console.log("long", keep.check());
