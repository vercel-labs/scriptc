// Variadic generic wrappers specialize per call site; the forms that have
// no fixed signature keep precise refusals.

// `arguments` with no fixed signature to lower against.
const loose = function () {
  return arguments[0];
};

// Forwarding a fixed tuple to a variadic function value.
function forward<A extends number[]>(sink: (...xs: number[]) => number, ...args: A): number {
  return sink.apply(null, args);
}
console.log(forward((...xs: number[]) => xs.length, 1, 2));
export { loose };
