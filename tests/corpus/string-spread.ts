// Spreading strings into arrays: code points of each UTF-8 length, astral
// pairs, lone surrogates, the empty string, and the fresh array each spread
// returns.

const samples = ["", "a", "abc", "é", "café", "日本語", "😀", "a😀b", "🚀🚀", "\ud800", "a\udc00b", "xé日😀"];

for (const s of samples) {
  const chars = [...s];
  console.log(JSON.stringify(s), chars.length, JSON.stringify(chars), chars.join("|"));
}

// Each spread is a new array: changing one leaves the others and the string.
const text = "héllo 😀";
const first = [...text];
const second = [...text];
first.reverse();
first.push("!");
console.log(first.join(""), second.join(""), first === second, text);

// The spread result is an ordinary array.
const letters = [..."naïve"];
letters.sort();
console.log(letters, letters.length, Array.isArray(letters));
console.log([..."abc"].map((c) => c.toUpperCase()).join(""));
console.log([..."日本"].concat([..."語"]).join("-"));
