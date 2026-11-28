// A JSDoc record's array field is the array the returned closure pushes
// into: JavaScript keeps ONE array there, so the field sees every later
// push and a write through the field is visible to the closure.
'use strict';

/** @returns {{ out: string[], push: () => void }} */
function make() {
  const out = [];
  const push = () => { out.push("x"); };
  return { out, push };
}
const r = make();
r.push();
console.log(r.out.length);
r.push();
r.push();
console.log(r.out.length, r.out.join(","));

// The same for a record that collects numbers, and a write through the
// returned field is the array the closure reads.
/** @returns {{ rows: number[], add: (n: number) => void, head: () => number }} */
function collector() {
  const rows = [];
  const add = (n) => { rows.push(n); };
  const head = () => (rows.length > 0 ? rows[0] : -1);
  return { rows, add, head };
}
const c = collector();
console.log(c.rows.length, c.head());
c.add(4);
c.add(9);
console.log(c.rows.length, c.rows.join(","), c.head());
c.rows.push(7);
console.log(c.rows.join(","), c.head());

// An explicitly untyped array in an annotated record keeps one array too.
/** @returns {{ seen: string[], note: (s: string) => void }} */
function notes() {
  /** @type {any[]} */
  const seen = [];
  const note = (s) => { seen.push(s); };
  return { seen, note };
}
const n = notes();
n.note("a");
n.note("b");
n.note("c");
console.log(n.seen.length, n.seen.join("+"));
