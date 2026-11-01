// util.inspect's getters option over the checked-dynamic walk: accessor
// properties on plain-JS objects, the labels without the option, every
// getter under it, 'get'/'set' choosing by setter, the result's form by
// kind, a getter that throws, a getter's result under a depth budget, and
// console.dir. Node is the oracle.
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
