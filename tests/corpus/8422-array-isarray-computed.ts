// `Array.isArray` over a computed argument: a call, an array literal, an
// object literal. The answer comes from the argument's static type, so the
// argument is evaluated for its effects and its value discarded. A union
// argument keeps answering by its runtime tag, and side effects of the
// argument survive the fold.
function rows(): number[] {
  return [1, 2];
}
function label(): string {
  return "rows";
}
type Pair = [number, string];
function pair(): Pair {
  return [3, "three"];
}
let evals = 0;
function counted(): number[] {
  evals++;
  return [];
}

console.log(Array.isArray(rows()), Array.isArray([1, 2]), Array.isArray({ a: 1 }));
console.log(Array.isArray(label()), Array.isArray(pair()));
console.log(Array.isArray(counted()), evals);
const maybe: string | string[] = ["a"];
const narrow: string | string[] = "a";
console.log(Array.isArray(maybe), Array.isArray(narrow));
console.log(Array.isArray(rows().map((n) => n * 2)));
