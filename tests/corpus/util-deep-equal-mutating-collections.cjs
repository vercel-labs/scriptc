"use strict";
// util.isDeepStrictEqual walks Map and Set entries live, as Node's iterators
// do: a member getter that appends to either collection is reached by the
// walk, and the matching slots are reserved as the collection being matched
// grows, so an append never runs past the bookkeeping.
const { isDeepStrictEqual: equal } = require("node:util");

const defineGetter = (target, key, run) => Object.defineProperty(target, key, {
  enumerable: true,
  configurable: true,
  get() {
    const value = run();
    return value;
  },
});

const growingMap = (extra) => {
  const map = new Map();
  const value = {};
  defineGetter(value, "x", () => {
    if (extra) map.set("extra", 7);
    return 1;
  });
  map.set("k", value);
  return map;
};

{
  const left = growingMap(true);
  const right = growingMap(true);
  console.log("same extra both", equal(left, right), left.size, right.size);
}

{
  const left = growingMap(true);
  const right = growingMap(false);
  console.log("same extra left only", equal(left, right), left.size, right.size);
}

{
  const left = growingMap(false);
  const right = growingMap(true);
  console.log("same extra right only", equal(left, right), left.size, right.size);
}

{
  const grow = (name) => {
    const map = new Map();
    const value = {};
    defineGetter(value, "x", () => {
      map.set(name, 1);
      return 1;
    });
    map.set("k", value);
    return map;
  };
  const left = grow("left");
  const right = grow("right");
  console.log("both grow apart", equal(left, right), left.size, right.size);
}

{
  const grow = (count) => {
    const map = new Map();
    const value = {};
    defineGetter(value, "x", () => {
      for (let i = 0; i < count; i += 1) map.set("e" + i, i);
      return 1;
    });
    map.set("k", value);
    return map;
  };
  const left = grow(50);
  const right = grow(50);
  console.log("grow 50", equal(left, right), left.size, right.size);
}

{
  const left = new Map();
  const leftValue = {};
  defineGetter(leftValue, "x", () => {
    left.delete("other");
    return 1;
  });
  left.set("k", leftValue);
  left.set("other", 2);
  const right = new Map();
  const rightValue = {};
  defineGetter(rightValue, "x", () => 1);
  right.set("k", rightValue);
  right.set("other", 2);
  console.log("delete during", equal(left, right), left.size, right.size);
}

{
  const growingSet = (extra) => {
    const set = new Set();
    const value = {};
    defineGetter(value, "x", () => {
      if (extra) set.add(9);
      return 1;
    });
    set.add(value);
    return set;
  };
  const left = growingSet(true);
  const right = growingSet(true);
  console.log("set same extra both", equal(left, right), left.size, right.size);
}

{
  const plain = new Map([["a", 1], ["b", 2]]);
  const other = new Map([["b", 2], ["a", 1]]);
  console.log("plain maps", equal(plain, other));
}
