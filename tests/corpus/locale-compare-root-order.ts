// String.prototype.localeCompare with no locales or options follows the
// root-locale collation: letters compare before case and accents, so
// sorting with it interleaves upper and lower case and places accented
// letters next to their base letter.
const pairs: [string, string][] = [
  ["a", "B"],
  ["B", "a"],
  ["a", "A"],
  ["A", "a"],
  ["ä", "z"],
  ["résumé", "resume"],
  ["resume", "Resume"],
  ["coop", "co-op"],
  ["co-op", "coop"],
  ["file10", "file9"],
  ["Zebra", "apple"],
  ["ß", "ss"],
  ["æ", "ae"],
  ["Œuvre", "oeuvre"],
  ["naïve", "naive"],
  ["Ångström", "Angstrom"],
  ["", "a"],
  ["a", ""],
  ["same", "same"],
  ["ø", "o"],
  ["ł", "m"],
  ["_x", "x"],
  [" x", "x"],
  ["1", "a"],
  ["Z", "é"],
];
for (const [a, b] of pairs) console.log(JSON.stringify(a), JSON.stringify(b), a.localeCompare(b));

const words = ["banana", "Apple", "cherry", "apple", "Éclair", "eclair", "Banana", "zoo", "Zoo", "état", "etat", "über", "uber", "Uber", "ñandu", "nandu"];
console.log([...words].sort((x, y) => x.localeCompare(y)).join(","));
console.log([...words].sort((x, y) => y.localeCompare(x)).join(","));

interface Item {
  name: string;
  qty: number;
}
const items: Item[] = [
  { name: "widget", qty: 3 },
  { name: "Gadget", qty: 1 },
  { name: "gizmo", qty: 7 },
  { name: "Ärmel", qty: 2 },
  { name: "arm", qty: 5 },
];
items.sort((p, q) => p.name.localeCompare(q.name));
for (const item of items) console.log(item.name, item.qty);
