// A spread call through a union of function types, one of them variadic:
// the tuple's positions reach the variadic function as its arguments.
type Handler = ((e: string, n: number) => void) | ((...args: unknown[]) => void);

const h: Handler = (...args: unknown[]) => {
  console.log("n", args.length, args.map(String).join(","));
};
const pair: [string, number] = ["a", 2];
h(...pair);

const fixed: Handler = (e: string, n: number) => {
  console.log("fixed", e, n);
};
const spread: [string, number] = ["b", 3];
fixed(...spread);
