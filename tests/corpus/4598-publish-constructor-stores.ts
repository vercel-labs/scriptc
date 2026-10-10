import { publish } from "@scriptc/threads";

// Constructor stores into a `this` that nothing else can reach yet can never
// hit a published object, so scriptc drops their frozen-object guard. Every
// constructor below that lets `this` escape before or between its stores
// must keep the guard: the escaped object can be published before the
// constructor finishes, and Node.js then rejects the remaining stores.

function attempt(label: string, f: () => void): void {
  try {
    f();
    console.log(`${label}: ok`);
  } catch (e) {
    console.log(`${label}: ${e instanceof TypeError ? "TypeError" : "other"}: ${(e as Error).message}`);
  }
}

// Private construction: plain field stores, a compound assignment (whose
// receiver is a temporary alias of `this`), and a self reference.
class Plain {
  flags = 1;
  name: string;
  self: Plain | undefined;
  constructor(name: string, extra: number) {
    this.name = name;
    this.flags |= extra;
    this.self = this;
  }
}

// The constructor publishes `this` before its last store.
class PublishesItself {
  a: number;
  b: number;
  constructor() {
    this.a = 1;
    publish(this);
    this.b = 2;
  }
}

// A base constructor registers `this`; the subclass constructor's store runs
// after a call that publishes everything registered.
const registry: Base[] = [];
class Base {
  id: number;
  constructor(id: number) {
    this.id = id;
    registry.push(this);
  }
}
function publishRegistry(): number {
  publish(registry);
  return 7;
}
class Derived extends Base {
  late: number;
  constructor(id: number) {
    super(id);
    this.late = publishRegistry();
  }
}

// `this` escapes through a closure created in the constructor.
let hook: (() => void) | undefined;
class Captured {
  x: number;
  y: number;
  constructor() {
    this.x = 1;
    hook = () => {
      publish(this);
    };
    hook();
    this.y = 2;
  }
}

// `this` escapes as a method receiver.
class ViaMethod {
  ready = false;
  value = 0;
  constructor() {
    this.freeze();
    this.value = 5;
  }
  freeze(): void {
    publish(this);
  }
}

attempt("plain", () => {
  const p = new Plain("p", 6);
  console.log(p.name, p.flags, p.self === p);
  publish(p);
  attempt("plain write after publish", () => {
    p.flags = 9;
  });
  attempt("plain compound after publish", () => {
    p.flags |= 16;
  });
  console.log(p.flags);
});
attempt("publishes itself", () => {
  new PublishesItself();
});
attempt("derived after base escape", () => {
  new Derived(3);
});
console.log(registry.length, registry[0]!.id);
attempt("captured", () => {
  new Captured();
});
attempt("via method", () => {
  new ViaMethod();
});

// Many private constructions, published in bulk afterwards: every object
// stays writable until its own publish.
class Point {
  x: number;
  y: number;
  next: Point | null;
  constructor(x: number, y: number, next: Point | null) {
    this.x = x;
    this.y = y;
    this.next = next;
  }
}
let head: Point | null = null;
for (let i = 0; i < 1000; i++) head = new Point(i, i * 2, head);
let sum = 0;
for (let p = head; p !== null; p = p.next) {
  p.y += 1;
  sum += p.x + p.y;
}
console.log(sum);
publish(head);
attempt("point write after publish", () => {
  head!.next!.x = 0;
});
const fresh = new Point(1, 2, head);
fresh.x = 10;
console.log(fresh.x, fresh.next === head);
