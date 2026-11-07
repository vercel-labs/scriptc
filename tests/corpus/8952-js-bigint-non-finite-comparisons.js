// Strict equality between a bigint and a non-finite number (or nullish)
// compares the types first and answers false; the checker proves the result
// (TS2845) and the comparison lowering applies the same type test Node
// applies. A bigint never equals Infinity, -Infinity or NaN, in either
// operand order.
console.log(0n === Infinity, Infinity === 0n);
console.log(1n === -Infinity, -Infinity === 1n);
console.log(0n === NaN, NaN === 0n);
console.log(NaN === null, Infinity === null, undefined === null);

// The loose operator reaches the same answer for these operands, and the
// condition's truth value is what the program sees.
if (0n === Infinity) {
  console.log("equal");
} else {
  console.log("not equal");
}
const results = [0n === NaN, Infinity === 0n, NaN === null];
console.log(results.join(","));
