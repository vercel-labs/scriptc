// `instanceof` against constructors held as values: a property holding a
// global constructor, and constructor functions with prototype chains.
const kinds = [
  { name: "Date", type: Date },
  { name: "RegExp", type: RegExp },
  { name: "Map", type: Map },
  { name: "Set", type: Set },
  { name: "WeakMap", type: WeakMap },
  { name: "Promise", type: Promise },
  { name: "Array", type: Array },
];
function classify(value) {
  return kinds
    .filter((kind) => typeof value === "object" && value !== null && value instanceof kind.type)
    .map((kind) => kind.name)
    .join("+") || "none";
}
const samples = [new Date(0), /x/g, new Map([[1, 2]]), new Set([1]), new WeakMap(), Promise.resolve(1), [1, 2], { a: 1 }, null, "text", 4];
console.log(samples.map(classify).join(" "));

function Shape(sides) {
  this.sides = sides;
}
Shape.prototype.describe = function () {
  return this.sides + " sides";
};
function Square() {
  Shape.call(this, 4);
}
Square.prototype = Object.create(Shape.prototype);
Square.prototype.constructor = Square;
const square = new Square();
const shape = new Shape(3);
const types = { Shape, Square };
console.log(square instanceof types.Shape, square instanceof types.Square, shape instanceof types.Square);
console.log(square.describe(), shape.describe(), Object.create(Square.prototype) instanceof types.Shape);
console.log([square, shape, {}, []].map((value) => value instanceof types.Shape));
const notCallable = JSON.parse("{}");
try {
  console.log(square instanceof notCallable);
} catch (error) {
  console.log(error instanceof TypeError, error.message);
}
