// padStart and padEnd on the results of case conversion and slicing, with
// ASCII and non-ASCII receivers and fills, and index reads of the results.

const words = ["alpha", "beta", "gamma", "Delta", "épée", "straße", "日本語", "a😀b"];
const fills = ["-", "ab", "é", "😀", "", " "];

function describe(s: string): string {
  return [
    JSON.stringify(s),
    s.length,
    s.charAt(1),
    s.at(-1),
    s.indexOf("A"),
    s.slice(1, 4),
    s.charCodeAt(s.length - 1),
    s.codePointAt(0),
  ].join(" ");
}

for (const word of words) {
  const upper = word.slice(0, 3).toUpperCase();
  const lower = word.toLowerCase();
  for (const fill of fills) {
    console.log(describe(upper.padStart(6, fill)));
    console.log(describe(lower.padEnd(9, fill)));
  }
  console.log(describe(upper.padStart(2)), describe(upper.padEnd(5)));
}

// The same string padded again, compared and used as a key.
const counts = new Map<string, number>();
for (let i = 0; i < 40; i++) {
  const key = words[i % words.length]!.slice(0, 3).toUpperCase().padStart(4, "-");
  counts.set(key, (counts.get(key) ?? 0) + 1);
}
console.log([...counts].map(([k, v]) => `${k}=${v}`).join(","));
const padded = "abc".toUpperCase().padStart(5, "😀");
console.log(padded.length, [...padded].length, padded === "\ud83dABC".padStart(5, "😀"));
console.log("x".toUpperCase().padEnd(4, "é").normalize("NFD").length);
