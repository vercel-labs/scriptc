// Helpers called from several sites with different callbacks keep Node's
// behavior: results, callback order, closures, identity and a mix of known
// and unknown callbacks per helper.
function mapInPlace(values: number[], f: (x: number) => number): number[] {
  for (let i = 0; i < values.length; i++) values[i] = f(values[i]!);
  return values;
}

function countIf(values: number[], pred: (x: number) => boolean): number {
  let n = 0;
  for (const v of values) if (pred(v)) n++;
  return n;
}

function forEachPair(values: string[], f: (a: string, b: string) => void): void {
  for (let i = 0; i < values.length; i++)
    for (let j = i + 1; j < values.length; j++) f(values[i]!, values[j]!);
}

function sortBy<T>(items: T[], key: (item: T) => number): T[] {
  for (let i = 1; i < items.length; i++) {
    const cur = items[i]!;
    const k = key(cur);
    let j = i - 1;
    while (j >= 0 && key(items[j]!) > k) {
      items[j + 1] = items[j]!;
      j--;
    }
    items[j + 1] = cur;
  }
  return items;
}

function triple(x: number): number {
  return x * 3;
}
const negate = (x: number): number => -x;

interface Point {
  x: number;
  y: number;
  label: string;
}

function main(): void {
  console.log(mapInPlace([1, 2, 3, 4], (x) => x + 1).join(","));
  console.log(mapInPlace([1, 2, 3, 4], (x) => x * x).join(","));
  console.log(mapInPlace([1, 2, 3, 4], triple).join(","));
  console.log(mapInPlace([1, 2, 3, 4], negate).join(","));
  const half = (x: number): number => x / 2;
  console.log(mapInPlace([1, 2, 3, 4], half).join(","));
  let offset = 10;
  const shift = (x: number): number => x + offset;
  console.log(mapInPlace([1, 2], shift).join(","));
  offset = 20;
  console.log(mapInPlace([1, 2], shift).join(","));

  const values = [5, 12, 7, 30, 1, 18];
  console.log(countIf(values, (x) => x > 6), countIf(values, (x) => (x & 1) === 1));
  let calls = 0;
  console.log(
    countIf(values, (x) => {
      calls++;
      return x % 3 === 0;
    }),
    calls,
  );

  const seen: string[] = [];
  forEachPair(["a", "b", "c"], (a, b) => seen.push(a + b));
  forEachPair(["x", "y", "z"], (a, b) => seen.push(b + a));
  console.log(seen.join(" "));

  const points: Point[] = [
    { x: 3, y: 1, label: "p" },
    { x: 1, y: 4, label: "q" },
    { x: 2, y: 2, label: "r" },
    { x: 5, y: 0, label: "s" },
  ];
  console.log(
    sortBy(points.slice(), (p) => p.x)
      .map((p) => p.label)
      .join(""),
  );
  console.log(
    sortBy(points.slice(), (p) => p.y)
      .map((p) => p.label)
      .join(""),
  );
  console.log(sortBy(["ccc", "a", "bb"], (s) => s.length).join(","));
  console.log(sortBy([3, 1, 2], (n) => -n).join(","));

  // The order of key calls, observed through a side effect.
  const order: number[] = [];
  sortBy([3, 1, 2], (n) => {
    order.push(n);
    return n;
  });
  console.log(order.join(","));

  // A callback chosen at run time stays a callback value.
  const pick = values.length > 3 ? (x: number) => x - 1 : (x: number) => x + 1;
  console.log(mapInPlace([10, 20], pick).join(","));
  let chosen: (x: number) => number = triple;
  if (values[0] === 5) chosen = negate;
  console.log(mapInPlace([10, 20], chosen).join(","));

  // The helper as a value next to direct calls.
  const helper = mapInPlace;
  console.log(helper([1, 2], (x) => x * 100).join(","), helper === mapInPlace);

  // Function identity inside the helper: a declared function is one value.
  console.log(countIf([1, 2, 3], (x) => x > 1), countIf([1], triple === triple ? (x) => x > 0 : (x) => x < 0));

  // More distinct callbacks than the helper gets copies.
  const results: number[] = [];
  for (const f of [
    (x: number) => x + 1,
    (x: number) => x + 2,
  ])
    results.push(mapInPlace([1], f)[0]!);
  results.push(mapInPlace([1], (x) => x + 3)[0]!);
  results.push(mapInPlace([1], (x) => x + 4)[0]!);
  results.push(mapInPlace([1], (x) => x + 5)[0]!);
  results.push(mapInPlace([1], (x) => x + 6)[0]!);
  results.push(mapInPlace([1], (x) => x + 7)[0]!);
  results.push(mapInPlace([1], (x) => x + 8)[0]!);
  results.push(mapInPlace([1], (x) => x + 9)[0]!);
  results.push(mapInPlace([1], (x) => x + 10)[0]!);
  results.push(mapInPlace([1], (x) => x + 11)[0]!);
  results.push(mapInPlace([1], (x) => x + 12)[0]!);
  console.log(results.join(","));
}

main();
