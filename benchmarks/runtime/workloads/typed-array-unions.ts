// Loops over unions of typed arrays: a cache-shaped worker picks its index
// arrays by capacity, so the array a kernel receives is one of several widths
// and every element read or write has to find the arm first. The kernels fill,
// scale, sum and count over the arrays the worker built.

type Indexes = Uint8Array | Uint16Array | Uint32Array;
type IndexesOrList = Uint8Array | Uint16Array | Uint32Array | number[];

function indexArray(max: number): Indexes {
  if (max <= 2 ** 8) return new Uint8Array(max);
  if (max <= 2 ** 16) return new Uint16Array(max);
  return new Uint32Array(max);
}

function indexArrayOrList(max: number, list: boolean): IndexesOrList {
  if (!list) return indexArray(max);
  const values: number[] = new Array<number>(max).fill(0);
  return values;
}

function fill(target: Indexes, base: number): void {
  for (let i = 0; i < target.length; i++) target[i] = base + i;
}

function scaleBy(target: Indexes, factor: number): void {
  for (let i = 0; i < target.length; i++) target[i] = target[i]! * factor;
}

function sum(values: Indexes): number {
  let total = 0;
  for (let i = 0; i < values.length; i++) total += values[i]!;
  return total;
}

function countAtLeast(values: Indexes, limit: number): number {
  let count = 0;
  for (let i = 0; i < values.length; i++) if (values[i]! >= limit) count++;
  return count;
}

function listSum(values: IndexesOrList): number {
  let total = 0;
  for (let i = 0; i < values.length; i++) total += values[i] ?? 0;
  return total;
}

const scale = Number(process.argv[2] ?? "1");
const n = 1 << 16;
// One array per arm: a byte-max index cache, a short one and a wide one.
const arrays: Indexes[] = [indexArray(2 ** 8), indexArray(2 ** 12), indexArray(n * 2)];
const mixed: IndexesOrList[] = [indexArray(n), indexArrayOrList(n, true)];

const rounds = Math.round(800 * scale);
let sumTotal = 0;
let countTotal = 0;
let listTotal = 0;
for (let r = 0; r < rounds; r++) {
  const target = arrays[r % arrays.length]!;
  fill(target, r & 255);
  scaleBy(target, 1 + (r & 3) / 4);
  sumTotal += sum(target);
  countTotal += countAtLeast(target, 128);
  // The number-array arm keeps its per-element dispatch; it runs a sixteenth
  // as often so the typed-array arms hold the measurement.
  if ((r & 15) === 0) {
    const values = mixed[(r >> 4) % mixed.length]!;
    listTotal += listSum(values);
    values[(r * 7) % n] = r & 255;
  }
}
console.log(`sum ${sumTotal}`);
console.log(`count ${countTotal}`);
console.log(`list ${listTotal}`);
console.log(`widths ${arrays.map((a) => a.length).join(",")}`);
