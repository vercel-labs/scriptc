"use strict";
// Class instances of a hierarchy cross into untyped code through their
// base type many times. Each crossing names the same object: identity,
// Map, Set and WeakMap keys, properties added through untyped code, and
// field writes from either side stay one object, and every subclass keeps
// its own members, as in Node.

class Shape {
  constructor(name) {
    this.name = name;
    this.hits = 0;
  }
  area() {
    return 0;
  }
  describe() {
    return `${this.name}:${this.area()}`;
  }
}

class Square extends Shape {
  constructor(side) {
    super("square");
    this.side = side;
  }
  area() {
    return this.side * this.side;
  }
}

class Cube extends Square {
  constructor(side) {
    super(side);
    this.name = "cube";
  }
  area() {
    return 6 * super.area();
  }
  get volume() {
    return this.side ** 3;
  }
}

class Circle extends Shape {
  constructor(r) {
    super("circle");
    this.r = r;
  }
  area() {
    return Math.round(Math.PI * this.r * this.r);
  }
}

/** @param {any} value */
function untyped(value) {
  return value;
}
/** @param {any} value @param {string} key @param {unknown} extra */
function tag(value, key, extra) {
  value[key] = extra;
  value.hits++;
  return value;
}

/** @param {Shape} shape */
function crossAsBase(shape) {
  return untyped(shape);
}

const shapes = [new Shape("plain"), new Square(2), new Cube(3), new Circle(1)];
const seen = new Map();
const weak = new WeakMap();
const set = new Set();
for (let round = 0; round < 50; round++) {
  for (const shape of shapes) {
    const boxed = crossAsBase(shape);
    if (round === 0) {
      seen.set(boxed, shape.name);
      weak.set(boxed, round);
    }
    set.add(boxed);
    if (boxed !== shape || untyped(boxed) !== crossAsBase(shape)) console.log("identity lost", shape.name);
  }
}
console.log(seen.size, set.size, shapes.map((s) => seen.get(crossAsBase(s))).join(","), shapes.every((s) => weak.has(untyped(s))));

for (const shape of shapes) {
  const boxed = crossAsBase(shape);
  tag(boxed, "color", shape.name.length);
  shape.hits += 10;
  console.log(boxed.describe(), boxed.area(), boxed.hits, shape.hits, boxed.color, Object.keys(boxed).join(","));
  console.log(boxed instanceof Shape, boxed instanceof Square, boxed instanceof Cube, boxed instanceof Circle, boxed.constructor.name);
}

/** @type {Shape} */
const asBase = shapes[2];
const cube = crossAsBase(asBase);
console.log(cube.volume, JSON.stringify(cube), "side" in cube, "volume" in cube, Object.prototype.hasOwnProperty.call(cube, "volume"));
/** @type {any} */ (shapes[1]).side = 5;
console.log(crossAsBase(shapes[1]).area(), shapes[1].area(), untyped(shapes[1]).side);

const many = [];
for (let i = 0; i < 1000; i++) many.push(crossAsBase(i % 2 ? new Square(i) : new Circle(i)));
let squares = 0;
for (const item of many) if (item instanceof Square) squares += item.side;
console.log(many.length, squares, many[999].describe(), many[998].describe());
