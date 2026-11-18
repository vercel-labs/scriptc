// `export *` over a CommonJS module forwards exactly the names Node's lexer
// finds — through `module.exports = require(...)` chains, conditionals
// included — and never `default`; `module.exports` is itself a forwarded
// name. A name the re-exporting module exports itself wins, and a name two
// different re-exported CommonJS modules provide is ambiguous and absent.
import { jsx, Fragment } from "./shim.ts";
import * as shim from "./shim.ts";
import * as shadow from "./shadow.ts";
import * as two from "./two.ts";

console.log(jsx("div"), Fragment);
console.log(Object.keys(shim).sort().join(","));
console.log(shadow.jsx(), shadow.Fragment);
console.log(Object.keys(shadow).sort().join(","));
console.log(two.onlyA, two.onlyB, Object.keys(two).sort().join(","));
