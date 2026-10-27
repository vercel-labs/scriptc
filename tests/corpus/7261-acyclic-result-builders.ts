// Records built by functions that return object literals, as tree and list
// builders are written. The backend gives such a function a result-slot
// entry that writes the literal's fields into a caller's frame storage, and
// those stores do not make the record's fields mutable: a type no store
// changes after construction stays acyclic and needs no cycle-collector
// header. This pins what such programs print: rebuilt trees, a shared
// subtree (a DAG), a builder whose result the caller only projects (so the
// entry runs), a list longer than the runtime's teardown depth budget, and
// a record type the program writes after construction, whose rings only
// the collector frees. The sanitized lane asserts every object is freed.

interface Node {
  value: number;
  left: Node | null;
  right: Node | null;
}

function leaf(value: number): Node {
  return { value, left: null, right: null };
}

function branch(value: number, left: Node | null, right: Node | null): Node {
  return { value, left, right };
}

function tree(depth: number, value: number): Node {
  return depth === 0 ? leaf(value) : branch(value, tree(depth - 1, value * 2), tree(depth - 1, value * 2 + 1));
}

function sum(node: Node | null): number {
  return node === null ? 0 : node.value + sum(node.left) + sum(node.right);
}

let total = 0;
for (let generation = 0; generation < 8; generation++) total += sum(tree(8, generation + 1));
console.log("trees", total);

// A subtree shared by both branches is released once.
const shared = tree(3, 1);
const dag = branch(0, shared, shared);
console.log("dag", sum(dag), JSON.stringify(branch(1, leaf(2), null)));

// Only projected: the result lives in the caller's frame, which releases
// the subtree it holds.
const top = branch(5, tree(2, 1), null);
console.log("top", top.value, sum(top.left), top.right === null);

interface Cell {
  n: number;
  next: Cell | null;
}

function cons(n: number, next: Cell | null): Cell {
  return { n, next };
}

let list: Cell | null = null;
for (let i = 0; i < 5000; i++) list = cons(i, list);
let length = 0;
let last = -1;
for (let c = list; c !== null; c = c.next) {
  length++;
  last = c.n;
}
console.log("list", length, last);
list = null;

// A record type written after construction keeps its cycle-collector
// header: these rings are garbage only the collector can free.
interface Ring {
  id: number;
  next: Ring | null;
}

function ring(id: number, next: Ring | null): Ring {
  return { id, next };
}

let ids = 0;
for (let i = 0; i < 200; i++) {
  const a = ring(i, null);
  const b = ring(i + 1, a);
  a.next = b;
  ids += a.next.id + b.next!.id;
}
console.log("rings", ids);
