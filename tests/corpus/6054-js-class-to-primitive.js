// JavaScript class instances convert to strings through their own toString,
// and to "[object Object]" without one, as in Node.
class Point {
  constructor(x, y) {
    this.x = x;
    this.y = y;
  }
  toString() {
    return `(${this.x}, ${this.y})`;
  }
}
const p = new Point(1, 2);
console.log(`${p}`, String(p), "p=" + p);
class Bare {}
console.log(`${new Bare()}`);
