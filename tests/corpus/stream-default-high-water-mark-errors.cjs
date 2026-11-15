// The JavaScript lane's setDefaultHighWaterMark ladder: Node's
// validateInteger(value, 'value', 0) answers ERR_INVALID_ARG_TYPE for a
// non-number and ERR_OUT_OF_RANGE for a non-integer or negative one, with its
// exact text; objectMode is read by truthiness, and a missing argument is
// undefined (falsy for the mode, the type error for the value). The typed
// program tests the statically-spellable forms.
'use strict';
const { Readable, getDefaultHighWaterMark, setDefaultHighWaterMark } = require('stream');

function show(label, f) {
  try {
    f();
    console.log(label, 'ok');
  } catch (e) {
    console.log(label, '->', e.name, e.code, JSON.stringify(e.message));
  }
}

console.log('initial', getDefaultHighWaterMark(false), getDefaultHighWaterMark(true));

show('string', () => setDefaultHighWaterMark(false, '10'));
show('missing value', () => setDefaultHighWaterMark(false));
show('null', () => setDefaultHighWaterMark(false, null));
show('boolean', () => setDefaultHighWaterMark(false, true));
show('object', () => setDefaultHighWaterMark(false, {}));
show('fraction', () => setDefaultHighWaterMark(false, 1.5));
show('negative', () => setDefaultHighWaterMark(false, -1));
show('nan', () => setDefaultHighWaterMark(true, NaN));
console.log('after failures', getDefaultHighWaterMark(false), getDefaultHighWaterMark(true));

// objectMode is read by truthiness, like Node's `if (objectMode)`.
console.log('truthy mode', getDefaultHighWaterMark(1), getDefaultHighWaterMark(''), getDefaultHighWaterMark());
setDefaultHighWaterMark(1, 9);
console.log('truthy set', getDefaultHighWaterMark(true), getDefaultHighWaterMark(false));
const afterSet = new Readable({ read() {} });
console.log('stream takes it', afterSet.readableHighWaterMark);
setDefaultHighWaterMark(true, 16);
setDefaultHighWaterMark(false, 65536);

// The value is validated before the mode is used, so the errors above
// leave both defaults where they were.
console.log('restored', getDefaultHighWaterMark(false), getDefaultHighWaterMark(true));
