'use strict';
// assert methods are function values: stored, passed and called through
// aliases, they assert as the methods do, and every read is the same
// function. A constant bound to a method and called directly reports
// the call as Node quotes it.
const assert = require('assert');
const { strictEqual, deepStrictEqual } = require('assert');
const strict = require('assert/strict');
const EventEmitter = require('events');
console.log(typeof assert.fail, assert.fail === assert.fail, strict.equal === assert.strictEqual, strictEqual === assert.strictEqual);
const ok = assert.ok;
ok(1);
const tryIt = (label, fn) => { try { fn(); console.log(label, 'passed'); } catch (e) { console.log(label, e.name, e.code, JSON.stringify(e.message), e.generatedMessage); } };
tryIt('ok', () => ok(0));
tryIt('ok none', () => ok());
tryIt('ok msg', () => ok(false, 'nope'));
tryIt('ok err', () => ok(false, new TypeError('own')));
tryIt('fail', () => assert.fail.call(null));
tryIt('fail msg', () => (0, assert.fail)('boom'));
tryIt('equal', () => assert.equal.call(null, 1, '1'));
tryIt('equal fail', () => [assert.equal][0](1, 2));
tryIt('notEqual fail', () => [assert.notEqual][0](1, '1'));
tryIt('strict', () => strictEqual(1, 2));
tryIt('deep', () => deepStrictEqual({ a: 1 }, { a: 1 }));
tryIt('deep fail', () => [deepStrictEqual][0]({ a: 1 }, { a: 2 }, 'differs'));
tryIt('ifError', () => [assert.ifError][0](null));
const checks = [assert.ok, assert.fail, assert.strictEqual];
checks.forEach((check, i) => console.log(i, typeof check, check === checks[i], check.name));
[1, 'x', true].forEach((value) => assert.ok(value));
console.log('done');
