'use strict';

console.log('b start');
var a;
a = require('./a.js');
exports.B = function () {
  return a.A;
};
