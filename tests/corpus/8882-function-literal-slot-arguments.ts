// `arguments` in a function expression holds what the caller passed, however
// many parameters the expression declares.
type Step = (a: number, b: number, c: number) => number;
function call3(f: Step): number {
  return f(1, 2, 3);
}
console.log(
  "count",
  call3(function () {
    return arguments.length;
  }),
  call3(function (a) {
    return arguments.length * 10 + a;
  }),
);
// A function expression that declares every parameter still counts them all.
console.log(
  "declared",
  call3(function (a, b, c) {
    return arguments.length * 100 + a + b + c;
  }),
);
