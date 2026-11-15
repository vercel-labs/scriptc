// Character classes whose members are written in every order: ranges after
// Unicode properties, ranges that overlap, touch, repeat or run backwards
// through the code points, single characters between them, negation, case
// folding, and the v flag's subtraction and intersection after a single
// character. Every pattern is built at run time, so the regex compiler in
// the program parses it. Node.js prints the same.

const PROBES: string[] = [
  "a", "m", "z", "A", "M", "Z", "0", "5", "9", "_", "-", " ", "\t", "\n", ".", ",", "!", "+", "$", "^", "]", "\\",
  "é", "ß", "ſ", "K", "α", "ω", "Ω", "ж", "中", "한", "ー", "、", "！", "＄", "€", "←", "😀", "𝒜", "\u{16fe0}", "\u{2f800}",
];

function hits(source: string, flags: string): string {
  const re = new RegExp(source, flags);
  let out = "";
  for (const probe of PROBES) {
    if (re.test(probe)) out += probe === "\n" ? "\\n" : probe === "\t" ? "\\t" : probe;
  }
  return `/${source}/${flags} ${re.flags} [${out}]`;
}

function wide(count: number, step: number, width: number, reverse: boolean): string {
  const parts: string[] = [];
  for (let i = 0; i < count; i++) {
    const first = 0x3000 + i * step;
    parts.push(`\\u${first.toString(16)}-\\u${(first + width).toString(16)}`);
  }
  if (reverse) parts.reverse();
  return parts.join("");
}

const sources: [string, string][] = [
  ["[a-cx-zm]", ""],
  ["[x-za-cm]", ""],
  ["[a-mh-zc-e]", ""],
  ["[a-cd-fg-i]", ""],
  ["[zzaamm]", ""],
  ["[m-ma-az-z]", ""],
  ["[^x-za-cm0-9]", ""],
  ["[\\d_a-c\\s.]", ""],
  ["[a-c\\W]", ""],
  ["[\\]\\\\^$-]", ""],
  ["[z-]", ""],
  ["[-a]", ""],
  ["[a\\-c]", ""],
  ["[k-mK]", "i"],
  ["[ſß]", "i"],
  ["[a-cſ]", "iu"],
  ["[\\p{P}a-c\\p{S}x-z]", "u"],
  ["[a-c\\p{P}x-z\\p{S}0]", "u"],
  ["[\\s\\p{P}\\p{S}\\u3000-\\u303f\\uac00-\\ud7a3\\u{16fe0}-\\u{16fe4}]", "u"],
  ["[^\\s\\p{P}\\p{S}\\u3000-\\u303f\\uac00-\\ud7a3\\u{16fe0}-\\u{16fe4}]", "u"],
  ["[\\u{2f800}-\\u{2fa1f}\\uac00-\\ud7a3a-c\\p{Lu}]", "u"],
  ["[\\p{Script=Greek}a-zж]", "u"],
  ["[\\P{L}a-z]", "u"],
  [`[\\p{P}${wide(40, 0x40, 0x20, false)}]`, "u"],
  [`[\\p{P}${wide(40, 0x40, 0x20, true)}]`, "u"],
  [`[${wide(40, 0x40, 0x20, true)}\\p{P}]`, "u"],
  [`[^${wide(40, 0x40, 0x50, true)}a-z]`, "u"],
  [`[${wide(64, 0x10, 0x10, false)}]`, "u"],
  ["[k-mK]", "iu"],
  ["[a--a]", "v"],
  ["[_--a]", "v"],
  ["[_&&\\w]", "v"],
  ["[a&&[a-c]&&\\p{Ll}]", "v"],
  ["[[a-zé]--[m-z]--é]", "v"],
  ["[[x-za-cm]&&[a-y]]", "v"],
  ["[\\p{L}--[a-z]--[α-ω]]", "v"],
  ["[a-cx-z[0-5]\\p{Lu}m]", "v"],
  ["[^a-cx-z[0-5]m]", "v"],
  ["[k-mK]", "iv"],
];

for (const [source, flags] of sources) console.log(hits(source, flags));

// A class repeated inside one pattern, and patterns built from shared parts.
const set = `[\\s\\p{P}\\p{S}${wide(12, 0x100, 0x7f, false)}]`;
const other = `[^\\s\\p{P}\\p{S}${wide(12, 0x100, 0x7f, false)}]`;
const delimiter = new RegExp(`${other}(\\*+)(?=${set}|$)|${set}(\\*+)(?=${other})|^(\\*+)(?=${other})`, "gu");
for (const text of ["a* b", "*a", "、*中", "a**、", "한*a *b"]) {
  const found: string[] = [];
  for (const match of text.matchAll(delimiter)) found.push(`${match.index}:${match[0]}`);
  console.log(JSON.stringify(text), found.join(" "));
}

// What the constructor rejects stays rejected, with the same error class.
for (const [source, flags] of [["[z-a]", ""], ["[\\d-a]", "u"], ["[a-\\d]", "u"], ["[a-c--b]", "v"], ["[ab--c]", "v"], ["[a-z", ""]] as [string, string][]) {
  try {
    new RegExp(source, flags);
    console.log(`/${source}/${flags} accepted`);
  } catch (error) {
    console.log(`/${source}/${flags} ${error instanceof SyntaxError ? "SyntaxError" : "other"}`);
  }
}
