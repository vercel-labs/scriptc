'use strict';

console.log('a start');
module.exports = {
  get value() {
    console.log('getter ran');
    return 'G';
  },
};
const b = require('./b.js');
console.log('a sees', b.late);
