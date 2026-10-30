// UTF-16 index operations on long non-ASCII strings: slices and substrings
// walking forward and backward, interleaved on two strings, at astral
// characters and their halves, with negative and out-of-range indexes;
// lastIndexOf, startsWith and endsWith with positions; and normalize on
// text already in each form, composed and decomposed text, Hangul,
// compatibility characters and combining marks.

const unit = "Ünïcödé tëxt with ß and 日本語 and émoji 😀 mixed in, ";
const big = unit.repeat(3000);
const other = "ascii words then 中文 and 🎉🎉 and ü, ".repeat(4000);

function digest(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return h;
}

let forward = 0;
for (let i = 0; i + 30 < big.length; i += 7) {
  forward = (forward * 33 + digest(big.slice(i, i + 20)) + digest(big.substring(i + 3, i + 9))) >>> 0;
}
let backward = 0;
for (let i = big.length - 1; i > 30; i -= 11) {
  backward = (backward * 33 + digest(big.slice(i - 25, i)) + big.substring(i, i - 5).length) >>> 0;
}
let interleaved = 0;
for (let i = 0; i + 40 < other.length && i + 40 < big.length; i += 13) {
  interleaved = (interleaved * 33 + digest(big.slice(i, i + 9)) + digest(other.slice(i + 1, i + 40))) >>> 0;
}
console.log(big.length, forward, backward, interleaved);

// Indexes at astral characters and their halves.
const emojiAt = big.indexOf("😀", 100000);
console.log(
  emojiAt,
  JSON.stringify(big.slice(emojiAt, emojiAt + 1)),
  JSON.stringify(big.slice(emojiAt + 1, emojiAt + 3)),
  JSON.stringify(big.substring(emojiAt - 1, emojiAt + 1)),
  big.charCodeAt(emojiAt + 1),
  JSON.stringify(big.at(emojiAt + 1)),
  JSON.stringify(big.charAt(emojiAt)),
);
console.log(
  JSON.stringify(big.slice(-5)),
  JSON.stringify(big.slice(-30, -20)),
  big.slice(big.length - 3, big.length + 10).length,
  JSON.stringify(big.substring(-10, 4)),
  big.slice(5, 2).length,
  JSON.stringify(big.slice(NaN, 3)),
);
for (const at of [0, 1, 52, 99999, 150000, big.length - 1, big.length, -1, -2, -big.length]) {
  console.log(at, JSON.stringify(big.at(at)), JSON.stringify(big.charAt(at)), big.charCodeAt(at));
}

// lastIndexOf, startsWith and endsWith with positions.
console.log(
  big.lastIndexOf("日本"),
  big.lastIndexOf("日本", 100000),
  big.lastIndexOf("😀", 50),
  big.lastIndexOf("absent"),
  big.lastIndexOf("é", 0),
  big.lastIndexOf("Ü"),
  big.lastIndexOf(""),
  big.lastIndexOf("", 10),
);
let starts = 0;
let ends = 0;
for (let i = 0; i < big.length; i += 17) {
  if (big.startsWith("tëxt", i)) starts++;
  if (big.endsWith("😀", i)) ends++;
}
console.log(starts, ends, big.startsWith("Ü"), big.endsWith("in, "), big.startsWith("ünï"), big.endsWith("in, ", big.length - 1));

// normalize.
const samples = [
  "plain ascii",
  "précomposé café naïve",
  "décomposé café",
  "日本語のテキスト 한국어 문장",
  "각 각",
  "ｆｕｌｌｗｉｄｔｈ ｶﾀｶﾅ ﬁ ① ℌ ²",
  "ậ ậ ͅ",
  "Ω Å Å Ω K",
  "が が か゚",
  "emoji 😀 and \ud800 lone",
  unit,
];
for (const sample of samples) {
  const forms = ["NFC", "NFD", "NFKC", "NFKD"].map((form) => sample.normalize(form));
  console.log(
    forms.map((text) => `${text.length}:${digest(text)}`).join(" "),
    forms.map((text) => text === sample).join(","),
  );
}
const longNfc = big.normalize();
const longNfd = big.normalize("NFD");
console.log(longNfc === big, longNfc.length, longNfd.length, digest(longNfd.slice(0, 100)), longNfd.normalize("NFC") === big);
try {
  "x".normalize("NFX");
} catch (error) {
  console.log((error as Error).name, (error as Error).message);
}
