// Callbacks that update captured `let` numbers and booleans from loops: typed
// array and array methods, an authored higher-order function called with one
// function at several calls and with two functions at one, closures of one
// function over different bindings, a callback that throws part way, nested
// callbacks, callbacks declared in the loop body, and reads after the loop.

function each(values: number[], visit: (v: number, i: number) => void): void {
  for (let i = 0; i < values.length; i++) visit(values[i]!, i);
}

function until(limit: number, step: (i: number) => boolean): number {
  let i = 0;
  while (i < limit) {
    if (!step(i)) break;
    i++;
  }
  return i;
}

function twice(values: Int16Array, f: (v: number) => void): void {
  let i = 0;
  do {
    for (let j = 0; j < values.length; j++) f(values[j]!);
    i++;
  } while (i < 2);
}

const ints = new Int32Array([5, -3, 8, 0, 12, -7, 4]);
let total = 0;
let negatives = 0;
let sawZero = false;
ints.forEach((v) => {
  total = (total + v) | 0;
  if (v < 0) negatives++;
  if (v === 0) sawZero = true;
});
console.log("forEach", total, negatives, sawZero);

let max = -Infinity;
let maxAt = -1;
const floats = new Float64Array([0.5, 9.25, -2, 9.25, 3]);
floats.forEach((v, i) => {
  if (v > max) {
    max = v;
    maxAt = i;
  }
});
console.log("max", max, maxAt);

let calls = 0;
const doubled = ints.map((v) => {
  calls++;
  return v * 2 + calls;
});
console.log("map", doubled.join(","), calls);

let seen = 0;
const big = [3, 14, 15, 92, 65].filter((v) => {
  seen += v;
  return v > 10;
});
console.log("filter", big.join(","), seen);

let sum = 0;
let count = 0;
const summing = (v: number): void => {
  sum += v;
  count++;
};
each([1, 2, 3], summing);
each([10, 20], summing);
console.log("each shared", sum, count);

let a = 0;
let b = 0;
each([1, 2], (v) => {
  a += v;
});
each([1, 2], (v, i) => {
  b += v * (i + 1);
});
console.log("each two", a, b);

const counters: (() => number)[] = [];
for (let k = 0; k < 3; k++) {
  let local = k * 100;
  each([1, 1, 1], () => {
    local++;
  });
  counters.push(() => local);
}
console.log("closures", counters.map((c) => c()).join(","));

let steps = 0;
console.log("until", until(10, (i) => (steps += i, steps < 12)), steps);

let shorts = 0;
twice(new Int16Array([7, -8, 9]), (v) => {
  shorts = shorts * 2 + v;
});
console.log("twice", shorts);

let partial = 0;
try {
  floats.forEach((v) => {
    if (v < 0) throw new RangeError(`at ${partial}`);
    partial += v;
  });
} catch (error) {
  console.log("throw", (error as Error).message, partial);
}

let outer = 0;
let inner = 0;
[1, 2, 3].forEach((x) => {
  outer += x;
  ints.forEach((y) => {
    if (y > x) inner++;
  });
});
console.log("nested", outer, inner);

let flag = false;
let flips = 0;
new Uint8Array([1, 0, 1, 1]).forEach((v) => {
  if (v === 1) flag = !flag;
  if (flag) flips++;
});
console.log("bool", flag, flips);

// Callbacks declared in the loop body: each iteration binds its own.
let strides = 0;
for (let i = 0; i < 10; i++) {
  const bump = (): void => {
    i += 2;
    strides++;
  };
  bump();
}
let countdown = 0;
let k = 3;
while (k > 0) {
  const tick = (n: number): number => (n > 0 ? tick(n - 1) + 1 : 0);
  countdown += tick(k);
  k--;
}
console.log("declared in loop", strides, countdown);
