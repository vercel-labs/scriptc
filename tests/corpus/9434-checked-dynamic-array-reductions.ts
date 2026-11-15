// reduce, reduceRight, flat, findLast and findLastIndex on an array that
// is a checked-dynamic value (parsed JSON, an `any[]`): the
// method runs on the value the binding holds, and a typed use of the result
// is checked like any other read of such a value.
const loose: any = JSON.parse('[3,[4,5],"six",[["seven"]]]');
const held: any[] = JSON.parse("[1,2,3,4]");
const parsed: unknown = JSON.parse('["x","yy","zzz"]');

console.log(
  held.reduce((acc: number, n: number) => acc + n, 0),
  held.reduce((acc: string, n: number) => acc + n, ">"),
  held.reduce((a: number, b: number) => a * b),
  held.reduceRight((a: number, b: number) => a - b),
);
console.log(loose.reduce((acc: number, v: unknown) => acc + (typeof v === "number" ? v : 0), 0));
const squares = held.reduce(
  (acc: Record<string, number>, n: number) => {
    acc["k" + n] = n * n;
    return acc;
  },
  {} as Record<string, number>,
);
console.log(JSON.stringify(squares));
const sum: number = held.reduce((acc: number, n: number) => acc + n, 100);
console.log(sum + 1);

if (Array.isArray(parsed)) {
  console.log(
    parsed.reduce((acc: number, s: string) => acc + s.length, 0),
    parsed.reduce((a: string, b: string) => a + b),
  );
  const lengths = parsed.reduce<number[]>((acc, s: string) => {
    acc.push(s.length);
    return acc;
  }, []);
  console.log(lengths.join(","));
  console.log(parsed.flat().length, JSON.stringify(parsed.flat()));
}

console.log(JSON.stringify(loose.flat()), JSON.stringify(loose.flat(2)), loose.flat().length);
console.log(JSON.stringify(held.flat()), JSON.stringify(held.flatMap((n: number) => [n, n * 10])));
console.log(
  held.findLast((n: number) => n % 2 === 1),
  held.findLastIndex((n: number) => n > 9),
  held.findLastIndex((n: number) => n < 3),
);

// An empty array without an initial value is Node's TypeError.
const none: any[] = JSON.parse("[]");
try {
  none.reduce((a: number, b: number) => a + b);
} catch (e) {
  console.log(e instanceof TypeError, (e as Error).message);
}
// A value that is not an array has no such method.
const notArray: any = JSON.parse('{"n":1}');
try {
  notArray.reduce((a: number, b: number) => a + b, 0);
} catch (e) {
  console.log(e instanceof TypeError, (e as Error).message);
}

// A callback that takes its arguments through a rest parameter receives
// what the method passes: the view of the list runs the method itself.
const bins: Record<string, object> = { north: { rows: 3 }, south: { rows: 1 } };
console.log(Object.values(bins).findLastIndex((...args: unknown[]) => args.length === 3));
console.log(Object.values(bins).reduce((...args: unknown[]) => (args[0] as number) + args.length, 0));
console.log(
  Object.values(bins).reduceRight((sum: number, ...more: unknown[]) => sum + more.length, 0),
);
