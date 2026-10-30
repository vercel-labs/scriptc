// charCodeAt scans of strings that are not ASCII, repeated so the runtime
// holds their UTF-16 units: counts, hashes, neighbor reads, descending
// loops, reads past the end, line starts pushed to a number array, helper
// functions that read no string, a helper that reads another string, a
// second non-ASCII string read in the same loop, two texts scanned in
// turn, a short text, a text appended to between scans, surrogate pairs
// and lone surrogates, ASCII texts beside them, and while loops over a
// counter below the length: word and identifier scans, peeks past the
// counter, and a lexer class whose position is a field. Loops also read
// the length in their bodies, and loops over a fresh text that no scan
// has published run from its end and over its last units.

function isWordUnit(c: number): boolean {
  return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c > 127;
}

function isWordOrDigit(c: number): boolean {
  return isWordUnit(c) || (c >= 48 && c <= 57);
}

function spaces(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 32) n++;
  return n;
}

function hash(s: string): number {
  let h = 7;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h;
}

function rises(s: string): number {
  let n = 0;
  for (let i = 1; i < s.length - 1; i++)
    if (s.charCodeAt(i) > s.charCodeAt(i - 1) && s.charCodeAt(i) >= s.charCodeAt(i + 1)) n++;
  return n;
}

function backwards(s: string): number {
  let h = 0;
  for (let i = s.length - 1; i >= 0; i -= 3) h = (h * 7 + s.charCodeAt(i)) % 1000003;
  return h;
}

function pastEnd(s: string): string {
  let sum = 0;
  for (let i = 0; i <= s.length; i++) sum += s.charCodeAt(i);
  return String(sum);
}

function lineStarts(s: string): number[] {
  const starts = [0];
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

function wordUnits(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (isWordOrDigit(s.charCodeAt(i))) n++;
  return n;
}

function codeOf(t: string, i: number): number {
  return t.charCodeAt(i % t.length);
}

function mixed(s: string, t: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) n = (n + s.charCodeAt(i) * codeOf(t, i)) % 1000003;
  return n;
}

function sameAt(a: string, b: string): number {
  let n = 0;
  const end = Math.min(a.length, b.length);
  for (let i = 0; i < end; i++) if (a.charCodeAt(i) === b.charCodeAt(i)) n++;
  return n;
}

function surrogates(s: string): string {
  let high = 0,
    low = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c < 0xdc00) high++;
    else if (c >= 0xdc00 && c < 0xe000) low++;
  }
  return `${high}/${low}`;
}

function wordCount(s: string): number {
  let pos = 0,
    n = 0;
  const end = s.length;
  while (pos < end) {
    while (pos < end && s.charCodeAt(pos) === 32) pos++;
    if (pos >= end) break;
    n++;
    while (pos < end && s.charCodeAt(pos) !== 32) pos++;
  }
  return n;
}

function wordUnitRuns(s: string): number {
  let pos = 0,
    total = 0;
  while (pos < s.length) {
    if (isWordUnit(s.charCodeAt(pos))) {
      const start = pos;
      while (pos < s.length && isWordOrDigit(s.charCodeAt(pos))) pos++;
      total += pos - start;
    } else pos = (pos + 1) | 0;
  }
  return total;
}

function doubled(s: string): number {
  let pos = 0,
    n = 0;
  while (pos < s.length) {
    if (s.charCodeAt(pos) === s.charCodeAt(pos + 1)) n++;
    pos += 1;
  }
  return n;
}

class Scanner {
  pos = 0;
  src: string;
  constructor(src: string) {
    this.src = src;
  }
  line(): number {
    const src = this.src;
    const start = this.pos;
    let pos = start;
    while (pos < src.length && src.charCodeAt(pos) !== 10) pos++;
    this.pos = pos + 1;
    return pos - start;
  }
}

function lineLengths(s: string): number {
  const scanner = new Scanner(s);
  let total = 0,
    lines = 0;
  while (scanner.pos < s.length) {
    total = (total * 31 + scanner.line()) % 1000003;
    lines++;
  }
  return total * 1000 + lines;
}

function remaining(s: string): number {
  let pos = 0;
  let sum = 0;
  while (pos < s.length) {
    if (s.charCodeAt(pos) === 32) sum += s.length - pos;
    pos++;
  }
  return sum;
}

function lastLineLength(s: string): number {
  let last = s.length;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) last = s.length - i - 1;
  return last;
}

function from(s: string, start: number): number {
  let pos = start;
  let sum = 0;
  while (pos < s.length) {
    sum = sum * 3 + s.charCodeAt(pos);
    pos++;
  }
  return sum;
}

const words = ["Größe", "naïve", "façade", "東京", "ok", "✓", "mañana", "plain", "😀", "end\n"];
function text(count: number, seed: number): string {
  let out = "";
  for (let k = 0; k < count; k++) out += words[(k * 7 + seed) % words.length] + (k % 5 === 0 ? "  " : " ");
  return out;
}

const big = text(3000, 1);
const other = text(2000, 4);
const ascii = big.replace(/[^\x00-\x7f]/g, "x");
const short = "café ✓ 東京";
const lone = "a\uD800b\uDFFFc " + big.slice(0, 500) + "\uD83D";
for (let pass = 0; pass < 3; pass++) {
  console.log(
    pass,
    spaces(big),
    hash(big),
    rises(big),
    backwards(big),
    pastEnd(big),
    lineStarts(big).length,
    wordUnits(big),
  );
  console.log(" ", spaces(other), hash(other), spaces(big), hash(other), wordUnits(other));
  console.log(" ", mixed(big, other), sameAt(big, other), surrogates(big), surrogates(lone));
  console.log(" ", spaces(ascii), hash(ascii), spaces(short), hash(short), hash(lone), rises(lone));
  console.log(" ", wordCount(big), wordUnitRuns(big), doubled(big), lineLengths(big));
  console.log(" ", wordCount(ascii), wordUnitRuns(other), doubled(lone), lineLengths(lone), wordCount(""));
  const fresh = text(40 + pass, pass) + "ü";
  console.log(" ", remaining(big), remaining(ascii), lastLineLength(big), lastLineLength(other));
  console.log(" ", from(fresh, fresh.length), from(fresh, fresh.length - 3), from(big, big.length - 4));
}

let grown = text(1500, 2);
for (let round = 0; round < 3; round++) {
  console.log("grown", round, grown.length, spaces(grown), hash(grown), hash(grown));
  grown += text(200, round) + "Ünïcödé";
}
console.log("empty", spaces(""), hash(""), pastEnd(""), lineStarts("").length);
