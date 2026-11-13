// The untyped String conversion of class instances: util.format's %s,
// String(value), template literals and property keys run the class's
// declared Symbol.toPrimitive (with the "string" hint) or toString, declared
// or inherited, and use its answer. A conversion that throws, answers an
// object or answers a symbol fails with Node's error; a class that declares
// neither keeps the inspect form. Containers holding instances inspect them.
import { format, formatWithOptions, inspect } from "node:util";

class Plain {
  n = 1;
}

class Tagged {
  get [Symbol.toStringTag](): string {
    return "Tagged";
  }
}

class Mid {
  toString(): string {
    return "mid";
  }
}

class Leaf extends Mid {}

class Override extends Mid {
  toString(): string {
    return "override";
  }
}

class Exotic {
  [Symbol.toPrimitive](hint: string): string {
    seen.push(hint);
    return `exotic-${hint}`;
  }
}

class ReturnsNumber {
  toString(): number {
    return 42;
  }
}

class ReturnsBoolean {
  toString(): boolean {
    return false;
  }
}

class ReturnsBigInt {
  toString(): bigint {
    return 10n;
  }
}

class ReturnsNull {
  toString(): null {
    return null;
  }
}

class ReturnsUndefined {
  toString(): undefined {
    return undefined;
  }
}

class WithParam {
  toString(radix?: number): string {
    return radix === undefined ? "no-arg" : `radix ${radix}`;
  }
}

class Computed {
  get toString(): () => string {
    return () => "getter";
  }
}

class ObjBack {
  toString(): object {
    return { a: 1 };
  }
}

class SymbolBack {
  toString(): any {
    return Symbol("s");
  }
}

class Thrower {
  toString(): string {
    throw new RangeError("boom");
  }
}

class Counting {
  calls = 0;
  toString(): string {
    this.calls++;
    return `counted ${this.calls}`;
  }
}

const seen: string[] = [];

const values: unknown[] = [
  new Plain(),
  new Tagged(),
  new Mid(),
  new Leaf(),
  new Override(),
  new Exotic(),
  new ReturnsNumber(),
  new ReturnsBoolean(),
  new ReturnsBigInt(),
  new ReturnsNull(),
  new ReturnsUndefined(),
  new WithParam(),
  new Computed(),
];

// %s of an untyped instance runs the class's conversion.
for (const value of values) console.log(format("%s", value));
console.log(format("%s|%s|%s", new Leaf(), new Override(), new Mid()));
console.log(formatWithOptions({ colors: false }, "%s %s", new Leaf(), 3));

// String(value), a template literal and a property key reach the same
// conversion.
const untyped: unknown = new Leaf();
console.log(String(untyped), `${untyped}`);

// A class with only a toStringTag keeps the inspect form.
const tagged: unknown = new Tagged();
console.log(format("%s", tagged), inspect(tagged));

// A conversion that cannot produce a string throws Node's error.
const failures: unknown[] = [new ObjBack(), new SymbolBack(), new Thrower()];
for (const value of failures) {
  try {
    console.log(format("%s", value));
  } catch (error: any) {
    console.log(error.name, error.message);
  }
}

// Containers holding instances inspect them rather than convert them.
console.log(format("%s", [new Leaf(), new Counting()]));
console.log(format("%s", new Map([["k", new Leaf()]])));
console.log(format("%s", new Set([new Override()])));
console.log(format("%O", { leaf: new Leaf() }));

// %s converts an instance once per conversion, and the hint is "string".
const counting = new Counting();
const countingUntyped: unknown = counting;
console.log(format("%s", countingUntyped), counting.calls);
console.log(format("%s %s", countingUntyped, countingUntyped), counting.calls);
console.log(format("%s", new Exotic()), seen.join(","));

// An inspect of the instance does not run the conversion.
console.log(inspect(new Counting()), counting.calls);

// A stored console.log formats like console.log.
const stored = console.log;
stored("%s", new Leaf(), new Override());

// The statically typed conversion agrees.
const direct = new Leaf();
console.log(String(direct), format("%s", direct));
