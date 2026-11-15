// util.isDeepStrictEqual over program classes: two instances match when
// their constructors match (the same class, or the same prototype when the
// class defines its own constructor property) and their own enumerable
// properties, symbols included, match deeply. A subclass instance never
// matches a base instance, a class instance never matches a plain record
// unless the third argument turns the prototype gate off, and a class
// declared `extends Date` compares by its time value first.
import { isDeepStrictEqual as equal } from "node:util";

class Point {
  x = 0;
  y = 0;
}
class Other {
  x = 0;
  y = 0;
}
class Named {
  tag: string;
  constructor(tag: string) {
    this.tag = tag;
  }
}
class Box {
  corner = new Point();
  label = "";
  labels = new Map<string, number>();
}
class Base {
  a = 1;
}
class Derived extends Base {
  b = 2;
}
class Empty {}

const show = (label: string, value: boolean): void => {
  console.log(`${label}: ${value}`);
};

show("instances", equal(new Point(), new Point()));
show("classes", equal(new Point(), new Other()));
show("constructor args", equal(new Named("a"), new Named("a")));
show("constructor args differ", equal(new Named("a"), new Named("b")));
show("nested", equal(new Box(), new Box()));
const moved = new Box();
moved.corner.x = 3;
show("nested differ", equal(new Box(), moved));
show("empty", equal(new Empty(), new Empty()));
show("subclass", equal(new Derived(), new Derived()));
show("subclass vs base", equal(new Derived(), new Base()));
show("base vs subclass", equal(new Base(), new Derived()));

const loose = { x: 0, y: 0 };
show("class vs record", equal(new Point(), loose));
show("class vs record skip", equal(new Point() as any, loose as any, true));

const padded = new Point();
(padded as any).extra = 1;
const paddedTwin = new Point();
(paddedTwin as any).extra = 1;
show("extra property", equal(padded, paddedTwin));
const paddedOther = new Point();
(paddedOther as any).extra = 2;
show("extra property differ", equal(padded, paddedOther));

const tag = Symbol("tag");
const symA: any = new Point();
symA[tag] = 1;
const symB: any = new Point();
symB[tag] = 1;
show("symbol property", equal(symA, symB));

const cyclic: any = new Point();
cyclic.self = cyclic;
const cyclicTwin: any = new Point();
cyclicTwin.self = cyclicTwin;
show("cycle", equal(cyclic, cyclicTwin));
const broken: any = new Point();
broken.self = new Point();
show("cycle broken", equal(cyclic, broken));

class WithMethod {
  value = 1;
  doubled(): number {
    return this.value * 2;
  }
}
const method = new WithMethod();
show("methods", equal(method, new WithMethod()));
show("method call", method.doubled() === 2);
const ctor: any = WithMethod;
show("class value name", ctor.name === "WithMethod");

class WithAccessor {
  value = 1;
  get label(): string {
    return `v${this.value}`;
  }
}
show("prototype accessor", equal(new WithAccessor(), new WithAccessor()));

class WithPrivate {
  #secret = 1;
  value = 1;
}
show("private fields", equal(new WithPrivate(), new WithPrivate()));

class When extends Date {}
show("date subclass", equal(new When(5), new When(5)));
show("date subclass differ", equal(new When(5), new When(6)));
show("date subclass invalid", equal(new When(NaN), new When(NaN)));
show("date subclass vs date", equal(new When(5), new Date(5)));

class Points {
  list = [new Point(), new Point()];
}
show("class array field", equal(new Points(), new Points()));

const mapKey = new Map<Point, string>([[new Point(), "p"]]);
show("class map key", equal(mapKey, new Map<Point, string>([[new Point(), "p"]])));

console.log("done");
