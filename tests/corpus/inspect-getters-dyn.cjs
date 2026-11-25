// util.inspect's getters option over the checked-dynamic walk: accessor
// properties on plain-JS objects, the labels without the option, every
// getter under it, 'get'/'set' choosing by setter, the result's form by
// kind, a getter that throws, a result whose custom inspector throws, a
// getter's result under a depth budget, an array's accessors (called with
// the array as `this`), an inspection a getter runs (starting from the
// default options), console.dir, and a typed array's and a DataView's
// accessors (called with the view as `this`). Node is the oracle.
"use strict";
const util = require("node:util");

const inner = { x: 1 };
const mixed = {
  get num() {
    return 42;
  },
  get text() {
    return "hi";
  },
  get obj() {
    return inner;
  },
  get nul() {
    return null;
  },
  get ud() {
    return undefined;
  },
  get bad() {
    throw { code: 3 };
  },
  plain: "p",
};
console.log(util.inspect(mixed));
console.log(util.inspect(mixed, { getters: true }));
console.log(util.inspect(mixed, { getters: "get" }));
console.log(util.inspect({ deep: mixed }, { getters: true, depth: 1 }));

const combo = {
  get getOnly() {
    return 5;
  },
  set setOnly(v) {},
  get both() {
    return 6;
  },
  set both(v) {},
  plain: 0,
};
console.log(util.inspect(combo));
console.log(util.inspect(combo, { getters: true }));
console.log(util.inspect(combo, { getters: "get" }));
console.log(util.inspect(combo, { getters: "set" }));
console.dir(mixed, { getters: true });

// An accessor on an array is called with the array as `this`, not with the
// property table the walk reads it from.
const list = [1, 2];
Reflect.defineProperty(list, "first", {
  get() {
    return this.length + 10;
  },
  enumerable: true,
  configurable: true,
});
Reflect.defineProperty(list, "back", {
  get() {
    return this[this.length - 1];
  },
  enumerable: true,
  configurable: true,
});
console.log(util.inspect(list, { getters: true }));
console.log(util.inspect(list));
console.log(util.inspect({ list }, { getters: true }));

// A getter's result whose custom inspector throws renders the threw label,
// on an object's accessor and on an array's.
class Boom {
  [util.inspect.custom]() {
    throw { code: 9 };
  }
}
const throwing = {
  get bad() {
    return new Boom();
  },
  plain: 3,
};
console.log(util.inspect(throwing, { getters: true }));
const throwList = [1];
Reflect.defineProperty(throwList, "bad", {
  get() {
    return new Boom();
  },
  enumerable: true,
  configurable: true,
});
console.log(util.inspect(throwList, { getters: true }));

// A getter's own util.inspect calls start from Node's default options.
const innerAccess = {
  get x() {
    return 7;
  },
  plain: 1,
};
const inspecting = {
  get plainCall() {
    return util.inspect(innerAccess);
  },
  plain: 2,
};
console.log(util.inspect(inspecting, { getters: true }));
console.log(util.inspect(inspecting, { getters: "get", depth: 4 }));

// An accessor on a typed array or a DataView is called with the view as
// `this` too, and its answer carries the same label forms.
const nums = new Uint8Array([3, 4]);
Reflect.defineProperty(nums, "sum", {
  get() {
    return this.length + this[0] + this[1];
  },
  enumerable: true,
  configurable: true,
});
console.log(util.inspect(nums, { getters: true }));
console.log(util.inspect(nums));
console.log(util.inspect({ nums }, { getters: true }));
console.log(util.formatWithOptions({ getters: true }, "%O", nums));
const view = new DataView(new ArrayBuffer(4));
Reflect.defineProperty(view, "twice", {
  get() {
    return this.byteLength * 2;
  },
  enumerable: true,
  configurable: true,
});
console.log(util.inspect({ view }, { getters: true }));
const badNums = new Uint8Array([5]);
Reflect.defineProperty(badNums, "bad", {
  get() {
    throw { code: 4 };
  },
  enumerable: true,
  configurable: true,
});
console.log(util.inspect(badNums, { getters: true }));
