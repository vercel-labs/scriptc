// Number arrays of proven int32s that reach other functions: passed to
// helpers called directly, along chains of helpers and recursion, and held
// in module globals that several functions read. A helper that also
// receives an array of other numbers or one that is not a fresh array,
// stores a fraction through its parameter, or escapes as a value keeps
// every array it can reach in doubles, as does a global an async function
// reads. Each case uses its own arrays and helpers.

const data: number[] = [];
let seed = 7;
for (let i = 0; i < 2000; i++) {
  seed = (Math.imul(seed, 48271) + 11) & 0x7fffffff;
  data.push(seed % 1000);
}

function fnv(values: number[]): number {
  let h = 2166136261;
  for (let i = 0; i < values.length; i++) {
    h ^= values[i]! & 0xff;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

function histogram(values: number[], buckets: number): number[] {
  const counts: number[] = new Array(buckets).fill(0);
  for (let i = 0; i < values.length; i++) {
    const b = values[i]! % buckets;
    counts[b] = counts[b]! + 1;
  }
  return counts;
}

// A helper that writes through its parameter and calls another helper.
function scale(values: number[], factor: number): number {
  for (let i = 0; i < values.length; i++) values[i] = (values[i]! * factor) & 0xffff;
  return sum(values);
}

function sum(values: number[]): number {
  let s = 0;
  for (let i = 0; i < values.length; i++) s = (s + values[i]!) | 0;
  return s;
}

// Recursion passes the array on, and the elements index another array.
function chase(next: number[], at: number, steps: number): number {
  if (steps === 0) return at;
  return chase(next, next[at]!, steps - 1);
}

function pushAll(target: number[], count: number): void {
  for (let i = 0; i < count; i++) target.push((i * 3) & 0xffff);
}

// `n` is a power of two: the masked elements are indexes of `perm`.
function locals(n: number): string {
  const perm: number[] = [];
  for (let i = 0; i < n; i++) perm.push((i * 37 + 11) & (n - 1));
  const copy: number[] = [];
  pushAll(copy, n);
  const s1 = scale(copy, 5);
  return `locals ${chase(perm, 0, 1000)} ${s1} ${copy[n - 1]} ${copy.length} ${sum(perm)}`;
}

// Read only through the element reader (`a[i] ?? 0`) and states.
function readSparse(values: number[], at: number): string {
  return `${values[at] ?? -1} ${at in values} ${values.length}`;
}

// The same helper receives an array of other numbers too: the arrays it
// can reach keep doubles.
function mean(values: number[]): number {
  let s = 0;
  for (let i = 0; i < values.length; i++) s += values[i]!;
  return s / values.length;
}

// A store through the parameter that is not an int32.
function halve(values: number[]): void {
  for (let i = 0; i < values.length; i++) values[i] = values[i]! / 2;
}

// A function used as a value keeps its parameters.
function first(values: number[]): number {
  return values[0]!;
}

let reassigned: number[] = [1, 2, 3];
function regrow(n: number): number {
  reassigned = [];
  for (let i = 0; i < n; i++) reassigned.push(i & 15);
  let s = 0;
  for (let i = 0; i < reassigned.length; i++) s += reassigned[i]!;
  return s;
}

// Not a fresh array: the result of a call.
function total(values: number[]): number {
  let s = 0;
  for (let i = 0; i < values.length; i++) s += values[i]!;
  return s;
}

const awaited: number[] = [4, 5, 6];
async function later(): Promise<number> {
  return awaited[0]! + awaited.length;
}

// A helper whose record result its callers only project: the backend may
// call its result-slot entry instead, so its parameter keeps doubles.
interface Span {
  lo: number;
  hi: number;
}
function spanAt(values: number[], i: number): Span {
  return { lo: values[i]!, hi: values[i + 1]! };
}
const spans: number[] = [5, 9, 2, 7, 11];
function spanTotal(): number {
  let total = 0;
  for (let i = 0; i < 4; i++) {
    const span = spanAt(spans, i);
    total += span.hi * 10 - span.lo;
  }
  return total;
}

const ints: number[] = [3, 4, 5];
const fractions: number[] = [0.5, 1.5, 2.5];
const halved: number[] = [8, 6, 4];
halve(halved);
const pick: (values: number[]) => number = first;
const viaValue: number[] = [9, 8, 7];

// An index that calls a function reassigning the global: the read uses the
// array the global held before the index ran, as in Node.
let swapped: number[] = [1, 2, 3];
function swapIn(): number {
  swapped = [];
  for (let i = 0; i < 4; i++) swapped.push(i + 10);
  return 1;
}
function fillSwapped(n: number): number {
  swapped = [];
  for (let i = 0; i < n; i++) swapped.push(i & 15);
  let s = 0;
  for (let i = 0; i < swapped.length; i++) s += swapped[i]!;
  return s;
}
function readSwapped(): number | undefined {
  return swapped[swapIn()];
}

console.log(`fnv ${fnv(data)} ${fnv(data)}`);
const h = histogram(data, 10);
console.log(`hist ${h.length} ${h[0]} ${h[9]} ${total(h)}`);
console.log(locals(128));
console.log(readSparse(data, 5), readSparse(data, 5000));
console.log(`mean ${mean(ints)} ${mean(fractions)}`);
console.log(`halved ${halved[0]} ${halved[2]} ${halved.length}`);
console.log(`value ${pick(viaValue)} ${viaValue.length}`);
console.log(`regrow ${regrow(40)} ${reassigned.length} ${reassigned[39]} ${regrow(5)}`);
console.log(`span ${spanTotal()}`);
console.log(`swap ${fillSwapped(6)} ${readSwapped()} ${swapped[1]}`);
void later().then((v) => console.log(`later ${v}`));
