// Overrides declared by function-local subclasses dispatch on the receiver
// when the call site lowers before the function that declares them.
class Shape {
  area(): number { return 0; }
  get label(): string { return "shape"; }
  describe(): string { return this.label + ":" + this.area(); }
}

function square(side: number): Shape {
  class Square extends Shape {
    area(): number { return side * side; }
    get label(): string { return "square"; }
  }
  return new Square();
}

function scaled(factor: number): Shape {
  class Scaled extends Shape {
    area(): number { return factor; }
  }
  class Doubled extends Scaled {
    area(): number { return super.area() * 2; }
  }
  return new Doubled();
}

const shapes: Shape[] = [new Shape(), square(3), scaled(5)];
for (const shape of shapes) console.log(shape.area(), shape.label, shape.describe());

function pair() {
  class Base {
    name(): string { return "base"; }
  }
  class Derived extends Base {
    name(): string { return "derived"; }
  }
  return [new Base(), new Derived()];
}
const [first, second] = pair();
console.log(first.name(), second.name());

function counter() {
  const Tally = class {
    count(): number { return 1; }
  };
  const Double = class extends Tally {
    count(): number { return 2; }
  };
  return new Double();
}
console.log(counter().count());
