// Loops bounded by a typed array's length whose bindings change while they
// run, that leave early, or that run at module level, in generators and in
// async functions. Each keeps the reads, writes and bounds the source names
// on every iteration.

function swapBound(a: Float64Array, b: Float64Array, out: Float64Array): number {
  let n = 0;
  for (let i = 0; i < a.length; i++) {
    out[i] = a[i]! + b[i]!;
    n++;
    if (i === 2) a = b;
  }
  return n;
}

function swapOperand(a: Int16Array, b: Int16Array, out: Int16Array): void {
  for (let i = 0; i < out.length; i++) {
    out[i] = a[i]! * 3;
    if (i === 3) a = b;
  }
}

function closureSwap(a: Uint16Array, b: Uint16Array, out: Uint16Array): void {
  const swap = (): void => {
    out = b;
  };
  for (let i = 0; i < out.length; i++) {
    out[i] = a[i]! + 1000;
    if (i === 1) swap();
  }
}

function firstAbove(values: Float32Array, limits: Float32Array): number {
  for (let i = 0; i < values.length; i++) {
    if (values[i]! > limits[i]!) return i;
  }
  return -1;
}

function copyUntilZero(src: Uint8Array, out: Uint8Array): number {
  let copied = 0;
  for (let i = 0; i < src.length; i++) {
    if (src[i] === 0) break;
    out[i] = src[i]!;
    copied++;
  }
  return copied;
}

function checkedScale(src: Int32Array, out: Int32Array): void {
  for (let i = 0; i < src.length; i++) {
    if (src[i]! < 0) throw new RangeError(`negative at ${i}: ${src[i]}`);
    out[i] = src[i]! * 2;
  }
}

function fromList(values: number[], out: Float64Array): void {
  for (let i = 0; i < values.length; i++) {
    out[i] = values[i]! / 2;
    if (values.length < 6) values.push(i * 10);
  }
}

function rows(table: Uint32Array[], totals: Uint32Array): void {
  for (let r = 0; r < table.length; r++) {
    const row = table[r]!;
    let sum = 0;
    for (let c = 0; c < row.length; c++) sum += row[c]! * (c + 1);
    totals[r] = sum;
  }
}

function* pairs(a: Int8Array, b: Int8Array): Generator<number> {
  for (let i = 0; i < a.length; i++) yield a[i]! * b[i]!;
}

async function addLater(a: Float64Array, b: Float64Array, out: Float64Array): Promise<void> {
  for (let i = 0; i < out.length; i++) {
    out[i] = a[i]! + b[i]!;
    if (i % 2 === 0) await null;
  }
}

const a = new Float64Array([1, 2, 3, 4, 5, 6]);
const b = new Float64Array([10, 20, 30]);
const sum = new Float64Array(8);
console.log("swap bound", swapBound(a, b, sum), sum.join(","));

const s16 = new Int16Array([1, -2, 3, -4, 5, -6, 7]);
const t16 = new Int16Array([100, 200, 300, 400, 500, 600]);
const o16 = new Int16Array(7);
swapOperand(s16, t16, o16);
console.log("swap operand", o16.join(","));

const u = new Uint16Array([5, 6, 7, 8]);
const other = new Uint16Array(2);
const first = new Uint16Array(4);
closureSwap(u, other, first);
console.log("closure swap", first.join(","), other.join(","));

const values = new Float32Array([0.5, 1.5, 2.5, 3.5]);
console.log("first above", firstAbove(values, new Float32Array([1, 1, 1, 1])));
console.log("first above short", firstAbove(values, new Float32Array([9])));
console.log("first above none", firstAbove(values, new Float32Array([9, 9, 9, 9])));

const text = new Uint8Array([72, 105, 33, 0, 88]);
const copy = new Uint8Array(2);
console.log("copy", copyUntilZero(text, copy), copy.join(","));

const ints = new Int32Array([4, 8, -15, 16]);
const doubled = new Int32Array(4);
try {
  checkedScale(ints, doubled);
} catch (error) {
  console.log((error as Error).name, (error as Error).message, doubled.join(","));
}

const list = [3, 5];
const halves = new Float64Array(5);
fromList(list, halves);
console.log("from list", list.join(","), halves.join(","));

const table = [new Uint32Array([1, 2, 3]), new Uint32Array([]), new Uint32Array([4294967295, 1])];
const totals = new Uint32Array(4);
rows(table, totals);
console.log("rows", totals.join(","));

console.log("pairs", [...pairs(new Int8Array([1, -2, 3, 127]), new Int8Array([4, 5, -6]))].join(","));

const left = new Float64Array([0.25, 0.5, 0.75, 1]);
const right = new Float64Array([1, 2, 3, 4, 5]);
const later = new Float64Array(5);
const pending = addLater(left, right, later);
console.log("before await", later.join(","));

// Module-level bindings, including one a loop body reassigns.
let source = new Uint8Array([9, 8, 7, 6, 5]);
const replacement = new Uint8Array([1, 2]);
const target = new Uint8Array(5);
for (let i = 0; i < source.length; i++) {
  target[i] = source[i]! + 100;
  if (i === 1) source = replacement;
}
console.log("module", target.join(","), source.join(","));

pending.then(() => console.log("after await", later.join(",")));
