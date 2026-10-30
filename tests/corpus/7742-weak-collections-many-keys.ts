// Weak collections with many keys: entries found among tens of thousands
// in WeakMaps and WeakSets that share keys, deleted and replaced, and gone
// with their keys, so blocks a new key reuses are not found under it.
// Keys in reference cycles die by the cycle collector.
class Key {
  readonly id: number;
  peer: Key | null = null;
  constructor(id: number) {
    this.id = id;
  }
}

const n = 40000;
let keys: Key[] = [];
for (let i = 0; i < n; i++) keys.push(new Key(i));
const values = new WeakMap<Key, number>();
const labels = new WeakMap<Key, string>();
const marked = new WeakSet<Key>();
for (const k of keys) {
  values.set(k, k.id * 2);
  if (k.id % 3 === 0) labels.set(k, "k" + k.id);
  if (k.id % 2 === 0) marked.add(k);
}
let sum = 0;
let labelled = 0;
let counted = 0;
for (const k of keys) {
  sum += values.get(k) ?? 0;
  if (labels.has(k)) labelled++;
  if (marked.has(k)) counted++;
}
console.log("filled", sum, labelled, counted);

// Deleting every fourth key from one collection leaves the others alone.
let deleted = 0;
for (const k of keys) if (k.id % 4 === 0 && values.delete(k)) deleted++;
let remaining = 0;
for (const k of keys) if (values.has(k)) remaining++;
console.log("deleted", deleted, remaining, values.delete(keys[0]!), marked.has(keys[0]!), labels.get(keys[3]!));

// Overwriting keeps one entry per key.
for (const k of keys) if (k.id % 5 === 0) values.set(k, -1);
let negative = 0;
for (const k of keys) if (values.get(k) === -1) negative++;
console.log("overwritten", negative);

// Dropping the keys ends their entries; new keys are not found.
keys = [];
const fresh: Key[] = [];
for (let i = 0; i < n; i++) fresh.push(new Key(n + i));
let stale = 0;
for (const k of fresh) if (values.has(k) || labels.has(k) || marked.has(k)) stale++;
console.log("fresh", fresh.length, stale);

// Keys that reach each other die together through the cycle collector.
for (let round = 0; round < 3; round++) {
  let ring: Key[] = [];
  for (let i = 0; i < 1000; i++) ring.push(new Key(i));
  for (let i = 0; i < ring.length; i++) ring[i]!.peer = ring[(i + 1) % ring.length]!;
  for (const k of ring) {
    values.set(k, round);
    marked.add(k);
  }
  ring = [];
}
const after: Key[] = [];
for (let i = 0; i < 3000; i++) after.push(new Key(i));
let found = 0;
for (const k of after) if (values.has(k) || marked.has(k)) found++;
console.log("cycles", found);
