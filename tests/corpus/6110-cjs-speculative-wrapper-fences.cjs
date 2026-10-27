// @deferred-fences: 1
// Function expressions lowered speculatively — the `.call(this)` and
// `.apply` receivers of CommonJS wrappers, and a computed class base — keep
// every statement of their bodies. The wrappers' `root === module.exports`
// and `typeof module.exports` compile; a statement with no static lowering
// (here `module.exports` passed as a value in the class base) compiles to
// its runtime fence instead of vanishing. It never runs, so the binary
// matches Node.
const verbose = process.argv.length > 99;
(function () {
  var root = this;
  console.log("call wrapper");
  if (verbose) console.log(root === module.exports);
  console.log("call wrapper done");
}).call(this);
(function (label) {
  console.log("apply wrapper", label);
  if (verbose) console.log(typeof module.exports);
}).apply(null, ["ok"]);
class Base {
  hello() {
    return "hello";
  }
}
class Derived extends (function () {
  if (verbose) console.log(module.exports);
  return Base;
})() {}
console.log(new Derived().hello());
