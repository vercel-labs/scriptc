import type { ProgramLifetime } from "@scriptc/types";

// Arrays whose elements need no release when the array is destroyed:
// ProgramLifetime instances (plain and `| undefined` elements), numbers and
// booleans. They are created and dropped by literals, push, slice, filter,
// map, concat, splice, sort and spread, kept in fields, closures and maps,
// nested in other arrays, given holes and far indices, and
// mixed with arrays of ordinary objects, whose elements are released.

class Node implements ProgramLifetime {
  readonly id: number;
  next: Node | undefined = undefined;
  readonly kids: Node[] = [];
  constructor(id: number) {
    this.id = id;
  }
}

class Leaf extends Node {
  weight = 2;
}

class Temp {
  readonly label: string;
  constructor(label: string) {
    this.label = label;
  }
}

const nodes: Node[] = [];
for (let i = 0; i < 40; i++) nodes.push(i % 3 === 0 ? new Leaf(i) : new Node(i));
for (let i = 1; i < nodes.length; i++) nodes[i - 1]!.next = nodes[i];
for (const n of nodes) for (let k = 1; k <= n.id % 4; k++) n.kids.push(nodes[(n.id + k) % 40]!);

function ids(list: readonly (Node | undefined)[]): string {
  return list.map((n) => (n === undefined ? "-" : String(n.id))).join(",");
}

// Temporary arrays from every array operation, dropped at once.
let total = 0;
for (let round = 0; round < 200; round++) {
  const picked = nodes.filter((n) => n.id % 7 === round % 7);
  const mapped = picked.map((n) => n.next);
  const joined = picked.concat(nodes.slice(round % 10, (round % 10) + 3));
  const spliced = joined.slice();
  spliced.splice(1, 2, nodes[round % 40]!);
  const sorted = [...spliced].sort((a, b) => b.id - a.id);
  const optional: (Node | undefined)[] = [nodes[round % 40], undefined, mapped[0]];
  total += picked.length + mapped.length + joined.length + sorted.length + optional.length;
  if (round % 50 === 0) console.log(round, ids(sorted), ids(optional), ids(mapped));
}
console.log("temporaries", total);

// Numbers and booleans.
let sum = 0;
for (let round = 0; round < 100; round++) {
  const values = [round, round * 2, round * 3];
  const flags = values.map((v) => v % 2 === 0);
  sum += values.reduce((a, b) => a + b, 0) + flags.filter((f) => f).length;
}
console.log("scalars", sum);

// Holes and far indices keep the full teardown.
const holey: Node[] = [];
holey[3] = nodes[3]!;
holey[0] = nodes[0]!;
const far: Node[] = [nodes[1]!];
far[4_000_000_000] = nodes[2]!;
console.log("holey", holey.length, 1 in holey, ids([holey[0], holey[3]]));
console.log("far", far.length, far[4_000_000_000]?.id, far[0]?.id);

// Kept arrays: a field, a closure, a map, an array of arrays.
class Holder {
  items: Node[] = [];
}
const holder = new Holder();
for (let i = 0; i < 5; i++) holder.items = nodes.slice(i, i + 4);
const later = ((kept: Node[]) => () => ids(kept))(nodes.filter((n) => n instanceof Leaf));
const byKey = new Map<string, Node[]>();
for (let i = 0; i < 10; i++) byKey.set(`k${i % 3}`, nodes.slice(i, i + 2));
const nested: Node[][] = [];
for (let i = 0; i < 6; i++) nested.push(nodes.slice(i, i + i));
nested.splice(2, 3);
console.log("field", ids(holder.items));
console.log("closure", later());
console.log("map", [...byKey].map(([k, v]) => `${k}:${ids(v)}`).join(" "));
console.log("nested", nested.map((list) => ids(list)).join(" | "));

// Arrays of ordinary objects still release their elements.
let labels = "";
for (let round = 0; round < 50; round++) {
  const temps = [new Temp(`t${round}`), new Temp(`u${round}`)];
  const kept = temps.filter((t) => t.label.endsWith("0"));
  labels += kept.map((t) => t.label).join("");
}
console.log("objects", labels);

// Kids lists reached through the graph.
let walked = 0;
for (let at: Node | undefined = nodes[0]; at !== undefined; at = at.next)
  walked += at.kids.filter((k) => k.id > at!.id).length;
console.log("walked", walked, nodes[39]!.kids.length, (nodes[3] as Leaf).weight);
