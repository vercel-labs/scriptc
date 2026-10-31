// The string iterator: for-of, spread, Array.from, yield* and
// [Symbol.iterator]() walk code points. Astral characters come back whole,
// a lone surrogate is a one-unit character, and halves joined by
// concatenation form one character, as in Node.
function unitCodes(c: string): string {
  const codes: string[] = [];
  for (let k = 0; k < c.length; k++) codes.push(c.charCodeAt(k).toString(16));
  return `${c.length}:${codes.join(".")}`;
}
const show = (chars: string[]): string => chars.map(unitCodes).join(" ");

const samples = [
  "",
  "abc",
  "aé😀b",
  "\u0000\u007f\u0080߿ࠀ￿",
  "\u{10000}\u{10ffff}",
  "é ñ",
  "\ud800",
  "\udc00",
  "x\ud83d",
  "\ude00x",
  "\udc00\ud800",
  "\ud83d" + "\ude00",
  "a\ud83d" + "\ude00b\ud83d",
  "日本語テキスト",
];
for (const s of samples) {
  const looped: string[] = [];
  for (const c of s) looped.push(c);
  console.log(JSON.stringify(s), show(looped), show([...s]), show(Array.from(s)), [...s].length, s.length);
}

// Loop control, heads and bindings.
const text = "a😀b\ud800c";
let out = "";
outer: for (const c of text) {
  if (c === "b") continue;
  for (const d of "xy") {
    if (d === "y" && c === "c") continue outer;
    out += c + d;
  }
  if (c === "\ud800") out += "|";
}
console.log(out);
for (var v of "hé") out += v;
console.log(out);
let last = "";
for (last of "q😀") out += last.length;
console.log(out, last);
for (const [first] of ["😀z", "ab"].join("")) out += first;
console.log(out);
let source = "abc";
for (const c of source) {
  source += c;
  out += source.length;
}
console.log(out, source);
let n = 0;
for (const c of "stop😀here") {
  if (c === "😀") break;
  n += c.length;
}
console.log(n);

// Characters as values: lengths, Map keys and code points.
const counts = new Map<string, number>();
for (const c of "abracadabra😀😀é") counts.set(c, (counts.get(c) ?? 0) + 1);
console.log([...counts].map(([k, v]) => `${k}=${v}`).join(","));
let points = 0;
for (const c of "😀é\ud800a") points += c.codePointAt(0)!;
console.log(points);

// Generators and explicit iterators.
function* letters(s: string): Generator<string, void, undefined> {
  yield* s;
}
console.log(show([...letters("x😀\udc00y")]));
const it = "o😀"[Symbol.iterator]();
let step = it.next();
while (!step.done) {
  out += step.value.length;
  step = it.next();
}
console.log(out);

// A long string built from mixed pieces.
let long = "";
for (let i = 0; i < 2000; i++) long += i % 3 === 0 ? "a" : i % 3 === 1 ? "é" : "😀";
let units = 0;
let chars = 0;
for (const c of long) {
  units += c.length;
  chars++;
}
console.log(units, chars, long.length, [...long].length);
