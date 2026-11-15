// A helper's loop calls its callback with a fixed argument list, so a
// callback that takes its arguments through a rest parameter is refused by
// name where no checked-dynamic view of the array can run the method
// instead: over a typed array, and over a list of checked-dynamic values
// for a flatMap whose callback declares an array result. The view runs the
// other methods, the reductions included (corpus 9434).
const xs: number[] = [3, 1, 2];
console.log(xs.map((...args: unknown[]) => args.length).join(","));
console.log(xs.filter((...args: unknown[]) => args.length === 3).length);
xs.forEach((...args: unknown[]) => console.log(args.length));
console.log(xs.some((...args: unknown[]) => args.length === 3));
console.log(xs.reduce((sum: number, ...more: unknown[]) => sum + more.length, 0));
console.log(xs.sort((...args: number[]) => args[0]! - args[1]!).join(","));

const d: Record<string, object> = { a: { n: 3 }, b: { n: 1 } };
console.log(Object.values(d).flatMap((...args: unknown[]): number[] => [args.length]).join(","));
