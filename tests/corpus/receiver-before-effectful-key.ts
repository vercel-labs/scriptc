// A receiver is evaluated once, before its key, even when the key's
// evaluation rebinds the receiver's binding or has other effects: a tuple
// read with a runtime index, a keyed read through a finite union of field
// names, and an inherited-key `in` test on a computed index-signature
// receiver.

const log: string[] = [];

// Tuple read with a runtime index that rebinds the tuple.
let pair: [string, number] = ["first", 1];
function rebindPair(i: number): number {
  log.push(`rebind pair ${i}`);
  pair = ["second", 2];
  return i;
}
const viaIndex = pair[rebindPair(0)];
console.log("tuple", viaIndex, pair[0]);

// A field holding a tuple, replaced by the index.
const holder: { t: [number, number, number] } = { t: [10, 20, 30] };
function replaceHeld(i: number): number {
  holder.t = [-1, -2, -3];
  return i;
}
console.log("tuple field", holder.t[replaceHeld(2)], holder.t[2]);

// Keyed read through a finite union of keys naming a subset of the fields,
// with a key that rebinds the local or replaces the field holding the record.
type Row = { width?: number; label: string; tags: string[] };
function finiteKeys(): void {
  let row: Row = { width: 640, label: "old", tags: [] };
  const pick = (): "width" | "label" => {
    log.push("pick key");
    row = { width: 1, label: "new", tags: ["x"] };
    return "label";
  };
  const picked = row[pick()];
  console.log("keyed", picked, row.label);
  const box: { row: Row } = { row: { label: "boxed", tags: [] } };
  const replace = (): "width" | "label" => {
    box.row = { width: 7, label: "replaced", tags: [] };
    return "width";
  };
  const width = box.row[replace()];
  console.log("keyed field", width, box.row.width);
}
finiteKeys();

// `in` on an inherited key of a computed null-prototype record: the
// receiver call runs once.
let groups = 0;
function grouped(): Partial<Record<string, number[]>> {
  groups++;
  log.push("grouped");
  return Object.groupBy([1, 2, 3], (n) => (n % 2 === 0 ? "even" : "odd"));
}
console.log("in", "toString" in grouped(), "hasOwnProperty" in grouped(), groups);

console.log(log.join(" | "));
