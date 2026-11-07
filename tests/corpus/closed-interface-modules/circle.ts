import type { Shape } from "./shape.ts";
import { Square } from "./square.ts";

export class Circle implements Shape {
  readonly kind: string = "circle";
  radius: number;
  constructor(radius: number) {
    this.radius = radius;
  }
  area(): number {
    return 3 * this.radius * this.radius;
  }
  scaled(by: number): Shape {
    // An implementor may answer another implementor.
    return by === 0 ? new Square(0) : new Circle(this.radius * by);
  }
}

export class Ring extends Circle {
  override readonly kind = "ring";
  hole: number;
  constructor(radius: number, hole: number) {
    super(radius);
    this.hole = hole;
  }
  override area(): number {
    return super.area() - 3 * this.hole * this.hole;
  }
}
