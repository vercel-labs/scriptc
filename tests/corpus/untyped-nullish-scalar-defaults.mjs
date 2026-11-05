// `??` in untyped JavaScript where the left is an optional number, boolean or
// string and the default has the same type: Map reads, find(), a function that
// may return undefined, and defaults of another type, null or an object.
const words = ["alpha", "beta", "gamma", "beta", "delta", "beta", "alpha"];
const counts = new Map();
for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
for (const [word, n] of counts) console.log(word, n);

const odd = new Map();
odd.set("nan", NaN);
odd.set("zero", -0);
odd.set("one", 1);
for (const key of ["nan", "zero", "one", "missing"]) {
  const value = odd.get(key) ?? 7;
  console.log(key, value, Object.is(value, -0), Number.isNaN(value), typeof value);
}

const flags = new Map();
flags.set("on", true);
flags.set("off", false);
for (const key of ["on", "off", "missing"]) console.log(key, flags.get(key) ?? true);

const names = new Map();
names.set("a", "");
names.set("b", "bee");
for (const key of ["a", "b", "c"]) console.log(JSON.stringify(names.get(key) ?? "none"));

const values = [3, 8, 13, 21];
console.log(values.find((v) => v > 10) ?? -1, values.find((v) => v > 100) ?? -1);

function lookup(table, key) {
  return key in table ? table[key] : undefined;
}
const table = { x: 1.5, y: 0 };
console.log(lookup(table, "x") ?? 0, lookup(table, "y") ?? 9, lookup(table, "z") ?? 9);

// Defaults of another type keep the left's value or take the default as is.
console.log(counts.get("beta") ?? "none", counts.get("omega") ?? "none");
console.log(counts.get("omega") ?? null, counts.get("beta") ?? null);
const fallback = { n: 0 };
console.log(counts.get("omega") ?? fallback, counts.get("alpha") ?? fallback);

// The result is an ordinary value in later arithmetic and comparisons.
let total = 0;
for (const word of ["alpha", "beta", "omega"]) total += (counts.get(word) ?? 0) * 10;
console.log(total, (counts.get("omega") ?? 0) === 0, (odd.get("nan") ?? 0) === (odd.get("nan") ?? 0));

// A default of the same type that can itself be undefined keeps its value.
const spare = [4, 5];
console.log(counts.get("omega") ?? spare[9], counts.get("beta") ?? spare[9], counts.get("omega") ?? spare[1]);
