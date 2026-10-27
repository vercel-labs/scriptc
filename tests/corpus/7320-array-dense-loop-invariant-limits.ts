// Index loops bounded by an invariant limit other than the array's own length
// (a local copy of a length, a literal, an inclusive bound), over arrays the
// loop never resizes: class instances whose number and boolean fields the loop
// writes, and number arrays that are dense, short, holey or partially filled.

class Body {
  x: number;
  v = 0;
  hit = false;
  next: Body | null = null;

  constructor(x: number) {
    this.x = x;
  }
}

function pairs(bodies: Body[]): string {
  const n = bodies.length;
  for (let i = 0; i < n; i++) {
    const bi = bodies[i]!;
    let vi = bi.v;
    for (let j = i + 1; j < n; j++) {
      const bj = bodies[j]!;
      const d = bi.x - bj.x;
      const f = 1 / (d * d + 1);
      vi -= d * f;
      bj.v += d * f;
      bj.hit = f > 0.1;
    }
    bi.v = vi;
  }
  return bodies.map((b) => `${b.v.toFixed(6)}${b.hit ? "*" : ""}`).join(" ");
}

function firstThree(bodies: Body[]): number {
  let s = 0;
  for (let j = 0; j < 3; j++) s += bodies[j]!.x;
  return s;
}

function inclusive(bodies: Body[]): number {
  const last = bodies.length - 1;
  let s = 0;
  for (let j = 1; j <= last; j++) s += bodies[j]!.x * j;
  return s;
}

function linked(bodies: Body[]): string {
  const n = bodies.length;
  // A reference field write: the loop keeps the ordinary copy.
  for (let j = 0; j < n - 1; j++) bodies[j]!.next = bodies[j + 1]!;
  let count = 0;
  for (let b: Body | null = bodies[0]!; b !== null; b = b.next) count++;
  return `${count}`;
}

function sumTo(a: number[], limit: number): string {
  const n = limit;
  let s = 0;
  let missing = 0;
  for (let i = 0; i < n; i++) {
    const v = a[i];
    if (v === undefined) missing++;
    else s += v;
  }
  return `${s} ${missing}`;
}

function scaleTo(a: number[], out: number[]): string {
  const n = a.length;
  for (let i = 0; i < n; i++) out[i] = a[i] * 2;
  return `${out.length}:${out.join(",")}`;
}

function window(a: number[]): number {
  let s = 0;
  for (let i = 2; i < 6; i++) s += a[i] * i;
  return s;
}

const bodies = [new Body(0), new Body(1.5), new Body(-2), new Body(4), new Body(0.25)];
console.log(pairs(bodies));
console.log(pairs(bodies));
console.log(firstThree(bodies), inclusive(bodies), inclusive([new Body(7)]));
console.log(linked([new Body(1), new Body(2), new Body(3)]));

const dense = [1, 2, 3, 4, 5, 6, 7, 8];
console.log(sumTo(dense, 8), sumTo(dense, 5), sumTo(dense, 0), sumTo(dense, -3));
// Limits past the length or the filled prefix take the checked loop.
console.log(sumTo(dense, 10), sumTo([], 2));
const holey = [1];
holey[3] = 4;
console.log(sumTo(holey, 4), sumTo(holey, 1));
const shortened = [1, 2, 3, 4, 5, 6];
shortened.length = 3;
shortened.length = 6;
console.log(sumTo(shortened, 6), sumTo(shortened, 3));
console.log(scaleTo(dense, new Array<number>(8).fill(0)));
console.log(scaleTo(dense, [9, 9]));
console.log(scaleTo([1, 2, 3], []));
console.log(window(dense), window([1, 2, 3, 4, 5, 6]));
