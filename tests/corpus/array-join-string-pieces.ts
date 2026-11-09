// Array.prototype.join over arrays of strings. The runtime sizes the result
// in one pass and copies the pieces in a second one, with copies of fixed
// size for short pieces and loops of their own for the empty and the
// one-byte separator: so the pieces here have every length on both sides of
// those bounds, each length takes a turn as the first and as the last piece,
// and the separators are empty, one byte, and shorter and longer than the
// bounds. Every join is compared with the same text built by concatenation.
// The other element kinds (holes, null, undefined, numbers, booleans, untyped
// values whose toString runs the program's code) keep their own path and are
// pinned beside it.

function digest(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return s.length + ":" + h;
}

function piece(i: number, len: number): string {
  let s = "";
  for (let k = 0; k < len; k++) s += String.fromCharCode(97 + ((i * 7 + k) % 26));
  return s;
}

const lens = [0, 1, 2, 3, 7, 8, 9, 15, 16, 17, 31, 32, 33, 64, 200];
function lenAt(i: number): number {
  return lens[i % lens.length] ?? 0;
}

const seps = [
  "",
  ",",
  "--",
  "0123456789abcdef",
  "0123456789abcdefg",
  " -- a separator of 33 bytes -- .. ",
  "·",
  "€é",
];

for (const sep of seps) {
  let equal = 0;
  let all = "";
  for (let first = 0; first < lens.length; first++) {
    const parts: string[] = [];
    let expect = "";
    for (let j = 0; j < lens.length; j++) {
      const text = piece(j, lenAt(first + j));
      parts.push(text);
      expect += (j > 0 ? sep : "") + text;
    }
    const joined = parts.join(sep);
    if (joined === expect && joined.length === expect.length) equal++;
    all += digest(joined) + ";";
  }
  console.log("separator of " + sep.length + ": " + equal + " of " + lens.length + " equal, " + digest(all));
}

// Sizes: none, one, two, and enough for the result to be a large block.
for (const n of [0, 1, 2, 3, 10, 100, 2000, 100000]) {
  const parts: string[] = [];
  for (let i = 0; i < n; i++) parts.push(("q" + (1234567 + i * 7919)).slice(0, 1 + (i % 8)));
  console.log(n, digest(parts.join("")), digest(parts.join(",")), digest(parts.join(" | ")));
}

// Small joins in full.
const none: string[] = [];
console.log("[" + none.join("") + "]", "[" + none.join(",") + "]", "[" + none.join("long separator") + "]");
console.log("[" + [""].join(",") + "]", "[" + ["", ""].join(",") + "]", "[" + ["", "", ""].join("") + "]");
console.log(["a"].join("a long separator that is never used"), ["a", "", "b"].join(""), ["", "a", ""].join("+"));
console.log(["one", "two", "three"].join(), ["one", "two", "three"].join(", "), ["x", "y"].join("xy"));

// The same string many times, and literals beside built strings.
const same = "xy" + String(none.length);
const repeated: string[] = [];
for (let i = 0; i < 50; i++) repeated.push(i % 3 === 0 ? "lit" : same);
console.log(repeated.join(""), digest(repeated.join("/")));

// Pieces and separators that are not ASCII: the result's length and its
// characters are those of the text, not of its bytes.
const wide = ["café", "naïve", "€", "plain", "😀", ""];
const w1 = wide.join("");
console.log(w1, w1.length, w1.charCodeAt(3), w1.charCodeAt(w1.length - 1), w1.indexOf("plain"));
const w2 = wide.join("·");
console.log(w2, w2.length, w2.charCodeAt(4), w2.lastIndexOf("·"));
const oneWide = ["a", "b", "é", "c"].join(",");
console.log(oneWide, oneWide.length, oneWide.charCodeAt(4), oneWide.charCodeAt(6));
const wideSeparator = ["a", "b"].join("é");
const unusedSeparator = ["a"].join("é");
console.log(wideSeparator, wideSeparator.length, unusedSeparator, unusedSeparator.length);
const allWide: string[] = [];
for (let i = 0; i < 40; i++) allWide.push("é" + (i % 10) + (i % 3 === 0 ? "€" : ""));
console.log(allWide.join("").length, digest(allWide.join("")), digest(allWide.join(",")), digest(allWide.join("·")));

// A joined string is an ordinary string afterwards: a key, an operand, a
// piece of the next join.
const key = ["ab", "cd", "ef"].join("");
const table = new Map<string, number>();
table.set("abcdef", 7);
table.set(key + "!", 8);
console.log(table.get(key), table.has(["abc", "def"].join("")), table.get(["abcdef", ""].join("!")), key === "abcdef");
console.log(key.length, key + key, key.slice(1, 4), key.toUpperCase(), key.indexOf("de"), key.charAt(5));
const members = new Set<string>([["a", "b"].join("")]);
console.log(members.has("ab"), members.has(["a", "b"].join(",")));
let nested = "";
for (let round = 0; round < 6; round++) nested = [nested, "r" + round].join("/");
console.log(nested, [nested, nested].join("").length);
const big: string[] = [];
for (let i = 0; i < 300; i++) big.push(piece(i, 5));
let rounds = "";
for (let round = 0; round < 4; round++) {
  const text = big.join(round % 2 === 0 ? "" : ",");
  rounds += digest(text) + " ";
}
console.log(rounds);

// Elements that are not strings keep their own conversions.
const nullable: Array<string | null> = ["a", null, "b", null];
const optional: Array<string | undefined> = [undefined, "a", undefined];
console.log("[" + nullable.join("") + "]", "[" + nullable.join(",") + "]", "[" + optional.join("") + "]", "[" + optional.join("-") + "]");
const holes = new Array<string>(5);
holes[1] = "x";
holes[4] = "y";
console.log("[" + holes.join("") + "]", "[" + holes.join(",") + "]", "[" + holes.join("<>") + "]");
const far: string[] = ["a"];
far[6] = "g";
console.log("[" + far.join("") + "]", "[" + far.join(",") + "]");
console.log([1, 2.5, -0, NaN, Infinity, 1e21].join(""), [1, 2].join(", "), [true, false].join(""), [true].join("-"));
const mixed: unknown[] = ["s", 1, null, undefined, true, [1, "x", null, [2, 3]], { toString: () => "obj" }, {}, 2.5];
console.log(mixed.join(""), mixed.join(","), mixed.join(" and "));

// A string array held under its type and behind `unknown`.
const typed: string[] = ["x", "yy", "zzz"];
const hidden: unknown = typed;
console.log(Array.isArray(hidden) ? hidden.join("") : "not an array", (hidden as string[]).join("+"));

// An element's toString runs in index order and may change the array: the
// length was read once, and an index that is gone joins as empty.
const order: string[] = [];
const live: unknown[] = [];
live.push({
  toString: () => {
    order.push("first");
    return "A";
  },
});
live.push({
  toString: () => {
    order.push("second");
    live.pop();
    return "B";
  },
});
live.push({
  toString: () => {
    order.push("third");
    return "C";
  },
});
live.push("tail");
console.log(live.join("-"), order.join(","), live.length);
const growing: unknown[] = [];
growing.push({
  toString: () => {
    order.push("grow");
    growing.push("late");
    return "G";
  },
});
growing.push("end");
console.log(growing.join("+"), growing.length, growing.join("+"), growing.length);
const thrower: unknown[] = [
  "a",
  {
    toString: () => {
      throw new Error("stop");
    },
  },
  {
    toString: () => {
      order.push("never");
      return "x";
    },
  },
];
try {
  console.log(thrower.join(","));
} catch (e) {
  console.log("caught", e instanceof Error ? e.message : "?", order.join(","));
}
