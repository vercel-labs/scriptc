// `items[at] ?? spare` and `items[at] || spare` where the element read is
// typed present (so the checker types the expression as the element alone)
// and the default has a wider type that only a copy could bring into the
// element's type: an array of a wider element type, a record of another
// layout, a dictionary of a wider value type. Every such read here finds
// its element, and the answer is that element itself: the same object, with
// the writes made through the result, and the default is never evaluated.
// (Where the element is absent JavaScript answers the default itself; the
// compiled program stops there by name, which tests/harness/dyncheck.test.ts
// pins.) A default that needs no such copy is used when the element is
// absent: a narrower one, a literal, one of the element's own type.
interface Nut {
  kind: "nut";
  grade: number;
}
interface Bolt {
  kind: "bolt";
  length: number;
}
interface Tagged {
  label: string;
  weight: number;
}
interface Loose {
  label: string;
  weight: number | string;
}

const counts: number[][] = [[1, 2], [3]];
const anything: (number | string)[] = ["x", 4];
const bins: Nut[][] = [[{ kind: "nut", grade: 8 }]];
const mixed: (Nut | Bolt)[] = [{ kind: "bolt", length: 30 }];
const tagged: Tagged[] = [{ label: "a", weight: 1 }];
const loose: Loose = { label: "b", weight: "heavy" };
const ledgers: Record<string, number>[] = [{ a: 1 }];
const wideLedger: Record<string, number | string> = { b: "two" };
const shelves: Record<string, Nut[]> = { s0: [{ kind: "nut", grade: 5 }] };

let asked = 0;
function spare(): (number | string)[] {
  asked++;
  return anything;
}

function pick(at: number): void {
  const values = counts[at] ?? anything;
  values.push(9);
  console.log(values === counts[at], counts[at].join(","), values.length);
  const lazy = counts[at] ?? spare();
  console.log(lazy === counts[at], lazy.length, asked);
  const parts = bins[at] ?? mixed;
  parts.push({ kind: "nut", grade: 3 });
  console.log(parts === bins[at], bins[at].length, parts[0].grade);
  const item = tagged[at] ?? loose;
  item.weight += 2;
  console.log(item === tagged[at], tagged[at].weight, item.label);
  const ledger = ledgers[at] ?? wideLedger;
  ledger["c"] = 3;
  console.log(ledger === ledgers[at], Object.keys(ledgers[at]).join(","));
  const shelf = shelves["s" + at] ?? mixed;
  console.log(shelf === shelves["s" + at], shelf.length, shelf[0].grade);
  const either = counts[at] || spare();
  console.log(either === counts[at], either.length, asked);
  const first = tagged[at] || loose;
  console.log(first === tagged[at], first.label, first.weight);
}
pick(0);
console.log(anything.join(","), mixed.length, loose.weight, Object.keys(wideLedger).join(","));

// Defaults that enter the element's type without a copy of a wider value.
const wideRows: (number | string)[][] = [["a", 1]];
const narrow: number[] = [5, 6];
const own: number[] = [7];
function other(at: number): void {
  const widened = wideRows[at] ?? narrow;
  console.log(widened.join(","), widened.length);
  const fresh = tagged[at] ?? { label: "fresh", weight: 0 };
  console.log(fresh.label, fresh.weight);
  const same = counts[at] ?? own;
  console.log(same === own, same.join(","));
  const built = counts[at] || [1, 1, 1];
  console.log(built.length);
}
other(0);
other(7);
