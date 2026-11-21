// @normalize-pid
// The deprecated crypto.fips getter reports DEP0093 once per process on
// its first read and reflects the flag crypto.setFips leaves off (this
// build has no FIPS provider, so only falsy values are set here).
'use strict';
const crypto = require('node:crypto');

crypto.setFips(false);
console.log('getFips', crypto.getFips());
console.log('fips', crypto.fips, typeof crypto.fips);
console.log('fips again', crypto.fips);
crypto.setFips(false);
console.log('after clear', crypto.getFips(), crypto.fips);
