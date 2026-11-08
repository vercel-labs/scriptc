// A class member that cannot be compiled is refused without rejecting its
// class. The class constructs and its other members compile; each
// statically typed use of the refused member is an error at the use, and
// the member's own diagnostic is reported once.

// a method whose signature has no mapping
class Store {
  count = 0;
  watch(ref: WeakRef<object>): number {
    return ref.deref() === undefined ? 0 : 1;
  }
  add(): number {
    return ++this.count;
  }
  self(): number {
    // through `this`
    return this.watch(undefined as never);
  }
}
class Shelf extends Store {
  viaSuper(): number {
    return super.watch(undefined as never);
  }
}
declare const ref: WeakRef<object>;
const store = new Store();
console.log(store.add());
console.log(store.watch(ref));
// read as a value
const detached = store.watch;
console.log(typeof detached);
// through a subclass that does not redeclare it, through `super`, and
// through `this` (each body lowers because its caller is reached)
console.log(new Shelf().watch(ref));
console.log(new Shelf().viaSuper());
console.log(store.self());

// an override whose signature the inherited slot cannot carry (fewer
// parameters and a body that reads `arguments`, which the slot's dropped
// arguments would be missing from)
class Printer {
  print(text: string, copies: number): string {
    return `${text} x${copies}`;
  }
}
class Plotter extends Printer {
  print(): string {
    return `plotter ${arguments.length}`;
  }
}
console.log(new Printer().print("a", 1));
console.log(new Plotter().print());

// a getter/setter pair with different types: the getter compiles, the
// setter is refused
class Cell {
  private raw = "1";
  get v(): string {
    return this.raw;
  }
  set v(x: string | number) {
    this.raw = String(x);
  }
}
const cell = new Cell();
console.log(cell.v);
cell.v = 3;
// a compound assignment reads the getter and writes the setter
const other = new Cell();
other.v += "!";

// an accessor whose type has no mapping
class Holder {
  n = 1;
  get held(): WeakRef<object> {
    throw new Error("never");
  }
}
const holder = new Holder();
console.log(holder.n, holder.held);

// a static method whose signature has no mapping, through its class and
// through a subclass
class Registry {
  static count = 0;
  static watch(target: WeakRef<object>): number {
    return target.deref() === undefined ? 0 : 1;
  }
}
class Local extends Registry {}
console.log(Registry.count, Registry.watch(ref));
console.log(Local.watch(ref));

// a generic member whose form is refused (a field holding a generic
// generator function expression): the class and its fields compile, each
// demand for an instance of the member reports it
class Feed {
  n = 1;
  each = function* <T>(x: T): Generator<T> {
    yield x;
  };
}
const feed = new Feed();
console.log(feed.n);
console.log([...feed.each("a")].length);
