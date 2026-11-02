// JavaScript operators convert their operands with ToPrimitive/ToNumeric
// (ToInt32 for the bitwise six) before the operation, whatever the static
// types say. TypeScript sources keep their typed refusals; this program pins
// the JavaScript lane against Node byte-for-byte.
var s = "6";
var u;
var b = true;
var n = null;

// The numeric five.
console.log(s / 2, s - 1, s * "2", s % 4, s ** 2, s / "3", s - "1");
console.log(u / 2, u - 1, u * s, u % 2, b / true, b % true, b * n, n / 2, n - "1");

// The bitwise six: ToInt32/ToUint32 of strings, booleans, null and undefined.
console.log(s << "1", s >>> 1, s >> 1, s & "3", s | 0, s ^ 3);
console.log(b & true, b | 0, b ^ "3", n & 1, u | 0, "12" >>> "2");

// `+` adds numbers and concatenates strings after ToPrimitive.
console.log(b + n, n + n, s + b, b + s, u + s);

// A conversion hook runs in the operator's own order, once per operand.
var order = "";
var left = { valueOf: function () { order += "l"; return 4; } };
var right = { toString: function () { order += "r"; return "2"; } };
console.log(left - right, left * s, left / 2, order);

// A Symbol operand throws Node's TypeError and a conversion hook that throws
// propagates its own error.
try {
  console.log(Symbol() / 2);
} catch (e) {
  console.log(e.constructor.name, e.message);
}
try {
  console.log(s * Symbol());
} catch (e) {
  console.log(e.constructor.name, e.message);
}
try {
  var poisoned = { valueOf: function () { throw new RangeError("hook"); } };
  console.log(poisoned - 1);
} catch (e) {
  console.log(e.name, e.message);
}

// Unary - and + are ToNumber; ~ is ToInt32. (A symbol operand keeps the
// checker's TS2469 refusal, so the program does not exercise it here.)
console.log(-s, +s, ~s, -b, ~n, -u, +u, ~"12", -null, +"12.5");

// BigInt operands keep their own operators, in both languages.
console.log(5n * 2n, 5n % 2n, 5n - 2n, 5n / 2n, -5n, ~5n);
