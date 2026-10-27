// A dependency under node_modules that requires node:punycode: Node's
// isInsideNodeModules() rule skips DEP0040 for it, so nothing reaches stderr
// or the 'warning' listeners, and the program's own later require of the
// cached module does not report either.
"use strict";
process.on("warning", (w) => console.log("listener", w.code));
const toAscii = require("puny-dep");
const punycode = require("punycode");

console.log(toAscii("mañana.com"), toAscii("example.org"));
console.log(punycode.toUnicode("xn--maana-pta.com"));
setTimeout(() => console.log("timer"), 0);
