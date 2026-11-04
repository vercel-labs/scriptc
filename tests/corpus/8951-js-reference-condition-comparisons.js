// Strict equality between two distinct object references is false, and
// between a value and itself is true: the checker proves the condition
// (TS2839), and the comparison lowering performs the same reference test
// Node performs. A fresh object never equals another fresh object, whichever
// wrapper or literal form creates it.
console.log({} === {});
console.log({} !== {});
console.log(new Number(1) === new Number(1));
console.log(new String("a") === new String("a"));
console.log(1 === new Number(1));

const left = {};
const right = {};
const same = left;
console.log(left === right, left === same, left !== same);

// The same reference compared through two bindings, and as a condition.
if (left === right) {
  console.log("same");
} else {
  console.log("different");
}
const values = [left, right];
console.log(values[0] === values[1], values[0] === same);
