// A function literal written where a function with more parameters is
// expected, in every kind of slot: the literal's own parameters bind, the
// slot's other arguments are ignored, and the function keeps its own length,
// name and identity.
type Visit = (value: number, index: number) => void;
type Pick = (value: number, index: number, all: number[]) => boolean;

function each(xs: number[], f: Visit): void {
  for (let i = 0; i < xs.length; i++) f(xs[i]!, i);
}
function count(xs: number[], f: Pick): number {
  let n = 0;
  for (let i = 0; i < xs.length; i++) if (f(xs[i]!, i, xs)) n++;
  return n;
}
function lengthOf(f: Pick): number {
  return f.length;
}
const xs = [3, 1, 4, 1, 5, 9, 2, 6];

// Argument position.
let total = 0;
each(xs, (x) => {
  total += x;
});
console.log("argument", total);
console.log("no parameters", count(xs, () => true));
console.log("one parameter", count(xs, (x) => x > 2));
console.log("two parameters", count(xs, (x, i) => x > i));
console.log("all parameters", count(xs, (x, i, all) => x + i < all.length));

// Function.length is the literal's own declared count.
console.log(
  "length",
  lengthOf(() => true),
  lengthOf((x) => x > 0),
  lengthOf((x, i) => x > i),
  lengthOf((x, i, all) => all.length > x + i),
  lengthOf(function () {
    return false;
  }),
  lengthOf(function (x) {
    return x > 0;
  }),
);
// A typed binding.
const bound: Pick = (x) => x % 2 === 1;
console.log("binding", count(xs, bound), bound.length, bound.name, bound(7, 0, xs));
let rebound: Pick = () => false;
console.log("let before", count(xs, rebound), rebound.length);
rebound = (x, i) => x === i;
console.log("let after", count(xs, rebound), rebound.length);

// A returned value.
function above(limit: number): Pick {
  return (x) => x > limit;
}
function never(): Pick {
  return function () {
    return false;
  };
}
console.log("returned", count(xs, above(3)), above(3).length, count(xs, never()), never().length);

// Record fields, array elements and optional callbacks.
interface Walker {
  enter: Visit;
  leave?: Visit;
  accept: Pick;
}
const log: string[] = [];
const walker: Walker = {
  enter: (x) => {
    log.push(`in ${x}`);
  },
  accept: () => true,
};
function walk(w: Walker, values: number[]): void {
  values.forEach((v, i) => {
    if (!w.accept(v, i, values)) return;
    w.enter(v, i);
    if (w.leave) w.leave(v, i);
  });
}
walk(walker, [1, 2]);
walker.leave = (x) => {
  log.push(`out ${x}`);
};
walk(walker, [3]);
console.log("record", log.join(","), walker.enter.length, walker.accept.length, walker.enter.name);

const picks: Pick[] = [() => true, (x) => x > 4, (x, i) => i === 0, (x, i, all) => all[i] === x];
console.log("array", picks.map((p) => count(xs, p)).join(","), picks.map((p) => p.length).join(","));

function run(xs: number[], onItem?: Visit): number {
  let calls = 0;
  for (let i = 0; i < xs.length; i++) {
    if (onItem) {
      onItem(xs[i]!, i);
      calls++;
    }
  }
  return calls;
}
let seen = 0;
console.log("optional", run(xs), run(xs, (x) => { seen += x; }), seen);

// A default parameter value and a class field.
function withDefault(xs: number[], f: Pick = (x) => x > 5): number {
  return count(xs, f) * 10 + f.length;
}
console.log("default", withDefault(xs), withDefault(xs, () => true));
class Filter {
  keep: Pick = (x) => x !== 1;
  drop: Pick;
  constructor() {
    this.drop = () => false;
  }
}
const filter = new Filter();
console.log("class", count(xs, filter.keep), count(xs, filter.drop), filter.keep.length, filter.drop.length);

// A conditional of two literals.
function choose(strict: boolean): Pick {
  return strict ? (x, i) => x > i + 1 : (x) => x > 1;
}
console.log("conditional", count(xs, choose(true)), count(xs, choose(false)), choose(true).length, choose(false).length);

// Identity: one function value, however it is reached.
const same: Pick = (x) => x > 0;
const list: Pick[] = [same];
const set = new Set<Pick>([same]);
console.log("identity", same === list[0], list.indexOf(same), list.includes(same), set.has(same));

// Captures: a parameter and a local shared with the caller.
function sumAbove(xs: number[], limit: number): number {
  let sum = 0;
  each(xs, (x) => {
    if (x > limit) sum += x;
  });
  return sum;
}
console.log("captures", sumAbove(xs, 2), sumAbove(xs, 8));

// A literal that calls itself through its binding.
const depth: (n: number, trace: string[]) => number = (n) => (n <= 0 ? 0 : 1 + depth(n - 1, []));
console.log("recursion", depth(5, []), depth.length);

// A literal that reassigns its parameter and captures it.
function later(xs: number[]): (() => number)[] {
  const out: (() => number)[] = [];
  each(xs, (x) => {
    x = x * 2;
    out.push(() => x);
  });
  return out;
}
console.log("captured parameter", later([1, 2, 3]).map((f) => f()).join(","));
