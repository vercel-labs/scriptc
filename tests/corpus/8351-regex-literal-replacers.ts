// Global substitutions of regex literals with literal replacements: matches
// at every offset around 16-character blocks and at the end of the
// subject, empty matches, alternation order, case-insensitive and
// multiline flags, word boundaries, replacements that are empty, longer
// than the match or hold quotes and backslashes, outputs that grow far past
// the subject, subjects without a match, and subjects outside ASCII (which
// take the general loop). replace and replaceAll.
const substitutions: [string, (s: string) => string][] = [
  ["<[^>]*>", (s) => s.replace(/<[^>]*>/g, "|")],
  ["a[NSt]|BY", (s) => s.replace(/a[NSt]|BY/g, "<2>")],
  ["tHa[Nt]", (s) => s.replace(/tHa[Nt]/g, "<4>")],
  ["\\|[^|][^|]*\\|", (s) => s.replace(/\|[^|][^|]*\|/g, "-")],
  ["x*", (s) => s.replace(/x*/g, "-")],
  ["\\b", (s) => s.replace(/\b/g, "^")],
  ["^ab", (s) => s.replace(/^ab/gm, "Z")],
  ["ab|abc|b", (s) => s.replace(/ab|abc|b/g, "#")],
  ["AB (i)", (s) => s.replace(/AB/gi, "")],
  ["(a)(b)?", (s) => s.replace(/(a)(b)?/g, "q")],
  ["\\d+", (s) => s.replace(/\d+/g, '"\\\n')],
  ["[^a-z]", (s) => s.replace(/[^a-z]/g, "")],
  ["a", (s) => s.replace(/a/g, "<<<<a>>>>")],
  ["cat (replaceAll)", (s) => s.replaceAll(/cat/g, "dog")],
  ["[aeiou]{2} (replaceAll)", (s) => s.replaceAll(/[aeiou]{2}/g, "~")],
];

function hash(text: string, h: number): number {
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return h;
}

const filler = "qwertyuiop asdfghjkl zxcvbnm";
const needles = ["<2>", "<abc>", "aN", "BY", "tHat", "|ab|", "||", "xx", "ab", "abc", "AB", "123", "cat", "aeio", "a"];
let checksum = 0;
let lines = 0;
for (let length = 0; length <= 70; length += 7) {
  for (const needle of needles) {
    for (const offset of [0, 1, 14, 15, 16, 17, 31, 32, 33]) {
      if (offset + needle.length > length) continue;
      let subject = "";
      while (subject.length < length) subject += filler;
      subject = subject.slice(0, offset) + needle + subject.slice(offset + needle.length, length);
      for (const [name, sub] of substitutions) {
        const out = sub(subject);
        checksum = hash(out, checksum);
        lines++;
        if (length === 35 && (offset === 15 || offset === 16)) console.log(name, offset, JSON.stringify(out));
      }
    }
  }
}
console.log("lines", lines, "checksum", checksum);

// Dense matches, matches that end the subject, and an output many times
// larger than the subject.
const dense = "<1><22><333>".repeat(40) + "tail<x>";
for (const [name, sub] of substitutions) console.log(name, JSON.stringify(sub(dense).slice(-40)), sub(dense).length);
const many = "a".repeat(5000);
console.log("grow", many.replace(/a/g, "<<<<a>>>>").length, many.replace(/a/g, "<<<<a>>>>").slice(4990));
console.log("empty", JSON.stringify("".replace(/x*/g, "-")), JSON.stringify("".replace(/a/g, "b")));
console.log("none", "zzzz".replace(/a[bc]/g, "!"), "zzzz".replaceAll(/a[bc]/g, "!"));

// Subjects outside ASCII run the general loop with the same results.
for (const subject of ["héllo <x> wörld <yy>", "日本<語>", "a\u{1F600}b<c>", "cat café cat"]) {
  console.log(JSON.stringify(subject.replace(/<[^>]*>/g, "|")), JSON.stringify(subject.replaceAll(/cat/g, "dog")), JSON.stringify(subject.replace(/x*/g, "-")));
}

// A long DNA-like subject, as in regex-redux.
let dna = "";
for (let i = 0; i < 4000; i++) dna += "acgt"[(i * 7 + (i >> 2)) % 4] + (i % 61 === 0 ? "tHaN" : i % 37 === 0 ? "aNBY" : "");
const step1 = dna.replace(/tHa[Nt]/g, "<4>").replace(/a[NSt]|BY/g, "<2>");
const step2 = step1.replace(/<[^>]*>/g, "|").replace(/\|[^|][^|]*\|/g, "-");
console.log("dna", dna.length, step1.length, step2.length, hash(step2, 0));
