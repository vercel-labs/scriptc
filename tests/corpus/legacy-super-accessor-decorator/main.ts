// @tsc-legacy-decorators
// A decorated accessor replaced by its decorator must be the accessor
// `super.x` reads and writes too: super dispatch must not bypass a wrapper
// the decorator installed (a guard silently skipped otherwise).

function guard(target: object, key: string, descriptor: PropertyDescriptor): PropertyDescriptor {
  const original = descriptor.get!;
  descriptor.get = function (this: unknown): number {
    const value = original.call(this);
    if (value < 0) throw new Error("denied");
    return value;
  };
  return descriptor;
}

function checked(target: object, key: string, descriptor: PropertyDescriptor): PropertyDescriptor {
  const original = descriptor.set!;
  descriptor.set = function (this: unknown, value: number): void {
    if (value < 0) throw new Error("bad value");
    original.call(this, value);
  };
  return descriptor;
}

class Base {
  protected v = -1;

  @guard
  get x(): number {
    return this.v;
  }

  @checked
  set y(value: number) {
    this.v = value;
  }

  get y(): number {
    return this.v;
  }
}

class Sub extends Base {
  read(): number {
    return super.x;
  }

  write(v: number): void {
    super.y = v;
  }
}

const sub = new Sub();
try {
  console.log("read", sub.read());
} catch (error) {
  console.log("denied", error instanceof Error);
}
try {
  sub.write(-5);
  console.log("wrote");
} catch {
  console.log("rejected");
}
sub.write(7);
console.log("value", sub.read());
