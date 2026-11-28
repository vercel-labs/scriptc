export class Base {
  base = "base";
  hello(): string {
    return "hello:" + this.base;
  }
}

export abstract class AbstractMid extends Base {
  abstract area(): number;
}

export class Leaf extends AbstractMid {
  area(): number {
    return 3;
  }
}

export class Plain extends Base {
  plain = "plain";
}

export abstract class Shape {
  kind = "shape";
  describe(): string {
    return "a " + this.kind;
  }
  abstract area(): number;
}

export class Circle extends Shape {
  area(): number {
    return 3;
  }
}
