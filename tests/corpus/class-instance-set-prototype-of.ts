// Object.setPrototypeOf on instances of TypeScript classes: calls, reads,
// `in` and instanceof through a typed receiver follow the prototype the
// instance was given, as in Node; instances that keep their class's
// prototype keep its methods.

class Shape {
  name: string;
  constructor(name: string) {
    this.name = name;
  }
  area(): number {
    return 0;
  }
  describe(): string {
    return "shape " + this.name;
  }
  get label(): string {
    return "<" + this.name + ">";
  }
  sum(...values: number[]): number {
    return values.reduce((total, value) => total + value, this.name.length);
  }
}
class Square extends Shape {
  side = 2;
  area(): number {
    return this.side * this.side;
  }
}
class Circle extends Shape {
  area(): number {
    return 3;
  }
  describe(): string {
    return "circle " + this.name;
  }
}

const plain = {
  describe(this: { name: string }): string {
    return "plain " + this.name;
  },
};

const moved = new Square("moved");
const kept = new Square("kept");
Object.setPrototypeOf(moved, plain);
console.log(moved.describe(), kept.describe(), kept.area(), moved.name, moved.side);
console.log(typeof moved.area, "area" in moved, "describe" in moved, "label" in moved, kept.label);
console.log(moved instanceof Square, moved instanceof Shape, kept instanceof Square);
try {
  moved.area();
} catch (error) {
  console.log("not a function:", error instanceof TypeError);
}

// The key of `in` is evaluated before the receiver: a key that rebinds the
// receiver asks the new one.
let target: Square = kept;
const pick = (): string => {
  target = moved;
  return "area";
};
console.log(pick() in target, "area" in target);

// A spread argument, on an instance with its class's prototype and on one
// whose prototype has no such method.
const numbers = [1, 2, 3];
console.log(kept.sum(...numbers));
try {
  moved.sum(...numbers);
} catch (error) {
  console.log("spread call:", error instanceof TypeError);
}

// Through a union of classes, and back to its own class's prototype.
const shapes: (Square | Circle)[] = [new Square("a"), new Circle("b"), moved];
console.log(shapes.map((shape) => `${shape instanceof Circle}:${shape instanceof Shape}`).join(" "));
Object.setPrototypeOf(moved, Object.getPrototypeOf(kept));
console.log(moved.describe(), moved.area(), moved instanceof Circle, moved instanceof Square);
console.log(moved.sum(...numbers), moved.sum(4, ...numbers, 5));

// A null prototype.
const bare = new Circle("bare");
Object.setPrototypeOf(bare, null);
console.log(Object.getPrototypeOf(bare), bare instanceof Shape, "describe" in bare, bare.name);
