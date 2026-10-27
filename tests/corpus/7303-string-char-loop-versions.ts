// s[i] and s.charAt(i) in counted for loops: equality and switch tests with
// one-unit literals, character locals compared with ranges of one-unit
// literals on either side, characters used as strings (pushed, concatenated,
// map keys, compared with each other), reads past the end, fractional,
// negative and -0 indices, ASCII, Latin-1, BMP, surrogate pairs and lone
// surrogates, empty strings, a character local with other uses, a local
// compared with a longer literal, a string rebound in the loop and a
// module-level loop.

function spacesIndex(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s[i] === " ") n++;
  return n;
}

function nonSpaces(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charAt(i) !== " ") n++;
  return n;
}

function kinds(s: string): string {
  let letters = 0,
    digits = 0,
    upper = 0,
    other = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c >= "a" && c <= "z") letters++;
    else if ("0" <= c && "9" >= c) digits++;
    else if (c > "@" && c < "[") upper++;
    else other++;
  }
  return `${letters}/${digits}/${upper}/${other}`;
}

function punctuation(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i);
    switch (c) {
      case ".":
      case ",":
        n += 1;
        break;
      case "!":
        n += 10;
        break;
      case "é":
        n += 100;
        break;
      default:
        if (c === "?") n += 1000;
    }
  }
  return n;
}

function switchIndex(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    switch (s[i]) {
      case "a":
        n++;
        break;
      case "b":
        n += 2;
        break;
    }
  }
  return n;
}

function pastEnd(s: string): string {
  let below = 0,
    atMost = 0,
    above = 0,
    atLeast = 0;
  for (let i = 0; i <= s.length + 1; i++) {
    const c = s.charAt(i);
    if (c < "a") below++;
    if (c <= "z") atMost++;
    if (c > " ") above++;
    if (c >= "\0") atLeast++;
  }
  return `${below} ${atMost} ${above} ${atLeast}`;
}

function oddIndices(s: string): string {
  const out: string[] = [];
  for (let i = -2; i < 3; i++) out.push(JSON.stringify(s.charAt(i + 0.5)));
  out.push(JSON.stringify(s.charAt(-0)), JSON.stringify(s.charAt(NaN)));
  const c = s.charAt(-1);
  out.push(String(c < "a"), String(c >= "\0"));
  return out.join(",");
}

function chars(s: string): string {
  const out: string[] = [];
  for (let i = 0; i < s.length; i++) out.push(s.charAt(i));
  let reversed = "";
  for (let i = s.length - 1; i >= 0; i--) reversed += s[i];
  return `${out.join("|")} ${reversed}`;
}

function counts(s: string): string {
  const seen = new Map<string, number>();
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    seen.set(c, (seen.get(c) ?? 0) + 1);
  }
  return [...seen].map(([c, n]) => `${c}${n}`).join("");
}

function sameAt(a: string, b: string): number {
  let n = 0;
  const end = Math.min(a.length, b.length);
  for (let i = 0; i < end; i++) if (a[i] === b[i]) n++;
  return n;
}

function words(s: string): string {
  let n = 0;
  let last = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === " ") n++;
    last = c;
  }
  return `${n}:${last}`;
}

function longer(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i);
    if (c === "ab" || c < "b") n++;
  }
  return n;
}

function rebound(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "x") n++;
    if (i === 1) s = s + "xx";
  }
  return n;
}

const samples = [
  "the quick brown fox, jumps over the lazy dog!",
  "",
  " ",
  "abc123 DEF? xyz",
  "café, au lait.",
  "日本語のテキスト と 空白",
  "emoji 😀 and 🎉 here!",
  "lone \uD800 surrogate \uDFFF end",
  "aabbab ba",
];
for (const s of samples) {
  console.log(
    JSON.stringify(s),
    spacesIndex(s),
    nonSpaces(s),
    kinds(s),
    punctuation(s),
    switchIndex(s),
    pastEnd(s),
    oddIndices(s),
  );
  console.log(" ", chars(s), counts(s), words(s), longer(s), rebound(s));
}

let built = "";
for (let k = 0; k < 40; k++) built += String.fromCharCode(97 + (k % 26)) + (k % 4 === 0 ? " " : "");
console.log("built", spacesIndex(built), kinds(built), sameAt(built, built.slice(3)), counts(built));
console.log("pairs", sameAt("hello world", "help, world!"), sameAt("abc", ""), sameAt("é", "e"));

const text = "module level: scan, with commas, and spaces";
let commas = 0;
for (let i = 0; i < text.length; i++) if (text[i] === ",") commas++;
console.log("module", commas);
