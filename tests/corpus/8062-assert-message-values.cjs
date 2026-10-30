'use strict';
// node:assert messages that are not string literals: an untyped string, an
// Error to throw, null/undefined (omitted) and falsy values, and
// scalar-union operands against untyped values.
const assert = require('assert');

function attempt(label, fn) {
  try {
    fn();
    console.log(label, 'passed');
  } catch (e) {
    console.log(label, e.name, JSON.stringify(e.message), e.generatedMessage, e.code);
  }
}

const failures = [];
for (const x of ['a', 'b']) if (x === 'c') failures.push(`\n${x}`);
attempt('joined passes', () => assert.strictEqual(failures.length, 0, failures.join('')));
const untyped = JSON.parse('"untyped message"');
attempt('untyped', () => assert.strictEqual(1, 2, untyped));
attempt('untyped deep', () => assert.deepStrictEqual([1], [2], untyped));
attempt('untyped notStrict', () => assert.notStrictEqual(1, 1, untyped));
attempt('error message', () => assert.strictEqual(1, 2, new TypeError('own error')));
attempt('error deep', () => assert.deepStrictEqual({ a: 1 }, { a: 2 }, new RangeError('own range')));
const none = JSON.parse('null');
attempt('null message', () => assert.strictEqual(1, 2, none));
const zero = JSON.parse('0');
attempt('zero message deep', () => assert.deepStrictEqual([1], [2], zero));
attempt('passing error message', () => assert.strictEqual(1, 1, new Error('unused')));
attempt('later string message', () => assert.strictEqual(1, 2, 'plain'));

// Operand order: both operands evaluate before the message.
const order = [];
const mark = (label, value) => (order.push(label), value);
attempt('order', () => assert.strictEqual(mark('a', 1), mark('b', 2), mark('m', JSON.parse('"m"'))));
console.log(order.join(','));

const row = [['a', 'b', true], ['c', 'd', 'x']];
for (const [, , expected] of row) {
  attempt('union operand', () => assert.strictEqual(JSON.parse(JSON.stringify(expected)), expected));
}

// assert.fail with a message that is not a string: an Error is thrown as
// is; other values become the message, generated when falsy.
attempt('fail error', () => assert.fail(new RangeError('re')));
attempt('fail value', () => assert.fail(JSON.parse('{"a":1}')));
attempt('fail zero', () => assert.fail(zero));
attempt('fail null', () => assert.fail(JSON.parse('null')));
