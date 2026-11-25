// A class's accessor replaced through Object.defineProperty is read through
// the shared prototype view so every instance sees the replacement. Building
// that view lowers the class's members, and a subclass member's typed read of
// the same accessor asks for the very view being built: it must reach the one
// helper, whose run-time class test still answers the subclass's own getter.
class Base {
  get size(): number {
    return 1;
  }
}

class Derived extends Base {
  get size(): number {
    return 2;
  }
  peek(other: Base): number {
    return other.size;
  }
}

Object.defineProperty(Base.prototype, "size", {
  get() {
    return 7;
  },
  configurable: true,
});

const base = new Base();
const derived = new Derived();
console.log(base.size, derived.size, derived.peek(base), derived.peek(derived));
