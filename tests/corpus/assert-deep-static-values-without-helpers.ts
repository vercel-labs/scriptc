// assert.deepStrictEqual over statically typed values that have no
// synthesized static comparison — a Date, a RegExp, a class instance, an
// index-signature record, a Set of object members, and a record holding a
// Date — crosses both operands into the checked-dynamic tree, whose strict
// walk applies Node's constructor gate and built-in arms. Statically typed
// operands that do have a comparison keep their static helper.
import assert from "node:assert";

function outcome(f: () => void): string {
  try {
    f();
    return "pass";
  } catch (e) {
    return e instanceof Error ? e.message : "not an Error";
  }
}

class Point {
  x: number;
  y: number;
  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }
}

const counts: Record<string, number> = { a: 1, b: 2 };
const countsSame: Record<string, number> = { b: 2, a: 1 };
const countsDifferent: Record<string, number> = { a: 1, b: 3 };
console.log("A", outcome(() => assert.deepStrictEqual(counts, countsSame)));
console.log("B", outcome(() => assert.deepStrictEqual(counts, countsDifferent)));

console.log("C", outcome(() => assert.deepStrictEqual(new Date(0), new Date(0))));
console.log("D", outcome(() => assert.deepStrictEqual(new Date(0), new Date(1))));
console.log("E", outcome(() => assert.deepStrictEqual(/a/g, /a/g)));
console.log("F", outcome(() => assert.deepStrictEqual(/a/g, /a/i)));

console.log("G", outcome(() => assert.deepStrictEqual(new Point(1, 2), new Point(1, 2))));
console.log("H", outcome(() => assert.deepStrictEqual(new Point(1, 2), new Point(1, 3))));

console.log("I", outcome(() => assert.deepStrictEqual(new Set([{ a: 1 }]), new Set([{ a: 1 }]))));
console.log("J", outcome(() => assert.deepStrictEqual(new Set([{ a: 1 }]), new Set([{ a: 2 }]))));

const stamped = { at: new Date(0), label: "x" };
const stampedSame = { at: new Date(0), label: "x" };
const stampedDifferent = { at: new Date(1), label: "x" };
console.log("K", outcome(() => assert.deepStrictEqual(stamped, stampedSame)));
console.log("L", outcome(() => assert.deepStrictEqual(stamped, stampedDifferent)));
