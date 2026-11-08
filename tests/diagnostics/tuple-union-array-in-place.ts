// A union of tuples read as one array is read in place (corpus 9403). A
// tuple runs `.map()`, `.filter()`, the searches, `.join()` and `.slice()`
// in place; it has no `.forEach()`, `.reduce()`, `.at()` or `.concat()`
// that does, and a copy of the tuple would not show what the callback
// writes while the call runs, so those are refused.
const GROUPS = {
  Vegetables: ['kale'],
  Grains: ['rye', 'oat', 'rice', 'millet'],
} as const;

let total = 0;
for (const [, names] of Object.entries(GROUPS)) {
  (names as readonly string[]).forEach((name) => {
    total += name.length;
  });
  total += (names as readonly string[]).reduce((sum, name) => sum + name.length, 0);
  total += String((names as readonly string[]).at(-1)).length;
  total += (names as readonly string[]).concat(['z']).length;
}
console.log(total);
