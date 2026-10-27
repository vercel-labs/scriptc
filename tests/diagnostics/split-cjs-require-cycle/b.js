var a;
a = require('./main.js');
exports.fromB = 'b-value';
exports.readA = function () {
  return a.early + '/' + a.late;
};
console.log('b sees a.early:', a.early, 'a.late:', a.late);
