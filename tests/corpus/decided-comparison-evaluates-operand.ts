// A comparison with `undefined` or `null` whose answer the types decide
// still evaluates its other operand: the call runs, the getter runs, the
// object is constructed.
let calls = 0;
function count(): number {
  calls++;
  console.log("count called");
  return calls;
}
function label(): string {
  calls++;
  return "l";
}

// Strict comparisons, the operand on either side.
console.log(count() === undefined, calls);
console.log(count() !== undefined, calls);
console.log(undefined === count(), calls);
console.log(count() === null, count() !== null, calls);
if (count() !== undefined) console.log("then", calls);

// Loose comparisons.
console.log(label() == null, calls);
console.log(label() != null, calls);
console.log(null == label(), calls);
console.log(label() == undefined, label() != undefined, calls);

// A method, a getter and a constructor.
class Counter {
  n = 0;
  static made = 0;
  constructor() {
    Counter.made++;
  }
  next(): number {
    this.n++;
    return this.n;
  }
  get bumped(): number {
    this.n += 10;
    return this.n;
  }
}
const c = new Counter();
console.log(c.next() === undefined, c.n);
console.log(c.bumped !== undefined, c.n);
console.log(new Counter() === null, Counter.made);
console.log(new Counter() != null, Counter.made);

// Where the comparison is a condition or an operand.
const picked = count() === undefined ? "missing" : "present";
console.log(picked, calls);
while (count() === undefined) console.log("never");
console.log(calls);
for (let i = 0; count() !== undefined && i < 2; i++) console.log("turn", i, calls);
const both = count() !== undefined && count() !== null;
console.log(both, calls);
const either = count() === undefined || count() === null;
console.log(either, calls);
console.log(!(count() === undefined), calls);

// Other operands with effects: an awaited call, a sequence, a mutating
// array method, an assignment, and Object.is.
async function later(): Promise<number> {
  calls++;
  return calls;
}
async function main(): Promise<void> {
  const before = calls;
  console.log((await later()) === undefined, calls - before);
  console.log((label(), label()) === undefined, calls - before);
  const values = [1, 2];
  console.log(values.push(3) === undefined, values.length);
  console.log(values.reverse() !== undefined, values[0]);
  let assigned = "";
  console.log((assigned = label()) === undefined, assigned, calls - before);
  console.log(Object.is(label(), undefined), calls - before);
}
main();

// A read of a binding or a field has no effect to keep.
const plain = 3;
const held = { n: 4 };
console.log(plain === undefined, held.n !== undefined, plain != null);
