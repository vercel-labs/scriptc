// Math.max/Math.min over ONE spread fixed-length numeric tuple. A tuple is
// a record whose positional fields "0".."n-1" hold the values, so the
// spread folds them in order with the same scalar compare the positional
// form uses: NaN poisons, ±0 orders by the JS rules, and the source
// evaluates exactly once (no array is built).
function linear(c: number): [number, number, number] {
  return [c, c * 2, 1 - c];
}

console.log(Math.max(...linear(0.5)), Math.min(...linear(0.5)));
console.log(Math.max(...linear(-2)), Math.min(...linear(-2)));

// A literal assertion to a tuple, including the ±0 preference.
const zeros = [0, -0] as [number, number];
console.log(1 / Math.max(...zeros), 1 / Math.min(...zeros));

// NaN poisons the fold, exactly like the positional form.
const nan: [number, number, number] = [1, 0 / 0, 3];
console.log(Math.max(...nan), Math.min(...nan));

// A one-element tuple spreads to one argument: the value itself.
const single: [number] = [42];
console.log(Math.max(...single), Math.min(...single));

// The shape that started this: a tuple call inside a unary expression.
console.log(Math.cbrt(1 / Math.max(...linear(0.25))));

// Evaluation happens exactly once, even though the fold reads three
// positions.
let calls = 0;
function counted(): [number, number] {
  calls++;
  console.log("counted call", calls);
  return [calls, 10];
}
console.log(Math.max(...counted()), "calls", calls);

// A readonly tuple spreads the same way.
const pair = [4, 9] as const;
console.log(Math.max(...pair), Math.min(...pair));

// A tuple-typed local read is the same fold as the call result.
const local: [number, number, number] = [5, 1, 8];
console.log(Math.max(...local), Math.min(...local));
