// The `in` operator with literal keys on class instances held as `any`, in
// a program whose instanceof and Object.getPrototypeOf checks give the
// classes runtime prototypes: methods, getters, setters and inherited
// members answer true, as do own fields and Object.prototype members;
// static methods and missing names answer false.

class Shape {
  name = "shape";
  static create(): Shape {
    return new Shape();
  }
  area(): number {
    return 0;
  }
  get label(): string {
    return this.name;
  }
  set size(value: number) {
    this.name = `size ${value}`;
  }
}

class Square extends Shape {
  side = 2;
  override area(): number {
    return this.side * this.side;
  }
  perimeter(): number {
    return this.side * 4;
  }
}

const shape: any = new Shape();
const square: any = new Square();
console.log("instanceof", square instanceof Shape, shape instanceof Square);
console.log("same prototype", Object.getPrototypeOf(shape) === Object.getPrototypeOf(square));

console.log("method", "area" in shape, "area" in square);
console.log("subclass method", "perimeter" in shape, "perimeter" in square);
console.log("getter", "label" in shape, "label" in square);
console.log("setter", "size" in shape, "size" in square);
console.log("own field", "name" in shape, "side" in square, "side" in shape);
console.log("object prototype", "toString" in shape, "hasOwnProperty" in square);
console.log("static", "create" in shape, "create" in square);
console.log("missing", "volume" in shape, "volume" in square);
console.log("negated", !("area" in shape), !("volume" in square));

const names = ["area", "perimeter", "label", "size", "name", "create", "volume"];
for (const name of names) {
  const key: any = JSON.parse(JSON.stringify(name));
  console.log("computed", name, key in shape, key in square);
}
