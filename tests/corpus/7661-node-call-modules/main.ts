// @requires-libnode
// The modules island calls load ship with the program: a module of the
// program and the modules it loads, and whole packages with their
// dependencies, including files a package reads or loads by computed names.
import { callSync } from "@scriptc/node";

console.log(callSync<string>("./lib/entry.cjs", "describe", "scriptc"));
console.log(callSync<string>("greeter", "greet", "world"));
console.log(callSync<string>("greeter", "fromData"));
console.log(callSync<string>("greeter", "byName", "shout", "computed"));
console.log(callSync<boolean>("./lib/entry.cjs", "hasOptional"));
console.log(callSync<number>("./lib/esm.mjs", "twice", 21));
