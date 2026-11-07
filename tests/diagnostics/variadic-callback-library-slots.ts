// A function that takes a rest parameter or reads `arguments` observes every
// argument its caller passes. A library function whose own loop calls its
// callback with the parameters the callback names would hand such a
// function none of them, so each of these calls is refused by name.
const xs: number[] = [3, 1, 2];
const m = new Map<string, number>([["a", 1]]);
const s = new Set<number>([1]);
const ta = new Float64Array([1, 2]);
m.forEach((...args: unknown[]) => console.log(args.length));
s.forEach((...args: unknown[]) => console.log(args.length));
ta.forEach((...args: unknown[]) => console.log(args.length));
console.log(ta.map((...args: unknown[]) => args.length).length);
console.log(Array.from(xs.values().map((...args: unknown[]) => args.length)).length);
xs.values().forEach((...args: unknown[]) => console.log(args.length));
console.log(xs.toSorted((...args: unknown[]) => args.length).length);
console.log("a1".replace("1", (...args: unknown[]) => String(args.length)));
new URLSearchParams("a=1").forEach((...args: unknown[]) => console.log(args.length));
console.log(Map.groupBy(xs, (...args: unknown[]) => String(args.length)).size);
Promise.resolve(1).then((...args: unknown[]) => console.log(args.length));
process.stdout.write("x", (...args: unknown[]) => console.log(args.length));
process.on("exit", (...args: unknown[]) => console.log(args.length));

// `arguments.length` in a function expression folds to the count its slot's
// function type names. Handed where no function type is expected, its
// callers pass what they like, so the read is refused by name.
function loose(f: any): unknown {
  return f(1, 2);
}
console.log(
  loose(function () {
    return arguments.length;
  }),
);
const held: unknown = function () {
  return arguments.length;
};
console.log(typeof held);
console.log(
  Reflect.apply(
    function () {
      return arguments.length;
    },
    undefined,
    [1, "two"],
  ),
);
