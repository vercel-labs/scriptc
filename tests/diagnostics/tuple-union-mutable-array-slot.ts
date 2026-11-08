// A union of tuples handed to a slot of a mutable array type would be
// copied there, and a write through the slot or to the tuple afterwards
// would be lost for the other, where Node has one array. The flow is
// refused; a readonly array slot, and reading the value in place (corpus
// 9401, 9403), are not.
const GROUPS = {
  Vegetables: ['kale'],
  Grains: ['rye', 'oat', 'rice', 'millet'],
} as const;

function total(list: string[]): number {
  return list.length;
}

let count = 0;
for (const [, names] of Object.entries(GROUPS)) {
  const alias = names as unknown as string[];
  alias[0] = 'changed';
  const declared: string[] = names as unknown as string[];
  count += total(names as unknown as string[]) + declared.length;
  const kept: readonly string[] = names;
  count += kept.length;
}
console.log(count, GROUPS.Vegetables[0]);
