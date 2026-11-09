// Array.prototype.join in a program that holds lone surrogates: a lone
// high surrogate that ends one piece and a lone low one that starts the next
// (or the separator) become one character of two code units, as in a
// concatenation; pieces a separator keeps apart stay lone. Nothing here
// prints a lone surrogate: lengths and code points only.

function units(s: string): string {
  const out: string[] = [];
  for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i).toString(16));
  return s.length + "[" + out.join(" ") + "]";
}

const high = "\ud83d";
const low = "\ude00";
const pair = [high, low].join("");
console.log(units(pair), pair.codePointAt(0), pair === "😀", pair === high + low);
console.log(units([high, low].join(",")), units([low, high].join("")), units([high, high, low, low].join("")));
console.log(units([high, "", low].join("")), units(["", high, low, ""].join("")), units([high, "", "", low].join(",")));
console.log(units(["x" + high, "y"].join(low)), units(["x" + high, low + "y", "z" + high].join(low)));
console.log(units(["a", "b"].join(high)), units([low, "b", high].join("")), units([high].join(low)));

// Pieces of every kind around the seam: ASCII, other characters, the pair.
const parts: string[] = ["plain", "café" + high, low + "€", "😀", high, low, "end"];
const text = parts.join("");
console.log(units(text), text.codePointAt(9), text.codePointAt(12), text.codePointAt(14));
console.log(units(parts.join("|")), units(parts.join("·")));

// Many pieces: the fused result still has the length of its text.
const many: string[] = [];
for (let i = 0; i < 200; i++) many.push(i % 4 === 0 ? high : i % 4 === 1 ? low : i % 4 === 2 ? "k" + i : "");
const long = many.join("");
let sum = 0;
for (let i = 0; i < long.length; i++) sum = (sum * 31 + long.charCodeAt(i)) | 0;
console.log(long.length, sum, many.join(",").length);

// An ASCII join in the same program is untouched.
const ascii = ["a", "bc", "def"].join("-");
console.log(ascii, ascii.length, units(ascii));
