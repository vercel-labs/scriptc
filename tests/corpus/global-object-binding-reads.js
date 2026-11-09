// A name no declaration binds reads the global object's own property of that
// name. A class or function assigned to `globalThis` or `global` is visible
// as an identifier afterwards: construction, calls, instanceof, typeof.
console.log(typeof Point, typeof Shape, typeof missingName);

try {
  new Point(0, 0);
} catch (error) {
  console.log(error instanceof ReferenceError, error.message);
}

globalThis.Point = class Point {
  constructor(x, y) {
    this.x = x;
    this.y = y;
  }
  sum() {
    return this.x + this.y;
  }
};

const p = new Point(1, 2);
console.log(p.sum(), p instanceof Point, typeof Point, Point.name);
console.log(Point === globalThis.Point, p.constructor === Point);

global.Shape = function Shape(sides) {
  this.sides = sides;
};
Shape.prototype.describe = function () {
  return "shape with " + this.sides + " sides";
};
const s = new Shape(3);
console.log(s.describe(), s instanceof Shape, typeof Shape);

globalThis.scale = function (value, factor) {
  return value * factor;
};
console.log(scale(4, 2.5), typeof scale);

globalThis.settings = { mode: "fast", level: 2 };
console.log(settings.mode, settings.level, typeof settings);

// A function declared before the write reads the property when it runs.
function makePoint(x) {
  return new Point(x, x);
}
console.log(makePoint(5).sum());

// A later write replaces the value every read sees.
globalThis.Point = class Point3 {
  constructor(x, y) {
    this.x = x;
    this.y = y;
    this.z = 0;
  }
  sum() {
    return this.x + this.y + this.z;
  }
};
console.log(new Point(2, 3).sum(), makePoint(1).z, Point.name);

// A name nothing wrote still throws, and typeof still answers "undefined".
try {
  console.log(notWritten);
} catch (error) {
  console.log(error.name, error.message);
}
console.log(typeof notWritten);

// The polyfill form: install only when the name is missing.
if (typeof Pixel === "undefined") {
  globalThis.Pixel = class Pixel {
    constructor(value) {
      this.value = value;
    }
  };
}
console.log(new Pixel(7).value, typeof Pixel);

// A name the global object inherits answers Node's typeof until the program
// writes its own property of that name.
console.log(typeof toString, typeof hasOwnProperty, typeof propertyIsEnumerable);
globalThis.propertyIsEnumerable = "own";
console.log(typeof propertyIsEnumerable, typeof toString);
