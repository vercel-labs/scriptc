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
