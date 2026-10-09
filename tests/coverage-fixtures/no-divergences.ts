// Ordinary code: identity-preserving calls, declaration-ordered literals,
// Latin-script comparisons, related-class casts and ISO dates report no
// divergence.
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
