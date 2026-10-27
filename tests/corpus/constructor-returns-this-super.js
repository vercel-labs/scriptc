// A JavaScript base constructor that returns `this` through a method, as
// three.js's Color does: `super()` from a subclass keeps the subclass's own
// instance.
class Color {
  constructor(r, g, b) {
    this.r = 1;
    this.g = 1;
    this.b = 1;
    return this.set(r, g, b);
  }
  set(r, g, b) {
    if (g === undefined) {
      this.r = this.g = this.b = r;
    } else {
      this.r = r;
      this.g = g;
      this.b = b;
    }
    return this;
  }
}
class Color4 extends Color {
  constructor(r, g, b, a = 1) {
    super(r, g, b);
    this.a = a;
  }
}
const c = new Color(0.5);
const c4 = new Color4(0.1, 0.2, 0.3);
const c4b = new Color4(1, 0, 0, 0.5);
console.log(c.r, c.g, c.b, c instanceof Color);
console.log(c4.r, c4.g, c4.b, c4.a, c4 instanceof Color4, c4 instanceof Color);
console.log(c4b.a, c4b !== c4, Object.keys(c4b).join(","));
