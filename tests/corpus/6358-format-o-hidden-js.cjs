'use strict';
// %o shows an object's non-enumerable own properties as `[key]`, symbol
// keys included.
const util = require('util');
const hidden = Object.defineProperty(JSON.parse('{"shown":1}'), 'secret', { value: [2], enumerable: false });
Object.defineProperty(hidden, 'a-b', { value: 'x', enumerable: false });
Object.defineProperty(hidden, Symbol('tag'), { value: 3, enumerable: false });
console.log(util.format('%o and %O', hidden, hidden));
console.log(util.format('%o', [hidden]));
