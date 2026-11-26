// @tsc-legacy-decorators
// Legacy accessor decorators: one decoration step per accessor property,
// with the combined get/set descriptor from the property's pair, applied in
// reverse source order. A decorator that returns (or mutates and returns) the
// descriptor replaces the accessor the instance reads and writes go through.

function acc(label: string): (t: object, k: string, d: PropertyDescriptor) => void {
  console.log("factory", label);
  return (t: object, k: string, d: PropertyDescriptor): void => {
    console.log("apply", label, k, typeof d.get, typeof d.set, d.enumerable, d.configurable);
  };
}

function doubled(target: object, key: string, descriptor: PropertyDescriptor): PropertyDescriptor {
  const original = descriptor.get!;
  descriptor.get = function (this: D): number {
    return original.call(this) * 2;
  };
  return descriptor;
}

class C {
  private v = 1;

  @acc("x")
  get x(): number {
    return this.v;
  }

  set x(n: number) {
    this.v = n;
  }

  @acc("y")
  set y(n: number) {
    console.log("set y", n);
  }

  get y(): number {
    return 5;
  }
}

class D {
  @doubled
  get z(): number {
    return 3;
  }
}

function param(label: string): (t: object, k: string | symbol | undefined, i: number) => void {
  console.log("factory-param", label);
  return (t: object, k: string | symbol | undefined, i: number): void => {
    console.log("apply-param", label, i);
  };
}

class E {
  private v = 0;

  @acc("e")
  set e(@param("p") value: number) {
    this.v = value;
  }

  get e(): number {
    return this.v;
  }
}

const c = new C();
console.log("read", c.x, c.y);
c.x = 7;
c.y = 8;
console.log("after", c.x);
console.log("doubled", new D().z);
const e = new E();
e.e = 3;
console.log("setter-param", e.e);
