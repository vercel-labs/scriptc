// Functions whose number parameter bounds a loop that writes record fields:
// plain writes, compound assignments, increments, an assignment used as a
// value, a string field, two references to one record, and a bound that the
// loop itself reassigns from a field it wrote. No caller proves the bound an
// int32: each function runs with integers, fractions, NaN, -0, negatives,
// infinities and integers past the int32 range, and prints Node's result.
// No loop reads past its array: a bound larger than the array is either
// cut to the array's length by the caller or paired with a second condition.

interface Body {
  x: number;
  v: number;
  mass: number;
}

interface Counter {
  hits: number;
  last: number;
  label: string;
}

interface State {
  total: number;
  cap: number;
}

function show(label: string, value: number): void {
  console.log(label, Object.is(value, -0) ? "-0" : String(value));
}

// The pair loop of an n-body step: every write is a compound assignment.
function advance(bodies: Body[], n: number, dt: number): void {
  for (let i = 0; i < n; i++) {
    const bi = bodies[i]!;
    for (let j = i + 1; j < n; j++) {
      const bj = bodies[j]!;
      const d = bi.x - bj.x;
      bi.v -= d * bj.mass * dt;
      bj.v += d * bi.mass * dt;
    }
  }
  for (let i = 0; i < n; i++) {
    const b = bodies[i]!;
    b.x += dt * b.v;
  }
}

// The bound can be far past the array: a second condition ends the loop.
function damp(bodies: Body[], n: number, k: number): number {
  let i = 0;
  for (; i < n && i < bodies.length; i++) {
    const b = bodies[i]!;
    b.v *= k;
    b.x -= b.v;
  }
  return i;
}

// Plain writes, a string field, and the bound stored into the record.
function tally(c: Counter, labels: string[], n: number): number {
  for (let i = 0; i < n; i++) {
    c.hits = c.hits + 1;
    c.last = i + n;
    c.label = labels[i % labels.length]!;
  }
  return 1 / n + c.hits;
}

// Increments and an assignment used as a value.
function bump(c: Counter, n: number): number {
  let seen = 0;
  for (let i = 0; i < n; i++) {
    c.hits++;
    seen += c.last = c.hits * 2;
    --c.last;
  }
  return seen;
}

// Both references are the same record: each write is visible through the other.
function alias(a: Counter, b: Counter, n: number): number {
  let sum = 0;
  for (let i = 0; i < n; i++) {
    a.hits = i;
    b.hits += n;
    sum += a.hits;
    b.last = a.last + 1;
  }
  return sum;
}

// The loop reassigns its own bound from a field it wrote, to a fraction.
function drain(state: State, n: number): number {
  let steps = 0;
  for (let i = 0; i < n; i++) {
    state.total += i;
    if (state.total > state.cap) n = state.cap / 4;
    steps++;
  }
  return steps * 1000 + n;
}

// A while loop bounded by the parameter, counting down through a field.
function settle(state: State, n: number): number {
  let rounds = 0;
  while (state.total < n && rounds < 50) {
    state.total += state.cap;
    state.cap *= 2;
    rounds++;
  }
  return rounds;
}

function bodies(): Body[] {
  return [
    { x: 0, v: 0, mass: 4 },
    { x: 1.5, v: 0.25, mass: 1 },
    { x: -2, v: -0.5, mass: 0.5 },
    { x: 4, v: 1, mass: 0.125 },
  ];
}

function describe(list: Body[]): string {
  return list.map((b) => `${b.x.toFixed(6)}/${b.v.toFixed(6)}`).join(" ");
}

// Values arrive through JSON and Number(), so no caller proves them int32s.
const inputs: number[] = JSON.parse("[0, 1, 2, 3, 4, 2.5, 3.999, -3, -0, 5, 2147483648, -2147483649, 1e300]");
inputs.push(NaN, Infinity, -Infinity, Number("4"), Number.parseFloat("1.25"));

for (const n of inputs) {
  const list = bodies();
  // advance reads bodies[i] for every i below its bound: keep it within the array.
  const within = Math.abs(n) > list.length ? (n > 0 ? list.length : -list.length) : n;
  for (let step = 0; step < 3; step++) advance(list, within, 0.01);
  console.log(`advance ${n}`, describe(list));
  show(`damp ${n}`, damp(list, n, 0.5));
  console.log(`damp ${n} left`, describe(list));

  // A bound past a few thousand would run for too long: keep its sign.
  const small = Math.abs(n) > 1000 ? (n > 0 ? 7 : -7) : n;
  const c: Counter = { hits: 0, last: 0, label: "none" };
  show(`tally ${n}`, tally(c, ["even", "odd", "third"], small));
  console.log(`tally ${n} left`, c.hits, c.last, c.label);
  show(`sign ${n}`, tally({ hits: 0, last: 0, label: "" }, ["x"], Math.abs(n) > 1000 ? NaN : n));
  show(`bump ${n}`, bump(c, small));
  console.log(`bump ${n} left`, c.hits, c.last);
  const shared: Counter = { hits: 0, last: 0, label: "shared" };
  show(`alias ${n}`, alias(shared, shared, small));
  console.log(`alias ${n} left`, shared.hits, shared.last);
  const state: State = { total: 0, cap: 10 };
  show(`drain ${n}`, drain(state, small));
  console.log(`drain ${n} left`, state.total, state.cap);
  const settled: State = { total: 0, cap: 1 };
  show(`settle ${n}`, settle(settled, n));
  console.log(`settle ${n} left`, settled.total, settled.cap);
}

// The functions as values, and through array callbacks.
const steppers: ((list: Body[], n: number, dt: number) => void)[] = [advance];
const last = bodies();
steppers[0]!(last, Number("3"), 0.5);
console.log("as a value", describe(last));
console.log([1, 2.5, 3].map((n) => bump({ hits: 0, last: 0, label: "" }, n)).join(" "));
