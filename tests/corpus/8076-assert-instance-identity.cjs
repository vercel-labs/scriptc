'use strict';
// assert.strictEqual and notStrictEqual compare class instances by
// reference: two instances, an instance and the same instance read back
// through an untyped value, and an instance a method returns. Symbols
// compare by identity too.
const assert = require('assert');
const EventEmitter = require('events');

class Box {
  constructor(v) {
    this.v = v;
  }
  self() {
    return this;
  }
}

const b = new Box(1);
const c = new Box(1);
assert.strictEqual(b, b.self());
assert.notStrictEqual(b, c);
const e = new EventEmitter();
assert.strictEqual(e, e.setMaxListeners(1));
const untyped = [e, b][0];
assert.strictEqual(untyped, e);
assert.strictEqual(e, untyped);
assert.notStrictEqual(untyped, b);

try {
  assert.strictEqual(b, c);
} catch (error) {
  console.log(error.code);
  console.log(error.message);
}
try {
  assert.notStrictEqual(b, b.self(), 'same box');
} catch (error) {
  console.log(error.code, error.message);
}
// A symbol read back through an untyped value is the same symbol.
const symbol = Symbol('s');
const read = Reflect.get({ k: symbol }, 'k');
assert.strictEqual(read, symbol);
assert.notStrictEqual(read, Symbol('s'));
try {
  assert.strictEqual(read, Symbol('other'));
} catch (error) {
  console.log(error.code, error.message.split('\n')[0]);
}
console.log('done');
