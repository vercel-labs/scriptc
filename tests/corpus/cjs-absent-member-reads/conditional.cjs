'use strict';

// The branch never runs at this argv length, so `sometimes` stays absent
// from the exports object while the checker still types it a number.
exports.always = 'yes';
if (process.argv.length > 1000) exports.sometimes = 1;
