// @requires-libnode
// @normalize-pid
// Node's deprecation warnings from island code (scope-B NI-7f):
// - punycode required first by island code outside node_modules: DEP0040
//   on stderr, with Node's text, at that call;
// - punycode required by an island package (inside node_modules, as
//   node-fetch's whatwg-url): no warning, in Node as here;
// - a package that warns when it loads: not deferred (the probe records
//   the warning), so it warns at its import position.
import { requireModule } from "@scriptc/node";
import { toAscii } from "puny-pkg";
import { ok } from "warn-pkg";

console.log("start", ok());
const legacy = requireModule("./legacy.cjs");
const ascii: string = legacy.toAscii("bücher.de");
console.log("legacy", ascii);
console.log("package", toAscii("mañana.com"));
