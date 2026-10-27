// Classes extending the result of a generic class factory, and the
// factory's class values and instances: each instantiation of the factory
// has its own class, as each call does in Node.
function base<T>(initial: T) {
  return class {
    value: T = initial;
    read(): T {
      return this.value;
    }
    describe(): string {
      return `value=${String(this.value)}`;
    }
  };
}

class Counter extends base(42) {
  bump(): number {
    this.value += 1;
    return this.value;
  }
}
const counter = new Counter();
console.log(counter.value, counter.bump(), counter.read(), counter.describe());

class Label extends base("hello") {
  shout(): string {
    return this.read().toUpperCase();
  }
  describe(): string {
    return `label ${super.describe()}`;
  }
}
const label = new Label();
console.log(label.shout(), label.describe(), label.value.length);

const NumberBox = base<number>(7);
const box = new NumberBox();
console.log(box.read() * 2, box instanceof NumberBox, counter instanceof NumberBox);
console.log(base(1) === base(1), typeof NumberBox);
console.log(Counter.name, Label.name, counter instanceof Counter);

function pair<A, B>(first: A, second: B) {
  return class {
    first: A = first;
    second: B = second;
    swap(): [B, A] {
      return [this.second, this.first];
    }
  };
}
class Entry extends pair("id", 3) {
  label: string;
  constructor(label: string) {
    super();
    this.label = label;
  }
  render(): string {
    const [n, s] = this.swap();
    return `${this.label}:${s}:${n * 10}`;
  }
}
console.log(new Entry("row").render(), new Entry("col").first);

interface Shape {
  name: string;
  size: number;
}
function model<S>(defaults: S) {
  return class {
    data: S;
    constructor(data?: S) {
      this.data = data ?? defaults;
    }
    get(): S {
      return this.data;
    }
  };
}
class ShapeModel extends model<Shape>({ name: "square", size: 2 }) {
  area(): number {
    return this.data.size * this.data.size;
  }
}
const square = new ShapeModel();
const big = new ShapeModel({ name: "big", size: 5 });
console.log(square.get().name, square.area(), big.get().name, big.area());

function tagged<T>(tag: string, payload: T) {
  class Tagged {
    tag = tag;
    payload = payload;
    toString(): string {
      return `${this.tag}(${String(this.payload)})`;
    }
  }
  return new Tagged();
}
const first = tagged("a", 1);
const second = tagged("b", true);
console.log(first.toString(), second.toString(), first.payload + 1, second.payload === true);

const arrowFactory = <T,>(initial: T) =>
  class {
    item: T = initial;
  };
class FromArrow extends arrowFactory("arrow") {}
function wrap<U>(value: U): U {
  const Made = base(value);
  return new Made().read();
}
console.log(new FromArrow().item, wrap("w"), wrap(9), wrap([1, 2]));
