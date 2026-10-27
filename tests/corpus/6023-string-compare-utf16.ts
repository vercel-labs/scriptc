// Relational string comparisons order strings by UTF-16 code units, as in
// Node: characters above U+FFFF (surrogate pairs) sort before U+E000..U+FFFF,
// lone surrogates sort by their own code unit, and ASCII and other BMP text
// keep their ordinary order. Typed comparisons, sort comparators and
// comparisons of untyped values agree.
const astral = "😀"; // U+1F600: D83D DE00
const privateUse = "\ue000";
const last = "\uffff";
const highSurrogate = "\ud83d";
const lowSurrogate = "\ude00";
const hex = (s: string): string => {
  const units: string[] = [];
  for (let i = 0; i < s.length; i++) units.push(s.charCodeAt(i).toString(16));
  return units.join(" ");
};

const pairs: [string, string][] = [
  [astral, last],
  [astral, privateUse],
  ["\ud7ff", astral],
  [highSurrogate, astral],
  [lowSurrogate, astral],
  [lowSurrogate, last],
  ["é", "e"],
  ["abc😀", "abc\uffff"],
  ["same", "same"],
  ["prefix", "prefix😀"],
];
for (const [a, b] of pairs)
  console.log(hex(a), "|", hex(b), a < b, a <= b, a > b, a >= b);

const words = ["\uffff", "😀", "é", "e", "\ue000", "z", "\ud83d", "A"];
const byOperator = [...words].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
const byDefault = [...words].sort();
console.log(byOperator.map(hex).join(", "));
console.log(byDefault.map(hex).join(", "));
console.log(byOperator.join("") === byDefault.join(""));

const untyped: unknown[] = JSON.parse('["\\uffff", "\\ud83d\\ude00", "a"]');
const [u0, u1] = untyped as string[];
console.log(u1! < u0!, [...untyped].sort().map((v) => hex(String(v))).join(", "));

let smallest = words[0]!;
for (const word of words) if (word < smallest) smallest = word;
console.log(hex(smallest), words.filter((w) => w > "\ud7ff").length);

// Every pair of these characters after shared prefixes of 0 to 24 bytes,
// ASCII and multibyte, with and without a suffix: the first differing byte
// falls in the first word, the tail word, the first byte or past 16 bytes.
const chars = ["a", "z", "é", "한", "中", "\ud7ff", "\ue000", "\uffff"];
chars.push(astral, highSurrogate, lowSurrogate, "\u{10ffff}");
const hashOf = (text: string): number => {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (Math.imul(h, 31) + text.charCodeAt(i)) | 0;
  return h >>> 0;
};
for (const unit of ["p", "é", "中"]) {
  const rows: string[] = [];
  for (let n = 0; n <= 24; n += 3) {
    const prefix = unit.repeat(n);
    let marks = "";
    for (const x of chars)
      for (const y of chars)
        for (const suffix of ["", "q", "tail-of-text"]) {
          const a = prefix + x + suffix;
          const b = prefix + y;
          marks += a < b ? "<" : a > b ? ">" : "=";
        }
    rows.push(`${n}:${marks.split("<").length - 1}:${hashOf(marks)}`);
  }
  console.log(hex(unit), rows.join(" "));
}
