// A checked cast into a union with many string discriminant literals reads
// the discriminant once, but a getter that runs while an arm's fields are
// checked can change it. The cast then continues with the arms after the
// one that failed, testing each arm's literal again, and matches the arm
// the new discriminant names. Each getter changes the discriminant on its
// first call only; the program reads the getter once itself, so Node (where
// the cast runs no code) reaches the same state. Valid casts only (see
// 1002-json-parse-cast.ts).

type Shape =
  | { kind: "circle"; radius: number }
  | { kind: "square"; side: number }
  | { kind: "rect"; height: number; width: number }
  | { kind: "tri"; a: number; b: number; c: number };

function area(shape: Shape): number {
  switch (shape.kind) {
    case "circle":
      return Math.round(Math.PI * shape.radius * shape.radius);
    case "square":
      return shape.side * shape.side;
    case "rect":
      return shape.width * shape.height;
    case "tri": {
      const s = (shape.a + shape.b + shape.c) / 2;
      return Math.sqrt(s * (s - shape.a) * (s - shape.b) * (s - shape.c));
    }
  }
}

// The circle arm reads `radius`, whose getter turns the value into a square.
let squareReads = 0;
const square: any = {
  kind: "circle",
  get radius() {
    squareReads++;
    if (squareReads === 1) square.kind = "square";
    return "none";
  },
  side: 3,
};
const asSquare = square as Shape;
void square.radius;
console.log(square.kind, asSquare.kind, area(asSquare));

// Values without getters take the arm their discriminant names.
const plain: any[] = [
  { kind: "rect", width: 2, height: 5 },
  { kind: "tri", a: 3, b: 4, c: 5 },
  { kind: "circle", radius: 2 },
];
for (const value of plain) {
  const shape = value as Shape;
  console.log(shape.kind, area(shape));
}
