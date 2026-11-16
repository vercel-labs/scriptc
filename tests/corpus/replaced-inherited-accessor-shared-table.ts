// An inherited accessor replaced on a subclass prototype answers through that
// subclass for dynamic reads and writes, even when the class's key table shares
// a base class's table. The base declares enough names, and a sibling repeats
// them, so the sharing path is the one under test.
class Base {
  f0 = 0;
  f1 = 1;
  f2 = 2;
  f3 = 3;
  f4 = 4;
  f5 = 5;
  f6 = 6;
  f7 = 7;
  f8 = 8;
  f9 = 9;
  f10 = 10;
  f11 = 11;
  f12 = 12;
  f13 = 13;
  f14 = 14;
  f15 = 15;
  f16 = 16;
  f17 = 17;
  f18 = 18;
  f19 = 19;
  f20 = 20;
  f21 = 21;
  f22 = 22;
  f23 = 23;
  f24 = 24;
  f25 = 25;
  f26 = 26;
  f27 = 27;
  f28 = 28;
  f29 = 29;
  f30 = 30;
  f31 = 31;
  f32 = 32;
  f33 = 33;
  f34 = 34;
  f35 = 35;
  f36 = 36;
  f37 = 37;
  f38 = 38;
  f39 = 39;
  got = 0;
  get value(): number {
    return 1;
  }
  set value(v: number) {
    this.got = v;
  }
}
class Mid extends Base {
  b = 2;
}
class Leaf extends Mid {
  c = 3;
}
class Other extends Base {
  d = 4;
}
Object.defineProperty(Mid.prototype, "value", {
  get() {
    return 24;
  },
  set(v: number) {
    (this as any).seen = v;
  },
  configurable: true,
});
const values: any[] = [new Base(), new Mid(), new Leaf(), new Other()];
function read(value: any, key: string): unknown {
  return value[key];
}
function write(value: any, key: string, stored: unknown): void {
  value[key] = stored;
}
write(values[1], "value", 7);
write(values[2], "value", 9);
write(values[0], "value", 5);
console.log(
  read(values[0], "value"),
  read(values[1], "value"),
  read(values[2], "value"),
  read(values[3], "value"),
  read(values[1], "seen"),
  read(values[2], "seen"),
  read(values[0], "got"),
);
