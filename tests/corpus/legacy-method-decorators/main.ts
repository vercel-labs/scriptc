// @tsc-legacy-decorators
// Legacy (`experimentalDecorators`) METHOD decorators: each member's
// decorator expressions evaluate in source order after the class body, the
// applications run in reverse source order with
// (prototype, key, descriptor), the descriptor carries the method's own
// function value, and a returned (or mutated) descriptor replaces the
// method every later call dispatches to.

class Calc {
  base = 10;

  @wrap("run")
  add(x: number): number {
    return this.base + x;
  }

  @wrap("stop")
  stop(): string {
    return "stop";
  }
}

function wrap(label: string): (t: object, k: string, d: PropertyDescriptor) => void {
  console.log("factory", label);
  return (t: object, k: string, d: PropertyDescriptor): void => {
    console.log("apply", label, k, typeof d.value, d.value === (t as any)[k]);
    console.log("flags", d.writable, d.enumerable, d.configurable);
  };
}

// A descriptor-returning decorator: the wrapper it installs must be the one
// every later call runs, with the original method's `this`.
function doubled(t: object, k: string, d: PropertyDescriptor): PropertyDescriptor {
  const original = d.value as (x: number) => number;
  console.log("doubled", k);
  d.value = function (this: Calc, x: number): number {
    return original.call(this, x) * 2;
  };
  return d;
}

// The decorators must exist before the class statement evaluates.
class Doubled {
  base = 1;

  @doubled
  @wrap("doubled")
  twice(x: number): number {
    return this.base + x;
  }
}

const calc = new Calc();
console.log("call", calc.add(5), calc.stop());
const doubledInstance = new Doubled();
console.log("wrapped", doubledInstance.twice(4), doubledInstance.base);
