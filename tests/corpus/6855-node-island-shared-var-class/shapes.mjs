var Shape = class {
  constructor(side) {
    this.side = side;
  }
  area() {
    return this.side * this.side;
  }
};

function makeShape(side) {
  return new Shape(side);
}

export { Shape, makeShape };
