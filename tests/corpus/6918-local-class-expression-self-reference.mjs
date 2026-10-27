// Function-local class expressions in JavaScript whose static members and
// methods read the class by its own name.
function point(scale) {
  const P = class Point {
    static origin = new Point(0, 0);
    static unit = Point.scaled(1);
    constructor(x, y) {
      this.x = x;
      this.y = y;
    }
    static scaled(n) {
      return new Point(n * scale, n * scale);
    }
    plus(other) {
      return new Point(this.x + other.x, this.y + other.y);
    }
  };
  return P;
}
const P = point(3);
const sum = P.origin.plus(P.unit).plus(P.unit);
console.log(sum.x, sum.y, P.unit instanceof P, P.name);

function selfName() {
  const K = class Named {
    static who() {
      return Named === this;
    }
  };
  return [K.who(), K.name, typeof K];
}
console.log(selfName());

function factory(tag) {
  return class Tagged {
    static count = 0;
    constructor() {
      Tagged.count++;
    }
    static make() {
      return new Tagged();
    }
    get tag() {
      return tag + Tagged.count;
    }
  };
}
const T = factory("t");
T.make();
console.log(T.make().tag, T.count, factory("u").count);

// The only reference to the name is a shorthand property.
function packed() {
  const K = class Packed {
    static wrap() {
      return { Packed };
    }
  };
  return [K.wrap().Packed === K, K.wrap().Packed.name];
}
console.log(packed());
