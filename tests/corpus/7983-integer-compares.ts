// Compares of integer values that are not doubles in the generated code:
// typed-array elements and char codes, which read as NaN past the end, and
// sums such as `2 * i + 1` whose double is the integer rounded once, near and
// past 2^53.

function countPairs(a: Int32Array): string {
  // `j` runs one past the end, where `a[j]` is NaN and every order compare
  // is false.
  let lt = 0;
  let ge = 0;
  let eq = 0;
  let ne = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j <= a.length; j++) {
      if (a[i]! < a[j]!) lt++;
      if (a[i]! >= a[j]!) ge++;
      if (a[i]! === a[j]!) eq++;
      if (a[i]! !== a[j]!) ne++;
    }
  }
  return `${lt} ${ge} ${eq} ${ne}`;
}

function pastTheEnd(a: Int32Array, b: Uint8Array, c: Uint32Array): string {
  const n = a.length;
  const out: boolean[] = [];
  out.push(a[n]! < a[0]!, a[n]! > a[0]!, a[n]! <= a[n]!, a[n]! === a[0]!, a[0]! !== a[n]!);
  out.push(a[n]! < 0, a[n]! >= -1, a[-1]! < a[0]!, b[n]! <= b[0]!, b[0]! !== b[n]!);
  out.push(c[n]! < c[0]!, c[n]! >= c[n]!, c[0]! === c[0]!, c[n]! !== c[0]!);
  out.push(a[0]! < b[n]!, b[0]! >= a[n]!, a[0]! < c[n]!);
  return out.map((v) => (v ? 1 : 0)).join("");
}

function unsigned(c: Uint32Array): string {
  // Elements above 2^31 compare as unsigned values.
  let below = 0;
  let above = 0;
  let same = 0;
  for (let i = 0; i < c.length; i++) {
    for (let j = 0; j < c.length; j++) {
      if (c[i]! < c[j]!) below++;
      if (c[i]! > c[j]!) above++;
      if (c[i]! === c[j]!) same++;
    }
  }
  return `${below} ${above} ${same}`;
}

function mixed(a: Int32Array, b: Uint8Array, c: Uint32Array, d: Int16Array): string {
  let count = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i]! < b[i]!) count += 1;
    if (a[i]! < c[i]!) count += 10;
    if (c[i]! > d[i]!) count += 100;
    if (b[i]! >= d[i]!) count += 1000;
    if (a[i]! === c[i]!) count += 10000;
  }
  return String(count);
}

function charCodes(s: string): string {
  // `s.charCodeAt(s.length)` is NaN.
  let rising = 0;
  let falls = 0;
  let equal = 0;
  let differ = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) < s.charCodeAt(i + 1)) rising++;
    if (s.charCodeAt(i) >= s.charCodeAt(i + 1)) falls++;
    if (s.charCodeAt(i) === s.charCodeAt(i + 1)) equal++;
    if (s.charCodeAt(i) !== s.charCodeAt(i + 1)) differ++;
  }
  return `${rising} ${falls} ${equal} ${differ}`;
}

function heapChildren(start: number, end: number, steps: number): string {
  // `2 * i + 1` passes 2^53 for `i` at or above 2^52, where its double
  // rounds; `end` stays a safe integer.
  const out: string[] = [];
  for (let i = start; i < start + steps; i++) {
    const child = 2 * i + 1;
    out.push(
      [2 * i + 1 < end, 2 * i + 1 <= end, 2 * i + 1 > end, 2 * i + 1 === end, 2 * i + 1 !== end]
        .map((v) => (v ? 1 : 0))
        .join("") + ` ${child}`,
    );
  }
  return out.join(" ");
}

function countNear(start: number, end: number, steps: number): string {
  // The same compares in a loop over integer locals only, stopping early if
  // `i` reaches `end`.
  let lt = 0;
  let le = 0;
  let gt = 0;
  let eq = 0;
  let ne = 0;
  for (let i = start; i < start + steps && i !== end; i++) {
    if (2 * i + 1 < end) lt++;
    if (2 * i + 1 <= end) le++;
    if (2 * i + 1 > end) gt++;
    if (2 * i + 1 === end) eq++;
    if (2 * i + 1 !== end) ne++;
  }
  return `${lt} ${le} ${gt} ${eq} ${ne}`;
}

function descend(root: number, end: number): number {
  // A sift-down's index walk: doubles `root` until `2 * root + 1` reaches `end`.
  let steps = 0;
  while (2 * root + 1 < end) {
    root = 2 * root + 1;
    steps++;
  }
  return steps * 1000 + (root % 1000);
}

function scaled(i: number, end: number): string {
  // Products by a power of two never round: 4 * i and 1024 * i compare exactly.
  return [4 * i < end, 4 * i === end, 1024 * i - 1 < end, 3 * i + 1 < end, 2 * i - 1 > -end]
    .map((v) => (v ? 1 : 0))
    .join("");
}

const a = new Int32Array([5, -3, 2147483647, -2147483648, 5, 0]);
const b = new Uint8Array([0, 255, 7, 128, 5, 0]);
const c = new Uint32Array([4294967295, 2147483648, 2147483647, 0, 1, 4294967295]);
const d = new Int16Array([-32768, 32767, -1, 1, 5, 0]);
console.log(countPairs(a));
console.log(countPairs(new Int32Array(0)));
console.log(pastTheEnd(a, b, c));
console.log(unsigned(c));
console.log(mixed(a, b, c, d));
console.log(charCodes("abcddcbaÿ￿\u0000"));
console.log(charCodes(""));
const p52 = 2 ** 52;
const safe = Number.MAX_SAFE_INTEGER;
console.log(heapChildren(p52 - 2, safe, 5));
console.log(heapChildren(p52 - 2, safe - 1, 5));
console.log(heapChildren(p52 + 100, safe, 3));
console.log(heapChildren(-p52 - 2, -safe, 5));
console.log(heapChildren(0, 4, 4));
console.log(countNear(p52 - 3, safe, 6), countNear(p52 - 3, safe - 2, 6), countNear(p52, safe, 4));
console.log(countNear(-p52 - 3, -safe, 6), countNear(-p52 + 1, -safe + 4, 4), countNear(0, 7, 6));
console.log(descend(0, safe), descend(1, safe), descend(p52 - 1, safe), descend(p52, safe));
console.log(descend(3, 100), descend(0, 1), descend(5, 0));
for (const i of [0, 1, p52 / 2 - 1, p52 / 2, p52 / 1024, p52 / 2 + 1, p52, -p52]) {
  console.log(scaled(i, safe), scaled(i, safe - 1), scaled(i, 2 ** 51), scaled(i, 4));
}
