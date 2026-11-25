// An object made from a TypeScript class's prototype and typed as the
// class: absent fields read as undefined, accessors and methods run with
// the made object as `this`, writes land on the object, and an object made
// from a subclass's prototype inherits the base's members the same way.
class Box {
  a = 1;
  get double(): number {
    return this.a * 2;
  }
  set double(v: number) {
    this.a = v / 2;
  }
  twice(): number {
    return this.a * 2;
  }
  sum(): number {
    return this.twice() + 1;
  }
}
const proto = Box.prototype;
const made = Object.create(proto) as Box;
console.log(made.a === undefined, typeof proto, made instanceof Box);
console.log(made.double);
made.double = 10;
console.log(made.a, made.double, made.twice(), made.sum());
made.a = 5;
console.log(made.double, made.twice(), made.sum());
console.log(Object.getPrototypeOf(made) === proto, proto.isPrototypeOf(made));
const other = Object.create(proto) as Box;
console.log(other.a === undefined, other.double);
class Sub extends Box {
  extra(): number {
    return this.a + 1;
  }
}
const madeSub = Object.create(Sub.prototype) as Sub;
console.log(madeSub.a === undefined, madeSub instanceof Sub, madeSub instanceof Box);
madeSub.a = 4;
console.log(madeSub.double, madeSub.twice(), madeSub.sum(), madeSub.extra());
const real = new Box();
console.log(real.double, proto.isPrototypeOf(real), made instanceof Sub);
