// A JavaScript class whose instances track which fields they have (one
// field is created by a method) and carry a symbol-keyed field. Freezing
// or sealing such an instance makes its symbol entry read-only; later
// reflection rebuilds the instance's view and takes the field's value.
const tag = Symbol("tag");
class Box {
  constructor(v) {
    this.v = v;
    this[tag] = v;
  }
  later() {
    this.w = 3;
  }
}

const frozen = new Box(1);
frozen.extra = 2;
Object.freeze(frozen);
console.log(Object.isFrozen(frozen));
console.log(Object.isFrozen(frozen), Object.isSealed(frozen), Object.isExtensible(frozen));
console.log(frozen[tag], frozen.v, frozen.extra, frozen.w);
console.log(JSON.stringify(Object.getOwnPropertyDescriptor(frozen, tag)));

const sealed = new Box(2);
sealed.later();
Object.seal(sealed);
console.log(Object.isSealed(sealed), Object.isFrozen(sealed), sealed[tag], sealed.w);
console.log(JSON.stringify(Object.getOwnPropertyDescriptor(sealed, tag)));

const closed = new Box(4);
Object.preventExtensions(closed);
console.log(Object.isExtensible(closed), Object.isSealed(closed), closed[tag]);
