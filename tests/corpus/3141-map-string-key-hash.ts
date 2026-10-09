// String Map/Set keys under every key representation: literals (hash baked
// in at compile time), one-character and empty strings (immortal runtime
// statics), heap strings that cache their hash, a probe string appended in
// place after its hash was cached, and split pieces whose scratch buffer is
// reused for the next piece. Equal bytes must always find the same entry.
const lit = new Map<string, number>();
for (const key of ["", "a", "ab", "abc", "alpha", "hello world!", "a much longer key of 31 bytes!!", "été", "😀"]) {
  lit.set(key, key.length);
}
const pieces = ["al", "pha"];
const computed = [
  pieces.join(""),
  "hello" + " " + "world!",
  "xab".slice(1),
  "xyzabc".substring(3),
  String.fromCharCode(97),
  "zaz".charAt(1),
  `${"a much longer key"} of ${31} bytes!!`,
  ["é", "t", "é"].join(""),
  "x😀".slice(1),
  "abc".slice(3),
];
for (const key of computed) console.log(JSON.stringify(key), lit.get(key), lit.has(key));

// Heap keys stored first, probed later with literals and statics.
const heap = new Map<string, number>();
const letters = "qwerty";
for (let i = 0; i < letters.length; i++) heap.set(letters.charAt(i) + "", i);
heap.set(["k", "e", "y"].join(""), 100);
console.log(heap.get("q"), heap.get("y"), heap.get("key"), heap.get("ke"), heap.size);
for (const ch of letters.split("")) console.log(ch, heap.get(ch));

// A uniquely owned probe grows in place after each lookup cached its hash.
const grown = new Map<string, number>();
for (const word of ["ab", "abc", "abcd", "abcde", "abcdef", "abcdefg", "abcdefghijk"]) grown.set(word, word.length);
let probe = String.fromCharCode(97);
probe += "b";
for (let i = 0; i < 10; i++) {
  console.log(probe, grown.get(probe), grown.has(probe));
  probe += String.fromCharCode(99 + i);
}

// Loop-consumed split pieces longer than four bytes reuse one scratch string
// when nothing else keeps them; overwriting an existing key keeps the stored
// key object, so the probe stays uniquely owned.
const counts = new Map<string, number>();
for (const name of ["alpha", "gamma", "delta", "omega"]) counts.set(name, 0);
const line = "alpha,gamma,alpha,delta,gamma,omega,alpha,sigma";
for (const part of line.split(",")) {
  const current = counts.get(part);
  if (current !== undefined) counts.set(part, current + 1);
  else console.log("unknown", part);
}
console.log([...counts.entries()].map(([k, v]) => k + "=" + v).join(" "));

// Union-keyed maps hash string members exactly like string-keyed maps.
const mixed = new Map<string | number, string>();
mixed.set("1", "string one");
mixed.set(1, "number one");
mixed.set("gamma", "g");
console.log(mixed.get(["1"].join("")), mixed.get(1), mixed.get("gam" + "ma"), mixed.size);

// Set dedupe, delete, and re-add through different key objects keep
// insertion order.
const seen = new Set<string>();
const words: string[] = [];
for (let i = 0; i < 40; i++) words.push(["ka", "lo", "mi"][i % 3]! + ["", "ne", "ru"][i % 5 % 3]!);
for (const w of words) seen.add(w);
console.log(seen.size, [...seen].join(","));
console.log(seen.delete("ka" + "ne"), seen.has("kane"), seen.delete("kane"));
seen.add(["ka", "ne"].join(""));
console.log([...seen].join(","));

// Many keys force bucket storage and growth; every key is found again by a
// freshly built probe and by its stored object.
const big = new Map<string, number>();
const stored: string[] = [];
for (let i = 0; i < 2000; i++) {
  const key = "k" + i.toString(36);
  stored.push(key);
  big.set(key, i);
}
let found = 0;
for (let i = 0; i < 2000; i++) {
  if (big.get("k" + i.toString(36)) === i && big.get(stored[i]!) === i) found++;
}
for (let i = 0; i < 2000; i += 2) big.delete(stored[i]!);
let remaining = 0;
for (let i = 0; i < 2000; i++) if (big.has("k" + i.toString(36))) remaining++;
console.log(found, remaining, big.size, big.get("k1"), big.get("k0"));
