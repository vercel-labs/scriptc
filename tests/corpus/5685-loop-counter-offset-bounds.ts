// Loops whose condition compares the counter plus or minus a literal with a
// bound (`i + 1 < xs.length`, `1 + i < n`, `i - 1 >= 0`): fractional, NaN,
// infinite and negative bounds, counters past 2^31 and near 2^53, helper
// calls with the counter, string lengths and arrays that grow in the body.

interface Point {
  x: number;
  y: number;
}
function pointAt(xs: number[], ys: number[], i: number): Point {
  return { x: xs[i], y: ys[i] };
}
function gap(p: Point, q: Point): number {
  return Math.abs(p.x - q.x) + Math.abs(p.y - q.y);
}

const xs: number[] = [];
const ys: number[] = [];
for (let i = 0; i < 50; i++) {
  xs.push((i * 37) % 11);
  ys.push((i * 53) % 7);
}

let path = 0;
for (let i = 0; i + 1 < xs.length; i++) path += gap(pointAt(xs, ys, i), pointAt(xs, ys, i + 1));
console.log("path", path);

let pairs = 0;
for (let i = 0; 1 + i < xs.length; i++) pairs += xs[i]! * xs[i + 1]!;
console.log("pairs", pairs);

let triples = 0;
for (let i = 0; i + 2 <= xs.length - 1; i += 2) triples += xs[i]! + xs[i + 1]! + xs[i + 2]!;
console.log("triples", triples);

// Bounds that are not integers, or not finite.
function count(bound: number): number {
  let n = 0;
  for (let i = 0; i + 2 < bound; i++) {
    n++;
    if (n > 20) break;
  }
  return n;
}
console.log("bounds", count(7.5), count(2), count(2.0001), count(-3), count(Number.NaN), count(Infinity));

// Counters below zero, past int32 and near the end of exact integers.
let negative = 0;
for (let i = -5; i + 5 < 3; i++) negative += i;
console.log("negative", negative);
let wide = 0;
for (let i = 2 ** 31 - 3; i + 1 < 2 ** 31 + 3; i++) wide += i - 2 ** 31;
console.log("past int32", wide);
const exact: number[] = [];
for (let i = 2 ** 53 - 4; i + 1 < 2 ** 53; i++) exact.push(i - 2 ** 53);
console.log("near 2^53", exact.join(","));
let half = 0;
for (let i = 0; i + 0.5 < 4; i++) half += i;
console.log("half offset", half);

// Descending counters.
const down: number[] = [];
for (let i = 6; i - 1 >= 0; i--) down.push(i);
console.log("down", down.join(","));
let back = 0;
for (let i = xs.length - 1; i - 1 >= 0; i--) back += xs[i]! - xs[i - 1]!;
console.log("back", back);

// A while loop on a string's length.
const text = "abcdefghij";
let pos = 0;
let codes = 0;
while (pos + 3 < text.length) {
  codes += text.charCodeAt(pos) * text.charCodeAt(pos + 3);
  pos++;
}
console.log("string", pos, codes);

// An array that grows inside the loop: the bound is reread on every pass.
const grow = [1, 2, 3];
let steps = 0;
for (let i = 0; i + 1 < grow.length; i++) {
  if (grow.length < 12) grow.push(grow[i]! + grow[i + 1]!);
  steps++;
}
console.log("grow", steps, grow.join(","));

// The counter after the loop, and an equality bound.
let last = 0;
for (last = 0; last + 1 < 9; last++) {}
console.log("last", last);
let hits = 0;
for (let i = 0; i < 10; i++) if (i + 3 === 7) hits += i;
console.log("equal", hits);
