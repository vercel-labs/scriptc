// @dynamic
// Explicit any[] stays a static array of engine handles. Array.toSorted must
// still sink engine undefined values without invoking compareFn for them.

const source: any[] = [undefined, 2, 1, undefined];
let calls = 0;
const sorted = source.toSorted((a: any, b: any) => {
  calls++;
  if (a === undefined || b === undefined) {
    throw new Error("undefined reached compareFn");
  }
  return a - b;
});

console.log(
  sorted.length,
  `${sorted[0]}`,
  `${sorted[1]}`,
  `${sorted[2]}`,
  `${sorted[3]}`,
  calls,
);
console.log(
  source.length,
  `${source[0]}`,
  `${source[1]}`,
  `${source[2]}`,
  `${source[3]}`,
);
