// "x".repeat with a negative or infinite count throws a catchable
// RangeError, and typed-array reads at an index that is not an integer in
// [0, length) answer undefined (writes there are ignored), like Node.
function attempt(label: string, f: () => unknown): void {
  try {
    console.log(label, "ok", f());
  } catch (e) {
    if (e instanceof RangeError) console.log(label, "RangeError", e.name, e instanceof Error);
    else console.log(label, "other");
  }
}

const neg: number = process.argv.length > 99 ? 1 : -1;
attempt("repeat-negative", () => "ab".repeat(neg));
attempt("repeat-infinite", () => "ab".repeat(neg / 0 < 0 ? Infinity : 1));
attempt("repeat-ok", () => "ab".repeat(3));

try {
  "x".repeat(neg);
  console.log("not reached");
} catch (e) {
  console.log("message:", (e as Error).message);
}

const bytes = new Uint8Array(4);
bytes[1] = 9;
const far: number = process.argv.length + 10;
const negative: number = -process.argv.length;
const fraction: number = process.argv.length + 0.5;
console.log("in range", bytes[1], bytes[3]);
console.log("out of range", bytes[far], bytes[negative], bytes[fraction], bytes[4]);
console.log("is undefined", bytes[far] === undefined, bytes[1] === undefined);
console.log("arithmetic", bytes[far] + 1, bytes[1] + 1, Number.isNaN(bytes[far] * 2));
console.log("defaulted", bytes[far] ?? -1, bytes[1] ?? -1);
if (bytes[far]) console.log("not reached");
else console.log("falsy");
const missing = bytes[far];
console.log("binding", missing, `${missing}`, [missing], JSON.stringify({ value: bytes[far] }));
bytes[far] = 7;
bytes[negative] = 7;
bytes[fraction] = 7;
console.log("ignored writes", bytes.join(","), bytes.length);

const floats = new Float64Array([1.5, -2]);
let sum = 0;
for (let i = 0; i <= floats.length; i++) sum += floats[i] !== undefined ? floats[i]! : 100;
console.log("floats", sum, floats[2], floats[-0]);
const words = new Int32Array(2);
words[0] = -5;
const picked: number[] = [];
for (let i = -1; i < 3; i++) picked.push(words[i] ?? 0);
console.log("words", picked.join(","), words.length);
console.log("after", bytes.length);
