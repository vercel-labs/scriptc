// Nested destructuring of a builtin require (undici's `const { types: {
// isPromise } } = require('util')`): util.types IS the util/types module,
// so the nested pattern binds that module's members.
'use strict';

const {
  types: { isPromise, isPromise: promiseCheck },
  format,
} = require('util');
const { promises: { readFile } } = require('fs');
const { posix: { join } } = require('path');

console.log(isPromise(Promise.resolve(1)), isPromise({}), promiseCheck(Promise.reject(new Error('x')).catch(() => {})));
console.log(format('%s=%d', 'a', 1), join('a', 'b', '..', 'c'));
readFile(__filename, 'utf8').then((text) => console.log('read', text.includes('isPromise')));
