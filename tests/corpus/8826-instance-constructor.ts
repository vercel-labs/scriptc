// `x.constructor` on an instance of a program class is the instance's own
// class, whatever class the static type names: its name, its identity, the
// class as a value, and construction through it. The instance stores
// nothing for this; the class it already carries for `instanceof` answers.

abstract class Shape {
  abstract area(): number;
  label(): string {
    return `${this.constructor.name}(${this.area()})`;
  }
  isExactly(other: Shape): boolean {
    return this.constructor === other.constructor;
  }
}
class Sq extends Shape {
  area(): number {
    return 4;
  }
}
class Rect extends Shape {
  area(): number {
    return 6;
  }
}
class Cube extends Sq {
  area(): number {
    return 24;
  }
}

// The name is the run-time class's, through `this` and through a base type.
function tag(shape: Shape): string {
  return shape.constructor.name;
}
const shapes: Shape[] = [new Sq(), new Rect(), new Cube()];
console.log("name", shapes.map((s) => s.label()).join(" "), shapes.map(tag).join(","));

// Identity against a class, and between two instances.
function kind(shape: Shape): string {
  return [shape.constructor === Sq, shape.constructor === Cube, shape.constructor !== Rect]
    .map(String)
    .join(",");
}
console.log("identity", kind(new Sq()), kind(new Cube()), kind(new Rect()));
console.log(
  "same",
  new Sq().isExactly(new Sq()),
  new Sq().isExactly(new Cube()),
  new Cube().isExactly(new Cube()),
);

// A class with no subclasses, a generic function, and a type parameter
// bounded by a class.
class Widget {}
function nameOf<T extends object>(value: T): string {
  return value.constructor.name;
}
function nameOfShape<T extends Shape>(value: T): string {
  return value.constructor.name;
}
console.log(
  "plain",
  new Widget().constructor.name,
  new Widget().constructor === Widget,
  nameOf(new Widget()),
  nameOf(new Cube()),
  nameOfShape(new Rect()),
);

// Every instantiation of a generic class is the one class JavaScript has.
class Box<T> {
  value: T | undefined = undefined;
  tag(): string {
    return this.constructor.name;
  }
}
class NumberBox extends Box<number> {}
console.log("generic", new Box<string>().tag(), new Box<number>().tag(), new NumberBox().tag());

// Classes that join a hierarchy while bodies lower: class expressions, a
// function-local class and a mixin application.
class Base {
  tag(): string {
    return this.constructor.name;
  }
  isBase(): boolean {
    return this.constructor === Base;
  }
}
const Named = class Inner extends Base {};
const Anonymous = class extends Base {};
function local(): Base {
  class Local extends Base {}
  return new Local();
}
type Constructor<T = object> = new (...args: any[]) => T;
function Stamped<B extends Constructor>(Parent: B) {
  return class Stamp extends Parent {
    stamp = 1;
  };
}
const StampedBase = Stamped(Base);
console.log(
  "late",
  new Named().tag(),
  new Anonymous().tag(),
  local().tag(),
  new StampedBase().tag(),
  new Base().tag(),
  new Named().isBase(),
  new Base().isBase(),
  new Named().constructor === Named,
);

// The class as a value: its name, its type, a Map key, `instanceof`.
const handlers = new Map<Function, string>([
  [Sq, "square"],
  [Rect, "rectangle"],
]);
function describe(shape: Shape): string {
  return handlers.get(shape.constructor) ?? "other";
}
function sameKind(left: Shape, right: Shape): boolean {
  return right instanceof left.constructor;
}
console.log(
  "value",
  describe(new Sq()),
  describe(new Rect()),
  describe(new Cube()),
  sameKind(new Sq(), new Cube()),
  sameKind(new Cube(), new Sq()),
);
const counts = new Map<string, number>();
for (const shape of shapes) {
  const name = shape.constructor.name;
  counts.set(name, (counts.get(name) ?? 0) + 1);
}
console.log("counts", [...counts].map(([name, n]) => `${name}=${n}`).join(","));

// Construction through the instance's class, under the assertions real code
// writes: each class completes the arguments against its own constructor.
class Point {
  x: number;
  y: number;
  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }
  clone(): Point {
    return new (this.constructor as typeof Point)(this.x, this.y);
  }
  empty(): this {
    return new (this.constructor as new () => this)();
  }
  moved(x: number): Point {
    return new (this.constructor as any)(x, this.y);
  }
  kind(): string {
    return "point";
  }
}
class Point3 extends Point {
  z = 9;
  kind(): string {
    return "point3";
  }
}
const cloned = new Point3(1, 2).clone();
const moved = new Point3(1, 2).moved(7);
console.log(
  "new",
  cloned.kind(),
  cloned.x,
  cloned.y,
  cloned instanceof Point3,
  new Point3(1, 2).empty().kind(),
  new Point3(1, 2).empty().x,
  moved.kind(),
  moved.x,
  new Point(3, 4).clone().kind(),
);

// A class that extends Error, through `this` and through its own type.
class AppError extends Error {
  describe(): string {
    return `${this.constructor.name}: ${this.message}`;
  }
}
class NotFound extends AppError {}
function errorName(error: AppError): string {
  return error.constructor.name;
}
try {
  throw new NotFound("missing");
} catch (error) {
  const caught = error as AppError;
  console.log(
    "error",
    caught.describe(),
    errorName(caught),
    caught.constructor === NotFound,
    caught.constructor === AppError,
    new AppError("plain").describe(),
  );
}
