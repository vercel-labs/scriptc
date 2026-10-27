// Unary plus and minus on booleans and on values that may be strings or
// undefined, and += on a binding that holds a number or a string.
function step(text, at) {
  const open = text[at] === "[";
  at += +open;
  return [at, +open + +true + +false, -open];
}
const at = JSON.parse("1");
console.log(step("a[b", at), step("ab", at));
let total = 0;
for (const flag of [true, false, true]) total += +flag;
console.log(total, +true, -true, +(1 > 2), -(2 > 1));

const match = "2024-01-02".match(/^(\d+)-(\d+)-(\d+)(?:T(\d+))?$/);
console.log(+match[1], +match[4], -match[2], +match[3] + 1, typeof +match[4], -match[4]);
const optional = [undefined, "7", " 8 ", "", "x"];
console.log(optional.map((value) => +value), optional.map((value) => -value));

let fraction = 0;
const digits = "5";
if (digits) {
  fraction = digits.slice(0, 3);
  while (fraction.length < 3) fraction += "0";
  fraction = +fraction;
}
console.log(fraction, typeof fraction);
let width = 0;
width = digits.repeat(2);
width += 1;
console.log(width, typeof width);
let label = "x";
label += 5;
label += true;
console.log(label);
