// WeakMap and WeakSet holding thousands of keys: each collection's index
// and the thread-wide index of all weak entries grow and rehash, entries
// are overwritten, deleted and added again, keys are shared by several
// collections, a collection is dropped while its keys live, keys are
// dropped while collections live, and fresh keys (which may reuse a freed
// key's memory) are never mistaken for the dropped ones.
type Key = { id: number };

function makeKeys(from: number, count: number): Key[] {
  const keys: Key[] = [];
  for (let i = 0; i < count; i++) keys.push({ id: from + i });
  return keys;
}

const ids = new WeakMap<Key, number>();
const names = new WeakMap<Key, string>();
const members = new WeakSet<Key>();
let keys = makeKeys(0, 6000);
for (const key of keys) {
  ids.set(key, key.id);
  if (key.id % 3 === 0) names.set(key, `k${key.id}`);
  members.add(key);
}
for (const key of keys) if (key.id % 5 === 0) ids.set(key, -key.id);

let sum = 0;
let named = 0;
let present = 0;
for (const key of keys) {
  sum += ids.get(key)!;
  if (names.has(key)) named++;
  if (members.has(key)) present++;
}
console.log(sum, named, present, names.get(keys[3]!), names.get(keys[4]!));

let deleted = 0;
for (let i = 0; i < keys.length; i += 2) {
  if (ids.delete(keys[i]!)) deleted++;
  members.delete(keys[i]!);
}
console.log(deleted, ids.delete(keys[0]!), ids.has(keys[0]!), ids.get(keys[0]!), ids.has(keys[1]!));

for (let i = 0; i < keys.length; i += 4) ids.set(keys[i]!, 1);
let held = 0;
let inSet = 0;
for (const key of keys) {
  if (ids.has(key)) held++;
  if (members.has(key)) inSet++;
}
console.log(held, inSet);

// A collection dropped while its keys live leaves no entry behind.
function scratchCount(list: Key[]): number {
  const scratch = new WeakMap<Key, number>();
  for (const key of list) scratch.set(key, key.id);
  let found = 0;
  for (const key of list) if (scratch.has(key)) found++;
  return found;
}
console.log(scratchCount(keys), scratchCount(keys.slice(0, 10)));

// Dropping keys removes their entries from every collection.
const survivors = keys.slice(0, 100);
keys = [];
const fresh = makeKeys(10000, 6000);
let stale = 0;
for (const key of fresh) if (ids.has(key) || names.has(key) || members.has(key)) stale++;
let kept = 0;
for (const key of survivors) if (ids.has(key) || members.has(key)) kept++;
console.log(stale, kept, names.get(survivors[99]!));

// Collections still work after their keys are gone.
for (const key of fresh) ids.set(key, key.id);
let total = 0;
for (const key of fresh) total += ids.get(key)!;
console.log(total, ids.has(survivors[1]!), ids.get(survivors[0]!));
