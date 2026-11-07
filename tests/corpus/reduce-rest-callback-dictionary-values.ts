// reduce and reduceRight over the values of a dictionary, with a callback
// that takes a rest parameter: the callback sees the four arguments
// JavaScript passes (accumulator, value, index, array), whatever it names.
const d: Record<string, object> = { a: { n: 3 }, b: { n: 1 } };
console.log(Object.values(d).reduce((...args: unknown[]) => (args[0] as number) + args.length, 0));
console.log(Object.values(d).reduceRight((sum: number, ...more: unknown[]) => sum + more.length, 0));
console.log(
  Object.values(d).reduce((...args: unknown[]) => {
    console.log(args.length, typeof args[0], JSON.stringify(args[1]), args[2], Array.isArray(args[3]));
    return (args[0] as number) + 1;
  }, 10),
);
console.log(
  Object.values(d).reduceRight((sum: number, ...more: unknown[]) => {
    console.log(more.length, JSON.stringify(more[0]), more[1], Array.isArray(more[2]));
    return sum + 1;
  }, 20),
);
