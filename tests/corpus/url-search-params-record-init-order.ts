// A URLSearchParams record init evaluates its property initializers in
// source order and appends the record's keys in Reflect.ownKeys order
// (integer index keys ascending first), so an integer key does not move
// its initializer ahead of the others and a later initializer cannot
// change a value an earlier one already read.
const seen: string[] = [];
const tag = (label: string, value: string): string => {
  seen.push(label);
  return value;
};

const p = new URLSearchParams({ b: tag("b", "2"), 0: tag("0", "1"), a: tag("a", "3") });
console.log(p.toString());
console.log(seen.join(","));

const tail = new URLSearchParams({ b: "B", 10: "ten", 2: "two", a: "A", 0: "zero" });
console.log(tail.toString());

let v = "before";
const r = new URLSearchParams({ b: v, 0: ((v = "after"), "zero") });
console.log(r.toString());
console.log(v);

const one = new URLSearchParams({ 0: tag("only 0", "0"), b: tag("only b", "B") });
console.log(one.toString());
console.log(seen.join(","));
