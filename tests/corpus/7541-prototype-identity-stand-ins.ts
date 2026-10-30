// Instances held as unknown, of a class whose chain has no prototype data
// (a subclass without methods, or one extending Error), still share one
// prototype: comparing the prototypes of two instances of the same class is
// true, and of instances of different classes is false.
class Base {
  tag = "b";
}
class Sub extends Base {}
class Other extends Base {}
class Oops extends Error {}
const bases: Base[] = [new Sub(), new Sub(), new Other()];
const errors: Error[] = [new Oops("a"), new Oops("b")];
const first: unknown = bases[0];
const second: unknown = bases[1];
const other: unknown = bases[2];
const e1: unknown = errors[0];
const e2: unknown = errors[1];
console.log(Object.getPrototypeOf(first) === Object.getPrototypeOf(second));
console.log(Object.getPrototypeOf(first) === Object.getPrototypeOf(other));
console.log(Object.getPrototypeOf(e1) === Object.getPrototypeOf(e2));
console.log(Object.getPrototypeOf(first) === Object.getPrototypeOf(e1));
console.log(first instanceof Sub, other instanceof Sub, e1 instanceof Oops, e1 instanceof Error);
