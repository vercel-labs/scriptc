// A JavaScript module's default export object holding functions and class
// values builds at module initialization, and its members work through
// both the default object and the named exports.
import lib, { parse, ParseError } from "./lib/index.js";

console.log(JSON.stringify(parse("a = 1")));
console.log(lib.stringify(lib.parse("b = 2")));
try {
  lib.parse("");
} catch (e) {
  if (e instanceof ParseError) console.log(e.name, e.message, e.line);
}
const Ctor = lib.ParseError;
const made = new Ctor("built through the default object", 7);
console.log(made instanceof ParseError, made.message, made.line, Ctor === ParseError);
