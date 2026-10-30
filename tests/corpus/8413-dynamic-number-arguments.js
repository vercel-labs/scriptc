// Untyped functions called directly with numbers and operator results:
// parameters read as operands, by property and container code, through
// `arguments`, defaults, rest parameters, closures, recursion and throws.
function scale(v, k) {
  return v * k + 0.5;
}
function add(a, b) {
  return a + b;
}
function withArguments(a, b) {
  return arguments.length + ":" + (arguments[0] + a) + ":" + String(b);
}
function withDefault(a, b = a * 2) {
  return a + b;
}
function withRest(first, ...rest) {
  return first + rest.length;
}
function fib(n) {
  return n < 2 ? n : fib(n - 1) + fib(n - 2);
}
function reassigned(x) {
  x = x * 3;
  x += 1;
  return x;
}
function counter(start) {
  return () => ++start;
}
function store(o, v) {
  o.total = v + 1;
  return o;
}
function collect(list, v) {
  list.push(v * 2);
  return list.length;
}
function describe(v) {
  return typeof v + ":" + v;
}
function check(v) {
  if (v > 100) throw new RangeError("too large: " + v);
  return v - 1;
}
function mixed(v) {
  return v + "!";
}
function big(v) {
  return v * 1e300;
}
function negativeZero(v) {
  return Object.is(v * -1, -0);
}

let s = 0;
for (let i = 0; i < 1000; i++) {
  s = add(s, scale(i, 1.5));
}
console.log(s);
console.log(withArguments(1.25, 2.5), withArguments(3));
console.log(withDefault(1.5), withDefault(1.5, 0.25));
console.log(withRest(10.5, 1, 2, 3), withRest(0.5));
console.log(fib(20));
console.log(reassigned(2.5), reassigned(1e10));
const next = counter(1000.5);
next();
console.log(next());
console.log(JSON.stringify(store({}, 2.75)));
const list = [];
for (let i = 0; i < 5; i++) collect(list, i + 0.5);
console.log(list.join(","));
console.log(describe(1.5 * 2), describe(0.1 + 0.2), describe(2 ** 53 + 2));
let caught = 0;
for (let i = 95; i < 105; i++) {
  try {
    check(i * 1.5);
  } catch (e) {
    caught++;
    if (caught === 1) console.log(e instanceof RangeError, e.message);
  }
}
console.log(caught);
console.log(mixed(1.5 * 3), mixed(-0), mixed(NaN * 1));
console.log(big(1e10), big(-1e10));
console.log(negativeZero(0 * 1), negativeZero(1 - 1));
