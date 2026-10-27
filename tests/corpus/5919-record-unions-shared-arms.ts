// Record unions that share arms: Third = D | A, First = A | B and
// Second = B | C. Only C is cyclic. Every arm of a union whose values the
// cycle collector can visit carries a collector header, and the shared
// arms pass that requirement from Second back through First to Third.
type A = { kind: "a"; v: number };
type B = { kind: "b"; w: number };
type C = { kind: "c"; kids: C[] };
type D = { kind: "d"; label: string };
type Third = D | A;
type First = A | B;
type Second = B | C;

function third(u: Third): string {
  return u.kind === "d" ? u.label : `a${u.v}`;
}

function first(u: First): number {
  return u.kind === "a" ? u.v : u.w;
}

function second(u: Second): number {
  return u.kind === "b" ? u.w : u.kids.length + u.kids.reduce((n, k) => n + second(k), 0);
}

const zs: Third[] = [
  { kind: "d", label: "dee" },
  { kind: "a", v: 7 },
];
console.log(zs.map(third).join(","));

const xs: First[] = [
  { kind: "a", v: 1 },
  { kind: "b", w: 2 },
];
console.log(xs.map(first).join(","));

const leaf: C = { kind: "c", kids: [] };
const ys: Second[] = [
  { kind: "b", w: 3 },
  { kind: "c", kids: [leaf, { kind: "c", kids: [leaf] }] },
];
console.log(ys.map(second).join(","));

// One record held through two unions.
const sharedA: A = { kind: "a", v: 5 };
const sharedB: B = { kind: "b", w: 6 };
const viaThird: Third = sharedA;
const viaFirst: First[] = [sharedA, sharedB];
const viaSecond: Second = sharedB;
console.log(third(viaThird), viaFirst.map(first).join(","), second(viaSecond));

// A cyclic C reachable only through Second, dropped and rebuilt in a loop.
let total = 0;
for (let i = 0; i < 200; i++) {
  const node: C = { kind: "c", kids: [] };
  node.kids.push(node);
  const held: Second[] = [node, { kind: "b", w: i }];
  total += held.length + node.kids.length;
}
console.log("total", total);
