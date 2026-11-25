// A function-local class constructs through its own environment, which has
// no result slot: extending a class whose constructor can return an
// existing instance is refused there, by name.
let pending: Base | null = null;
class Base {
  a = 1;
  constructor() {
    if (pending !== null) {
      const p = pending;
      pending = null;
      return p;
    }
  }
}
function make(): number {
  class Local extends Base {
    b = 2;
  }
  return new Local().b;
}
console.log(make());
