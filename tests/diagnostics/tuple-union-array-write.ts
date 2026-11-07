// A union of tuples read as one array converts arm by arm, and a tuple arm
// becomes a new array (corpus 9401). A method that writes its receiver
// would change that copy where Node changes the table's own array, so it
// is refused.
const GROUPS = {
  Vegetables: ['kale'],
  Grains: ['rye', 'oat', 'rice', 'millet'],
} as const;

for (const [group, names] of Object.entries(GROUPS)) {
  if (group === 'Vegetables') (names as unknown as string[]).push('leek');
  (names as unknown as string[]).sort();
}
console.log(GROUPS.Vegetables.length);
