const assert = require("assert");
const strict = require("node:assert/strict");
const { doesNotThrow: noThrow } = require("node:assert");
assert.doesNotThrow(() => {});
strict.doesNotThrow(() => 42);
noThrow(() => {});
try { strict.doesNotThrow(() => { throw new TypeError("bad"); }, /TypeError: bad/); }
catch (error) { console.log(error.name, error.code, error.message); }
console.log("CommonJS pass");
