// A CommonJS file under "use strict": a function with named parameters
// reads `arguments`, which in strict code never aliases those parameters.
"use strict";
function wrap(fn, label) {
  label = label + "!";
  return [label, arguments.length, arguments[1], typeof arguments[0]].join(" ");
}
function sum(a, b) {
  a = 100;
  let total = 0;
  for (let i = 0; i < arguments.length; i++) total += arguments[i];
  return total;
}
console.log(wrap(() => 1, "tag"));
console.log(sum(1, 2, 3));
