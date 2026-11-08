// A union of tuples read as one array is read in place (corpus 9403). A
// tuple runs `.map()`, `.filter()`, the searches, `.join()` and `.slice()`
// in place; it has no `.forEach()`, `.reduce()`, `.at()` or `.concat()`
// that does, and a copy of the tuple would not show what the callback
// writes while the call runs, so those are refused.
const LINES = {
  hill: ['mast'],
  loop: ['gate', 'park', 'mill', 'quay'],
} as const;

let total = 0;
for (const [line, stops] of Object.entries(LINES)) {
  total += line.length;
  (stops as readonly string[]).forEach((stop) => {
    total += stop.length;
  });
  total += (stops as readonly string[]).reduce((sum, stop) => sum + stop.length, 0);
  total += String((stops as readonly string[]).at(-1)).length;
  total += (stops as readonly string[]).concat(['yard']).length;
}
console.log(total);
