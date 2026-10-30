// Number-keyed Map and Set operations whose keys the compiler knows are
// integers (loop counters, `| 0` results, typed-array bytes, integer
// arithmetic) test the map's direct index on the integer. Results must
// match Node while the index covers the keys, after a key outside it moves
// the map to hashing, for negative keys and for keys past the index, and
// when a double key and an integer key name the same entry.

const counts = new Map<number, number>();
for (let i = 0; i < 200; i++) {
  const key = (i * 7) % 13;
  counts.set(key, (counts.get(key) ?? 0) + 1);
}
const dense: string[] = [];
for (let k = -2; k < 16; k++) dense.push(`${k}:${counts.has(k) ? counts.get(k) : "-"}`);
console.log(dense.join(" "));

// A key past the direct index moves the map to hashing; integer reads still
// find every key.
counts.set(1_000_000, 5);
let found = 0;
for (let k = -2; k < 16; k++) if (counts.has(k)) found += counts.get(k)!;
console.log(found, counts.get(1_000_000), counts.has(999_999), counts.size);

// Negative keys, and keys built with `| 0` and shifts.
const signed = new Map<number, string>();
for (let i = -5; i <= 5; i++) signed.set((i * 3) | 0, `v${i}`);
const reads: string[] = [];
for (let i = -16; i <= 16; i += 4) reads.push(`${i}:${signed.get(i) ?? "-"}`);
console.log(reads.join(" "), signed.get(-0), signed.get(0));

// Bytes of a typed array as keys, in a Set.
const bytes = new Uint8Array([3, 250, 3, 0, 17, 250, 255, 0]);
const seen = new Set<number>();
let repeats = 0;
for (let i = 0; i < bytes.length; i++) {
  if (seen.has(bytes[i]!)) repeats++;
  seen.add(bytes[i]!);
}
console.log([...seen].join(","), repeats);

// A double key and an integer key name the same entry.
const mixed = new Map<number, number>();
mixed.set(2.0, 1);
mixed.set(0.5, 2);
for (let i = 0; i < 4; i++) mixed.set(i, (mixed.get(i) ?? 0) + 10);
console.log([...mixed.entries()].map(([k, v]) => `${k}=${v}`).join(" "), mixed.get(0.5));

// Deletion through integer keys, then reinsertion order.
const order = new Map<number, number>();
for (let i = 0; i < 10; i++) order.set(i, i * i);
for (let i = 0; i < 10; i += 3) order.delete(i);
for (let i = 9; i >= 0; i -= 2) order.set(i, -i);
console.log([...order.entries()].map(([k, v]) => `${k}=${v}`).join(" "));

// Large integer keys near 2^53, from integer arithmetic.
const wide = new Map<number, number>();
let key = 2 ** 52;
for (let i = 0; i < 5; i++) {
  wide.set(key, i);
  key = key * 2 - 1;
}
console.log([...wide.keys()].join(" "), wide.get(2 ** 52), wide.get(2 ** 53 - 1));

// A lookup whose key is an assignment of a wide integer constant, in a
// branch, then a lookup of the same constant after the branch.
const far = new Map<number, number>();
far.set(1099511627776, 7);
function probeFar(taken: boolean): number {
  let k = 0;
  let hits = 0;
  if (taken) {
    if (far.has((k = 1099511627776))) hits += 1;
  }
  hits += far.get(1099511627776) ?? -1;
  return hits + k;
}
console.log(probeFar(true), probeFar(false));
