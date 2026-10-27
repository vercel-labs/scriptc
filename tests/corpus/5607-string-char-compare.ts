// Comparing one character of a string with a one-unit literal: index and
// charAt forms, === and !==, the literal on either side, indexes out of
// range, negative, fractional and NaN, multi-byte and astral text, lone
// surrogates, and literals of other lengths.
function bits(s: string, i: number): string {
  return [
    s[i] === "_", s.charAt(i) === "_", "_" === s.charAt(i), s.charAt(i) !== "_", s[i] !== "_",
    s[i] === "a", s.charAt(i) === "a", "a" === s.charAt(i), s.charAt(i) !== "a", s[i] !== "a",
    s[i] === "é", s.charAt(i) === "é", "é" === s.charAt(i), s.charAt(i) !== "é", s[i] !== "é",
    s[i] === "\uD83D", s.charAt(i) === "\uD83D", "\uD83D" === s.charAt(i), s.charAt(i) !== "\uD83D", s[i] !== "\uD83D",
    s[i] === "\uDE00", s.charAt(i) === "\uDE00", "\uDE00" === s.charAt(i), s.charAt(i) !== "\uDE00", s[i] !== "\uDE00",
    s[i] === "\uD800", s.charAt(i) === "\uD800", "\uD800" === s.charAt(i), s.charAt(i) !== "\uD800", s[i] !== "\uD800",
    s[i] === "語", s.charAt(i) === "語", "語" === s.charAt(i), s.charAt(i) !== "語", s[i] !== "語",
    s[i] === "", s.charAt(i) === "", "" === s.charAt(i), s.charAt(i) !== "", s[i] !== "",
    s[i] === "ab", s.charAt(i) === "ab", "ab" === s.charAt(i), s.charAt(i) !== "ab", s[i] !== "ab",
  ]
    .map((b) => (b ? "1" : "0"))
    .join("");
}
const samples: string[] = ["a_b", "", "é_ü", "x😀y", "\uD800z", "日本_語", "ab"];
const indexes = [0, 1, 2, 3, 4, -1, 1.5, NaN, 100];
for (const s of samples) console.log(JSON.stringify(s), indexes.map((i) => bits(s, i)).join(" "));

function countUnderscores(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text[i] === "_") n++;
  return n;
}
function firstSpace(text: string): number {
  for (let i = 0; i < text.length; i++) if (text.charAt(i) === " ") return i;
  return -1;
}
console.log(countUnderscores("a_b_c__d"), countUnderscores(""), firstSpace("type Foo = Bar"), firstSpace("none"));
let k = 0;
const s = "ab";
const at = (): number => k++;
console.log(s.charAt(at()) === "a", s.charAt(at()) === "a", k);
