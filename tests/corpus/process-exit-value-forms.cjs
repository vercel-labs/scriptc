// @exit: 16
// process.exitCode accepts Node's numeric forms: a numeric string converts
// through Number, whitespace-only text reads as zero, and null/undefined
// clear the assignment. Everything else is the setter's validation: the
// non-number TypeError (the empty string and non-numeric text keep their
// string shape and read as type string, a symbol never converts), the
// non-integer RangeError, and the uint32 wrap for large integers.
// process.exit(value) runs the same conversion and exits with the result.
"use strict";
function set(value) {
  try {
    process.exitCode = value;
    console.log("set", String(value), "->", process.exitCode);
  } catch (error) {
    console.log("set", String(value), error.name, error.code, error.message);
  }
}
set(16);
set("0x10");
set(" ");
set("  24  ");
set(null);
set(undefined);
set(true);
set(1.5);
set("");
set("abc");
set(-1);
try {
  process.exitCode = Symbol("c");
} catch (error) {
  console.log("symbol", error.name, error.message);
}
set(2.0);
set(-0);
set(4294967296);
process.exit("0x10");
