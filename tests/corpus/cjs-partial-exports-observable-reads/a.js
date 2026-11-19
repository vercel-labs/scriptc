'use strict';

exports.ready = true;
const b = require('./b.js');
exports.late = 'late';
console.log('a sees', b.ok);
