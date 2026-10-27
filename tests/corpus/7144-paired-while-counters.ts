// While loops with two counters closing in on each other (`lo++; hi--;` at
// the end of the body): reversals over arrays, typed arrays and strings,
// either comparison direction, inclusive bounds, larger steps, parameters as
// counters, early exits, unproven starts, and the shapes that keep the loop
// as it is (a continue, a counter read after the loop, a captured counter,
// a counter the body writes).
function reverse(a: number[], from: number, to: number): number[] {
  let lo = from;
  let hi = to;
  while (lo < hi) {
    const t = a[lo]!;
    a[lo] = a[hi]!;
    a[hi] = t;
    lo++;
    hi--;
  }
  return a;
}
const base = (): number[] => [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
console.log(reverse(base(), 0, 9).join(","));
console.log(reverse(base(), 2, 6).join(","));
console.log(reverse(base(), 6, 2).join(","));
console.log(reverse(base(), 3, 3).join(","));
console.log(reverse(base(), -0, 2).join(","), reverse(base(), 7, -0).join(","));

// The parameters are the counters; the updates come in the other order.
function reverseRange(a: Float64Array, lo: number, hi: number): string {
  while (hi > lo) {
    const t = a[lo]!;
    a[lo] = a[hi]!;
    a[hi] = t;
    hi -= 1;
    ++lo;
  }
  return a.join(",");
}
console.log(reverseRange(new Float64Array([1, 2, 3, 4, 5, 6]), 0, 5));
console.log(reverseRange(new Float64Array([1, 2, 3, 4, 5, 6]), 1, 3.5));
console.log(reverseRange(new Float64Array([1, 2, 3, 4, 5, 6]), -2, 2));
console.log(reverseRange(new Float64Array([1, 2, 3, 4, 5, 6]), NaN, 4), reverseRange(new Float64Array([1, 2]), 0, NaN));

function bytesReversed(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let i = 0,
    j = bytes.length - 1;
  while (i < j) {
    const t = bytes[i]!;
    bytes[i] = bytes[j]!;
    bytes[j] = t;
    i++;
    j--;
  }
  return new TextDecoder().decode(bytes);
}
console.log(bytesReversed("hello, world"), bytesReversed(""), bytesReversed("x"));

// Unproven starts read through charCodeAt (which truncates its index).
function codes(s: string, from: number, to: number): string {
  const out: number[] = [];
  let lo = from;
  let hi = to;
  while (lo <= hi) {
    out.push(s.charCodeAt(lo), s.charCodeAt(hi), lo, hi);
    lo += 2;
    hi -= 3;
  }
  return out.join(",");
}
const word = "abcdefghijkl";
console.log(codes(word, 0, 11), "|", codes(word, 0.5, 9.25), "|", codes(word, 4, 4));
console.log(codes(word, 2 ** 53 - 3, 2 ** 53), "|", codes(word, -3, 2), "|", codes(word, 5, 1));

// Negative zero starts stay negative zero.
function signs(text: string, from: number): string {
  const out: string[] = [];
  let lo = from;
  let hi = text.length - 1;
  while (lo < hi) {
    out.push(`${Object.is(lo, -0)}:${text.charCodeAt(lo)}`);
    lo++;
    hi--;
  }
  let a = -0;
  let b = 2;
  while (a < b) {
    out.push(`${Object.is(a, -0)}:${text.charCodeAt(b)}`);
    a++;
    b--;
  }
  return out.join(" ");
}
console.log(signs("abcd", -0), signs("abcd", 0));

function isPalindrome(s: string): boolean {
  let i = 0;
  let j = s.length - 1;
  while (i < j) {
    if (s.charCodeAt(i) !== s.charCodeAt(j)) return false;
    i++;
    j--;
  }
  return true;
}
console.log(isPalindrome("racecar"), isPalindrome("abca"), isPalindrome(""), isPalindrome("ab"));

function firstMismatch(a: number[]): number {
  let found = -1;
  let lo = 0;
  let hi = a.length - 1;
  while (lo < hi) {
    const left = a[lo]!;
    if (left !== a[hi]!) {
      found = lo;
      break;
    }
    lo++;
    hi--;
  }
  return found;
}
console.log(firstMismatch([1, 2, 3, 2, 1]), firstMismatch([1, 2, 3, 4, 2, 1]), firstMismatch([]));

// A labeled jump to an outer loop leaves the inner loop from its middle.
function rows(grid: number[][]): string {
  const out: string[] = [];
  outer: for (const row of grid) {
    let lo = 0;
    let hi = row.length - 1;
    while (lo < hi) {
      const left = row[lo]!;
      const right = row[hi]!;
      if (left === 0) continue outer;
      if (right === 0) break outer;
      out.push(`${left}${right}`);
      lo++;
      hi--;
    }
    out.push("|");
  }
  return out.join(" ");
}
console.log(rows([[1, 2, 3, 4], [0, 5, 6], [7, 8, 9, 1], [2, 3, 0, 4]]));

// Repeated entries: the counters are declared inside an outer loop. Each
// pass reverses the prefix that ends at the index the first element holds,
// until the first element is 0, and the passes are counted.
function prefixReversals(values: number[]): number {
  const copy = values.slice();
  let count = 0;
  let end = copy[0]!;
  while (end !== 0) {
    let i = 0;
    let j = end;
    while (i < j) {
      const t = copy[i]!;
      copy[i] = copy[j]!;
      copy[j] = t;
      i++;
      j--;
    }
    count++;
    end = copy[0]!;
  }
  return count;
}
console.log(
  prefixReversals([3, 1, 2, 0]),
  prefixReversals([0, 1, 2]),
  prefixReversals([4, 3, 2, 1, 0]),
  prefixReversals([2, 0, 1]),
);

// Holes and present undefined values move as they are.
const sparse: (number | undefined)[] = [1, , 3, undefined, 5];
{
  let lo = 0;
  let hi = sparse.length - 1;
  while (lo < hi) {
    const t = sparse[lo];
    sparse[lo] = sparse[hi];
    sparse[hi] = t;
    lo++;
    hi--;
  }
}
console.log(sparse, 1 in sparse, 3 in sparse);

// These keep the while loop: a continue skips the trailing updates, a
// counter is read after the loop, a closure captures a counter, and the
// body writes a counter.
function skipping(n: number): string {
  const out: number[] = [];
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    if (lo % 3 === 0) {
      lo += 2;
      continue;
    }
    out.push(lo, hi);
    lo++;
    hi--;
  }
  return out.join(",");
}
console.log(skipping(12));

function meet(n: number): string {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    lo++;
    hi--;
  }
  return `${lo}:${hi}`;
}
console.log(meet(9), meet(10), meet(0.5));

function captured(n: number): string {
  const seen: (() => number)[] = [];
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    seen.push(() => lo * 100 + hi);
    lo++;
    hi--;
  }
  return seen.map((f) => f()).join(",");
}
console.log(captured(5));

function jumps(a: number[]): string {
  const out: number[] = [];
  let lo = 0;
  let hi = a.length - 1;
  while (lo < hi) {
    out.push(a[lo]!, a[hi]!);
    if (a[lo]! > 5) hi = lo;
    lo++;
    hi--;
  }
  return out.join(",");
}
console.log(jumps([1, 2, 9, 4, 5, 6, 7, 8]));
