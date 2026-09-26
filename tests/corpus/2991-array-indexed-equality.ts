// Ordinary primitive reads compare without boxes, but preserve JS absence,
// NaN, signed zero, numeric properties, evaluation order and owned snapshots.
function numbers(a: number[], b: number[], i: number, j: number): void {
  console.log(a[i] === b[j], a[i] !== b[j]);
}
function strings(a: string[], b: string[], i: number, j: number): void {
  console.log(a[i] === b[j], a[i] !== b[j]);
}
function booleans(a: boolean[], b: boolean[], i: number, j: number): void {
  console.log(a[i] === b[j], a[i] !== b[j]);
}
const a = [0, -0, NaN, Infinity, 3];
const b = [0, -0, NaN, Infinity, 4];
const indices = [0, 1, 2, 3, 4, 8, -1, 1.5, NaN, Infinity, 4294967295];
a[-1] = 7; b[-1] = 7;
a[1.5] = 9; b[1.5] = 10;
a[NaN] = 11; b[NaN] = 11;
for (const i of indices) for (const j of indices) numbers(a, b, i, j);
const empty: number[] = [];
const sparse: number[] = [];
sparse[1] = empty[0];
sparse[2] = 0;
sparse[3] = NaN;
for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) numbers(sparse, sparse, i, j);
for (let i = -1; i < 5; i++) for (let j = -1; j < 5; j++) {
  strings(["", "é", "┌", "same"], ["", "e", "┌", "same"], i, j);
  booleans([false, true], [false, true], i, j);
}
let trace = "";
const text = ["left".repeat(20)];
function receiver(label: string): string[] { trace += label; return text; }
function index(label: string): number { trace += label; return 0; }
function replace(): string[] { trace += "R"; text[0] = "right".repeat(20); return text; }
console.log(receiver("L")[index("i")] === replace()[index("j")], trace);
console.log(text[0]);
function fail(): number { trace += "!"; throw new Error("index"); }
try { console.log(receiver("A")[index("a")] === receiver("B")[fail()]); }
catch (error) { console.log(error instanceof Error, trace); }
// Repeated conditions exercise hidden-local cleanup on continue/break and
// exceptions; both backends run under the RC audit as well as plain mode.
let count = 0;
for (let i = 0; i < 500; i++) {
  const x = ["x".repeat(i % 17 + 1)];
  const y = ["x".repeat(i % 17 + 1)];
  if (x[0] !== y[0]) break;
  if (x[1] === y[1]) { count++; continue; }
}
console.log("count", count);
let n = 0;
while (["a".repeat(++n)][0] === ["a".repeat(n)][0]) if (n === 40) break;
console.log("condition", n);
