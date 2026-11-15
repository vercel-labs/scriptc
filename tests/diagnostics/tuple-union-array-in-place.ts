// A union of tuples read as one array is read in place (corpus 9403). A
// tuple runs `.map()`, `.filter()`, the searches, `.join()`, `.slice()`,
// `.reduce()` and, as a statement, `.forEach()` in place (corpus 9431); it
// has no `.at()` or `.concat()` that does, and a copy of the tuple would
// not show what the call's own code writes, so those are refused. A
// `.forEach()` used as a value has nothing to choose by arm.
const LINES = {
  hill: ['mast'],
  loop: ['gate', 'park', 'mill', 'quay'],
} as const;

let total = 0;
for (const [line, stops] of Object.entries(LINES)) {
  total += line.length;
  total += String(
    (stops as readonly string[]).forEach((stop) => {
      total += stop.length;
    }),
  ).length;
  total += String((stops as readonly string[]).at(-1)).length;
  total += (stops as readonly string[]).concat(['yard']).length;
}
console.log(total);
