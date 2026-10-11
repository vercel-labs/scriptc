// Reference fields written only by their class's constructors may be read
// without a retain wherever their object is held. Every other field keeps
// its owning reads: a callee may replace it while the caller still uses the
// old value.

class Buffer2 {
  readonly items: string[] = [];
  label: string;
  constructor(label: string) {
    this.label = label;
  }
  push(item: string): number {
    this.items.push(item);
    return this.items.length;
  }
  describe(): string {
    return `${this.label}:${this.items.join(",")}`;
  }
}

class Owner {
  // Final: written only here, twice, with a method call between the writes.
  readonly primary: Buffer2;
  // Not final: replaced by `rotate`.
  current: Buffer2;
  log: string[] = [];
  constructor() {
    this.primary = new Buffer2("first");
    this.current = new Buffer2("c0");
    this.log.push(this.peek());
    this.primary = new Buffer2("primary");
    this.log.push(this.peek());
  }
  peek(): string {
    const primary = this.primary;
    primary.push("peeked");
    return primary.describe();
  }
  // The callee replaces `current` while the caller's receiver is the old one.
  rotate(next: string): Buffer2 {
    const old = this.current;
    this.current = new Buffer2(next);
    return old;
  }
  useCurrent(): string {
    return this.current.push(this.rotate("c1").describe()) + " " + this.current.describe();
  }
  usePrimary(): string {
    const before = this.primary.push("a");
    const again = this.primary.push(this.rotate("c2").label);
    return `${before} ${again} ${this.primary.describe()}`;
  }
}

class Derived extends Owner {
  readonly extra: Buffer2;
  constructor() {
    super();
    this.extra = new Buffer2("extra");
    this.extra.push(this.primary.describe());
  }
  report(): string {
    return `${this.extra.describe()} / ${this.primary.describe()}`;
  }
}

// A field a closure created in the constructor writes later is not final.
class Callbacks {
  target: Buffer2;
  readonly reset: () => void;
  constructor() {
    this.target = new Buffer2("t0");
    this.reset = () => {
      this.target = new Buffer2("t1");
    };
  }
  run(): string {
    return this.target.push(this.fire()) + " " + this.target.describe();
  }
  fire(): string {
    this.reset();
    return "fired";
  }
}

// A field written through another object, outside any constructor.
class Node2 {
  next: Node2 | undefined;
  readonly name: string;
  readonly payload: Buffer2;
  constructor(name: string) {
    this.name = name;
    this.payload = new Buffer2(name);
  }
}
function relink(a: Node2): string {
  const first = a.next!;
  a.next = new Node2("b2");
  return first.payload.describe() + " -> " + a.next.payload.describe();
}

const owner = new Owner();
console.log(owner.log.join(" | "));
console.log(owner.useCurrent());
console.log(owner.usePrimary());
console.log(owner.current.describe());
const derived = new Derived();
console.log(derived.report());
const callbacks = new Callbacks();
console.log(callbacks.run());
const a = new Node2("a");
a.next = new Node2("b");
a.next.payload.push("x");
console.log(relink(a));

// Async methods keep owning reads across their suspensions.
class Pending {
  readonly box: Buffer2 = new Buffer2("async");
  async later(): Promise<string> {
    const box = this.box;
    box.push("before");
    await Promise.resolve();
    box.push("after");
    return box.describe();
  }
}
new Pending().later().then((text) => console.log(text));
