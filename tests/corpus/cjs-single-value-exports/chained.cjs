'use strict';

// The declaration spelling: Node stores the function in module.exports and
// in `double` alike, and the later expando write lands on the same object.
var double = (module.exports = function (n) {
  return n * 2;
});

double.extra = 7;
double.triple = function (n) {
  return n * 3;
};
