// Parsed data keeps a JSDoc annotation's record storage: an annotated
// binding or field assigned a JSON.parse result holds the record the
// annotation describes, so writes through typed parameters reach the
// object, as in Node. A class annotation does not describe a plain object,
// so a parsed value there keeps its own identity.

/** @typedef {{ count: number, label: string }} Counter */

/** @param {Counter} c */
function bump(c) {
  c.count += 1;
  return c.count;
}

/** @type {Counter} */
let later;
later = JSON.parse('{"count":1,"label":"x"}');
console.log(bump(later), later.count, later.label);

class Holder {
  /** @type {Counter} */
  item;
  constructor() {
    this.item = JSON.parse('{"count":2,"label":"y"}');
  }
}
const holder = new Holder();
console.log(bump(holder.item), holder.item.count, holder.item.label);

class StaticHolder {
  /** @type {Counter} */
  static item = { count: 0, label: "z" };
}
StaticHolder.item = JSON.parse('{"count":4,"label":"w"}');
console.log(bump(StaticHolder.item), StaticHolder.item.count, StaticHolder.item.label);

// A class annotation does not describe a plain object, so a parsed value
// there keeps its own identity.
class Parser {
  constructor() {
    this.kind = 1;
  }
}
/** @type {Parser} */
const plain = JSON.parse('{"kind":7}');
console.log(plain instanceof Parser, plain.kind);
