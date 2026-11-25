// @normalize-pid
'use strict';
// setTimeout and setInterval convert an untyped delay with ToNumber, as
// Node's `after *= 1` does: undefined, null, booleans, strings, arrays and
// objects all become a 1ms delay, with Node's warnings for the NaN,
// negative and overflowing ones (test-timers.js).
//
// The delays are in increasing order, so the timeouts run in the order they
// were created however long the process is held up: a later timer with a
// longer delay expires later. The array that converts to 3 and the string
// that converts to 7 sit between the numbers 2, 5 and 9, and one that
// converted to a delay outside its neighbours' would run out of place.
const inputs = [undefined, null, true, false, '', [], {}, NaN, Infinity, -Infinity, -0, 0.5, 2147483648, 2, [3], 5, '7', 9];
const fired = [];
inputs.forEach((value, index) => {
  setTimeout(() => fired.push(`t${index}`), value);
  const handle = setInterval(() => {
    clearInterval(handle);
    fired.push(`i${index}`);
  }, value);
});
setTimeout(() => {
  console.log(fired.length, fired.filter((name) => name.startsWith('t')).join(' '));
}, 30);
