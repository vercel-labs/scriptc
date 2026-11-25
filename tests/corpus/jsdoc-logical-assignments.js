// Logical assignments write the values a program gives a JSDoc-typed
// binding or field, as Node does: `||=`, `&&=` and `??=` keep the stored
// value's identity and class through reads, `instanceof` and `===`.

class Base {
  constructor() {
    this.kind = 0;
  }
}
class Other {
  constructor() {
    this.other = 1;
  }
}

const other = new Other();

/** @type {Base | undefined} */
let or;
or ||= other;
console.log(or === other, or instanceof Other, or instanceof Base);

/** @type {Base | undefined} */
let nullish;
nullish ??= other;
console.log(nullish === other, nullish instanceof Other);

/** @type {Base | undefined} */
let and = new Base();
and &&= other;
console.log(and === other, and instanceof Other, and instanceof Base);

class Holder {
  /** @type {Base | undefined} */
  item;
}
const holder = new Holder();
holder.item ||= other;
console.log(holder.item === other, holder.item instanceof Other);
holder.item ??= new Base();
console.log(holder.item === other);
holder.item &&= new Base();
console.log(holder.item instanceof Base, holder.item instanceof Other);
