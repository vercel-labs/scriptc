// `arguments.length` in a function expression stored in a slot with more
// parameters counts that slot's arguments, but a call through the
// expression's own name passes only the declared ones: no constant answers
// both, so the read fences.
const count: (a: number, b: number) => number = function self(a: number): number {
  return a > 0 ? self(a - 1) + arguments.length : arguments.length;
};
console.log(count(2, 0));
