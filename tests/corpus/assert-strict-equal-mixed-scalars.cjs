'use strict';
// assert.strictEqual and notStrictEqual over scalars of different static
// types: a bigint read from a Buffer through a computed method name, a
// JSON.stringify result (string | undefined) against a string, and an
// optional number against strings and numbers. Both sides cross by value,
// so the comparison is SameValue, with Node's failure messages.
const assert = require('assert');

const buf = Buffer.alloc(8);
buf[`writeBigInt64${'LE'}`](5n, 0);
assert.strictEqual(buf[`readBigInt64${'LE'}`](0), 5n);
console.log('bigint matched');
try {
  assert.strictEqual(buf[`readBigInt64${'LE'}`](0), 6n);
} catch (e) {
  console.log(e.message);
}

const json = JSON.stringify(Buffer.from([1]));
assert.strictEqual(json, '{"type":"Buffer","data":[1]}');
console.log('string matched');
try {
  assert.strictEqual(json, 'x');
} catch (e) {
  console.log(e.message);
}

const maybe = process.argv.length > 10 ? 1 : undefined;
assert.notStrictEqual(maybe, 0);
assert.strictEqual(maybe, undefined);
try {
  assert.strictEqual(maybe, 'undefined');
} catch (e) {
  console.log(e.message);
}
try {
  assert.notStrictEqual(maybe, undefined);
} catch (e) {
  console.log(e.message);
}
