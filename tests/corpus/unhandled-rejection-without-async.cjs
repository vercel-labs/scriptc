// @exit: 1
'use strict';
// A program with no async functions or timers still ends Node's way when a
// promise rejection goes unhandled: after the script, the 'exit' listeners
// see code 1 and the process exits 1. Settled promises alone do not fail.
process.on('exit', (code) => console.log('exit listener', code));
const settled = Promise.resolve(1);
new Promise((resolve) => resolve(2));
console.log('end of script', typeof settled);
new Promise((resolve, reject) => reject(new TypeError('rejected in the executor')));
