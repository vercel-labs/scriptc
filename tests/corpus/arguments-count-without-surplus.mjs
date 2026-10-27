// arguments in functions called with and without surplus arguments: length,
// element reads, identity, and parameters that are reassigned.
function f(a, b, c) {
  const n = arguments.length;
  if (n > 3) return [n, arguments[3], arguments[0]].join(",");
  return n + ":" + Array.prototype.slice.call(arguments).join("|");
}
console.log(f(1), f(1, 2), f(1, 2, 3), f(1, 2, 3, 4), f());
function g(a, b) {
  const args = arguments;
  const again = arguments;
  return [args === again, args.length, args[1], typeof args[2]].join(" ");
}
console.log(g("x"), g("x", "y"), g("x", "y", "z"));
function h(a) {
  return arguments.length;
}
console.log(h(), h(1), h(1, 2, 3));
function k(a) {
  a = 5;
  return arguments[0] + "/" + arguments.length;
}
console.log(k(1), k(1, 2));
