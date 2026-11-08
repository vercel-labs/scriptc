// @requires-libnode
// An island ES module that exports a binding literally named
// 'module.exports' (yargs does): its default import is still the 'default'
// export, which require()'s answer would not be (it unwraps the
// 'module.exports' export instead of giving the namespace).
import shout, { named } from "esm-pkg";

console.log("default:", typeof shout, shout("hi"));
console.log("named:", named);
