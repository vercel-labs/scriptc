"use strict";
// util.inspect reads own enumerable getters while a getter deletes its own
// property. The table entry keeps the key it is rendering across the call, so
// the render still names the property and the value the getter answered, in
// the plain-object, function and symbol renderers.
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
  const target = { a: 1 };
  const key = repeat("k", 200);
  let calls = 0;
  defineGetter(target, key, () => {
    calls += 1;
    delete target[key];
    return 42;
  });
  const text = inspect(target, { getters: true });
  console.log("plain", calls, text.includes(key + ": [Getter: 42]"), Object.keys(target).length);
}

{
  const fn = function named() {};
  const key = repeat("f", 200);
  defineGetter(fn, key, () => {
    delete fn[key];
    return "v";
  });
  const text = inspect(fn, { getters: true });
  console.log("function", text.includes(key + ": [Getter: 'v']"), Object.keys(fn).length);
}

{
  const target = {};
  const key = Symbol("s");
  defineGetter(target, key, () => {
    delete target[key];
    return "sym";
  });
  console.log("symbol", inspect(target, { getters: true }));
}
