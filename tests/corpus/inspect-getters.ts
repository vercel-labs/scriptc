// util.inspect's getters option over accessor properties in a typed record:
// the [Getter]/[Setter]/[Getter/Setter] labels, true/'get'/'set' choosing
// which getters run, the result's form by kind (primitives, null, an object
// or a function-like value), a getter that throws, a result whose custom
// inspector throws, results under the depth options, a circular reference
// through a getter, a getter that inspects a value of its own (the inner
// inspection starting from the default options), console.dir,
// formatWithOptions, and an accessor on a typed array (called with the view
// as `this`). Node is the oracle.
import * as util from "node:util";

const inner: { x: number } = { x: 1 };
const mixed = {
  get num(): number {
    return 41 + 1;
  },
  get text(): string {
    return "hi";
  },
  get obj(): { x: number } {
    return inner;
  },
  get nul(): null {
    return null;
  },
  get ud(): undefined {
    return undefined;
  },
  get bad(): number {
    throw { code: 3 };
  },
  plain: "p",
};
console.log(util.inspect(mixed));
console.log(util.inspect(mixed, { getters: true }));
console.log(util.inspect(mixed, { getters: "get" }));
console.log(util.inspect(mixed, { getters: false }));

let seen = 0;
const combo = {
  get getOnly(): number {
    return seen;
  },
  set setOnly(v: number) {
    seen += v;
  },
  get both(): number {
    return seen + 1;
  },
  set both(v: number) {
    seen += v;
  },
  plain: 0,
};
console.log(util.inspect(combo));
console.log(util.inspect(combo, { getters: true }));
console.log(util.inspect(combo, { getters: "get" }));
console.log(util.inspect(combo, { getters: "set" }));
console.log(seen);

console.log(util.inspect({ deep: mixed }, { getters: true, depth: 1 }));
console.log(util.inspect({ deep: mixed }, { getters: true, depth: 0 }));

type Ring = { get self(): Ring; plain: number };
const ring: Ring = {
  get self(): Ring {
    return ring;
  },
  plain: 1,
};
console.log(util.inspect(ring, { getters: true }));
console.log(util.inspect(ring));

const nested = {
  get inner(): string {
    return util.inspect({ y: 2 });
  },
  plain: 1,
};
console.log(util.inspect(nested, { getters: true }));
console.log(util.inspect(nested));

// A getter's own util.inspect calls start from Node's default options, so
// the inner inspection keeps the labels whether or not this one runs the
// getters; the options the call does name still apply.
const innerAccess = {
  get x(): number {
    return 7;
  },
  plain: 1,
};
const inspectingGetter = {
  get plainCall(): string {
    return util.inspect(innerAccess);
  },
  get withGetters(): string {
    return util.inspect(innerAccess, { getters: true });
  },
  get withDepth(): string {
    return util.inspect(innerAccess, { depth: 0 });
  },
  plain: 2,
};
console.log(util.inspect(inspectingGetter, { getters: true }));
console.log(util.inspect(inspectingGetter, { depth: 5 }));

// What the getter answers renders in THIS inspection, so its own accessors
// run under this inspection's getters option.
const resultAccess = {
  get obj(): { get y(): number; z: number } {
    return {
      get y(): number {
        return 8;
      },
      z: 2,
    };
  },
};
console.log(util.inspect(resultAccess, { getters: true }));
console.log(util.inspect(resultAccess));

// A result whose custom inspector throws renders the threw label, exactly
// as a throwing getter does.
class Boom {
  boom = 1;
  [util.inspect.custom](): string {
    throw { code: 9 };
  }
}
const badResult = {
  get bad(): Boom {
    return new Boom();
  },
  plain: 3,
};
console.log(util.inspect(badResult, { getters: true }));
console.log(util.inspect({ wrap: badResult }, { getters: true }));

console.dir(combo, { getters: true });
console.log(util.formatWithOptions({ getters: true }, "%O", mixed));

// An accessor on a typed array is called with the view as `this`, as one on
// a record is. (A getter declared in an object literal can't name `this`
// here yet, so the accessor is defined from a function expression.)
const nums = new Uint8Array([3, 4]);
const sum = function (this: Uint8Array): number {
  return this.length + this[0] + this[1];
};
Reflect.defineProperty(nums, "sum", { get: sum, enumerable: true, configurable: true });
console.log(util.inspect(nums, { getters: true }));
console.log(util.inspect(nums));
console.log(util.inspect({ nums }, { getters: true }));
