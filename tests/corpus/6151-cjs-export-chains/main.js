// Chained member exports share one value, evaluated once; a fresh
// `exports = module.exports = {}` at the top of a module is a no-op reset.
const chain = require("./chain.js");
console.log(chain.a(), chain.b(), chain.a === chain.b, chain.evaluations);
console.log(chain.c, chain.d, chain.e);
const re = require("./re.js");
console.log(re.src.length, re.t.FULL, re.tokens.join(","));
const sem = require("./sem.js");
console.log(sem.src.join(" "), sem.re.join(","), sem.count());
