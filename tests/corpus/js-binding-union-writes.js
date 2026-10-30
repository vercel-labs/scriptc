// JavaScript bindings initialized with a number and later written with a
// value that may be a string: a conditional of a number and a string, and
// `+=` of an element that can be either. Node keeps each value as written.
function pick(c) {
  var x = 0;
  x = c > 1 ? 1 : "a";
  return x;
}
function total(parts) {
  let n = 0;
  for (let i = 0; i < parts.length; i++) n += parts[i];
  return n;
}
console.log(pick(0), pick(2), typeof pick(0), typeof pick(2));
console.log(total([1, 2]), total([1, "a", 2]), typeof total([1, "a"]));
