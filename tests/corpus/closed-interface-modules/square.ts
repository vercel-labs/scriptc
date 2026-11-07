import type { Shape, Sized } from "./shape.ts";

export class Square implements Shape, Sized {
  readonly kind = "square";
  side: number;
  constructor(side: number) {
    this.side = side;
  }
  area(): number {
    return this.side * this.side;
  }
  scaled(by: number): Shape {
    return new Square(this.side * by);
  }
  size(): number {
    return 4;
  }
}
