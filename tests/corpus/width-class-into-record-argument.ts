// @transform-types
// A class that writes its own fields after construction, passed to a
// function that only reads them: the interface keeps its record shape and
// the instance is copied at the call, which answers the same reads the
// instance would.
interface Point {
  x: number;
  y: number;
}

class Cursor {
  constructor(
    public x: number,
    public y: number,
    public label: string,
  ) {}
  step(dx: number, dy: number): void {
    this.x += dx;
    this.y += dy;
  }
}

function distance(p: Point): number {
  return Math.sqrt(p.x * p.x + p.y * p.y);
}

const cursor = new Cursor(3, 4, "cursor");
console.log(distance(cursor));
cursor.step(3, 4);
console.log(distance(cursor));

// Two calls, one instance: each copy carries the values the instance has at
// the call.
const fixed = new Cursor(6, 8, "fixed");
console.log(distance(fixed), distance(fixed));

// The callee reads one field and passes the read value to a builtin.
function scaled(p: Point): number {
  return Math.round(p.x * 10) + Math.round(p.y * 10);
}
console.log(scaled(cursor), scaled(new Cursor(0.25, 0.5, "half")));

// A class with a method that the callee never reaches: the method's writes
// do not change the reads the copy answers.
class Tally {
  constructor(public n: number) {}
  add(k: number): void {
    this.n += k;
  }
}
interface Count {
  n: number;
}
function twice(c: Count): number {
  return c.n * 2;
}
const tally = new Tally(5);
tally.add(2);
console.log(twice(tally));
