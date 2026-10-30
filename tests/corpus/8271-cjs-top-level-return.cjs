'use strict';
// A return at the top level of the entry CommonJS module ends its
// evaluation, as in Node's module wrapper: from a block, a loop and a try
// statement, whose finally block still runs.
const fs = require('fs');

console.log('start');
for (const name of ['a', 'b', 'c']) {
  if (name === 'c') {
    try {
      console.log('returning at', name);
      process.on('exit', (code) => console.log('exit', code));
      if (!fs.existsSync('/scriptc-missing-path')) return;
    } finally {
      console.log('finally runs');
    }
  }
  console.log('visited', name);
}
console.log('not reached');
