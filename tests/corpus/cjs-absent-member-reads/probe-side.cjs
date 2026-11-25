'use strict';

// Required only in expression position: the first probe through
// require("./probe-side.cjs") evaluates this module, so its side effect
// lands before the reading statement's output.
console.log('probe module ran');
exports.always = 'yes';
if (false) exports.sometimes = 'set';
