// Array.prototype methods that create a new array construct it through the
// subclass (ArraySpeciesCreate): map, filter, slice, splice, concat, flat
// and flatMap return an instance of the subclass, built by calling its
// constructor with the length the specification passes. Methods that
// return the receiver keep it, and Array.of / Array.from inherited as
// statics construct the subclass too.
class Logged extends Array<number> {
  constructor(...args: number[]) {
    super(...args);
    console.log("construct", args.length === 1 ? `length ${args[0]}` : `items ${args.join(",")}`);
  }

  sum(): number {
    let total = 0;
    for (const v of this) total += v;
    return total;
  }
}

const base = Logged.of(1, 2, 3, 4);
console.log(base instanceof Logged, base);
const doubled = base.map((v) => v * 2);
console.log(doubled instanceof Logged, (doubled as Logged).sum(), doubled);
const even = base.filter((v) => v % 2 === 0);
console.log(even instanceof Logged, even);
const part = base.slice(1, 3);
console.log(part instanceof Logged, part);
const removed = base.splice(0, 1);
console.log(removed instanceof Logged, removed, base);
const joined = base.concat([7, 8]);
console.log(joined instanceof Logged, joined.length, joined);
const flat = base.flatMap((v) => [v, v]);
console.log(flat instanceof Logged, flat.length);
const filled = base.fill(0, 0, 1);
console.log(filled === base, base);
const from = Logged.from([5, 6]);
console.log(from instanceof Logged, (from as Logged).sum());
