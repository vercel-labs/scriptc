// Logical assignment (`??=`, `||=`, `&&=`) to property and computed members:
// class fields, an index-signature record, and a callable's own properties.
// Each form evaluates its receiver and key once, reads the current value,
// and evaluates the right side only when the operator's test says so; the
// expression yields the value the member holds afterwards.

let inits = 0;
function make(): number {
  inits += 1;
  return 4;
}

class Box {
  value: number | undefined;
  other: number | undefined;
  flag = true;
  counts: Record<string, number> = {};

  set(v: number): number {
    return (this.value ??= v);
  }

  or(key: string, v: number): number {
    return (this.counts[key] ||= v);
  }

  and(v: boolean): boolean {
    this.flag &&= v;
    return this.flag;
  }
}

const box = new Box();
console.log("set", box.set(5), box.set(9));
console.log("or", box.or("zero", 0), box.or("zero", 7), box.counts["zero"]);
console.log("and", box.and(true), box.and(false), box.flag);

// A property whose current value is nullish evaluates the right side once;
// a present value skips it entirely.
interface Tracked {
  (): number;
  runs?: number;
}
const tracked: Tracked = function () {
  return 1;
};
console.log("fn", tracked.runs ??= make(), tracked.runs, inits);
console.log("fn", tracked.runs ??= make(), tracked.runs, inits);

// An any-typed receiver keeps the untyped read and write.
const bag: any = { n: 0, s: "" };
bag.n ||= 11;
bag.s &&= "kept";
bag.missing ??= make();
console.log("bag", bag.n, bag.s, bag.missing, inits);

// The receiver and key of a computed member are evaluated once even when
// the right side runs (and can itself touch the member).
const counts: Record<string, number> = {};
let keyReads = 0;
function key(): string {
  keyReads += 1;
  return "hits";
}
console.log("computed", (counts[key()] ||= make()), keyReads, counts);
counts["hits"] ||= make();
console.log("kept", counts["hits"], keyReads, inits);
