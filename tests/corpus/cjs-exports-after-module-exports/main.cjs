'use strict';

const fn = require('./function-module.cjs');
console.log(typeof fn, fn.version, fn.hello, fn.default === fn);
console.log(fn({ a: 1 }).config.a);

const table = require('./table-module.cjs');
console.log(table.kept, table.dropped, Object.keys(table).join(','));
