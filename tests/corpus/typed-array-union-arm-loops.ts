// Loops that index a union of typed arrays: the arm a loop indexes is bound
// once before it, so the loop reads and writes the concrete array it holds.
// The loops here cover a fill, a two-round scale, an accumulate, a nested
// copy over a second union, a count, out-of-range and fractional indexes, and
// a union with a number-array arm.

type Indexes = Uint8Array | Uint16Array | Uint32Array;
type Values = Uint8Array | Uint16Array | number[];

function fill(xs: Indexes, base: number): void {
  for (let i = 0; i < xs.length; i++) xs[i] = base + i;
}

function scale(xs: Indexes, factor: number): void {
  for (let r = 0; r < 2; r++) for (let i = 0; i < xs.length; i++) xs[i] = xs[i]! * factor;
}

function sum(xs: Indexes): number {
  let total = 0;
  let i = 0;
  while (i < xs.length) {
    total += xs[i]!;
    i++;
  }
  return total;
}

function count(xs: Indexes, limit: number): number {
  let n = 0;
  for (let i = 0; i < xs.length; i++) if (xs[i]! >= limit) n++;
  return n;
}

function copy(xs: Indexes, ys: Values): void {
  for (let i = 0; i < xs.length; i++) {
    const value = xs[i]!;
    for (let j = 0; j < ys.length; j++) ys[j] = value + j;
  }
}

// Negative, fractional and past-the-end indexes: a typed array ignores a store
// it cannot keep and reads undefined where it holds no element.
function poke(xs: Indexes): string {
  const out: string[] = [];
  for (let i = -2; i < xs.length + 2; i++) {
    xs[i] = 7;
    out.push(String(xs[i]));
  }
  xs[1.5] = 9;
  out.push(String(xs[1.5]), String(xs.length), String(xs.byteLength));
  return out.join(" ");
}

const arrays: Indexes[] = [new Uint8Array(4), new Uint16Array(5), new Uint32Array(3)];
for (const xs of arrays) {
  fill(xs, 100);
  console.log(xs.length, xs[0], xs[1], xs[xs.length - 1]);
  scale(xs, 1.5);
  console.log(sum(xs), count(xs, 200));
  console.log(poke(xs));
}

const bytes = new Uint8Array(3);
const words = new Uint16Array(2);
copy(bytes, words);
console.log(words.join(","));
const list: number[] = [0, 0];
copy(bytes, list);
console.log(list.join(","));

// A union arm the loop picks per call.
const picked: Indexes = (() => {
  const xs: Indexes[] = [new Uint8Array(6), new Uint16Array(6), new Uint32Array(6)];
  return xs[2]!;
})();
fill(picked, 5);
console.log(sum(picked), count(picked, 8));

// A loop that only reads the length keeps its dispatch and agrees.
function repeatLength(xs: Indexes): number {
  let total = 0;
  for (let i = 0; i < 3; i++) total += xs.length;
  return total;
}
console.log(repeatLength(new Uint8Array(7)), repeatLength(new Uint16Array(7)));

// A function that rebinds the union inside the loop leaves the arm unbound and
// still reads the array it holds on that iteration.
function alternate(xs: Indexes, ys: Indexes): number {
  let total = 0;
  for (let i = 0; i < 4; i++) {
    total += xs[i]!;
    if (i === 1) xs = ys;
  }
  return total;
}
const first = new Uint8Array([1, 2, 3, 4]);
const second = new Uint16Array([10, 20, 30, 40]);
console.log(alternate(first, second));
