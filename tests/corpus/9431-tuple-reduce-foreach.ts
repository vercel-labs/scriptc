// reduce, reduceRight and forEach on a fixed tuple. The callback runs once
// per position, in the method's direction, with the value the position
// holds when it is visited: a write to a position not yet visited is seen,
// as it is on an array. Without an initial value the first position visited
// seeds the accumulator and the callback is not called for it.
const sides: [string, string, string] = ["left", "top", "right"];
const fixed: readonly [number, number, number] = [4, 5, 6];
const lone: readonly [string] = ["north"];
const pair = ["am", "pm"] as const;
const mixed: [string, number, boolean] = ["depth", 3, true];

// With an initial value: every accumulator kind.
console.log(
  fixed.reduce((a, b) => a + b, 0),
  sides.reduce((acc, s) => acc + s.length, 0),
  pair.reduce((acc, s) => acc + s, ">"),
  lone.reduce((acc, s) => {
    acc.push(s.length);
    return acc;
  }, [] as number[]).join(","),
);
const index = sides.reduce<Record<string, number>>((acc, s, i) => {
  acc[s] = i;
  return acc;
}, {});
console.log(JSON.stringify(index));
const totals = fixed.reduce((acc, n) => ({ sum: acc.sum + n, count: acc.count + 1 }), {
  sum: 0,
  count: 0,
});
console.log(totals.sum, totals.count);
const widths = sides.reduce((acc, s) => acc.set(s, s.length), new Map<string, number>());
console.log(widths.size, widths.get("top"));
console.log(mixed.reduce((acc, v) => acc + typeof v + String(v), ""));

// Without one: the first position is the seed.
function longer(a: string, b: string): string {
  return b.length > a.length ? b : a;
}
console.log(
  fixed.reduce((a, b) => a * b),
  sides.reduce((a, b) => a + "+" + b),
  lone.reduce((a, b) => a + b),
  fixed.reduceRight((a, b) => a - b),
  sides.reduce(longer),
  sides.reduceRight(longer),
);

// The callback's index, and the order of calls.
const calls: string[] = [];
const total = sides.reduce((acc, s, i) => {
  calls.push(`${i}:${s}`);
  return acc + s.length;
}, 100);
sides.reduceRight((acc, s, i) => {
  calls.push(`${i}:${s}`);
  return acc;
}, 0);
console.log(total, calls.join(","));

// forEach: values and indexes in order; the result is discarded.
sides.forEach((s, i) => console.log(i, s));
fixed.forEach((n) => console.log(n * 2));
mixed.forEach((v, i) => console.log(i, typeof v));
const seen: string[] = [];
pair.forEach((s) => seen.push(s));
console.log(seen.join(","));

// A position is read when it is visited.
const cells: [number, number, number] = [1, 2, 3];
const sum = cells.reduce((acc, n, i) => {
  if (i === 0) cells[2] = 30;
  return acc + n;
}, 0);
console.log(sum, cells.join(","));
const visited: number[] = [];
cells.forEach((n, i) => {
  if (i === 0) cells[1] = 20;
  visited.push(n);
});
console.log(visited.join(","));
console.log(
  cells.reduceRight((acc, n, i) => {
    if (i === 2) cells[0] = 10;
    return acc + ":" + n;
  }, ""),
);

// A row of an `as const` table whose rows differ in length is a union of
// tuples: read as one array, reduce and (as a statement) forEach run on the
// tuple the value holds.
const SHELVES = {
  attic: ["lamp"],
  cellar: ["jar", "keg", "vat"],
} as const;
let letters = 0;
for (const [room, items] of Object.entries(SHELVES)) {
  (items as readonly string[]).forEach((item, i) => {
    letters += item.length + i;
  });
  console.log(
    room,
    (items as readonly string[]).reduce((sum, item) => sum + item.length, 0),
    (items as readonly string[]).reduce((a, b) => a + "/" + b),
    (items as readonly string[]).reduceRight((acc, item, i) => acc + i + item[0], ""),
  );
}
console.log(letters);
