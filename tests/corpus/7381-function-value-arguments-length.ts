// `arguments.length` in a function declaration counts the arguments its
// caller passes: a direct call passes the declared parameters, and a call
// through the function as a value passes the parameters of the function
// type it was passed as (3 for map and filter, 4 for reduce, 2 for sort).
function scaled(value: number): number {
  return value * 10 + arguments.length;
}
function total(acc: number, value: number): number {
  return acc + value + arguments.length;
}
function compare(a: number, b: number): number {
  return arguments.length === 2 ? a - b : 0;
}
console.log([1, 2].map(scaled).join(), scaled(3));
console.log([5, 6].filter(scaled).length, [1, 2].reduce(total, 0), total(1, 2));
console.log([3, 1, 2].sort(compare).join());

function apply(f: (a: number, b: number, c: number) => number): number {
  return f(1, 2, 3);
}
console.log(apply(scaled));

// A direct call inside a call through the value sees its own count.
function depth(n: number): number {
  return n <= 0 ? arguments.length : depth(n - 1) + arguments.length;
}
console.log([2].map(depth).join(), depth(2));
