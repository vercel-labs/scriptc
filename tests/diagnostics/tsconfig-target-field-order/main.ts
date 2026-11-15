// The project targets ES2019, so its parameter properties are assigned
// before its field initializers run and `this.items` below is defined. A
// field declared further down is still read before its own initializer, in
// either order: that error stays.
class Shelf {
  private count = this.items.length;
  private doubled = this.width * 2;
  private width = 3;
  constructor(readonly items: string[]) {}
  size(): number {
    return this.count + this.doubled + this.width;
  }
}

console.log(new Shelf(["a"]).size());
