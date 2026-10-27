// Running maximum and minimum scans over ascending, descending, alternating,
// pseudo-random and NaN-holding data: plain for, while, do-while and for-of
// loops, `<=` and `>=` ties, an argmax that records its index, typed array
// and array element reads, callbacks that update captured bindings, a scan
// nested in an outer loop, an update nested in another branch, and the clamp
// and saturating updates that are not running extrema.

function shapes(n: number): [string, Float64Array][] {
  const ascending = new Float64Array(n);
  const descending = new Float64Array(n);
  const alternating = new Float64Array(n);
  const random = new Float64Array(n);
  const holes = new Float64Array(n);
  let x = 12345;
  for (let i = 0; i < n; i++) {
    ascending[i] = i;
    descending[i] = n - i;
    alternating[i] = i % 2 === 0 ? 0 : i;
    x = (x * 1103515245 + 12345) % 2147483648;
    random[i] = (x % 1000) - 500;
    holes[i] = i % 7 === 3 ? NaN : (x % 97) - 48;
  }
  return [
    ["ascending", ascending],
    ["descending", descending],
    ["alternating", alternating],
    ["random", random],
    ["nan", holes],
  ];
}

function argmax(a: Float64Array): string {
  let max = -Infinity;
  let at = -1;
  for (let i = 0; i < a.length; i++) {
    const v = a[i]!;
    if (v > max) {
      max = v;
      at = i;
    }
  }
  return `${max}@${at}`;
}

function lastMin(a: Float64Array): string {
  let min = Infinity;
  let at = -1;
  let i = 0;
  while (i < a.length) {
    if (a[i]! <= min) {
      min = a[i]!;
      at = i;
    }
    i++;
  }
  return `${min}@${at}`;
}

function bothEnds(values: number[]): string {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (lo > v) lo = v;
    if (v >= hi) hi = v;
  }
  return `${lo}..${hi}`;
}

function firstDrop(a: Float64Array): number {
  let floor = a[0]!;
  let i = 0;
  do {
    if (a[i]! < floor) floor = a[i]!;
    i++;
  } while (i < a.length);
  return floor;
}

function callbackPeak(a: Float64Array): string {
  let max = -Infinity;
  let at = -1;
  a.forEach((v, i) => {
    if (v > max) {
      max = v;
      at = i;
    }
  });
  return `${max}@${at}`;
}

function arrayCallbackMin(values: number[]): number {
  let min = Infinity;
  values.forEach((v) => {
    if (v < min) min = v;
  });
  return min;
}

function rowMaxima(a: Float64Array, width: number): string {
  const out: number[] = [];
  for (let row = 0; row * width < a.length; row++) {
    let best = -Infinity;
    for (let j = row * width; j < Math.min(a.length, (row + 1) * width); j++) {
      if (a[j]! > best) best = a[j]!;
    }
    out.push(best);
  }
  return out.join(",");
}

function longestNonNegativeRun(a: Float64Array): number {
  let longest = 0;
  let run = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i]! >= 0) {
      run++;
      if (run > longest) longest = run;
    } else run = 0;
  }
  return longest;
}

function clampSum(a: Float64Array, hi: number): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    let v = a[i]!;
    if (hi < v) v = hi;
    s += v;
  }
  return s;
}

function saturate(a: Float64Array, hi: number): number {
  let v = 0;
  for (let i = 0; i < a.length; i++) {
    v += a[i]!;
    if (hi < v) v = hi;
  }
  return v;
}

for (const [name, a] of shapes(40)) {
  const values = Array.from(a);
  console.log(
    name,
    argmax(a),
    lastMin(a),
    bothEnds(values),
    firstDrop(a),
    callbackPeak(a),
    arrayCallbackMin(values),
  );
  console.log(
    " rows",
    rowMaxima(a, 7),
    "run",
    longestNonNegativeRun(a),
    "clamp",
    clampSum(a, 5),
    "saturate",
    saturate(a, 30),
  );
}

const signed = new Float64Array([0, -0, 0, -0]);
let top = -Infinity;
for (let i = 0; i < signed.length; i++) if (signed[i]! >= top) top = signed[i]!;
console.log("signed zero", Object.is(top, -0), argmax(signed), lastMin(signed));
console.log("empty", argmax(new Float64Array(0)), bothEnds([]), arrayCallbackMin([]));
