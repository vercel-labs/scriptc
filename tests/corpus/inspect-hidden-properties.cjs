'use strict';
// Under showHidden, own non-enumerable keys print in brackets and symbol
// keys print after the string keys: records, and arrays after their
// [length] entry.
const util = require('util');

const record = JSON.parse('{"a":1}');
Object.defineProperty(record, 'hidden', { value: 2, enumerable: false });
Object.defineProperty(record, Symbol('s'), { value: 3, enumerable: true });
Object.defineProperty(record, Symbol('hs'), { value: 4, enumerable: false });
console.log(util.inspect(record, { showHidden: true }));
console.log(util.inspect(record));

const list = JSON.parse('[1,2]');
Object.defineProperty(list, 'note', { value: 'n', enumerable: false });
Object.defineProperty(list, Symbol('tag'), { value: 't', enumerable: true });
Object.defineProperty(list, Symbol('htag'), { value: 'u', enumerable: false });
console.log(util.inspect(list, { showHidden: true }));
console.log(util.inspect(list));
