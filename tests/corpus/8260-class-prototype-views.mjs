// A class's prototype as the prototype of other objects: ES5 constructors
// that inherit from a class through Object.create, Object.setPrototypeOf and
// util.inherits, and plain objects that adopt a class prototype. Inherited
// methods, accessors and calls between methods run with the object as the
// receiver.
import util from "node:util";

class Shape {
  constructor(name) {
    this.name = name;
  }
  get label() {
    return `${this.name} (${this.sides()} sides)`;
  }
  sides() {
    return 0;
  }
  describe() {
    return `${this.label}: area ${this.area().toFixed(2)}`;
  }
  area() {
    return 0;
  }
}

class Polygon extends Shape {
  sides() {
    return this.points.length;
  }
  perimeter() {
    let total = 0;
    for (let i = 0; i < this.points.length; i++) {
      const [x1, y1] = this.points[i];
      const [x2, y2] = this.points[(i + 1) % this.points.length];
      total += Math.hypot(x2 - x1, y2 - y1);
    }
    return total;
  }
}

// Object.create(Class.prototype) for an ES5 subclass.
function Square(size) {
  this.name = "square";
  this.size = size;
  this.points = [
    [0, 0],
    [size, 0],
    [size, size],
    [0, size],
  ];
}
Square.prototype = Object.create(Polygon.prototype);
Square.prototype.constructor = Square;
Square.prototype.area = function () {
  return this.size * this.size;
};

const square = new Square(3);
console.log(square.describe());
console.log(square.perimeter(), square.sides(), square.label);
console.log(square instanceof Square, square instanceof Polygon, square instanceof Shape);
console.log(Object.getPrototypeOf(Square.prototype) === Polygon.prototype);
console.log(Object.getPrototypeOf(Polygon.prototype) === Shape.prototype);
console.log(Object.keys(square).join(","));
const inherited = [];
for (const key in square) inherited.push(key);
console.log(inherited.join(","));

// Object.setPrototypeOf on an ES5 constructor's prototype.
function Circle(radius) {
  this.name = "circle";
  this.radius = radius;
}
Circle.prototype.area = function () {
  return Math.PI * this.radius * this.radius;
};
Object.setPrototypeOf(Circle.prototype, Shape.prototype);
const circle = new Circle(2);
console.log(circle.describe(), circle instanceof Shape, circle instanceof Polygon);

// util.inherits with a class as the superCtor.
function Triangle(a, b, c) {
  this.name = "triangle";
  this.points = [a, b, c];
}
util.inherits(Triangle, Polygon);
Triangle.prototype.area = function () {
  const [[x1, y1], [x2, y2], [x3, y3]] = this.points;
  return Math.abs((x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2)) / 2);
};
const triangle = new Triangle([0, 0], [4, 0], [0, 3]);
console.log(Triangle.super_ === Polygon, triangle instanceof Polygon);
console.log(triangle.describe(), triangle.perimeter());

// A plain object that adopts a class prototype (rehydrating parsed data).
const parsed = JSON.parse('{"name":"lot","points":[[0,0],[2,0],[2,1]]}');
Object.setPrototypeOf(parsed, Polygon.prototype);
console.log(parsed.sides(), parsed.perimeter().toFixed(3), parsed.label, parsed instanceof Polygon);
const fresh = Object.create(Shape.prototype);
fresh.name = "blank";
console.log(fresh.describe(), fresh instanceof Shape, Object.getPrototypeOf(fresh) === Shape.prototype);

// Native instances keep their own methods and answers.
const native = new Polygon("native");
native.points = [
  [0, 0],
  [1, 0],
  [0, 1],
];
console.log(native.describe(), native.perimeter().toFixed(3), native instanceof Polygon);

// util.inspect names each object by its prototype's constructor.
function Plain() {
  this.v = 1;
}
Object.setPrototypeOf(Plain.prototype, Shape.prototype);
console.log(new Square(1).size, fresh, new Plain(), Object.prototype.toString.call(fresh));
console.log(util.inspect(new Plain()), util.inspect(parsed, { depth: 0 }));

// A subclass keeps its own constructor below a base whose prototype other
// objects inherit: `new this.constructor()` in a base method builds the
// subclass, also while the subclass's prototype holds a replaceable method.
class Disc extends Shape {
  area() {
    return 3;
  }
  rebuild() {
    return new this.constructor("copy of " + this.name);
  }
}
const areaValue = Shape.prototype.area;
const disc = new Disc("d");
const rebuilt = disc.rebuild();
console.log(disc.constructor === Disc, rebuilt instanceof Disc, rebuilt.area(), rebuilt.name, typeof areaValue);

// Deleting a reflected prototype's constructor: instances read the
// constructor their base class's prototype holds, then Object's; a
// replacement answers again.
class Root {
  hi() {
    return "hi";
  }
}
class Middle extends Root {}
class Tip extends Middle {}
const members = [new Middle(), new Tip(), new Root(), {}];
const constructorNames = () => members.map((member) => member.constructor.name).join(",");
console.log(constructorNames(), Object.getOwnPropertyNames(Object.getPrototypeOf(new Middle())).join("|"));
delete Object.getPrototypeOf(new Middle()).constructor;
console.log(constructorNames(), Object.getOwnPropertyNames(Object.getPrototypeOf(new Middle())).join("|"));
console.log(new Middle().constructor === Root, new Tip().constructor === Tip);
delete Object.getPrototypeOf(new Root()).constructor;
console.log(constructorNames(), new Middle().constructor === Object);
Middle.prototype.constructor = function Named() {};
console.log(constructorNames());

// A reflected prototype whose constructor is an accessor: an instance's read runs the getter with the
// instance as `this`, also where the instance's class inherits it.
class Facet {
  constructor(tag) {
    this.tag = tag;
  }
}
class Tile extends Facet {}
class Brick extends Tile {}
const facets = [new Tile("s"), new Brick("c"), new Facet("p")];
const facetTags = () =>
  facets.map((facet) => (typeof facet.constructor === "string" ? facet.constructor : facet.constructor.name)).join(",");
Object.defineProperty(Tile.prototype, "constructor", {
  get() {
    return "on " + this.tag;
  },
  configurable: true,
});
delete Object.getPrototypeOf(new Brick("x")).constructor;
console.log(facetTags());
delete Object.getPrototypeOf(new Tile("x")).constructor;
console.log(facetTags());
