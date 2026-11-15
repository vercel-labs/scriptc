// Pins: a static method read as a value is the method wherever it is held.
// Printed from an array, a record, a union arm, a tuple, a Map or a Set it
// carries the method's own name and call kind, as Node prints it, read
// through the declaring class or through a subclass; bound, it is `bound`
// plus that name; and the `name` an untyped read answers is the same one.
// The neighbours below it are named by the function they are as well: what
// a getter returns, a function a class field holds, a class expression.
import { inspect } from "node:util";

type Convert = (amount: number) => number;
type Step = string | Convert | [Convert];

class Length {
  static toFeet(metres: number): number {
    return metres * 3.28084;
  }
  static toMiles(kilometres: number): number {
    return kilometres * 0.621371;
  }
  static async lookUp(code: number): Promise<number> {
    return code;
  }
  static *ticks(limit: number): Generator<number> {
    for (let i = 0; i < limit; i++) yield i;
  }
  static async *readings(limit: number): AsyncGenerator<number> {
    yield limit;
  }
  static #round(amount: number): number {
    return Math.round(amount);
  }
  static rounding(): Convert[] {
    return [Length.#round];
  }
  static half = (amount: number): number => amount / 2;
  static get doubler(): Convert {
    return function twice(amount: number): number {
      return amount * 2;
    };
  }

  factor = 2;
  scale = (amount: number): number => amount * this.factor;
  shrink = function (amount: number): number {
    return amount / 10;
  };
  get rounder(): Convert {
    return function nearest(amount: number): number {
      return Math.round(amount);
    };
  }
  get same(): Convert {
    return (amount) => amount;
  }
  times(amount: number): number {
    return amount * this.factor;
  }
}
class Imperial extends Length {
  static toYards(metres: number): number {
    return metres * 1.09361;
  }
}
const length = new Length();

// Directly, and through the subclass that inherits it.
console.log(Length.toFeet, Imperial.toFeet, Imperial.toYards);

// An array: the row that printed `[Function (anonymous)]`.
const table: Convert[] = [Length.toFeet, Length.toMiles, Imperial.toFeet, Imperial.toYards];
console.log(table);
console.log(inspect(table));
console.log(table.map((convert) => Math.round(convert(1000))));
console.log(Length.rounding());

// A union arm and a one-element tuple.
function show(step: Step): void {
  console.log(step);
  console.log(inspect(step));
}
show("feet");
show(Length.toMiles);
show([Imperial.toYards]);

// A parameter: the function's name, not the parameter's.
function describe(run: Convert): void {
  console.log("run", run, inspect(run));
}
describe(Length.toFeet);
describe(Imperial.toFeet);

// A record member, an optional member, a tuple position, a Map value and a
// Set element.
const entry = { label: "feet", run: Length.toFeet };
console.log(entry);
const optional: { label: string; run?: Convert } = { label: "miles", run: Length.toMiles };
console.log(optional);
const pair: [string, Convert] = ["yards", Imperial.toYards];
console.log(pair);
console.log(new Map<string, Convert>([["miles", Length.toMiles]]));
console.log(new Set<Convert>([Imperial.toYards]));

// The call kind of an async, a generator and an async generator method.
const kinds: ((amount: number) => unknown)[] = [Length.lookUp, Length.ticks, Length.readings];
console.log(kinds);

// Bound: `bound` and the name of the method it binds.
const bound: Convert[] = [
  Length.toFeet.bind(null),
  length.times.bind(length),
  length.scale.bind(null),
];
console.log(bound);

// Through an untyped value, printed and asked for its name.
const loose: unknown = { table, kinds };
console.log(loose);
const names: any = table;
console.log(names[0].name, names[1].name, names[3].name);

// What a getter returns is named by the function it returns, a function a
// class field holds by the field.
const fields: Convert[] = [length.scale, length.shrink, Length.half];
console.log(fields);
const returned: Convert[] = [length.rounder, length.same, Length.doubler];
console.log(returned);
const steps: { run: Convert }[] = [
  { run: length.rounder },
  { run: Length.toFeet },
  { run: length.scale },
];
console.log(steps, inspect(steps));
show(length.rounder);
show([Length.doubler]);
show(length.scale);
show([Length.half]);

// A class expression: the binding names an anonymous one, a named one
// keeps its own name.
const Area = class {
  side = 1;
};
const Volume = class Cube {
  side = 1;
};
const classes: (typeof Area)[] = [Area];
console.log(classes, Area, Volume);
const held: { kind: typeof Volume } = { kind: Volume };
console.log(held);
