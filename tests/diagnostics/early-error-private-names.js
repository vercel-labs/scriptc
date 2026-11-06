// AllPrivateNamesValid: a `#name` may only be read inside a class that
// declares it — a class heritage is evaluated in the outer private
// environment, so it cannot name the class's own private either. TypeScript
// reports the outside-class case as TS2339, which JavaScript sources relax,
// so the compiler keeps the spec's early error.
class Box {
  #value = 1;
  static from(value) {
    // @ts-expect-error -- the compiler's own early error fires first
    return value.#value;
  }
}
const box = new Box();
console.log(box.#value);
