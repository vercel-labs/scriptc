// Instances held as unknown, of classes whose chains have no prototype data
// a program can name (no methods, or a subclass of Error): each class's
// instances share one prototype, and different classes' differ, as in Node.
class Base {
  tag = "b";
}
class Sub extends Base {}
class Other extends Base {}
class Oops extends Error {}
const bases: Base[] = [new Sub(), new Sub(), new Other(), new Base()];
const errors: Error[] = [new Oops("a"), new Oops("b")];
const [a, b, c, d] = bases.map((value): unknown => value);
const e1: unknown = errors[0];
const e2: unknown = errors[1];
console.log(Object.getPrototypeOf(a) === Object.getPrototypeOf(b));
console.log(Object.getPrototypeOf(a) === Object.getPrototypeOf(c));
console.log(Object.getPrototypeOf(a) === Object.getPrototypeOf(d));
console.log(Object.getPrototypeOf(e1) === Object.getPrototypeOf(e2));
console.log(Object.getPrototypeOf(a) === Object.getPrototypeOf(e1));
