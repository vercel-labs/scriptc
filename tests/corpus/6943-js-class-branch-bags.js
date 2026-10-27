// Untyped reads of class instances in a hierarchy: own properties added at
// runtime shadow methods and accessors, prototype data answers while an
// instance has no own properties, and computed keys and key probes see the
// same members, for the base class and for each subclass.

class Shape {
  constructor(name) {
    this.name = name;
    this.sides = 0;
  }
  area() {
    return 0;
  }
  get label() {
    return `${this.name}/${this.sides}`;
  }
}
class Square extends Shape {
  constructor(size) {
    super("square");
    this.sides = 4;
    this.size = size;
  }
  area() {
    return this.size * this.size;
  }
}
class Tile extends Square {
  constructor(size, color) {
    super(size);
    this.color = color;
  }
}
Shape.prototype.kind = "shape";
Square.prototype.corner = "right";

function read(value, key) {
  return value[key];
}
function describe(value) {
  const parts = [];
  for (const key of ["name", "sides", "size", "color", "kind", "corner", "label", "missing"])
    parts.push(`${key}=${String(read(value, key))}`);
  parts.push(`in:${"area" in value},${"kind" in value},${"extra" in value}`);
  parts.push(`own:${Object.hasOwn(value, "kind")},${Object.hasOwn(value, "size")}`);
  return parts.join(" ");
}

const shapes = [new Shape("dot"), new Square(3), new Tile(2, "red")];
for (const shape of shapes) console.log(describe(shape), shape.area(), shape.label);

const untyped = shapes.map((shape) => /** @type {any} */ (shape));
untyped[1].area = () => -1;
untyped[2].kind = "tile";
untyped[2].extra = 7;
try {
  untyped[0].label = "plain";
} catch (error) {
  console.log(error.name);
}
Object.defineProperty(untyped[0], "label", { value: "plain", enumerable: true });
for (const shape of untyped) {
  console.log(describe(shape), typeof shape.area, shape.area(), shape.kind, shape.extra);
  console.log(read(shape, "area") === Shape.prototype.area, read(shape, "label"));
}
const area = untyped[2].area;
console.log(area.call(new Tile(5, "blue")), Object.keys(untyped[2]).join(","));
