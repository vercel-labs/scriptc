// Call regions: calls of functions that build what they need and return
// a number, so everything they allocate is dead when they return.
interface Point {
  x: number;
  y: number;
}
interface Segment {
  from: Point;
  to: Point;
}

function perimeter(n: number, scale: number): number {
  const points: Point[] = [];
  for (let i = 0; i < n; i++) points.push({ x: Math.cos(i) * scale, y: Math.sin(i) * scale });
  const segments: Segment[] = [];
  for (let i = 0; i < n; i++) segments.push({ from: points[i]!, to: points[(i + 1) % n]! });
  let total = 0;
  for (const s of segments) total += Math.hypot(s.to.x - s.from.x, s.to.y - s.from.y);
  return Math.round(total * 1000) / 1000;
}

let sum = 0;
for (let k = 3; k < 300; k++) sum += perimeter(k, k / 10);
console.log("perimeters", sum.toFixed(3));

function histogram(words: string[]): number {
  const buckets: { word: string; count: number }[] = [];
  for (const w of words) {
    let found = false;
    for (const b of buckets)
      if (b.word === w) {
        b.count++;
        found = true;
      }
    if (!found) buckets.push({ word: w, count: 1 });
  }
  let best = 0;
  for (const b of buckets) best = Math.max(best, b.count * 100 + b.word.length);
  return best;
}
const words = "the quick brown fox jumps over the lazy dog the end".split(" ");
let h = 0;
for (let i = 0; i < 200; i++) h += histogram(words);
console.log("histogram", h);
