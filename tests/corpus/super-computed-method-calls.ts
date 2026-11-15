// super[computedKey](): the base prototype's method named by a computed key,
// called over the derived method's own `this` — literal string and numeric
// keys, argument and spread forwarding, evaluation order, and a class whose
// base is declared inside the same function.

class Base {
  greet(name: string): string {
    return "base " + name;
  }
  add(a: number, b: number): number {
    return a + b;
  }
  addAll(...values: number[]): number {
    return values.reduce((sum, value) => sum + value, 0);
  }
  "0"(suffix: string): string {
    return "zero " + suffix;
  }
}

class Derived extends Base {
  greet(name: string): string {
    return "derived<" + super["greet"](name) + ">";
  }
  total(a: number, b: number): string {
    return this.greet(String(super["add"](a, b)));
  }
  spread(values: number[]): number {
    return super["addAll"](...values);
  }
  zero(suffix: string): string {
    return super[0](suffix);
  }
  forwarded(label: () => string): string {
    return super["greet"](label());
  }
}

const d = new Derived();
console.log(d.greet("ann"));
console.log(d.total(2, 3));
console.log(d.spread([4, 5]));
console.log(d.zero("suffix"));

let calls = 0;
console.log(
  d.forwarded(() => {
    calls++;
    return "order";
  }),
  calls,
);

function localBases(): string {
  class LocalBase {
    describe(): string {
      return "local base";
    }
  }
  class LocalDerived extends LocalBase {
    describe(): string {
      return "local derived of " + super["describe"]();
    }
  }
  return new LocalDerived().describe();
}
console.log(localBases());
