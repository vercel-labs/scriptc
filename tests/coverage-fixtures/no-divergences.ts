// Ordinary code: identity-preserving calls, declaration-ordered literals,
// Latin-script comparisons, related-class casts, ISO dates, views of the
// global object and a dictionary held as `{}` report no divergence.
interface Item {
  name: string;
  qty: number;
}
function restock(item: Item): void {
  item.qty += 1;
}
const items: Item[] = [
  { name: "bolt", qty: 1 },
  { name: "nut", qty: 2 },
];
for (const item of items) restock(item);
console.log(JSON.stringify(items));

function describe(item: { name: string }): string {
  return item.name.toUpperCase();
}
console.log(describe(items[0]!));

class Animal {
  legs = 4;
}
class Bird extends Animal {
  wings = 2;
}
function wingsOf(a: Animal): number {
  return a instanceof Bird ? (a as Bird).wings : 0;
}
console.log(wingsOf(new Bird()), wingsOf(new Animal()));
console.log(["b", "A", "a"].sort((p, q) => p.localeCompare(q)).join(","));
console.log(Date.parse("2024-01-02"), new Date("2024-01-02T03:04:05+01:00").getTime());

// A type assertion of the global object denotes the global object itself.
const COUNT = Symbol.for("no-divergences.count");
const globalState = globalThis as { [COUNT]?: { n: number } };
globalState[COUNT] = { n: 1 };
console.log(globalState[COUNT]?.n);

// A dictionary held as `{}` comes back out as itself.
const counts: Record<string, string> = { a: "x" };
const opaque: {} = counts;
const again: Record<string, string> = opaque;
again[counts["a"] ?? "a"] = "y";
console.log(JSON.stringify(counts));

// A record stored in a dictionary binding and written through it stays
// the same object.
const named: { first: string } = { first: "a" };
const byName: Record<string, string> = named;
byName[named.first] = "b";
console.log(JSON.stringify(named));
