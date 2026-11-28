// A symbol-keyed STATIC method that reads its class through `this`. The
// call `C[k]()` is a static call: `this` is the class, here and through a
// subclass that inherits the method. The value on its own is the method, so
// a detached call loses `this`, exactly as Node does.
'use strict';

const k = Symbol.for('receiver.k');
const other = Symbol.for('receiver.other');

class A {
  static value = 42;
  static [k]() {
    return this.value;
  }
  static [other](suffix) {
    return `${this.value}${suffix}`;
  }
}

class B extends A {}

console.log('calls:', A[k](), B[k](), A[other]('!'), B[other]('?'));

const detached = A[k];
try {
  detached();
  console.log('detached: no throw');
} catch (error) {
  console.log('detached:', error.constructor.name);
}
