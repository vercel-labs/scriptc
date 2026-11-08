// The rest of a text cut off again and again, as a tokenizer does:
// `rest = rest.slice(cut)`. A slice that runs to the end of a non-ASCII
// string takes its end from the string's length. Texts of every character
// width, short and long, cuts that land between the halves of a surrogate
// pair, and the same cut through slice, substring and substr.
export {};

function checksum(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i += text.length > 4000 ? 97 : 1) h = (Math.imul(h, 31) + text.charCodeAt(i)) | 0;
  return h;
}

const face = "\u{1F600}";
const units: [string, string][] = [
  ["ascii", "A line of plain text with nothing else in it.\n"],
  ["dash", "A line of text — with a dash and café in it.\n"],
  ["astral", `A line ${face} with ${face}${face} faces in it.\n`],
  ["dense", `é—${face}日本語${face}ü`],
];

for (const [name, unit] of units) {
  for (const size of [50, 300, 5000, 70000, 200000]) {
    const text = unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
    // Cut the front off until nothing is left; the cut sizes cycle, so some
    // land between the two units of a pair.
    let rest = text;
    let cuts = 0;
    let sum = 0;
    let at = 0;
    const sizes = [1, 7, 30, 2, 61, 3, 250, 5];
    while (rest.length > 0) {
      const cut = size >= 70000 ? sizes[cuts % sizes.length]! * 40 : sizes[cuts % sizes.length]!;
      const next = rest.slice(cut);
      at += Math.min(cut, rest.length);
      if (next.length !== text.length - at) console.log("length is wrong at", at);
      if (cuts % 16 === 0) {
        sum = (sum + checksum(next) + next.charCodeAt(0) + next.charCodeAt(next.length - 1)) | 0;
        if (next !== text.slice(at)) console.log("text is wrong at", at);
      }
      rest = next;
      cuts++;
    }
    console.log(name, size, "cuts", cuts, "sum", sum);
    // The same rest four ways, and a rest of a rest.
    for (const from of [0, 1, 2, 3, 17, size - 3, size - 1, size, size + 5]) {
      const a = text.slice(from);
      const b = text.substring(from);
      const c = text.substr(from);
      const d = text.slice(from, text.length);
      const e = text.slice(from, Infinity);
      const f = text.slice(from - text.length - 1 < -text.length ? 0 : from);
      const same = a === b && a === c && a === d && a === e;
      console.log(name, size, from, same, a.length, checksum(a), a.slice(1).length, checksum(a.slice(2)), f.length);
    }
    console.log(name, size, "negative", text.slice(-3).length, checksum(text.slice(-7)), checksum(text.slice(-size)), text.slice(-1).charCodeAt(0));
  }
}
