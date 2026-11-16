// A member a CommonJS module's exports object does not carry reads
// undefined in Node — through a require binding, a destructured binding,
// and an inline require().member. A member the module's JavaScript only
// conditionally assigns is absent on the path that skipped it, and reads
// undefined there too, including through a module whose whole export is
// chosen between two static tables.
'use strict';

const table = require('./table.cjs');
const { present, absent } = require('./table.cjs');
const conditional = require('./conditional.cjs');
const picked = require('./pick.cjs');

console.log('binding', table.present, table.absent);
console.log('inline', require('./table.cjs').present, require('./table.cjs').absent);
console.log('destructured', present, absent);
console.log('probe', table.absent === undefined, typeof table.absent, table.absent ?? 'default');
console.log('present', table.present === undefined, typeof table.present, table.present ?? -1);
console.log('conditional', conditional.always, conditional.sometimes === undefined);
console.log('conditional typeof', typeof conditional.sometimes, conditional.sometimes ?? 'unset');
console.log('picked', picked.always, picked.sometimes === undefined, picked.sometimes ?? 'unset');

// A probe through an inline require() evaluates the module at that position
// (its side effect runs first) and reads its storage afterwards.
console.log(
  'inline probe',
  require('./probe-side.cjs').sometimes === undefined,
  typeof require('./probe-side.cjs').sometimes,
  require('./probe-side.cjs').always,
);

// Calling the absent member evaluates its arguments first, then throws
// Node's "is not a function" TypeError naming the member.
try {
  table.absent(console.log('argument ran'));
} catch (e) {
  console.log('call', e.name, e.message);
}
try {
  require('./table.cjs').absent(console.log('argument ran'), 1);
} catch (e) {
  console.log('inline call', e.name, e.message);
}
