// A forwarding factory and a function that ignores its receiver, reached
// through this module's namespace.
export function dual(body) {
  return function () {
    return body.apply(this, arguments);
  };
}
export const plain = function (n) {
  return "plain " + n;
};
// A factory that chooses what it returns by the number of its arguments,
// and an export it made.
export const byArity = function () {
  if (arguments.length === 1) {
    const first = arguments[0];
    return (n) => first + " " + n;
  }
  return dual((a, b) => a + " " + b).apply(this, arguments);
};
export const partial = byArity("chosen");
