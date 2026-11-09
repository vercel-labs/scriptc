// The Set methods that walk two collections, over Sets that hold a unit
// key and Sets of other element types; and a generic over the key type.
function show(v: unknown): string {
  return v === null ? "<null>" : v === undefined ? "<undefined>" : typeof v + ":" + String(v);
}
function list<T>(label: string, x: Iterable<T>): void {
  const out: string[] = [];
  for (const v of x) out.push(show(v));
  console.log(label, out.join(","));
}

const a = new Set<string | null>(["a", null, "b"]);
const b = new Set<string | null>([null, "c"]);
const plain = new Set<string>(["a", "z"]);
const three = new Set<string | null | undefined>([undefined, null, "a"]);
const keyed = new Map<string | null, number>([[null, 1], ["b", 2]]);

list("union", a.union(b));
list("intersection", a.intersection(b));
list("difference", a.difference(b));
list("symmetric", a.symmetricDifference(b));
console.log(a.isSubsetOf(b), b.isSubsetOf(a.union(b)), a.isSupersetOf(new Set<string | null>([null])), a.isDisjointFrom(b));
list("intersection map", a.intersection(keyed));
list("difference map", a.difference(keyed));
console.log(a.isDisjointFrom(keyed), new Set<string | null>([null]).isSubsetOf(keyed));
console.log(a.union(b).has(null), a.difference(b).has(null), a.intersection(b).size);

function firstKey<K>(x: Set<K>): K | undefined {
  for (const v of x) return v;
  return undefined;
}
function swap<K, V>(x: Map<K, V>): Map<V, K> {
  const out = new Map<V, K>();
  for (const [k, v] of x) out.set(v, k);
  return out;
}
class Index<K> {
  private readonly seen = new Map<K, number>();
  note(key: K): number {
    const n = (this.seen.get(key) ?? 0) + 1;
    this.seen.set(key, n);
    return n;
  }
  keys(): K[] {
    return [...this.seen.keys()];
  }
}
console.log(show(firstKey(b)), show(firstKey(a)));
const swapped = swap(new Map<number, string | null>([[1, null], [2, "s"]]));
console.log(swapped.get(null), swapped.get("s"), swapped.has(null));
list("swapped", swapped.keys());
const index = new Index<string | null>();
index.note(null);
index.note("i");
console.log(index.note(null), index.keys().map(show).join(","));

const nested = new Map<string, Set<string | null>>([["k", a]]);
console.log(nested.get("k")!.has(null), nested);
const many: Set<string | undefined>[] = [new Set<string | undefined>([undefined]), new Set<string | undefined>(["u"])];
console.log(many.map((x) => x.has(undefined)).join(","), many);
const lookalike = String.fromCharCode(0xff) + "n";
const tricky = new Set<string | null>([lookalike, "ÿu"]);
console.log(tricky.has(null), tricky.size, tricky.has(lookalike));
tricky.add(null);
console.log(tricky.has(null), tricky.size, [...tricky].map((v) => (v === null ? "<null>" : v.length)).join(","));
