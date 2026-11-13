// process.noDeprecation and process.throwDeprecation as plain values:
// both read undefined until assigned, keep whatever value they are given
// (Node stores the raw value, not a coerced boolean), and a truthy
// noDeprecation silences a deprecate() wrapper, which is the reason
// programs set it.
const util = require("util");
console.log("initial", process.noDeprecation, process.throwDeprecation);
process.noDeprecation = true;
console.log("set", process.noDeprecation, typeof process.noDeprecation);
process.noDeprecation = 0;
console.log("number", process.noDeprecation, typeof process.noDeprecation);
process.noDeprecation = "yes";
console.log("string", process.noDeprecation, typeof process.noDeprecation);
process.throwDeprecation = 1;
console.log("throw-set", process.throwDeprecation, typeof process.throwDeprecation);
process.throwDeprecation = null;
console.log("throw-null", process.throwDeprecation);
process.noDeprecation = undefined;
process.throwDeprecation = undefined;
console.log("cleared", process.noDeprecation, process.throwDeprecation);
// Silence through the flag.
process.noDeprecation = true;
const quiet = util.deprecate(() => "quiet", "quiet() is deprecated", "DEP_FLAGS_PROBE");
console.log("deprecated", quiet(), process.noDeprecation);
process.noDeprecation = false;
console.log("end", process.noDeprecation, process.throwDeprecation);
