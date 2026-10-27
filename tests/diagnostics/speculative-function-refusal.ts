// Function expressions lowered speculatively — an `.apply` receiver and a
// computed class base — report a refused statement in their body like any
// other function: the statement never disappears from the build.
(function () {
  console.log("wrapper");
  console.log(eval("1 + 1"));
}).apply(null, []);

class Base {}
class Derived extends (function () {
  console.log(new Function("return 1")());
  return Base;
})() {}
console.log(typeof Derived);
