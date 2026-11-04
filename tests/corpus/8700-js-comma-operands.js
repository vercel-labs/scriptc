// A comma operator whose left operand is "unused and has no side
// effects" is legal JavaScript: the operator evaluates the left operand for
// its effects and yields the right one. TypeScript reports TS2695 and
// scriptc refuses the program; a JavaScript source evaluates it like Node.
function record(log, value) {
  log.push(`left:${value}`);
  return value;
}
const log = [];
const constant = (0, 41) + 1;
const called = (record(log, "a"), "right");
const nested = ((1, 2), (3, 4));
const object = {};
object.value = (true, 5);
const array = [(0, "a"), (0, "b")];
let sum = 0;
for (let i = (0, 0); i < (0, 3); i = (0, i + 1)) sum += (0, i);
const conditional = true ? (0, "yes") : (0, "no");
const template = `${(0, "tpl")}`;
console.log(constant, called, nested, object.value, array.join(""), sum);
console.log(conditional, template, log.join(","));
