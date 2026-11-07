// The usual WeakRef: typed code holds the target, and the ref is read in a
// later turn. The dynamic value the ref was made from is gone by then, and
// what deref answers is still the same object to everything that looks at
// it dynamically: the same class to instanceof and to console.log, the
// same live fields.
class Point {
  x: number;
  y: number;
  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }
  norm(): number {
    return Math.hypot(this.x, this.y);
  }
}
interface Named {
  name: string;
  tags: string[];
}

const point = new Point(3, 4);
const named: Named = { name: "kept", tags: ["a"] };
const pointRef = new WeakRef(point);
const namedRef = new WeakRef(named);

function show(when: string): void {
  const p: unknown = pointRef.deref();
  const n: unknown = namedRef.deref();
  console.log(when, p, n);
  console.log(when, p instanceof Point, p === point, n === named, typeof p, typeof n);
  console.log(when, JSON.stringify(p), JSON.stringify(n), Object.keys(n as object).join(","));
  if (p instanceof Point) console.log(when, p.norm());
}

show("same job");
setTimeout(() => {
  show("next turn");
  point.x = 6;
  point.y = 8;
  named.tags.push("b");
  setTimeout(() => show("after writes"), 1);
}, 1);
