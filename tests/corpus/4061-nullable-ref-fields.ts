// Class fields typed `C | null` / `C | undefined` hold the instance pointer
// itself (no union box). This pins every way such a field is read and
// written: tests, narrowing, `??`, `?.`, equality, truthiness, whole-value
// escapes (arrays, calls, returns, closures), reassignment and self-
// assignment, constructor parameters that are and are not projection-only,
// subclass instances in base-typed fields, shared-field reads across a
// class union, `any` views (reads and writes through the dynamic bridge),
// JSON, cycles for the collector, and a long chain's teardown.

class Node {
  next: Node | null = null;
  prev?: Node;
  readonly id: number;
  constructor(id: number) {
    this.id = id;
  }
}

const a = new Node(1);
const b = new Node(2);
console.log("init", a.next === null, a.prev === undefined, a.next, a.prev);
a.next = b;
b.prev = a;
console.log("linked", a.next === b, a.next?.id, b.prev?.id, b.next?.id, a.prev?.id);
console.log("nullish", (a.next ?? b).id, (b.next ?? a).id, b.prev?.id ?? -1, a.prev?.id ?? -1);
console.log("truthy", !!a.next, !!b.next, !!b.prev, !!a.prev, a.next ? "yes" : "no", b.next ? "yes" : "no");
console.log("eq", a.next === b.next, a.next !== b, b.prev === a, a.prev === b.next as unknown);

// Whole-value escapes: arrays, calls, returns, closures.
function describe(n: Node | null): string {
  return n === null ? "null" : `#${n.id}`;
}
function pick(n: Node, first: boolean): Node | null {
  return first ? n.next : null;
}
const held: (Node | null)[] = [a.next, b.next, pick(a, true), pick(a, false)];
console.log("held", held.map(describe).join(","), describe(a.next), describe(b.next));
const getNext = (): Node | null => a.next;
a.next = null;
console.log("closure", describe(getNext()), describe(held[0]!), held[0] === b);
a.next = b;
console.log("closure2", describe(getNext()));

// Reassignment releases the old instance; self-assignment keeps it alive.
let chain = new Node(10);
chain.next = new Node(11);
chain.next.next = new Node(12);
chain.next = chain.next;
chain.next.next = chain.next.next;
console.log("self", chain.next?.id, chain.next?.next?.id);
chain.next = chain.next?.next ?? null;
console.log("skip", chain.next?.id, chain.next?.next);
chain = new Node(20);
console.log("fresh", chain.next, chain.id);

// Mutation inside `??` defaults and equality operands.
const m = new Node(30);
m.next = null;
const viaDefault = m.next ?? ((m.next = new Node(31)), m.next);
console.log("default", viaDefault.id, m.next?.id, viaDefault === m.next);
const old = m.next;
function swap(n: Node): Node | null {
  n.next = new Node(32);
  return n.next;
}
console.log("eq-mutation", m.next === swap(m), old === m.next, m.next?.id, old?.id);

// Constructor parameters: projection-only stores, and stores that also
// escape the parameter elsewhere.
class Tree {
  readonly left: Tree | null;
  readonly right: Tree | null;
  constructor(left: Tree | null, right: Tree | null) {
    this.left = left;
    this.right = right;
  }
  count(): number {
    return 1 + (this.left === null ? 0 : this.left.count()) + (this.right?.count() ?? 0);
  }
}
const seen: (Tree | null)[] = [];
class Logged {
  readonly child: Tree | null;
  constructor(child: Tree | null) {
    seen.push(child);
    this.child = child;
  }
}
function build(depth: number): Tree {
  return depth === 0 ? new Tree(null, null) : new Tree(build(depth - 1), build(depth - 1));
}
let total = 0;
for (let i = 0; i < 200; i++) total += build(8).count();
const logged = [new Logged(build(2)), new Logged(null)];
console.log("trees", total, logged[0]!.child?.count(), logged[1]!.child, seen.length, seen[0] === logged[0]!.child);

// Subclass instances in base-typed fields; virtual calls through them.
class Shape {
  parent: Shape | null = null;
  area(): number {
    return 0;
  }
}
class Square extends Shape {
  readonly side: number;
  constructor(side: number) {
    super();
    this.side = side;
  }
  area(): number {
    return this.side * this.side;
  }
}
class Circle extends Shape {
  readonly r: number;
  constructor(r: number) {
    super();
    this.r = r;
  }
  area(): number {
    return Math.round(Math.PI * this.r * this.r);
  }
}
const sq = new Square(3);
const ci = new Circle(2);
sq.parent = ci;
ci.parent = new Square(5);
console.log("virtual", sq.parent.area(), sq.parent?.parent?.area(), ci.parent?.parent?.area() ?? "none");

// Shared-field reads across a union of classes.
class Leaf {
  readonly kind = "leaf";
  owner: Branch | null = null;
}
class Branch {
  readonly kind = "branch";
  owner: Branch | null = null;
}
const root = new Branch();
const owned = new Leaf();
const inner = new Branch();
owned.owner = root;
inner.owner = root;
const items: (Leaf | Branch)[] = [owned, inner, new Leaf()];
for (const item of items) console.log("owner", item.kind, item.owner === root, item.owner?.kind ?? "none");

// `any` views: reads, writes, JSON, and console output.
class Box {
  inner: Box | null = null;
  readonly tag: string;
  constructor(tag: string) {
    this.tag = tag;
  }
}
const outer = new Box("outer");
outer.inner = new Box("inner");
const view: any = outer;
console.log("any-read", view.inner.tag, view.inner.inner);
// Read through a helper: TypeScript's assignment narrowing of `outer.inner`
// does not see writes made through the `any` view.
function innerOf(box: Box): Box | null {
  return box.inner;
}
view.inner = new Box("replaced");
console.log("any-write", innerOf(outer)?.tag, innerOf(outer)?.inner);
view.inner = null;
console.log("any-null", innerOf(outer), innerOf(outer) === null);
outer.inner = new Box("again");
console.log("json", JSON.stringify(view));
console.log(outer);

// Local copies own their payload: a copied field read survives a later
// store to the field, and copies of other bindings keep scalar arms intact.
const keeper = new Node(40);
keeper.next = new Node(41);
let kept: Node | null = keeper.next;
keeper.next = null;
console.log("kept", describe(kept), keeper.next);
kept = keeper.next;
console.log("kept2", describe(kept));
function mixed(flag: number): string {
  const first: string | number | undefined = flag > 1 ? "two" : flag > 0 ? 1 : undefined;
  let copy = first;
  let out = typeof copy === "string" ? copy.toUpperCase() : String(copy);
  const second: string | number | undefined = flag > 0 ? -0 : `s${flag}`;
  copy = second;
  out += "|" + (typeof copy === "number" ? String(Object.is(copy, -0)) : copy);
  copy = first;
  return out + "|" + (copy ?? "none");
}
console.log("mixed", mixed(0), mixed(1), mixed(2));

// Cycles through nullable fields are collected; output stays stable.
let survivors = 0;
for (let i = 0; i < 20000; i++) {
  const x = new Node(i);
  const y = new Node(i + 1);
  x.next = y;
  y.next = x;
  y.prev = x;
  if (x.next.next === x) survivors++;
}
console.log("cycles", survivors);

// A long chain tears down without exhausting the native stack.
let head: Node | null = null;
for (let i = 0; i < 300000; i++) {
  const n = new Node(i);
  n.next = head;
  head = n;
}
let length = 0;
for (let p: Node | null = head; p !== null; p = p.next) length++;
console.log("chain", length, head?.id, head?.next?.id);
head = null;
console.log("done", head);
