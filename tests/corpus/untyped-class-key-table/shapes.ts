// Classes of another source module. Their type keys sit in the program's one
// class key table beside the entry module's, in class pre-order: Shape, Round,
// Circle, Poly, Quad, Square, Tri, then Label.

export class Shape {
  name: string;
  constructor(name: string) {
    this.name = name;
  }
  area(): number {
    return 0;
  }
  describe(): string {
    return this.name + ' ' + this.area();
  }
}

export class Round extends Shape {
  radius: number;
  constructor(name: string, radius: number) {
    super(name);
    this.radius = radius;
  }
  area(): number {
    return 3 * this.radius * this.radius;
  }
}

export class Circle extends Round {
  constructor(radius: number) {
    super('circle', radius);
  }
}

export class Poly extends Shape {
  sides: number;
  constructor(name: string, sides: number) {
    super(name);
    this.sides = sides;
  }
}

export class Quad extends Poly {
  width: number;
  height: number;
  constructor(name: string, width: number, height: number) {
    super(name, 4);
    this.width = width;
    this.height = height;
  }
  area(): number {
    return this.width * this.height;
  }
}

export class Square extends Quad {
  constructor(side: number) {
    super('square', side, side);
  }
}

export class Tri extends Poly {
  base: number;
  height: number;
  constructor(base: number, height: number) {
    super('tri', 3);
    this.base = base;
    this.height = height;
  }
  area(): number {
    return (this.base * this.height) / 2;
  }
}

export class Label {
  text: string;
  constructor(text: string) {
    this.text = text;
  }
}

/** Every value leaves this module untyped. */
export function shapes(): unknown[] {
  return [new Shape('shape'), new Round('round', 2), new Circle(1), new Poly('poly', 5), new Quad('quad', 2, 3), new Square(2), new Tri(3, 4)];
}
