// util.inspect's getters option over accessor properties in a typed record:
// the [Getter]/[Setter]/[Getter/Setter] labels, true/'get'/'set' choosing
// which getters run, the result's form by kind (primitives, null, an object
// or a function-like value), a getter that throws, results under the depth
// options, a circular reference through a getter, a getter that inspects a
// value of its own, console.dir and formatWithOptions. Node is the oracle.
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

console.dir(combo, { getters: true });
console.log(util.formatWithOptions({ getters: true }, "%O", mixed));
