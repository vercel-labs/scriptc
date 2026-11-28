// A symbol-keyed permission installed with `Object.defineProperty` on a class
// and a different one on its subclass. A class-value receiver typed as the
// BASE (`/** @type {typeof Base} */`) still reads the class it actually
// holds, so the two classes answer their own permissions, not the base's.
'use strict';

const k = Symbol.for('perm');

class Base {}
class Sub extends Base {}

Object.defineProperty(Base, k, { value: 'base-perm', enumerable: true, configurable: true });
Object.defineProperty(Sub, k, { value: 'sub-perm', enumerable: true, configurable: true });

/** @type {typeof Base} */
let Perm = Base;
console.log('base:', Perm[k]);

Perm = Sub;
console.log('sub:', Perm[k]);

function read(ctor) {
  return ctor[k];
}
console.log('dynamic:', read(Base), read(Sub));
