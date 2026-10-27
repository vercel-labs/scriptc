// CommonJS modules that export first and require afterwards: code that can
// reach the bindings only runs after the module finished, so they compile
// without a fence and behave exactly as under Node.
'use strict';

console.log('main: start');
const Comparator = require('./comparator.js');
const glob = require('./glob.js');
const { Provider, REASON } = require('./bundle.js');

const c = new Comparator(' a.txt ', { loose: true });
console.log(c.mode, c.text, c.test('/x/a.txt'), Comparator.ANY.toString());
console.log(new Comparator('b').mode, Comparator.describe());
console.log(glob('a//b'), glob.sync('c//d'));
console.log(new Provider('custom').describe(), REASON);
