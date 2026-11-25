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

// A member attached through module.exports belongs to the exported value.
module.exports.named = 'exported';

// The declarator is an ordinary module binding: reassigning it leaves the
// exported function alone.
double = function (n) {
  return n * 100;
};
console.log('chained in-file:', double(2), module.exports.named);
