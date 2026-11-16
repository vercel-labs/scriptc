'use strict';

let n = 0;
function bump() {
  n += 1;
  console.log('bump', n);
  return n;
}
require('./b.js');
module.exports = { value: bump() };
