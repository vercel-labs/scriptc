// Searches whose patterns begin with fixed sequences of characters and
// classes (literal alternations, classes, fixed repetitions), over subjects
// of every length from 0 to 80 and with matches at every offset: match,
// matchAll, search, exec with captures, global and sticky lastIndex,
// replace, case-insensitive letters, multiline anchors and word boundaries.
// Results must not depend on where a match falls relative to 16-character
// blocks or the end of the subject.
const patterns: RegExp[] = [
  /agggtaaa|tttaccct/gi,
  /[cgt]gggtaaa|tttaccc[acg]/gi,
  /ab|abc|b/g,
  /(ab)(c|d)x/g,
  /x[0-9]{3}y/g,
  /(?:no|yes)(!+)/gi,
  /^ab/gm,
  /\bcat\b/g,
  /a{2}(b+)c/g,
  /[A-Z][a-z]{2}-[0-9]/g,
];

function describe(re: RegExp, subject: string): string {
  const parts: string[] = [];
  const all = subject.match(re);
  parts.push(`match=${all === null ? "null" : JSON.stringify(all)}`);
  parts.push(`search=${subject.search(re)}`);
  const rows: string[] = [];
  for (const m of subject.matchAll(re)) rows.push(`${m.index}:${JSON.stringify(m.slice(0))}`);
  parts.push(`all=[${rows.join(" ")}]`);
  parts.push(`replace=${JSON.stringify(subject.replace(re, "<$&>"))}`);
  return parts.join(" ");
}

const filler = "qwertyuiopasdfghjklzxcvbnm";
const needles = ["agggtaaa", "TTTACCCT", "tttacccg", "abcx", "abdx", "x123y", "NO!!", "yes!", "cat", "aabbbc", "Abc-1", "ab"];
let checksum = 0;
let lines = 0;
for (let length = 0; length <= 80; length += 7) {
  for (const needle of needles) {
    for (const offset of [0, 1, 14, 15, 16, 17, 31, 32, 33]) {
      if (offset + needle.length > length) continue;
      let subject = "";
      while (subject.length < length) subject += filler;
      subject = subject.slice(0, offset) + needle + subject.slice(offset + needle.length, length);
      for (const re of patterns) {
        const text = describe(re, subject);
        for (let i = 0; i < text.length; i++) checksum = (checksum * 31 + text.charCodeAt(i)) >>> 0;
        lines++;
        if (length === 35 && (offset === 15 || offset === 16)) console.log(re.source, offset, needle, text);
      }
    }
  }
}
console.log("lines", lines, "checksum", checksum);

// Overlapping candidates: every start position looks like a match for the
// first characters, and only some complete.
const dense = "agggtaa".repeat(9) + "agggtaaa" + "tttaccc".repeat(5) + "tttaccct";
console.log(describe(/agggtaaa|tttaccct/g, dense));

// exec with lastIndex, global and sticky.
const re = /x[0-9]{3}y/g;
const text = "zzx111yzzzzzzzzzzzzzzzzzzx222yx333y" + "z".repeat(20) + "x444y";
let m: RegExpExecArray | null;
const found: string[] = [];
while ((m = re.exec(text)) !== null) found.push(`${m[0]}@${m.index}->${re.lastIndex}`);
console.log("exec", found.join(" "));
const sticky = /x[0-9]{3}y/y;
sticky.lastIndex = 2;
console.log("sticky", sticky.test(text), sticky.lastIndex, sticky.test(text), sticky.lastIndex);

// Short subjects and the tail.
for (const subject of ["", "a", "agggtaa", "agggtaaa", "zagggtaaa", "z".repeat(16) + "agggtaaa", "z".repeat(23) + "tttaccct"]) {
  console.log(JSON.stringify(subject.slice(-12)), subject.length, describe(/agggtaaa|tttaccct/gi, subject));
}

// A long subject with matches spread through it.
let long = "";
for (let i = 0; i < 2000; i++) long += i % 97 === 0 ? "aGgGtAaA" : i % 89 === 0 ? "tttACCCt" : filler[i % filler.length];
console.log("long", (long.match(/agggtaaa|tttaccct/gi) ?? []).length, long.search(/tttaccct/i));
