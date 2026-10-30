'use strict';
// A top-level return in a CommonJS module can precede declarations that
// only the rest of the module reads. The timer and exit handler registered
// before the return run, a callback's own binding shadows a later one of
// the same name, and a function declared after the return is hoisted.
const fs = require('fs');

console.log('start', describe());
setTimeout(() => {
  const socket = 'inner socket';
  console.log('timer', socket);
}, 1);
process.on('exit', (code) => console.log('exit', code));
for (const name of ['a', 'b']) {
  if (name === 'b' && !fs.existsSync('/scriptc-missing-path')) return;
  console.log('visited', name);
}

const socket = 'outer socket';
let count = 2;
var total = count + 1;
class Server {}
const [first, second] = [count, total];
for (var i = 0; i < 2; i++) console.log('not reached', i);
console.log('not reached', socket, first, second, new Server());
function describe() {
  return 'hoisted';
}
