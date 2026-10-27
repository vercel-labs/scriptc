// Speculative integer loops whose checks fail: on the first statement of
// every entry (fractional field data), after an effect earlier in the same
// iteration, before a `continue`, `break` or `return`, and on entries
// that alternate between integer and fractional data. A site that keeps
// failing stops trying its integer copy; every result is Node's.

class Point {
  x: number;
  y: number;
  w = 0;

  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }
}

function show(label: string, value: number): void {
  console.log(label, Object.is(value, -0) ? "-0" : String(value));
}

// Each inner entry fails at its first statement when the fields hold
// fractions, and runs no iteration at all for the last point.
function pairs(points: Point[]): number {
  let total = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    let acc = p.w;
    for (let j = i + 1; j < points.length; j++) {
      const q = points[j]!;
      const dx = p.x - q.x;
      const dy = p.y - q.y;
      const d2 = dx * dx + dy * dy;
      acc += d2;
      q.w += d2 * 0.5;
    }
    p.w = acc;
    total += acc;
  }
  return total;
}

const fractional = [
  new Point(0.5, 1),
  new Point(1.25, -2),
  new Point(3, 4.75),
  new Point(-1.5, 0),
];
const integral = [new Point(0, 1), new Point(2, -2), new Point(3, 4), new Point(-1, 0)];
for (let round = 0; round < 12; round++) {
  show(`pairs fractional ${round}`, pairs(fractional));
}
// The same site, now with integer data after it stopped speculating.
show("pairs integral", pairs(integral));
show("pairs integral again", pairs(integral));

// A field write comes before the failing statement: the iteration resumes
// after it and must not repeat it.
function afterEffect(points: Point[], scale: number): number {
  let s = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    p.w += 1;
    const k = p.x * scale;
    s += k * k;
  }
  return s;
}
const marks = [new Point(1, 0), new Point(2, 0), new Point(3, 0)];
show("after effect 2", afterEffect(marks, 2));
show("after effect 0.5", afterEffect(marks, 0.5));
show("after effect 3", afterEffect(marks, 3));
console.log(marks.map((p) => p.w).join(" "));

// The failing statement is followed by `continue`, `break` and `return`.
function control(n: number, step: number): number {
  let acc = 0;
  let i = 0;
  while (i < n) {
    const v = i * step;
    i++;
    if (v * v > 400) break;
    if ((i & 1) === 0) continue;
    acc += v * 3;
    if (acc > 1000) return -acc;
  }
  return acc;
}
for (const step of [1, 0.5, 2, 0.75, 7, 1.5, 3, 0.25, 5, 1.75, 4]) {
  show(`control ${step}`, control(40, step));
}

// do-while: the check fails part-way through, on some entries only.
function steps(start: number, factor: number): number {
  let v = start;
  let k = 0;
  do {
    v = v * factor - k;
    k++;
  } while (k < 6);
  return v;
}
for (let r = 0; r < 20; r++) show(`steps ${r}`, steps(r % 3 === 0 ? r + 0.5 : r, 3));

// Overflow past 2^53 on later entries only.
function powers(base: number, n: number): number {
  let p = 1;
  for (let i = 0; i < n; i++) p = p * base;
  return p;
}
for (const n of [3, 10, 40, 80, 5, 60, 2, 70, 1, 90, 0, 4]) show(`powers ${n}`, powers(3, n));
