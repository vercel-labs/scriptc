// @normalize-pid
// crypto.fips is the deprecated getFips() behind a once-per-process DEP0093
// report: the CommonJS exports object owns it as a getter that answers the
// number 0, and the ES module namespace does not export it at all.
'use strict';
const crypto = require('node:crypto');

console.log('fips', crypto.fips, typeof crypto.fips);
console.log('fips again', crypto.fips);
const { fips } = crypto;
console.log('fips destructured', fips, typeof fips);
console.log('getFips', crypto.getFips());
