// Counted for loops whose limit is an exact integer: an int32 local, an
// int32 field, the result of a function returning an int32, a value in a
// proven range (a masked byte, an array length), counting up and down,
// with exclusive and inclusive bounds, empty ranges and the int32 edges.
// Fractional, NaN and infinite limits take the double path and give the
// same trip counts as Node.

function bitCount(x: number): number {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
}

class Window {
  low = 0;
  high = 0;
  constructor(low: number, high: number) {
    this.low = low | 0;
    this.high = high | 0;
  }
}

function countUp(from: number, to: number): number {
  let trips = 0;
  for (let i = from; i < to; i++) trips++;
  return trips;
}
function countUpInclusive(from: number, to: number): number {
  let trips = 0;
  for (let i = from; i <= to; i++) trips++;
  return trips;
}
function countDown(from: number, to: number): number {
  let trips = 0;
  for (let i = from; i > to; i--) trips++;
  return trips;
}
function countDownInclusive(from: number, to: number): number {
  let trips = 0;
  for (let i = from; i >= to; i--) trips++;
  return trips;
}

// An int32 local limit, as in an insertion that shifts the elements after a rank.
function insertAt(values: number[], at: number, value: number): void {
  values.push(value);
  for (let i = values.length - 1; i > at; i--) values[i] = values[i - 1]!;
  values[at] = value;
}
function removeAt(values: number[], at: number): void {
  for (let i = at; i < values.length - 1; i++) values[i] = values[i + 1]!;
  values.pop();
}

const values = [10, 20, 30, 40];
const rank = bitCount(0b1011 & 0b0011);
insertAt(values, rank, 25);
insertAt(values, 0, 5);
insertAt(values, values.length - 1, 45);
console.log("after inserts", values.join(","));
removeAt(values, bitCount(1));
removeAt(values, values.length - 1);
console.log("after removes", values.join(","));

// A rank from a method as the limit: a page that keeps its values in id
// order and shifts the later ones on insert and remove.
class Page {
  readonly values: number[] = [];
  bits = 0;
  rank(slot: number): number {
    return bitCount(this.bits & ((1 << (slot & 31)) - 1));
  }
  set(slot: number, value: number): void {
    const bit = 1 << (slot & 31);
    const at = this.rank(slot);
    const values = this.values;
    if ((this.bits & bit) !== 0) {
      for (let i = at; i < values.length - 1; i++) values[i] = values[i + 1]!;
      values.pop();
      this.bits = (this.bits & ~bit) | 0;
      return;
    }
    values.push(value);
    for (let i = values.length - 1; i > at; i--) values[i] = values[i - 1]!;
    values[at] = value;
    this.bits = (this.bits | bit) | 0;
  }
  // Inclusive bounds at a rank, in both directions.
  suffix(slot: number): number {
    const at = this.rank(slot);
    const values = this.values;
    let total = 0;
    for (let i = values.length - 1; i >= at; i--) total += values[i]!;
    for (let i = 0; i <= at - 1; i++) total -= values[i]!;
    return total;
  }
}
const page = new Page();
for (const slot of [5, 1, 9, 3, 31, 0, 9, 1, 17]) page.set(slot, slot * 10);
console.log("page", page.values.join(","), page.bits >>> 0);
console.log("suffix", page.suffix(0), page.suffix(4), page.suffix(17), page.suffix(31));

// Limits from fields, calls and proven ranges.
const window = new Window(-3, 7);
let sum = 0;
for (let i = window.low; i < window.high; i++) sum += i;
console.log("field limits", sum);
sum = 0;
for (let i = window.high; i >= window.low; i--) sum += i;
console.log("field limits down", sum);
let byte = 0;
for (let k = 0; k < 6; k++) {
  const limit = (k * 77) & 0xff;
  let trips = 0;
  for (let i = 0; i <= limit; i += 37) trips++;
  byte += trips;
}
console.log("masked limits", byte);
let fromCalls = 0;
for (let i = bitCount(0xff); i > bitCount(0x3); i--) fromCalls++;
console.log("call limits", fromCalls);

// Edges and empty ranges.
console.log("up", countUp(0, 5), countUp(5, 0), countUp(-5, -2), countUp(2147483645, 2147483647));
console.log(
  "up inclusive",
  countUpInclusive(0, 5),
  countUpInclusive(3, 3),
  countUpInclusive(2147483645, 2147483647),
);
console.log("down", countDown(5, 0), countDown(0, 5), countDown(-2147483646, -2147483648));
console.log(
  "down inclusive",
  countDownInclusive(5, 0),
  countDownInclusive(-2147483646, -2147483648),
  countDownInclusive(0, 0),
);

// Limits that are not exact integers.
console.log("fractional", countUp(0, 2.5), countUpInclusive(0, 2.5), countDown(3, 0.5), countDownInclusive(3, 0.5));
console.log("negative fractional", countUp(-3, -0.5), countDownInclusive(0, -2.5));
console.log("NaN", countUp(0, Number.NaN), countDown(3, Number.NaN));
let capped = 0;
for (let i = 0; i < Number.POSITIVE_INFINITY; i++) {
  if (++capped === 4) break;
}
console.log("infinite", capped);
let floored = 0;
for (let i = 3; i > Number.NEGATIVE_INFINITY; i--) {
  if (++floored === 5) break;
}
console.log("negative infinite", floored);
