// util.inspect lists an object's own keys as they are when its rendering
// starts, as Node's getKeys does: a custom inspect function of a child that
// adds keys to the object (integer-like ones included) does not change that
// rendering, and the next one shows them.
const util = require("util");

const parent = { 1: "one", a: "x" };
parent.child = {
  [util.inspect.custom]() {
    parent[5] = "five";
    parent[0] = "zero";
    parent.b = "late";
    return "C";
  },
};
console.log(util.inspect(parent));
console.log(util.inspect(parent));
