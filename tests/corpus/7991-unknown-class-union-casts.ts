// Checked casts from `unknown` to unions of classes: each instance selects
// its own arm, whatever the order of the arms, including subclasses, arrays
// of instances, instances inside records, and values of no listed class.
class Circle {
  readonly r: number;
  constructor(r: number) {
    this.r = r;
  }
  area(): number {
    return Math.round(Math.PI * this.r * this.r);
  }
}
class Square {
  readonly side: number;
  constructor(side: number) {
    this.side = side;
  }
  area(): number {
    return this.side * this.side;
  }
}
class Rect {
  readonly w: number;
  readonly h: number;
  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
  }
  area(): number {
    return this.w * this.h;
  }
}
class Tile extends Square {
  label(): string {
    return `tile ${this.side}`;
  }
}

type Shape = Circle | Square | Rect;

function describe(value: unknown): string {
  try {
    const shape = value as Shape;
    const kind = shape instanceof Circle ? "circle" : shape instanceof Rect ? "rect" : "square";
    return `${kind} ${shape.area()}`;
  } catch (error) {
    return `rejected: ${(error as Error).name}`;
  }
}

const values: unknown[] = [new Circle(2), new Square(3), new Rect(2, 5), new Tile(4), { side: 3 }, 7, null];
for (const value of values) console.log(describe(value));

const reversed = values.slice(0, 4).reverse() as Shape[];
console.log(reversed.map((s) => s.area()).join(","));

const boxed: unknown = { first: new Rect(1, 2), second: new Circle(1) };
const pair = boxed as { first: Shape; second: Shape };
console.log(pair.first.area(), pair.second.area(), pair.first instanceof Rect);

const tiles: unknown = [new Tile(1), new Tile(2)];
const asSquares = tiles as Square[];
console.log(asSquares.map((t) => t.area()).join(" "), asSquares[0] instanceof Tile);

let total = 0;
for (let i = 0; i < 1000; i++) {
  const v: unknown = i % 3 === 0 ? new Circle(1) : i % 3 === 1 ? new Square(2) : new Rect(1, 3);
  total += (v as Shape).area();
}
console.log(total);
