// For loops with two counters closing in on each other (`lo++, hi--`):
// in-place reversals, inclusive bounds, larger steps, early exits, starts
// that are fractions, negative zero, NaN, huge or already crossed, nested
// reversals, and counters a closure captures or the body writes.
function reverse(a: number[], from: number, to: number): number[] {
  for (let lo = from, hi = to; lo < hi; lo++, hi--) {
    const t = a[lo]!;
    a[lo] = a[hi]!;
    a[hi] = t;
  }
  return a;
}
const base = (): number[] => [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
console.log(reverse(base(), 0, 9).join(","));
console.log(reverse(base(), 2, 6).join(","));
console.log(reverse(base(), 6, 2).join(","));
console.log(reverse(base(), 3, 3).join(","));
// Unproven starts: fractions, negative zero, NaN and huge values keep JS
// semantics (charCodeAt truncates its index; out-of-range reads are NaN).
function codes(s: string, from: number, to: number): string {
  const out: number[] = [];
  for (let lo = from, hi = to; lo < hi; lo++, hi--) out.push(s.charCodeAt(lo), s.charCodeAt(hi), lo, hi);
  return out.join(",");
}
const word = "abcdefgh";
console.log(codes(word, 0.5, 4.5));
console.log(codes(word, -0, 3), Object.is(-0 + 0, 0));
console.log(codes(word, NaN, 4), "|", codes(word, 0, NaN));
console.log(codes(word, 2 ** 53 - 3, 2 ** 53));
console.log(codes(word, -3, 2));

function pairs(n: number): string {
  const out: string[] = [];
  for (let i = 0, j = n; i <= j; i += 2, j -= 3) out.push(`${i}:${j}`);
  return out.join(" ");
}
console.log(pairs(20), "|", pairs(0), "|", pairs(-1));

function firstGap(a: number[]): number {
  let found = -1;
  for (let lo = 0, hi = a.length - 1; lo < hi; lo++, hi--) {
    if (a[lo] === a[hi]) continue;
    found = lo;
    break;
  }
  return found;
}
console.log(firstGap([1, 2, 3, 2, 1]), firstGap([1, 2, 3, 4, 2, 1]), firstGap([]));

// The flip loop of a permutation puzzle: the next index comes from the array.
function flips(perm: number[]): number {
  const work = perm.slice();
  let count = 0;
  let head = work[0]!;
  while (head !== 0) {
    for (let lo = 0, hi = head; lo < hi; lo++, hi--) {
      const t = work[lo]!;
      work[lo] = work[hi]!;
      work[hi] = t;
    }
    count++;
    head = work[0]!;
  }
  return count;
}
console.log(flips([3, 1, 0, 2]), flips([4, 3, 2, 1, 0]), flips([0, 1, 2]));

// Counters a closure reads, or the body writes, stay ordinary bindings.
const readers: (() => number)[] = [];
for (let lo = 0, hi = 4; lo < hi; lo++, hi--) readers.push(() => lo * 10 + hi);
console.log(readers.map((f) => f()).join(","));
const seen: number[] = [];
for (let lo = 0, hi = 10; lo < hi; lo++, hi--) {
  seen.push(lo, hi);
  if (lo === 2) hi -= 3;
}
console.log(seen.join(","));
const text = "abcdefgh";
let mirrored = "";
for (let lo = 0, hi = text.length - 1; lo <= hi; lo++, hi--) mirrored += text.charAt(hi) + text.charCodeAt(lo);
console.log(mirrored);
