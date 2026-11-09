// `x instanceof C` on untyped values: a class and the classes below it answer
// by the value's own class, whatever the number of classes, and every value
// that is no instance of a program class answers as Node does.
abstract class Shape {
  abstract area(): number;
  label(): string {
    return "shape:" + this.area();
  }
}
class Circle extends Shape {
  constructor(readonly r: number) {
    super();
  }
  area(): number {
    return this.r * this.r * 3;
  }
}
class Square extends Shape {
  constructor(readonly side: number) {
    super();
  }
  area(): number {
    return this.side * this.side;
  }
}
class Tile extends Square {
  label(): string {
    return "tile:" + this.side;
  }
}
class Mosaic extends Tile {
  pieces = 4;
}
class Part {
  constructor(readonly id: number) {}
  name(): string {
    return "part" + this.id;
  }
}
class P1 extends Part {}
class P2 extends Part {}
class P3 extends Part {}
class P4 extends Part {}
class P5 extends Part {}
class P6 extends Part {}
class P7 extends Part {}
class P8 extends Part {}
class P9 extends Part {
  name(): string {
    return "nine";
  }
}
class Other {
  tag = "other";
}
class Further extends Other {}
class Box<T> {
  constructor(readonly held: T) {}
}
class NumberBox extends Box<number> {}
const Hidden = class {
  secret = 7;
};
class AppError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppError";
  }
}
class DeepError extends AppError {}
type Rec = { id: number; name: string };

function bit(test: boolean): string {
  return test ? "1" : "0";
}

function shapes(x: unknown): string {
  return (
    bit(x instanceof Shape) +
    bit(x instanceof Circle) +
    bit(x instanceof Square) +
    bit(x instanceof Tile) +
    bit(x instanceof Mosaic)
  );
}

function parts(x: unknown): string {
  return (
    bit(x instanceof Part) +
    bit(x instanceof P1) +
    bit(x instanceof P2) +
    bit(x instanceof P5) +
    bit(x instanceof P8) +
    bit(x instanceof P9)
  );
}

function others(x: unknown): string {
  return (
    bit(x instanceof Other) +
    bit(x instanceof Further) +
    bit(x instanceof Box) +
    bit(x instanceof NumberBox) +
    bit(x instanceof Hidden)
  );
}

function errors(x: unknown): string {
  return bit(x instanceof Error) + bit(x instanceof AppError) + bit(x instanceof DeepError);
}

function builtins(x: unknown): string {
  return bit(x instanceof Map) + bit(x instanceof Array) + bit(x instanceof Date);
}

function narrowed(x: unknown): string {
  if (x instanceof Tile) return x.label() + "/" + x.area();
  if (x instanceof Shape) return x.label();
  if (x instanceof P9) return x.name() + "!";
  if (x instanceof Part) return x.name();
  if (x instanceof NumberBox) return "box:" + (x.held + 1);
  if (x instanceof AppError) return x.name + ":" + x.message;
  return "-";
}

const asShape: Shape = new Mosaic(5);
const asPart: Part = new P5(55);
const rec: Rec = { id: 1, name: "rec" };
const values: Array<[string, unknown]> = [
  ["circle", new Circle(2)],
  ["square", new Square(3)],
  ["tile", new Tile(4)],
  ["mosaic", new Mosaic(2)],
  ["mosaic as shape", asShape],
  ["part", new Part(0)],
  ["p1", new P1(1)],
  ["p2", new P2(2)],
  ["p3", new P3(3)],
  ["p4", new P4(4)],
  ["p5 as part", asPart],
  ["p6", new P6(6)],
  ["p7", new P7(7)],
  ["p8", new P8(8)],
  ["p9", new P9(9)],
  ["other", new Other()],
  ["further", new Further()],
  ["box of string", new Box("held")],
  ["box of number", new Box(1)],
  ["number box", new NumberBox(41)],
  ["hidden", new Hidden()],
  ["app error", new AppError("app")],
  ["deep error", new DeepError("deep")],
  ["error", new Error("plain")],
  ["range error", new RangeError("range")],
  ["record", rec],
  ["literal", { id: 2, tag: "lit" }],
  ["parsed", JSON.parse('{"id":3}')],
  ["array", [1, 2, 3]],
  ["map", new Map<string, number>()],
  ["string", "text"],
  ["number", 12.5],
  ["boolean", true],
  ["null", null],
  ["undefined", undefined],
  ["function", (n: number): number => n + 1],
];

for (const [name, value] of values) {
  console.log(
    name +
      ": " +
      shapes(value) +
      " " +
      parts(value) +
      " " +
      others(value) +
      " " +
      errors(value) +
      " " +
      builtins(value) +
      " " +
      narrowed(value),
  );
}

let caught = "";
for (const make of [
  (): never => {
    throw new DeepError("thrown deep");
  },
  (): never => {
    throw new AppError("thrown app");
  },
  (): never => {
    throw new P9(99);
  },
  (): never => {
    throw new TypeError("thrown type");
  },
]) {
  try {
    make();
  } catch (error) {
    caught += errors(error) + parts(error) + shapes(error) + " ";
  }
}
console.log("caught: " + caught);

let hits = 0;
for (let round = 0; round < 50; round++) {
  for (const [, value] of values) {
    if (value instanceof Part) hits += 1;
    if (value instanceof Shape) hits += 2;
    if (value instanceof P9) hits += 100;
  }
}
console.log("hits: " + hits);
