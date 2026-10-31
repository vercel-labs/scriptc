// Code point iteration over mixed text: a word tokenizer over for-of, a
// character histogram, reversal through spread, and Array.from over
// words. The text mixes ASCII, Latin-1 letters, CJK and emoji.
let seed = 11;
function random(): number {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  return seed / 4294967296;
}
const pieces = [
  "the", "quick", "brown", "fox", "jumps", "over", "lazy", "dog",
  "café", "naïve", "über", "señor", "straße", "déjà", "vu",
  "日本", "語", "テキスト", "中文", "한국어",
  "😀", "🚀", "👍", "🎉",
];
const punctuation = [" ", " ", " ", ", ", ". ", "! ", "\n"];
const scale = Number(process.argv[2] ?? "1");
const lines: string[] = [];
for (let i = 0; i < Math.floor(4000 * scale); i++) {
  let line = "";
  const words = 6 + Math.floor(random() * 10);
  for (let w = 0; w < words; w++) {
    line += pieces[Math.floor(random() * pieces.length)]!;
    line += punctuation[Math.floor(random() * punctuation.length)]!;
  }
  lines.push(line);
}

function isWordChar(c: string): boolean {
  const code = c.codePointAt(0)!;
  return (code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a) || code >= 0xc0;
}

let tokens = 0;
let tokenUnits = 0;
let reversedLength = 0;
let fromLength = 0;
const histogram = new Map<string, number>();
for (let round = 0; round < 30; round++) {
  for (const line of lines) {
    let word = "";
    for (const c of line) {
      if (isWordChar(c)) {
        word += c;
        continue;
      }
      if (word !== "") {
        tokens++;
        tokenUnits += word.length;
        if (round === 0) histogram.set(word, (histogram.get(word) ?? 0) + 1);
        fromLength += Array.from(word).length;
        word = "";
      }
    }
    reversedLength += [...line].reverse().join("").length;
  }
}
const top = [...histogram].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 5);
console.log(top.map(([word, count]) => `${word}:${count}`).join(" "));
console.log("tokens", tokens, "units", tokenUnits, "reversed", reversedLength, "from", fromLength);
