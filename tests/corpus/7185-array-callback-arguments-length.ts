// `arguments.length` in a function-expression callback counts every
// argument the array method passes: value, index and array, plus the
// accumulator for reduce. One stored in a fixed-arity function type counts
// that type's parameters, which every call passes.
const seen: number[] = [];
[10, 20].forEach(function (value) {
  seen.push(arguments.length, value);
});
console.log(seen.join(","));

console.log(
  [1, 2]
    .map(function (value) {
      return `${value}:${arguments.length}`;
    })
    .join(" "),
);

console.log([5].filter(function () {
  return arguments.length === 3;
}).length);

console.log([1].reduce(function (acc, value) {
  return acc + value + arguments.length;
}, 0));

console.log(["x", "y"].reduceRight(function (acc: string, value: string) {
  return `${acc}${value}${arguments.length}`;
}, ""));

console.log([3, 4].some(function (value) {
  return arguments.length === 3 && value === 4;
}));

const sum: (a: number, b: number) => number = function (a) {
  return a + arguments.length;
};
console.log(sum(1, 2));

console.log([3, 1, 2].sort(function (a, b) {
  return arguments.length === 2 ? a - b : 0;
}).join(","));
