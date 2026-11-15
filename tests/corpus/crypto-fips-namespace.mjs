// The ES module namespace of node:crypto has exactly the exports object's
// enumerable names, so the deprecated fips getter is not one of them: the
// namespace read is undefined and the name is not enumerable.
import * as crypto from 'node:crypto';

console.log('namespace fips', crypto.fips);
console.log('namespace keys', Object.keys(crypto).includes('fips'));
console.log('namespace getFips', crypto.getFips());
