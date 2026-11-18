// @ts-nocheck
// In a JavaScript file TypeScript does not check, a JSDoc `@returns` names
// the result of the declaration it documents and nothing else: a function
// later in the file that builds a class instance keeps its static result
// slot (`rebuilt` answers a Color, not a checked-dynamic value). A result
// that is one of the function's own checked-dynamic parameters survives a
// constant copy, a property read and a conditional, so a plain object the
// caller passes comes back as that object, as in Node.

class Color {
  constructor(value = 0) {
    this.value = value;
    this.self = this;
  }
}

const swatch = new Color(1);
const plain = { value: 5, self: null };
plain.self = plain;

/** @returns {Color} */
function documented() {
  return swatch;
}

/** @param {Color} target */
function rebuilt(target) {
  return new Color(target.value);
}

/** @param {Color} target */
function copied(target) {
  const copy = target;
  return copy;
}

/** @param {Color} target */
function picked(target) {
  return target ? target : null;
}

/** @param {Color} target */
function selfOf(target) {
  return target.self;
}

console.log("documented", documented().value, rebuilt(swatch).value, rebuilt(plain).value);
console.log("copied", copied(swatch).value, copied(plain) === plain);
console.log("picked", picked(swatch).value, picked(plain) === plain);
console.log("self", selfOf(swatch).value, selfOf(plain) === plain);
