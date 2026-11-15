"use strict";
// util.inspect renders a symbol-keyed own property while the palette getter
// for that key's style is running. A getter that deletes the property (or the
// table it was found in) must not free the key or the descriptor the render is
// reading, and the entry still shows the value the getter answered.
const { inspect } = require("node:util");

const define = Object.defineProperty;
const del = Reflect.deleteProperty;

const styled = (key, run) => define(inspect.styles, key, {
  enumerable: true,
  configurable: true,
  get() {
    run();
    return key;
  },
});

{
  const target = Buffer.from([1, 2, 3]);
  const key = Symbol("probe");
  define(target, key, { value: "kept", enumerable: true, configurable: true });
  let ran = 0;
  styled("symbol", () => {
    ran += 1;
    del(target, key);
  });
  console.log(JSON.stringify(inspect(target, { colors: true })));
  console.log("ran", ran, "symbols", Object.getOwnPropertySymbols(target).length);
}

// The same deletion through a plain object with a symbol key.
{
  const target = { a: 1 };
  const key = Symbol("plain");
  Object.defineProperty(target, key, { value: "kept", enumerable: true, configurable: true });
  let ran = 0;
  styled("symbol", () => {
    ran += 1;
    delete target[key];
  });
  console.log(JSON.stringify(inspect(target, { colors: true })));
  console.log("ran", ran, "symbols", Object.getOwnPropertySymbols(target).length);
}

// A getter that leaves the property in place renders it once per leaf.
{
  const target = {};
  const key = Symbol("stay");
  define(target, key, { value: 7, enumerable: true, configurable: true });
  let ran = 0;
  styled("number", () => {
    ran += 1;
  });
  console.log(JSON.stringify(inspect(target, { colors: true })));
  console.log("ran", ran > 0);
}
