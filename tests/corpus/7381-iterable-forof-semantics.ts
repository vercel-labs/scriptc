// for-of over Iterable<T> keeps the semantics of the held source: an array
// is walked live, a generator is closed on break, return and throw (its
// finally blocks run) but not when it is exhausted or throws itself, and
// labels, closures, await and yield work in the loop body.

function* noisy(tag: string): Generator<number, void, undefined> {
  try {
    yield 1;
    yield 2;
    yield 3;
  } finally {
    console.log("closed", tag);
  }
}

const early: Iterable<number> = noisy("break");
for (const v of early) {
  if (v === 2) break;
  console.log("v", v);
}

function firstOver(src: Iterable<number>, n: number): number | undefined {
  for (const x of src) if (x > n) return x;
  return undefined;
}
console.log(firstOver([1, 5, 9], 4), firstOver(noisy("return"), 1), firstOver(noisy("exhausted"), 9));

try {
  for (const v of noisy("throw") as Iterable<number>) {
    if (v === 1) throw new Error("boom");
  }
} catch (e) {
  console.log("caught", (e as Error).message);
}

function* failing(): Generator<number, void, undefined> {
  try {
    yield 1;
    throw new RangeError("generator failed");
  } finally {
    console.log("failing finally");
  }
}
try {
  for (const v of failing() as Iterable<number>) console.log("got", v);
} catch (e) {
  console.log(String(e));
}

// The array is read live: elements pushed during the walk are visited.
const grow: number[] = [1, 2];
let visits = 0;
for (const v of grow as Iterable<number>) {
  if (grow.length < 5) grow.push(v * 10);
  visits++;
}
console.log(visits, grow);

// Holes read undefined when T holds it.
function show(xs: Iterable<number | undefined>): string {
  const out: string[] = [];
  for (const x of xs) out.push(String(x));
  return out.join(",");
}
console.log(show([1, , 3]), show([undefined, 2]));

// Labels, closures over the per-iteration binding, try/finally, a class
// declared in the body, and an existing binding as the loop target.
function run(src: Iterable<number>, tag: string): void {
  const fns: (() => number)[] = [];
  let acc = 0;
  outer: for (const x of src) {
    fns.push(() => x * 10);
    try {
      if (x === 2) continue outer;
      class Local {
        v = x;
        twice(): number {
          return this.v * 2;
        }
      }
      acc += new Local().twice();
      const inner = (y: number): number => y + x;
      acc += inner(1);
    } finally {
      acc += 100;
    }
  }
  console.log(tag, acc, fns.map((f) => f()).join(","));
}
function* three(): Generator<number, void, undefined> {
  yield 1;
  yield 2;
  yield 3;
}
run([1, 2, 3], "array");
run(three(), "generator");
run(new Set([1, 2, 3]), "set");

let product = 0;
outer: for (const a of [1, 2, 3] as Iterable<number>) {
  for (const b of new Set([10, 20]) as Iterable<number>) {
    if (b === 20) continue outer;
    if (a === 3) break outer;
    product += a * b;
  }
}
let target = 0;
for (target of [7, 8] as Iterable<number>) {
}
console.log(product, target);

// await and yield inside the loop body.
async function asyncSum(src: Iterable<number>): Promise<number> {
  let s = 0;
  for (const x of src) s += await Promise.resolve(x);
  return s;
}
function* doubled(src: Iterable<number>): Generator<number, void, undefined> {
  for (const x of src) yield x * 2;
}
asyncSum([4, 5]).then((v) => console.log("async", v, [...doubled([1, 2])], [...doubled(new Set([7]))]));
