// @normalize-pid
// The deprecated crypto.fips getter reads the flag crypto.setFips stores
// and reports DEP0093 once per process on its first read.
'use strict';
const crypto = require('node:crypto');

crypto.setFips(true);
console.log('getFips', crypto.getFips());
console.log('fips', crypto.fips, typeof crypto.fips);
console.log('fips again', crypto.fips);
crypto.setFips(false);
console.log('after clear', crypto.getFips(), crypto.fips);
