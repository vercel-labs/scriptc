// Collections keyed by objects: JavaScript compares a reference key by
// identity, whatever kind of object it is. Maps, Sets and typed arrays are
// one object each for their whole life, like records, arrays and class
// instances, so a Set or a Map holds them, finds them and tells two objects
// with equal contents apart.

const words = new Set(["one", "two"]);
const other = new Set(["one", "two"]);
const counts = new Map([["a", 1]]);

const sets = new Set<Set<string>>([words, other]);
console.log(sets.size, sets.has(words), sets.has(new Set(["one", "two"])), sets.has(other));
sets.add(words);
console.log(sets.size);
words.add("three");
console.log(sets.has(words), [...sets].length);

const maps = new Set<Map<string, number>>([counts, counts, new Map([["a", 1]])]);
console.log(maps.size, maps.has(counts));
counts.set("b", 2);
console.log(maps.has(counts), maps.size);

const bytes = new Uint8Array([1, 2]);
const sameBytes = new Uint8Array([1, 2]);
const buffers = new Set<Uint8Array>([bytes, sameBytes]);
console.log(buffers.size, buffers.has(bytes), buffers.has(sameBytes), buffers.has(new Uint8Array([1, 2])));
bytes[0] = 9;
console.log(buffers.has(bytes));

const rows = [{ k: "a" }, { k: "a" }];
const rowSet = new Set(rows);
console.log(rowSet.size, rowSet.has(rows[0]!), rowSet.has({ k: "a" }));
rowSet.add(rows[1]!);
console.log(rowSet.size);

const lists: string[][] = [["x"], ["x"]];
const listSet = new Set<string[]>(lists);
console.log(listSet.size, listSet.has(lists[0]!), listSet.has(["x"]));

class Key {
  n: number;
  constructor(n: number) {
    this.n = n;
  }
}
const k1 = new Key(1);
const k2 = new Key(1);
const byKey = new Map<Key, string>([[k1, "first"], [k2, "second"], [k1, "again"]]);
console.log(byKey.size, byKey.get(k1), byKey.get(k2), byKey.get(new Key(1)));

// A Set of [key, value] pairs seeds a Map: each pair's elements are the
// entries, and reference values stay the objects the program holds.
const pairKey = new Key(7);
const pairs = new Set<[Key, Map<string, number>]>([[pairKey, counts]]);
const seeded = new Map(pairs);
console.log(seeded.size, seeded.get(pairKey) === counts);
console.log(seeded.get(pairKey)!.get("b"));

// Deleting and re-adding the same object keeps insertion order by identity.
const order = new Set<object>([rows[0]!, counts, bytes]);
order.delete(counts);
order.add(counts);
console.log([...order].length, order.has(rows[0]!), order.has(counts), order.has(bytes));
console.log(order.size, [...order.keys()].length);

// A union of reference kinds keys each element by identity as well.
const mixed: Set<Map<string, number> | string[]> = new Set();
mixed.add(counts);
mixed.add(lists[0]!);
mixed.add(counts);
console.log(mixed.size, mixed.has(counts), mixed.has(lists[1]!), mixed.has([...lists[0]!]));

// A Map keyed by collections compares them by identity too.
const byMap = new Map<Map<string, number>, string>([[counts, "counts"]]);
byMap.set(new Map([["a", 1]]), "copy");
console.log(byMap.size, byMap.get(counts), byMap.get(new Map([["a", 1]])));
const byBytes = new Map<Uint8Array, string>([[bytes, "bytes"]]);
console.log(byBytes.get(bytes), byBytes.get(new Uint8Array([1, 2])));
const bySet = new Map<Set<string>, number>([[words, 1]]);
console.log(bySet.get(words), bySet.get(new Set(["one", "two"])));

// A collection and a collection holding it are one cycle: the collector
// frees it as a unit.
const ring = new Map<string, unknown>();
const ringSet = new Set<object>([ring]);
ring.set("set", ringSet);
console.log(ringSet.has(ring), (ring.get("set") as Set<object>).has(ring));
console.log(ring.size, ringSet.size);
