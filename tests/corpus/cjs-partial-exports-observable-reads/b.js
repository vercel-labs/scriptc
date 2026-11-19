'use strict';

const a = require('./a.js');
// A partial cycle's live exports are read for their value in `typeof`, a
// comparison, and a condition. Node sees the members as they stand, so the
// absent one is undefined and the settled one is its value.
const live = typeof a.late === 'undefined' && a.ready === true;
if (live) console.log('b sees live exports');
else console.log('b sees', typeof a.late, a.ready);
exports.ok = live ? 'yes' : 'no';
