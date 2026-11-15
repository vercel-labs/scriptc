// Deferred fences in a module's top-level code run when the module loads;
// a fence inside a function runs when the function is called.
"use strict";
var value = JSON.parse("{}");
console.log(value instanceof AsyncDisposableStack);
function check(other) {
  return other instanceof AsyncDisposableStack;
}
console.log(check([]));
