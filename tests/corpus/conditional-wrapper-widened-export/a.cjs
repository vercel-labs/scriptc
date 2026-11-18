"use strict";
// The development arm: a binding whose later write stores a value its
// initializer's record type does not admit.
(function () {
  var value = { alpha: ["a", "b"], beta: ["c", "d"] };
  value = { gamma: function () { return "g"; } };
  exports.value = value;
})();
