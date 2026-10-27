// Split require bindings (`var m; m = require("./x.cjs")`) that close a
// CommonJS cycle: each module publishes its exports before its require, and
// reads the other module's binding only in functions that run after both
// modules finish, the cycle shape the const form compiles too. One
// assignment parenthesizes its require.
console.log("main: start");
var even, odd;
even = require("./even.cjs");
odd = require("./odd.cjs");
console.log(even.isEven(10), odd.isOdd(7), even.isEven(3));
console.log(even.describe(4), "|", even.describe(9));
console.log("odd calls", odd.calls(), even.name, odd.name);
