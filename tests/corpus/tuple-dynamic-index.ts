// A RUNTIME index into a tuple: the element at an integer index in
// [0, arity), undefined for everything else — exactly Node's read of the
// underlying array (a fraction, a negative, NaN, Infinity, or one past the
// end all read undefined). The result joins the element types, so a
// heterogeneous tuple answers a union and a numeric consumer treats a miss
// like a missing array element.

type Vec3 = readonly [number, number, number];

const vec: Vec3 = [10, 20, 30];

function at(i: number): number | undefined {
  return vec[i];
}

for (const i of [0, 1, 2, 3, -1, 1.5, NaN, Infinity]) {
  console.log(i, at(i));
}

const mixed: [string, number, boolean] = ["s", 7, true];
for (const i of [0, 1, 2, 3]) {
  console.log(i, mixed[i]);
}

// A literal index stays the plain positional read.
console.log(vec[0], mixed[1]);

// The asserted form of an index the program guarantees in range.
function sumTriple(i: number, j: number, k: number): number {
  return vec[i]! + vec[j]! + vec[k]!;
}
console.log(sumTriple(0, 1, 2));

// A runtime index into a nested tuple read.
const rows: readonly (readonly [number, string])[] = [
  [1, "a"],
  [2, "b"],
];
function cell(r: number, c: number): number | string | undefined {
  return rows[r]![c];
}
console.log(cell(0, 0), cell(1, 1), cell(0, 2));

// A tuple-typed call receiver evaluates once per read.
let calls = 0;
function make(): Vec3 {
  calls++;
  return [1, 2, 3];
}
let beyond: number = 3;
console.log(make()[1], make()[beyond], calls);

// The read still reaches a destination typed as the element type.
function double(x: number): number {
  return x * 2;
}
console.log(double(vec[1]));

// Arithmetic on a miss is ToNumber(undefined) = NaN, as for a missing array
// element.
function plusOne(i: number): number {
  return vec[i] + 1;
}
console.log(plusOne(1), plusOne(3));

// Records as elements join into a union result.
interface Wide {
  w: number;
}
interface Tall {
  t: string;
}
const recs: [Wide, Tall] = [{ w: 1 }, { t: "t" }];
function pick(i: number): Wide | Tall | undefined {
  return recs[i];
}
for (const i of [0, 1, 2]) {
  const r = pick(i);
  console.log(i, r === undefined ? "missing" : "w" in r ? r.w : r.t);
}

// An optional element type inside the tuple keeps its own arm.
const opts: [number | undefined, number] = [undefined, 4];
function optAt(i: number): number | undefined {
  return opts[i];
}
console.log(optAt(0), optAt(1), optAt(2));

// An index call that rebinds the receiver: JavaScript evaluates the receiver
// before the index, so the read observes the tuple the binding held then.
let active: Vec3 = [1, 2, 3];
const replacement: Vec3 = [4, 5, 6];
function swapKey(): number {
  active = replacement;
  return 1;
}
console.log(active[swapKey()], active[1], active[0]);
