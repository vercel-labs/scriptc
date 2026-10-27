import { inspect } from "node:util";

class Point {
  x = 1;
  y = 2;
}
class Empty {}
class WithCtor {
  a: number;
  b: string;
  constructor(a: number, b: string) {
    this.a = a;
    this.b = b;
  }
}
class Derived extends Point {
  w = 4;
}
class Methods {
  n = 1;
  get double(): number {
    return this.n * 2;
  }
  inc(): void {
    this.n++;
  }
}

const p = new Point();
console.log(p);
console.log(new Empty());
console.log(new WithCtor(1, "s"));
console.log(new Derived());
console.log(new Methods());
console.log([p, p]);
console.log({ p });
console.log(inspect(p));
console.log(`${inspect(new Derived())}`);

class Pair {
  x = 1;
  y = 2;
}

class Node2 {
  name: string;
  next: Node2 | null = null;
  constructor(name: string) {
    this.name = name;
  }
}

class Holder {
  #secret = 1;
  label = "h";
  items: number[] = [1, 2, 3];
  inner = new Pair();
}

const Anonymous = class {
  v = 1;
};

const pair = new Pair();
console.log(pair);
const loose: any = pair;
loose["z"] = 3;
(pair as any).w = "added";
console.log(pair);
console.log([pair], { pair });
console.log(inspect(pair, { depth: 0 }));
console.log(inspect({ deep: { deeper: pair } }, { depth: 1 }));

const a = new Node2("a");
const b = new Node2("b");
a.next = b;
b.next = a;
console.log(a);

const h = new Holder();
(h as any).extra = { nested: true };
console.log(h);
console.log(new Anonymous());
console.log(`${inspect(new Pair())}`);

const self = new Node2("s");
self.next = self;
console.log(self);
console.log([a]);
console.log({ ring: a, other: self });

class Shape {
  label = "shape";
  peer: Shape | null = null;
}
class Circle extends Shape {
  r = 1;
}
const c1 = new Circle();
const c2 = new Circle();
c1.peer = c2;
c2.peer = c1;
const shapes: Shape[] = [c1];
console.log(shapes);
console.log(c2);

class Link {
  label = "link";
  peer: Link | null = null;
}
class Tagged extends Link {
  tag = 1;
}
const l1 = new Tagged();
l1.peer = new Tagged();
const links: Link[] = [l1];
console.log(links);
