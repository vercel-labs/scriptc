// Token scans that alternate between two non-ASCII strings: each inner loop
// starts at a token and runs while the class holds, so every token enters a
// loop over one of the strings again. Also a string extended in place
// between scans, strings rebuilt with the same length and new content, and
// slices of a scanned string.

function isWord(c: number): boolean {
  return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c >= 0xc0;
}

function isDigit(c: number): boolean {
  return c >= 48 && c <= 57;
}

// The kinds and lengths of s's tokens, hashed.
function lex(s: string): number {
  let h = 0,
    tokens = 0,
    pos = 0;
  const end = s.length;
  while (pos < end) {
    const c = s.charCodeAt(pos);
    let start = pos;
    if (isWord(c)) {
      while (pos < end && isWord(s.charCodeAt(pos))) pos++;
      h = (h * 31 + 1) | 0;
    } else if (isDigit(c)) {
      while (pos < end && isDigit(s.charCodeAt(pos))) pos++;
      h = (h * 31 + 2) | 0;
    } else if (c === 32) {
      while (pos < end && s.charCodeAt(pos) === 32) pos++;
      start = pos;
    } else {
      pos++;
      h = (h * 31 + c) | 0;
    }
    h = (h * 31 + (pos - start)) | 0;
    tokens++;
  }
  return h ^ tokens;
}

// Two strings lexed token by token in turn: each token's loop runs over a
// different receiver than the one before it.
function interleave(a: string, b: string): number {
  let i = 0,
    j = 0,
    h = 0;
  while (i < a.length || j < b.length) {
    const fromA = i < a.length;
    while (i < a.length && a.charCodeAt(i) !== 32) {
      h = (h * 31 + a.charCodeAt(i)) | 0;
      i++;
    }
    i++;
    while (j < b.length && b.charCodeAt(j) !== 32) {
      h = (h * 37 + b.charCodeAt(j)) | 0;
      j++;
    }
    j++;
    if (fromA) h = (h + 1) | 0;
  }
  return h;
}

// The sum of every unit of s.
function units(s: string): number {
  let sum = 0;
  for (let i = 0; i < s.length; i++) sum += s.charCodeAt(i);
  return sum;
}

function text(seed: number, words: number): string {
  const parts = ["café", "naïve", "façade", "x", "😀", "Ωmega", "über", "ab"];
  let s = "";
  for (let k = 0; k < words; k++) {
    s += parts[(seed + k * 7) % parts.length]!;
    s += k % 5 === 0 ? " " + ((seed * k) % 1000) + " " : k % 3 === 0 ? "; " : " ";
  }
  return s;
}

const first = text(1, 300),
  second = text(4, 280);
for (let pass = 0; pass < 3; pass++) {
  console.log(lex(first), lex(second), lex(first), units(second), units(first));
  console.log(interleave(first, second), interleave(second, first));
}

// Extended in place between scans: the second scan reads the new units.
let grown = text(2, 120);
console.log(lex(grown), units(grown), grown.length);
for (let round = 0; round < 4; round++) {
  grown += round % 2 === 0 ? " é1 ü22 " : " 😀 tail ";
  console.log(lex(grown), units(grown), grown.length, interleave(grown, first));
}

// Same length, different content, built after the previous one is dropped.
for (let round = 0; round < 6; round++) {
  const s = round % 2 === 0 ? "é".repeat(200) + " a" : "ü".repeat(200) + " b";
  console.log(lex(s), units(s), units(s.slice(0, 100)), lex(second));
}

// Slices of a scanned string, scanned between scans of the whole.
for (const at of [0, 7, 101, first.length - 9]) {
  const part = first.slice(at, at + 64);
  console.log(lex(part), units(part), lex(first), units(part.slice(3)));
}
