// An array method's callback annotates its parameter with a type that has
// no static lowering, and the array can hold holes. The analysis that
// widens callback parameters for missing elements runs before any body
// lowers; it leaves such a parameter alone, and the statement that holds
// the callback lowers it as a checked-dynamic slot. The same callbacks over
// an array without holes always compiled this way.
type Probe = (() => number) | (AbortSignal & { tag?: string }) | Map<string, (x: number) => string>;

const sizes: number[] = [1, 2, 3];
sizes.length = 5;

// The find family visits holes as undefined.
console.log(sizes.find((e: number | Probe) => e === 2));
console.log(sizes.findIndex((e: number | Probe) => e === undefined));
console.log(sizes.findLastIndex((e: number | Probe) => e === 3));

// The other methods skip them.
let visited = 0;
sizes.forEach((e: number | Probe) => {
  if (e !== undefined) visited++;
});
console.log(visited);
console.log(sizes.filter((e: number | Probe) => typeof e === "number").length);
console.log(
  sizes.some((e: number | Probe) => e === undefined),
  sizes.every((e: number | Probe) => typeof e === "number"),
);
console.log(
  sizes.reduce((sum: number, e: number | Probe) => sum + (typeof e === "number" ? e : 0), 0),
);

// A reduce whose accumulator and result have no static lowering either.
const last = sizes.reduce(
  (seen: number | Probe | undefined, e: number) => (e > 1 ? e : seen),
  undefined as number | Probe | undefined,
);
console.log(last);

// A parameter type no dynamic slot family names: still the callback's own slot.
const weak: number[] = [4, 5];
weak.length = 3;
console.log(weak.find((e: number | WeakRef<object>) => e === 5));
