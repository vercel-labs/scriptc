// pop removes the last slot whether its value is used, discarded, absent
// or a hole, for union, scalar and object element arrays alike.
class Circle {
  radius: number;
  constructor(radius: number) {
    this.radius = radius;
  }
}
class Square {
  side: number;
  constructor(side: number) {
    this.side = side;
  }
}
type Shape = Circle | Square;

function area(shape: Shape | undefined): string {
  if (shape === undefined) return "none";
  return shape instanceof Circle ? `circle ${shape.radius}` : `square ${shape.side}`;
}

const shapes: Shape[] = [new Circle(1), new Square(2), new Circle(3)];
const alias = shapes;
console.log(area(shapes.pop()), shapes.length, alias.length);
shapes.pop();
console.log(shapes.length, area(shapes[0]));
void shapes.pop();
console.log(shapes.length, area(shapes.pop()), shapes.length);
shapes.pop();
console.log(shapes.length);

const mixed: (number | string)[] = [1, "two", 3];
for (let i = 0; i < 2; i++, mixed.pop()) console.log("mixed", mixed.length, mixed[mixed.length - 1]);
console.log(mixed.length, mixed.pop(), mixed.pop(), mixed.length);

const holey: Shape[] = [new Square(4)];
holey.length = 3;
console.log(holey.length, area(holey.pop()), holey.length);
holey.pop();
console.log(holey.length, area(holey.pop()), holey.length);

const numbers: number[] = [10, 20, 30];
numbers.pop();
const top = numbers.pop();
console.log(top, numbers.join(","));
console.log(numbers.pop(), numbers.pop(), numbers.length);

const flags: boolean[] = [true, false];
let seen = 0;
while (flags.length > 0) {
  if (flags.pop()) seen++;
}
console.log(seen, flags.length, flags.pop());

const words: string[] = ["x", "y"];
(words.pop(), words.pop(), words.pop());
console.log(words.length);

const stack: Shape[] = [];
for (let i = 0; i < 6; i++) stack.push(i % 2 === 0 ? new Circle(i) : new Square(i));
const drained: string[] = [];
while (stack.length > 2) drained.push(area(stack.pop()));
stack.pop();
console.log(drained.join(", "), stack.length, area(stack[0]));

class History {
  private readonly steps: Shape[] = [];
  record(shape: Shape): void {
    this.steps.push(shape);
  }
  undo(): void {
    this.steps.pop();
  }
  latest(): string {
    return area(this.steps[this.steps.length - 1]);
  }
}
const history = new History();
history.record(new Circle(7));
history.record(new Square(8));
history.undo();
console.log(history.latest());
history.undo();
history.undo();
console.log(history.latest());
