export class Base {
  v: number = 1;
  describe(): string {
    return `base:${this.v}`;
  }
}

// The issue's shape: a helper returns a subclass of its argument, and that
// subclass carries a static field.
export function wrap(B: typeof Base) {
  return class extends B {
    static flagged = true;
    extra: number = 2;
  };
}

// The same shape with a static getter beside the field.
export function labelled(B: typeof Base) {
  return class extends B {
    static label = "labelled";
    static get shout(): string {
      return "shout";
    }
    extra = 3;
  };
}

// A helper that returns an instance of a function-local class with a static
// member (the shape a whole-program element-type query used to crash on).
export function make() {
  class Box {
    static count = 0;
    v = 7;
  }
  return new Box();
}
