// An interface whose implementors live in other modules: the whole program
// knows every class behind it.
import type { Shape, Sized } from "./shape.ts";
import { Circle, Ring } from "./circle.ts";
import { Square } from "./square.ts";

function build(n: number): Shape[] {
  const out: Shape[] = [];
  for (let i = 1; i <= n; i++) out.push(i % 3 === 0 ? new Ring(i, 1) : i % 2 === 0 ? new Circle(i) : new Square(i));
  return out;
}
function report(shape: Shape): string {
  return `${shape.kind}:${shape.area()}`;
}
const shapes = build(6);
console.log(shapes.map(report).join(" "));
const doubled = shapes.map((shape) => shape.scaled(2));
console.log(doubled.map(report).join(" "));
console.log(shapes[1]!.scaled(0).kind, shapes[2] instanceof Circle, shapes[2] instanceof Ring, shapes[0] instanceof Square);
// One class behind two interfaces: the same instance through each.
const square = new Square(3);
const asShape: Shape = square;
const asSized: Sized = square;
console.log(asShape.area(), asSized.size(), asShape === square, asSized === square);
// Interface-typed fields and maps keep the instances.
class Scene {
  items: Shape[] = [];
  focus: Shape | undefined = undefined;
  add(shape: Shape): Shape {
    this.items.push(shape);
    this.focus = shape;
    return shape;
  }
  total(): number {
    let sum = 0;
    for (const item of this.items) sum += item.area();
    return sum;
  }
}
const scene = new Scene();
const added = scene.add(square);
scene.add(new Ring(2, 1));
console.log(added === square, scene.focus === scene.items[1], scene.total(), scene.focus?.kind);
const index = new Map<string, Shape>();
for (const shape of shapes) index.set(report(shape), shape);
console.log(index.size, index.get("circle:12") === shapes[1], index.get("missing")?.area());
