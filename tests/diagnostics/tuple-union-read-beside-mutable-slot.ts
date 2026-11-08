// A union of tuples is read in place (corpus 9401, 9403). A program that
// also hands the same binding to a slot of a mutable array type would get
// a copy of the tuple in that slot, and a write through the copy would
// not show in the read, without an error. Such a read is refused, naming
// the slot; a readonly array slot beside the read is not concerned.
const GROUPS = {
  Vegetables: ['kale'],
  Grains: ['rye', 'oat', 'rice', 'millet'],
} as const;

function longest(list: string[]): number {
  return Math.max(...list.map((item) => item.length));
}

let count = 0;
for (const [, names] of Object.entries(GROUPS)) {
  const alias = names as unknown as string[];
  alias[0] = 'changed';
  if ((names as readonly string[]).includes('changed')) count++;
}
for (const [, rows] of Object.entries(GROUPS)) {
  count += longest(rows as unknown as string[]);
  for (const row of rows as readonly string[]) count += row.length;
}
for (const [, kept] of Object.entries(GROUPS)) {
  const view: readonly string[] = kept;
  count += view.length + (kept as readonly string[]).indexOf('kale');
}
console.log(count);
