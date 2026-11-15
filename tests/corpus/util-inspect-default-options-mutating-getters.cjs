"use strict";
// util.inspect.defaultOptions' setter copies the source's own keys the way a
// for...in walk does: the keys are snapshotted before any getter runs, so a key
// deleted by its own getter still reaches the sealed object's write and a key
// added during the walk is not copied.
const { inspect } = require("node:util");

const defineGetter = (target, key, run) => Object.defineProperty(target, key, {
  enumerable: true,
  configurable: true,
  get() {
    const value = run();
    return value;
  },
});

const repeat = (letter, count) => letter.repeat(count);

{
  const source = Object.create(null);
  const key = repeat("d", 200);
  defineGetter(source, key, () => {
    delete source[key];
    return 1;
  });
  try {
    inspect.defaultOptions = source;
    console.log("unknown key", "no throw");
  } catch (error) {
    console.log("unknown key", error.name, error.message.includes(key), inspect.defaultOptions.depth);
  }
}

{
  const source = {};
  defineGetter(source, "depth", () => {
    source.extra = 5;
    return 7;
  });
  try {
    inspect.defaultOptions = source;
    console.log("added key", inspect.defaultOptions.depth, "extra" in inspect.defaultOptions);
  } catch (error) {
    console.log("added key", "threw", error.name);
  }
  inspect.defaultOptions.depth = 2;
}
