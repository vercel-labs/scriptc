// charCodeAt and codePointAt on short non-ASCII strings: characters of each
// UTF-8 length, astral pairs, lone surrogates, out-of-range and non-integer
// indexes, strings at the 16-byte boundary, and a long receiver scanned in
// between.

const samples = [
  "é", "ß", "日", "語", "😀", "🚀", "a", "",
  "café", "naïve", "straße", "日本語", "テキスト", "한국어",
  "a😀b", "😀😀", "xéy日z",
  "\ud800", "\udc00", "a\ud800b", "\ud83d", "\ude00x",
  "0123456789abcdé", "0123456789abcdeé", "0123456789abcdefé", "ééééééé", "éééééééé", "ééééééééé",
];

function codes(s: string): string {
  const out: string[] = [];
  for (let i = -1; i <= s.length + 1; i++) out.push(String(s.charCodeAt(i)));
  out.push(String(s.charCodeAt(0.5)), String(s.charCodeAt(NaN)), String(s.charCodeAt(1.9)));
  return out.join(",");
}

function points(s: string): string {
  const out: string[] = [];
  for (let i = -1; i <= s.length + 1; i++) out.push(String(s.codePointAt(i)));
  return out.join(",");
}

for (const s of samples) {
  console.log(JSON.stringify(s), s.length, codes(s));
  console.log("  points", points(s));
}

// A long receiver scanned while short ones are read.
let long = "";
for (let i = 0; i < 200; i++) long += i % 3 === 0 ? "é" : i % 3 === 1 ? "日" : "x";
let sum = 0;
for (let i = 0; i < long.length; i++) {
  sum += long.charCodeAt(i);
  sum += samples[i % samples.length]!.charCodeAt(0) || 0;
}
console.log("long", long.length, sum);

// Characters of a for-of loop classified by their code points.
let letters = 0;
let others = 0;
for (const c of "the café, 日本 😀 naïve!") {
  const code = c.codePointAt(0)!;
  if ((code >= 0x61 && code <= 0x7a) || code >= 0xc0) letters++;
  else others++;
}
console.log("letters", letters, "others", others);
