// Distinct symbols from two CommonJS key tables that share one description:
// each keeps its own slot, and inspect prints both under Node's spelling.
'use strict';

const { inspect } = require('node:util');
const MockClient = require('./mock-client');

const m = new MockClient('http://a');
console.log(m.shutdown());
console.log(m.shutdown());
console.log(inspect(m));
