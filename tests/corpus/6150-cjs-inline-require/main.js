// Inline require() of program modules: each call evaluates its module at
// exactly that position (or answers from the cache), and the value is the
// module's exports, read statically.
console.log("main: start");
const f = require("./lib.js").f;
console.log("main: first inline require done", f(1));
console.log("main: cached", require("./lib.js").n, require("./lib.js").f(2));
exports.viaInline = require("./lib.js").f;
console.log("main: exported member", exports.viaInline(3), exports.viaInline === f);

// Mutation through an inline read is visible to every requirer.
require("./lib.js").counter.hits++;
const lib = require("./lib.js");
console.log("main: shared counter", lib.counter.hits, require("./lib.js").counter === lib.counter);

// A whole-export function called directly off the require.
const debug = require("./make-logger.js")("app");
console.log(debug("ready"));

// Construction through a whole-export class and through a member class.
const p = new (require("./point.js"))(1, 2);
console.log("point", p.x + p.y);
const q = new (require("./shapes.js").Square)(3);
console.log("square", q.area());

// Lazy inline require: the module loads at the first call, once.
function late() {
  return require("./late.js").value;
}
console.log("main: before late");
console.log("late", late(), late());

// Member calls off an inline require of a table module.
console.log("table member", require("./table.js").twice(4), require("./table.js").label);

// Table entries holding inline requires.
const table = { verify: require("./verify.js"), sign: require("./lib.js").f };
console.log("table", table.verify("tok"), table.sign(4));

// Re-exports: module.exports = require(...) and through a binding.
const a = require("./reexport-inline.js");
const b = require("./reexport-binding.js");
console.log("reexports", a.inner(), b.inner(), a.inner === b.inner);

// Single computed values as the whole export.
const T = require("./type-error.js");
try {
  throw new T("bad input");
} catch (e) {
  console.log(e instanceof TypeError, String(e));
}
const pick = require("./pick.js");
console.log("pick", pick(5), typeof require("./fallback.js"), require("./fallback.js")());
const reg = require("./registry.js");
console.log("registry", reg.size(), reg.add("x"), reg.size(), require("./registry.js") === reg);
