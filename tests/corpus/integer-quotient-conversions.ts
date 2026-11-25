// The bitwise conversions of a constant-divisor quotient. `(x / c) | 0` and
// `^ 0`, `& -1`, `<< 0` and `>> 0` are the truncated quotient of an int32
// dividend, which integer division computes; every other shape keeps
// ToInt32 of the real quotient. A shift count is the identity operand on the
// RIGHT only (`0 << (10 / 3)` is `0 << 3`, not `10 / 3`), and a divisor
// outside the instruction's i64 constant keeps the real quotient rather
// than dividing by a truncated zero.
console.log("or-zero", (100 / 7) | 0);
console.log("xor-zero", (100 / 7) ^ 0);
console.log("and-all-ones", (100 / 7) & -1);
console.log("negative", (-100 / 7) | 0);
console.log("positive-fraction", (10 / 3) | 0);
console.log("shift-count-zero", (10 / 3) << 0);
console.log("right-shift-count-zero", (-10 / 3) >> 0);
console.log("unsigned-shift", (100 / 7) >>> 0);
console.log("fractional-divisor", (10 / 2.5) | 0);
console.log("zero-divisor", (10 / 0) | 0);

// The shift's left literal is the value shifted, not the conversion.
console.log("shift-left-zero", 0 << (10 / 3));
console.log("shift-left-32", 32 << (10 / 3));
console.log("shift-left-negative", -32 << (10 / 3));
console.log("shift-right-zero", 0 >> (10 / 3));
console.log("shift-right-32", 32 >> (10 / 3));
console.log("shift-left-zero-dividend", 0 << (-10 / 3));

// 18446744073709551616 is an integer double that is not representable in an i64
// constant: the integer division would divide by a truncated zero.
console.log("huge-divisor", (10 / 18446744073709551616) | 0);
console.log("huge-negative-divisor", (10 / -18446744073709551616) | 0);
console.log("huge-quotient-divisor", (-10 / 9007199254740991) | 0);
console.log("safe-divisor", (10 / 9007199254740991) | 0);
// A counted loop's integer dividend keeps the instruction dynamic, so a
// divisor the i64 constant cannot hold would divide by a truncated zero
// at run time.
let huge: number = 0;
for (let i = 0; i < 3; i++) {
  huge += (i / 18446744073709551616) | 0;
}
console.log("huge-divisor-loop", huge);

// An int32 element read is a proven integer dividend in the instruction.
const ints = new Int32Array(2);
ints[0] = 5;
console.log("huge-divisor-element", (ints[0]! / 18446744073709551616) | 0);

// INT32_MIN / -1 is the quotient outside int32; ToInt32 wraps it.
console.log("int32-min-over-minus-one", (-2147483648 / -1) | 0);
console.log("int32-max-over-minus-half", (2147483647 / -0.5) | 0);
