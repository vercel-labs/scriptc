'use strict';
exports.ready = true;
console.log('early module start', typeof helper);
if (exports.ready) return;
console.log('early module end');
function helper() {}
