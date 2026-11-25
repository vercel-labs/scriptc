"use strict";
// util.isDeepStrictEqual runs an own enumerable getter while the getter can
// delete the other side's property. The right-hand property is looked up again
// after the first getter runs, so a deleted property answers with no property
// rather than the value it held before the deletion.
const { isDeepStrictEqual: equal } = require("node:util");

const defineGetter = (target, key, run) => Object.defineProperty(target, key, {
  enumerable: true,
  configurable: true,
  get() {
    const value = run();
    return value;
  },
});

const repeat = (letter, count) => letter.repeat(count);

// The key and value the deletion frees are long enough to sit in their own
// allocations, so a comparison that reads the freed descriptor cannot answer
// the value it held.
const longKey = repeat("p", 400);
const longText = repeat("v", 400);

{
  const right = { [longKey]: longText };
  const left = {};
  defineGetter(left, longKey, () => {
    delete right[longKey];
    return longText;
  });
  console.log("delete right", equal(left, right), Object.keys(right).length);
}

{
  const right = { [longKey]: longText };
  const left = {};
  defineGetter(left, longKey, () => {
    delete right[longKey];
    right[longKey] = longText;
    return longText;
  });
  console.log("replace right", equal(left, right), Object.keys(right).length);
}

{
  const deleted = { deep: repeat("x", 400) };
  const right = { [longKey]: deleted };
  const left = {};
  defineGetter(left, longKey, () => {
    delete right[longKey];
    return { deep: repeat("x", 400) };
  });
  console.log("delete object right", equal(left, right), Object.keys(right).length);
}

{
  const right = {};
  const left = { [longKey]: longText };
  defineGetter(right, longKey, () => {
    delete right[longKey];
    return longText;
  });
  console.log("right self delete", equal(left, right), Object.keys(right).length);
}

{
  const right = { [longKey]: longText, other: 1 };
  const left = { [longKey]: longText };
  defineGetter(left, "extra", () => 1);
  console.log("key counts", equal(left, right), Object.keys(right).length);
}
