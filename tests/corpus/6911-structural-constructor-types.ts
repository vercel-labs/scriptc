// Values typed by a structural constructor type: `new () => unknown`, a type
// that also names static members, abstract constructor types and arrays of
// constructors. The class value keeps its identity; `new` through it builds
// an instance of the class it holds, and static reads see that class's
// statics.
type DescribedClass = { readonly schema: unknown; new (): unknown };
class Item {
  static readonly schema = { name: true };
  value = 42;
}
class Other {
  static readonly schema = { name: false, extra: 1 };
  value = 7;
}
function classOf(flag: boolean): DescribedClass {
  return flag ? Item : Other;
}
console.log(JSON.stringify(classOf(true).schema), JSON.stringify(classOf(false).schema));
const C = classOf(true);
const made = new C();
console.log(made instanceof Item, (made as Item).value, C === Item);

type Ctor = new () => unknown;
const ctors: Ctor[] = [Item, Other];
console.log(ctors.length, ctors.map((c) => (new c() as { value: number }).value).join(","));

class Point {
  readonly x: number;
  readonly y: number;
  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }
  static origin = "0,0";
}
type PointLike = { readonly origin: string; new (x: number, y: number): { x: number; y: number } };
const P: PointLike = Point;
const p = new P(3, 4);
console.log(p.x + p.y, P.origin);

abstract class Shape {
  abstract area(): number;
  describe(): string {
    return `area ${this.area()}`;
  }
}
class Square extends Shape {
  area(): number {
    return 4;
  }
}
type ShapeCtor = abstract new () => Shape;
const sc: ShapeCtor = Square;
console.log(sc === Square, new (sc as new () => Shape)().describe());

function make<T>(c: new () => T): T {
  return new c();
}
console.log((make(Item) as Item).value, (make(Other) as Other).value);
