// A const require binding read by a statement above the require that
// lowers to no expression: publishing the binding as an export is module
// plumbing, so no initialization check can run where Node throws
// "Cannot access 'greet' before initialization". The read keeps SC1013.
'use strict';

module.exports = { greet };
const { greet } = require('./lib.js');
