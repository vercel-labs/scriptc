// The same speculative element-type query, reaching a function-local class
// with a private brand through the function's returned array. The brand is
// tested on another object, so the evaluations' private names must differ.
function make() {
  class Box {
    #v = 1;
    read(): number {
      return this.#v;
    }
    same(other: object): boolean {
      return #v in other;
    }
  }
  return [new Box()];
}
const xs = make();
const x = xs[0];
console.log(x === undefined ? -1 : x.read());
