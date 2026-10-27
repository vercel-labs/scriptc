// Classes whose base is an ordinary function constructor, with a declared
// constructor calling super and with the implicit derived constructor.
function Shape(name, sides) {
  this.name = name;
  this.sides = sides;
}
Shape.prototype.describe = function () {
  return `${this.name} with ${this.sides} sides`;
};

class Polygon extends Shape {
  constructor(name, sides, length) {
    super(name, sides);
    this.length = length;
  }
  perimeter() {
    return this.sides * this.length;
  }
}

class Unnamed extends Shape {}

const square = new Polygon("square", 4, 3);
console.log(square.describe(), square.perimeter());
console.log(square instanceof Polygon);
const shape = new Unnamed("triangle", 3);
console.log(shape.describe(), Object.keys(shape).join(","));
