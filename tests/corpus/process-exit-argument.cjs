// @exit: 3
// process.exit(code) runs the exitCode setter's conversion before exiting:
// a value the setter rejects (non-numeric text, a fraction, a symbol)
// throws catchably and the program keeps running with the code unset,
// while a numeric string exits with its number. The last call exits 3.
"use strict";
function report(label, run) {
  try {
    console.log(label, "->", run());
  } catch (error) {
    console.log(label, error.name, error.code, error.message);
  }
}
console.log("start");
report("non-numeric string", () => process.exit("nope"));
console.log("still running", process.exitCode);
report("fraction", () => process.exit(1.5));
console.log("still running", process.exitCode);
report("symbol", () => process.exit(Symbol("c")));
console.log("still running", process.exitCode);
process.exit("0x03", "ignored");
console.log("never");
