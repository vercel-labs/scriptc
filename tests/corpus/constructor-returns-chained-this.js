// The JavaScript shape three.js ships: the constructor returns a chainable
// setter's result and other classes extend it.
class Color {
  constructor(r, g, b) {
    this.isColor = true;
    this.r = 1;
    this.g = 1;
    this.b = 1;
    return this.set(r, g, b);
  }
  set(r, g, b) {
    if (g === undefined && b === undefined) {
      if (r !== undefined) this.setScalar(r);
    } else {
      this.r = r;
      this.g = g;
      this.b = b;
    }
    return this;
  }
  setScalar(s) {
    this.r = this.g = this.b = s;
    return this;
  }
}
class Tinted extends Color {
  constructor(r, g, b, tint) {
    super(r, g, b);
    this.tint = tint;
  }
  set(r, g, b, a = 1) {
    this.a = a;
    return super.set(r, g, b);
  }
}
const c = new Color(0.5);
console.log(c.r, c.g, c.b, c instanceof Color);
const t = new Tinted(0.1, 0.2, 0.3, 'warm');
console.log(t.r, t.g, t.b, t.a, t.tint, t instanceof Tinted, t instanceof Color);
console.log(new Color().r);
