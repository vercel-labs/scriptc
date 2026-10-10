// Typed-array element reads flowing through bindings, parameters and returns
// whose consumers cannot tell undefined from NaN, next to consumers that can.
// An index that is not an integer in [0, length) reads undefined, like Node;
// the compiler may carry such reads as plain numbers only where that is
// unobservable.
const base: number = process.argv.length; // 2 under both runtimes
const text = "let x = 1; /* note */ y\u{1F600}";
const chars = new Uint16Array(text.length);
for (let i = 0; i < text.length; i++) chars[i] = text.charCodeAt(i);

const far = base + 100;
const negative = -base;
const fraction = base + 0.5;
const nan = base / 0 - base / 0;
const negativeZero = -0 * base;

class Cursor {
  pos = 0;
  readonly end: number;
  token: number | undefined = 0;
  readonly data: Uint16Array;
  constructor(data: Uint16Array) {
    this.data = data;
    this.end = data.length;
  }
  char(): number {
    return this.pos < this.end ? this.data[this.pos] : -1;
  }
  peek(offset: number): number {
    return this.data[this.pos + offset];
  }
  codePointAt(pos: number): number {
    const ch = this.data[pos];
    if (ch >= 0xd800 && ch <= 0xdbff) {
      const low = this.data[pos + 1];
      if (low >= 0xdc00 && low <= 0xdfff) return (ch - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000;
    }
    return ch;
  }
}

function isLetter(ch: number): boolean {
  return (ch >= 97 && ch <= 122) || (ch >= 65 && ch <= 90);
}

function isSpace(ch: number): boolean {
  return ch === 32 || ch === 9;
}

function kind(ch: number): string {
  switch (ch) {
    case 32:
      return "space";
    case 61:
      return "equals";
    case -1:
      return "eof";
    default:
      return isLetter(ch) ? "letter" : "other";
  }
}

function describe(ch: number): string {
  // String() observes undefined: the read is rebuilt as `number | undefined`.
  return ch === 120 ? "x" : String(ch);
}

function skipComment(data: Uint16Array, pos: number, end: number): number {
  const view = data.subarray(pos, end);
  for (let i = 0; i < view.length; i++) {
    const c = view[i];
    if (c === 42 || c === 10 || c > 127) return pos + i;
  }
  return end;
}

const cursor = new Cursor(chars);
const kinds: string[] = [];
for (; cursor.pos <= cursor.end; cursor.pos++) kinds.push(kind(cursor.char()));
console.log("kinds", kinds.join(","));
cursor.pos = 0;
console.log("peek", cursor.peek(1), cursor.peek(far), cursor.peek(negative), cursor.peek(fraction));
console.log("peek kinds", kind(cursor.peek(2)), kind(cursor.peek(far)), isSpace(cursor.peek(far)));
console.log("describe", describe(chars[4]), describe(chars[0]), describe(chars[far]), describe(chars[nan]));
console.log("code points", cursor.codePointAt(text.length - 2), cursor.codePointAt(text.length - 1), cursor.codePointAt(far));
console.log("skip", skipComment(chars, 13, chars.length), skipComment(chars, 0, 3));

// Index conversions: NaN, fractions, negatives and -0.
const reads = [chars[nan], chars[fraction], chars[negative], chars[negativeZero], chars[far], chars[-0]];
console.log("index forms", reads.join("|"), reads.map((r) => r === undefined).join(","));
let present = 0;
for (const index of [0, negativeZero, 1.5, -1, nan, Infinity, -Infinity, 2 ** 32, chars.length - 1, chars.length]) {
  const c = chars[index];
  if (c > 0) present++;
}
console.log("present", present);

function bindings(): void {
// Equality of two reads: undefined equals undefined.
const a = chars[far];
const b = chars[far + 1];
const c0 = chars[0];
console.log("equal missing", a === b, a !== b, a == b, a === c0, c0 === chars[0], chars[far] === chars[negative]);
console.log("equal mixed", a === 108, c0 === 108, c0 !== 108, a !== 108, a == null, a === undefined);
console.log("relational", a < 1, a >= 0, c0 > 100, chars[far] <= chars[far]);
console.log("arithmetic", a + 1, c0 + 1, a | 0, c0 >> 1, -a, ~a, Math.max(a, 1));
console.log("truthy", a ? "yes" : "no", !a, c0 && 5, chars[far] || 7, a ?? -1);
console.log("typeof", typeof a, typeof c0, `${a}/${c0}`, [a, c0], JSON.stringify({ a, c0 }));

// Stored and returned values keep undefined.
cursor.token = cursor.peek(far);
console.log("field", cursor.token === undefined);
cursor.token = cursor.char();
console.log("field", cursor.token);
const kept: (number | undefined)[] = [];
kept.push(cursor.peek(far), cursor.peek(0));
console.log("pushed", kept, kept.indexOf(undefined));
function passThrough(value: unknown): string {
  return value === undefined ? "undefined" : typeof value;
}
console.log("unknown", passThrough(chars[far]), passThrough(chars[1]));

// A binding that may hold a genuine NaN next to a missing read.
const floats = new Float64Array([nan, 1.5]);
const f0 = floats[0];
const fMissing = floats[far];
console.log("floats", f0 === fMissing, f0, fMissing, Number.isNaN(f0), fMissing === undefined);
let counter = chars[far];
counter++;
console.log("incremented", counter, counter === chars[far], Number.isNaN(counter));

}
bindings();

// Only NaN-insensitive consumers: the reads stay plain numbers, and equality
// of two missing reads is still true.
function equalities(offset: number): string {
  const p = chars[far + offset];
  const q = chars[negative - offset];
  const r = chars[offset];
  const s = chars[offset + 1];
  const flags = [p === q, p !== q, p == q, p != q, p === r, r === s, r !== s, p < r, r > p];
  let score = 0;
  if (p === q) score += 1;
  if (q !== r) score += 2;
  if (r === chars[offset]) score += 4;
  if (p === chars[fraction]) score += 8;
  switch (p) {
    case 0:
      score += 100;
      break;
    default:
      score += 16;
  }
  return flags.join(",") + " " + score + " " + JSON.stringify(String.fromCharCode(p, r, Math.max(q, s)));
}
console.log("equalities", equalities(0), equalities(1));

// Views: a subarray answers undefined past its own length even when the
// underlying buffer continues.
const view = chars.subarray(2, 5);
console.log("view", view.length, view[0], view[2], view[3], view[far], view[3] === chars[far]);
let hash = 0x811c9dc5 | 0;
for (let i = 0; i <= view.length; i++) hash = Math.imul(hash ^ view[i], 0x01000193);
console.log("hash", hash >>> 0);
