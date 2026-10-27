// A number-keyed Map read followed by a write of the same key: the write
// goes through the entry the read found when the map and the key's bits
// are the same, and through an ordinary set otherwise (a miss, -0 against
// 0, another map). Values, sizes and insertion order match Node for
// directly indexed keys, hashed keys, fractional keys, NaN and signed
// zeros.

function show(map: Map<number, number>): string {
  const parts: string[] = [];
  map.forEach((value, key) => {
    parts.push(`${Object.is(key, -0) ? "-0" : String(key)}=${value}`);
  });
  return `${map.size} [${parts.join(" ")}]`;
}

// The counting update over small integer keys (direct index) and wide keys
// (hashed).
const keys = [3, 1, 3, 2, 1, 3, 1e12, 2 ** 40 + 1, 1e12, 0.5, 0.5, -7, 2 ** 40 + 1];
const counts = new Map<number, number>();
for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
console.log(show(counts));

// The read as a declaration, then the write.
const sums = new Map<number, number>();
for (let i = 0; i < 40; i++) {
  const key = (i * 7) % 11;
  const current = sums.get(key);
  sums.set(key, current === undefined ? i : current + i);
}
console.log(show(sums));

// Signed zeros: -0 and 0 are one key, which the map stores as 0.
const zeros = new Map<number, number>();
const zeroKeys = [-0, 0, -0, 0, 0];
for (const key of zeroKeys) zeros.set(key, (zeros.get(key) ?? 0) + 1);
console.log(show(zeros), Object.is([...zeros.keys()][0], -0));
const plusFirst = new Map<number, number>();
for (const key of [0, -0, -0]) plusFirst.set(key, (plusFirst.get(key) ?? 0) + 1);
console.log(show(plusFirst));

// NaN is one key whatever its producer.
const nans = new Map<number, number>();
const nanKeys = [NaN, 0 / 0, Math.sqrt(-1), Number("x")];
for (const key of nanKeys) nans.set(key, (nans.get(key) ?? 0) + 1);
console.log(show(nans));

// A read of one map and a write of another take the ordinary set.
const source = new Map<number, number>([
  [1, 10],
  [2, 20],
]);
const target = new Map<number, number>([[2, 5]]);
for (const key of [1, 2, 3]) target.set(key, (source.get(key) ?? 0) + 1);
console.log(show(source), show(target));

// Overwrites keep the insertion order; deleted keys come back at the end.
const order = new Map<number, number>();
for (const key of [5, 4, 3, 2, 1]) order.set(key, (order.get(key) ?? 0) + 1);
order.delete(3);
for (const key of [1, 3, 5]) order.set(key, (order.get(key) ?? 0) + 10);
console.log(show(order));

// Boolean values.
const seen = new Map<number, boolean>();
for (const key of [1, 2, 1, 1e9, 1e9]) seen.set(key, !(seen.get(key) ?? false));
const flags: string[] = [];
seen.forEach((value, key) => flags.push(`${key}:${value}`));
console.log(flags.join(" "));

// A large table, where the hashed probe and growth run.
const big = new Map<number, number>();
for (let i = 0; i < 50000; i++) {
  const key = (i * 2654435761) % 100003;
  big.set(key, (big.get(key) ?? 0) + 1);
}
let total = 0;
let most = 0;
big.forEach((value) => {
  total += value;
  if (value > most) most = value;
});
console.log(big.size, total, most);
