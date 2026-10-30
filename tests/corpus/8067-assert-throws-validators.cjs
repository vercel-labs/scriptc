'use strict';
// assert.throws and assert.rejects with validation functions, constructor
// functions, and untyped expected values (Node's expectedException).
const assert = require('assert');
function show(label, fn) {
  try { fn(); console.log(label, 'passed'); } catch (e) { console.log(label, e.name, JSON.stringify(e.message), e.generatedMessage, e.operator, e.actual && e.actual.message); }
}
function check(err) { return err.message === 'x'; }
show('named false', () => assert.throws(() => { throw new Error('y'); }, check));
show('named true', () => assert.throws(() => { throw new Error('x'); }, check));
show('custom message', () => assert.throws(() => { throw new Error('y'); }, check, 'custom'));
show('returns 1', () => assert.throws(() => { throw new Error('y'); }, () => 1));
show('non-error thrown', () => assert.throws(() => { throw 'str'; }, (v) => v === 'str'));
show('non-error fails', () => assert.throws(() => { throw 42; }, () => undefined));
function MyErr(m) { this.message = m; }
show('constructor', () => assert.throws(() => { throw new MyErr('q'); }, MyErr));
function untyped(expected) { assert.throws(() => { throw new Error('u'); }, expected); }
show('untyped validator', () => untyped((e) => e.message === 'u'));
show('untyped validator fails', () => untyped(function v() { return false; }));
show('untyped object', () => untyped({ message: 'u' }));
assert.rejects(Promise.reject(new Error('r')), (e) => e.message === 'r').then(() => console.log('rejects passed'));
assert.rejects(Promise.reject(new Error('r')), () => false).catch((e) => console.log('rejects', JSON.stringify(e.message), e.operator));
