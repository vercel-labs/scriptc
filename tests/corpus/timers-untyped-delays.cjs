// @normalize-pid
'use strict';
// setTimeout and setInterval convert an untyped delay with ToNumber, as
// Node's `after *= 1` does: undefined, null, booleans, strings, arrays and
// objects all become a 1ms delay, with Node's warnings for the NaN,
// negative and overflowing ones (test-timers.js).
const inputs = [undefined, null, true, false, '', '7', [], [3], {}, NaN, Infinity, -Infinity, -0, 0.5, 2147483648];
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
