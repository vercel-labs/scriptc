// .length of long non-ASCII strings: many texts read in turn, appends in
// place (including a lone high surrogate completed by a low one), strings
// freed and rebuilt at reused addresses, split pieces, and slices and
// searches on texts whose lengths were read before.
let unit = "";
while (unit.length < 300) unit += "naïve 日本語 ";
const texts: string[] = [];
for (let i = 0; i < 40; i++) texts.push(unit.repeat(1 + (i % 7)) + "é".repeat(i));
let sum = 0;
for (let r = 0; r < 3; r++) for (const t of texts) sum += t.length;
console.log(sum, texts[39].length, texts[0].length);

let grow = unit;
const lengths: number[] = [];
for (let i = 0; i < 20; i++) {
  grow += i % 2 ? "ü" : "x";
  lengths.push(grow.length);
}
console.log(lengths.join(","));
let pair = unit + "\uD83D";
const before = pair.length;
pair += "\uDE00";
console.log(before, pair.length, pair.codePointAt(pair.length - 2)!.toString(16));

const seen: number[] = [];
for (let i = 0; i < 50; i++) {
  const temp = unit + "ß".repeat(i % 5) + i;
  seen.push(temp.length);
}
console.log(seen.slice(0, 10).join(","), seen.reduce((a, b) => a + b, 0));

const parts = (unit + "|").repeat(30).split("|");
console.log(parts.length, parts[0].length, parts.map((p) => p.length).reduce((a, b) => a + b, 0));

const big = texts[39];
console.log(big.slice(big.length - 5), big.substring(10, 20).length, big.indexOf("日本"), big.lastIndexOf("é"), big.length);
