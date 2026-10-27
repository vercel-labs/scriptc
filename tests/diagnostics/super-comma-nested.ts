// super(...) as an operand of a statement-level comma expression compiles
// (super-comma-sequence.ts). Any other expression position still refuses:
// the field initializers that run at super() would be misordered.
class Base {
  constructor(readonly origin: string) {}
}

class Selected extends Base {
  constructor(left: boolean) {
    left ? super("left") : super("right");
  }
}

function keep<T>(value: T): T {
  return value;
}

class Argument extends Base {
  constructor() {
    keep((super("argument"), 1));
  }
}

console.log(new Selected(true).origin, new Argument().origin);
