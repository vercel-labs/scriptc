// `arguments.length` in a function expression bound to a variable counts
// what the caller passes: a direct call passes the declared parameters, a
// call through a reference whose function type declares the same count
// passes those, and an inline callback counts the arguments its method
// passes (three for `map`). The count is a compile-time constant on each
// path, so these shapes need no hidden arguments array.
const scaled = function (value: number, factor: number): number {
  console.log("scaled", arguments.length, value, factor);
  return value * factor + arguments.length;
};
console.log(scaled(2, 3));
const same: (value: number, factor: number) => number = scaled;
console.log(same(4, 5));
console.log(
  [1, 2]
    .map(function (value) {
      return `${value}:${arguments.length}`;
    })
    .join(" "),
);
