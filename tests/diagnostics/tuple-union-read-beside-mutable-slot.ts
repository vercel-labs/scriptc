// A union of tuples is read in place (corpus 9401, 9403). A program that
// also hands the same binding to a slot of a mutable array type would get
// a copy of the tuple in that slot, and a write through the copy would
// not show in the read, without an error. Such a read is refused, naming
// the slot; a readonly array slot beside the read is not concerned.
const LINES = {
  hill: ['mast'],
  loop: ['gate', 'park', 'mill', 'quay'],
} as const;

function longest(list: string[]): number {
  return Math.max(...list.map((item) => item.length));
}

let count = 0;
for (const [line, stops] of Object.entries(LINES)) {
  const alias = stops as unknown as string[];
  alias[0] = line;
  if ((stops as readonly string[]).indexOf(line) === 0) count++;
}
for (const [line, rows] of Object.entries(LINES)) {
  count += longest(rows as unknown as string[]) + line.length;
  for (const row of rows as readonly string[]) count += row.length;
}
for (const [line, kept] of Object.entries(LINES)) {
  const view: readonly string[] = kept;
  count += view.length + (kept as readonly string[]).lastIndexOf(line);
}
console.log(count);
