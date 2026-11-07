// Case C: an interface only its declaring classes inhabit.
interface Shape {
  readonly name: string;
  scale: number;
  area(): number;
  describe(prefix: string): string;
  grow(by: number): void;
}
class Sq implements Shape {
  readonly name = "sq";
  scale = 1;
  s: number;
  constructor(s: number) { this.s = s; }
  area(): number { return this.s * this.s; }
  describe(prefix: string): string { return `${prefix}${this.name}:${this.area()}`; }
  grow(by: number): void { this.s += by; }
}
class Ci implements Shape {
  readonly name = "ci";
  scale = 2;
  r: number;
  constructor(r: number) { this.r = r; }
  area(): number { return 3 * this.r * this.r; }
  describe(prefix: string): string { return `${prefix}${this.name}:${this.area()}`; }
  grow(by: number): void { this.r += by; }
}
class BigSq extends Sq {
  override area(): number { return 1000 + super.area(); }
}
function mk(kind: number): Shape {
  return kind === 0 ? new Sq(2) : kind === 1 ? new Ci(1) : new BigSq(3);
}
function total(shapes: Shape[]): number {
  let t = 0;
  for (const s of shapes) t += s.area() * s.scale;
  return t;
}
function same(a: Shape, b: Shape): boolean { return a === b; }
function kinds(s: Shape): string { return `${s instanceof Sq}/${s instanceof Ci}/${s instanceof BigSq}`; }
const a = mk(0), b = mk(1), c = mk(2);
const shapes: Shape[] = [a, b, c];
console.log(total(shapes), shapes.map((s) => s.describe("#")).join(" "));
a.grow(1); b.scale = 5;
console.log(a.area(), b.scale, total(shapes));
console.log(same(a, a), same(a, b), kinds(a), kinds(b), kinds(c));
// identity through containers
const seen = new Map<Shape, number>();
for (const s of shapes) seen.set(s, s.area());
console.log(seen.get(a), seen.get(b), seen.size, shapes.indexOf(b), shapes.includes(c));
const set = new Set<Shape>([a, a, b]);
console.log(set.size, set.has(c));
// optional and nullable slots
let current: Shape | undefined;
console.log(current?.area(), current === undefined);
current = shapes[2];
console.log(current?.area(), current === c, current?.name);
let maybe: Shape | null = null;
if (shapes.length > 1) maybe = b;
console.log(maybe !== null ? maybe.describe("?") : "none");
// a field, a closure, a return through a function value
class Holder { shape: Shape; other?: Shape; constructor(shape: Shape) { this.shape = shape; } }
const h = new Holder(a);
h.other = b;
const pick = (flag: boolean): Shape => (flag ? h.shape : h.other ?? h.shape);
console.log(pick(true) === a, pick(false) === b, h.shape.name, h.other?.area());
// the instance is still its class
if (a instanceof Sq) console.log(a.s);
const narrowed = shapes.filter((s): s is Sq => s instanceof Sq);
console.log(narrowed.length, narrowed.map((s) => s.s).join(","));
// mutation through the interface is seen through the class
const sq = new Sq(10);
const viaIface: Shape = sq;
viaIface.grow(5); viaIface.scale = 9;
console.log(sq.s, sq.scale, viaIface === sq);
