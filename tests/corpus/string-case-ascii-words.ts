// toLowerCase and toUpperCase on ASCII strings of every length from 0 to 40,
// with the letters to convert at the start, the middle, the end, and every
// eighth position, and next to the bytes just outside A-Z and a-z ('@', '[',
// '`' and '{').
const alphabet = "AZaz@[`{09 _-~MmQq";
const words: string[] = [];
let seed = 2024;
function next(): number {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  return seed;
}
for (let length = 0; length <= 40; length++) {
  for (let sample = 0; sample < 6; sample++) {
    let word = "";
    for (let i = 0; i < length; i++) word += alphabet[next() % alphabet.length];
    words.push(word);
  }
  words.push("a".repeat(length), "A".repeat(length), "@".repeat(length), "{".repeat(length));
  if (length > 0) {
    words.push("x".repeat(length - 1) + "Q", "Q" + "x".repeat(length - 1));
    words.push(Array.from({ length }, (_, i) => (i % 8 === 7 ? "K" : "k")).join(""));
  }
}
let lowered = 0;
let raised = 0;
let digest = 0;
for (const word of words) {
  const lower = word.toLowerCase();
  const upper = word.toUpperCase();
  if (lower !== word) lowered++;
  if (upper !== word) raised++;
  for (let i = 0; i < lower.length; i++)
    digest = (Math.imul(digest, 31) + lower.charCodeAt(i) * 3 + upper.charCodeAt(i)) >>> 0;
  if (lower.length !== word.length || upper.length !== word.length) console.log("length changed", word);
}
console.log(words.length, lowered, raised, digest);
console.log(["Hello, World!", "user@Example.COM", "ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~"].map((w) => w.toLowerCase() + " " + w.toUpperCase()).join("\n"));
