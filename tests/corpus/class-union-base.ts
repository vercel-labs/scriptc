// A union of a class and its subclasses (`Shape | Circle`) holds the
// instances the base class's slot holds: method calls dispatch on the
// instance's own class, and instanceof, type guards, discriminant checks,
// typeof, equality, JSON and inspection read the instance itself.
class Shape {
  kind: string = "shape";
  name: string;
  constructor(name: string) {
    this.name = name;
  }
  area(): number {
    return 0;
  }
  describe(): string {
    return `${this.name}:${this.area().toFixed(2)}`;
  }
}
class Circle extends Shape {
  r: number;
  constructor(r: number) {
    super("circle");
    this.r = r;
    this.kind = "circle";
  }
  area(): number {
    return Math.PI * this.r * this.r;
  }
}
class Square extends Shape {
  side: number;
  constructor(side: number) {
    super("square");
    this.side = side;
    this.kind = "square";
  }
  area(): number {
    return this.side * this.side;
  }
}
class BigSquare extends Square {
  big = true;
}
function isCircle(s: Shape | Circle): s is Circle {
  return s instanceof Circle;
}
const all: Array<Shape | Circle | Square> = [new Shape("plain"), new Circle(2), new Square(3), new BigSquare(4)];
for (const s of all) {
  if (s instanceof Circle) console.log("circle r", s.r);
  else if (s instanceof Square) console.log("square side", s.side, s instanceof BigSquare);
  else console.log("shape", s.name);
  console.log(s.describe(), s.kind);
}
const mixed: Shape | Circle = all[1]!;
if (isCircle(mixed)) console.log("guard", mixed.r);
const disc = all[2] as Shape | Square;
if (disc.kind === "square") console.log("disc", (disc as Square).side);
const nullable: Circle | Shape | null = Math.random() > 2 ? null : new Circle(1);
console.log(nullable === null ? "null" : nullable.area().toFixed(3));
const m = new Map<string, Square | BigSquare>();
m.set("a", new Square(1));
m.set("b", new BigSquare(2));
for (const [k, v] of m) console.log(k, v.area(), v instanceof BigSquare ? v.big : "-");
const circles: Circle[] = [new Circle(1), new Circle(3)];
const copied: (Shape | Circle)[] = [...circles, new Shape("pushed")];
console.log(circles.length, copied.length, copied[2]!.name);
function pick(i: number): Square | BigSquare | string {
  return i === 0 ? "none" : i === 1 ? new Square(5) : new BigSquare(6);
}
for (let i = 0; i < 3; i++) {
  const p = pick(i);
  console.log(typeof p, typeof p === "string" ? p : p.area());
}
const eq: Shape | Circle = circles[0]!;
console.log(eq === circles[0], all.indexOf(all[3]!), JSON.stringify(all[1]));
console.log(all[3]);
const sorted = [...all].sort((a, b) => a.area() - b.area());
console.log(sorted.map((s) => s.name).join(","));
class Cursor {
  x: number;
  y: number;
  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }
  step(dx: number, dy: number): this {
    this.x += dx;
    this.y += dy;
    return this;
  }
}
class Marker extends Cursor {
  label: string;
  constructor(x: number, y: number, label: string) {
    super(x, y);
    this.label = label;
  }
}
const cursors: Array<Cursor | Marker> = [];
for (let i = 0; i < 8; i++)
  cursors.push(i % 2 === 0 ? new Cursor(i, -i) : new Marker(i, -i, "m" + i));
let checksum = 0;
for (let r = 0; r < 1000; r++) {
  const cursor = cursors[r & 7]!;
  const moved = cursor.step((r % 3) - 1, (r % 5) - 2);
  checksum += moved.x * 3 + moved.y;
  if (moved === cursor && cursor.x > 20) cursor.x = 0;
}
const last = cursors[3]!;
console.log(checksum, last.x, last.y, last instanceof Marker ? last.label : "");
