// A constructor that ends with `return this.set(...)`, where every
// reachable `set` returns `this`, answers the constructed instance, so
// subclasses still construct through super() (three.js's Color).
class Color {
  r = 0;
  g = 0;
  b = 0;
  constructor(r?: number, g?: number, b?: number) {
    return this.set(r ?? 0, g ?? 0, b ?? 0);
  }
  set(r: number, g: number, b: number): this {
    if (r < 0) return this.clear();
    this.r = r;
    this.g = g;
    this.b = b;
    return this;
  }
  clear(): this {
    this.r = this.g = this.b = 0;
    return this;
  }
}
class NamedColor extends Color {
  name: string;
  constructor(name: string, r: number, g: number, b: number) {
    super(r, g, b);
    this.name = name;
  }
  override set(r: number, g: number, b: number): this {
    super.set(r * 2, g * 2, b * 2);
    return this;
  }
}
const plain = new Color(1, 2, 3);
console.log(plain instanceof Color, plain.r, plain.g, plain.b);
console.log(new Color(-1, 5, 5).r, new Color().b);
const named = new NamedColor("teal", 0, 1, 2);
console.log(named instanceof NamedColor, named instanceof Color, named.name, named.r, named.g, named.b);
