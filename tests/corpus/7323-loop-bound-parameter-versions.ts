// Functions whose number parameters bound their loops, called with values
// no caller proves to be int32s: integers, fractions, NaN, -0, infinities,
// and integers past the int32 range. Every call prints Node's result,
// including -0 read back through 1 / n, a reassigned parameter, a thrown
// error, a void result and a function passed as a value.

function show(label: string, value: number): void {
  console.log(label, Object.is(value, -0) ? "-0" : String(value));
}

function sumTo(n: number): number {
  let s = 0;
  for (let i = 0; i < n; i++) s += i;
  return s;
}

function fill(n: number, out: number[]): void {
  for (let i = 0; i < n; i++) out.push(i * 2);
}

function sign(n: number): number {
  let steps = 0;
  for (let i = 0; i < n && steps < 4; i++) steps++;
  return 1 / n + steps;
}

function countdown(n: number, step: number): number {
  let k = 0;
  while (n > 0) {
    n -= step;
    k++;
    if (k > 100) break;
  }
  return k * 1000 + n;
}

function checked(n: number, limit: number): number {
  let s = 0;
  let over = -1;
  for (let i = 0; i <= n; i++) {
    if (i > limit && over < 0) over = i;
    s += i;
  }
  if (over >= 0) throw new RangeError(`past ${limit} at ${over}`);
  return s;
}

function fillTo(n: number, out: number[]): number {
  for (let i = 0; i < n; i++) out[i] = i * 3;
  return out.length;
}

function window2(a: number[], from: number, to: number): string {
  const parts: string[] = [];
  for (let i = from; i < to; i++) parts.push(String(a[i]));
  return parts.join(",");
}

// Values arrive as strings and JSON, so no caller proves them int32s.
const inputs: number[] = JSON.parse("[0, 1, 5, 7.5, -3, -0, 2147483647, 2147483648, -2147483649, 1e300]");
inputs.push(NaN, Infinity, -Infinity, Number("12"), Number.parseFloat("3.25"));

for (const n of inputs) {
  const small = Math.abs(n) > 100 ? (n > 0 ? 3 : -3) : n;
  show(`sumTo ${n}`, sumTo(small));
  show(`sign ${n}`, sign(n));
  show(`countdown ${n}`, countdown(small, 2));
  const out: number[] = [];
  fill(small, out);
  const dense: number[] = [];
  const length = fillTo(small, dense);
  console.log(`fill ${n}`, out.join(" "), length, dense.join(" "));
}

for (const n of [3, 4.5, 6]) {
  try {
    show(`checked ${n}`, checked(n, 4));
  } catch (e) {
    console.log(`checked ${n} threw`, (e as Error).message);
  }
}

const data = [10, 20, 30, 40, 50];
for (const [from, to] of JSON.parse("[[0, 2], [1.5, 4], [-1, 1], [3, 9], [2, 2]]") as [number, number][])
  console.log(`window ${from}..${to}`, window2(data, from, to));

const fns: ((n: number) => number)[] = [sumTo, (n) => sumTo(n) * 2];
console.log(fns.map((f) => f(Number("4"))).join(" "), [1, 2.5, 3].map(sumTo).join(" "));
