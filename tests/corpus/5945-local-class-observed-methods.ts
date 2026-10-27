// After a write with a computed string key, calls of every method name
// check the receiver for the property. Instances of function-local
// classes keep their declared methods, see own-property replacements, and
// see methods the program replaces on the class's prototype.
function write(target: object, key: string, value: unknown): void {
  (target as any)[key] = value;
}

function makeCounter(start: number) {
  class Counter {
    n: number;
    constructor() {
      this.n = start;
    }
    bump(): number {
      return ++this.n;
    }
    label(): string {
      return `counter ${this.n}`;
    }
  }
  return new Counter();
}

function run(start: number): string {
  class Step {
    value = start;
    next(): number {
      this.value *= 2;
      return this.value;
    }
    twice(): number {
      this.next();
      return this.next();
    }
  }
  const step = new Step();
  return `${typeof step.next} ${step.twice()} ${step.next()}`;
}

function makePatched(start: number) {
  class Patched {
    n = start;
    bump(): number {
      return ++this.n;
    }
  }
  Patched.prototype.bump = function (this: Patched) {
    this.n += 10;
    return this.n;
  };
  return new Patched();
}

const counter = makeCounter(5);
write({}, "other", 1);
console.log(typeof counter.bump, counter.bump(), counter.label());
const bump = counter.bump;
console.log(bump.call(counter));
write(counter, "label", () => "replaced");
console.log(counter.label(), makeCounter(1).label());
console.log(run(1), run(10));
console.log(makePatched(1).bump());
