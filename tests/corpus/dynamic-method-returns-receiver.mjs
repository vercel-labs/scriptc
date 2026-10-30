// Untyped methods that return their receiver, called through untyped
// values: chains, identity, subclasses, overrides and partial returns.
class Point {
  constructor(x, y) {
    this.x = x;
    this.y = y;
  }
  move(dx, dy) {
    this.x += dx;
    this.y += dy;
    return this;
  }
  scale(k) {
    if (k === 0) {
      this.x = 0;
      this.y = 0;
      return this;
    }
    this.x *= k;
    this.y *= k;
    return this;
  }
  maybe(flag) {
    if (flag) return this;
    return { x: -1 };
  }
  check(v) {
    if (v < 0) throw new RangeError("negative " + v);
    this.x += v;
    return this;
  }
}
class Tagged extends Point {
  constructor(x, y, tag) {
    super(x, y);
    this.tag = tag;
  }
  move(dx, dy) {
    super.move(dx, dy);
    return this.tag;
  }
}
class Plain extends Point {}
const points = [new Point(1, 2), new Tagged(3, 4, "t"), new Plain(5, 6), new Point(7, 8)];
let sum = 0;
for (let r = 0; r < 200; r++) {
  const p = points[r % points.length];
  const moved = p.move(1, -1);
  if (typeof moved === "object") {
    sum += moved.x + moved.y;
    if (moved !== p) throw new Error("identity lost");
  } else sum += moved.length;
  const scaled = p.scale(r % 3);
  sum += scaled === p ? 1 : 0;
  sum += p.maybe(r % 2 === 0).x;
}
console.log(sum);
const chain = points[0].move(1, 1).scale(2).move(-1, 0);
console.log(chain === points[0], chain.x, chain.y, chain instanceof Point);
const plain = points[2];
const r1 = plain.move(2, 2);
r1.extra = "seen";
console.log(plain.extra, r1 === plain, Object.keys(r1).join(","), r1.constructor.name);
try {
  points[3].check(1).check(-2);
} catch (e) {
  console.log(e instanceof RangeError, e.message, points[3].x);
}
const results = [];
for (const p of points) results.push(p.scale(1));
console.log(results.map((p, i) => p === points[i]).join(","));
console.log(JSON.stringify(points));
