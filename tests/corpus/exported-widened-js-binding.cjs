// A CommonJS export that stores a JavaScript binding whose later write puts a
// value its initializer's type does not admit. Node's exports object holds
// whatever the binding holds when the write runs, so the member has to hold
// that value too, not a checked conversion of it back to the initializer's
// record type (react.development.js's `exports.__COMPILER_RUNTIME =
// deprecatedAPIs`, where the record starts as arrays of strings and is later
// replaced by a frozen object). The write sits in a function, as React's
// does, so the binding's slot is collected after the module's export table.
(function () {
  var value = { alpha: ["a", "b"], beta: ["c", "d"] };
  value = { gamma: function () { return "g"; } };
  exports.value = value;
})();
console.log(typeof exports.value, exports.value.gamma());
