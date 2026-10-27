// Loops whose integer locals take part in compares and typed-array indexes as
// `i + 1`, `i - 1` and `2 * i + 1`: heap sift-downs, neighbor reads at both
// ends of an array, a binary search, and counters near 2^53, where the sum
// of a counter and a constant is still an exact double.

function siftDown(a: Int32Array, start: number, end: number): void {
  let root = start;
  while (2 * root + 1 < end) {
    let child = 2 * root + 1;
    if (child + 1 < end && a[child]! < a[child + 1]!) child++;
    if (a[root]! >= a[child]!) return;
    const t = a[root]!;
    a[root] = a[child]!;
    a[child] = t;
    root = child;
  }
}

function heapSort(a: Int32Array): string {
  for (let start = (a.length >> 1) - 1; start >= 0; start--) siftDown(a, start, a.length);
  for (let end = a.length - 1; end > 0; end--) {
    const t = a[0]!;
    a[0] = a[end]!;
    a[end] = t;
    siftDown(a, 0, end);
  }
  return Array.from(a).join();
}

function neighbors(a: Float64Array): string {
  const out: number[] = [];
  let i = 0;
  while (i < a.length) {
    out.push(a[i - 1]! + a[i + 1]!);
    i = i + 1;
  }
  return out.join();
}

function lowerBound(a: Int32Array, value: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = lo + ((hi - lo) >> 1);
    if (a[mid]! < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function nearLimit(start: number): string {
  const seen: string[] = [];
  let i = start;
  let n = 0;
  while (n < 4) {
    seen.push(`${i + 1 > 9007199254740991}:${i + 1 === i + 2}:${i - 1 < i}`);
    i = i + 1;
    n = n + 1;
  }
  return seen.join(" ");
}

function atLimit(start: number, end: number): string {
  // A counter of integer locals only, up to 2^53 - 1: `i + 2` may be
  // 2^53 + 1, whose double is 2^53, so `i + 1 === i + 2` holds at the end.
  let same = 0;
  let above = 0;
  let mixed = 0;
  for (let i = start; i <= end; i++) {
    if (i + 1 === i + 2) same++;
    if (i + 2 > 9007199254740992) above++;
    mixed += (i * 2) % 3;
  }
  return `${same} ${above} ${mixed}`;
}

console.log(heapSort(new Int32Array([5, -3, 9, 0, 9, 2147483647, -2147483648, 7, 1])));
console.log(heapSort(new Int32Array([])), heapSort(new Int32Array([4])));
console.log(neighbors(new Float64Array([1, 2, 3, 4])));
const sorted = new Int32Array([-5, -1, 0, 0, 3, 8, 8, 13]);
console.log([-6, -1, 0, 1, 8, 13, 14].map((v) => lowerBound(sorted, v)).join());
console.log(nearLimit(9007199254740988));
console.log(nearLimit(-9007199254740991));
console.log(atLimit(9007199254740988, 9007199254740991));
console.log(atLimit(-9007199254740991, -9007199254740988));
