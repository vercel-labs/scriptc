// A class field typed by a type parameter compiles when the instantiation
// binds the parameter to `unknown` or `object` (corpus
// generic-class-fields-unknown.ts). An `any` argument stays refused: the
// instantiation reports the type it cannot compile, whether or not an
// `unknown` instantiation of the same class comes first.
class Box<T> {
  value: T;
  constructor(v: T) {
    this.value = v;
  }
}
const known = new Box<unknown>("u");
const loose = new Box<any>(1);
console.log(known.value, loose.value);
export const marker: number = 1;
