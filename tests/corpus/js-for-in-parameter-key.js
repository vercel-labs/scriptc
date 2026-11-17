// A JSDoc-typed parameter becomes a for-in head's binding. Node writes the
// key string into it whatever the annotation says, and the function answers
// that string.

/** @param {number} key */
function walk(key) {
  for (key in { a: 1, b: 2 }) console.log("walk", typeof key, key);
  var out = key;
  return out;
}

class Walker {
  /** @param {number} key */
  constructor(key) {
    for (key in { c: 3 }) console.log("ctor", typeof key, key);
    this.key = key;
  }
  /** @param {number} key */
  reset(key) {
    for (key in { d: 4, e: 5 }) console.log("method", typeof key, key);
    return key;
  }
}

const literal = {
  /** @param {number} key */
  key(key) {
    for (key in { f: 6 }) console.log("literal", typeof key, key);
    return key;
  },
};

/** @param {number} key */
var expression = function (key) {
  for (key in { g: 7 }) console.log("expression", typeof key, key);
  return key;
};

/** @type {(key: number) => any} */
var arrow = (key) => {
  for (key in { h: 8 }) console.log("arrow", typeof key, key);
  return key;
};

console.log("walk returned", walk(1));
const walker = new Walker(2);
console.log("ctor stored", typeof walker.key, walker.key);
console.log("method returned", walker.reset(3));
console.log("literal returned", literal.key(4));
console.log("expression returned", expression(5));
console.log("arrow returned", arrow(6));
