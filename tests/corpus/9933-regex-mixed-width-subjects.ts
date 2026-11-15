// Regular expressions on subjects whose characters have every UTF-16 and
// UTF-8 width: ASCII, two- and three-byte characters, astral characters
// (two UTF-16 units, four bytes) and unpaired surrogates. A non-ASCII
// subject is matched on its stored bytes, so everything JavaScript sees as
// a UTF-16 index is pinned here: `index`, `lastIndex` (also when it points
// between the halves of a pair), replacer offsets, `search`, and the text
// of matches and captures that begin or end inside a pair. With and without
// the u flag, case-insensitive matching across non-ASCII, back references,
// lookbehind, and the empty-match loops.
export {};

function codes(text: string): string {
  const out: string[] = [];
  for (let i = 0; i < text.length; i++) out.push(text.charCodeAt(i).toString(16));
  return `[${out.join(" ")}]`;
}

function matchShown(m: RegExpMatchArray | null): string {
  if (m === null) return "null";
  const parts: string[] = [];
  for (let i = 0; i < m.length; i++) parts.push(m[i] === undefined ? "-" : codes(m[i]!));
  return `${m.index}:${parts.join(",")}`;
}

const face = "\u{1F600}";
const hi = "\ud83d";
const lo = "\ude00";
const subjects: string[] = [
  `a${face}b`,
  `${face}${face}`,
  `é${face}—a${face}`,
  `${hi}a${lo}`,
  `${lo}${hi}`,
  `${hi}${hi}${lo}${lo}`,
  `x—yéz`,
  `KKk sſS Σσς`,
  `naïve café — ${face} ok`,
  ` a b\nc`,
  `ab${face}ab${face}ab`,
];

const patterns: RegExp[] = [
  /./g,
  /./gu,
  /./gs,
  /[^a]/g,
  /[^a]/gu,
  /\ud83d/g,
  /\ude00/g,
  /\ud83d/gu,
  /😀/g,
  /\u{1F600}/gu,
  /[\u{1F600}-\u{1F64F}]/gu,
  /[\ud800-\udbff]/g,
  /[\udc00-\udfff]/g,
  /(?<=\ud83d)./g,
  /(?<=\ud83d)./gu,
  /(?<!\ud83d)\ude00/g,
  /.(?=\ude00)/g,
  /(.)\1/g,
  /(.)\1/gu,
  /(é|—|a)[^]*?\1/g,
  /\w+/g,
  /\w+/giu,
  /\W/gu,
  /\b/g,
  /k/gi,
  /k/giu,
  /s/gi,
  /s/giu,
  /σ/gi,
  /[à-ÿ]/gi,
  /É/gi,
  /^./gm,
  /.$/gm,
  /^/gm,
  /$/gmu,
  /(?:)/g,
  /(?:)/gu,
  /a|—|(?=b)/g,
  /[^—]+/y,
  /./y,
  /./uy,
  /ab/gy,
  /(a)|(b)|(é)|(.)/gu,
];

for (const re of patterns) {
  const twin = new RegExp(re.source, re.flags);
  for (const s of subjects) {
    const out: string[] = [];
    for (const r of [re, twin]) {
      const parts: string[] = [];
      r.lastIndex = 0;
      parts.push(`exec=${matchShown(r.exec(s))}@${r.lastIndex}`);
      r.lastIndex = 0;
      parts.push(`test=${r.test(s)}@${r.lastIndex}`);
      r.lastIndex = 0;
      parts.push(`search=${s.search(r)}`);
      // Every lastIndex, the ones between the halves of a pair included.
      const steps: string[] = [];
      for (let from = 0; from <= s.length + 1; from++) {
        r.lastIndex = from;
        const m = r.exec(s);
        steps.push(m === null ? `x@${r.lastIndex}` : `${m.index}+${m[0].length}@${r.lastIndex}`);
      }
      parts.push(`from=${steps.join(" ")}`);
      r.lastIndex = 0;
      if (r.global) {
        const all: string[] = [];
        for (const m of s.matchAll(r)) all.push(`${m.index}+${m[0].length}`);
        parts.push(`matchAll=${all.join(" ")}`);
        const found = s.match(r);
        parts.push(`match=${found === null ? "null" : codes(found.join("|"))}`);
        parts.push(`replaceAll=${codes(s.replaceAll(r, "<$&>"))}`);
      }
      parts.push(`replace=${codes(s.replace(r, "[$`|$&|$']"))}`);
      // A replacer's offset follows the captures: read it where there are none.
      if (!/\((?!\?)/.test(r.source))
        parts.push(`offsets=${codes(s.replace(r, (whole: string, offset: number) => `{${whole.length}@${offset}}`))}`);
      parts.push(`split=${codes(s.split(r, 6).join("|"))}`);
      parts.push(`last=${r.lastIndex}`);
      out.push(parts.join(" "));
    }
    console.log(`${re} ${codes(s)} ${out[0]}`);
    if (out[0] !== out[1]) console.log(`  constructed differs: ${out[1]}`);
  }
}

// A long text (the string index keeps checkpoints for it) walked by a
// global pattern, a sticky pattern and a replacer: every index is a UTF-16
// index although the text is stored with one to four bytes per character.
const line = `plain line, café — ${face} and a tail\n`;
const long = line.repeat(3000);
let count = 0;
let sum = 0;
const word = /[a-zé]+|\u{1F600}|—/gu;
let m: RegExpExecArray | null;
while ((m = word.exec(long)) !== null) {
  count++;
  sum = (sum + m.index * 31 + m[0].length + word.lastIndex) | 0;
  if (long.slice(m.index, m.index + m[0].length) !== m[0]) console.log("index is wrong at", m.index);
}
console.log("long exec loop", long.length, count, sum, word.lastIndex);

const token = /[a-zé]+|[^a-zé]/uy;
let at = 0;
let tokens = 0;
while (at < long.length) {
  token.lastIndex = at;
  const t = token.exec(long);
  if (t === null) break;
  tokens++;
  at = token.lastIndex;
}
console.log("long sticky walk", tokens, at);

// lastIndex set back and forth across the long text, also between the
// halves of a pair and past the end, by two patterns in turn: each call
// converts its lastIndex from wherever the call before it stopped.
let jumpSeed = 12345;
let jumpHash = 0;
const jumps: string[] = [];
const oneUnit = /[^]/y;
const onePoint = /[^]/uy;
for (let i = 0; i < 600; i++) {
  jumpSeed = (Math.imul(jumpSeed, 1103515245) + 12345) >>> 0;
  const from = i % 7 === 0 ? long.length - (jumpSeed % 60) + 2 : i % 3 === 0 ? jumpSeed % 200 : jumpSeed % (long.length + 3);
  const r = i % 2 === 0 ? oneUnit : onePoint;
  r.lastIndex = from;
  const hit = r.exec(long);
  const shown = hit === null ? `${from}:x@${r.lastIndex}` : `${from}:${hit.index}+${hit[0].length}:${hit[0].charCodeAt(0)}@${r.lastIndex}`;
  if (hit !== null && long.charCodeAt(hit.index) !== hit[0].charCodeAt(0)) console.log("jump is wrong at", from);
  for (let k = 0; k < shown.length; k++) jumpHash = (Math.imul(jumpHash, 31) + shown.charCodeAt(k)) | 0;
  if (i < 14) jumps.push(shown);
}
console.log("long jumps", jumpHash, jumps.join(" "));

let offsetSum = 0;
const replaced = long.replace(/—|\ud83d/g, (whole: string, offset: number) => {
  offsetSum = (offsetSum + offset) | 0;
  return whole === "—" ? "--" : "";
});
console.log("long replace", replaced.length, offsetSum, codes(replaced.slice(15, 30)));
console.log("long search", long.search(/\ude00 and a tail\nplain line, café — 😀 and a tail\n$/));
console.log("long split", long.split(/ — \ud83d/).length, long.split(/(?<=\ud83d)/u).length);
const tail = "x".repeat(70000) + "—end";
console.log("ascii prefix", tail.search(/—/), /^x+—end$/.test(tail), tail.replace(/x+/, "").length, /end$/.exec(tail)!.index);
