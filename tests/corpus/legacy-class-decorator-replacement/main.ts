// @tsc-legacy-decorators
// A legacy class decorator that RETURNS the class rebinds the binding to its
// result, exactly as tsc's `C = __decorate([…], C)` does: the decorator runs
// after the static initializers, the result keeps one identity, and every
// direct path (new, statics, instanceof, .name) stays exact.

let applied = 0;

function identity(t: typeof Counter): typeof Counter {
  applied++;
  console.log("identity", applied, t.name, t.total);
  return t;
}

function keep(t: typeof Counter): typeof Counter {
  console.log("keep", t.name);
  return t;
}

@identity
@keep
@identity
class Counter {
  static total = (console.log("static init"), 0);
  n: number;
  constructor(n: number) {
    this.n = n;
    Counter.total = Counter.total + n;
  }
  double(): number {
    return this.n * 2;
  }
  static report(): string {
    return "total=" + String(Counter.total);
  }
}

const a = new Counter(3);
const b = new Counter(4);
console.log("instances", a.n, b.n, a.double(), b.double());
console.log("statics", Counter.total, Counter.report());
const alias = Counter;
console.log("alias", alias === Counter, new alias(1).n, Counter.total);
console.log("instanceof", a instanceof Counter, b instanceof Counter);
console.log("name", Counter.name, alias.name);
