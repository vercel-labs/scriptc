// A union of tuples read as one array is read arm by arm, in place (corpus
// 9401). A method that writes its receiver has no single array to write
// where Node changes the table's own array, so it is refused.
const LINES = {
  hill: ['mast'],
  loop: ['gate', 'park', 'mill', 'quay'],
} as const;

for (const [line, stops] of Object.entries(LINES)) {
  if (line === 'hill') (stops as unknown as string[]).push('summit');
  (stops as unknown as string[]).sort();
}
console.log(LINES.hill.length);
