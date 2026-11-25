// @requires-libnode
// A function a Node island package exports is a value like any other: it is
// passed as a comparator or a callback, stored in a variable or a field, and
// handed to a program function. The program's slot holds a typed view of the
// island's one function object; each call is the island call a direct call
// makes, with every argument the caller supplies.
import * as ordkit from "ordkit";
import {
  add,
  arity,
  byWeight,
  compare,
  double,
  identity,
  isEven,
  note,
  notes,
  rcompare,
  shout,
  versionCompare,
  versionRcompare,
  withIndex,
} from "ordkit";
import kit from "ordkit/lib/core.js";
import reversePlugin from "ordkit/lib/plugins/reverse.js";
import shoutPlugin from "ordkit/lib/plugins/shout.js";
import { compare as barrelCompare, twice } from "./barrel.ts";

const names = ["pear", "apple", "fig"];
const versions = ["1.2.3", "2.0.0", "1.10.0"];

// Comparators: sort in place, toSorted, a spread copy, a ternary beside a
// direct call (the shape of a version picker).
console.log([...names].sort(compare).join(","), [...names].sort(rcompare).join(","));
console.log(names.toSorted(rcompare).join(","), names.join(","));
const wanted = process.argv.length > 99;
const latest = wanted ? versions[0] : [...versions].sort(versionRcompare)[0];
console.log(latest, [...versions].sort(versionCompare).join(","));
console.log([...names].sort(ordkit.compare).join(","), [...names].sort(barrelCompare).join(","));
const items = [{ weight: 3 }, { weight: 1 }, { weight: 2 }];
console.log(
  items
    .sort(byWeight)
    .map((item) => item.weight)
    .join(","),
);

// Array callbacks: each receives (value, index, array), as in JavaScript.
console.log([1, 2, 3].map(double).join(","), names.map(shout).join(","), [1].map(twice).join(","));
console.log([1, 2, 3, 4].filter(isEven).join(","), [1, 2, 3].find(isEven), [1, 3].some(isEven));
console.log([2, 4].every(isEven), [1, 2, 3].findIndex(isEven), [1, 2, 3].reduce(add), [1, 2].reduce(add, 10));
console.log([7, 8].map(arity).join(","), names.map(withIndex).join(","));
console.log([1, 2].map(identity).join(","), ["a"].map(identity).join(","));
console.log(Array.from([1, 2, 3], double).join(","));
names.forEach(note);
console.log(notes());

// A variable, a reassigned variable, a record field, a shorthand property, a
// dictionary, an array of functions.
const first = compare;
let order = compare;
console.log(first("a", "b"), [...names].sort(order).join(","));
order = rcompare;
console.log([...names].sort(order).join(","));
interface Ops {
  twice: (n: number) => number;
  order: (a: string, b: string) => number;
}
const ops: Ops = { twice: double, order: compare };
console.log(ops.twice(21), ops.order("a", "b"), [...names].sort(ops.order).join(","));
const short = { double, compare };
console.log(short.double(4), short.compare("b", "a"), [...names].sort(short.compare).join(","));
const table: Record<string, (n: number) => number> = { double };
console.log(table["double"]!(8));
const steps = [double, (n: number) => n + 1];
console.log(steps.map((step) => step(10)).join(","));

// A program function with a callback parameter, a default parameter, a
// return value, a class field.
function apply(f: (n: number) => number, x: number): number {
  return f(x);
}
function smallest<T>(xs: T[], by: (a: T, b: T) => number): T {
  return [...xs].sort(by)[0]!;
}
function run(x: number, f: (n: number) => number = double): number {
  return f(x);
}
function pick(reverse: boolean): (a: string, b: string) => number {
  return reverse ? rcompare : compare;
}
console.log(apply(double, 6), smallest(names, compare), run(4), run(4, (n) => n - 1));
console.log([...names].sort(pick(true)).join(","), [...names].sort(pick(false)).join(","));
class Sorter {
  twice = double;
  order: (a: string, b: string) => number;
  constructor() {
    this.order = compare;
  }
  run(xs: string[]): string {
    return [...xs].sort(this.order).join(",") + this.twice(2);
  }
}
console.log(new Sorter().run(names));

// Default exports of the package's own modules, stored as the property
// values of an object literal (shorthand and long form) and handed back to
// the island: each is still the island's function there.
const plugins = { shoutPlugin, reversePlugin };
for (const [name, plugin] of Object.entries(plugins)) {
  kit.register(name, plugin);
}
console.log(kit.run("shoutPlugin", "abc"), kit.run("reversePlugin", "abc"), kit.run("none", "abc"));
const renamed = { loud: shoutPlugin, back: reversePlugin };
kit.register("loud", renamed.loud);
console.log(kit.run("loud", "xyz"), Object.keys(renamed).join(","), plugins.reversePlugin === reversePlugin);

// name, length, typeof, and the function's own methods.
console.log(double.name, double.length, compare.name, compare.length, arity.length);
const typed: (a: string, b: string) => number = compare;
console.log(typed.name, typed.length, typeof typed, typeof double, double instanceof Function);
console.log(double.call(null, 2), double.apply(null, [3]), compare.bind(null, "a")("b"));

// Timers call the function with no arguments.
setTimeout(note, 1, "late");
setTimeout(() => console.log(notes()), 20);
