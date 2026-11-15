// Every spelling of a scan over a string's characters, over ASCII text,
// non-ASCII text (Latin-1, an astral pair, a lone surrogate), the empty
// string and a string binding the loop reassigns: the counter in the `for`
// head, declared before the `for` (with `continue`, with an early exit, with
// a second read past the counter), `while`, `for…of`, `s[i]`, `charAt`,
// `codePointAt`, a field, a module constant, a hoisted length; reads at an
// index out of range or not an integer. (`replace` and `replaceAll` are in
// text-replace-forms.ts.)

const TEXTS: string[] = [
  "",
  "a",
  "<",
  "plain text without markup 0123456789",
  'a <b class="x"> & \'c\' > d',
  "&&&&<<<<>>>>\"\"\"\"''''",
  "café <ü> & 中文",
  "pair \u{1F600} & lone \ud83d < end \ude00",
  "x".repeat(70) + "&" + "y".repeat(70) + "<",
];

function head(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) n = (n * 31 + s.charCodeAt(i)) | 0;
  return n;
}

function before(s: string): number {
  let n = 0;
  let i = 0;
  for (; i < s.length; i++) n = (n * 31 + s.charCodeAt(i)) | 0;
  return n + i;
}

function beforeSwitch(s: string): number {
  let n = 0;
  let i = 0;
  for (; i < s.length; i++) {
    const c = s.charCodeAt(i);
    switch (c) {
      case 34:
        n += 1;
        break;
      case 38:
        n += 20;
        break;
      case 39:
        n += 300;
        break;
      case 60:
        n += 4000;
        break;
      case 62:
        n += 50000;
        break;
      default:
        continue;
    }
    n += i;
  }
  return n + i;
}

// The counter is left where the scan stopped.
function beforeUntil(s: string, stop: number): number {
  let i = 0;
  for (; i < s.length; i++) {
    if (s.charCodeAt(i) === stop) break;
  }
  return i;
}

// A second read past the counter: NaN at the end of the text.
function beforePairs(s: string): number {
  let n = 0;
  let i = 0;
  for (; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const d = s.charCodeAt(i + 1);
    if (c === d) n++;
    if (d !== d) n += 1000;
  }
  return n;
}

// The counter starts where the caller says: negative, fractional, past the end.
function beforeFrom(s: string, from: number): string {
  let out = "";
  let i = from;
  let turns = 0;
  for (; i < s.length; i++) {
    out += String(s.charCodeAt(i)) + ",";
    if (++turns === 4) break;
  }
  return out + String(i);
}

// The binding is reassigned in the loop: every read is of the current string.
function beforeReassigned(s: string): number {
  let n = 0;
  let i = 0;
  for (; i < s.length; i++) {
    n = (n * 31 + s.charCodeAt(i)) | 0;
    if (s.charCodeAt(i) === 38) s = s.slice(0, i) + "+" + s.slice(i + 2);
  }
  return n + i;
}

// The counter is assigned in the loop's initializer.
function assignedInHead(s: string): number {
  let n = 0;
  let i = 5;
  for (i = 0; i < s.length; i++) n += s.charCodeAt(i);
  return n + i;
}

function whileForm(s: string): number {
  let n = 0;
  let i = 0;
  while (i < s.length) {
    n = (n * 31 + s.charCodeAt(i)) | 0;
    i++;
  }
  return n + i;
}

function hoisted(s: string): number {
  let n = 0;
  const len = s.length;
  for (let i = 0; i < len; i++) n = (n * 31 + s.charCodeAt(i)) | 0;
  return n;
}

function ofForm(s: string): string {
  let n = 0;
  let marks = 0;
  for (const ch of s) {
    n++;
    if (ch === "<" || ch === "&") marks++;
  }
  return n + "/" + marks;
}

function indexed(s: string): string {
  let lt = 0;
  let amp = 0;
  let i = 0;
  for (; i < s.length; i++) {
    if (s[i] === "<") lt++;
    if (s.charAt(i) === "&") amp++;
  }
  return lt + "/" + amp + "/" + String(s[i]) + "/" + JSON.stringify(s.charAt(i));
}

function codePoints(s: string): number {
  let n = 0;
  let i = 0;
  for (; i < s.length; i++) n = (n * 31 + (s.codePointAt(i) ?? -1)) | 0;
  return n;
}

class Holder {
  text: string;
  constructor(text: string) {
    this.text = text;
  }
  scan(): number {
    let n = 0;
    let i = 0;
    for (; i < this.text.length; i++) n = (n * 31 + this.text.charCodeAt(i)) | 0;
    return n + i;
  }
  // The field is assigned in the loop.
  shrink(): number {
    let n = 0;
    let i = 0;
    for (; i < this.text.length; i++) {
      n += this.text.charCodeAt(i);
      if (i === 2) this.text = this.text.slice(0, 5);
    }
    return n + i;
  }
}

const FIXED: string = 'module <constant> & "text"';
function moduleConstant(): number {
  let n = 0;
  let i = 0;
  for (; i < FIXED.length; i++) n = (n * 31 + FIXED.charCodeAt(i)) | 0;
  return n + i;
}

for (const s of TEXTS) {
  console.log(JSON.stringify(s));
  console.log(
    " scan",
    head(s),
    before(s),
    beforeSwitch(s),
    beforeUntil(s, 38),
    beforeUntil(s, 0x4e2d),
    beforePairs(s),
    beforeReassigned(s),
    assignedInHead(s),
    whileForm(s),
    hoisted(s),
    ofForm(s),
    indexed(s),
    codePoints(s),
  );
  console.log(
    " from",
    beforeFrom(s, 0),
    beforeFrom(s, -2),
    beforeFrom(s, 1.5),
    beforeFrom(s, s.length - 1),
    beforeFrom(s, s.length),
    beforeFrom(s, NaN),
    beforeFrom(s, -0),
  );
  const h = new Holder(s);
  console.log(" field", h.scan(), h.shrink(), h.scan(), JSON.stringify(h.text));
}
console.log("module", moduleConstant(), s0());

function s0(): string {
  // Reads out of range and at indexes that are not integers.
  const s = "abé";
  return [
    s.charCodeAt(-1),
    s.charCodeAt(3),
    s.charCodeAt(1.9),
    s.charCodeAt(NaN),
    String(s[3]),
    String(s[-1]),
    JSON.stringify(s.charAt(7)),
    String(s.codePointAt(3)),
  ].join(" ");
}
