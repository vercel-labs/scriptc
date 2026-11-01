// A union of a class and its subclasses (`Shape | Circle | Square`) holds
// the base class's values, so the storage beside another arm keeps the base
// slot. A guard that proves the value is one of several subclasses narrows
// that storage to the sub-union (`Circle | Square`), which reads the
// instances back with their own layouts.
class Shape {
  name: string;
  constructor(name: string) {
    this.name = name;
  }
  area(): number {
    return 0;
  }
}
class Circle extends Shape {
  r: number;
  constructor(r: number) {
    super("circle");
    this.r = r;
  }
  area(): number {
    return 3 * this.r * this.r;
  }
}
class Square extends Shape {
  side: number;
  constructor(side: number) {
    super("square");
    this.side = side;
  }
  area(): number {
    return this.side * this.side;
  }
}
function isRound(shape: Shape | Circle | Square | number): shape is Circle | Square {
  return shape instanceof Circle || shape instanceof Square;
}
const items: Array<Shape | Circle | Square | number> = [
  new Circle(2),
  new Square(3),
  new Shape("plain"),
  5,
];
for (const item of items) {
  if (item instanceof Circle || item instanceof Square) {
    const round: Circle | Square = item;
    console.log(round.name, round.area());
  } else if (typeof item === "number") {
    console.log("number", item);
  } else {
    console.log("shape", item.name);
  }
}
const mixed: Shape | Circle | Square | number = items[0]!;
if (isRound(mixed)) {
  const round: Circle | Square = mixed;
  console.log("guard", round instanceof Circle, round.area());
} else {
  console.log("guard", "none");
}
const nullable: Circle | Square | null = items.length > 4 ? new Square(4) : null;
if (nullable !== null && isRound(nullable)) {
  const round: Circle | Square = nullable;
  console.log("nullable", round.name, round.area());
} else {
  console.log("nullable", nullable === null ? "null" : "none");
}
