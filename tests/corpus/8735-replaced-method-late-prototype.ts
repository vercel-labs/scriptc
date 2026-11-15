// A method replaced on a prototype that no code had asked for until calls
// had already run: instances created before and after see the replacement,
// a subclass sees its base's, and restoring the value restores the method.
class Shape {
  readonly side: number;
  constructor(side: number) {
    this.side = side;
  }
  area(): number {
    return this.side * this.side;
  }
  describe(): string {
    return `shape ${this.area()}`;
  }
}

class Box extends Shape {
  override describe(): string {
    return `box ${this.area()}`;
  }
}

class Other {
  area(): number {
    return -1;
  }
}

function put(target: any, key: string, value: unknown): void {
  target[key] = value;
}

function read(target: any, key: string): unknown {
  return target[key];
}

function drop(target: any, key: string): void {
  delete target[key];
}

const shape = new Shape(2);
const box = new Box(3);
const other = new Other();
const shapes: Shape[] = [shape, box];

let sum = 0;
for (let i = 0; i < 1000; i++) sum += shape.area() + box.area() + other.area();
console.log(sum, shapes.map((s) => s.describe()).join(" | "));

// The base's prototype, reached from an instance of the subclass.
const boxPrototype: unknown = Object.getPrototypeOf(box);
const shapePrototype: unknown = Object.getPrototypeOf(boxPrototype);
console.log(shapePrototype === Object.getPrototypeOf(shape), boxPrototype === shapePrototype);
const original = read(shapePrototype, "area");
put(shapePrototype, "area", function (this: Shape): number {
  return this.side * 10;
});
console.log(shape.area(), box.area(), other.area(), new Shape(4).area(), new Box(5).area());
console.log(shapes.map((s) => s.describe()).join(" | "));

// The subclass's own prototype shadows the base's.
put(boxPrototype, "area", () => 7);
console.log(shape.area(), box.area(), shapes.map((s) => s.describe()).join(" | "));

// An own property shadows both.
put(box, "area", () => 8);
console.log(box.area(), new Box(1).area());

// Restored, innermost first.
drop(box, "area");
console.log(box.area());
drop(boxPrototype, "area");
console.log(box.area(), shape.area());
put(shapePrototype, "area", original);
console.log(shape.area(), box.area(), shapes.map((s) => s.describe()).join(" | "), other.area());

// A family in which only the base's prototype is ever asked for: an
// inherited method changes for instances of the subclass too, and the
// subclass's own override stays.
class Animal {
  speak(): string {
    return "...";
  }
  legs(): number {
    return 4;
  }
}

class Bird extends Animal {
  override legs(): number {
    return 2;
  }
}

const animal = new Animal();
const bird = new Bird();
let legs = 0;
for (let i = 0; i < 1000; i++) legs += animal.legs() + bird.legs();
console.log(legs, animal.speak(), bird.speak());
put(Object.getPrototypeOf(animal), "speak", () => "hello");
put(Object.getPrototypeOf(animal), "legs", () => 40);
console.log(animal.speak(), bird.speak(), animal.legs(), bird.legs(), new Bird().speak());
