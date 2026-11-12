// A dividend with side effects is evaluated once on both the integer path
// and the ToInt32 fallback: `(a.push(1) / 2) | 0` appends one element, not
// two, when the push's range is not proven and the conversion falls back to
// the real quotient.
const a: number[] = [];
console.log("push", (a.push(1) / 2) | 0, a.length);

const b: number[] = [4, 5];
console.log("pop", (b.pop()! / 2) | 0, b.length);

const c: number[] = [];
console.log("unshift", (c.unshift(6) / 4) | 0, c.length);

// A proven integer dividend next to a side-effecting one in the same
// expression: each runs once.
let calls: number = 0;
function next(): number {
  calls++;
  return 7;
}
console.log("call", (next() / 2) | 0, calls);
console.log("push-and-call", (a.push(next()) / 2) | 0, a.length, calls);
console.log("shift-left-zero", 0 << (next() / 3), calls);
