// console.log / util.inspect over CYCLIC recursive-record data: Node's
// exact <ref *N> / [Circular *N] markers — discovery-order numbering,
// persistent ids across re-renders, circular-beats-depth ordering.
import { inspect } from "node:util";

interface TreeNode { label: string; children: TreeNode[] }

// Acyclic recursive-typed data renders like any tree (depth 2 default).
const plain: TreeNode = { label: "root", children: [{ label: "kid", children: [] }] };
console.log(plain);

// The canonical self-reference: <ref *1> { ... [Circular *1] ... }.
const ring: TreeNode = { label: "ring", children: [] };
ring.children.push(ring);
console.log(ring);
console.log(inspect(ring));

// Parent <-> child two-step.
const parent: TreeNode = { label: "p", children: [] };
const child: TreeNode = { label: "c", children: [] };
parent.children.push(child);
child.children.push(parent);
console.log(inspect(parent, { depth: 5 }));

// Circular wins over the depth budget (Node checks seen before depth).
interface Chain { next: Chain | null; tag: string }
const a: Chain = { next: null, tag: "a" };
const b: Chain = { next: null, tag: "b" };
const c: Chain = { next: null, tag: "c" };
a.next = b;
b.next = c;
c.next = a;
console.log(a);
console.log(inspect(a, { depth: null }));

// Two independent cycles under one acyclic root: numbering by discovery.
interface Pair { left: TreeNode; right: TreeNode }
const cyc1: TreeNode = { label: "one", children: [] };
cyc1.children.push(cyc1);
const cyc2: TreeNode = { label: "two", children: [] };
cyc2.children.push(cyc2);
const pair: Pair = { left: cyc1, right: cyc2 };
console.log(pair);

// The SAME object rendered twice keeps one ref id (persistent circular
// map within a single inspect call).
interface Duo { a: TreeNode; b: TreeNode }
const duo: Duo = { a: ring, b: ring };
console.log(inspect(duo, { depth: 4 }));

// Fresh numbering per console.log call.
console.log(ring);

// Checked-dynamic composites share the same circular identity rules.
const dynamic: any = JSON.parse('{"label":"dynamic"}');
dynamic.self = dynamic;
console.log(inspect(dynamic, { depth: null }));
const dynamicArray: any = JSON.parse("[]");
dynamicArray.push(dynamicArray);
console.log(inspect(dynamicArray, { depth: null }));
console.log(inspect({ first: dynamic, second: dynamic }, { depth: null }));
