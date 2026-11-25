// Object.prototype methods called by name on a record type whose values
// can be converted from objects with their own method of that name: Node
// runs the object's method, which the record's type does not declare.
type Plain = { a: number };

const wide = {
  a: 1,
  valueOf() {
    return 42;
  },
  isPrototypeOf(_value: unknown) {
    return true;
  },
};
const plain: Plain = wide;
console.log(plain.valueOf() === plain, plain.isPrototypeOf({}));
