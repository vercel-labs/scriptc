// Scans whose loop version guard must not take a fast copy blindly: a string
// that stops or starts being ASCII inside the loop, a loop that appends to
// the string it scans, a `switch` on the unit with fallthrough and with its
// default in the middle, reads at an index that is not the loop's counter,
// two strings of different representations under one bound, strings whose
// text is ASCII but was cut out of non-ASCII text (and the reverse), slices
// that start at an offset, a loop over a counter declared before it that
// appends to another string, and a `switch` in a function the loop calls.

const TEXTS: string[] = [
  "",
  "a&b<c",
  "plain ascii text 0123456789",
  "café <ü> & 中文",
  "pair \u{1F600} & lone \ud83d < end",
  "é",
  "x".repeat(40) + "é" + "<&>",
  "<&>".repeat(9),
];

function scan(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) n = (n * 31 + s.charCodeAt(i)) | 0;
  return n;
}

function scanBefore(s: string): number {
  let n = 0;
  let i = 0;
  for (; i < s.length; i++) {
    const c = s.charCodeAt(i);
    switch (c) {
      case 38:
        n += 7;
        break;
      case 60:
        n += 70;
        break;
      default:
        n = (n * 3 + c) | 0;
    }
  }
  return n + i;
}

// The scanned binding stops being ASCII inside the loop, and becomes ASCII
// again later.
function flips(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    n = (n * 33 + c) | 0;
    if (c === 38) s = s.slice(0, i + 1) + "é中" + s.slice(i + 1);
    else if (c === 0xe9) s = s.slice(0, i) + "e" + s.slice(i + 1);
    else if (c === 0x4e2d) s = s.slice(0, i) + s.slice(i + 1);
  }
  return n + s.length;
}

// The loop appends to the string it scans, ASCII text and other text.
function grows(s: string): string {
  let i = 0;
  let seen = 0;
  for (; i < s.length && s.length < 120; i++) {
    const c = s.charCodeAt(i);
    seen = (seen * 5 + c) | 0;
    if (c === 60) s += ">";
    else if (c === 38) s += "é";
    else if (c === 0xe9) s += "e";
  }
  return `${s.length}:${i}:${seen}:${JSON.stringify(s.slice(-3))}`;
}

// Fallthrough between cases, the default in the middle, cases that share a
// body, and a last case without a break.
function fallthrough(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    switch (s.charCodeAt(i)) {
      case 38:
        n += 1;
      // falls through
      case 60:
        n += 10;
        break;
      default:
        n += 100;
      // falls through
      case 62:
        n += 1000;
        break;
      case 0xe9:
      case 0x4e2d:
        n += 10000;
    }
    n = n | 0;
  }
  return n;
}

// The same with the counter declared before the loop and a `continue`.
function fallthroughBefore(s: string): number {
  let n = 0;
  let i = 0;
  for (; i < s.length; i++) {
    const c = s.charCodeAt(i);
    switch (c) {
      default:
        if (c > 127) continue;
        n += 3;
      // falls through
      case 32:
        n += 50;
        break;
      case 38:
      case 60:
        n += 700;
      // falls through
      case 62:
        n += 9000;
    }
    n = (n + i) | 0;
  }
  return n + i;
}

// A `switch` on the character as a string.
function switchChar(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    switch (s[i]) {
      case "&":
        out += "A";
      // falls through
      case "<":
        out += "L";
        break;
      case "é":
        out += "E";
        break;
      default:
        if (i % 9 === 0) out += ".";
    }
  }
  return out;
}

// Reads at indexes that are not the counter: a second variable that runs
// backwards, a computed index, an index past the bound, a negative one.
function otherIndexes(s: string): number {
  let n = 0;
  let j = s.length - 1;
  for (let i = 0; i < s.length; i++, j--) {
    const wrapped = s.charCodeAt((i * 7) % s.length);
    const ahead = s.charCodeAt(i + 2) | 0;
    const behind = s.charCodeAt(i - 3) | 0;
    n = (n * 31 + s.charCodeAt(j) * 3 + wrapped + ahead - behind) | 0;
  }
  for (let i = 0; i < s.length; i += 2) n = (n + (s.charCodeAt(i * 2) || -1)) | 0;
  return n;
}

// The counter is not the index at all: the index is stepped in the body.
function steppedInBody(s: string): number {
  let n = 0;
  let at = 0;
  for (let round = 0; round < s.length; round++) {
    const c = s.charCodeAt(at);
    n = (n * 31 + c) | 0;
    at += c === 38 ? 2 : 1;
    if (at >= s.length) at = 0;
  }
  return n + at;
}

// One bound, two strings: the other string is shorter, longer, and of the
// other representation.
function twoStrings(a: string, b: string): number {
  let n = 0;
  for (let i = 0; i < a.length; i++) {
    n = (n * 31 + a.charCodeAt(i) + (b.charCodeAt(i) | 0) * 2) | 0;
  }
  return n;
}

// A slice that starts at an offset, scanned through a binding and directly.
function slices(s: string): string {
  const out: number[] = [];
  for (const from of [0, 1, 3, s.length - 2, s.length]) {
    const t = s.slice(from);
    out.push(scan(t), scanBefore(t));
    let n = 0;
    for (let i = 0; i < s.substring(from, from + 5).length; i++) {
      n = (n * 31 + s.substring(from, from + 5).charCodeAt(i)) | 0;
    }
    out.push(n);
  }
  return out.join(",");
}

// The counter is declared before the loop and the loop appends to another
// string: with a start the caller chooses, and with a second read at a
// fixed index beside the read at the counter.
function escapedFrom(s: string, start: number): string {
  let out = "";
  let i = start;
  for (; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 60) out += "&lt;";
    else if (c === 38) out += "&amp;";
    else if (c > 127) out += "?";
  }
  return `${out}:${i}`;
}
function firstAndEach(s: string): string {
  let out = "";
  let i = 1;
  for (; i < s.length; i++) if (s.charCodeAt(i) === s.charCodeAt(0)) out += i;
  return `${out}:${i}`;
}

// The `switch` is in a function the loop calls, one call deep and two.
function weight(c: number): number {
  let w = 1;
  switch (c) {
    case 38:
      w = 7;
      break;
    case 60:
    case 62:
      w = 70;
      break;
    case 0xe9:
      w = 700;
      break;
  }
  return w;
}
function doubled(c: number): number {
  return weight(c) * 2;
}
function weighed(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) n = (n + weight(s.charCodeAt(i))) | 0;
  let j = 0;
  for (; j < s.length; j++) n = (n * 3 + doubled(s.charCodeAt(j))) | 0;
  return n + j;
}

// Text that is ASCII but was made from non-ASCII text, and the reverse.
function derived(): string[] {
  const wide = "é<&>中";
  const made: string[] = [
    wide.slice(1, 4),
    wide.substring(1, 2) + wide.substring(3, 4),
    "<&>" + String.fromCharCode(0xe9),
    String.fromCharCode(0xff) + "a",
    String.fromCharCode(38, 60, 62),
    String.fromCodePoint(0x1f600) + "z",
    ["a", "é", "b"].join(""),
    ["<", "&"].join(">"),
    "é".repeat(3) + "a".repeat(3),
    "aéa".replace("é", "e"),
    "a<a".replace("<", "é"),
    "  é&  ".trim(),
    "<".padEnd(4, "é"),
    wide.charAt(1) + wide.charAt(2),
    wide.split("").reverse().join(""),
    JSON.parse('"\\u00e9<&"') as string,
    JSON.parse('"<&\\u0041"') as string,
    `${wide.length}&${wide[0]}`,
    wide.toUpperCase().toLowerCase(),
  ];
  return made.map(
    (s) => `${JSON.stringify(s)} ${scan(s)} ${scanBefore(s)} ${fallthrough(s)} ${switchChar(s)}`,
  );
}

for (const s of TEXTS) {
  console.log(JSON.stringify(s.slice(0, 24)), s.length);
  console.log(
    " loops",
    scan(s),
    scanBefore(s),
    flips(s),
    grows(s),
    fallthrough(s),
    fallthroughBefore(s),
    JSON.stringify(switchChar(s)),
  );
  console.log(" index", otherIndexes(s), steppedInBody(s), slices(s));
  console.log(
    " calls",
    JSON.stringify(escapedFrom(s, 0)),
    JSON.stringify(escapedFrom(s, 3)),
    JSON.stringify(firstAndEach(s)),
    weighed(s),
  );
  console.log(
    " pairs",
    TEXTS.map((other) => twoStrings(s, other)).join(","),
  );
}
for (const line of derived()) console.log(line);
