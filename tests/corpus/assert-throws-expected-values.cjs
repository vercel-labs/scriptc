'use strict';
// assert.throws with the expected error description held in a value, the
// way Node's test files share them (const OOR_ERROR = { name: ... }): the
// expected's own enumerable keys are read from the thrown error through its
// prototype chain, a RegExp value tests a string property, and an Error
// instance also compares name and message.
const assert = require('assert');

const buf = Buffer.alloc(4);
const read = () => buf.readUInt8(10);

const OOR = { name: 'RangeError' };
assert.throws(read, OOR);
console.log('name matched');

const CODED = { code: 'ERR_OUT_OF_RANGE', name: 'RangeError' };
assert.throws(read, CODED);
console.log('code and name matched');

const PATTERN = { code: 'ERR_OUT_OF_RANGE', message: /^The value of "offset" is out of range/ };
assert.throws(read, PATTERN);
console.log('pattern matched');

const INSTANCE = new RangeError(
  'The value of "offset" is out of range. It must be >= 0 and <= 3. Received 10',
);
assert.throws(read, INSTANCE);
console.log('instance matched');

const WRONG_NAME = { name: 'TypeError' };
try {
  assert.throws(read, WRONG_NAME);
  console.log('wrong name matched');
} catch (e) {
  console.log('wrong name', e.name, e.code);
}

const WRONG_PATTERN = { message: /^Something else/ };
try {
  assert.throws(read, WRONG_PATTERN);
  console.log('wrong pattern matched');
} catch (e) {
  console.log('wrong pattern', e.name, e.code);
}

const WRONG_INSTANCE = new RangeError('another message');
try {
  assert.throws(read, WRONG_INSTANCE);
  console.log('wrong instance matched');
} catch (e) {
  console.log('wrong instance', e.name, e.code);
}
