// @transform-types
// super(...) as an operand of a statement-level comma expression lowers
// like the separate statements a minifier joined: operands run in source
// order, the base constructor and then the derived field initializers run
// at the super() call, and the trailing operands see the initialized
// instance.
function log<T>(label: string, value: T): T {
  console.log("  " + label);
  return value;
}

class Base {
  readonly origin: string;
  constructor(origin: string) {
    console.log("  Base body", origin);
    this.origin = origin;
  }
}

class Joined extends Base {
  first = log("field first", 1);
  second: number = this.first + 1;
  tag: string;
  constructor(origin: string) {
    super(log("super argument", origin)), log("after super", 0), this.tag = `${this.origin}:${this.second}`;
  }
}

class Leading extends Base {
  value = log("field value", "v");
  constructor(origin: string) {
    log("before super", 0), super(origin), log("after super " + this.value, 0);
  }
}

class Parenthesized extends Base {
  count = 0;
  constructor() {
    (super("paren"), this.count++, this.count++);
  }
}

class Nested extends Base {
  steps: string[] = [];
  constructor() {
    super("nested"), (this.steps.push("a"), this.steps.push("b")), this.steps.push("c");
  }
}

class Branching extends Base {
  side: string;
  constructor(left: boolean) {
    if (left) super("left"), this.side = "L";
    else super("right"), this.side = "R";
  }
}

class Point {
  constructor(
    public x: number,
    public y: number,
  ) {}
}

class Point3 extends Point {
  label = "p3";
  constructor(
    x: number,
    y: number,
    public z: number,
  ) {
    super(x, y), console.log("  Point3", this.x, this.y, this.z, this.label);
  }
}

class Point4 extends Point3 {
  w: number;
  constructor(x: number, y: number, z: number, w: number) {
    super(x, y, z), this.w = w, this.label = "p4";
  }
}

console.log("joined:");
const joined = new Joined("j");
console.log(joined.origin, joined.first, joined.second, joined.tag);

console.log("leading:");
const leading = new Leading("l");
console.log(leading.origin, leading.value);

const paren = new Parenthesized();
console.log("parenthesized:", paren.origin, paren.count);

const nested = new Nested();
console.log("nested:", nested.origin, nested.steps.join(","));

console.log("branching:", new Branching(true).side, new Branching(false).side);

console.log("chain:");
const p4 = new Point4(1, 2, 3, 4);
console.log(p4.x, p4.y, p4.z, p4.w, p4.label, p4 instanceof Point3, p4 instanceof Point);
