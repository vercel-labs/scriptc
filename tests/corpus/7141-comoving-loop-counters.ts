// For loops with a second counter that steps beside the tested one
// (`i++, j += 4`): pixel strides over typed arrays, interleaving into number
// arrays, descending and inclusive loops, three counters, early exits,
// starts and limits that are fractions, negative zero, NaN, infinite or
// near 2^53, counters that live across a yield or an await, and counters a
// closure captures, the body writes or the condition reads.
function luminance(px: Uint8Array, count: number): number[] {
  const out: number[] = [];
  for (let i = 0, p = 0; i < count; i++, p += 4) {
    out.push((px[p]! * 77 + px[p + 1]! * 150 + px[p + 2]! * 29) >> 8);
  }
  return out;
}
const px = new Uint8Array(32);
for (let k = 0; k < px.length; k++) px[k] = (k * 37 + 11) & 255;
console.log(luminance(px, 8).join(","));
// Past the end, reads are undefined and the sums NaN, which `>> 8` makes 0.
console.log(luminance(px, 10).join(","));
console.log(luminance(px, 0).length, luminance(px, -3).length, luminance(px, 2.5).join(","));
console.log(luminance(px, NaN).length);

function interleave(a: number[], b: number[]): number[] {
  const out: number[] = new Array(a.length * 2).fill(-1);
  const n = a.length;
  for (let i = 0, j = 0; i < n; i++, j += 2) {
    out[j] = a[i]!;
    out[j + 1] = b[i]!;
  }
  return out;
}
console.log(interleave([1, 2, 3, 4], [10, 20, 30, 40]).join(","));
console.log(interleave([], []).length);

// The second counter's start is not proven: charCodeAt truncates its index,
// and the counter's own values keep JS semantics.
function codes(s: string, count: number, from: number, step: number): string {
  const out: (number | string)[] = [];
  if (step === 3) {
    for (let i = 0, j = from; i < count; i++, j += 3) out.push(s.charCodeAt(j), j);
  } else {
    for (let i = 0, j = from; i < count; i++, j -= 2) out.push(s.charCodeAt(j), j);
  }
  return out.join(",");
}
const word = "abcdefghijklmnop";
console.log(codes(word, 4, 0, 3), "|", codes(word, 4, 15, -2));
console.log(codes(word, 4, 0.5, 3), "|", codes(word, 3, 9.75, -2));
const negativeZero = -0;
console.log(codes(word, 2, negativeZero, 3), Object.is(negativeZero, -0));
console.log(codes(word, 2, NaN, 3), "|", codes(word, 2, Infinity, -2), "|", codes(word, 2, -Infinity, 3));
// Near 2^52 the run-time test passes or fails on the trip count; near 2^53
// the double counter rounds (odd values above 2^53 are not representable).
console.log(codes(word, 4, 2 ** 52 - 16, 3));
console.log(codes(word, 6, 2 ** 52 - 4, 3));
console.log(codes(word, 6, 2 ** 53 - 10, 3));
console.log(codes(word, 4, -(2 ** 53) + 3, -2));
// A limit that is not finite or not an integer.
function capped(s: string, limit: number): string {
  const out: number[] = [];
  for (let i = 0, j = 1; i < limit; i++, j += 2) {
    if (j >= s.length) break;
    out.push(s.charCodeAt(j));
  }
  return out.join(",");
}
console.log(capped(word, Infinity), "|", capped(word, 3.5), "|", capped(word, NaN), "|", capped(word, -Infinity));

// A descending driver with an ascending follower, inclusive bounds and
// larger steps.
function mirror(s: string): string {
  const out: string[] = [];
  for (let i = s.length - 1, j = 0; i >= 0; i--, j += 2) out.push(`${s.charCodeAt(i)}@${j}`);
  return out.join(" ");
}
console.log(mirror("scriptc"));
function stepped(bytes: Uint8Array, last: number): string {
  const out: number[] = [];
  for (let i = 0, j = bytes.length - 1; i <= last; i += 3, j -= 5)
    out.push(bytes[i]! | 0, bytes[j]! | 0, j);
  return out.join(",");
}
console.log(stepped(px, 9), "|", stepped(px, 30));

// Three counters, continue and break.
function triple(a: Uint8Array, n: number): string {
  const out: number[] = [];
  for (let i = 0, j = 10, k = 100; i < n; i++, j -= 1, k += 7) {
    if (i % 3 === 1) continue;
    if (k > 150) break;
    out.push(a[i]!, a[j]!, k);
  }
  return out.join(",");
}
console.log(triple(px, 12), "|", triple(px, 4));

// A counted limit with a known range and a follower used by a remainder.
let rotated = 0;
for (let i = 0, j = 5; i < 1000; i++, j += 3) rotated = (rotated * 31 + px[j % 32]!) % 1000003;
console.log(rotated);

// The follower starting from a driver's start of unproven exactness.
function window(bytes: Uint8Array, from: number, to: number): string {
  const out: number[] = [];
  for (let i = from, j = 0; i < to; i++, j += 2) out.push(bytes[i]! | 0, bytes[j]! | 0, i, j);
  return out.join(",");
}
console.log(window(px, 2, 5), "|", window(px, 1.5, 4), "|", window(px, -0, 2));

// Counters a closure captures keep one binding per iteration; a follower the
// body writes, one the condition reads, and a start that reads another
// counter keep their JS values.
const reads: (() => number)[] = [];
for (let i = 0, j = 0; i < 3; i++, j += 4) {
  reads.push(() => j);
  void px[j];
}
console.log(reads.map((read) => read()).join(","));
const written: number[] = [];
for (let i = 0, j = 0; i < 5; i++, j += 2) {
  if (i === 2) j += 7;
  written.push(px[j]!, j);
}
console.log(written.join(","));
const chased: number[] = [];
for (let i = 0, j = 5; i < j; i += 2, j++) chased.push(px[i]!, i, j);
console.log(chased.join(","));
const offset: number[] = [];
for (let i = 1, j = i + 1; i < 4; i++, j += 2) offset.push(px[j]!, j);
console.log(offset.join(","));

// Counters that live across a yield or an await.
function* strided(bytes: Uint8Array, n: number): Generator<number> {
  for (let i = 0, j = 1; i < n; i++, j += 3) yield bytes[j]! + i;
}
console.log([...strided(px, 6)].join(","));
async function weighted(bytes: Uint8Array, n: number): Promise<number> {
  let sum = 0;
  for (let i = 0, j = 2; i < n; i++, j += 5) {
    await null;
    sum += bytes[j]! * (i + 1);
  }
  return sum;
}
void (async () => console.log(await weighted(px, 6), await weighted(px, 3)))();
