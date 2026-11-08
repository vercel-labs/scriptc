// `items[at] ?? spare` where the element read is typed present (so the
// checker types the expression as the element alone), the read can be absent
// at run time, and the default is of another type that only a copy of the
// element could reach: an array of a wider element type, a record of another
// layout, a dictionary of a wider value type, with `??` and with `||`.
// JavaScript answers the element itself; a copy would lose its identity and
// the writes made through the result. The forms that keep the value compile
// (corpus nullish-absent-read-default-type; `crates[at] ?? labelled` below).
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
class Crate {
  label: string;
  slots = 4;
  constructor(label: string) {
    this.label = label;
  }
}
interface Labelled {
  label: string;
}

const bins: Nut[][] = [[{ kind: "nut", grade: 8 }]];
const mixed: (Nut | Bolt)[] = [{ kind: "bolt", length: 30 }];
const counts: number[][] = [[1, 2]];
const anything: (number | string)[] = ["x"];
const tagged: Tagged[] = [{ label: "a", weight: 1 }];
const loose: Loose = { label: "b", weight: "heavy" };
const ledgers: Record<string, number>[] = [{ a: 1 }];
const wideLedger: Record<string, number | string> = { b: "two" };
const crates: Crate[] = [new Crate("c")];
const labelled: Labelled = { label: "d" };
const shelves: Record<string, Nut[]> = { top: [{ kind: "nut", grade: 5 }] };

function pick(at: number): void {
  const parts = bins[at] ?? mixed;
  const values = counts[at] ?? anything;
  const item = tagged[at] ?? loose;
  const ledger = ledgers[at] ?? wideLedger;
  const named = crates[at] ?? labelled;
  const shelf = shelves["s" + at] ?? mixed;
  const either = bins[at] || mixed;
  console.log(parts.length, values.length, item.label, Object.keys(ledger).length, named.label);
  console.log(shelf.length, either.length);
}
pick(0);
pick(4);
