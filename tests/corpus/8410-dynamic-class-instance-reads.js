// Untyped reads and writes of class instances at property sites: base and
// subclass instances, subclass instances returned where the base class is
// the inferred type, a subclass that redeclares an inherited field, a
// getter, fields set after construction and fields never set.
class Point {
  constructor(x, y) {
    this.x = x;
    this.y = y;
  }
}
class Tagged extends Point {
  constructor(x, y, tag) {
    super(x, y);
    this.tag = tag;
  }
}
class Shifted extends Point {
  label = "s";
  x = 100;
}
class Gauge {
  get x() {
    return 9;
  }
}
class Late {
  constructor(set) {
    if (set) this.x = "late";
  }
}
function make(i) {
  if (i % 3 === 0) return new Point(i, -i);
  if (i % 3 === 1) return new Tagged(i, i * 2, "t" + i);
  return new Shifted(i, 0);
}
function readX(o) {
  return o.x;
}
function readY(o) {
  return o.y;
}
function writeX(o, v) {
  o.x = v;
}
const values = [];
for (let i = 0; i < 9; i++) values.push(make(i));
values.push(new Gauge(), new Late(true), new Late(false), { x: "plain", y: 1 }, { y: 2, x: "swapped" });
let sum = 0;
for (let round = 0; round < 3; round++) {
  for (const v of values) {
    const x = readX(v);
    sum += typeof x === "number" ? x : x === undefined ? 1000 : x.length;
    const y = readY(v);
    if (typeof y === "number") sum += y;
  }
  for (let i = 0; i < 9; i++) writeX(values[i], round * 10 + i);
}
console.log(sum);
console.log(values.map((v) => String(readX(v))).join(" "));
console.log(values.map((v) => String(readY(v))).join(" "));
writeX(values[1], "changed");
console.log(readX(values[1]), readX(values[2]), values[2].label, values[1].tag);
