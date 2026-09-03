// A CommonJS require reaches an ESM graph. Node links that graph at the
// require site and rejects a plain import of a type-only export there.
'use strict';

console.log('before require');
require('./child.mts');
console.log('after require');
