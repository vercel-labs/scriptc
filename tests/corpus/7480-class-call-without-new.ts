// Function.prototype.call and apply invoke a class constructor without
// `new`, which throws a TypeError naming the class after the arguments are
// evaluated. A declared static `call` answers instead.
class Base {
  n = 1;
}
class Derived extends Base {}
class Pair {
  left: string;
  right: string;
  constructor(left: string, right: string) {
    this.left = left;
    this.right = right;
  }
}
class WithCall {
  static call(value: number): number {
    return value + 1;
  }
}

function report(label: string, run: () => unknown): void {
  try {
    run();
    console.log(label, "returned");
  } catch (error) {
    console.log(label, error instanceof TypeError, (error as Error).message);
  }
}

const receiver = new Base();
report("call", () => Base.call(receiver));
report("apply", () => Base.apply(receiver, []));
report("derived", () => Derived.call(new Derived()));
report("arguments", () => Pair.call(new Pair("a", "b"), "c", "d"));

const order: string[] = [];
function effect<T>(label: string, value: T): T {
  order.push(label);
  return value;
}
report("ordered", () => Pair.call(effect("this", new Pair("a", "b")), effect("left", "x"), effect("right", "y")));
console.log(order.join(","));

function local(): void {
  class Inner {
    x = 2;
  }
  report("local", () => Inner.call(new Inner()));
}
local();

class Statics {
  static run(): void {
    report("static this", () => this.call(new Statics()));
  }
}
Statics.run();

console.log(WithCall.call(4));
