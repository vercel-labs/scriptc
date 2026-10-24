'use strict';
// A CommonJS module may end its evaluation with a top-level return: the
// rest of the module does not run, while timers, exit handlers and the
// modules it already required keep their effects.
const early = require('./early.js');
console.log('early exports', early.ready);
setTimeout(() => console.log('timer ran'), 1);
process.on('exit', () => console.log('exit handler'));
for (const value of [1, 2, 3]) {
  if (value === 2) return 'ignored value';
  console.log('value', value);
}
console.log('not reached');
function hoisted() {
  return 'hoisted';
}
