'use strict';

console.log('a start');
class A {
  hello() {
    return 'hi';
  }
}
exports.A = A;
require('./b.js');
