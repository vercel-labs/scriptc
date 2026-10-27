// Template literals and String() call the toString of class instances and
// of object literals that define one, and print "[object Object]" for
// objects that inherit Object.prototype.toString.
class Point {
  x: number;
  constructor(x: number) {
    this.x = x;
  }
  toString(): string {
    return `Point(${this.x})`;
  }
}
class Bare {
  y: number;
  constructor(y: number) {
    this.y = y;
  }
}
const labeled = {
  v: 1,
  toString() {
    return "labeled" + this.v;
  },
};
const plain = { v: 2 };
const p = new Point(3);
const b = new Bare(4);
console.log(`${p}`, `${b}`, `${labeled}`, `${plain}`);
console.log(String(p), String(labeled), p + "", labeled + "", "" + b);
const maybe: Point | undefined = p;
console.log(`${maybe}`);
