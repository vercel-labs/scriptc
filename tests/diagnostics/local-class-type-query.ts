// A whole-program analysis queries the element type of `items` before any
// body lowers. The function-local class it names is refused: the refusal is
// reported once, at the class (it used to crash the compiler with an uncaught
// PoisonError).
function make() {
  class Box {
    static count = 0;
    v = 1;
  }
  return new Box();
}
const items = [make()];
const first = items[0];
console.log(first ? first.v : 0);
