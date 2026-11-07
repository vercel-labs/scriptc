// @requires-libnode
// A Node island's function is one function, however many types the program
// holds it through: every read of the export, every typed view of it and the
// value the island gets back are the same function to `===`, to searches and
// to collection keys.
import * as ordkit from "ordkit";
import { applyTo, compare, double, isDouble, isEven, pickDouble, registry } from "ordkit";

type Unary = (n: number) => number;

// The same export, read twice.
const a = double;
const b = double;
console.log(a === b, double === double, a === double, (a as unknown) === compare);
console.log(ordkit.double === double, registry.double === double, pickDouble() === double);

// Typed views: an annotated variable, array elements, record fields,
// parameters.
const view: Unary = double;
const other: Unary = double;
console.log(view === other, view === double, view === a);
const list: Unary[] = [double, double, (n) => n];
console.log(list[0] === list[1], list[0] === list[2], list.indexOf(double), list.includes(double));
console.log(list.lastIndexOf(double), list.indexOf(view), list.findIndex((f) => f === double));
function same(f: Unary, g: Unary): boolean {
  return f === g;
}
console.log(same(double, double), same(double, view), same(double, (n) => n));
interface Ops {
  twice: Unary;
}
const one: Ops = { twice: double };
const two: Ops = { twice: double };
console.log(one.twice === two.twice, one.twice === double, one.twice === view);

// Views at different signatures are still the one function.
const loose: (n: number, extra?: string) => number = double;
const wide: (n: number) => unknown = double;
console.log(loose === view, wide === view, loose === wide);

// A view assigned on to a slot of another signature is a second adapter over
// the first. It is still the function: boxed, compared with the export, and
// handed back to the island.
const rewide: (n: number) => unknown = view;
const again: unknown = rewide;
console.log(again === double, isDouble(rewide), rewide === view, wide === double);
const boxedWide: unknown = wide;
const boxedLoose: unknown = loose;
console.log(boxedWide === double, isDouble(wide), boxedLoose === double, isDouble(loose));
console.log(isDouble(boxedLoose), typeof boxedWide, typeof rewide);

// Held as unknown, and narrowed back.
const hidden: unknown = double;
console.log(hidden === double, hidden === view, hidden === compare, typeof hidden);

// Collection keys and values.
const set = new Set<Unary>([double, double, view]);
console.log(set.size, set.has(double), set.has(view), set.has((n) => n));
const labels = new Map<(n: number) => unknown, string>([
  [double, "double"],
  [isEven, "isEven"],
]);
console.log(labels.get(double), labels.get(isEven), labels.has(double), labels.size);
const byName = new Map<string, Unary>([["d", double]]);
console.log(byName.get("d") === double, byName.get("d")!(7));

// Handed back to the island: it is the island's own function there.
console.log(isDouble(double), isDouble(view), isDouble(one.twice), isDouble(compare));
console.log(applyTo(double, 4), applyTo(view, 5), applyTo((n) => n + 1, 4));
